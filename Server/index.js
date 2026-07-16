const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const proxyManager = require('./proxyManager');
const { EvolutionApi, toDigits: evolutionDigits, toRemoteJid: evolutionRemoteJid } = require('./evolutionApi');
require('dotenv').config();

function sanitizeWebhookUrl(value) {
    let v = String(value || '').trim();
    if (!v) return '';
    v = v.replace(/[`"'‘’´]/g, '');
    v = v.replace(/\s+/g, '');
    v = v.replace(/^[()<>]+|[()<>]+$/g, '');
    return v;
}

function trimTrailingSlash(value) {
    return String(value || '').replace(/\/+$/, '');
}

function getOriginFromUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        return trimTrailingSlash(new URL(raw).origin);
    } catch (e) {
        return '';
    }
}

const MASTER_PASSWORD = process.env.MASTER_PASSWORD || process.env.SESSION_MASTER_PASSWORD || 'Ga145523@';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'mro@gmail.com').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || MASTER_PASSWORD;
const TEST_PROMO_CODE = (process.env.TEST_PROMO_CODE || 'xxg2').trim();
const ADMIN_SELF_SESSION_ID = String(process.env.ADMIN_SELF_SESSION_ID || 'session_admin_self').trim();
const WHATSAPP_PROVIDER = String(
    process.env.WHATSAPP_PROVIDER ||
    ((process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY) ? 'evolution' : 'wwebjs')
).trim().toLowerCase();
const USE_EVOLUTION = WHATSAPP_PROVIDER === 'evolution';
const EVOLUTION_API_URL = String(process.env.EVOLUTION_API_URL || '').trim();
const EVOLUTION_API_KEY = String(process.env.EVOLUTION_API_KEY || '').trim();
const EVOLUTION_WEBHOOK_URL = sanitizeWebhookUrl(process.env.EVOLUTION_WEBHOOK_URL || '');
const PUBLIC_BASE_URL = trimTrailingSlash(
    process.env.PUBLIC_BASE_URL ||
    process.env.APP_BASE_URL ||
    process.env.SITE_URL ||
    getOriginFromUrl(EVOLUTION_WEBHOOK_URL) ||
    ''
);
const evolutionApi = USE_EVOLUTION
    ? new EvolutionApi({
        baseUrl: EVOLUTION_API_URL,
        apiKey: EVOLUTION_API_KEY,
        integration: String(process.env.EVOLUTION_INTEGRATION || 'WHATSAPP-BAILEYS').trim() || 'WHATSAPP-BAILEYS'
    })
    : null;
const publicIpCache = new Map();
const PUBLIC_IP_CACHE_TTL_MS = 2 * 60 * 1000;
const evolutionContactLookupCache = new Map();
const EVOLUTION_CONTACT_LOOKUP_TTL_MS = 5 * 60 * 1000;

const PUBLIC_IP_CHECK_ENDPOINTS = [
    { url: 'https://api.ipify.org?format=json', type: 'json' },
    { url: 'http://api.ipify.org?format=json', type: 'json' },
    { url: 'https://ipv4.icanhazip.com', type: 'text' },
    { url: 'http://ifconfig.me/ip', type: 'text' }
];

function normalizePublicIp(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw.replace(/^::ffff:/i, '');
}

function getRemoteRequestIp(req) {
    if (!req) return '';
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return normalizePublicIp(forwarded || req.ip || (req.socket && req.socket.remoteAddress) || '');
}

async function fetchOutboundPublicIp(proxyConfig = null) {
    const key = proxyConfig && proxyConfig.id ? `proxy:${proxyConfig.id}` : 'direct';
    const now = Date.now();
    const cached = publicIpCache.get(key);
    if (cached && (now - cached.at) < PUBLIC_IP_CACHE_TTL_MS) {
        return cached.value;
    }

    const requestConfig = {
        timeout: 8000,
        headers: { 'User-Agent': 'zapmro-ip-check/1.0' }
    };
    if (proxyConfig && proxyConfig.host && proxyConfig.port) {
        const protocol = String(proxyConfig.protocol || 'http').toLowerCase();
        if (protocol === 'socks4' || protocol === 'socks5') {
            const result = { ip: '', endpoint: '', error: `Protocolo ${protocol} nao suportado na validacao HTTP` };
            publicIpCache.set(key, { at: now, value: result });
            return result;
        }
        requestConfig.proxy = {
            protocol,
            host: proxyConfig.host,
            port: Number(proxyConfig.port),
            auth: proxyConfig.username
                ? { username: proxyConfig.username, password: proxyConfig.password || '' }
                : undefined
        };
    }

    const errors = [];
    for (const endpoint of PUBLIC_IP_CHECK_ENDPOINTS) {
        try {
            const response = await axios.get(endpoint.url, requestConfig);
            const ip = endpoint.type === 'json'
                ? normalizePublicIp(response && response.data && response.data.ip)
                : normalizePublicIp(response && response.data);
            if (ip) {
                const result = { ip, endpoint: endpoint.url, error: '' };
                publicIpCache.set(key, { at: now, value: result });
                return result;
            }
            errors.push(`${endpoint.url}: resposta sem ip`);
        } catch (e) {
            const reason = e && e.response
                ? `${e.response.status} ${e.response.statusText || ''}`.trim()
                : (e && (e.code || e.message)) || 'erro desconhecido';
            errors.push(`${endpoint.url}: ${reason}`);
        }
    }

    const result = { ip: '', endpoint: '', error: errors.join(' | ').slice(0, 800) };
    if (proxyConfig) {
        console.warn('[proxy-ip-validation-failed]', JSON.stringify({
            proxyId: proxyConfig.id || '',
            proxyName: proxyConfig.name || '',
            proxyHost: proxyConfig.host || '',
            proxyPort: proxyConfig.port || '',
            protocol: proxyConfig.protocol || '',
            error: result.error
        }));
    }
    publicIpCache.set(key, { at: now, value: result });
    return result;
}

async function buildSessionNetworkInfo(sessionId) {
    const sid = String(sessionId || '').trim();
    const serverNetwork = await fetchOutboundPublicIp(null);
    const serverRealIp = serverNetwork.ip || '';
    if (!sid || sid === ADMIN_SELF_SESSION_ID) {
        return {
            serverRealIp,
            currentConnectionIp: serverRealIp,
            proxyConnectionIp: '',
            proxyHost: '',
            proxyPort: '',
            proxyName: '',
            usingProxy: false,
            proxyIpValidated: false,
            proxyValidationError: '',
            proxyValidationEndpoint: serverNetwork.endpoint || ''
        };
    }

    const proxyConfig = proxyManager.getProxyConfigForSession(sid);
    const proxyRecord = proxyManager.getProxyRecordForSession(sid);
    const proxyNetwork = proxyConfig ? await fetchOutboundPublicIp(proxyConfig) : { ip: '', endpoint: '', error: '' };
    const proxyConnectionIp = proxyNetwork.ip || '';
    const usingProxy = !!proxyConfig;
    const proxyIpValidated = !!(usingProxy && proxyConnectionIp);
    return {
        serverRealIp,
        currentConnectionIp: usingProxy ? (proxyConnectionIp || '') : serverRealIp,
        proxyConnectionIp,
        proxyHost: proxyRecord && proxyRecord.host ? String(proxyRecord.host) : '',
        proxyPort: proxyRecord && proxyRecord.port ? String(proxyRecord.port) : '',
        proxyName: proxyRecord && proxyRecord.name ? String(proxyRecord.name) : '',
        usingProxy,
        proxyIpValidated,
        proxyValidationError: proxyNetwork.error || '',
        proxyValidationEndpoint: proxyNetwork.endpoint || ''
    };
}

function shouldIgnoreFatalError(err) {
    const msg = err && (err.stack || err.message || String(err));
    if (!msg) return false;
    const isBusy = msg.includes('EBUSY') || msg.includes('EPERM') || msg.toLowerCase().includes('resource busy') || msg.toLowerCase().includes('locked');
    if (!isBusy) return false;
    return msg.includes('.wwebjs_auth');
}

process.on('uncaughtException', (err) => {
    if (shouldIgnoreFatalError(err)) {
        console.error('[uncaughtException ignored]', err?.message || err);
        return;
    }
    console.error('[uncaughtException]', err);
    setTimeout(() => process.exit(1), 250);
});

process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    if (shouldIgnoreFatalError(err)) {
        console.error('[unhandledRejection ignored]', err?.message || err);
        return;
    }
    console.error('[unhandledRejection]', err);
    setTimeout(() => process.exit(1), 250);
});

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const multer = require('multer');

// Configurações
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, '../data');
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, '../public'))
    ? path.join(__dirname, '../public')
    : path.join(__dirname, '../Public');
const KANBAN_FILE = path.join(__dirname, '../data/kanban.json');
const SESSIONS_FILE = path.join(__dirname, '../data/sessions.json');
const SCHEDULED_MESSAGES_FILE = path.join(__dirname, '../data/scheduled_messages.json');
const CONTACTS_FILE = path.join(__dirname, '../data/contacts.json');
const FLOWS_FILE = path.join(__dirname, '../data/flows.json');
const TAGS_FILE = path.join(__dirname, '../data/tags.json');
const AI_CONFIG_FILE = path.join(__dirname, '../data/ai_config.json');
const AI_CHAT_STATUS_FILE = path.join(__dirname, '../data/ai_chat_status.json');
const AI_TRANSCRIPTS_FILE = path.join(__dirname, '../data/ai_transcripts.json');
const WINBACK_CAMPAIGNS_FILE = path.join(__dirname, '../data/winback_campaigns.json');
const WINBACK_STATS_FILE = path.join(__dirname, '../data/winback_stats.json');
const LID_PHONE_MAP_FILE = path.join(__dirname, '../data/lid_phone_map.json');

const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
const GOOGLE_REDIRECT_URI = String(process.env.GOOGLE_REDIRECT_URI || 'https://app.zapmro.com/auth/google/callback').trim();

const googleOAuthStates = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of googleOAuthStates.entries()) {
        if (!v || !v.expiresAt || now > v.expiresAt) googleOAuthStates.delete(k);
    }
}, 60_000);

function ensureGoogleConfigOrThrow() {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
        const e = new Error('google_oauth_not_configured');
        e.code = 'google_oauth_not_configured';
        throw e;
    }
}

function maskEmail(email) {
    const v = String(email || '').trim();
    if (!v.includes('@')) return v;
    const [u, d] = v.split('@');
    const uu = u.length <= 2 ? u : `${u.slice(0, 2)}***`;
    const dd = d.length <= 2 ? d : `${d.slice(0, 2)}***`;
    return `${uu}@${dd}`;
}

function getUserSessionId(user) {
    return user && user.sessionId ? String(user.sessionId) : '';
}

function getGoogleAuthFromUser(user) {
    const g = user && user.google ? user.google : null;
    if (!g || !g.refreshToken) return null;
    return {
        connectedAt: g.connectedAt || null,
        email: g.email || '',
        refreshToken: g.refreshToken || '',
        accessToken: g.accessToken || '',
        accessTokenExpiresAt: g.accessTokenExpiresAt || 0
    };
}

async function refreshGoogleAccessToken(refreshToken) {
    const params = new URLSearchParams();
    params.set('client_id', GOOGLE_CLIENT_ID);
    params.set('client_secret', GOOGLE_CLIENT_SECRET);
    params.set('refresh_token', String(refreshToken || ''));
    params.set('grant_type', 'refresh_token');
    const r = await axios.post('https://oauth2.googleapis.com/token', params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 20_000
    });
    return r.data || {};
}

async function ensureGoogleAccessTokenForUser(user) {
    ensureGoogleConfigOrThrow();
    const auth = getGoogleAuthFromUser(user);
    if (!auth) return { ok: false, error: 'google_not_connected' };
    const now = Date.now();
    if (auth.accessToken && auth.accessTokenExpiresAt && now + 60_000 < Number(auth.accessTokenExpiresAt)) {
        return { ok: true, accessToken: auth.accessToken };
    }
    const tokenResp = await refreshGoogleAccessToken(auth.refreshToken);
    const accessToken = String(tokenResp.access_token || '');
    const expiresIn = Number(tokenResp.expires_in || 0);
    const accessTokenExpiresAt = now + Math.max(0, expiresIn) * 1000;
    const next = upsertUser({
        ...user,
        google: {
            ...(user.google || {}),
            accessToken,
            accessTokenExpiresAt
        },
        updatedAt: Date.now()
    });
    const updated = getGoogleAuthFromUser(next);
    if (!updated || !updated.accessToken) return { ok: false, error: 'google_token_refresh_failed' };
    return { ok: true, accessToken: updated.accessToken };
}

function normalizeDigits(v) {
    const s = String(v || '');
    const d = s.replace(/\D/g, '');
    return d || '';
}

function buildContactIndexForSession(sessionId) {
    const sid = String(sessionId || '');
    const store = loadContacts();
    const sessionContacts = store && store[sid] && typeof store[sid] === 'object' ? store[sid] : {};
    const byDigits = new Map();

    function consider(digits, record) {
        const d = normalizeDigits(digits);
        if (!d) return;
        const rec = record && typeof record === 'object' ? record : {};
        const t = Number(rec.updatedAt || 0) || 0;
        const existing = byDigits.get(d);
        const et = existing ? (Number(existing.updatedAt || 0) || 0) : 0;
        if (!existing || t >= et) byDigits.set(d, rec);
    }

    for (const [key, v] of Object.entries(sessionContacts)) {
        if (String(key).startsWith('__')) continue;
        if (!v || typeof v !== 'object') continue;
        consider(v.waNumber || v.phoneNumber || '', v);
        if (String(key).includes('@c.us')) consider(String(key).split('@')[0], v);
        if (String(key).startsWith('manual_')) consider(String(key).slice('manual_'.length), v);
    }

    const googleContacts = Array.isArray(sessionContacts.__googleContacts) ? sessionContacts.__googleContacts : [];
    for (const g of googleContacts) {
        if (!g || typeof g !== 'object') continue;
        const digits = g.phoneDigits || g.phone || '';
        const name = g.name ? String(g.name) : '';
        const updatedAt = Number(g.updatedAt || 0) || 0;
        if (!name) continue;
        consider(digits, { name, updatedAt, waNumber: normalizeDigits(digits) });
    }

    return { sessionContacts, byDigits };
}

function pickPrimaryName(person) {
    const names = person && Array.isArray(person.names) ? person.names : [];
    const primary = names.find(n => n && n.metadata && n.metadata.primary) || names[0] || null;
    const dn = primary && primary.displayName ? String(primary.displayName) : '';
    return dn.trim();
}

function pickPrimaryEmail(person) {
    const emails = person && Array.isArray(person.emailAddresses) ? person.emailAddresses : [];
    const primary = emails.find(e => e && e.metadata && e.metadata.primary) || emails[0] || null;
    const v = primary && primary.value ? String(primary.value) : '';
    return v.trim();
}

function pickPrimaryPhone(person) {
    const phones = person && Array.isArray(person.phoneNumbers) ? person.phoneNumbers : [];
    const primary = phones.find(p => p && p.metadata && p.metadata.primary) || phones[0] || null;
    const v = primary && primary.value ? String(primary.value) : '';
    return v.trim();
}

async function googleRequest(accessToken, method, url, data) {
    const cfg = {
        method,
        url,
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 25_000
    };
    if (data !== undefined) cfg.data = data;
    const r = await axios(cfg);
    return r.data;
}

async function importGoogleContactsForUser(user) {
    const tokenRes = await ensureGoogleAccessTokenForUser(user);
    if (!tokenRes.ok) return { ok: false, error: tokenRes.error };
    const accessToken = tokenRes.accessToken;
    let pageToken = '';
    const out = [];
    for (let i = 0; i < 10; i++) {
        const u = new URL('https://people.googleapis.com/v1/people/me/connections');
        u.searchParams.set('personFields', 'names,emailAddresses,phoneNumbers,metadata');
        u.searchParams.set('pageSize', '1000');
        if (pageToken) u.searchParams.set('pageToken', pageToken);
        const data = await googleRequest(accessToken, 'GET', u.toString());
        const connections = data && Array.isArray(data.connections) ? data.connections : [];
        for (const p of connections) {
            const name = pickPrimaryName(p);
            const email = pickPrimaryEmail(p);
            const phone = pickPrimaryPhone(p);
            const resourceName = p && p.resourceName ? String(p.resourceName) : '';
            const etag = p && p.etag ? String(p.etag) : '';
            if (!name && !email && !phone) continue;
            out.push({
                resourceName,
                etag,
                name: name || '',
                email: email || '',
                phone: phone || '',
                phoneDigits: normalizeDigits(phone),
                updatedAt: Date.now()
            });
        }
        pageToken = data && data.nextPageToken ? String(data.nextPageToken) : '';
        if (!pageToken) break;
    }
    return { ok: true, contacts: out };
}

async function createGoogleContactForUser(user, { name, phone, email }) {
    const tokenRes = await ensureGoogleAccessTokenForUser(user);
    if (!tokenRes.ok) return { ok: false, error: tokenRes.error };
    const accessToken = tokenRes.accessToken;
    const body = {};
    const nm = String(name || '').trim();
    if (nm) body.names = [{ displayName: nm, givenName: nm }];
    const ph = String(phone || '').trim();
    if (ph) body.phoneNumbers = [{ value: ph }];
    const em = String(email || '').trim();
    if (em) body.emailAddresses = [{ value: em }];
    const data = await googleRequest(accessToken, 'POST', 'https://people.googleapis.com/v1/people:createContact?personFields=names,emailAddresses,phoneNumbers', body);
    const resourceName = data && data.resourceName ? String(data.resourceName) : '';
    const etag = data && data.etag ? String(data.etag) : '';
    return { ok: true, resourceName, etag };
}

function encodeGoogleResourceName(resourceName) {
    const rn = String(resourceName || '').trim();
    if (!rn) return '';
    return rn
        .split('/')
        .map(seg => encodeURIComponent(seg))
        .join('/');
}

async function getGoogleContactForUser(user, resourceName) {
    const rn = String(resourceName || '').trim();
    if (!rn) return { ok: false, error: 'resource_name_required' };
    const tokenRes = await ensureGoogleAccessTokenForUser(user);
    if (!tokenRes.ok) return { ok: false, error: tokenRes.error };
    const accessToken = tokenRes.accessToken;
    const encoded = encodeGoogleResourceName(rn);
    const u = new URL(`https://people.googleapis.com/v1/${encoded}`);
    u.searchParams.set('personFields', 'names,emailAddresses,phoneNumbers,metadata');
    const data = await googleRequest(accessToken, 'GET', u.toString());
    const etag = data && data.etag ? String(data.etag) : '';
    return { ok: true, etag, data };
}

async function updateGoogleContactForUser(user, { resourceName, etag, name, phone, email }) {
    const rn = String(resourceName || '').trim();
    if (!rn) return { ok: false, error: 'resource_name_required' };
    const tokenRes = await ensureGoogleAccessTokenForUser(user);
    if (!tokenRes.ok) return { ok: false, error: tokenRes.error };
    const accessToken = tokenRes.accessToken;
    const encoded = encodeGoogleResourceName(rn);
    const u = new URL(`https://people.googleapis.com/v1/${encoded}:updateContact`);
    u.searchParams.set('updatePersonFields', 'names,emailAddresses,phoneNumbers');
    const body = {};
    const e = String(etag || '').trim();
    if (e) body.etag = e;
    const nm = String(name || '').trim();
    if (nm) body.names = [{ displayName: nm, givenName: nm }];
    const ph = String(phone || '').trim();
    if (ph) body.phoneNumbers = [{ value: ph }];
    const em = String(email || '').trim();
    if (em) body.emailAddresses = [{ value: em }];
    const data = await googleRequest(accessToken, 'PATCH', u.toString(), body);
    const nextEtag = data && data.etag ? String(data.etag) : '';
    return { ok: true, resourceName: rn, etag: nextEtag };
}

async function exchangeGoogleCodeForTokens(code) {
    ensureGoogleConfigOrThrow();
    const params = new URLSearchParams();
    params.set('client_id', GOOGLE_CLIENT_ID);
    params.set('client_secret', GOOGLE_CLIENT_SECRET);
    params.set('redirect_uri', GOOGLE_REDIRECT_URI);
    params.set('code', String(code || ''));
    params.set('grant_type', 'authorization_code');
    const r = await axios.post('https://oauth2.googleapis.com/token', params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 25_000
    });
    return r.data || {};
}

async function fetchGoogleUserEmail(accessToken) {
    const t = String(accessToken || '').trim();
    if (!t) return '';
    const data = await googleRequest(t, 'GET', 'https://www.googleapis.com/oauth2/v3/userinfo');
    const em = data && data.email ? String(data.email) : '';
    return em.trim();
}
const SESSION_PASSWORDS_FILE = path.join(__dirname, '../data/session_passwords.json');
const USERS_FILE = path.join(__dirname, '../data/users.json');
const AUTH_TOKENS_FILE = path.join(__dirname, '../data/auth_tokens.json');
const ARCHIVE_DIR = path.join(__dirname, '../data/archives');
const HISTORY_DIR = path.join(__dirname, '../data/history');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');

// Ensure directories exist
[ARCHIVE_DIR, HISTORY_DIR, UPLOADS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

function migrateLegacyUploadsToDefaultSessionDir() {
    try {
        const defaultSessionId = getDefaultSessionId();
        const safeDefault = String(defaultSessionId || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
        const defaultDir = path.join(UPLOADS_DIR, safeDefault);
        if (!fs.existsSync(defaultDir)) fs.mkdirSync(defaultDir, { recursive: true });

        const items = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true });
        for (const it of items) {
            if (!it.isFile()) continue;
            const name = it.name;
            if (!/\.(jpg|jpeg|png|gif|mp3|ogg|wav|mp4|webm)$/i.test(name)) continue;
            const from = path.join(UPLOADS_DIR, name);
            const to = path.join(defaultDir, name);
            if (fs.existsSync(to)) continue;
            fs.renameSync(from, to);
        }
    } catch (e) {}
}

setTimeout(migrateLegacyUploadsToDefaultSessionDir, 0);

// Multer Configuration for Uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const rawSessionId = (req.query && req.query.sessionId) ? String(req.query.sessionId) : '';
        const safeSessionId = rawSessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
        if (!safeSessionId) {
            cb(null, UPLOADS_DIR);
            return;
        }
        const sessionDir = path.join(UPLOADS_DIR, safeSessionId);
        try {
            if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
        } catch (e) {}
        cb(null, sessionDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname)
    }
});
const upload = multer({ storage: storage });

function queryFlag(value) {
    if (typeof value === 'boolean') return value;
    const text = String(value || '').trim().toLowerCase();
    return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

function toPublicRelativePath(absPath) {
    const rel = path.relative(PUBLIC_DIR, absPath || '');
    return String(rel || '').replace(/\\/g, '/');
}

function toPublicAssetUrl(assetPath) {
    const raw = String(assetPath || '').trim();
    if (!raw) return '';
    if (/^(https?:)?\/\//i.test(raw) || /^data:/i.test(raw)) return raw;
    const rel = raw.replace(/^[/\\]+/, '').replace(/\\/g, '/');
    if (!rel) return '';
    if (PUBLIC_BASE_URL) return `${PUBLIC_BASE_URL}/${rel}`;
    return `/${rel}`;
}

async function convertAudioToVoiceNoteOgg(inputPath, options = {}) {
    const {
        outputNamePrefix = 'ptt',
        force = false,
        removeOriginal = false
    } = options;

    const ext = path.extname(inputPath || '').toLowerCase();
    if (!force && ext === '.ogg') {
        return inputPath;
    }

    const ffmpeg = require('fluent-ffmpeg');
    try {
        const ffmpegPath = require('ffmpeg-static');
        if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
    } catch (e) {
        console.warn('ffmpeg-static not found, relying on system ffmpeg');
    }

    const baseName = `${outputNamePrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const outPath = path.join(path.dirname(inputPath), `${baseName}.ogg`);

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .noVideo()
            .audioCodec('libopus')
            .audioChannels(1)
            .audioFrequency(48000)
            .format('ogg')
            .outputOptions(['-b:a 24k', '-vbr on', '-application voip'])
            .on('end', resolve)
            .on('error', reject)
            .save(outPath);
    });

    if (removeOriginal && path.resolve(outPath) !== path.resolve(inputPath)) {
        try { fs.unlinkSync(inputPath); } catch (e) {}
    }

    return outPath;
}

// Helper functions for Data Persistence
function loadData(file) {
    try {
        if (fs.existsSync(file)) {
            const data = fs.readFileSync(file, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error(`Error loading data from ${file}:`, error);
    }
    return {};
}

function saveData(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error(`Error saving data to ${file}:`, error);
    }
}

// Wrapper for specific files
function loadKanbanData() { return loadData(KANBAN_FILE); }
function saveKanbanData(data) { saveData(KANBAN_FILE, data); }
function loadSessionsData() { return loadData(SESSIONS_FILE); }
function saveSessionsData(data) { saveData(SESSIONS_FILE, data); }
function loadScheduledMessages() { return loadData(SCHEDULED_MESSAGES_FILE); }
function saveScheduledMessages(data) { saveData(SCHEDULED_MESSAGES_FILE, data); }
function loadContacts() { return loadData(CONTACTS_FILE); }
function saveContacts(data) { saveData(CONTACTS_FILE, data); }
function loadUsersStore() {
    const raw = loadData(USERS_FILE);
    if (raw && typeof raw === 'object' && Array.isArray(raw.users)) return raw;
    return { users: [] };
}
function saveUsersStore(store) { saveData(USERS_FILE, store && typeof store === 'object' ? store : { users: [] }); }

function loadWinbackCampaigns() { return loadData(WINBACK_CAMPAIGNS_FILE); }
function saveWinbackCampaigns(data) { saveData(WINBACK_CAMPAIGNS_FILE, data); }

// --- HISTORY PERSISTENCE HELPERS ---
function getHistoryFilePath(sessionId, chatId) {
    const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeChat = String(chatId).replace(/[^a-zA-Z0-9@._-]/g, '_');
    const sessionDir = path.join(HISTORY_DIR, safeSession);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    return path.join(sessionDir, `${safeChat}.json`);
}

function saveMessageToHistory(sessionId, chatId, messageData) {
    try {
        const file = getHistoryFilePath(sessionId, chatId);
        let history = [];
        if (fs.existsSync(file)) {
            const raw = fs.readFileSync(file, 'utf8');
            try { history = JSON.parse(raw); } catch (e) {}
        }
        if (!Array.isArray(history)) history = [];
        
        // Deduplicate
        const existsIndex = history.findIndex(m => m.id === messageData.id);
        if (existsIndex >= 0) {
            // Update existing
            history[existsIndex] = { ...history[existsIndex], ...messageData };
        } else {
            // Append
            history.push(messageData);
        }
        
        // Keep last 500 messages to avoid huge files (optional, but good practice)
        if (history.length > 500) {
            history = history.slice(-500);
        }

        fs.writeFileSync(file, JSON.stringify(history, null, 2));
    } catch (e) {
        console.error('Error saving history:', e);
    }
}

function getEvolutionWebhookUrl() {
    return EVOLUTION_WEBHOOK_URL;
}

function buildEvolutionWebhookConfig() {
    const url = sanitizeWebhookUrl(getEvolutionWebhookUrl());
    if (!url) return null;
    return {
        enabled: true,
        url,
        byEvents: false,
        base64: true,
        events: [
            'QRCODE_UPDATED',
            'CONNECTION_UPDATE',
            'MESSAGES_UPSERT',
            'MESSAGES_UPDATE',
            'SEND_MESSAGE',
            'SEND_MESSAGE_UPDATE'
        ]
    };
}

function evolutionInstanceName(sessionId) {
    return String(sessionId || '').trim();
}

function normalizeEvolutionChatId(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.endsWith('@g.us') || raw.endsWith('@lid') || raw.endsWith('@newsletter')) return raw;
    if (raw.endsWith('@s.whatsapp.net')) return `${raw.slice(0, raw.indexOf('@'))}@c.us`;
    if (raw.endsWith('@c.us')) return raw;
    const digits = normalizeEvolutionPhone(raw);
    return digits ? `${digits}@c.us` : raw;
}

function normalizeEvolutionPhone(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/@lid$/i.test(raw) || /@g\.us$/i.test(raw) || /@newsletter$/i.test(raw)) return '';
    return evolutionDigits(raw);
}

function getLidDigits(chatId) {
    const lid = normalizeEvolutionChatId(chatId);
    if (!/@lid$/i.test(lid)) return '';
    return evolutionDigits(lid.replace(/@lid$/i, ''));
}

function isSuspiciousLidPhone(chatId, phoneNumber) {
    const digits = normalizeEvolutionPhone(phoneNumber);
    const lidDigits = getLidDigits(chatId);
    return !!(digits && lidDigits && digits === lidDigits);
}

function isLikelyTechnicalChatLabel(value) {
    const raw = String(value || '').trim();
    if (!raw || raw === '[object Object]') return true;
    if (/@lid$/i.test(raw)) return true;
    return /^[0-9@._+\-\s]+$/.test(raw);
}

function pickBestChatLabel(...values) {
    for (const value of values) {
        const text = String(value || '').trim();
        if (!text || isLikelyTechnicalChatLabel(text)) continue;
        return text;
    }
    return '';
}

function loadLidPhoneMap() {
    const data = loadData(LID_PHONE_MAP_FILE);
    const raw = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const cleaned = {};
    let changed = false;
    for (const [lid, value] of Object.entries(raw)) {
        const normalizedLid = normalizeEvolutionChatId(lid);
        const digits = normalizeEvolutionPhone(value || '');
        if (!/@lid$/i.test(normalizedLid) || !digits || digits.length < 10 || digits.length > 15 || isSuspiciousLidPhone(normalizedLid, digits)) {
            changed = true;
            continue;
        }
        cleaned[normalizedLid] = digits;
        if (normalizedLid !== lid || digits !== value) changed = true;
    }
    if (changed) saveData(LID_PHONE_MAP_FILE, cleaned);
    return cleaned;
}

function saveLidPhoneMap(data) {
    saveData(LID_PHONE_MAP_FILE, data && typeof data === 'object' && !Array.isArray(data) ? data : {});
}

function getStoredPhoneForLid(chatId) {
    const lid = normalizeEvolutionChatId(chatId);
    if (!/@lid$/i.test(lid)) return '';
    const stored = loadLidPhoneMap()[lid];
    const digits = normalizeEvolutionPhone(stored || '');
    if (!digits || digits.length < 10 || digits.length > 15) return '';
    if (isSuspiciousLidPhone(lid, digits)) return '';
    return digits;
}

function rememberLidPhone(chatId, phoneNumber) {
    const lid = normalizeEvolutionChatId(chatId);
    const digits = normalizeEvolutionPhone(phoneNumber);
    if (!/@lid$/i.test(lid) || !digits || digits.length < 10 || digits.length > 15) return;
    if (isSuspiciousLidPhone(lid, digits)) return;
    const current = loadLidPhoneMap();
    if (current[lid] === digits) return;
    current[lid] = digits;
    saveLidPhoneMap(current);
}

function toEvolutionApiTarget(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.endsWith('@g.us') || raw.endsWith('@lid') || raw.endsWith('@newsletter')) return raw;
    return evolutionRemoteJid(raw);
}

function normalizeEvolutionEventName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[.\s-]+/g, '_');
}

function extractEvolutionSessionId(payload) {
    const direct = [
        payload?.instance,
        payload?.session,
        payload?.instanceName,
        payload?.sender,
        payload?.data?.instance,
        payload?.data?.session,
        payload?.data?.instanceName,
        payload?.data?.instance?.instanceName,
        payload?.data?.instance?.name
    ];
    for (const item of direct) {
        if (typeof item === 'string' && item.trim()) return item.trim();
        if (item && typeof item === 'object') {
            const nested = item.instanceName || item.name;
            if (typeof nested === 'string' && nested.trim()) return nested.trim();
        }
    }
    return '';
}

function normalizeEvolutionAck(value) {
    const raw = String(value || '').trim().toUpperCase();
    if (!raw) return 0;
    if (raw === 'PENDING') return 0;
    if (raw === 'SERVER_ACK') return 1;
    if (raw === 'DELIVERY_ACK') return 2;
    if (raw === 'READ') return 3;
    if (raw === 'PLAYED') return 4;
    if (raw === 'DELETED') return 5;
    const num = Number(raw);
    return Number.isFinite(num) ? num : 0;
}

function normalizeEvolutionTimestamp(value) {
    if (value === null || value === undefined || value === '') return Math.floor(Date.now() / 1000);
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n > 10_000_000_000 ? Math.floor(n / 1000) : Math.floor(n);
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed / 1000);
    }
    return Math.floor(Date.now() / 1000);
}

function extractEvolutionMessageContent(rawMessage) {
    const wrapper = rawMessage && typeof rawMessage === 'object' ? rawMessage : {};
    const message = wrapper.message && typeof wrapper.message === 'object' ? wrapper.message : wrapper;

    if (typeof message.conversation === 'string') {
        return { type: 'chat', body: message.conversation, hasMedia: false, media: null };
    }
    if (message.extendedTextMessage && typeof message.extendedTextMessage.text === 'string') {
        return { type: 'chat', body: message.extendedTextMessage.text, hasMedia: false, media: null };
    }
    if (message.imageMessage) {
        const media = message.imageMessage;
        return {
            type: 'image',
            body: media.caption || '',
            hasMedia: true,
            media: {
                mimetype: media.mimetype || 'image/jpeg',
                data: media.base64 || media.jpegThumbnail || null,
                filename: media.fileName || 'image'
            }
        };
    }
    if (message.videoMessage) {
        const media = message.videoMessage;
        return {
            type: 'video',
            body: media.caption || '',
            hasMedia: true,
            media: {
                mimetype: media.mimetype || 'video/mp4',
                data: media.base64 || media.jpegThumbnail || null,
                filename: media.fileName || 'video'
            }
        };
    }
    if (message.audioMessage) {
        const media = message.audioMessage;
        return {
            type: media.ptt ? 'ptt' : 'audio',
            body: '',
            hasMedia: true,
            media: {
                mimetype: media.mimetype || 'audio/ogg',
                data: media.base64 || null,
                filename: media.fileName || 'audio'
            }
        };
    }
    if (message.documentMessage) {
        const media = message.documentMessage;
        return {
            type: 'document',
            body: media.caption || media.fileName || '',
            hasMedia: true,
            media: {
                mimetype: media.mimetype || 'application/octet-stream',
                data: media.base64 || null,
                filename: media.fileName || 'document'
            }
        };
    }
    if (message.stickerMessage) {
        return {
            type: 'sticker',
            body: '',
            hasMedia: true,
            media: {
                mimetype: 'image/webp',
                data: message.stickerMessage.base64 || null,
                filename: 'sticker.webp'
            }
        };
    }
    return { type: 'chat', body: '', hasMedia: false, media: null };
}

function extractEvolutionInteractiveReply(rawMessage) {
    const wrapper = rawMessage && typeof rawMessage === 'object' ? rawMessage : {};
    const message = wrapper.message && typeof wrapper.message === 'object' ? wrapper.message : wrapper;

    const buttonReply =
        message.buttonReply ||
        wrapper.buttonReply ||
        message.buttonsResponseMessage ||
        message.templateButtonReplyMessage ||
        message.interactiveResponseMessage?.buttonReplyMessage ||
        null;
    if (buttonReply && typeof buttonReply === 'object') {
        const id = buttonReply.selectedButtonId || buttonReply.buttonId || buttonReply.selectedId || buttonReply.id || '';
        const text =
            buttonReply.selectedDisplayText ||
            buttonReply.displayText ||
            buttonReply.selectedText ||
            buttonReply.title ||
            buttonReply.text ||
            '';
        if (id || text) {
            return {
                kind: 'button',
                id: String(id || '').trim(),
                text: String(text || '').trim()
            };
        }
    }

    const listReply =
        message.listReply ||
        wrapper.listReply ||
        message.listResponseMessage ||
        message.interactiveResponseMessage?.listReplyMessage ||
        null;
    if (listReply && typeof listReply === 'object') {
        const id = listReply.rowId || listReply.selectedRowId || listReply.id || '';
        const text = listReply.title || listReply.selectedTitle || listReply.description || '';
        if (id || text) {
            return {
                kind: 'list',
                id: String(id || '').trim(),
                text: String(text || '').trim()
            };
        }
    }

    return null;
}

function normalizeEvolutionInboundMessage(sessionId, rawMessage) {
    const msg = rawMessage && typeof rawMessage === 'object' ? rawMessage : {};
    const key = msg.key && typeof msg.key === 'object' ? msg.key : {};
    const chatId = normalizeEvolutionChatId(
        key.remoteJid ||
        msg.remoteJid ||
        msg.chatId ||
        msg.from
    );
    const content = extractEvolutionMessageContent(msg);
    const interactiveReply = extractEvolutionInteractiveReply(msg);
    const fromMe = !!(key.fromMe || msg.fromMe);
    const id = key.id || msg.id || crypto.randomBytes(8).toString('hex');
    const from = fromMe ? (msg.sender || chatId) : (msg.sender || chatId);
    const to = fromMe ? chatId : (msg.owner || '');
    return {
        id,
        body: content.body || (interactiveReply ? interactiveReply.text : '') || '',
        from,
        to,
        chatId,
        timestamp: normalizeEvolutionTimestamp(msg.messageTimestamp || msg.timestamp || msg.date_time),
        fromMe,
        type: content.type,
        hasMedia: !!content.hasMedia,
        ack: normalizeEvolutionAck(msg.status || msg.messageStatus),
        media: content.media,
        interactiveReplyId: interactiveReply && interactiveReply.id ? normalizeFlowInteractiveId(interactiveReply.id) : '',
        interactiveReplyType: interactiveReply && interactiveReply.kind ? interactiveReply.kind : '',
        interactiveReplyText: interactiveReply && interactiveReply.text ? interactiveReply.text : '',
        _evoRaw: msg
    };
}

function getEvolutionMessageId(message) {
    if (!message) return '';
    const key = message.key && typeof message.key === 'object' ? message.key : {};
    return String(key.id || message.id || '');
}

function getEvolutionMessageChatId(message) {
    if (!message) return '';
    const key = message.key && typeof message.key === 'object' ? message.key : {};
    return normalizeEvolutionChatId(key.remoteJid || message.remoteJid || message.chatId || '');
}

function extractEvolutionRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    if (Array.isArray(payload.chats)) return payload.chats;
    if (Array.isArray(payload.messages)) return payload.messages;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.records)) return payload.records;
    return [];
}

function normalizeEvolutionChatRecord(sessionId, rawChat) {
    const chat = rawChat && typeof rawChat === 'object' ? rawChat : {};
    const rawRemoteJid = normalizeEvolutionChatId(
        chat.remoteJid ||
        chat.id ||
        chat.key?.remoteJid ||
        chat.chatId ||
        chat.jid
    );
    const explicitPhone = normalizeEvolutionPhone(
        chat.phone ||
        chat.number ||
        chat.owner ||
        chat.participant ||
        chat.key?.participant
    );
    const displayPhone = extractPhoneDigits(
        chat.pushName ||
        chat.name ||
        chat.contactName ||
        chat.profileName ||
        ''
    );
    const remoteDigits = normalizeEvolutionPhone(rawRemoteJid);
    const shouldPreferDisplayPhone = !!(
        displayPhone &&
        remoteDigits &&
        displayPhone !== remoteDigits &&
        /@(c\.us|s\.whatsapp\.net)$/i.test(rawRemoteJid)
    );
    const storedPhone = getStoredPhoneForLid(rawRemoteJid) || findStoredPhoneForLid(rawRemoteJid);
    const normalizedPhone = explicitPhone || storedPhone || (rawRemoteJid.endsWith('@lid') ? displayPhone : '') || (shouldPreferDisplayPhone ? displayPhone : '') || remoteDigits;
    const remoteJid = (rawRemoteJid.endsWith('@lid') || shouldPreferDisplayPhone) && normalizedPhone
        ? `${normalizedPhone}@c.us`
        : rawRemoteJid;
    if (rawRemoteJid.endsWith('@lid') && normalizedPhone) rememberLidPhone(rawRemoteJid, normalizedPhone);
    const shouldDebugSuspiciousChat = !!(
        rawRemoteJid &&
        (/@lid$/i.test(rawRemoteJid) || (/@c\.us$/i.test(rawRemoteJid) && remoteDigits && remoteDigits.length > 13)) &&
        !explicitPhone &&
        !displayPhone
    );
    if (shouldDebugSuspiciousChat) {
        console.log('[evolution-chat-debug]', JSON.stringify({
            sessionId,
            rawRemoteJid,
            normalizedPhone,
            pushName: chat.pushName || '',
            name: chat.name || '',
            contactName: chat.contactName || '',
            profileName: chat.profileName || '',
            phone: chat.phone || '',
            number: chat.number || '',
            owner: chat.owner || '',
            participant: chat.participant || '',
            keyParticipant: chat.key?.participant || ''
        }));
    }
    const resolvedLabel = pickBestChatLabel(
        chat.pushName,
        chat.name,
        chat.contactName,
        chat.profileName,
        chat.subject
    );
    const name = resolvedLabel || normalizedPhone || remoteJid.split('@')[0];
    const lastMessageObj = chat.lastMessage && typeof chat.lastMessage === 'object' ? chat.lastMessage : {};
    const lastContent = extractEvolutionMessageContent(lastMessageObj);
    return {
        id: remoteJid,
        name,
        phoneNumber: normalizedPhone,
        unreadCount: Number(chat.unreadCount || chat.unread || 0) || 0,
        timestamp: normalizeEvolutionTimestamp(chat.updatedAt || chat.messageTimestamp || lastMessageObj.messageTimestamp || chat.timestamp),
        lastMessage: lastContent.body || chat.lastMessageText || chat.lastMessage || '',
        profilePic: sanitizeEvolutionUrl(chat.profilePictureUrl || chat.profilePicUrl || null)
    };
}

function collectDeepStringValues(value, bucket = [], depth = 0) {
    if (depth > 4 || value == null) return bucket;
    if (typeof value === 'string' || typeof value === 'number') {
        bucket.push(String(value));
        return bucket;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectDeepStringValues(item, bucket, depth + 1);
        return bucket;
    }
    if (typeof value === 'object') {
        for (const key of Object.keys(value)) {
            collectDeepStringValues(value[key], bucket, depth + 1);
        }
    }
    return bucket;
}

function extractEvolutionProfileInfo(profile) {
    const values = collectDeepStringValues(profile, []);
    let phoneDigits = '';
    for (const value of values) {
        const digits = normalizeEvolutionPhone(value);
        if (digits && digits.length >= 10 && digits.length <= 15) {
            phoneDigits = digits;
            break;
        }
    }

    const possibleNames = [
        profile?.pushName,
        profile?.profileName,
        profile?.fullName,
        profile?.name,
        profile?.contactName,
        profile?.subject
    ].map(v => String(v || '').trim()).filter(Boolean);
    const name = possibleNames.find(v => !/^[0-9@._+\-\s]+$/.test(v) && v !== '[object Object]') || '';
    return { phoneDigits, name };
}

function extractEvolutionContactInfo(payload) {
    const rows = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.contacts) ? payload.contacts : (Array.isArray(payload?.data?.contacts) ? payload.data.contacts : []));
    for (const row of rows) {
        const remoteJid = normalizeEvolutionChatId(row?.remoteJid || row?.jid || row?.id || '');
        const phoneDigits = normalizeEvolutionPhone(remoteJid || row?.phone || row?.number || '');
        const name = pickBestChatLabel(
            row?.pushName,
            row?.name,
            row?.profileName,
            row?.fullName,
            row?.contactName
        );
        const profilePictureUrl = sanitizeEvolutionUrl(row?.profilePictureUrl || row?.profilePicUrl || row?.profilePic || '');
        if (!remoteJid && !phoneDigits && !name && !profilePictureUrl) continue;
        return { remoteJid, phoneDigits, name, profilePictureUrl };
    }
    return { remoteJid: '', phoneDigits: '', name: '', profilePictureUrl: '' };
}

async function fetchEvolutionContactIdentity(sessionId, chatId) {
    if (!USE_EVOLUTION || !evolutionApi) return { remoteJid: '', phoneDigits: '', name: '', profilePictureUrl: '' };
    const candidates = collectPossibleChatIds(sessionId, chatId);
    const cacheKey = `${sessionId}:${candidates.sort().join('|')}`;
    const cached = evolutionContactLookupCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.at) < EVOLUTION_CONTACT_LOOKUP_TTL_MS) {
        return cached.value;
    }

    const candidateIds = Array.from(new Set(
        candidates
            .map(value => normalizeEvolutionChatId(value))
            .filter(Boolean)
    ));

    let best = { remoteJid: '', phoneDigits: '', name: '', profilePictureUrl: '' };
    for (const candidateId of candidateIds) {
        try {
            const result = await evolutionApi.findContacts(evolutionInstanceName(sessionId), {
                where: { remoteJid: candidateId },
                limit: 5,
                offset: 0,
                sort: { field: 'updatedAt', order: 'desc' }
            });
            const info = extractEvolutionContactInfo(result || {});
            if (info.remoteJid || info.phoneDigits || info.name || info.profilePictureUrl) {
                best = info;
                break;
            }
        } catch (e) {}
    }

    evolutionContactLookupCache.set(cacheKey, { at: now, value: best });
    return best;
}

function collectPossibleChatIds(sessionId, chatId) {
    const out = new Set();
    const base = String(chatId || '').trim();
    if (!base) return [];
    out.add(base);

    const normalized = normalizeEvolutionChatId(base);
    if (normalized) out.add(normalized);

    const digits = normalizeEvolutionPhone(base);
    if (digits) {
        out.add(`${digits}@c.us`);
        out.add(`${digits}@s.whatsapp.net`);
    }

    const cachedChats = loadChatCache(sessionId);
    const list = Array.isArray(cachedChats) ? cachedChats : [];
    const match = list.find(item => item && (
        String(item.id || '') === base ||
        String(item.id || '') === normalized ||
        (digits && normalizeEvolutionPhone(item.phoneNumber || item.id || '') === digits)
    ));
    if (match) {
        const cachedId = String(match.id || '').trim();
        const cachedDigits = normalizeEvolutionPhone(match.phoneNumber || cachedId);
        if (cachedId) out.add(cachedId);
        if (cachedDigits) {
            out.add(`${cachedDigits}@c.us`);
            out.add(`${cachedDigits}@s.whatsapp.net`);
        }
    }

    const localNumbers = new Set();
    for (const candidateId of Array.from(out)) {
        const history = loadMessageHistory(sessionId, candidateId);
        extractCandidateNumbersFromMessages(history).forEach(num => localNumbers.add(num));
    }
    const archiveFallback = loadArchiveFallback(sessionId, Array.from(out));
    archiveFallback.numbers.forEach(num => localNumbers.add(num));
    for (const num of localNumbers) {
        out.add(`${num}@c.us`);
        out.add(`${num}@s.whatsapp.net`);
    }

    return Array.from(out).filter(Boolean);
}

function buildEvolutionContactFromCache(sessionId, chatId) {
    const cache = loadChatCache(sessionId);
    const list = Array.isArray(cache) ? cache : [];
    const found = list.find(item => item && String(item.id) === String(chatId)) || null;
    const phoneDigits = normalizeEvolutionPhone(
        found && (found.phoneNumber || found.name || found.id)
            ? (found.phoneNumber || found.name || found.id)
            : chatId
    );
    return {
        id: { _serialized: String(chatId) },
        name: found && found.name ? String(found.name) : '',
        pushname: found && found.name ? String(found.name) : '',
        number: phoneDigits || '',
        async getProfilePicUrl() {
            if (found && found.profilePic) return found.profilePic;
            if (!USE_EVOLUTION || !evolutionApi) return null;
            try {
                const res = await evolutionApi.fetchProfilePictureUrl(evolutionInstanceName(sessionId), toEvolutionApiTarget(chatId));
                return res && (res.profilePictureUrl || res.url || res.picture || null);
            } catch (e) {
                return null;
            }
        },
        async getAbout() {
            if (!USE_EVOLUTION || !evolutionApi) return '';
            try {
                const res = await evolutionApi.fetchProfile(evolutionInstanceName(sessionId), toEvolutionApiTarget(chatId));
                return res && (res.about || res.description || '') ? String(res.about || res.description || '') : '';
            } catch (e) {
                return '';
            }
        }
    };
}

function createEvolutionMessageObject(sessionId, chatId, raw) {
    const payload = normalizeEvolutionInboundMessage(sessionId, raw);
    return {
        id: { _serialized: payload.id, remote: payload.chatId },
        body: payload.body,
        from: payload.from,
        to: payload.to,
        timestamp: payload.timestamp,
        fromMe: payload.fromMe,
        type: payload.type,
        hasMedia: payload.hasMedia,
        ack: payload.ack,
        _raw: raw,
        async getChat() {
            const sessionData = activeClients.get(sessionId);
            if (!sessionData || !sessionData.client) throw new Error('session_not_ready');
            return sessionData.client.getChatById(chatId || payload.chatId);
        },
        async downloadMedia() {
            if (payload.media && payload.media.data) return payload.media;
            if (!USE_EVOLUTION || !evolutionApi || !payload._evoRaw) return null;
            try {
                const res = await evolutionApi.getBase64FromMediaMessage(evolutionInstanceName(sessionId), payload._evoRaw);
                if (!res) return null;
                return {
                    mimetype: res.mimetype || payload.media?.mimetype || 'application/octet-stream',
                    data: res.base64 || res.data || null,
                    filename: res.fileName || payload.media?.filename || 'media'
                };
            } catch (e) {
                return null;
            }
        },
        async react() {
            return true;
        }
    };
}

function createEvolutionChatWrapper(sessionId, chatId) {
    const normalizedChatId = normalizeEvolutionChatId(chatId);
    const cached = getCachedChatByAnyId(sessionId, normalizedChatId);
    const cachedLastMessage = cached ? getChatPreviewSafe(cached.lastMessage) : '';
    const cachedTimestamp = Number(cached && cached.timestamp ? cached.timestamp : 0) || Math.floor(Date.now() / 1000);
    return {
        id: { _serialized: normalizedChatId },
        name: cached && cached.name ? sanitizeEvolutionText(cached.name) : '',
        phoneNumber: cached && cached.phoneNumber ? sanitizeEvolutionText(cached.phoneNumber) : '',
        unreadCount: Number(cached && cached.unreadCount ? cached.unreadCount : 0) || 0,
        profilePic: sanitizeEvolutionUrl(cached && cached.profilePic ? cached.profilePic : null),
        timestamp: cachedTimestamp,
        lastMessage: {
            id: { _serialized: `cache-last-${normalizedChatId}-${cachedTimestamp}` },
            body: cachedLastMessage,
            from: normalizedChatId,
            to: normalizedChatId,
            timestamp: cachedTimestamp,
            fromMe: false,
            type: 'chat',
            hasMedia: false,
            ack: 0
        },
        async fetchMessages({ limit = 100 } = {}) {
            const possibleIds = collectPossibleChatIds(sessionId, normalizedChatId);
            let local = [];
            for (const candidateId of possibleIds) {
                const history = loadMessageHistory(sessionId, candidateId);
                if (Array.isArray(history) && history.length > 0) {
                    local = history;
                    break;
                }
            }
            if (local && local.length > 0) {
                return local.slice(-limit).map(msg => createEvolutionMessageObject(sessionId, normalizedChatId, msg._evoRaw || {
                    key: { id: msg.id, remoteJid: normalizedChatId, fromMe: !!msg.fromMe },
                    messageTimestamp: msg.timestamp,
                    message: msg.hasMedia && msg.media ? { [`${msg.type === 'ptt' ? 'audio' : msg.type}Message`]: { ...msg.media, caption: msg.body || '' } } : { conversation: msg.body || '' }
                }));
            }
            if (!USE_EVOLUTION || !evolutionApi) return [];
            try {
                const remoteIds = collectPossibleChatIds(sessionId, normalizedChatId);
                const res = await evolutionApi.findMessages(evolutionInstanceName(sessionId), {
                    where: {
                        key: {
                            remoteJid: {
                                in: Array.from(new Set([
                                    ...remoteIds,
                                    ...remoteIds.map(id => toEvolutionApiTarget(id))
                                ].filter(Boolean)))
                            }
                        }
                    },
                    limit,
                    offset: 0,
                    page: 1
                });
                const rows = extractEvolutionRows(res);
                const mapped = rows.slice(-limit).map(item => createEvolutionMessageObject(sessionId, normalizedChatId, item));
                if ((!mapped || mapped.length === 0) && cachedLastMessage) {
                    return [createEvolutionMessageObject(sessionId, normalizedChatId, {
                        key: { id: `cache-last-${normalizedChatId}-${cachedTimestamp}`, remoteJid: normalizedChatId, fromMe: false },
                        messageTimestamp: cachedTimestamp,
                        message: { conversation: cachedLastMessage }
                    })];
                }
                return mapped;
            } catch (e) {
                if (cachedLastMessage) {
                    return [createEvolutionMessageObject(sessionId, normalizedChatId, {
                        key: { id: `cache-last-${normalizedChatId}-${cachedTimestamp}`, remoteJid: normalizedChatId, fromMe: false },
                        messageTimestamp: cachedTimestamp,
                        message: { conversation: cachedLastMessage }
                    })];
                }
                return [];
            }
        },
        async getContact() {
            return buildEvolutionContactFromCache(sessionId, normalizedChatId);
        },
        async getProfilePicUrl() {
            const contact = buildEvolutionContactFromCache(sessionId, normalizedChatId);
            return contact.getProfilePicUrl();
        },
        async sendStateTyping() {
            if (USE_EVOLUTION && evolutionApi) {
                try { await evolutionApi.setPresence(evolutionInstanceName(sessionId), toEvolutionApiTarget(normalizedChatId), 'composing', 1000); } catch (e) {}
            }
        },
        async sendStateRecording() {
            if (USE_EVOLUTION && evolutionApi) {
                try { await evolutionApi.setPresence(evolutionInstanceName(sessionId), toEvolutionApiTarget(normalizedChatId), 'recording', 1000); } catch (e) {}
            }
        },
        async clearState() {
            if (USE_EVOLUTION && evolutionApi) {
                try { await evolutionApi.setPresence(evolutionInstanceName(sessionId), toEvolutionApiTarget(normalizedChatId), 'paused', 500); } catch (e) {}
            }
        },
        async delete() {
            if (USE_EVOLUTION && evolutionApi) {
                try { await evolutionApi.archiveChat(evolutionInstanceName(sessionId), toEvolutionApiTarget(normalizedChatId), true); } catch (e) {}
            }
        },
        async clearMessages() {
            return true;
        },
        async archive() {
            if (USE_EVOLUTION && evolutionApi) {
                try { await evolutionApi.archiveChat(evolutionInstanceName(sessionId), toEvolutionApiTarget(normalizedChatId), true); } catch (e) {}
            }
        },
        async sendMessage(text) {
            const sessionData = activeClients.get(sessionId);
            if (!sessionData || !sessionData.client) throw new Error('session_not_ready');
            return sessionData.client.sendMessage(normalizedChatId, text);
        }
    };
}

function createSyntheticEvolutionSentMessage(sessionId, targetId, body, responseData, meta = {}) {
    const sessionData = activeClients.get(sessionId);
    const fromNumber = sessionData && sessionData.phoneNumber ? normalizeEvolutionPhone(sessionData.phoneNumber) : '';
    const chatId = normalizeEvolutionChatId(targetId);
    const key = responseData && typeof responseData === 'object' ? (responseData.key || responseData.messageKey || {}) : {};
    const id = key.id || responseData?.id || crypto.randomBytes(8).toString('hex');
    return {
        id: {
            _serialized: String(id),
            remote: chatId
        },
        body: String(body || ''),
        from: fromNumber ? `${fromNumber}@s.whatsapp.net` : '',
        to: chatId,
        timestamp: Math.floor(Date.now() / 1000),
        fromMe: true,
        type: meta.type || 'chat',
        hasMedia: !!meta.hasMedia,
        ack: 0,
        media: meta.media || null,
        async getChat() {
            const current = activeClients.get(sessionId);
            if (!current || !current.client) throw new Error('session_not_ready');
            return current.client.getChatById(chatId);
        },
        async downloadMedia() {
            return meta.media || null;
        }
    };
}

function createEvolutionClientWrapper(sessionId) {
    return {
        __provider: 'evolution',
        info: {
            wid: { user: '' },
            pushname: ''
        },
        async getChats() {
            if (!evolutionApi) return [];
            const result = await evolutionApi.findChats(evolutionInstanceName(sessionId), {});
            const rows = extractEvolutionRows(result);
            return rows.map(item => {
                const normalized = normalizeEvolutionChatRecord(sessionId, item);
                const chat = createEvolutionChatWrapper(sessionId, normalized.id);
                chat.name = normalized.name;
                chat.phoneNumber = normalized.phoneNumber || '';
                chat.unreadCount = normalized.unreadCount;
                chat.timestamp = normalized.timestamp;
                chat.lastMessage = {
                    id: { _serialized: `evo-last-${normalized.id}-${normalized.timestamp || 0}` },
                    body: normalized.lastMessage || '',
                    from: normalized.id,
                    to: normalized.id,
                    timestamp: normalized.timestamp || Math.floor(Date.now() / 1000),
                    fromMe: false,
                    type: 'chat',
                    hasMedia: false,
                    ack: 0
                };
                return chat;
            });
        },
        async getChatById(chatId) {
            return createEvolutionChatWrapper(sessionId, chatId);
        },
        async getContactById(chatId) {
            return buildEvolutionContactFromCache(sessionId, normalizeEvolutionChatId(chatId));
        },
        async getProfilePicUrl(chatId) {
            const contact = buildEvolutionContactFromCache(sessionId, normalizeEvolutionChatId(chatId));
            return contact.getProfilePicUrl();
        },
        async getNumberId(number) {
            if (!evolutionApi) return null;
            const digits = normalizeEvolutionPhone(number);
            const result = await evolutionApi.checkNumbers(evolutionInstanceName(sessionId), [digits]);
            const rows = Array.isArray(result) ? result : (Array.isArray(result?.numbers) ? result.numbers : []);
            const found = rows.find(item => item && (item.exists === true || item.jid || item.wid));
            if (!found) return null;
            return { _serialized: normalizeEvolutionChatId(found.jid || found.wid || `${digits}@s.whatsapp.net`) };
        },
        async isRegisteredUser(numberId) {
            if (!evolutionApi) return false;
            const digits = normalizeEvolutionPhone(numberId);
            const result = await evolutionApi.checkNumbers(evolutionInstanceName(sessionId), [digits]);
            const rows = Array.isArray(result) ? result : (Array.isArray(result?.numbers) ? result.numbers : []);
            const found = rows.find(item => normalizeEvolutionPhone(item?.number || item?.jid || item?.wid) === digits);
            return !!(found && found.exists !== false);
        },
        async sendMessage(chatId, content, options = {}) {
            if (!evolutionApi) throw new Error('evolution_not_configured');
            const targetId = normalizeEvolutionChatId(await resolveEvolutionSendTarget(sessionId, chatId));
            const apiTarget = toEvolutionApiTarget(targetId);
            if (typeof content === 'string') {
                const result = await evolutionApi.sendText(evolutionInstanceName(sessionId), apiTarget, content, {
                    delay: options.delay,
                    linkPreview: options.linkPreview
                });
                return createSyntheticEvolutionSentMessage(sessionId, targetId, content, result, { type: 'chat' });
            }

            const payload = content && typeof content === 'object' ? content : {};
            const mime = String(payload.mimetype || '').toLowerCase();
            const body = options.caption || '';
            if ((options && options.sendAudioAsVoice) || mime.startsWith('audio/')) {
                const result = await evolutionApi.sendWhatsAppAudio(
                    evolutionInstanceName(sessionId),
                    apiTarget,
                    payload.data,
                    { delay: options.delay }
                );
                return createSyntheticEvolutionSentMessage(sessionId, targetId, body || '🎤 Áudio', result, {
                    type: 'audio',
                    hasMedia: true,
                    media: {
                        mimetype: payload.mimetype || 'audio/ogg',
                        data: payload.data || null,
                        filename: payload.filename || 'audio'
                    }
                });
            }

            let mediatype = 'document';
            if (mime.startsWith('image/')) mediatype = 'image';
            else if (mime.startsWith('video/')) mediatype = 'video';
            else if (mime.startsWith('audio/')) mediatype = 'audio';

            const result = await evolutionApi.sendMedia(
                evolutionInstanceName(sessionId),
                apiTarget,
                {
                    mediatype,
                    mimetype: payload.mimetype || undefined,
                    caption: body || undefined,
                    fileName: payload.filename || undefined,
                    media: payload.data
                },
                { delay: options.delay }
            );
            return createSyntheticEvolutionSentMessage(sessionId, targetId, body || '📎 Mídia', result, {
                type: mediatype,
                hasMedia: true,
                media: {
                    mimetype: payload.mimetype || 'application/octet-stream',
                    data: payload.data || null,
                    filename: payload.filename || 'media'
                }
            });
        },
        async sendButtons(chatId, payload = {}) {
            if (!evolutionApi) throw new Error('evolution_not_configured');
            const targetId = normalizeEvolutionChatId(await resolveEvolutionSendTarget(sessionId, chatId));
            const apiTarget = toEvolutionApiTarget(targetId);
            const result = await evolutionApi.sendButtons(evolutionInstanceName(sessionId), apiTarget, payload);
            const summary = String(payload.text || payload.description || payload.title || 'Mensagem interativa').trim();
            return createSyntheticEvolutionSentMessage(sessionId, targetId, summary, result, { type: 'chat' });
        },
        async sendList(chatId, payload = {}) {
            if (!evolutionApi) throw new Error('evolution_not_configured');
            const targetId = normalizeEvolutionChatId(await resolveEvolutionSendTarget(sessionId, chatId));
            const apiTarget = toEvolutionApiTarget(targetId);
            const result = await evolutionApi.sendList(evolutionInstanceName(sessionId), apiTarget, payload);
            const summary = String(payload.description || payload.text || payload.title || 'Lista interativa').trim();
            return createSyntheticEvolutionSentMessage(sessionId, targetId, summary, result, { type: 'chat' });
        },
        async sendCarousel(chatId, payload = {}) {
            if (!evolutionApi) throw new Error('evolution_not_configured');
            const targetId = normalizeEvolutionChatId(await resolveEvolutionSendTarget(sessionId, chatId));
            const apiTarget = toEvolutionApiTarget(targetId);
            const result = await evolutionApi.sendCarousel(evolutionInstanceName(sessionId), apiTarget, payload);
            const summary = String(payload.description || payload.text || 'Carrossel interativo').trim();
            return createSyntheticEvolutionSentMessage(sessionId, targetId, summary, result, { type: 'chat' });
        },
        async destroy() {
            if (!evolutionApi) return;
            try {
                await evolutionApi.logoutInstance(evolutionInstanceName(sessionId));
            } catch (e) {}
        }
    };
}

function maybeEmitEvolutionQrToSocket(sessionId, socketId) {
    const sessionData = activeClients.get(sessionId);
    if (!sessionData || !sessionData.latestQr || !socketId) return;
    io.to(socketId).emit('qr-generated', {
        sessionId,
        qr: sessionData.latestQr
    });
}

async function syncEvolutionSessionState(sessionId, payload = null, options = {}) {
    const sessionData = activeClients.get(sessionId);
    if (!sessionData) return;
    const normalized = payload ? evolutionApi.normalizeInstanceState(payload) : { state: 'close', number: null, profileName: null, profilePictureUrl: null };
    const previousStatus = sessionData.status;
    const mappedStatus =
        normalized.state === 'open' ? 'connected'
            : normalized.state === 'connecting' ? 'authenticated'
            : normalized.state === 'close' ? 'reconnecting'
            : normalized.state === 'refused' ? 'auth_failed'
            : normalized.state;
    sessionData.status = mappedStatus;
    sessionData.ready = mappedStatus === 'connected';
    if (normalized.number) {
        sessionData.phoneNumber = normalizeEvolutionPhone(normalized.number);
        sessionData.client.info.wid.user = sessionData.phoneNumber || '';
    }
    if (normalized.profileName) {
        sessionData.name = String(normalized.profileName);
        sessionData.client.info.pushname = sessionData.name;
    }

    if (mappedStatus === 'connected' && (!sessionData.phoneNumber || !sessionData.name)) {
        try {
            const instancePayload = await evolutionApi.getInstance(evolutionInstanceName(sessionId)).catch(() => null);
            if (instancePayload) {
                const hydrated = evolutionApi.normalizeInstanceState(instancePayload);
                if (!sessionData.phoneNumber && hydrated.number) {
                    sessionData.phoneNumber = normalizeEvolutionPhone(hydrated.number);
                    sessionData.client.info.wid.user = sessionData.phoneNumber || '';
                }
                if (!sessionData.name && hydrated.profileName) {
                    sessionData.name = String(hydrated.profileName);
                    sessionData.client.info.pushname = sessionData.name;
                }
            }
        } catch (_) {}
    }

    if (mappedStatus === 'connected') {
        clearReconnect(sessionId);
        stopReadyProbe(sessionId);
        const sessions = loadSessionsData();
        sessions[sessionId] = {
            phoneNumber: sessionData.phoneNumber,
            name: sessionData.name,
            createdAt: (sessions[sessionId] && sessions[sessionId].createdAt) || Date.now()
        };
        saveSessionsData(sessions);
        const user = getUserBySessionId(sessionId);
        if (user) {
            const updatedUser = upsertUser({
                ...user,
                connectedAt: Date.now(),
                whatsappNumber: sessionData.phoneNumber || user.whatsappNumber || null,
                whatsappName: sessionData.name || user.whatsappName || null
            });
            if (previousStatus !== 'connected') {
                appendUserHistory(updatedUser, {
                    type: 'connect',
                    label: 'Conectou',
                    number: sessionData.phoneNumber || updatedUser.whatsappNumber || ''
                });
            }
        }
        emitToSessionClients(sessionId, 'client-ready', {
            sessionId,
            phoneNumber: sessionData.phoneNumber,
            name: sessionData.name
        });
        io.to('admin').emit('client-ready', {
            sessionId,
            phoneNumber: sessionData.phoneNumber,
            name: sessionData.name
        });
    }

    emitToSessionClients(sessionId, 'session-status', { sessionId, status: mappedStatus });
    io.to('admin').emit('session-status', { sessionId, status: mappedStatus });

    if (!options.silent && previousStatus !== mappedStatus) {
        io.to(`session:${sessionId}`).emit('sessions-list-update');
        io.to('admin').emit('sessions-list-update');
    }
}

async function processEvolutionWebhookEvent(body) {
    if (!USE_EVOLUTION || !evolutionApi) return;
    const payload = body && typeof body === 'object' ? body : {};
    const event = normalizeEvolutionEventName(payload.event || payload.type || payload.eventName || '');
    const sessionId = extractEvolutionSessionId(payload);
    if (!event || !sessionId) return;
    const sessionData = activeClients.get(sessionId);
    if (!sessionData) return;

    if (event === 'qrcode_updated') {
        const qr = evolutionApi.normalizeQr(payload.data || payload);
        if (qr.base64) {
            sessionData.latestQr = qr.base64.startsWith('data:') ? qr.base64 : `data:image/png;base64,${qr.base64}`;
            const user = getUserBySessionId(sessionId);
            if (user) upsertUser({ ...user, lastQrAt: Date.now() });
            emitToSessionClients(sessionId, 'qr-generated', { sessionId, qr: sessionData.latestQr });
            io.to('admin').emit('qr-generated', { sessionId });
        }
        return;
    }

    if (event === 'connection_update') {
        await syncEvolutionSessionState(sessionId, payload.data || payload);
        return;
    }

    if (event === 'messages_update' || event === 'send_message_update') {
        const rows = extractEvolutionRows(payload.data || payload);
        rows.forEach(item => {
            const id = getEvolutionMessageId(item);
            const chatId = getEvolutionMessageChatId(item);
            const ack = normalizeEvolutionAck(item?.status || item?.update?.status || item?.messageStatus);
            if (!id || !chatId) return;
            try {
                const file = getHistoryFilePath(sessionId, chatId);
                if (fs.existsSync(file)) {
                    const raw = fs.readFileSync(file, 'utf8');
                    const history = JSON.parse(raw);
                    if (Array.isArray(history)) {
                        const idx = history.findIndex(m => String(m.id) === String(id));
                        if (idx >= 0) {
                            history[idx].ack = ack;
                            fs.writeFileSync(file, JSON.stringify(history, null, 2));
                        }
                    }
                }
            } catch (e) {}
            emitToSessionClients(sessionId, 'message-ack', { sessionId, msgId: id, chatId, ack });
        });
        return;
    }

    if (event === 'messages_upsert' || event === 'send_message') {
        const rows = extractEvolutionRows(payload.data || payload);
        const cache = loadChatCache(sessionId);
        const cacheById = new Map(Array.isArray(cache) ? cache.map(item => [String(item.id), item]) : []);

        for (const item of rows) {
            const messagePayload = normalizeEvolutionInboundMessage(sessionId, item);
            if (!messagePayload.chatId || !messagePayload.id) continue;

            saveMessageToHistory(sessionId, messagePayload.chatId, messagePayload);

            const existingChat = getCachedChatByAnyId(sessionId, messagePayload.chatId) || cacheById.get(String(messagePayload.chatId)) || {};
            const resolvedIdentity = await resolveEvolutionChatIdentity(
                sessionId,
                messagePayload.chatId,
                pickBestChatLabel(
                    item?.pushName,
                    item?.name,
                    item?.contactName,
                    item?.profileName,
                    existingChat.name
                ),
                existingChat
            );
            const explicitPhoneNumber = normalizeEvolutionPhone(
                item?.phone ||
                item?.number ||
                item?.owner ||
                item?.participant ||
                item?.key?.participant ||
                resolvedIdentity?.phoneNumber ||
                existingChat.phoneNumber ||
                item?.pushName
            );
            const preferredName = pickBestChatLabel(
                existingChat.name,
                resolvedIdentity?.name,
                item?.pushName,
                item?.name,
                item?.contactName,
                item?.profileName
            );
            const nextChat = {
                ...existingChat,
                id: messagePayload.chatId,
                name: preferredName || explicitPhoneNumber || existingChat.phoneNumber || '',
                phoneNumber: explicitPhoneNumber || existingChat.phoneNumber || resolvedIdentity?.phoneNumber || '',
                unreadCount: messagePayload.fromMe ? (existingChat.unreadCount || 0) : ((existingChat.unreadCount || 0) + 1),
                timestamp: messagePayload.timestamp,
                lastMessage: messagePayload.body || existingChat.lastMessage || '',
                profilePic: existingChat.profilePic || null
            };
            if (messagePayload.chatId.endsWith('@lid') && nextChat.phoneNumber) {
                rememberLidPhone(messagePayload.chatId, nextChat.phoneNumber);
            }
            cacheById.set(String(nextChat.id), nextChat);

            if (!messagePayload.fromMe) {
                await processIncomingFlowMessage(sessionId, messagePayload, sessionData.client);
                emitToSessionClients(sessionId, 'new-message', {
                    sessionId,
                    message: messagePayload,
                    chat: {
                        id: nextChat.id,
                        name: nextChat.name,
                        unreadCount: nextChat.unreadCount,
                        timestamp: nextChat.timestamp,
                        lastMessage: nextChat.lastMessage,
                        profilePic: nextChat.profilePic
                    }
                });
            }
        }

        saveChatCache(sessionId, Array.from(cacheById.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)));
        io.to(`session:${sessionId}`).emit('sessions-list-update');
        return;
    }
}

async function handleSentMessage(sessionId, sentMsg, client, localMediaData = null) {
    try {
        let mediaData = localMediaData;
        if (!mediaData && sentMsg.hasMedia && typeof sentMsg.downloadMedia === 'function') {
            try {
                const downloaded = await sentMsg.downloadMedia();
                if (downloaded && downloaded.data) {
                    mediaData = {
                        mimetype: downloaded.mimetype || 'application/octet-stream',
                        data: downloaded.data,
                        filename: downloaded.filename || 'media'
                    };
                }
            } catch (e) {}
        }
        const messagePayload = {
            id: sentMsg.id._serialized || sentMsg.id,
            body: sentMsg.body,
            from: sentMsg.from,
            to: sentMsg.to,
            chatId: sentMsg.id.remote,
            timestamp: sentMsg.timestamp || Math.floor(Date.now() / 1000),
            fromMe: sentMsg.fromMe,
            type: sentMsg.type,
            hasMedia: sentMsg.hasMedia,
            ack: sentMsg.ack,
            media: mediaData || null
        };

        saveMessageToHistory(sessionId, sentMsg.id.remote, messagePayload);

        const sessionData = activeClients.get(sessionId);
        if (sessionData) {
             let contact;
             let profilePic = null;
             try {
                const chat = await sentMsg.getChat();
                contact = await chat.getContact();
                profilePic = await contact.getProfilePicUrl().catch(() => null);
                
                emitToSessionClients(sessionId, 'new-message', {
                    sessionId,
                    message: messagePayload,
                    chat: {
                        id: chat.id._serialized,
                        name: chat.name || contact.pushname || contact.number,
                        unreadCount: chat.unreadCount,
                        timestamp: sentMsg.timestamp || Math.floor(Date.now() / 1000),
                        lastMessage: sentMsg.body,
                        profilePic: profilePic
                    }
                });
             } catch (e) {
                 // Fallback
             }
        }
    } catch (e) {
        console.error('Error handling sent message notification:', e);
    }
}

function loadMessageHistory(sessionId, chatId) {
    try {
        const file = getHistoryFilePath(sessionId, chatId);
        if (fs.existsSync(file)) {
            const raw = fs.readFileSync(file, 'utf8');
            const data = JSON.parse(raw);
            return Array.isArray(data) ? data : [];
        }
    } catch (e) {
        console.error('Error loading history:', e);
    }
    return [];
}

function extractCandidateNumbersFromMessages(messages) {
    const out = new Set();
    const list = Array.isArray(messages) ? messages : [];
    for (const msg of list) {
        const candidates = [
            msg?.from,
            msg?.to,
            msg?.chatId,
            msg?._evoRaw?.key?.remoteJid,
            msg?._evoRaw?.remoteJid,
            msg?._evoRaw?.owner,
            msg?._evoRaw?.sender
        ];
        for (const candidate of candidates) {
            const digits = normalizeEvolutionPhone(candidate || '');
            if (digits && digits.length >= 10 && digits.length <= 15) out.add(digits);
        }
    }
    return Array.from(out);
}

function sanitizeEvolutionText(value) {
    return String(value == null ? '' : value)
        .replace(/^[`"' ]+|[`"' ]+$/g, '')
        .trim();
}

function sanitizeEvolutionUrl(value) {
    const cleaned = sanitizeEvolutionText(value);
    if (!cleaned) return null;
    return /^https?:\/\//i.test(cleaned) ? cleaned : null;
}

function getChatPreviewSafe(value) {
    if (!value) return '';
    if (typeof value === 'string' || typeof value === 'number') return sanitizeEvolutionText(value);
    if (typeof value === 'object') {
        return sanitizeEvolutionText(
            value.body ||
            value.caption ||
            value.text ||
            value.conversation ||
            value.message?.conversation ||
            value.message?.extendedTextMessage?.text ||
            ''
        );
    }
    return '';
}

function ensureSessionClientOnDemand(sessionId, options = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid) return null;

    let sessionData = activeClients.get(sid) || null;
    if (sessionData && sessionData.client) return sessionData;

    const sessions = loadSessionsData();
    const saved = sessions && sessions[sid] ? sessions[sid] : null;
    if (!saved) return sessionData;

    const forceResume = !!options.forceResume || sid === ADMIN_SELF_SESSION_ID;
    if (!forceResume && isSessionManuallyStopped(sid)) {
        return sessionData;
    }

    if (!sessionData || !sessionData.client) {
        if (forceResume) clearSessionManualStop(sid);
        initializeClient(sid, saved);
        sessionData = activeClients.get(sid) || sessionData;
    }

    return sessionData;
}

function emitToSessionClients(sessionId, eventName, payload) {
    if (!sessionId || !eventName) return;
    io.to(`session:${sessionId}`).emit(eventName, payload);
}

function sanitizeResolvedPhoneForChat(chatId, value) {
    const digits = normalizeEvolutionPhone(value);
    if (!digits) return '';
    if (/@lid$/i.test(String(chatId || '').trim()) && isSuspiciousLidPhone(chatId, digits)) return '';
    return digits;
}

function getCachedChatByAnyId(sessionId, chatId) {
    const ids = collectPossibleChatIds(sessionId, chatId);
    const cache = loadChatCache(sessionId);
    const list = Array.isArray(cache) ? cache : [];
    const direct = list.find(item => item && String(item.id || '').trim() === String(chatId || '').trim());
    if (direct) return direct;
    return list.find(item => item && ids.includes(String(item.id || '').trim())) || null;
}

function findStoredPhoneForLid(chatId) {
    const normalizedLid = normalizeEvolutionChatId(chatId);
    if (!/@lid$/i.test(normalizedLid)) return '';
    const directStored = getStoredPhoneForLid(normalizedLid);
    if (directStored) return directStored;

    const isValidDigits = (value) => {
        const digits = normalizeEvolutionPhone(value);
        if (!digits || digits.length < 10 || digits.length > 15) return '';
        if (isSuspiciousLidPhone(normalizedLid, digits)) return '';
        return digits;
    };

    try {
        const cacheFiles = fs.readdirSync(DATA_DIR)
            .filter(name => /^chats_cache_.*\.json$/i.test(name))
            .slice(-50);
        for (const fileName of cacheFiles) {
            try {
                const fullPath = path.join(DATA_DIR, fileName);
                const rows = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                const list = Array.isArray(rows) ? rows : [];
                const match = list.find(item => item && String(item.id || '').trim() === normalizedLid);
                const digits = isValidDigits(match?.phoneNumber || match?.name || '');
                if (digits) {
                    rememberLidPhone(normalizedLid, digits);
                    return digits;
                }
            } catch (e) {}
        }
    } catch (e) {}

    try {
        if (fs.existsSync(HISTORY_DIR)) {
            const sessionDirs = fs.readdirSync(HISTORY_DIR)
                .map(name => path.join(HISTORY_DIR, name))
                .filter(fullPath => {
                    try { return fs.statSync(fullPath).isDirectory(); } catch (e) { return false; }
                })
                .slice(-50);
            for (const sessionDir of sessionDirs) {
                const files = fs.readdirSync(sessionDir)
                    .filter(name => /@c\.us\.json$/i.test(name))
                    .slice(-200);
                for (const fileName of files) {
                    try {
                        const fullPath = path.join(sessionDir, fileName);
                        const raw = fs.readFileSync(fullPath, 'utf8');
                        if (!raw.includes(normalizedLid)) continue;
                        const digits = isValidDigits(fileName.replace(/\.json$/i, ''));
                        if (digits) {
                            rememberLidPhone(normalizedLid, digits);
                            return digits;
                        }
                    } catch (e) {}
                }
            }
        }
    } catch (e) {}

    try {
        if (fs.existsSync(ARCHIVE_DIR)) {
            const files = fs.readdirSync(ARCHIVE_DIR)
                .filter(name => name.endsWith('.json'))
                .slice(-200);
            for (const fileName of files) {
                try {
                    const fullPath = path.join(ARCHIVE_DIR, fileName);
                    const raw = fs.readFileSync(fullPath, 'utf8');
                    if (!raw.includes(normalizedLid)) continue;
                    const parsed = JSON.parse(raw);
                    const digits = isValidDigits(parsed?.chatId || '');
                    if (digits) {
                        rememberLidPhone(normalizedLid, digits);
                        return digits;
                    }
                } catch (e) {}
            }
        }
    } catch (e) {}

    return '';
}

async function resolveEvolutionChatIdentity(sessionId, chatId, baseName = '', cached = null) {
    const output = {
        phoneNumber: normalizeEvolutionPhone(cached?.phoneNumber || chatId),
        name: String(baseName || cached?.name || '').trim(),
        profilePictureUrl: sanitizeEvolutionUrl(cached?.profilePic || cached?.profilePictureUrl || '')
    };
    if (isSuspiciousLidPhone(chatId, output.phoneNumber)) output.phoneNumber = '';

    const storedPhone = getStoredPhoneForLid(chatId);
    const archive = loadArchiveFallback(sessionId, [chatId]);
    const archivePhone = Array.isArray(archive?.numbers)
        ? archive.numbers.find(num => num && num.length >= 10 && num.length <= 15 && !isSuspiciousLidPhone(chatId, num))
        : '';
    if (!output.phoneNumber && storedPhone) output.phoneNumber = storedPhone;
    if (!output.phoneNumber && archivePhone) output.phoneNumber = archivePhone;
    if (!output.phoneNumber) output.phoneNumber = findStoredPhoneForLid(chatId);
    if (output.phoneNumber) rememberLidPhone(chatId, output.phoneNumber);

    if (!USE_EVOLUTION || !evolutionApi) return output;
    if (!output.phoneNumber || !output.name || /^[0-9@._+\-\s]+$/.test(output.name) || !output.profilePictureUrl) {
        try {
            const contactInfo = await fetchEvolutionContactIdentity(sessionId, chatId);
            if (!output.phoneNumber && contactInfo.phoneDigits) output.phoneNumber = contactInfo.phoneDigits;
            if ((!output.name || /^[0-9@._+\-\s]+$/.test(output.name)) && contactInfo.name) output.name = contactInfo.name;
            if (!output.profilePictureUrl && contactInfo.profilePictureUrl) output.profilePictureUrl = contactInfo.profilePictureUrl;
            if (contactInfo.phoneDigits && /@lid$/i.test(String(chatId || ''))) {
                rememberLidPhone(chatId, contactInfo.phoneDigits);
            }
        } catch (e) {}
    }
    if (output.phoneNumber && output.name && !/^[0-9@._+\-\s]+$/.test(output.name)) return output;

    try {
        const profile = await evolutionApi.fetchProfile(evolutionInstanceName(sessionId), toEvolutionApiTarget(chatId));
        const info = extractEvolutionProfileInfo(profile || {});
        if (!output.phoneNumber && info.phoneDigits) output.phoneNumber = info.phoneDigits;
        if ((!output.name || /^[0-9@._+\-\s]+$/.test(output.name)) && info.name) output.name = info.name;
    } catch (e) {}

    return output;
}

async function resolveVerifiedEvolutionNumber(sessionId, candidates = []) {
    if (!USE_EVOLUTION || !evolutionApi) return null;

    const numbers = Array.from(new Set(
        (Array.isArray(candidates) ? candidates : [candidates])
            .map(value => normalizeEvolutionPhone(value))
            .filter(value => value && value.length >= 10 && value.length <= 15)
    ));
    if (!numbers.length) return null;

    try {
        const result = await evolutionApi.checkNumbers(evolutionInstanceName(sessionId), numbers);
        const rows = Array.isArray(result) ? result : (Array.isArray(result?.numbers) ? result.numbers : []);
        for (const digits of numbers) {
            const match = rows.find(item => {
                const itemDigits = normalizeEvolutionPhone(item?.number || item?.jid || item?.wid || '');
                return itemDigits === digits && item?.exists !== false;
            });
            if (match) {
                return {
                    number: digits,
                    jid: normalizeEvolutionChatId(match.jid || match.wid || `${digits}@s.whatsapp.net`),
                    raw: match
                };
            }
        }
    } catch (e) {}

    return null;
}

async function resolveEvolutionSendTarget(sessionId, chatId) {
    const raw = String(chatId || '').trim();
    if (!raw) return raw;

    const normalized = normalizeEvolutionChatId(raw);
    const isLidTarget = /@lid$/i.test(normalized);
    if (!USE_EVOLUTION || !evolutionApi) return normalized;
    if (normalized.endsWith('@g.us') || normalized.endsWith('@newsletter')) return normalized;

    const cached = getCachedChatByAnyId(sessionId, normalized);
    const ids = collectPossibleChatIds(sessionId, normalized);
    const historyNumbers = new Set();
    for (const candidateId of ids) {
        extractCandidateNumbersFromMessages(loadMessageHistory(sessionId, candidateId)).forEach(num => historyNumbers.add(num));
    }
    const archiveFallback = loadArchiveFallback(sessionId, ids.length ? ids : [normalized]);
    const resolvedIdentity = normalized.endsWith('@lid') || !normalizeEvolutionPhone(normalized)
        ? await resolveEvolutionChatIdentity(sessionId, normalized, cached?.name || '', cached)
        : null;

    const numericCandidates = new Set();
    const addCandidate = (value) => {
        const digits = normalizeEvolutionPhone(value);
        if (digits && digits.length >= 10 && digits.length <= 15) numericCandidates.add(digits);
    };

    if (!isLidTarget) {
        addCandidate(raw);
        addCandidate(normalized);
    }
    addCandidate(cached?.phoneNumber);
    addCandidate(cached?.name);
    if (!isLidTarget) addCandidate(cached?.id);
    addCandidate(resolvedIdentity?.phoneNumber);
    addCandidate(resolvedIdentity?.name);
    if (!isLidTarget) ids.forEach(addCandidate);
    historyNumbers.forEach(addCandidate);
    archiveFallback.numbers.forEach(addCandidate);

    const verified = await resolveVerifiedEvolutionNumber(sessionId, Array.from(numericCandidates));
    const shouldDebugSendTarget = !!(
        normalized &&
        (/@lid$/i.test(normalized) || (/@c\.us$/i.test(normalized) && normalizeEvolutionPhone(normalized).length > 13))
    );
    if (shouldDebugSendTarget) {
        console.log('[evolution-send-debug]', JSON.stringify({
            sessionId,
            raw,
            normalized,
            cachedId: cached?.id || '',
            cachedName: cached?.name || '',
            cachedPhoneNumber: cached?.phoneNumber || '',
            resolvedPhoneNumber: resolvedIdentity?.phoneNumber || '',
            candidateNumbers: Array.from(numericCandidates),
            verifiedJid: verified?.jid || ''
        }));
    }
    if (verified?.jid) return verified.jid;

    const firstNumber = Array.from(numericCandidates)[0];
    if (firstNumber) return `${firstNumber}@c.us`;

    return normalized;
}

function loadArchiveFallback(sessionId, chatIds) {
    try {
        if (!fs.existsSync(ARCHIVE_DIR)) return { messages: [], numbers: [] };
        const targets = new Set((Array.isArray(chatIds) ? chatIds : [chatIds]).map(v => String(v || '').trim()).filter(Boolean));
        const targetDigits = new Set(Array.from(targets).map(v => normalizeEvolutionPhone(v)).filter(Boolean));
        const files = fs.readdirSync(ARCHIVE_DIR)
            .filter(name => name.startsWith(`${sessionId}_`) && name.endsWith('.json'))
            .sort((a, b) => {
                try {
                    const aStat = fs.statSync(path.join(ARCHIVE_DIR, a));
                    const bStat = fs.statSync(path.join(ARCHIVE_DIR, b));
                    return bStat.mtimeMs - aStat.mtimeMs;
                } catch (e) {
                    return 0;
                }
            });

        const merged = new Map();
        const foundNumbers = new Set();

        for (const fileName of files.slice(0, 200)) {
            try {
                const full = path.join(ARCHIVE_DIR, fileName);
                const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
                const archivedChatId = String(raw?.chatId || '').trim();
                const archivedDigits = normalizeEvolutionPhone(archivedChatId);
                const match = targets.has(archivedChatId) || (archivedDigits && targetDigits.has(archivedDigits));
                if (!match) continue;

                const messages = Array.isArray(raw?.messages) ? raw.messages : [];
                extractCandidateNumbersFromMessages(messages).forEach(num => foundNumbers.add(num));
                for (const msg of messages) {
                    if (msg && msg.id) merged.set(String(msg.id), msg);
                }
            } catch (e) {}
        }

        return {
            messages: Array.from(merged.values()).sort((a, b) => (Number(a?.timestamp || 0) - Number(b?.timestamp || 0))),
            numbers: Array.from(foundNumbers)
        };
    } catch (e) {
        return { messages: [], numbers: [] };
    }
}
function loadWinbackStats() { return loadData(WINBACK_STATS_FILE); }
function saveWinbackStats(data) { saveData(WINBACK_STATS_FILE, data); }

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function hashPassword(password) {
    const p = String(password || '');
    const salt = crypto.randomBytes(16);
    const iterations = 120000;
    const keylen = 32;
    const digest = 'sha256';
    const derived = crypto.pbkdf2Sync(p, salt, iterations, keylen, digest);
    return `pbkdf2$${iterations}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function verifyPassword(password, encoded) {
    const p = String(password || '');
    const raw = String(encoded || '');
    const parts = raw.split('$');
    if (parts.length !== 4) return false;
    const algo = parts[0];
    const iterations = Number(parts[1]);
    const saltB64 = parts[2];
    const hashB64 = parts[3];
    if (algo !== 'pbkdf2') return false;
    if (!Number.isFinite(iterations) || iterations <= 0) return false;
    let salt;
    let expected;
    try {
        salt = Buffer.from(saltB64, 'base64');
        expected = Buffer.from(hashB64, 'base64');
    } catch (e) {
        return false;
    }
    if (!salt.length || !expected.length) return false;
    const derived = crypto.pbkdf2Sync(p, salt, iterations, expected.length, 'sha256');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
}

function generateId(prefix) {
    return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function getUserById(userId) {
    const store = loadUsersStore();
    return (store.users || []).find(u => String(u.id) === String(userId)) || null;
}

function getUserByEmail(email) {
    const em = normalizeEmail(email);
    const store = loadUsersStore();
    return (store.users || []).find(u => normalizeEmail(u.email) === em) || null;
}

function getUserBySessionId(sessionId) {
    const sid = String(sessionId || '');
    const store = loadUsersStore();
    return (store.users || []).find(u => String(u.sessionId || '') === sid) || null;
}

function upsertUser(user) {
    const store = loadUsersStore();
    const users = Array.isArray(store.users) ? store.users : [];
    const idx = users.findIndex(u => String(u.id) === String(user.id));
    const next = { ...user };
    if (idx >= 0) users[idx] = next;
    else users.push(next);
    store.users = users;
    saveUsersStore(store);
    return next;
}

function appendUserHistory(user, entry, options = {}) {
    if (!user || !user.id || !entry || !entry.type) return user;
    const now = Number(entry.at || Date.now());
    const normalized = {
        type: String(entry.type),
        at: now,
        label: entry.label ? String(entry.label) : '',
        number: entry.number ? String(entry.number) : ''
    };
    const history = Array.isArray(user.history) ? user.history.slice() : [];
    const last = history[0];
    const dedupeWindowMs = Number(options.dedupeWindowMs || 15000);
    const sameAsLast = last
        && String(last.type || '') === normalized.type
        && String(last.label || '') === normalized.label
        && String(last.number || '') === normalized.number
        && Math.abs(Number(last.at || 0) - normalized.at) <= dedupeWindowMs;
    if (!sameAsLast) history.unshift(normalized);
    const next = {
        ...user,
        history: history.slice(0, 100),
        updatedAt: now
    };
    if (normalized.type === 'connect' || normalized.type === 'connected') {
        next.connectedAt = now;
        if (!next.firstConnectedAt) next.firstConnectedAt = now;
    }
    if (normalized.type === 'disconnect' || normalized.type === 'deleted' || normalized.type === 'auth_failed') {
        next.disconnectedAt = now;
        next.lastDisconnectedAt = now;
    }
    return upsertUser(next);
}

function loadAuthTokens() {
    const raw = loadData(AUTH_TOKENS_FILE);
    return raw && typeof raw === 'object' ? raw : {};
}
function saveAuthTokens(tokens) { saveData(AUTH_TOKENS_FILE, tokens && typeof tokens === 'object' ? tokens : {}); }

function createAuthToken(payload) {
    const token = crypto.randomBytes(24).toString('hex');
    const tokens = loadAuthTokens();
    const now = Date.now();
    const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
    tokens[token] = { ...payload, createdAt: now, expiresAt };
    saveAuthTokens(tokens);
    return token;
}

function validateAuthToken(token) {
    const t = String(token || '').trim();
    if (!t) return null;
    const tokens = loadAuthTokens();
    const record = tokens[t];
    if (!record) return null;
    if (record.expiresAt && Date.now() > record.expiresAt) {
        delete tokens[t];
        saveAuthTokens(tokens);
        return null;
    }
    return { token: t, ...record };
}

function parseBearerToken(req) {
    const hdr = req.headers && req.headers.authorization ? String(req.headers.authorization) : '';
    const m = hdr.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
    if (req.query && req.query.token) return String(req.query.token).trim();
    return '';
}

function requireUser(req, res, next) {
    const token = parseBearerToken(req);
    const rec = validateAuthToken(token);
    if (!rec || rec.isAdmin) {
        res.status(401).json({ success: false, error: 'unauthorized' });
        return;
    }
    const user = getUserById(rec.userId);
    if (!user) {
        res.status(401).json({ success: false, error: 'unauthorized' });
        return;
    }
    req.user = user;
    req.authToken = rec.token;
    next();
}

function requireAdmin(req, res, next) {
    const token = parseBearerToken(req);
    const rec = validateAuthToken(token);
    if (!rec || !rec.isAdmin) {
        res.status(401).json({ success: false, error: 'unauthorized' });
        return;
    }
    req.authToken = rec.token;
    next();
}

function isAdminSelfRequest(req) {
    const hdr = req.headers && req.headers['x-zapmro-admin-self'] ? String(req.headers['x-zapmro-admin-self']).trim() : '';
    const bodyFlag = req.body && (req.body.adminSelf === true || String(req.body.adminSelf || '').trim() === '1');
    return hdr === '1' || bodyFlag;
}

function ensureSeedUser() {
    const seedEmail = ADMIN_EMAIL;
    const seedSessionId = 'session_1766863274035_0swxlb2vt';
    const existing = getUserByEmail(seedEmail);
    if (existing) {
        const next = { ...existing, sessionId: existing.sessionId || seedSessionId, promoCode: existing.promoCode || TEST_PROMO_CODE };
        upsertUser(next);
        return;
    }
    upsertUser({
        id: generateId('user'),
        name: 'Mro Suporte',
        email: seedEmail,
        promoCode: TEST_PROMO_CODE,
        sessionId: seedSessionId,
        createdAt: Date.now(),
        connectedAt: null,
        whatsappNumber: null,
        whatsappName: null,
        lastQrAt: null
    });
}
function getDefaultSessionId() {
    const sessions = loadSessionsData();
    const keys = sessions && typeof sessions === 'object' ? Object.keys(sessions) : [];
    if (keys.length === 0) return 'default';
    let bestId = keys[0];
    let bestTime = Number.isFinite(sessions[bestId]?.createdAt) ? sessions[bestId].createdAt : Number.POSITIVE_INFINITY;
    for (const id of keys) {
        const t = Number.isFinite(sessions[id]?.createdAt) ? sessions[id].createdAt : Number.POSITIVE_INFINITY;
        if (t < bestTime) {
            bestId = id;
            bestTime = t;
        }
    }
    return bestId || 'default';
}

function loadFlowsStore() {
    const raw = loadData(FLOWS_FILE);
    if (Array.isArray(raw)) {
        const defaultSessionId = getDefaultSessionId();
        const migrated = { [defaultSessionId]: raw };
        saveData(FLOWS_FILE, migrated);
        return migrated;
    }
    if (raw && typeof raw === 'object') return raw;
    return {};
}

const FLOW_TIME_UNITS = Object.freeze({
    milliseconds: 1,
    seconds: 1000,
    minutes: 60000,
    hours: 3600000
});
const FLOW_TEXT_MIN_TYPING_MS = 3000;

function getFlowTimeUnit(unit, fallback = 'milliseconds') {
    return Object.prototype.hasOwnProperty.call(FLOW_TIME_UNITS, unit) ? unit : fallback;
}

function sanitizeFlowDurationMs(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function getTextStepTypingDurationMs(step) {
    const direct = sanitizeFlowDurationMs(step && step.typingDuration);
    return Math.max(FLOW_TEXT_MIN_TYPING_MS, direct || FLOW_TEXT_MIN_TYPING_MS);
}

function normalizeFlowStep(step) {
    if (!step || typeof step !== 'object') return step;
    const normalized = { ...step };

    if (normalized.type === 'text') {
        normalized.content = String(normalized.content || '').trim();
        normalized.typingDuration = getTextStepTypingDurationMs(normalized);
        normalized.typingUnit = getFlowTimeUnit(normalized.typingUnit, 'seconds');
    }

    if (normalized.type === 'delay') {
        const preferredUnit = getFlowTimeUnit(normalized.timeUnit, 'milliseconds');
        let delayMs = Number(normalized.time);
        if (!Number.isFinite(delayMs)) {
            const legacyValue = Number(normalized.content);
            if (Number.isFinite(legacyValue)) {
                delayMs = legacyValue * FLOW_TIME_UNITS[preferredUnit];
            }
        }
        normalized.time = sanitizeFlowDurationMs(delayMs);
        normalized.timeUnit = preferredUnit;
    }

    if (normalized.type === 'wait_response') {
        normalized.timeout = sanitizeFlowDurationMs(normalized.timeout);
        normalized.timeoutUnit = getFlowTimeUnit(normalized.timeoutUnit, 'minutes');
    }

    if (normalized.type === 'buttons') {
        normalized.title = String(normalized.title || '').trim();
        normalized.text = String(normalized.text || normalized.bodyText || normalized.content || '').trim();
        normalized.bodyText = normalized.text;
        normalized.footerText = String(normalized.footerText || normalized.footer || '').trim();
        normalized.imageUrl = String(normalized.imageUrl || normalized.image || '').trim();
        normalized.buttons = Array.isArray(normalized.buttons)
            ? normalized.buttons.map((button, index) => normalizeFlowButtonConfig(button, index, 'button'))
            : [];
    }

    if (normalized.type === 'list') {
        normalized.title = String(normalized.title || '').trim();
        normalized.description = String(normalized.description || normalized.text || normalized.content || '').trim();
        normalized.buttonText = String(normalized.buttonText || 'Abrir menu').trim() || 'Abrir menu';
        normalized.footerText = String(normalized.footerText || normalized.footer || '').trim();
        normalized.sections = Array.isArray(normalized.sections)
            ? normalized.sections.map((section, index) => normalizeFlowListSection(section, index))
            : [];
    }

    if (normalized.type === 'carousel') {
        normalized.description = String(normalized.description || normalized.text || normalized.content || '').trim();
        normalized.footerText = String(normalized.footerText || normalized.footer || '').trim();
        normalized.cards = Array.isArray(normalized.cards)
            ? normalized.cards.map((card, index) => normalizeFlowCarouselCard(card, index))
            : [];
    }

    return normalized;
}

function createFlowRuntimeId() {
    return `flow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeFlowDefinition(flow) {
    if (!flow || typeof flow !== 'object') return flow;
    const id = String(flow.id || '').trim() || createFlowRuntimeId();
    return {
        ...flow,
        id,
        steps: Array.isArray(flow.steps) ? flow.steps.map(normalizeFlowStep) : []
    };
}

function normalizeFlowInteractiveId(value, fallback = 'option') {
    const text = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return text || fallback;
}

function normalizeFlowButtonConfig(button, index = 0, prefix = 'button') {
    const raw = button && typeof button === 'object' ? button : {};
    const type = ['reply', 'url', 'call', 'copy', 'pix'].includes(String(raw.type || '').toLowerCase())
        ? String(raw.type || '').toLowerCase()
        : 'reply';
    const displayText = String(raw.displayText || raw.text || raw.title || `Botao ${index + 1}`).trim() || `Botao ${index + 1}`;
    const fallbackId = `${prefix}_${index + 1}`;
    const id = type === 'reply'
        ? normalizeFlowInteractiveId(raw.id || raw.buttonId || raw.buttonID || displayText, fallbackId)
        : String(raw.id || raw.buttonId || raw.buttonID || '').trim();
    return {
        type,
        displayText,
        id,
        buttonId: id,
        url: String(raw.url || '').trim(),
        phoneNumber: String(raw.phoneNumber || raw.phone || '').trim(),
        copyCode: String(raw.copyCode || raw.copy_code || '').trim(),
        pixKey: String(raw.pixKey || raw.pix_key || '').trim(),
        targetId: raw.targetId ? String(raw.targetId) : null
    };
}

function normalizeFlowListRow(row, sectionIndex = 0, rowIndex = 0) {
    const raw = row && typeof row === 'object' ? row : {};
    const title = String(raw.title || `Opcao ${rowIndex + 1}`).trim() || `Opcao ${rowIndex + 1}`;
    const fallbackId = `row_${sectionIndex + 1}_${rowIndex + 1}`;
    const rowId = normalizeFlowInteractiveId(raw.rowId || raw.id || title, fallbackId);
    return {
        title,
        description: String(raw.description || '').trim(),
        rowId,
        id: rowId,
        targetId: raw.targetId ? String(raw.targetId) : null
    };
}

function normalizeFlowListSection(section, sectionIndex = 0) {
    const raw = section && typeof section === 'object' ? section : {};
    const rows = Array.isArray(raw.rows) ? raw.rows.map((row, rowIndex) => normalizeFlowListRow(row, sectionIndex, rowIndex)) : [];
    return {
        title: String(raw.title || `Secao ${sectionIndex + 1}`).trim() || `Secao ${sectionIndex + 1}`,
        rows
    };
}

function normalizeFlowCarouselCard(card, cardIndex = 0) {
    const raw = card && typeof card === 'object' ? card : {};
    const buttons = Array.isArray(raw.buttons)
        ? raw.buttons.map((button, buttonIndex) => normalizeFlowButtonConfig(button, buttonIndex, `card_${cardIndex + 1}`))
        : [];
    return {
        title: String(raw.title || `Card ${cardIndex + 1}`).trim() || `Card ${cardIndex + 1}`,
        description: String(raw.description || '').trim(),
        image: String(raw.image || raw.imageUrl || '').trim(),
        imageUrl: String(raw.imageUrl || raw.image || '').trim(),
        buttons
    };
}

function getFlowInteractiveBranches(step) {
    if (!step || typeof step !== 'object') return [];
    if (step.type === 'buttons') {
        return (Array.isArray(step.buttons) ? step.buttons : [])
            .filter(button => String(button && button.type || '').toLowerCase() === 'reply' && String(button.id || button.buttonId || '').trim())
            .map((button, index) => ({
                kind: 'button',
                id: String(button.id || button.buttonId).trim(),
                label: String(button.displayText || `Botao ${index + 1}`).trim(),
                targetId: button.targetId ? String(button.targetId) : null
            }));
    }
    if (step.type === 'list') {
        return (Array.isArray(step.sections) ? step.sections : []).flatMap(section =>
            (Array.isArray(section.rows) ? section.rows : [])
                .filter(row => String(row && row.rowId || row && row.id || '').trim())
                .map((row, index) => ({
                    kind: 'list',
                    id: String(row.rowId || row.id).trim(),
                    label: String(row.title || `Item ${index + 1}`).trim(),
                    targetId: row.targetId ? String(row.targetId) : null
                }))
        );
    }
    if (step.type === 'carousel') {
        return (Array.isArray(step.cards) ? step.cards : []).flatMap((card, cardIndex) =>
            (Array.isArray(card.buttons) ? card.buttons : [])
                .filter(button => String(button && button.type || '').toLowerCase() === 'reply' && String(button.id || button.buttonId || '').trim())
                .map((button, buttonIndex) => ({
                    kind: 'carousel',
                    id: String(button.id || button.buttonId).trim(),
                    label: `${String(card.title || `Card ${cardIndex + 1}`).trim()} - ${String(button.displayText || `Botao ${buttonIndex + 1}`).trim()}`,
                    targetId: button.targetId ? String(button.targetId) : null
                }))
        );
    }
    return [];
}

function findFlowInteractiveBranch(step, replyId) {
    const normalized = normalizeFlowInteractiveId(replyId || '');
    if (!normalized) return null;
    return getFlowInteractiveBranches(step).find(branch => normalizeFlowInteractiveId(branch.id) === normalized) || null;
}

function getFlowNextStepIndex(flow, step, currentIndex) {
    if (step && step.next) {
        const linkedIndex = getFlowStepIndexById(flow, step.next);
        if (linkedIndex >= 0) return linkedIndex;
    }
    return currentIndex + 1;
}

function getIncomingMessageReplyId(msg) {
    if (!msg || typeof msg !== 'object') return '';
    const directId = msg.interactiveReplyId || msg.replyId || '';
    if (directId) return normalizeFlowInteractiveId(directId);
    const body = typeof msg.body === 'string' ? msg.body.trim() : '';
    return body ? normalizeFlowInteractiveId(body) : '';
}

function loadFlows(sessionId) {
    const store = loadFlowsStore();
    const sid = sessionId ? String(sessionId) : getDefaultSessionId();
    const flows = Array.isArray(store[sid]) ? store[sid] : [];
    let changed = false;
    const normalized = flows.map((flow) => {
        const normalizedFlow = normalizeFlowDefinition(flow);
        if (String(flow && flow.id ? flow.id : '').trim() !== normalizedFlow.id) {
            changed = true;
        }
        return normalizedFlow;
    });
    if (changed) {
        store[sid] = normalized;
        saveData(FLOWS_FILE, store);
    }
    return normalized;
}

function saveFlows(sessionId, flows) {
    const store = loadFlowsStore();
    const sid = sessionId ? String(sessionId) : getDefaultSessionId();
    store[sid] = Array.isArray(flows) ? flows.map(normalizeFlowDefinition) : [];
    saveData(FLOWS_FILE, store);
}
function loadTagsStore() {
    const raw = loadData(TAGS_FILE);
    if (Array.isArray(raw)) {
        const defaultSessionId = getDefaultSessionId();
        const migrated = { [defaultSessionId]: raw };
        saveData(TAGS_FILE, migrated);
        return migrated;
    }
    if (raw && typeof raw === 'object') return raw;
    return {};
}

function loadTags(sessionId) {
    const store = loadTagsStore();
    const sid = sessionId ? String(sessionId) : getDefaultSessionId();
    const tags = store[sid];
    return Array.isArray(tags) ? tags : [];
}

function saveTags(sessionId, tags) {
    const store = loadTagsStore();
    const sid = sessionId ? String(sessionId) : getDefaultSessionId();
    store[sid] = Array.isArray(tags) ? tags : [];
    saveData(TAGS_FILE, store);
}
function loadAiConfigStore() {
    const raw = loadData(AI_CONFIG_FILE);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const keys = Object.keys(raw);
        const looksLikeSingleConfig = keys.some(k => ['enabled', 'apiKey', 'triggerMode', 'keyword', 'prompt'].includes(k));
        const looksLikeSessionMap = keys.every(k => typeof raw[k] === 'object' && raw[k] !== null && !Array.isArray(raw[k]));
        if (looksLikeSingleConfig && !looksLikeSessionMap) {
            const defaultSessionId = getDefaultSessionId();
            const migrated = { [defaultSessionId]: raw };
            saveData(AI_CONFIG_FILE, migrated);
            return migrated;
        }
        return raw;
    }
    return {};
}

function loadAiConfig() { return loadAiConfigStore(); }
function saveAiConfig(data) { saveData(AI_CONFIG_FILE, data); }
function loadAiChatStatus() { return loadData(AI_CHAT_STATUS_FILE); }
function saveAiChatStatus(data) { saveData(AI_CHAT_STATUS_FILE, data); }
function loadAiTranscripts() { return loadData(AI_TRANSCRIPTS_FILE); }
function saveAiTranscripts(data) { saveData(AI_TRANSCRIPTS_FILE, data); }
function loadSessionPasswords() { return loadData(SESSION_PASSWORDS_FILE); }
function saveSessionPasswords(data) { saveData(SESSION_PASSWORDS_FILE, data); }

function isMasterPassword(password) {
    if (!MASTER_PASSWORD) return false;
    if (password === undefined || password === null) return false;
    return String(password) === String(MASTER_PASSWORD);
}

function isSessionPasswordValid(sessionId, password) {
    if (isMasterPassword(password)) return true;
    const passwords = loadSessionPasswords();
    const stored = passwords[sessionId];
    if (!stored) return false;
    if (password === undefined || password === null) return false;
    return String(stored) === String(password);
}

function safeSessionKey(sessionId) {
    return String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function deletePathRecursive(targetPath) {
    if (!targetPath) return;
    try {
        if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
    } catch (e) {}
}

function removeSessionFromStores(sessionId) {
    const sid = String(sessionId || '');
    if (!sid) return;

    const sessions = loadSessionsData();
    if (sessions && sessions[sid]) {
        delete sessions[sid];
        saveSessionsData(sessions);
    }

    const passwords = loadSessionPasswords();
    if (passwords && passwords[sid]) {
        delete passwords[sid];
        saveSessionPasswords(passwords);
    }

    const kanban = loadKanbanData();
    if (kanban && kanban[sid]) {
        delete kanban[sid];
        saveKanbanData(kanban);
    }

    const contacts = loadContacts();
    if (contacts && contacts[sid]) {
        delete contacts[sid];
        saveContacts(contacts);
    }

    const scheduled = loadScheduledMessages();
    if (scheduled && scheduled[sid]) {
        delete scheduled[sid];
        saveScheduledMessages(scheduled);
    }

    const flowsStore = loadFlowsStore();
    if (flowsStore && flowsStore[sid]) {
        delete flowsStore[sid];
        saveData(FLOWS_FILE, flowsStore);
    }

    const tagsStore = loadTagsStore();
    if (tagsStore && tagsStore[sid]) {
        delete tagsStore[sid];
        saveData(TAGS_FILE, tagsStore);
    }

    const aiConfig = loadAiConfig();
    if (aiConfig && aiConfig[sid]) {
        delete aiConfig[sid];
        saveAiConfig(aiConfig);
    }

    const aiStatus = loadAiChatStatus();
    if (aiStatus && aiStatus[sid]) {
        delete aiStatus[sid];
        saveAiChatStatus(aiStatus);
    }

    const aiTranscripts = loadAiTranscripts();
    if (aiTranscripts && aiTranscripts[sid]) {
        delete aiTranscripts[sid];
        saveAiTranscripts(aiTranscripts);
    }

    const archiveLogFile = path.join(ARCHIVE_DIR, 'archive_log.json');
    const archiveLog = loadData(archiveLogFile);
    if (archiveLog && archiveLog[sid]) {
        delete archiveLog[sid];
        saveData(archiveLogFile, archiveLog);
    }
}

// Flow Manager
let activeFlows = {}; // { sessionId: { chatId: { flowId: '...', step: 0, waitingForResponse: boolean } } }
let flowExecutionHistory = {}; // { sessionId: [ { ...status } ] }
const FLOW_EXECUTION_HISTORY_LIMIT = 80;

function getFlowNameById(sessionId, flowId) {
    const flows = loadFlows(sessionId);
    const found = Array.isArray(flows) ? flows.find(f => String(f.id) === String(flowId)) : null;
    return found && found.name ? String(found.name) : `Fluxo ${flowId}`;
}

function logFlowDebug(sessionId, chatId, flow, stepIndex, stage, extra = {}) {
    try {
        console.log('[flow-debug]', JSON.stringify({
            sessionId,
            chatId,
            flowId: flow && flow.id ? flow.id : null,
            flowName: flow && flow.name ? flow.name : null,
            stepIndex: Number.isFinite(stepIndex) ? stepIndex : null,
            stepType: flow && flow.steps && Number.isFinite(stepIndex) && flow.steps[stepIndex] ? flow.steps[stepIndex].type : null,
            stage,
            ...extra
        }));
    } catch (e) {}
}

function recordFlowExecutionHistory(sessionId, payload = {}) {
    if (!sessionId) return;
    if (!flowExecutionHistory[sessionId]) flowExecutionHistory[sessionId] = [];
    flowExecutionHistory[sessionId].unshift({
        id: payload.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        flowId: payload.flowId || null,
        flowName: payload.flowName || (payload.flowId ? getFlowNameById(sessionId, payload.flowId) : 'Fluxo'),
        chatId: payload.chatId || '',
        status: payload.status || 'info',
        action: payload.action || null,
        step: Number.isFinite(payload.step) ? payload.step : null,
        message: payload.message ? String(payload.message) : '',
        error: payload.error ? String(payload.error) : '',
        createdAt: payload.createdAt || Date.now()
    });
    flowExecutionHistory[sessionId] = flowExecutionHistory[sessionId].slice(0, FLOW_EXECUTION_HISTORY_LIMIT);
}

function getFlowExecutionHistory(sessionId) {
    return Array.isArray(flowExecutionHistory[sessionId]) ? flowExecutionHistory[sessionId] : [];
}

function setActiveFlowState(sessionId, chatId, flow, overrides = {}) {
    if (!sessionId || !chatId || !flow) return null;
    if (!activeFlows[sessionId]) activeFlows[sessionId] = {};
    const prev = activeFlows[sessionId][chatId];
    if (prev && prev.timeoutId) {
        try { clearTimeout(prev.timeoutId); } catch (e) {}
    }
    const state = {
        flowId: flow.id,
        flowName: flow.name || getFlowNameById(sessionId, flow.id),
        step: Number.isFinite(overrides.step) ? overrides.step : 0,
        waiting: !!overrides.waiting,
        action: overrides.action || null,
        updatedAt: Date.now(),
        startedAt: overrides.startedAt || Date.now(),
        timeoutId: overrides.timeoutId || null
    };
    activeFlows[sessionId][chatId] = state;
    return state;
}

function normalizeBoolean(value, fallback = undefined) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (v === 'true') return true;
        if (v === 'false') return false;
    }
    if (typeof value === 'number') {
        if (value === 1) return true;
        if (value === 0) return false;
    }
    return fallback;
}

function getChatAiActive(sessionId, chatId, globalEnabled) {
    const aiStatus = loadAiChatStatus();
    const raw = aiStatus && aiStatus[sessionId] ? aiStatus[sessionId][chatId] : undefined;
    
    // Check if it's an object (new structure for WinBack)
    if (raw && typeof raw === 'object') {
        // If it has 'winbackCampaignId' or 'context', it's active
        if (raw.winbackCampaignId || raw.context) return true;
        // Fallback to explicit 'active' flag if present, or assume true if object exists (legacy/implicit)
        // But for safety, let's look for an explicit boolean property if we add one, or just default to true.
        // Let's assume if the object exists and is not empty, AI is active.
        return true; 
    }

    return normalizeBoolean(raw, !!globalEnabled);
}

function isConnectedLikeStatus(status) {
    return status === 'connected' || status === 'authenticated';
}

function hasReadyClient(sessionData) {
    return !!(sessionData && sessionData.client && (sessionData.ready === true || isConnectedLikeStatus(sessionData.status)));
}

function canFetchChats(sessionData) {
    if (!sessionData || !sessionData.client) return false;
    if (sessionData.ready === true) return true;
    const info = sessionData.client && sessionData.client.info ? sessionData.client.info : null;
    return !!(info && info.wid && info.wid.user);
}

function extractPhoneDigits(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 10) return '';
    return digits;
}

async function resolveChatIdForClient(client, chatId) {
    const raw = String(chatId || '');
    if (!raw) return raw;
    if (!raw.endsWith('@lid')) return raw;

    const timeout = (ms) => new Promise(resolve => setTimeout(() => resolve(null), ms));

    try {
        const contact = await Promise.race([
            client.getContactById(raw),
            timeout(6000)
        ]);
        const serialized = contact && contact.id && contact.id._serialized ? String(contact.id._serialized) : '';
        if (serialized && serialized !== raw) return serialized;
        const number = contact && contact.number ? String(contact.number) : '';
        if (number) return `${number}@c.us`;
    } catch (e) {}

    try {
        const result = await Promise.race([
            client.pupPage.evaluate(async (userId) => {
                if (!window.WWebJS || !window.WWebJS.enforceLidAndPnRetrieval) return {};
                const info = await window.WWebJS.enforceLidAndPnRetrieval(userId);
                if (!info) return {};
                const phone = info.phone && info.phone._serialized ? info.phone._serialized : null;
                const lid = info.lid && info.lid._serialized ? info.lid._serialized : null;
                return { phone, lid };
            }, raw),
            timeout(8000)
        ]);
        if (result && result.phone) return String(result.phone);
        if (result && result.lid) return String(result.lid);
    } catch (e) {}

    const digits = raw.split('@')[0];
    if (/^\d+$/.test(digits)) return `${digits}@c.us`;
    return raw;
}

function getFlowStepIndexById(flow, stepId) {
    if (!flow || !Array.isArray(flow.steps) || !stepId) return -1;
    return flow.steps.findIndex(item => item && String(item.id) === String(stepId));
}

async function safeGetProfilePicUrl(client, contactId) {
    const raw = String(contactId || '');
    if (!raw || !client || !client.pupPage) return null;

    const timeout = (ms) => new Promise(resolve => setTimeout(() => resolve(null), ms));

    try {
        const result = await Promise.race([client.getProfilePicUrl(raw), timeout(6000)]);
        if (result) return String(result);
    } catch (e) {}

    try {
        const result = await Promise.race([
            client.pupPage.evaluate(async (cid) => {
                try {
                    const Store = window.Store;
                    if (!Store || !Store.WidFactory || !Store.ProfilePic) return null;
                    const wid = Store.WidFactory.createWid(cid);
                    const api = Store.ProfilePic;
                    const fn = api.requestProfilePicFromServer || api.profilePicFind;
                    if (!fn) return null;
                    const res = await fn.call(api, wid);
                    return res && res.eurl ? res.eurl : null;
                } catch (e) {
                    return null;
                }
            }, raw),
            timeout(8000)
        ]);
        if (result) return String(result);
    } catch (e) {}

    return null;
}

function getFlowUsage(sessionId, flowId) {
    const items = [];
    const targetId = String(flowId);
    const chats = (activeFlows && sessionId && activeFlows[sessionId]) ? activeFlows[sessionId] : null;
    if (!chats) return items;
    for (const chatKey of Object.keys(chats)) {
        const state = chats[chatKey];
        if (!state) continue;
        if (String(state.flowId) !== targetId) continue;
        items.push({
            sessionId: sessionId,
            chatId: chatKey,
            step: typeof state.step === 'number' ? state.step : 0,
            waiting: !!state.waiting,
            action: state.action || null,
            updatedAt: Number.isFinite(state.updatedAt) ? state.updatedAt : null
        });
    }
    return items;
}

function getAllFlowsUsage(sessionId) {
    const usage = {};
    const chats = (activeFlows && sessionId && activeFlows[sessionId]) ? activeFlows[sessionId] : null;
    if (chats) {
        for (const chatKey of Object.keys(chats)) {
            const state = chats[chatKey];
            if (!state || state.flowId === undefined || state.flowId === null) continue;
            const id = String(state.flowId);
            if (!usage[id]) usage[id] = { count: 0, waitingCount: 0, flowName: state.flowName || getFlowNameById(sessionId, id), items: [] };
            usage[id].count += 1;
            if (state.waiting) usage[id].waitingCount += 1;
            usage[id].items.push({
                sessionId: sessionId,
                chatId: chatKey,
                step: typeof state.step === 'number' ? state.step : 0,
                waiting: !!state.waiting,
                action: state.action || null,
                updatedAt: Number.isFinite(state.updatedAt) ? state.updatedAt : null,
                flowName: state.flowName || getFlowNameById(sessionId, id)
            });
        }
    }
    return {
        active: usage,
        history: getFlowExecutionHistory(sessionId)
    };
}

function stopFlowInstances(sessionId, flowId) {
    const targetId = String(flowId);
    let stoppedCount = 0;
    const stoppedItems = [];
    const chats = (activeFlows && sessionId && activeFlows[sessionId]) ? activeFlows[sessionId] : null;
    if (!chats) return { stoppedCount, stoppedItems };
    for (const chatKey of Object.keys(chats)) {
        const state = chats[chatKey];
        if (!state) continue;
        if (String(state.flowId) !== targetId) continue;
        if (state.timeoutId) {
            try { clearTimeout(state.timeoutId); } catch (e) {}
        }
        stoppedItems.push({
            sessionId: sessionId,
            chatId: chatKey,
            step: typeof state.step === 'number' ? state.step : 0,
            waiting: !!state.waiting,
            action: state.action || null,
            updatedAt: Number.isFinite(state.updatedAt) ? state.updatedAt : null
        });
        delete chats[chatKey];
        stoppedCount += 1;
    }
    if (Object.keys(chats).length === 0) {
        delete activeFlows[sessionId];
    }
    return { stoppedCount, stoppedItems };
}

function stopFlowChat(sessionId, chatId, expectedFlowId = null) {
    if (!sessionId || !chatId) return { ok: false, error: 'sessionId e chatId são obrigatórios' };
    const chats = (activeFlows && activeFlows[sessionId]) ? activeFlows[sessionId] : null;
    if (!chats || !chats[chatId]) return { ok: false, error: 'Fluxo não está ativo para este chat' };
    const state = chats[chatId];
    if (expectedFlowId !== null && expectedFlowId !== undefined) {
        if (String(state.flowId) !== String(expectedFlowId)) {
            return { ok: false, error: 'Fluxo ativo não corresponde ao informado' };
        }
    }
    if (state.timeoutId) {
        try { clearTimeout(state.timeoutId); } catch (e) {}
    }
    delete chats[chatId];
    if (Object.keys(chats).length === 0) delete activeFlows[sessionId];
    return { ok: true };
}

function emitFlowUsage(sessionId) {
    try {
        emitToSessionClients(sessionId, 'flow-usage', getAllFlowsUsage(sessionId));
    } catch (e) {}
}

// Scheduled Messages Manager
let scheduledMessages = loadScheduledMessages();

function startFlowNow(sessionId, chatId, flowId, client) {
    const flows = loadFlows(sessionId);
    const flow = flows.find(f => String(f.id) === String(flowId));
    if (!flow) return { ok: false, error: 'Fluxo não encontrado' };

    setActiveFlowState(sessionId, chatId, flow, { step: 0, waiting: false, action: 'starting' });
    recordFlowExecutionHistory(sessionId, {
        flowId: flow.id,
        flowName: flow.name,
        chatId,
        status: 'running',
        action: 'starting',
        step: 0,
        message: 'Fluxo iniciado'
    });
    logFlowDebug(sessionId, chatId, flow, 0, 'flow_started', { source: 'startFlowNow' });
    emitFlowUsage(sessionId);
    executeFlowStep(sessionId, chatId, flow, 0, client);
    return { ok: true, flow };
}

// Check for scheduled messages every 30 seconds
setInterval(async () => {
    const now = Date.now();
    let changed = false;

    for (const sessionId in scheduledMessages) {
        const sessionMessages = scheduledMessages[sessionId] || [];
        const remainingMessages = [];

        for (const msg of sessionMessages) {
            if (msg.timestamp <= now) {
                // Time to send!
                const sessionData = activeClients.get(sessionId);
                if (hasReadyClient(sessionData)) {
                    try {
                        const kind = msg && (msg.type || msg.kind) ? String(msg.type || msg.kind) : 'text';

                        if (kind === 'flow') {
                            const res = startFlowNow(sessionId, msg.chatId, msg.flowId, sessionData.client);
                            if (!res.ok) {
                                console.error(`Error starting scheduled flow for ${msg.chatId}:`, res.error);
                            } else {
                                if (sessionData.socketId) {
                                    io.to(sessionData.socketId).emit('scheduled-message-sent', { id: msg.id, chatId: msg.chatId });
                                }
                            }
                            changed = true;
                        } else {
                            console.log(`Sending scheduled message to ${msg.chatId}`);
                            
                            // HUMAN SIMULATION
                            if (msg.simulation) {
                                try {
                                    const chat = await sessionData.client.getChatById(msg.chatId);
                                    if (msg.type === 'audio' || msg.type === 'ptt') {
                                        await chat.sendStateRecording();
                                        await new Promise(r => setTimeout(r, (msg.duration || 5000)));
                                        await chat.clearState();
                                    } else {
                                        await chat.sendStateTyping();
                                        const len = msg.body ? msg.body.length : 10;
                                        await new Promise(r => setTimeout(r, Math.min(len * 50, 10000))); // Min 10s or based on length
                                        await chat.clearState();
                                    }
                                } catch (e) {
                                    console.error('Error in simulation:', e);
                                }
                            }

                            const sentMsg = await sessionData.client.sendMessage(msg.chatId, msg.body);
                            await handleSentMessage(sessionId, sentMsg, sessionData.client);
                            
                            // WinBack Stats Update
                            if (msg.campaignId) {
                                const stats = loadWinbackStats();
                                if (!stats[sessionId]) stats[sessionId] = { totalSent: 0, campaigns: {} };
                                stats[sessionId].totalSent = (stats[sessionId].totalSent || 0) + 1;
                                if (stats[sessionId].campaigns[msg.campaignId]) {
                                    stats[sessionId].campaigns[msg.campaignId].sent = (stats[sessionId].campaigns[msg.campaignId].sent || 0) + 1;
                                }
                                saveWinbackStats(stats);
                            }

                            // Notify frontend
                            if (sessionData.socketId) {
                                emitToSessionClients(sessionId, 'message-sent', {
                                    chatId: msg.chatId,
                                    message: {
                                        id: sentMsg.id._serialized,
                                        body: sentMsg.body,
                                        from: sentMsg.from,
                                        to: sentMsg.to,
                                        timestamp: sentMsg.timestamp,
                                        fromMe: sentMsg.fromMe,
                                        type: sentMsg.type
                                    }
                                });
                                
                                // Notify that a scheduled message was processed
                                emitToSessionClients(sessionId, 'scheduled-message-sent', {
                                    id: msg.id,
                                    chatId: msg.chatId,
                                    campaignId: msg.campaignId
                                });
                            }
                            changed = true;
                        }
                    } catch (error) {
                        console.error(`Error sending scheduled message to ${msg.chatId}:`, error);
                        // Keep it to retry? Or delete? For now, keep if error is temporary, but let's delete to avoid loop
                        // Actually, better to keep it with a 'failed' status or retry count, but for simplicity let's delete
                        remainingMessages.push(msg); // Keep it for now if failed? No, let's just log and skip
                    }
                } else {
                    // Session not active, keep message for later
                    remainingMessages.push(msg);
                }
            } else {
                remainingMessages.push(msg);
            }
        }
        
        if (remainingMessages.length !== sessionMessages.length) {
            scheduledMessages[sessionId] = remainingMessages;
            changed = true;
        }
    }

    if (changed) {
        saveScheduledMessages(scheduledMessages);
    }
}, 30000);

// Archive Manager (Runs every hour to check for 30-day old chats)
// Ideally, this should be more sophisticated, but this meets the requirement.
const ARCHIVE_INTERVAL = 60 * 60 * 1000; // Check every hour
const DAYS_30 = 30 * 24 * 60 * 60 * 1000;

// Chat Cache Functions
function getChatCacheFile(sessionId) {
    return path.join(DATA_DIR, `chats_cache_${sessionId}.json`);
}

function loadChatCache(sessionId) {
    const file = getChatCacheFile(sessionId);
    if (fs.existsSync(file)) {
        try {
            return JSON.parse(fs.readFileSync(file));
        } catch (e) {
            console.error(`Error loading chat cache for ${sessionId}:`, e);
        }
    }
    return null;
}

function saveChatCache(sessionId, data) {
    const file = getChatCacheFile(sessionId);
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`Error saving chat cache for ${sessionId}:`, e);
    }
}

function loadDeletedChatsMetaForSession(sessionId) {
    try {
        const sid = String(sessionId || '');
        if (!sid) return {};
        const contacts = loadContacts();
        const sessionContacts = contacts && contacts[sid] && typeof contacts[sid] === 'object' ? contacts[sid] : {};
        const raw = sessionContacts.__deletedChats;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            const out = {};
            for (const [k, v] of Object.entries(raw)) {
                const id = String(k || '').trim();
                if (!id) continue;
                const t = Number(v || 0) || 0;
                if (t > 0) out[id] = t;
            }
            return out;
        }
        const arr = Array.isArray(raw) ? raw : [];
        const out = {};
        const now = Date.now();
        arr.map(String).filter(Boolean).forEach((id) => {
            out[id] = now;
        });
        return out;
    } catch (e) {
        return {};
    }
}

function rememberDeletedChatIds(sessionId, chatIds) {
    const sid = String(sessionId || '');
    if (!sid) return;
    const ids = Array.isArray(chatIds) ? chatIds.map(String).filter(Boolean) : [];
    if (ids.length === 0) return;
    const contacts = loadContacts();
    if (!contacts[sid]) contacts[sid] = {};
    const now = Date.now();
    const existing = loadDeletedChatsMetaForSession(sid);
    ids.forEach((id) => {
        existing[id] = now;
    });
    const keys = Object.keys(existing);
    if (keys.length > 6000) {
        const trimmed = keys
            .map(k => ({ id: k, t: Number(existing[k] || 0) || 0 }))
            .sort((a, b) => a.t - b.t)
            .slice(-5000);
        const next = {};
        trimmed.forEach(it => { next[it.id] = it.t; });
        contacts[sid].__deletedChats = next;
    } else {
        contacts[sid].__deletedChats = existing;
    }
    saveContacts(contacts);
}

function removeChatIdsFromCache(sessionId, chatIds) {
    const ids = new Set((Array.isArray(chatIds) ? chatIds : []).map(String).filter(Boolean));
    if (ids.size === 0) return;
    const cached = loadChatCache(sessionId);
    if (!Array.isArray(cached) || cached.length === 0) return;
    const next = cached.filter(c => c && c.id && !ids.has(String(c.id)));
    saveChatCache(sessionId, next);
}

function resolveChatIdCandidates(chatId, cachedChats) {
    const base = String(chatId || '').trim();
    const out = new Set();
    if (!base) return [];
    out.add(base);
    if (base.endsWith('@c.us') || base.endsWith('@g.us') || base.endsWith('@lid')) {
        if (base.includes('@')) out.add(base.split('@')[0]);
    }
    if (/^\d+$/.test(base)) {
        out.add(`${base}@c.us`);
    }
    if (base.endsWith('@lid') && Array.isArray(cachedChats)) {
        const cached = cachedChats.find(c => c && String(c.id) === base);
        const guessDigits = extractPhoneDigits(cached && (cached.phoneNumber || cached.name || '')) || '';
        if (guessDigits) {
            out.add(`${guessDigits}@c.us`);
            out.add(guessDigits);
        }
    }
    return Array.from(out);
}

async function deleteChatOnWhatsApp(client, sessionId, chatId) {
    if (!client) return;
    const base = String(chatId || '').trim();
    if (!base) return;

    const cached = loadChatCache(sessionId);
    const candidates = resolveChatIdCandidates(base, cached);
    const resolved = [];
    for (const id of candidates) {
        try {
            const r = await resolveChatIdForClient(client, id);
            if (r && String(r).trim()) resolved.push(String(r).trim());
        } catch (e) {}
    }
    const all = Array.from(new Set([...candidates, ...resolved].map(String).filter(Boolean)));

    for (const id of all) {
        try {
            const chat = await client.getChatById(id);
            try {
                await chat.delete();
                return;
            } catch (e) {
                try { await chat.clearMessages(); } catch (e2) {}
                try {
                    await chat.delete();
                    return;
                } catch (e3) {}
                try { await chat.archive(); } catch (e4) {}
            }
        } catch (e) {}
    }
}

function shouldHideDeletedChat(deletedMeta, chatId, chatTimestampSeconds) {
    const meta = deletedMeta && typeof deletedMeta === 'object' ? deletedMeta : {};
    const id = String(chatId || '').trim();
    if (!id) return false;
    const deletedAt = Number(meta[id] || 0) || 0;
    if (!deletedAt) return false;
    const tsSec = Number(chatTimestampSeconds || 0) || 0;
    const tsMs = tsSec > 0 ? tsSec * 1000 : 0;
    if (tsMs && tsMs > deletedAt) return false;
    return true;
}

function clearDeletedChatMetaIfReappeared(sessionId, deletedMeta, chatId, chatTimestampSeconds) {
    const meta = deletedMeta && typeof deletedMeta === 'object' ? deletedMeta : {};
    const id = String(chatId || '').trim();
    if (!id) return false;
    const deletedAt = Number(meta[id] || 0) || 0;
    if (!deletedAt) return false;
    const tsSec = Number(chatTimestampSeconds || 0) || 0;
    const tsMs = tsSec > 0 ? tsSec * 1000 : 0;
    if (!tsMs || tsMs <= deletedAt) return false;
    const contacts = loadContacts();
    if (!contacts[sessionId] || typeof contacts[sessionId] !== 'object') return false;
    const stored = loadDeletedChatsMetaForSession(sessionId);
    if (!stored[id]) return false;
    delete stored[id];
    contacts[sessionId].__deletedChats = stored;
    saveContacts(contacts);
    return true;
}

setInterval(async () => {
    console.log('Running archive check...');
    const archiveLogFile = path.join(ARCHIVE_DIR, 'archive_log.json');
    const archiveLog = loadData(archiveLogFile);
    // We iterate over active clients to fetch history
    for (const [sessionId, sessionData] of activeClients.entries()) {
        if (hasReadyClient(sessionData)) {
             try {
                 if (getChatsInFlight.get(sessionId)) continue;
                 const getChatsPromise = sessionData.client.getChats();
                 const timeoutPromise = new Promise((_, reject) =>
                     setTimeout(() => reject(new Error('Timeout getting chats (archive)')), 120000)
                 );
                 const chats = await Promise.race([getChatsPromise, timeoutPromise]);
                 if (!archiveLog[sessionId]) archiveLog[sessionId] = {};
                 let archivedThisRun = 0;
                 
                 for (const chat of chats) {
                     if (archivedThisRun >= 3) break;
                     const lastArchive = archiveLog[sessionId][chat.id._serialized] || 0;
                     
                     if (Date.now() - lastArchive > DAYS_30) {
                         console.log(`Archiving chat ${chat.name} (${chat.id._serialized})...`);
                         
                         const messages = await chat.fetchMessages({ limit: 200 });
                         
                         const archiveData = {
                             sessionId,
                             chatId: chat.id._serialized,
                             name: chat.name,
                             archivedAt: Date.now(),
                             messages: messages.map(msg => ({
                                id: msg.id._serialized,
                                body: msg.body,
                                from: msg.from,
                                to: msg.to,
                                timestamp: msg.timestamp,
                                fromMe: msg.fromMe,
                                type: msg.type
                            }))
                         };
                         
                         const fileName = `${sessionId}_${chat.id._serialized.replace(/\D/g,'')}_${Date.now()}.json`;
                         fs.writeFileSync(path.join(ARCHIVE_DIR, fileName), JSON.stringify(archiveData, null, 2));
                         
                         // Update log
                         archiveLog[sessionId][chat.id._serialized] = Date.now();
                         saveData(archiveLogFile, archiveLog);
                         console.log(`Chat archived to ${fileName}`);
                         archivedThisRun++;
                     }
                 }
             } catch (error) {
                 console.error(`Error archiving for session ${sessionId}:`, error);
             }
        }
    }
}, ARCHIVE_INTERVAL);

// Middleware
app.use(express.json({ limit: '25mb' }));
app.use(express.static(PUBLIC_DIR));

// --- API ENDPOINTS ---
app.post('/api/evolution/webhook', async (req, res) => {
    try {
        const body = req.body || {};
        const event = normalizeEvolutionEventName(body.event || body.type || body.eventName || '');
        const sessionId = extractEvolutionSessionId(body);
        if (event && sessionId) console.log('Evolution webhook:', event, sessionId);
        await processEvolutionWebhookEvent(req.body || {});
        res.json({ success: true });
    } catch (e) {
        console.error('Evolution webhook error:', e);
        res.status(500).json({ success: false });
    }
});

app.post('/api/auth/register', (req, res) => {
    try {
        const name = String(req.body && req.body.name ? req.body.name : '').trim();
        const email = normalizeEmail(req.body && req.body.email ? req.body.email : '');
        const password = String(req.body && req.body.password ? req.body.password : '');

        if (!name || !email || !password) {
            res.status(400).json({ success: false, error: 'name, email e password são obrigatórios' });
            return;
        }
        if (String(password).length < 6) {
            res.status(400).json({ success: false, error: 'senha muito curta (mínimo 6 caracteres)' });
            return;
        }

        const existing = getUserByEmail(email);
        if (existing) {
            res.status(409).json({ success: false, error: 'email já cadastrado' });
            return;
        }

        const user = upsertUser({
            id: generateId('user'),
            name,
            email,
            passwordHash: hashPassword(password),
            sessionId: null,
            createdAt: Date.now(),
            connectedAt: null,
            whatsappNumber: null,
            whatsappName: null,
            lastQrAt: null
        });
        const token = createAuthToken({ userId: user.id, isAdmin: false });
        res.json({ success: true, token, user: { name: user.name, email: user.email, sessionId: null } });
    } catch (e) {
        res.status(500).json({ success: false, error: 'erro interno' });
    }
});

app.post('/api/auth/login', (req, res) => {
    try {
        const email = normalizeEmail(req.body && req.body.email ? req.body.email : '');
        const password = String(req.body && req.body.password ? req.body.password : '');
        if (!email || !password) {
            res.status(400).json({ success: false, error: 'email e password são obrigatórios' });
            return;
        }
        const user = getUserByEmail(email);
        if (!user) {
            res.status(401).json({ success: false, error: 'credenciais inválidas' });
            return;
        }
        const hasHash = typeof user.passwordHash === 'string' && user.passwordHash.trim().length > 0;
        const legacyOk = !hasHash && String(user.promoCode || '').trim() && String(user.promoCode || '').trim() === String(password || '').trim();
        const ok = hasHash ? verifyPassword(password, user.passwordHash) : legacyOk;
        if (!ok) {
            res.status(401).json({ success: false, error: 'credenciais inválidas' });
            return;
        }
        if (!hasHash) {
            upsertUser({ ...user, passwordHash: hashPassword(password), updatedAt: Date.now() });
        }
        const token = createAuthToken({ userId: user.id, isAdmin: false });
        res.json({ success: true, token, user: { name: user.name, email: user.email, sessionId: user.sessionId || null } });
    } catch (e) {
        res.status(500).json({ success: false, error: 'erro interno' });
    }
});

app.post('/api/admin/login', (req, res) => {
    try {
        const email = normalizeEmail(req.body && req.body.email ? req.body.email : '');
        const password = String(req.body && req.body.password ? req.body.password : '');
        if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
            res.status(401).json({ success: false, error: 'credenciais inválidas' });
            return;
        }
        const token = createAuthToken({ isAdmin: true });
        res.json({ success: true, token, admin: { email: ADMIN_EMAIL } });
    } catch (e) {
        res.status(500).json({ success: false, error: 'erro interno' });
    }
});

app.get('/api/me', requireUser, (req, res) => {
    const u = req.user;
    res.json({ success: true, user: { name: u.name, email: u.email, sessionId: u.sessionId || null, whatsappNumber: u.whatsappNumber || null } });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const store = loadUsersStore();
        const users = Array.isArray(store.users) ? store.users : [];
        const sessions = loadSessionsData();
        const out = await Promise.all(users.map(async (u) => {
            const sid = u.sessionId || null;
            const live = sid ? activeClients.get(sid) : null;
            const saved = sid ? sessions[sid] : null;
            const status = live ? live.status : (saved ? 'authenticated' : 'none');
            const proxy = sid ? proxyManager.getProxyForSession(sid) : null;
            const netInfo = sid ? await buildSessionNetworkInfo(sid) : await buildSessionNetworkInfo('');
            const history = Array.isArray(u.history) ? u.history.slice().sort((a, b) => Number(b.at || 0) - Number(a.at || 0)) : [];
            const lastDisconnect = history.find(h => h && (h.type === 'disconnect' || h.type === 'deleted' || h.type === 'auth_failed')) || null;
            return {
                id: u.id,
                name: u.name,
                email: u.email,
                sessionId: sid,
                status,
                proxy: proxy || '—',
                whatsappNumber: (u.whatsappNumber || (saved && saved.phoneNumber) || null),
                whatsappName: (u.whatsappName || (saved && saved.name) || null),
                createdAt: u.createdAt || null,
                connectedAt: u.connectedAt || null,
                disconnectedAt: u.disconnectedAt || (lastDisconnect && lastDisconnect.at) || null,
                lastDisconnectedAt: u.lastDisconnectedAt || (lastDisconnect && lastDisconnect.at) || null,
                lastQrAt: u.lastQrAt || null,
                ip: netInfo.currentConnectionIp || null,
                realIp: netInfo.serverRealIp || null,
                proxyIp: netInfo.proxyConnectionIp || null,
                proxyHost: netInfo.proxyHost || null,
                proxyPort: netInfo.proxyPort || null,
                usingProxy: !!netInfo.usingProxy,
                proxyIpValidated: !!netInfo.proxyIpValidated,
                proxyValidationError: netInfo.proxyValidationError || null,
                proxyValidationEndpoint: netInfo.proxyValidationEndpoint || null,
                history
            };
        }));
        res.json({ success: true, users: out });
    } catch (e) {
        res.status(500).json({ success: false, error: 'erro interno' });
    }
});

app.get('/api/network-info', async (req, res) => {
    try {
        const realNetwork = await fetchOutboundPublicIp(null);
        res.json({
            success: true,
            realIp: (realNetwork && realNetwork.ip) ? realNetwork.ip : null,
            source: (realNetwork && realNetwork.endpoint) ? realNetwork.endpoint : null,
            requestIp: getRemoteRequestIp(req) || null
        });
    } catch (e) {
        res.status(500).json({ success: false, error: 'erro ao consultar ip' });
    }
});

app.get('/api/admin/proxies', requireAdmin, (req, res) => {
    try {
        const state = proxyManager.getAdminState();
        const stats = proxyManager.getStats();
        res.json({ success: true, state, stats });
    } catch (e) {
        res.status(500).json({ success: false, error: 'erro ao carregar proxies' });
    }
});

app.put('/api/admin/proxies', requireAdmin, (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const nextState = proxyManager.saveAdminState(body.state || body);
        const stats = proxyManager.getStats();
        io.emit('system-stats-update', stats);
        res.json({ success: true, state: nextState, stats });
    } catch (e) {
        res.status(500).json({ success: false, error: 'erro ao salvar proxies' });
    }
});

app.get('/api/uploads', requireUser, (req, res) => {
    const rawSessionId = req.user && req.user.sessionId ? String(req.user.sessionId) : '';
    const safeSessionId = rawSessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!safeSessionId) {
        res.status(400).json({ success: false, error: 'sessionId obrigatório' });
        return;
    }

    const dir = path.join(UPLOADS_DIR, safeSessionId);
    const prefix = `/uploads/${safeSessionId}/`;
    const out = [];
    try {
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            files
                .filter(f => /\.(jpg|jpeg|png|gif|mp3|ogg|wav|mp4|webm)$/i.test(f))
                .forEach(f => out.push(`${prefix}${f}`));
        }
    } catch (e) {}
    res.json({ success: true, files: out });
});

app.post('/api/upload', (req, res, next) => {
    // 1. Try User Auth
    const token = parseBearerToken(req);
    const rec = validateAuthToken(token);
    let user = null;
    if (rec && !rec.isAdmin) {
        user = getUserById(rec.userId);
    }

    // 2. Determine Session ID
    let rawSessionId = '';

    if (user && user.sessionId) {
        // Authenticated user
        rawSessionId = String(user.sessionId);
    } else if (req.query && req.query.sessionId) {
        // Direct session access (CRM view)
        const sid = String(req.query.sessionId).trim();
        const sessions = loadSessionsData();
        if (sessions[sid]) {
            rawSessionId = sid;
        }
    }

    if (!rawSessionId) {
        return res.status(401).json({ success: false, error: 'unauthorized' });
    }

    const safeSessionId = rawSessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!req.query) req.query = {};
    req.query.sessionId = safeSessionId;
    next();
}, upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    try {
        const wantsVoiceNote = queryFlag(req.query && req.query.voiceNote);
        let finalPath = req.file.path;
        let finalMime = req.file.mimetype || 'application/octet-stream';

        if (wantsVoiceNote) {
            const ext = path.extname(req.file.originalname || '').toLowerCase();
            const looksAudio = String(req.file.mimetype || '').startsWith('audio/');
            const supportedAudio = looksAudio || ext === '.mp3' || ext === '.ogg';
            if (!supportedAudio) {
                try { fs.unlinkSync(req.file.path); } catch (e) {}
                return res.status(400).json({ success: false, error: 'Envie um áudio MP3 ou OGG.' });
            }
            finalPath = await convertAudioToVoiceNoteOgg(req.file.path, {
                outputNamePrefix: 'flow-audio',
                force: true,
                removeOriginal: true
            });
            finalMime = 'audio/ogg';
        }

        const rel = toPublicRelativePath(finalPath);
        if (!rel) {
            throw new Error('Falha ao gerar caminho do upload');
        }

        res.json({
            success: true,
            path: rel,
            filename: path.basename(finalPath),
            originalName: req.file.originalname || path.basename(finalPath),
            mimetype: finalMime
        });
    } catch (error) {
        console.error('Upload error:', error);
        try { if (req.file && req.file.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch (e) {}
        res.status(500).json({ success: false, error: 'Falha ao processar upload.' });
    }
});

function ensureFlowSupportsInteractiveSend(client, stepType) {
    if (!client || client.__provider !== 'evolution' || typeof client.sendButtons !== 'function') {
        throw new Error(`O nó ${stepType} exige sessão Evolution API conectada.`);
    }
}

function buildFlowButtonsPayload(step) {
    const buttons = (Array.isArray(step.buttons) ? step.buttons : []).map((button, index) => {
        const normalized = normalizeFlowButtonConfig(button, index, 'button');
        if (normalized.type === 'reply') {
            return {
                type: normalized.type,
                id: normalized.id,
                displayText: normalized.displayText
            };
        }
        if (normalized.type === 'url') {
            return {
                type: normalized.type,
                displayText: normalized.displayText,
                url: normalized.url || undefined
            };
        }
        if (normalized.type === 'call') {
            return {
                type: normalized.type,
                displayText: normalized.displayText,
                phoneNumber: normalized.phoneNumber || undefined
            };
        }
        if (normalized.type === 'copy') {
            return {
                type: normalized.type,
                displayText: normalized.displayText,
                copyCode: normalized.copyCode || undefined
            };
        }
        return {
            type: normalized.type,
            displayText: normalized.displayText
        };
    });
    return {
        title: String(step.title || '').trim(),
        description: String(step.text || step.bodyText || step.content || '').trim(),
        footer: String(step.footerText || '').trim(),
        imageUrl: toPublicAssetUrl(step.imageUrl) || undefined,
        buttons
    };
}

function buildFlowListPayload(step) {
    const sections = (Array.isArray(step.sections) ? step.sections : []).map((section, sectionIndex) => {
        const normalized = normalizeFlowListSection(section, sectionIndex);
        return {
            title: normalized.title,
            rows: normalized.rows.map(row => ({
                title: row.title,
                description: row.description || undefined,
                rowId: row.rowId
            }))
        };
    });
    return {
        title: String(step.title || '').trim(),
        description: String(step.description || step.text || step.content || '').trim(),
        buttonText: String(step.buttonText || 'Abrir menu').trim() || 'Abrir menu',
        footerText: String(step.footerText || '').trim(),
        sections
    };
}

function buildFlowCarouselPayload(step) {
    const cards = (Array.isArray(step.cards) ? step.cards : []).map((card, cardIndex) => {
        const normalized = normalizeFlowCarouselCard(card, cardIndex);
        return {
            title: normalized.title,
            description: normalized.description || '',
            imageUrl: toPublicAssetUrl(normalized.imageUrl || normalized.image) || undefined,
            buttons: normalized.buttons.map(button => ({
                type: button.type,
                displayText: button.displayText,
                id: button.type === 'reply' ? button.id : undefined,
                url: button.url || undefined,
                phoneNumber: button.phoneNumber || undefined
            }))
        };
    });
    return {
        description: String(step.description || step.text || step.content || '').trim(),
        footerText: String(step.footerText || '').trim(),
        cards
    };
}

async function handleFlowInteractiveStepSend(sessionId, chatId, flow, stepIndex, client, step, kind) {
    ensureFlowSupportsInteractiveSend(client, kind);
    if (activeFlows[sessionId] && activeFlows[sessionId][chatId]) {
        activeFlows[sessionId][chatId].action = 'sending_interactive';
        activeFlows[sessionId][chatId].updatedAt = Date.now();
    }
    emitFlowUsage(sessionId);

    const payload = kind === 'buttons'
        ? buildFlowButtonsPayload(step)
        : (kind === 'list' ? buildFlowListPayload(step) : buildFlowCarouselPayload(step));
    logFlowDebug(sessionId, chatId, flow, stepIndex, 'interactive_send_attempt', {
        kind,
        payload
    });

    let sentMsg;
    if (kind === 'buttons') {
        sentMsg = await client.sendButtons(chatId, payload);
    } else if (kind === 'list') {
        sentMsg = await client.sendList(chatId, payload);
    } else {
        sentMsg = await client.sendCarousel(chatId, payload);
    }
    logFlowDebug(sessionId, chatId, flow, stepIndex, 'interactive_send_success', {
        kind,
        sentMessageId: sentMsg && sentMsg.id && sentMsg.id._serialized ? sentMsg.id._serialized : null
    });
    await handleSentMessage(sessionId, sentMsg, client);

    const branches = getFlowInteractiveBranches(step);
    if (branches.length > 0) {
        if (activeFlows[sessionId] && activeFlows[sessionId][chatId]) {
            activeFlows[sessionId][chatId].waiting = true;
            activeFlows[sessionId][chatId].action = 'waiting_interactive';
            activeFlows[sessionId][chatId].updatedAt = Date.now();
            emitFlowUsage(sessionId);
        }
        logFlowDebug(sessionId, chatId, flow, stepIndex, 'interactive_waiting', {
            kind,
            branches: branches.map(branch => ({ id: branch.id, label: branch.label, targetId: branch.targetId || null }))
        });
        return;
    }

    return await executeFlowStep(sessionId, chatId, flow, getFlowNextStepIndex(flow, step, stepIndex), client);
}

async function processIncomingFlowMessage(sessionId, msg, client) {
    if (!msg || !msg.chatId || msg.fromMe) return false;
    const chatKey = String(msg.chatId);
    const flows = loadFlows(sessionId);
    const incomingText = String(msg.body || '').trim().toLowerCase();
    const replyId = getIncomingMessageReplyId(msg);

    if (activeFlows[sessionId] && activeFlows[sessionId][chatKey]) {
        const active = activeFlows[sessionId][chatKey];
        if (active.waiting) {
            if (active.timeoutId) clearTimeout(active.timeoutId);
            active.waiting = false;
            active.timeoutId = null;
            active.action = null;

            const currentFlowObj = flows.find(f => String(f.id) === String(active.flowId));
            const step = currentFlowObj && currentFlowObj.steps && currentFlowObj.steps[active.step] ? currentFlowObj.steps[active.step] : null;
            if (step && step.type === 'wait_response' && step.exactMatch && incomingText && incomingText === String(step.exactMatch).trim().toLowerCase()) {
                if (step.exactMatchFlowId) {
                    const targetFlow = flows.find(f => String(f.id) === String(step.exactMatchFlowId));
                    if (targetFlow) {
                        setActiveFlowState(sessionId, chatKey, targetFlow, { step: 0, waiting: false, action: 'switch_exact_match' });
                        recordFlowExecutionHistory(sessionId, {
                            flowId: targetFlow.id,
                            flowName: targetFlow.name,
                            chatId: chatKey,
                            status: 'running',
                            action: 'switch_exact_match',
                            step: 0,
                            message: 'Fluxo iniciado por resposta exata'
                        });
                        logFlowDebug(sessionId, chatKey, targetFlow, 0, 'flow_switch_exact_match');
                        emitFlowUsage(sessionId);
                        await executeFlowStep(sessionId, chatKey, targetFlow, 0, client);
                        return true;
                    }
                }
            }

            active.updatedAt = Date.now();

            if (step && ['buttons', 'list', 'carousel'].includes(step.type)) {
                const branch = findFlowInteractiveBranch(step, replyId);
                const targetIndex = branch && branch.targetId ? getFlowStepIndexById(currentFlowObj, branch.targetId) : -1;
                await executeFlowStep(sessionId, chatKey, currentFlowObj, targetIndex >= 0 ? targetIndex : getFlowNextStepIndex(currentFlowObj, step, active.step), client);
                emitFlowUsage(sessionId);
                return true;
            }

            if (currentFlowObj) {
                const currentStep = currentFlowObj.steps && currentFlowObj.steps[active.step] ? currentFlowObj.steps[active.step] : null;
                const responseNext = currentStep && (currentStep.responseNext || currentStep.next);
                const nextIndex = responseNext ? getFlowStepIndexById(currentFlowObj, responseNext) : -1;
                await executeFlowStep(sessionId, chatKey, currentFlowObj, nextIndex >= 0 ? nextIndex : active.step + 1, client);
                emitFlowUsage(sessionId);
                return true;
            }
        }
    }

    let historyCount = 0;
    try {
        const file = getHistoryFilePath(sessionId, chatKey);
        if (fs.existsSync(file)) {
            const history = JSON.parse(fs.readFileSync(file, 'utf8'));
            historyCount = Array.isArray(history) ? history.length : 0;
        }
    } catch (e) {}

    for (const flow of flows) {
        let triggered = false;
        const triggerKeyword = String(flow.triggerKeyword || flow.trigger || '').trim().toLowerCase();
        if ((flow.triggerType === 'keyword' || !flow.triggerType) && triggerKeyword && triggerKeyword === incomingText) {
            triggered = true;
        } else if (flow.triggerType === 'first_message' && historyCount <= 1) {
            triggered = true;
        }
        if (triggered) {
            setActiveFlowState(sessionId, chatKey, flow, { step: 0, waiting: false, action: 'triggered' });
            recordFlowExecutionHistory(sessionId, {
                flowId: flow.id,
                flowName: flow.name,
                chatId: chatKey,
                status: 'running',
                action: 'triggered',
                step: 0,
                message: `Fluxo iniciado por gatilho ${flow.triggerType || 'keyword'}`
            });
            logFlowDebug(sessionId, chatKey, flow, 0, 'flow_triggered', {
                triggerType: flow.triggerType || 'keyword',
                incomingText
            });
            emitFlowUsage(sessionId);
            await executeFlowStep(sessionId, chatKey, flow, 0, client);
            return true;
        }
    }

    return false;
}

// Flow Execution Logic
async function executeFlowStep(sessionId, chatId, flow, stepIndex, client) {
    // Safety Check: Ensure flow is still active and valid
    const activeFlow = activeFlows[sessionId]?.[chatId];
    if (!activeFlow || String(activeFlow.flowId) !== String(flow.id)) {
        return;
    }

    if (stepIndex >= flow.steps.length) {
        // End of flow
        if (activeFlows[sessionId] && activeFlows[sessionId][chatId]) {
             delete activeFlows[sessionId][chatId];
        }
        recordFlowExecutionHistory(sessionId, {
            flowId: flow.id,
            flowName: flow.name,
            chatId,
            status: 'success',
            action: 'completed',
            step: stepIndex,
            message: 'Fluxo finalizado com sucesso'
        });
        logFlowDebug(sessionId, chatId, flow, stepIndex, 'flow_completed');
        emitFlowUsage(sessionId);
        return;
    }

    // Update active step
    if (activeFlows[sessionId][chatId]) {
        if (activeFlows[sessionId][chatId].timeoutId) {
            try { clearTimeout(activeFlows[sessionId][chatId].timeoutId); } catch (e) {}
            activeFlows[sessionId][chatId].timeoutId = null;
        }
        activeFlows[sessionId][chatId].step = stepIndex;
        activeFlows[sessionId][chatId].waiting = false;
        activeFlows[sessionId][chatId].action = null;
        activeFlows[sessionId][chatId].updatedAt = Date.now();
    }
    emitFlowUsage(sessionId);

    const step = flow.steps[stepIndex];
    const { MessageMedia } = require('whatsapp-web.js');
    logFlowDebug(sessionId, chatId, flow, stepIndex, 'step_start', {
        stepType: step && step.type ? step.type : null
    });

    try {
        if (step.type === 'text') {
            const typingDurationMs = getTextStepTypingDurationMs(step);
            if (activeFlows[sessionId] && activeFlows[sessionId][chatId]) {
                activeFlows[sessionId][chatId].action = 'typing';
                activeFlows[sessionId][chatId].updatedAt = Date.now();
            }
            emitFlowUsage(sessionId);
            try {
                const chat = await client.getChatById(chatId);
                const tickMs = 7000;
                const endAt = Date.now() + typingDurationMs;
                logFlowDebug(sessionId, chatId, flow, stepIndex, 'typing_simulation_start', { typingDurationMs });
                while (Date.now() < endAt) {
                    const stillActive = activeFlows[sessionId]?.[chatId] && String(activeFlows[sessionId][chatId].flowId) === String(flow.id);
                    if (!stillActive) {
                        try { await chat.clearState(); } catch (e) {}
                        return;
                    }
                    const remaining = endAt - Date.now();
                    try { await chat.sendStateTyping(); } catch (e) {}
                    await new Promise(resolve => setTimeout(resolve, Math.min(tickMs, remaining)));
                }
                try { await chat.clearState(); } catch (e) {}
            } catch (e) {
                console.error('Error simulating typing:', e);
            }
            
            const hasUrl = typeof step.content === 'string' && /https?:\/\/\S+/i.test(step.content);
            const options = hasUrl ? { linkPreview: false } : undefined;
            logFlowDebug(sessionId, chatId, flow, stepIndex, 'text_send_attempt', {
                text: String(step.content || ''),
                hasUrl,
                typingDurationMs
            });
            const sentMsg = await client.sendMessage(chatId, step.content, options);
            await handleSentMessage(sessionId, sentMsg, client);
            logFlowDebug(sessionId, chatId, flow, stepIndex, 'text_send_success');
            return await executeFlowStep(sessionId, chatId, flow, getFlowNextStepIndex(flow, step, stepIndex), client);
        } else if (step.type === 'delay') {
            if (activeFlows[sessionId] && activeFlows[sessionId][chatId]) {
                activeFlows[sessionId][chatId].action = 'delay';
                activeFlows[sessionId][chatId].updatedAt = Date.now();
            }
            emitFlowUsage(sessionId);
            const delayMs = sanitizeFlowDurationMs(typeof step.time !== 'undefined' ? step.time : step.content);
            logFlowDebug(sessionId, chatId, flow, stepIndex, 'delay_wait', { delayMs });
            const timeoutId = setTimeout(() => {
                // Check again before proceeding after delay
                const currentActive = activeFlows[sessionId]?.[chatId];
                // We check if flowId matches. We don't strictly check step because we updated it above.
                // But if the flow was restarted, step would be 0.
                // If we are here, we are about to go to stepIndex + 1.
                // If currentActive.step is 0, we should stop.
                // So:
                if (currentActive && String(currentActive.flowId) === String(flow.id) && currentActive.step === stepIndex) {
                    executeFlowStep(sessionId, chatId, flow, getFlowNextStepIndex(flow, step, stepIndex), client);
                }
            }, delayMs);
            if (activeFlows[sessionId] && activeFlows[sessionId][chatId]) {
                activeFlows[sessionId][chatId].timeoutId = timeoutId;
            }
        } else if (step.type === 'image') {
            const relPath = typeof step.path === 'string' ? step.path.replace(/^[/\\]+/, '') : '';
            const fullPath = path.join(PUBLIC_DIR, relPath);
            if (fs.existsSync(fullPath)) {
                if (activeFlows[sessionId] && activeFlows[sessionId][chatId]) {
                    activeFlows[sessionId][chatId].action = 'sending_media';
                    activeFlows[sessionId][chatId].updatedAt = Date.now();
                }
                emitFlowUsage(sessionId);
                logFlowDebug(sessionId, chatId, flow, stepIndex, 'image_send_attempt', { fullPath });
                const media = MessageMedia.fromFilePath(fullPath);
                const sentMsg = await client.sendMessage(chatId, media);
                await handleSentMessage(sessionId, sentMsg, client);
                logFlowDebug(sessionId, chatId, flow, stepIndex, 'image_send_success');
            }
            return await executeFlowStep(sessionId, chatId, flow, getFlowNextStepIndex(flow, step, stepIndex), client);
        } else if (step.type === 'audio') {
            const relPath = typeof step.path === 'string' ? step.path.replace(/^[/\\]+/, '') : '';
            const fullPath = path.join(PUBLIC_DIR, relPath);
            if (fs.existsSync(fullPath)) {
                let tempVoicePath = null;
                logFlowDebug(sessionId, chatId, flow, stepIndex, 'audio_prepare', {
                    fullPath,
                    recordingDuration: step.recordingDuration || 0
                });
                // Simulate recording
                if (step.recordingDuration && Number(step.recordingDuration) > 0) {
                    try {
                        const chat = await client.getChatById(chatId);
                        const totalMs = Math.max(0, Number(step.recordingDuration));
                        const tickMs = 7000;
                        const endAt = Date.now() + totalMs;
                        if (activeFlows[sessionId] && activeFlows[sessionId][chatId]) {
                            activeFlows[sessionId][chatId].action = 'recording';
                            activeFlows[sessionId][chatId].updatedAt = Date.now();
                        }
                        emitFlowUsage(sessionId);
                        while (Date.now() < endAt) {
                            const stillActive = activeFlows[sessionId]?.[chatId] && String(activeFlows[sessionId][chatId].flowId) === String(flow.id);
                            if (!stillActive) {
                                try { await chat.clearState(); } catch (e) {}
                                return;
                            }
                            const remaining = endAt - Date.now();
                            try { await chat.sendStateRecording(); } catch (e) {}
                            await new Promise(resolve => setTimeout(resolve, Math.min(tickMs, remaining)));
                        }
                        try { await chat.clearState(); } catch (e) {}
                    } catch (e) {
                        console.error('Error simulating recording:', e);
                    }
                }

                if (activeFlows[sessionId] && activeFlows[sessionId][chatId]) {
                    activeFlows[sessionId][chatId].action = 'sending_media';
                    activeFlows[sessionId][chatId].updatedAt = Date.now();
                }
                emitFlowUsage(sessionId);
                let chosenPath = fullPath;
                try {
                    chosenPath = await convertAudioToVoiceNoteOgg(fullPath, {
                        outputNamePrefix: 'flow-step-audio',
                        force: path.extname(fullPath).toLowerCase() !== '.ogg',
                        removeOriginal: false
                    });
                    if (chosenPath !== fullPath) tempVoicePath = chosenPath;
                } catch (e) {
                    chosenPath = fullPath;
                }
                try {
                    const media = MessageMedia.fromFilePath(chosenPath);
                    logFlowDebug(sessionId, chatId, flow, stepIndex, 'audio_send_attempt', {
                        chosenPath,
                        sendAudioAsVoice: true
                    });
                    const sentMsg = await client.sendMessage(chatId, media, { sendAudioAsVoice: true });
                    await handleSentMessage(sessionId, sentMsg, client);
                    logFlowDebug(sessionId, chatId, flow, stepIndex, 'audio_send_success', { chosenPath });
                } finally {
                    if (tempVoicePath) {
                        try { fs.unlinkSync(tempVoicePath); } catch (e) {}
                    }
                }
            }
            return await executeFlowStep(sessionId, chatId, flow, getFlowNextStepIndex(flow, step, stepIndex), client);
        } else if (step.type === 'video') {
            const relPath = typeof step.path === 'string' ? step.path.replace(/^[/\\]+/, '') : '';
            const fullPath = path.join(PUBLIC_DIR, relPath);
            if (fs.existsSync(fullPath)) {
                if (activeFlows[sessionId] && activeFlows[sessionId][chatId]) {
                    activeFlows[sessionId][chatId].action = 'sending_media';
                    activeFlows[sessionId][chatId].updatedAt = Date.now();
                }
                emitFlowUsage(sessionId);
                logFlowDebug(sessionId, chatId, flow, stepIndex, 'video_send_attempt', { fullPath });
                const media = MessageMedia.fromFilePath(fullPath);
                const sentMsg = await client.sendMessage(chatId, media, { sendMediaAsDocument: false });
                await handleSentMessage(sessionId, sentMsg, client);
                logFlowDebug(sessionId, chatId, flow, stepIndex, 'video_send_success');
            }
            return await executeFlowStep(sessionId, chatId, flow, getFlowNextStepIndex(flow, step, stepIndex), client);
        } else if (step.type === 'buttons') {
            return await handleFlowInteractiveStepSend(sessionId, chatId, flow, stepIndex, client, step, 'buttons');
        } else if (step.type === 'list') {
            return await handleFlowInteractiveStepSend(sessionId, chatId, flow, stepIndex, client, step, 'list');
        } else if (step.type === 'carousel') {
            return await handleFlowInteractiveStepSend(sessionId, chatId, flow, stepIndex, client, step, 'carousel');
        } else if (step.type === 'wait_response') {
            // Wait for user response
            if (activeFlows[sessionId] && activeFlows[sessionId][chatId]) {
                const active = activeFlows[sessionId][chatId];
                active.waiting = true;
                active.action = 'waiting';
                active.updatedAt = Date.now();
                if (typeof step.responseNext === 'undefined') step.responseNext = step.next || null;
                if (typeof step.timeoutNext === 'undefined') step.timeoutNext = null;
                if (active.timeoutId) {
                    clearTimeout(active.timeoutId);
                    active.timeoutId = null;
                }
                emitFlowUsage(sessionId);
                logFlowDebug(sessionId, chatId, flow, stepIndex, 'wait_response_armed', {
                    timeout: step.timeout || 0,
                    timeoutFlowId: step.timeoutFlowId || null,
                    timeoutNext: step.timeoutNext || null,
                    exactMatch: step.exactMatch || ''
                });
                
                // Set timeout if configured
                if (step.timeout && step.timeout > 0) { // timeout in ms
                    active.timeoutId = setTimeout(async () => {
                         // Check if still waiting
                         if (activeFlows[sessionId] && activeFlows[sessionId][chatId] && activeFlows[sessionId][chatId].waiting) {
                             console.log(`Flow ${flow.id} timed out for ${chatId}`);
                             activeFlows[sessionId][chatId].waiting = false;
                             activeFlows[sessionId][chatId].action = null;
                             activeFlows[sessionId][chatId].updatedAt = Date.now();
                             emitFlowUsage(sessionId);
                            
                             // 1. Send Message if configured
                             if (step.timeoutMessage) {
                                 const hasUrl = typeof step.timeoutMessage === 'string' && /https?:\/\/\S+/i.test(step.timeoutMessage);
                                 const options = hasUrl ? { linkPreview: false } : undefined;
                                 const sentMsg = await client.sendMessage(chatId, step.timeoutMessage, options);
                                 await handleSentMessage(sessionId, sentMsg, client);
                             }

                             // 2. Start new flow OR Stop
                            if (step.timeoutNext) {
                                const nextIndex = getFlowStepIndexById(flow, step.timeoutNext);
                                if (nextIndex >= 0) {
                                    setActiveFlowState(sessionId, chatId, flow, { step: nextIndex, waiting: false, action: 'timeout_next', timeoutId: null });
                                    emitFlowUsage(sessionId);
                                    executeFlowStep(sessionId, chatId, flow, nextIndex, client);
                                    return;
                                }
                            }
                             if (step.timeoutFlowId) {
                                 const allFlows = loadFlows(sessionId);
                                 const targetFlow = allFlows.find(f => String(f.id) === String(step.timeoutFlowId));
                                 
                                 if (targetFlow) {
                                     console.log(`Timeout triggering flow ${targetFlow.name} for ${chatId}`);
                                     if (!activeFlows[sessionId]) activeFlows[sessionId] = {};
                                     setActiveFlowState(sessionId, chatId, targetFlow, { step: 0, waiting: false, action: 'timeout_switch' });
                                     recordFlowExecutionHistory(sessionId, {
                                         flowId: targetFlow.id,
                                         flowName: targetFlow.name,
                                         chatId,
                                         status: 'running',
                                         action: 'timeout_switch',
                                         step: 0,
                                         message: 'Fluxo iniciado por timeout'
                                     });
                                     executeFlowStep(sessionId, chatId, targetFlow, 0, client);
                                     emitFlowUsage(sessionId);
                                     return;
                                 }
                             }
                             
                             // Stop flow if no transition
                             delete activeFlows[sessionId][chatId];
                             emitFlowUsage(sessionId);
                         }
                    }, step.timeout);
                }
            }
        }
    } catch (err) {
        console.error(`Error executing flow step ${stepIndex} for chat ${chatId}:`, err);
        recordFlowExecutionHistory(sessionId, {
            flowId: flow && flow.id ? flow.id : null,
            flowName: flow && flow.name ? flow.name : null,
            chatId,
            status: 'error',
            action: 'step_error',
            step: stepIndex,
            message: `Falha na etapa ${step && step.type ? step.type : stepIndex}`,
            error: err && err.message ? err.message : String(err)
        });
        logFlowDebug(sessionId, chatId, flow, stepIndex, 'step_error', {
            error: err && err.message ? err.message : String(err)
        });
        if (activeFlows[sessionId] && activeFlows[sessionId][chatId]) {
            delete activeFlows[sessionId][chatId];
        }
        emitFlowUsage(sessionId);
        try {
            const sessionData = activeClients.get(sessionId);
            if (sessionData && sessionData.socketId) {
                io.to(sessionData.socketId).emit('flow-execution-error', {
                    sessionId,
                    chatId,
                    flowId: flow && flow.id ? flow.id : null,
                    stepIndex,
                    error: err && err.message ? err.message : String(err)
                });
            }
        } catch (e) {}
    }
}

// Armazenamento de clientes ativos
const activeClients = new Map();
const aiDebounceTimers = {}; // { sessionId: { chatId: timeoutId } }
const reconnectState = new Map();
const profilePicHydrationState = new Map();
const getChatsInFlight = new Map();
const readyProbeTimers = new Map();
const evolutionConnectionPollTimers = new Map();
const manualStopSessions = new Set();

function markSessionManuallyStopped(sessionId) {
    const sid = String(sessionId || '').trim();
    if (sid) manualStopSessions.add(sid);
}

function clearSessionManualStop(sessionId) {
    manualStopSessions.delete(String(sessionId || '').trim());
}

function isSessionManuallyStopped(sessionId) {
    return manualStopSessions.has(String(sessionId || '').trim());
}

function clearPersistedConnectionState(sessionId, options = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid) return;
    const sessions = loadSessionsData();
    if (sessions && sessions[sid]) {
        delete sessions[sid];
        saveSessionsData(sessions);
    }
    if (!options.keepUserBinding) {
        return;
    }
    const user = getUserBySessionId(sid);
    if (user) {
        upsertUser({
            ...user,
            whatsappNumber: null,
            whatsappName: null,
            connectedAt: null,
            lastQrAt: null,
            updatedAt: Date.now()
        });
    }
}

function stopReadyProbe(sessionId) {
    const t = readyProbeTimers.get(sessionId);
    if (t) clearInterval(t);
    readyProbeTimers.delete(sessionId);
}

function startReadyProbe(sessionId) {
    stopReadyProbe(sessionId);
    const timer = setInterval(() => {
        try {
            const sessionData = activeClients.get(sessionId);
            if (!sessionData || !sessionData.client) {
                stopReadyProbe(sessionId);
                return;
            }
            if (sessionData.ready === true) {
                stopReadyProbe(sessionId);
                return;
            }
            const info = sessionData.client && sessionData.client.info ? sessionData.client.info : null;
            if (info && info.wid && info.wid.user) {
                sessionData.ready = true;
                sessionData.status = 'connected';
                sessionData.phoneNumber = info.wid.user;
                sessionData.name = info.pushname;
                const user = getUserBySessionId(sessionId);
                if (user) {
        const updatedUser = upsertUser({
                        ...user,
                        connectedAt: Date.now(),
                        whatsappNumber: sessionData.phoneNumber,
                        whatsappName: sessionData.name
                    });
        appendUserHistory(updatedUser, {
            type: 'connect',
            label: 'Conectou',
            number: sessionData.phoneNumber || ''
        });
                }
                emitToSessionClients(sessionId, 'session-status', { sessionId, status: 'connected' });
                io.to('admin').emit('session-status', { sessionId, status: 'connected' });
                emitToSessionClients(sessionId, 'client-ready', {
                    sessionId,
                    phoneNumber: sessionData.phoneNumber,
                    name: sessionData.name
                });
                io.to('admin').emit('client-ready', { sessionId, phoneNumber: sessionData.phoneNumber, name: sessionData.name });
                stopReadyProbe(sessionId);
            }
        } catch (e) {
        }
    }, 1500);
    readyProbeTimers.set(sessionId, timer);
}

function stopEvolutionConnectionPoll(sessionId) {
    const t = evolutionConnectionPollTimers.get(sessionId);
    if (t) clearInterval(t);
    evolutionConnectionPollTimers.delete(sessionId);
}

function startEvolutionConnectionPoll(sessionId) {
    stopEvolutionConnectionPoll(sessionId);
    const timer = setInterval(async () => {
        try {
            if (isSessionManuallyStopped(sessionId)) {
                stopEvolutionConnectionPoll(sessionId);
                return;
            }
            if (!USE_EVOLUTION || !evolutionApi) {
                stopEvolutionConnectionPoll(sessionId);
                return;
            }
            const sessionData = activeClients.get(sessionId);
            if (!sessionData || !sessionData.client) {
                stopEvolutionConnectionPoll(sessionId);
                return;
            }
            if (sessionData.ready === true || sessionData.status === 'connected') {
                stopEvolutionConnectionPoll(sessionId);
                return;
            }
            const state = await evolutionApi.connectionState(evolutionInstanceName(sessionId)).catch(() => null);
            if (state) {
                await syncEvolutionSessionState(sessionId, state, { silent: true });
            }
            const refreshed = activeClients.get(sessionId);
            if (refreshed && refreshed.ready === true) {
                stopEvolutionConnectionPoll(sessionId);
            }
        } catch (e) {}
    }, 2500);
    evolutionConnectionPollTimers.set(sessionId, timer);
}

function scheduleProfilePicHydration(sessionId, sessionData, socket) {
    if (!sessionData || !sessionData.client || !socket) return;

    const now = Date.now();
    const current = profilePicHydrationState.get(sessionId) || { running: false, lastRun: 0 };
    if (current.running) return;
    if (now - (current.lastRun || 0) < 60000) return;

    current.running = true;
    current.lastRun = now;
    profilePicHydrationState.set(sessionId, current);

    (async () => {
        try {
            const cached = loadChatCache(sessionId);
            const chats = Array.isArray(cached) ? cached : [];
            const pending = chats.filter(c => c && c.id && !c.profilePic).map(c => String(c.id)).slice(0, 30);
            if (pending.length === 0) return;

            let changed = false;
            const timeout = (ms) => new Promise(resolve => setTimeout(() => resolve(null), ms));

            for (let i = 0; i < pending.length; i += 2) {
                const batch = pending.slice(i, i + 2);
                await Promise.all(batch.map(async (chatId) => {
                    try {
                        const effectiveChatId = sessionData.client && sessionData.client.__provider === 'evolution'
                            ? await resolveEvolutionSendTarget(sessionId, chatId).catch(() => chatId)
                            : await resolveChatIdForClient(sessionData.client, chatId).catch(() => chatId);
                        let profilePic = null;
                        try {
                            const chatPromise = sessionData.client.getChatById(effectiveChatId);
                            const chat = await Promise.race([chatPromise, timeout(4000)]);
                            if (chat && typeof chat.getProfilePicUrl === 'function') {
                                const picPromise = chat.getProfilePicUrl();
                                profilePic = await Promise.race([picPromise, timeout(5000)]).catch(() => null);
                            }
                        } catch (e) {}

                        if (!profilePic) {
                            profilePic = await safeGetProfilePicUrl(sessionData.client, effectiveChatId);
                        }

                        if (!profilePic) {
                            const contactPromise = sessionData.client.getContactById(effectiveChatId);
                            const contact = await Promise.race([contactPromise, timeout(4000)]);
                            if (!contact) return;

                            const picPromise = contact.getProfilePicUrl();
                            profilePic = await Promise.race([picPromise, timeout(5000)]).catch(() => null);
                        }
                        if (!profilePic) return;

                        const item = chats.find(c => c && String(c.id) === String(chatId));
                        if (item && item.profilePic !== profilePic) {
                            item.profilePic = profilePic;
                            changed = true;
                        }
                        socket.emit('profile-pic-updated', { chatId, profilePic });
                    } catch (e) {
                    }
                }));
                await new Promise(resolve => setTimeout(resolve, 700));
            }

            if (changed) saveChatCache(sessionId, chats);
        } finally {
            const latest = profilePicHydrationState.get(sessionId) || { running: false, lastRun: now };
            latest.running = false;
            profilePicHydrationState.set(sessionId, latest);
        }
    })();
}

function scheduleReconnect(sessionId, reason) {
    if (isSessionManuallyStopped(sessionId)) return;
    const current = reconnectState.get(sessionId) || { attempt: 0, timer: null };
    if (current.timer) return;

    const nextAttempt = current.attempt + 1;
    const baseDelay = 2000;
    const maxDelay = 60000;
    const expDelay = Math.min(maxDelay, baseDelay * Math.pow(2, Math.min(nextAttempt - 1, 5)));
    const jitter = Math.floor(Math.random() * 750);
    const delay = expDelay + jitter;

    const timer = setTimeout(() => {
        const stateNow = reconnectState.get(sessionId);
        if (stateNow) stateNow.timer = null;

        const sessions = loadSessionsData();
        const savedSession = sessions[sessionId] || null;
        console.log(`Reconectando sessão: ${sessionId} (motivo: ${reason || 'desconhecido'}, tentativa: ${nextAttempt})`);
        try {
            initializeClient(sessionId, savedSession);
        } catch (e) {
            console.error(`Erro ao reinicializar sessão ${sessionId}:`, e);
            scheduleReconnect(sessionId, 'erro_reinit');
        }
    }, delay);

    reconnectState.set(sessionId, { attempt: nextAttempt, timer });
}

function clearReconnect(sessionId) {
    const state = reconnectState.get(sessionId);
    if (state && state.timer) clearTimeout(state.timer);
    reconnectState.delete(sessionId);
}

async function processAiMessage(sessionId, chatId, client) {
    try {
        const aiConfig = loadAiConfig();
        const config = aiConfig[sessionId];
        if (!config) return;

        const provider = config.provider ? String(config.provider).toLowerCase() : 'deepseek';
        const deepseekApiKey = config.deepseekApiKey || config.apiKey || '';
        const openaiApiKey = config.openaiApiKey || '';
        const effectiveKey = provider === 'gpt5mini' ? openaiApiKey : deepseekApiKey;
        if (!effectiveKey) return;
        const openAiChatModel = process.env.OPENAI_CHAT_MODEL ? String(process.env.OPENAI_CHAT_MODEL) : 'gpt-4o-mini';

        const chat = await client.getChatById(chatId);
        await chat.sendStateTyping();

        const history = await chat.fetchMessages({ limit: 20 });
        const lastMsg = history[history.length - 1];

        if (lastMsg && lastMsg.fromMe) {
            console.log(`[AI Process] Aborting: Last message in chat ${chatId} is from me.`);
            return;
        }

        const internalInstruction = "\n\nIMPORTANTE: Forneça respostas profissionais, curtas e diretas (idealmente entre 200 a 300 caracteres). É CRUCIAL que sua resposta esteja completa e NÃO seja cortada. Termine sempre a frase e o pensamento. Evite erros.\n\nFORMATAÇÃO: Para palavras em negrito, use APENAS UM asterisco de cada lado (ex: *palavra*), NÃO use dois (**).";

        const aiStatus = loadAiChatStatus();
        const statusObj = aiStatus[sessionId]?.[chatId];
        const aiContext = (statusObj && typeof statusObj === 'object' && statusObj.context) ? String(statusObj.context) : '';
        const aiGoal = (statusObj && typeof statusObj === 'object' && statusObj.goal) ? String(statusObj.goal) : '';

        const mediaTypes = ['image', 'video', 'audio', 'ptt', 'voice', 'sticker', 'document'];
        const lastIsMedia = !!(lastMsg && !lastMsg.fromMe && (lastMsg.hasMedia || mediaTypes.includes(lastMsg.type)));

        let systemPrompt = (config.prompt || "Você é um assistente útil.") + internalInstruction;
        if (aiContext) {
            systemPrompt += "\n\nCONTEXTO ADICIONAL (WINBACK/HISTÓRICO):\n" + aiContext;
        }
        if (aiGoal) {
            systemPrompt += "\n\nOBJETIVO DA CONVERSA (LINK/AÇÃO):\n" + aiGoal;
        }

        async function transcribeOpenAiAudio(media) {
            const FormData = require('form-data');
            const form = new FormData();
            const buf = Buffer.from(media.data, 'base64');
            const filename = media.filename || 'audio.ogg';
            form.append('file', buf, { filename, contentType: media.mimetype || 'audio/ogg' });
            form.append('model', 'whisper-1');
            form.append('response_format', 'json');

            const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
                headers: {
                    ...form.getHeaders(),
                    'Authorization': `Bearer ${openaiApiKey}`
                },
                maxBodyLength: Infinity
            });
            const text = resp && resp.data && (resp.data.text || resp.data.transcript) ? String(resp.data.text || resp.data.transcript) : '';
            return text.trim();
        }

        async function saveTranscriptForMessage(messageId, transcript) {
            if (!messageId || !transcript) return;
            const store = loadAiTranscripts();
            if (!store[sessionId]) store[sessionId] = {};
            store[sessionId][messageId] = { chatId, transcript: String(transcript), createdAt: Date.now() };
            saveAiTranscripts(store);
        }

        let reply = '';

        if (provider === 'gpt5mini') {
            if (lastIsMedia && lastMsg && (lastMsg.type === 'video')) {
                const sentMsg = await chat.sendMessage("Consigo reconhecer texto, áudio e imagem, mas não vídeo. Pode enviar uma imagem ou descrever em texto?");
                await handleSentMessage(sessionId, sentMsg, client);
                await chat.clearState();
                return;
            }

            let lastUserContent = null;
            let lastMedia = null;
            let transcript = '';

            if (lastIsMedia && lastMsg && (lastMsg.type === 'audio' || lastMsg.type === 'ptt' || lastMsg.type === 'voice')) {
                try {
                    lastMedia = await lastMsg.downloadMedia();
                } catch (e) {}
                if (!lastMedia || !lastMedia.data) {
                    const sentMsg = await chat.sendMessage("Não consegui baixar seu áudio agora. Pode tentar reenviar ou digitar?");
                    await handleSentMessage(sessionId, sentMsg, client);
                    await chat.clearState();
                    return;
                }
                transcript = await transcribeOpenAiAudio(lastMedia);
                if (!transcript) {
                    const sentMsg = await chat.sendMessage("Não consegui transcrever o áudio. Pode tentar reenviar ou digitar?");
                    await handleSentMessage(sessionId, sentMsg, client);
                    await chat.clearState();
                    return;
                }
                await saveTranscriptForMessage(lastMsg.id && lastMsg.id._serialized ? String(lastMsg.id._serialized) : '', transcript);
                lastUserContent = transcript;
            } else if (lastIsMedia && lastMsg && lastMsg.type === 'image') {
                try {
                    lastMedia = await lastMsg.downloadMedia();
                } catch (e) {}
                if (!lastMedia || !lastMedia.data || !lastMedia.mimetype) {
                    const sentMsg = await chat.sendMessage("Não consegui baixar a imagem agora. Pode tentar reenviar?");
                    await handleSentMessage(sessionId, sentMsg, client);
                    await chat.clearState();
                    return;
                }
                const caption = lastMsg.body ? String(lastMsg.body) : '';
                lastUserContent = [
                    { type: 'text', text: caption || 'Analise a imagem e responda.' },
                    { type: 'image_url', image_url: { url: `data:${lastMedia.mimetype};base64,${lastMedia.data}` } }
                ];
            } else if (lastIsMedia) {
                const sentMsg = await chat.sendMessage("Consigo reconhecer texto, áudio e imagem. Se puder, envie em texto ou mande áudio/imagem.");
                await handleSentMessage(sessionId, sentMsg, client);
                await chat.clearState();
                return;
            }

            // Internal prompt to confirm audio/image capabilities for GPT as requested
            const capabilityInstruction = "\n\nCAPACIDADES DE MÍDIA:\nVocê consegue 'ouvir' áudios (recebendo a transcrição) e 'ver' imagens (recebendo a análise visual). Se perguntarem, confirme que consegue ver imagens e ouvir áudios. Você tem acesso ao histórico completo incluindo mídias.";
            const messages = [{ role: "system", content: systemPrompt + capabilityInstruction }];
            for (const msg of history) {
                if (!msg) continue;
                if (!msg.body && !msg.hasMedia) continue;
                const role = msg.fromMe ? "assistant" : "user";

                if (lastMsg && msg.id && lastMsg.id && msg.id._serialized === lastMsg.id._serialized && !msg.fromMe) {
                    if (lastUserContent) {
                        messages.push({ role: "user", content: lastUserContent });
                        continue;
                    }
                }

                let content = msg.body;
                if (msg.hasMedia || mediaTypes.includes(msg.type)) {
                    content = "[Mídia recebida]";
                }
                messages.push({ role, content });
            }

            const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: openAiChatModel,
                messages,
                temperature: 0.7,
                max_tokens: 320
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openaiApiKey}`
                },
                maxBodyLength: Infinity
            });

            reply = response && response.data && response.data.choices && response.data.choices[0] && response.data.choices[0].message && response.data.choices[0].message.content
                ? String(response.data.choices[0].message.content)
                : '';
        } else {
            if (lastIsMedia) {
                try { await lastMsg.react('❌'); } catch (e) {}
                const sentMsg = await chat.sendMessage("DeepSeek não reconhece áudio/imagem/vídeo. Se puder digitar em texto, fica perfeito para eu responder.");
                await handleSentMessage(sessionId, sentMsg, client);
                await chat.clearState();
                return;
            }

            const messages = [{ role: "system", content: systemPrompt }];
            for (const msg of history) {
                if (!msg.body && !msg.hasMedia) continue;
                const role = msg.fromMe ? "assistant" : "user";
                let content = msg.body;
                if (msg.hasMedia) content = "[Mídia enviada - Ignorar conteúdo visual/áudio]";
                messages.push({ role, content });
            }

            const response = await axios.post('https://api.deepseek.com/chat/completions', {
                model: "deepseek-chat",
                messages: messages,
                temperature: 0.7
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${deepseekApiKey}`
                }
            });

            reply = response.data.choices[0].message.content;
        }

        reply = String(reply || '').trim();
        if (!reply) {
            await chat.clearState();
            return;
        }

        const typingDelay = Math.floor(Math.random() * (20000 - 13000 + 1) + 13000);
        await chat.sendStateTyping();
        await new Promise(resolve => setTimeout(resolve, typingDelay));

        const sentMsg = await client.sendMessage(chatId, reply);
        await handleSentMessage(sessionId, sentMsg, client);

        await chat.clearState();

    } catch (error) {
        const status = error && error.response && error.response.status ? error.response.status : null;
        const data = error && error.response && error.response.data !== undefined ? error.response.data : null;
        if (status) {
            let payload = '';
            try { payload = typeof data === 'string' ? data : JSON.stringify(data); } catch (e) { payload = String(data); }
            if (payload && payload.length > 3000) payload = payload.slice(0, 3000);
            console.error(`Error processing AI message for ${chatId}:`, `HTTP ${status}`, payload);
        } else {
            console.error(`Error processing AI message for ${chatId}:`, error && error.message ? error.message : error);
        }
        // Optional: Send error message to user? No, better silent fail or log.
    }
}

// Função para gerar ID único
function generateSessionId() {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Função para inicializar cliente
async function initializeClient(sessionId, savedSession = null, retryCount = 0) {
    console.log(`Inicializando sessão: ${sessionId} (Tentativa ${retryCount})`);
    clearSessionManualStop(sessionId);
    const shouldUseConfiguredProxy = String(sessionId) !== ADMIN_SELF_SESSION_ID;
    const proxyUser = shouldUseConfiguredProxy ? getUserBySessionId(sessionId) : null;
    const proxyLabel = proxyUser
        ? [proxyUser.name, proxyUser.email, sessionId].filter(Boolean).join(' | ')
        : sessionId;

    if (USE_EVOLUTION) {
        if (!evolutionApi || !evolutionApi.isConfigured()) {
            console.error('Evolution API não configurada. Defina EVOLUTION_API_URL e EVOLUTION_API_KEY.');
            return;
        }

        const existing = activeClients.get(sessionId);
        const existingSocketId = existing ? existing.socketId : null;
        const client = createEvolutionClientWrapper(sessionId);

        activeClients.set(sessionId, {
            client,
            socketId: existingSocketId,
            status: savedSession ? 'authenticated' : 'initializing',
            ready: false,
            phoneNumber: savedSession ? savedSession.phoneNumber : null,
            name: savedSession ? savedSession.name : null,
            latestQr: existing ? existing.latestQr : null
        });
        startReadyProbe(sessionId);

        try {
            const webhookConfig = buildEvolutionWebhookConfig();
            let proxyConfig = null;
            if (shouldUseConfiguredProxy) {
                try {
                    proxyConfig = proxyManager.getAssignment(sessionId, proxyLabel);
                } catch (e) {
                    console.error(`Falha ao atribuir proxy para ${sessionId}:`, e.message);
                }
            }
            const known = await evolutionApi.getInstance(evolutionInstanceName(sessionId)).catch(() => null);
            if (webhookConfig && known) {
                await evolutionApi.setWebhook(evolutionInstanceName(sessionId), webhookConfig).catch(() => null);
            }

            let createResponse = null;
            if (!known) {
                createResponse = await evolutionApi.createInstance(evolutionInstanceName(sessionId), webhookConfig, {
                    qrcode: true,
                    syncFullHistory: true,
                    groupsIgnore: false,
                    ...(proxyConfig ? {
                        proxy: {
                            host: proxyConfig.host,
                            port: proxyConfig.port,
                            username: proxyConfig.username,
                            password: proxyConfig.password
                        }
                    } : {})
                });
            }

            if (known) {
                if (proxyConfig) {
                    await evolutionApi.setInstanceProxy(evolutionInstanceName(sessionId), proxyConfig).catch(() => null);
                } else if (shouldUseConfiguredProxy) {
                    await evolutionApi.removeInstanceProxy(evolutionInstanceName(sessionId)).catch(() => null);
                }
            }

            let stateResponse = await evolutionApi.connectionState(evolutionInstanceName(sessionId)).catch(() => null);
            let normalized = stateResponse ? evolutionApi.normalizeInstanceState(stateResponse) : { state: 'close' };

            let connectResponse = null;
            if (!stateResponse || normalized.state !== 'open') {
                connectResponse = await evolutionApi.connectInstance(evolutionInstanceName(sessionId)).catch(() => null);
                if (connectResponse) {
                    await syncEvolutionSessionState(sessionId, connectResponse, { silent: true });
                }
            } else {
                await syncEvolutionSessionState(sessionId, stateResponse, { silent: true });
            }

            const qrPayload = evolutionApi.normalizeQr(connectResponse || createResponse || {});
            if (qrPayload.base64) {
                const sessionData = activeClients.get(sessionId);
                if (sessionData) {
                    sessionData.latestQr = qrPayload.base64.startsWith('data:')
                        ? qrPayload.base64
                        : `data:image/png;base64,${qrPayload.base64}`;
                    if (sessionData.socketId) {
                        io.to(sessionData.socketId).emit('qr-generated', {
                            sessionId,
                            qr: sessionData.latestQr
                        });
                    }
                }
            }
            startEvolutionConnectionPoll(sessionId);
            return;
        } catch (error) {
            console.error(`Erro ao inicializar sessão Evolution ${sessionId}:`, error && error.message ? error.message : error);
            const sessionData = activeClients.get(sessionId);
            if (sessionData) {
                sessionData.status = 'auth_failed';
                sessionData.ready = false;
            }
            return;
        }
    }
    
    // Proxy Assignment
    let proxyConfig = null;
    try {
        if (shouldUseConfiguredProxy) {
            proxyConfig = proxyManager.getAssignment(sessionId, proxyLabel);
        }
    } catch (e) {
        console.error(`Falha ao atribuir proxy para ${sessionId}:`, e.message);
        io.to('admin').emit('system-error', { message: e.message });
        return; 
    }

    if (proxyConfig) {
        console.log(`Proxy atribuído para ${sessionId}: ${proxyConfig.proxySessionId} (${proxyConfig.isNew ? 'Novo' : 'Existente'})`);
    } else {
        console.log(`Sessão ${sessionId} iniciando sem proxy configurado.`);
    }
    io.emit('system-stats-update', proxyManager.getStats());

    // Configuração do cliente
    const clientOptions = {
        authStrategy: new LocalAuth({
            clientId: sessionId
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
        }
    };
    if (proxyConfig) {
        clientOptions.proxyAuthentication = {
            username: proxyConfig.username,
            password: proxyConfig.password
        };
        clientOptions.puppeteer.args.unshift(`--proxy-server=${proxyConfig.proxyUrl}`);
    }
    const client = new Client(clientOptions);

    const existing = activeClients.get(sessionId);
    const existingSocketId = existing ? existing.socketId : null;

    if (client.authStrategy && typeof client.authStrategy.logout === 'function') {
        const originalLogout = client.authStrategy.logout.bind(client.authStrategy);
        client.authStrategy.logout = async () => {
            try {
                return await originalLogout();
            } catch (e) {
                if (shouldIgnoreFatalError(e)) return;
                throw e;
            }
        };
    }

    // Armazenar cliente
    activeClients.set(sessionId, {
        client: client,
        socketId: existingSocketId,
        status: savedSession ? 'authenticated' : 'initializing',
        ready: false,
        phoneNumber: savedSession ? savedSession.phoneNumber : null,
        name: savedSession ? savedSession.name : null
    });
    startReadyProbe(sessionId);

    // Eventos do cliente
    client.on('qr', async (qr) => {
        console.log(`QR gerado para sessão: ${sessionId}`);
        
        // Converter QR para base64
        const qrImage = await qrcode.toDataURL(qr);
        
        const user = getUserBySessionId(sessionId);
        if (user) upsertUser({ ...user, lastQrAt: Date.now() });

        // Enviar QR para frontend
        const sessionData = activeClients.get(sessionId);
        if (sessionData && sessionData.socketId) {
            io.to(sessionData.socketId).emit('qr-generated', {
                sessionId,
                qr: qrImage
            });
        }
        io.to('admin').emit('qr-generated', { sessionId });
    });

    client.on('ready', () => {
        console.log(`Cliente pronto para sessão: ${sessionId}`);
        const sessionData = activeClients.get(sessionId);
        
        if (sessionData) {
            clearReconnect(sessionId);
            sessionData.status = 'connected';
            sessionData.ready = true;
            stopReadyProbe(sessionId);
            sessionData.phoneNumber = client.info.wid.user;
            sessionData.name = client.info.pushname;
            
            // Persist session
            const sessions = loadSessionsData();
            sessions[sessionId] = {
                phoneNumber: sessionData.phoneNumber,
                name: sessionData.name,
                createdAt: Date.now()
            };
            saveSessionsData(sessions);

            const user = getUserBySessionId(sessionId);
            if (user) {
                upsertUser({
                    ...user,
                    connectedAt: Date.now(),
                    whatsappNumber: sessionData.phoneNumber,
                    whatsappName: sessionData.name
                });
            }
            
            // Enviar status para frontend
            emitToSessionClients(sessionId, 'session-status', { sessionId, status: 'connected' });
            io.to('admin').emit('session-status', { sessionId, status: 'connected' });
            
            emitToSessionClients(sessionId, 'client-ready', {
                sessionId,
                phoneNumber: sessionData.phoneNumber,
                name: sessionData.name
            });
            io.to('admin').emit('client-ready', { sessionId, phoneNumber: sessionData.phoneNumber, name: sessionData.name });
        }
    });

    client.on('message_ack', (msg, ack) => {
        const sessionData = activeClients.get(sessionId);
        if (sessionData && sessionData.socketId) {
             // Update history with new ack status
             try {
                 const chatId = msg.id.remote;
                 const file = getHistoryFilePath(sessionId, chatId);
                 if (fs.existsSync(file)) {
                     const raw = fs.readFileSync(file, 'utf8');
                     let history = JSON.parse(raw);
                     if (Array.isArray(history)) {
                         const idx = history.findIndex(m => m.id === msg.id._serialized);
                         if (idx >= 0) {
                             history[idx].ack = ack;
                             fs.writeFileSync(file, JSON.stringify(history, null, 2));
                         }
                     }
                 }
             } catch (e) {
                 console.error('Error updating ack in history:', e);
             }

             io.to(sessionData.socketId).emit('message-ack', {
                 sessionId,
                 msgId: msg.id._serialized,
                 chatId: msg.id.remote,
                 ack
             });
        }
    });

    client.on('message_create', async (msg) => {
        const sessionData = activeClients.get(sessionId);
        if (sessionData && sessionData.socketId) {
            try {
                // --- FLOW TRIGGER CHECK ---
                if (!msg.fromMe) { // Only trigger on incoming messages
                    
                    // Check if there is an ACTIVE flow waiting for response
                    if (activeFlows[sessionId] && activeFlows[sessionId][msg.from]) {
                        const active = activeFlows[sessionId][msg.from];
                        // If waiting for response, clear timeout and proceed
                        if (active.waiting) {
                            if (active.timeoutId) clearTimeout(active.timeoutId);
                            active.waiting = false;
                            active.timeoutId = null;
                            active.action = null;
                            
                            // --- NEW: Exact Match Logic ---
                            const currentFlows = loadFlows(sessionId);
                            const currentFlowObj = currentFlows.find(f => String(f.id) === String(active.flowId));
                            
                            if (currentFlowObj && currentFlowObj.steps && currentFlowObj.steps[active.step]) {
                                const step = currentFlowObj.steps[active.step];
                                if (typeof step.responseNext === 'undefined') step.responseNext = step.next || null;
                                
                                // Check for Exact Match Trigger
                                if (step.exactMatch && msg.body && msg.body.trim().toLowerCase() === step.exactMatch.trim().toLowerCase()) {
                                    console.log(`Exact match triggered for flow ${active.flowId}`);
                                    
                                    if (step.exactMatchFlowId) {
                                        const targetFlow = currentFlows.find(f => String(f.id) === String(step.exactMatchFlowId));
                                        if (targetFlow) {
                                            console.log(`Switching to flow ${targetFlow.name}`);
                                            setActiveFlowState(sessionId, msg.from, targetFlow, { step: 0, waiting: false, action: 'switch_exact_match' });
                                            recordFlowExecutionHistory(sessionId, {
                                                flowId: targetFlow.id,
                                                flowName: targetFlow.name,
                                                chatId: msg.from,
                                                status: 'running',
                                                action: 'switch_exact_match',
                                                step: 0,
                                                message: 'Fluxo iniciado por resposta exata'
                                            });
                                            executeFlowStep(sessionId, msg.from, targetFlow, 0, client);
                                            emitFlowUsage(sessionId);
                                            return;
                                        }
                                    }
                                }
                            }
                            // -----------------------------

                            active.updatedAt = Date.now();
                            console.log(`Received response for flow ${active.flowId}, proceeding...`);
                            
                            // Load flow to continue
                            const flows = loadFlows(sessionId);
                            const flow = flows.find(f => String(f.id) === String(active.flowId));
                            if (flow) {
                                const currentStep = flow.steps && flow.steps[active.step] ? flow.steps[active.step] : null;
                                const responseNext = currentStep && (currentStep.responseNext || currentStep.next);
                                const nextIndex = responseNext ? getFlowStepIndexById(flow, responseNext) : -1;
                                executeFlowStep(sessionId, msg.from, flow, nextIndex >= 0 ? nextIndex : active.step + 1, client);
                            }
                            emitFlowUsage(sessionId);
                            return; // Stop processing triggers if we resumed a flow
                        }
                    }

                    const flows = loadFlows(sessionId);
                    const incomingText = msg.body.toLowerCase().trim();
                    for (const flow of flows) {
                             let triggered = false;
                             
                             // Keyword Trigger
                             if (flow.triggerType === 'keyword' || !flow.triggerType) {
                                 if (flow.trigger && flow.trigger.toLowerCase() === incomingText) {
                                     triggered = true;
                                 }
                             }
                             
                             // First Message Trigger
                             else if (flow.triggerType === 'first_message') {
                                 // Check if this is likely a first message
                                 try {
                                    const chat = await msg.getChat();
                                    const messages = await chat.fetchMessages({ limit: 5 });
                                    // Filter out system messages if needed, but simple count works
                                    if (messages.length <= 1) {
                                        triggered = true;
                                    }
                                 } catch(e) {
                                     console.error("Error checking first message:", e);
                                 }
                             }
                            
                             if (triggered) {
                                 console.log(`Starting flow ${flow.name} for ${msg.from}`);
                                 setActiveFlowState(sessionId, msg.from, flow, { step: 0, waiting: false, action: 'triggered' });
                                 recordFlowExecutionHistory(sessionId, {
                                     flowId: flow.id,
                                     flowName: flow.name,
                                     chatId: msg.from,
                                     status: 'running',
                                     action: 'triggered',
                                     step: 0,
                                     message: `Fluxo iniciado por gatilho ${flow.triggerType || 'keyword'}`
                                 });
                                 emitFlowUsage(sessionId);
                                 executeFlowStep(sessionId, msg.from, flow, 0, client);
                                 break; 
                             }
                    }

                    // --- AI AGENT CHECK ---
                    if (!activeFlows[sessionId]?.[msg.from]) {
                        const aiConfig = loadAiConfig();
                        const config = aiConfig[sessionId];
                        
                        // DEBUG LOG
                        // console.log(`[AI Check] Session: ${sessionId}, Chat: ${msg.from}, Config Found: ${!!config}, Enabled: ${config?.enabled}, HasKey: ${!!config?.apiKey}`);
    
                        const provider = config && config.provider ? String(config.provider) : 'deepseek';
                        const hasKey = provider === 'gpt5mini'
                            ? !!(config && config.openaiApiKey)
                            : !!(config && (config.deepseekApiKey || config.apiKey));

                        if (config && config.enabled && hasKey) {
                            const fromId = String(msg.from || '');
                            const isGroupChat = fromId.endsWith('@g.us');
                            const allowGroups = !!config.respondInGroups;
                            if (isGroupChat && !allowGroups) {
                            } else {
                                const chatStatus = getChatAiActive(sessionId, msg.from, true);
                                const isAiActive = !!chatStatus;
                        
                            // DEBUG LOG
                            // console.log(`[AI Check] Chat Status: ${chatStatus}, Is Active: ${isAiActive}`);

                            // WinBack Response Tracking
                            const aiStatus = loadAiChatStatus();
                            const statusObj = aiStatus[sessionId]?.[msg.from];
                            if (statusObj && typeof statusObj === 'object' && statusObj.winbackCampaignId) {
                                const campaignId = statusObj.winbackCampaignId;
                                const wbStats = loadWinbackStats();
                                if (wbStats[sessionId] && wbStats[sessionId].campaigns && wbStats[sessionId].campaigns[campaignId]) {
                                    // Increment 'responded' count
                                    // Use a set to track unique responders if needed, but for now simple count or check if already responded?
                                    // Simple count for now. Ideally we should track *who* responded to avoid double counting.
                                    
                                    if (!wbStats[sessionId].campaigns[campaignId].responders) {
                                        wbStats[sessionId].campaigns[campaignId].responders = [];
                                    }
                                    
                                    const responders = wbStats[sessionId].campaigns[campaignId].responders;
                                    if (!responders.includes(msg.from)) {
                                        responders.push(msg.from);
                                        wbStats[sessionId].campaigns[campaignId].responded = responders.length;
                                        saveWinbackStats(wbStats);
                                        // Notify frontend
                                        io.to(`session:${sessionId}`).emit('winback-stats-update', wbStats[sessionId]);
                                    }
                                }
                            }

                            if (isAiActive) {
                                    let shouldRun = false;
                                    if (config.triggerMode === 'keyword') {
                                        const keyword = (config.keyword || '').trim();
                                        if (keyword.length > 0 && msg.body && msg.body.toLowerCase().includes(keyword.toLowerCase())) {
                                            shouldRun = true;
                                            const aiStatus = loadAiChatStatus();
                                            if (!aiStatus[sessionId]) aiStatus[sessionId] = {};
                                            if (aiStatus[sessionId][msg.from] === undefined) {
                                                aiStatus[sessionId][msg.from] = true;
                                                saveAiChatStatus(aiStatus);
                                            }
                                            io.to(sessionData.socketId).emit('ai-chat-status-updated', { chatId: msg.from, active: true });
                                        }
                                    } else {
                                        shouldRun = true;
                                        // If running in 'all' mode and status is implicit (undefined), make it explicit in UI (optional)
                                        // But crucially, emit event if it's the first time so UI pulses
                                        const aiStatus = loadAiChatStatus();
                                        const explicit = aiStatus[sessionId]?.[msg.from];
                                        if (explicit === undefined) {
                                             io.to(sessionData.socketId).emit('ai-chat-status-updated', { chatId: msg.from, active: true });
                                        }
                                    }
                                
                                    if (shouldRun) {
                                        if (!aiDebounceTimers[sessionId]) aiDebounceTimers[sessionId] = {};
                                        if (aiDebounceTimers[sessionId][msg.from]) {
                                            clearTimeout(aiDebounceTimers[sessionId][msg.from]);
                                            console.log(`[AI Debounce] Reset timer for ${msg.from}`);
                                        }
                                        
                                        console.log(`[AI Debounce] Starting 12s timer for ${msg.from}`);
                                        // Debounce de 12 segundos para aguardar o cliente terminar de digitar/enviar múltiplas mensagens
                                        aiDebounceTimers[sessionId][msg.from] = setTimeout(() => {
                                            console.log(`[AI Process] Executing AI for ${msg.from}`);
                                            processAiMessage(sessionId, msg.from, client);
                                            delete aiDebounceTimers[sessionId][msg.from];
                                        }, 12000); 
                                    } else {
                                        // console.log(`[AI Check] Skipped: Keyword mismatch`);
                                    }
                                } else {
                                    console.log(`[AI Check] Skipped: AI disabled for this chat`);
                                }
                            }
                        } else {
                            // console.log(`[AI Check] Skipped: Global config disabled or missing key`);
                        }
                    }
                }

                const chat = await msg.getChat();
                let contact;
                let profilePic = null;

                try {
                    contact = await chat.getContact();
                    profilePic = await contact.getProfilePicUrl().catch(() => null);
                } catch (e) {
                     contact = { pushname: null, number: null };
                }
                
                let mediaData = null;
                if (msg.hasMedia) {
                    try {
                        const media = await msg.downloadMedia();
                        if (media) {
                            mediaData = {
                                mimetype: media.mimetype,
                                data: media.data,
                                filename: media.filename
                            };
                        }
                    } catch (e) {
                        console.error('Error downloading media for new message:', e);
                    }
                }
                
                const messagePayload = {
                    id: msg.id._serialized,
                    body: msg.body,
                    from: msg.from,
                    to: msg.to,
                    chatId: msg.id.remote,
                    timestamp: msg.timestamp,
                    fromMe: msg.fromMe,
                    type: msg.type,
                    hasMedia: msg.hasMedia,
                    ack: msg.ack,
                    media: mediaData
                };
                saveMessageToHistory(sessionId, msg.id.remote, messagePayload);

                emitToSessionClients(sessionId, 'new-message', {
                    sessionId,
                    message: messagePayload,
                    chat: {
                        id: chat.id._serialized,
                        name: chat.name || contact.pushname || contact.number,
                        unreadCount: chat.unreadCount,
                        timestamp: chat.timestamp,
                        lastMessage: msg.body, // Ensure last message is updated
                        profilePic: profilePic
                    }
                });
            } catch (error) {
                console.error('Error handling new message:', error);
            }
        }
    });

    client.on('authenticated', () => {
        console.log(`Autenticado: ${sessionId}`);
        const sessionData = activeClients.get(sessionId);
        if (sessionData) {
            sessionData.status = 'authenticated';
            if (sessionData.ready !== true) sessionData.ready = false;
            if (sessionData.socketId) io.to(sessionData.socketId).emit('session-status', { sessionId, status: 'authenticated' });
            io.to('admin').emit('session-status', { sessionId, status: 'authenticated' });
        }
    });

    client.on('auth_failure', (msg) => {
        console.log(`Falha na autenticação: ${sessionId}`, msg);
        const sessionData = activeClients.get(sessionId);
        const user = getUserBySessionId(sessionId);
        if (sessionData) {
            sessionData.status = 'auth_failed';
            sessionData.ready = false;
            stopReadyProbe(sessionId);

            if (sessionData.socketId) {
                io.to(sessionData.socketId).emit('auth-failed', {
                    sessionId,
                    error: msg
                });
            }

            io.to('admin').emit('auth-failed', { sessionId });
            if (sessionData.socketId) io.to(sessionData.socketId).emit('session-status', { sessionId, status: 'auth_failed' });
            io.to('admin').emit('session-status', { sessionId, status: 'auth_failed' });
        }
        if (user) {
            appendUserHistory(user, {
                type: 'auth_failed',
                label: 'Falha de autenticação',
                number: user.whatsappNumber || (sessionData && sessionData.phoneNumber) || ''
            });
        }

        scheduleReconnect(sessionId, 'auth_failure');
    });

    client.on('disconnected', (reason) => {
        console.log(`Cliente desconectado: ${sessionId}`, reason);
        const user = getUserBySessionId(sessionId);
        if (isSessionManuallyStopped(sessionId)) {
            const sessionData = activeClients.get(sessionId);
            if (sessionData) {
                sessionData.status = 'disconnected';
                sessionData.ready = false;
                sessionData.client = null;
                stopReadyProbe(sessionId);
                stopEvolutionConnectionPoll(sessionId);
                emitToSessionClients(sessionId, 'session-status', { sessionId, status: 'disconnected' });
                io.to('admin').emit('session-status', { sessionId, status: 'disconnected' });
            }
            return;
        }
        const sessionData = activeClients.get(sessionId);
        if (sessionData) {
            sessionData.status = 'reconnecting';
            sessionData.ready = false;
            sessionData.client = null;
            stopReadyProbe(sessionId);
            if (sessionData.socketId) io.to(sessionData.socketId).emit('session-status', { sessionId, status: 'reconnecting' });
            io.to('admin').emit('session-status', { sessionId, status: 'reconnecting' });
        }
        if (user) {
            appendUserHistory(user, {
                type: 'disconnect',
                label: 'Desconectou',
                number: user.whatsappNumber || (sessionData && sessionData.phoneNumber) || ''
            });
        }

        scheduleReconnect(sessionId, reason || 'disconnected');
    });

    // Inicializar cliente
    try {
        await client.initialize();
    } catch (e) {
        console.error(`Erro ao inicializar cliente ${sessionId}:`, e);
        if (retryCount < 2) {
             console.log(`Tentando reconectar ${sessionId} com o mesmo proxy atribuido (Tentativa ${retryCount + 1})...`);
             // Clear partial state if needed? activeClients is overwritten on next call.
             setTimeout(() => initializeClient(sessionId, savedSession, retryCount + 1), 2000);
        } else {
             io.to('admin').emit('system-error', { message: `Falha crítica ao conectar ${sessionId} após ${retryCount} tentativas.` });
        }
    }
}

// Restore sessions on startup
(function restoreSessions() {
    const sessions = loadSessionsData();
    Object.keys(sessions).forEach(sessionId => {
        if (String(sessionId) === ADMIN_SELF_SESSION_ID) return;
        console.log(`Restaurando sessão: ${sessionId}`);
        initializeClient(sessionId, sessions[sessionId]);
    });
})();

// Rota principal
app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get(['/politica', '/politica-de-privacidade', '/privacy', '/privacy-policy'], (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'politica.html'));
});

app.get(
    ['/termosdoservico', '/termosdoserviço', '/termosdosevico', '/termosdoseviço', '/termos-de-servico', '/terms', '/terms-of-service'],
    (req, res) => {
        res.sendFile(path.join(PUBLIC_DIR, 'termos.html'));
    }
);

app.get('/auth/google/callback', async (req, res) => {
    try {
        // Detect if we are on the wrong domain (app.zapmro.com) and need to redirect to tunnel/localhost
        // This is a client-side redirect fix because Google sends user to the configured redirect_uri
        const host = req.get('host');
        // If we are on app.zapmro.com (or .br) but the user started from a tunnel (state cookie/param mismatch is hard to check here without session, 
        // but we can infer from the Referer or just assume if the user is here but the server is running locally/tunnel).
        
        // However, a better approach is: if the code/state are present, process them. 
        // If the processing is successful, redirect to the CRM.
        
        // THE ISSUE: The user is redirected to https://app.zapmro.com/... by Google.
        // But the server (YOU) are running on localhost/tunnel.
        // If app.zapmro.com does NOT point to your tunnel, this request never reaches THIS code.
        // It reaches the real app.zapmro.com server (if it exists) or fails (NXDOMAIN).
        
        // If you are seeing this code running, it means the request REACHED here.
        // If the user says "DNS_PROBE_FINISHED_NXDOMAIN" for app.zapmro.com, it means 
        // app.zapmro.com DOES NOT EXIST or is not reachable from their machine.
        
        // Since you cannot change where Google redirects (it MUST be the registered URI),
        // and you cannot change DNS for the world to point app.zapmro.com to your tunnel,
        // YOU ARE STUCK unless you add the tunnel URI to Google Console.
        
        // BUT, if the user says "depois de logar... ele abre esse link... voltando para minha pagina ali porem nao abre",
        // it confirms the browser is trying to go to app.zapmro.com.
        
        // WORKAROUND:
        // You MUST register the tunnel URI in Google Console. There is no code fix for "Google redirects to X, but X does not exist".
        // EXCEPT: If you can edit the 'hosts' file on the user machine to point app.zapmro.com to 127.0.0.1 (if using tunnel locally).
        
        // WAIT, if the user is running this LOCALLY and wants to test:
        // They must add the tunnel URL to Google Console.
        
        // IF that is impossible, we can try a trick:
        // Use a "manual" copy-paste flow? No, UX is bad.
        
        // LET'S ASSUME the user wants us to fix what we CAN fix.
        // If the request actually hits this server (e.g. they fixed DNS or are running on the domain),
        // we process it.
        
        // If the user is getting NXDOMAIN, the request NEVER hits this server.
        // So I cannot redirect them FROM here if they never GET here.
        
        // The ONLY solution if they can't touch Google Console is:
        // 1. Tell them to add the tunnel URL to Google Console.
        // 2. OR, use a domain they control.
        
        // HOWEVER, maybe they have the domain but it's not propagated?
        // User said: "veja se estamos liberando isso no tunnel"
        
        // If they want the tunnel to handle 'app.zapmro.com', they need to configure Cloudflared to route that hostname.
        // BUT they likely don't own the domain or can't change DNS.
        
        // Let's look at the previous success: "antes nao tava dando erro".
        // Maybe they were using a different redirect_uri before?
        // They pasted: redirect_uri=https://app.zapmro.com.br/auth/google/callback
        // And now: redirect_uri=https://app.zapmro.com/auth/google/callback (without .br)
        
        // If "app.zapmro.com" (no .br) is WRONG and does not exist, that's the problem.
        // The user said "Redirect: https://app.zapmro.com/auth/google/callback" in the input.
        // Is it possible they MEANT .com.br?
        
        // Let's revert to .com.br if that is the valid one that resolves.
        // The user explicitly typed ".com" in the last message, but the error screenshot showed ".com.br" initially.
        // Let's try to support BOTH or revert to the one that works.
        
        // If I change the .env back to .com.br, Google might reject it if the user registered .com.
        // But if .com returns NXDOMAIN, it surely isn't working.
        
        const code = String(req.query && req.query.code ? req.query.code : '').trim();
        const state = String(req.query && req.query.state ? req.query.state : '').trim();
        if (!code || !state) {
            res.redirect('/crm.html?view=contacts&google=error');
            return;
        }

        const st = googleOAuthStates.get(state);
        googleOAuthStates.delete(state);
        
        // If state is missing, it might be because the user is coming from a different domain/session
        // leading to a lost in-memory state if the server restarted or it's a different process.
        // But here we just fail.
        if (!st || !st.userId) {
            console.error('Google Callback: State not found or expired', state);
            res.redirect('/crm.html?view=contacts&google=error');
            return;
        }
        
        const user = getUserById(st.userId);
        if (!user) {
            res.redirect('/crm.html?view=contacts&google=error');
            return;
        }

        const tokenData = await exchangeGoogleCodeForTokens(code);
        const accessToken = String(tokenData.access_token || '').trim();
        const refreshToken = String(tokenData.refresh_token || '').trim();
        const expiresIn = Number(tokenData.expires_in || 0) || 0;
        const accessTokenExpiresAt = Date.now() + Math.max(0, expiresIn) * 1000;
        const email = await fetchGoogleUserEmail(accessToken).catch(() => '');

        upsertUser({
            ...user,
            google: {
                connectedAt: user.google && user.google.connectedAt ? user.google.connectedAt : Date.now(),
                email: email || (user.google && user.google.email ? user.google.email : ''),
                refreshToken: refreshToken || (user.google && user.google.refreshToken ? user.google.refreshToken : ''),
                accessToken: accessToken || '',
                accessTokenExpiresAt: accessToken ? accessTokenExpiresAt : 0
            },
            updatedAt: Date.now()
        });
        
        // SUCCESS: Redirect back to the CRM
        // CRITICAL: If we are on a "fake" domain or tunnel, ensure we redirect to the right place?
        // Actually, if the request reached here, the browser is at the right place (or the server is serving that domain).
        // Just redirect to relative path.
        res.redirect('/crm.html?view=contacts&google=connected');
    } catch (e) {
        console.error('Google Callback Error:', e);
        res.redirect('/crm.html?view=contacts&google=error');
    }
});

app.get('/api/public-stats', (req, res) => {
    try {
        const stats = proxyManager.getStats();
        // Also ensure we count ALL sessions in memory/file, not just "activeClients" map if they differ
        // But proxyManager.getStats() uses the persisted assignments file, which is the source of truth for the limit.
        res.json({
            success: true,
            totalConnections: stats.totalConnections,
            maxConnections: stats.maxConnections,
            available: Math.max(0, stats.maxConnections - stats.totalConnections)
        });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Internal Error' });
    }
});

app.get('/api/google/status', requireUser, (req, res) => {
    try {
        const g = getGoogleAuthFromUser(req.user);
        if (!g) {
            res.json({ success: true, connected: false });
            return;
        }
        res.json({ success: true, connected: true, email: g.email || '' });
    } catch (e) {
        res.status(500).json({ success: false, error: 'erro interno' });
    }
});

app.post('/api/whatsapp/check-number', requireUser, async (req, res) => {
    try {
        const sid = getUserSessionId(req.user);
        if (!sid) {
            res.status(400).json({ success: false, error: 'sessionId required' });
            return;
        }
        
        const phone = String(req.body.phone || '').trim().replace(/\D/g, '');
        if (!phone) {
            res.status(400).json({ success: false, error: 'phone required' });
            return;
        }

        const sessionData = activeClients.get(sid);
        if (!hasReadyClient(sessionData)) {
             res.status(503).json({ success: false, error: 'whatsapp_not_ready' });
             return;
        }

        const client = sessionData.client;
        const numberId = `${phone}@c.us`;
        const isRegistered = await client.isRegisteredUser(numberId);

        res.json({ success: true, isRegistered });
    } catch (e) {
        console.error('Check number error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/google/disconnect', requireUser, (req, res) => {
    try {
        const sid = getUserSessionId(req.user);
        const user = getUserById(req.user.id);
        if (user) {
            delete user.google;
            upsertUser(user);
        }
        
        if (sid) {
            const contacts = loadContacts();
            if (contacts[sid]) {
                delete contacts[sid].__googleContacts;
                delete contacts[sid].__googleSyncedAt;
                saveContacts(contacts);
            }
        }
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: 'erro interno' });
    }
});

app.post('/api/google/auth-url', requireUser, (req, res) => {
    try {
        ensureGoogleConfigOrThrow();
        const state = crypto.randomBytes(18).toString('hex');
        googleOAuthStates.set(state, { userId: req.user.id, createdAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000 });
        const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        u.searchParams.set('client_id', GOOGLE_CLIENT_ID);
        u.searchParams.set('redirect_uri', GOOGLE_REDIRECT_URI);
        u.searchParams.set('response_type', 'code');
        u.searchParams.set('access_type', 'offline');
        u.searchParams.set('prompt', 'consent');
        u.searchParams.set('include_granted_scopes', 'true');
        u.searchParams.set('scope', [
            'openid',
            'email',
            'profile',
            'https://www.googleapis.com/auth/contacts',
            'https://www.googleapis.com/auth/contacts.readonly'
        ].join(' '));
        u.searchParams.set('state', state);
        res.json({ success: true, url: u.toString() });
    } catch (e) {
        const code = e && e.code ? String(e.code) : '';
        if (code === 'google_oauth_not_configured') {
            res.status(500).json({ success: false, error: 'Google OAuth não configurado no servidor' });
            return;
        }
        res.status(500).json({ success: false, error: 'erro interno' });
    }
});

app.post('/api/google/import-contacts', requireUser, async (req, res) => {
    try {
        const sid = getUserSessionId(req.user);
        if (!sid) {
            res.status(400).json({ success: false, error: 'sessionId obrigatório' });
            return;
        }
        const r = await importGoogleContactsForUser(req.user);
        if (!r.ok) {
            res.status(400).json({ success: false, error: r.error || 'falha ao importar' });
            return;
        }
        const contacts = loadContacts();
        if (!contacts[sid]) contacts[sid] = {};
        contacts[sid].__googleContacts = r.contacts;
        contacts[sid].__googleSyncedAt = Date.now();
        saveContacts(contacts);
        res.json({ success: true, count: r.contacts.length });
    } catch (e) {
        res.status(500).json({ success: false, error: 'erro interno' });
    }
});

app.get('/api/contacts/list', requireUser, (req, res) => {
    try {
        const sid = getUserSessionId(req.user);
        if (!sid) {
            res.status(400).json({ success: false, error: 'sessionId obrigatório' });
            return;
        }
        const store = loadContacts();
        const sessionContacts = store && store[sid] && typeof store[sid] === 'object' ? store[sid] : {};
        const appContacts = [];
        for (const [key, v] of Object.entries(sessionContacts)) {
            if (String(key).startsWith('__')) continue;
            if (!v || typeof v !== 'object') continue;
            const name = String(v.name || '').trim();
            const phoneDigits = normalizeDigits(v.waNumber || v.phoneNumber || '');
            const phone = phoneDigits ? `+${phoneDigits}` : '';
            const updatedAt = Number(v.updatedAt || 0) || 0;
            if (!name && !phoneDigits) continue;
            appContacts.push({
                id: String(key),
                source: 'zapmro',
                name: name || phone || String(key),
                phone,
                phoneDigits,
                email: String(v.email || ''),
                notes: String(v.notes || ''),
                priority: String(v.priority || 'normal'),
                googleResourceName: v.googleResourceName ? String(v.googleResourceName) : '',
                updatedAt
            });
        }

        const googleContacts = Array.isArray(sessionContacts.__googleContacts) ? sessionContacts.__googleContacts : [];
        res.json({
            success: true,
            googleConnected: !!getGoogleAuthFromUser(req.user),
            googleEmail: (getGoogleAuthFromUser(req.user)?.email) || '',
            googleSyncedAt: Number(sessionContacts.__googleSyncedAt || 0) || 0,
            appContacts,
            googleContacts
        });
    } catch (e) {
        res.status(500).json({ success: false, error: 'erro interno' });
    }
});

app.post('/api/contacts/create', requireUser, async (req, res) => {
    try {
        const sid = getUserSessionId(req.user);
        if (!sid) {
            res.status(400).json({ success: false, error: 'sessionId obrigatório' });
            return;
        }
        const name = String(req.body && req.body.name ? req.body.name : '').trim();
        const phoneRaw = String(req.body && req.body.phone ? req.body.phone : '').trim();
        const email = String(req.body && req.body.email ? req.body.email : '').trim();
        const phoneDigits = normalizeDigits(phoneRaw);
        const notes = String(req.body && req.body.notes ? req.body.notes : '').trim();
        const priority = String(req.body && req.body.priority ? req.body.priority : 'normal').trim() || 'normal';
        const saveToGoogle = !!(req.body && req.body.saveToGoogle);
        if (!name && !phoneDigits) {
            res.status(400).json({ success: false, error: 'nome ou telefone obrigatório' });
            return;
        }
        const key = phoneDigits ? `manual_${phoneDigits}` : generateId('manual');
        const contacts = loadContacts();
        if (!contacts[sid]) contacts[sid] = {};
        const existing = contacts[sid][key] && typeof contacts[sid][key] === 'object' ? contacts[sid][key] : {};
        const record = {
            ...existing,
            name: name || existing.name || '',
            email: email || existing.email || '',
            notes: notes || existing.notes || '',
            priority,
            waNumber: phoneDigits || existing.waNumber || '',
            updatedAt: Date.now()
        };

        let googleResult = null;
        const g = getGoogleAuthFromUser(req.user);
        if (saveToGoogle && g && (name || phoneRaw || email)) {
            try {
                const r = await createGoogleContactForUser(req.user, { name: name || record.name, phone: phoneRaw || (phoneDigits ? `+${phoneDigits}` : ''), email: email || '' });
                if (r && r.ok) {
                    record.googleResourceName = r.resourceName || '';
                    record.googleEtag = r.etag || '';
                    googleResult = { ok: true, resourceName: r.resourceName || '' };
                }
            } catch (e) {
                googleResult = { ok: false, error: 'google_create_failed' };
            }
        }

        contacts[sid][key] = record;
        saveContacts(contacts);

        res.json({ success: true, id: key, google: googleResult });
    } catch (e) {
        res.status(500).json({ success: false, error: 'erro interno' });
    }
});

app.post('/api/contacts/update', requireUser, async (req, res) => {
    try {
        const sid = getUserSessionId(req.user);
        if (!sid) {
            res.status(400).json({ success: false, error: 'sessionId obrigatório' });
            return;
        }
        const id = String(req.body && req.body.id ? req.body.id : '').trim();
        if (!id) {
            res.status(400).json({ success: false, error: 'id obrigatório' });
            return;
        }
        const name = String(req.body && req.body.name ? req.body.name : '').trim();
        const phoneRaw = String(req.body && req.body.phone ? req.body.phone : '').trim();
        const email = String(req.body && req.body.email ? req.body.email : '').trim();
        const notes = String(req.body && req.body.notes ? req.body.notes : '').trim();
        const priority = String(req.body && req.body.priority ? req.body.priority : 'normal').trim() || 'normal';
        const saveToGoogle = !!(req.body && req.body.saveToGoogle);
        const phoneDigits = normalizeDigits(phoneRaw);

        const contacts = loadContacts();
        if (!contacts[sid]) contacts[sid] = {};
        const existing = contacts[sid][id] && typeof contacts[sid][id] === 'object' ? contacts[sid][id] : null;
        if (!existing) {
            res.status(404).json({ success: false, error: 'contato não encontrado' });
            return;
        }

        const canRekey = id.startsWith('manual_') || id.startsWith('google_');
        const targetKey = phoneDigits && canRekey ? `manual_${phoneDigits}` : id;
        const mergedBase =
            targetKey !== id && contacts[sid][targetKey] && typeof contacts[sid][targetKey] === 'object'
                ? { ...contacts[sid][targetKey], ...existing }
                : { ...existing };

        const nextRecord = {
            ...mergedBase,
            name: name || mergedBase.name || '',
            email: email || mergedBase.email || '',
            notes: notes || mergedBase.notes || '',
            priority,
            waNumber: phoneDigits || mergedBase.waNumber || '',
            updatedAt: Date.now()
        };

        let googleResult = null;
        const hasGoogle = !!getGoogleAuthFromUser(req.user);
        if (saveToGoogle && hasGoogle) {
            const googleName = nextRecord.name || '';
            const googlePhone = phoneRaw || (nextRecord.waNumber ? `+${nextRecord.waNumber}` : '');
            const googleEmail = nextRecord.email || '';
            const rn = nextRecord.googleResourceName ? String(nextRecord.googleResourceName) : '';
            try {
                if (rn) {
                    let etag = nextRecord.googleEtag ? String(nextRecord.googleEtag) : '';
                    if (!etag) {
                        const g0 = await getGoogleContactForUser(req.user, rn);
                        if (g0 && g0.ok && g0.etag) etag = g0.etag;
                    }
                    const r = await updateGoogleContactForUser(req.user, { resourceName: rn, etag, name: googleName, phone: googlePhone, email: googleEmail });
                    if (r && r.ok) {
                        nextRecord.googleEtag = r.etag || nextRecord.googleEtag || '';
                        googleResult = { ok: true, resourceName: rn, updated: true };
                    }
                } else if (googleName || googlePhone || googleEmail) {
                    const r = await createGoogleContactForUser(req.user, { name: googleName, phone: googlePhone, email: googleEmail });
                    if (r && r.ok) {
                        nextRecord.googleResourceName = r.resourceName || '';
                        nextRecord.googleEtag = r.etag || '';
                        googleResult = { ok: true, resourceName: r.resourceName || '', created: true };
                    }
                }
            } catch (e) {
                googleResult = { ok: false, error: 'google_update_failed' };
            }
        }

        contacts[sid][targetKey] = nextRecord;
        if (targetKey !== id) delete contacts[sid][id];
        saveContacts(contacts);

        res.json({ success: true, id: targetKey, google: googleResult });
    } catch (e) {
        res.status(500).json({ success: false, error: 'erro interno' });
    }
});

app.post('/api/contacts/delete', requireUser, (req, res) => {
    try {
        const sid = getUserSessionId(req.user);
        if (!sid) {
            res.status(400).json({ success: false, error: 'sessionId obrigatório' });
            return;
        }
        const id = String(req.body && req.body.id ? req.body.id : '').trim();
        if (!id) {
            res.status(400).json({ success: false, error: 'id obrigatório' });
            return;
        }
        const contacts = loadContacts();
        if (!contacts[sid]) contacts[sid] = {};
        if (!contacts[sid][id]) {
            res.status(404).json({ success: false, error: 'contato não encontrado' });
            return;
        }
        delete contacts[sid][id];
        saveContacts(contacts);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: 'erro interno' });
    }
});

app.post('/api/google/sync-to-zapmro', requireUser, async (req, res) => {
    try {
        const sid = getUserSessionId(req.user);
        if (!sid) {
            res.status(400).json({ success: false, error: 'sessionId obrigatório' });
            return;
        }
        const r = await importGoogleContactsForUser(req.user);
        if (!r.ok) {
            res.status(400).json({ success: false, error: r.error || 'falha ao importar' });
            return;
        }
        const contacts = loadContacts();
        if (!contacts[sid]) contacts[sid] = {};
        contacts[sid].__googleContacts = r.contacts;
        contacts[sid].__googleSyncedAt = Date.now();

        let mergedCount = 0;
        for (const c of r.contacts) {
            if (!c || typeof c !== 'object') continue;
            const digits = normalizeDigits(c.phoneDigits || c.phone || '');
            const email = String(c.email || '').trim();
            const name = String(c.name || '').trim();
            const rn = String(c.resourceName || '').trim();
            const etag = String(c.etag || '').trim();
            if (!name && !digits && !email) continue;

            let key = '';
            if (digits) key = `manual_${digits}`;
            else if (email) key = `google_${crypto.createHash('sha1').update(email).digest('hex').slice(0, 12)}`;
            else if (rn) key = `google_${crypto.createHash('sha1').update(rn).digest('hex').slice(0, 12)}`;
            else key = generateId('google');

            const existing = contacts[sid][key] && typeof contacts[sid][key] === 'object' ? contacts[sid][key] : {};
            const existingName = String(existing.name || '').trim();
            const placeholder = digits ? `+${digits}` : '';
            const shouldReplaceName = !existingName || (placeholder && existingName === placeholder);
            const next = {
                ...existing,
                name: shouldReplaceName ? (name || existingName) : existingName,
                email: email || String(existing.email || '').trim(),
                waNumber: digits || normalizeDigits(existing.waNumber || ''),
                googleResourceName: rn || existing.googleResourceName || '',
                googleEtag: etag || existing.googleEtag || '',
                updatedAt: Date.now()
            };
            contacts[sid][key] = next;
            mergedCount++;
        }

        saveContacts(contacts);
        res.json({ success: true, count: mergedCount });
    } catch (e) {
        res.status(500).json({ success: false, error: 'erro interno' });
    }
});

app.post('/api/google/sync-from-zapmro', requireUser, async (req, res) => {
    try {
        const sid = getUserSessionId(req.user);
        if (!sid) {
            res.status(400).json({ success: false, error: 'sessionId obrigatório' });
            return;
        }
        if (!getGoogleAuthFromUser(req.user)) {
            res.status(400).json({ success: false, error: 'google_not_connected' });
            return;
        }
        const contacts = loadContacts();
        if (!contacts[sid]) contacts[sid] = {};

        let created = 0;
        let updated = 0;
        let failed = 0;

        const entries = Object.entries(contacts[sid]).filter(([k]) => !String(k).startsWith('__'));
        for (const [key, v] of entries) {
            const rec = v && typeof v === 'object' ? v : {};
            const name = String(rec.name || '').trim();
            const digits = normalizeDigits(rec.waNumber || rec.phoneNumber || '');
            const phone = digits ? `+${digits}` : '';
            const email = String(rec.email || '').trim();
            if (!name && !phone && !email) continue;

            const rn = rec.googleResourceName ? String(rec.googleResourceName) : '';
            try {
                if (rn) {
                    let etag = rec.googleEtag ? String(rec.googleEtag) : '';
                    if (!etag) {
                        const g0 = await getGoogleContactForUser(req.user, rn);
                        if (g0 && g0.ok && g0.etag) etag = g0.etag;
                    }
                    const r = await updateGoogleContactForUser(req.user, { resourceName: rn, etag, name, phone, email });
                    if (r && r.ok) {
                        contacts[sid][key] = { ...rec, googleEtag: r.etag || rec.googleEtag || '', updatedAt: Date.now() };
                        updated++;
                    } else {
                        failed++;
                    }
                } else {
                    const r = await createGoogleContactForUser(req.user, { name, phone, email });
                    if (r && r.ok) {
                        contacts[sid][key] = { ...rec, googleResourceName: r.resourceName || '', googleEtag: r.etag || '', updatedAt: Date.now() };
                        created++;
                    } else {
                        failed++;
                    }
                }
            } catch (e) {
                failed++;
            }
        }

        saveContacts(contacts);
        res.json({ success: true, created, updated, failed });
    } catch (e) {
        res.status(500).json({ success: false, error: 'erro interno' });
    }
});

// Rota para criar nova sessão
app.post('/api/create-session', (req, res) => {
    const token = parseBearerToken(req);
    const rec = validateAuthToken(token);
    if (!rec) {
        res.status(401).json({ success: false, error: 'unauthorized' });
        return;
    }

    const wantsAdminSelf = !!(rec.isAdmin && isAdminSelfRequest(req));
    let sessionId = '';
    let user = null;

    if (wantsAdminSelf) {
        sessionId = ADMIN_SELF_SESSION_ID;
    } else {
        if (rec.isAdmin) {
            res.status(401).json({ success: false, error: 'unauthorized' });
            return;
        }
        user = getUserById(rec.userId);
        if (!user) {
            res.status(401).json({ success: false, error: 'unauthorized' });
            return;
        }
        if (user.sessionId) {
            sessionId = String(user.sessionId);
        } else {
            sessionId = generateSessionId();
        }
    }

    if (sessionId) {
        clearSessionManualStop(sessionId);
    }

    if (!wantsAdminSelf && user && user.sessionId) {
        const sid = String(user.sessionId);
        if (!activeClients.get(sid)) initializeClient(sid, loadSessionsData()[sid] || null);
        res.json({ success: true, sessionId: sid, message: 'Sessão já existe para este usuário' });
        return;
    }

    if (USE_EVOLUTION) {
        if (!evolutionApi || !evolutionApi.isConfigured()) {
            return res.status(400).json({
                success: false,
                error: 'Evolution API não configurada. Defina EVOLUTION_API_URL, EVOLUTION_API_KEY e EVOLUTION_WEBHOOK_URL.'
            });
        }
    } else {
        // Check global proxy limit before creating session
        try {
            // This will throw if limit is reached
            proxyManager.getAssignment(sessionId);
        } catch (e) {
            return res.status(400).json({ success: false, error: e.message });
        }
    }

    if (!wantsAdminSelf) {
        const updated = upsertUser({ ...user, sessionId, updatedAt: Date.now() });
        initializeClient(sessionId);
        res.json({ success: true, sessionId: updated.sessionId, message: 'Sessão criada com sucesso' });
        return;
    }

    if (!activeClients.get(sessionId)) {
        initializeClient(sessionId, null);
    }
    res.json({ success: true, sessionId, message: 'Sessão do admin iniciada com sucesso' });
});

// Rota para desconectar sessão
app.post('/api/disconnect-session', async (req, res) => {
    const token = parseBearerToken(req);
    const rec = validateAuthToken(token);
    if (!rec) {
        res.status(401).json({ success: false, message: 'unauthorized' });
        return;
    }
    if (rec.isAdmin && !isAdminSelfRequest(req)) {
        res.status(401).json({ success: false, message: 'unauthorized' });
        return;
    }
    const sessionId = rec.isAdmin && isAdminSelfRequest(req)
        ? ADMIN_SELF_SESSION_ID
        : (req.body && req.body.sessionId ? String(req.body.sessionId) : (getUserById(rec.userId || '')?.sessionId || ''));
    if (!sessionId) {
        res.status(404).json({ success: false, message: 'Sessão não encontrada' });
        return;
    }

    markSessionManuallyStopped(sessionId);
    clearReconnect(sessionId);
    stopReadyProbe(sessionId);
    stopEvolutionConnectionPoll(sessionId);

    const sessionData = activeClients.get(sessionId);
    const userBeforeDisconnect = getUserBySessionId(sessionId);
    if (sessionData && sessionData.client) {
        try { await sessionData.client.destroy(); } catch (e) {}
    }
    if (USE_EVOLUTION && evolutionApi) {
        try { await evolutionApi.logoutInstance(evolutionInstanceName(sessionId)); } catch (e) {}
    }
    activeClients.delete(sessionId);
    clearPersistedConnectionState(sessionId, { keepUserBinding: true });
    if (userBeforeDisconnect) {
        appendUserHistory(userBeforeDisconnect, {
            type: 'disconnect',
            label: 'Desconectou manualmente',
            number: userBeforeDisconnect.whatsappNumber || (sessionData && sessionData.phoneNumber) || ''
        });
    }

    emitToSessionClients(sessionId, 'session-status', { sessionId, status: 'disconnected' });
    io.to('admin').emit('session-status', { sessionId, status: 'disconnected' });
    io.to(`session:${sessionId}`).emit('sessions-list-update');
    io.to('admin').emit('sessions-list-update');

    res.json({ success: true, message: 'Sessão desconectada' });
});

app.get('/api/admin/self-session-status', requireAdmin, (req, res) => {
    const sessionId = ADMIN_SELF_SESSION_ID;
    const passwords = loadSessionPasswords();
    let sessionData = activeClients.get(sessionId) || null;

    if (!sessionData) {
        const saved = loadSessionsData()[sessionId];
        if (saved) {
            clearSessionManualStop(sessionId);
            initializeClient(sessionId, saved);
            sessionData = activeClients.get(sessionId) || null;
        }
    }

    if (sessionData) {
        let status = sessionData.status || 'initializing';
        if (status === 'initializing' && (sessionData.phoneNumber || sessionData.name)) status = 'authenticated';
        return res.json({
            success: true,
            session: {
                sessionId,
                status,
                phoneNumber: sessionData.phoneNumber || null,
                name: sessionData.name || null,
                connectedAt: sessionData.connectedAt || null,
                hasPassword: !!passwords[sessionId]
            }
        });
    }

    const saved = loadSessionsData()[sessionId];
    return res.json({
        success: true,
        session: {
            sessionId,
            status: saved ? 'authenticated' : 'none',
            phoneNumber: saved && saved.phoneNumber ? saved.phoneNumber : null,
            name: saved && saved.name ? saved.name : null,
            connectedAt: saved && saved.createdAt ? saved.createdAt : null,
            hasPassword: !!passwords[sessionId]
        }
    });
});

// Rota para listar sessões ativas
app.get('/api/active-sessions', requireUser, async (req, res) => {
    const sessions = [];
    const passwords = loadSessionPasswords();
    const sid = req.user && req.user.sessionId ? String(req.user.sessionId) : '';
    if (!sid) {
        res.json({ sessions: [] });
        return;
    }

    const netInfo = await buildSessionNetworkInfo(sid);
    const data = activeClients.get(sid);
    if (data) {
        let status = data.status;
        if (status === 'initializing' && (data.phoneNumber || data.name)) status = 'authenticated';
        const fallbackPhone = data.phoneNumber || req.user.whatsappNumber || (loadSessionsData()[sid] && loadSessionsData()[sid].phoneNumber) || null;
        const fallbackName = data.name || req.user.whatsappName || (loadSessionsData()[sid] && loadSessionsData()[sid].name) || null;
        sessions.push({
            sessionId: sid,
            status,
            phoneNumber: fallbackPhone,
            name: fallbackName,
            connectedAt: data.connectedAt || req.user.connectedAt || null,
            hasPassword: !!passwords[sid],
            realIp: netInfo.serverRealIp || null,
            currentConnectionIp: netInfo.currentConnectionIp || null,
            proxyConnectionIp: netInfo.proxyConnectionIp || null,
            proxyName: netInfo.proxyName || null,
            proxyHost: netInfo.proxyHost || null,
            proxyPort: netInfo.proxyPort || null,
            usingProxy: !!netInfo.usingProxy,
            proxyIpValidated: !!netInfo.proxyIpValidated,
            proxyValidationError: netInfo.proxyValidationError || null,
            proxyValidationEndpoint: netInfo.proxyValidationEndpoint || null
        });
        res.json({ sessions });
        return;
    }

    const saved = loadSessionsData()[sid];
    if (saved) {
        initializeClient(sid, saved);
        sessions.push({
            sessionId: sid,
            status: 'authenticated',
            phoneNumber: saved.phoneNumber || null,
            name: saved.name || null,
            connectedAt: saved.createdAt || null,
            hasPassword: !!passwords[sid],
            realIp: netInfo.serverRealIp || null,
            currentConnectionIp: netInfo.currentConnectionIp || null,
            proxyConnectionIp: netInfo.proxyConnectionIp || null,
            proxyName: netInfo.proxyName || null,
            proxyHost: netInfo.proxyHost || null,
            proxyPort: netInfo.proxyPort || null,
            usingProxy: !!netInfo.usingProxy,
            proxyIpValidated: !!netInfo.proxyIpValidated,
            proxyValidationError: netInfo.proxyValidationError || null,
            proxyValidationEndpoint: netInfo.proxyValidationEndpoint || null
        });
    }

    res.json({ sessions });
});

// DEBUG ENDPOINT
app.get('/api/debug-session/:sessionId', requireAdmin, (req, res) => {
    const { sessionId } = req.params;
    const sessionData = activeClients.get(sessionId);
    
    if (!sessionData) {
        return res.json({ found: false });
    }
    
    res.json({
        found: true,
        status: sessionData.status,
        hasClient: !!sessionData.client,
        socketId: sessionData.socketId,
        phoneNumber: sessionData.phoneNumber,
        name: sessionData.name
    });
});

ensureSeedUser();

// Socket.io connection
io.use((socket, next) => {
    try {
        const token = (socket.handshake && socket.handshake.auth && socket.handshake.auth.token) ? String(socket.handshake.auth.token) : '';
        const rec = validateAuthToken(token);
        if (!rec) return next(new Error('unauthorized'));
        socket.data.isAdmin = !!rec.isAdmin;
        socket.data.userId = rec.userId || null;
        socket.data.authToken = rec.token;
        return next();
    } catch (e) {
        return next(new Error('unauthorized'));
    }
});

io.on('connection', (socket) => {
    console.log('Novo cliente conectado:', socket.id);

    if (socket.data && socket.data.isAdmin) {
        socket.join('admin');
    } else if (socket.data && socket.data.userId) {
        const user = getUserById(socket.data.userId);
        if (user && user.sessionId) {
            const sessionData = activeClients.get(user.sessionId);
            if (sessionData) sessionData.socketId = socket.id;
            socket.join(`session:${user.sessionId}`);
        }
    }

    socket.use((packet, next) => {
        if (socket.data && socket.data.isAdmin) return next();
        const userId = socket.data && socket.data.userId ? socket.data.userId : null;
        if (!userId) return next(new Error('unauthorized'));
        const user = getUserById(userId);
        const sid = user && user.sessionId ? String(user.sessionId) : '';
        const eventName = packet && packet.length > 0 ? packet[0] : '';
        const data = packet && packet.length > 1 ? packet[1] : null;
        if (sid && data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'sessionId')) {
            data.sessionId = sid;
        } else if (sid && typeof data === 'string') {
            const name = String(eventName || '');
            const needsSessionId = (
                name === 'get-ai-config' ||
                name === 'get-chats' ||
                name === 'get-kanban-columns' ||
                name === 'get-scheduled-messages' ||
                name === 'get-tags' ||
                name === 'get-flows'
            );
            if (needsSessionId) {
                packet[1] = sid;
            }
        }
        next();
    });
    
    // Vincular socket à sessão
    socket.on('bind-session', (sessionId) => {
        const allowed = (socket.data && socket.data.isAdmin) ? String(sessionId) : (getUserById(socket.data.userId || '')?.sessionId || null);
        if (!allowed || String(sessionId) !== String(allowed)) return;
        const sessionData = ensureSessionClientOnDemand(allowed, {
            forceResume: String(allowed) === ADMIN_SELF_SESSION_ID
        }) || activeClients.get(allowed);
        if (sessionData) {
            sessionData.socketId = socket.id;
            console.log(`Socket ${socket.id} vinculado à sessão ${allowed}`);
            if (USE_EVOLUTION) maybeEmitEvolutionQrToSocket(allowed, socket.id);
        }
        socket.join(`session:${allowed}`);
    });

    // --- SESSION PASSWORD MANAGEMENT ---
    socket.on('set-session-password', ({ sessionId, password }) => {
        if (!password) return;
        const passwords = loadSessionPasswords();
        passwords[sessionId] = password;
        saveSessionPasswords(passwords);
        socket.emit('session-password-set', { sessionId, success: true });
        io.to(`session:${sessionId}`).emit('sessions-list-update');
        io.to('admin').emit('sessions-list-update');
    });

    socket.on('verify-session-password', ({ sessionId, password }) => {
        const valid = isSessionPasswordValid(sessionId, password);
        socket.emit('session-password-verified', { sessionId, valid: !!valid });
    });

    socket.on('delete-session-permanently', async ({ sessionId, password }, cb) => {
        const sid = String(sessionId || '');
        if (!sid) {
            if (typeof cb === 'function') cb({ ok: false, error: 'sessionId obrigatório' });
            return;
        }

        const stored = loadSessionPasswords()[sid];
        const allowed = stored ? isSessionPasswordValid(sid, password) : isMasterPassword(password);

        if (!allowed) {
            if (typeof cb === 'function') cb({ ok: false, error: stored ? 'Senha incorreta' : 'Senha master obrigatória' });
            return;
        }

        try {
            markSessionManuallyStopped(sid);
            stopReadyProbe(sid);
            stopEvolutionConnectionPoll(sid);
            clearReconnect(sid);
            if (activeFlows && activeFlows[sid]) delete activeFlows[sid];
            if (aiDebounceTimers && aiDebounceTimers[sid]) delete aiDebounceTimers[sid];
            profilePicHydrationState.delete(sid);
            readyProbeTimers.delete(sid);
            proxyManager.releaseAssignment(sid);
            io.emit('system-stats-update', proxyManager.getStats());

            const sessionData = activeClients.get(sid);
            if (sessionData && sessionData.client) {
                try { await sessionData.client.destroy(); } catch (e) {}
            }
            if (USE_EVOLUTION && evolutionApi) {
                try { await evolutionApi.deleteInstance(evolutionInstanceName(sid)); } catch (e) {}
            }
            activeClients.delete(sid);

            removeSessionFromStores(sid);

            const safeId = safeSessionKey(sid);
            deletePathRecursive(path.join(UPLOADS_DIR, safeId));
            deletePathRecursive(path.join(__dirname, '../.wwebjs_auth', `session-${sid}`));
            deletePathRecursive(path.join(__dirname, '../.wwebjs_auth', `session-${safeId}`));

            try {
                const cacheFile = getChatCacheFile(sid);
                if (cacheFile && fs.existsSync(cacheFile)) fs.rmSync(cacheFile, { force: true });
            } catch (e) {}

            try {
                if (fs.existsSync(ARCHIVE_DIR)) {
                    const files = fs.readdirSync(ARCHIVE_DIR);
                    for (const f of files) {
                        if (f === 'archive_log.json') continue;
                        if (f.startsWith(`${sid}_`)) {
                            deletePathRecursive(path.join(ARCHIVE_DIR, f));
                        }
                    }
                }
            } catch (e) {}

            const u = getUserBySessionId(sid);
            if (u) {
                const updatedUser = appendUserHistory(u, {
                    type: 'deleted',
                    label: 'Sessão excluída permanentemente',
                    number: u.whatsappNumber || (sessionData && sessionData.phoneNumber) || ''
                });
                upsertUser({ ...updatedUser, sessionId: null, whatsappNumber: null, whatsappName: null, connectedAt: null, lastQrAt: null, updatedAt: Date.now() });
            }
            io.to(`session:${sid}`).emit('sessions-list-update');
            io.to('admin').emit('sessions-list-update');
            if (typeof cb === 'function') cb({ ok: true });
        } catch (e) {
            if (typeof cb === 'function') cb({ ok: false, error: 'Erro ao excluir sessão' });
        }
    });

    // --- AI AGENT CONFIGURATION ---
    socket.on('get-ai-config', (sessionId) => {
        const config = loadAiConfig();
        const raw = config[sessionId] || {};
        const provider = raw.provider ? String(raw.provider) : 'deepseek';
        const sessionConfig = {
            enabled: !!raw.enabled,
            provider,
            deepseekApiKey: raw.deepseekApiKey || raw.apiKey || '',
            openaiApiKey: raw.openaiApiKey || '',
            triggerMode: raw.triggerMode || 'all',
            keyword: raw.keyword || '',
            respondInGroups: typeof raw.respondInGroups === 'boolean' ? raw.respondInGroups : false,
            prompt: raw.prompt || '',
            proofreadEnabled: typeof raw.proofreadEnabled === 'boolean' ? raw.proofreadEnabled : true,
            proofreadProvider: raw.proofreadProvider || 'same',
            proofreadModel: raw.proofreadModel || ''
        };
        socket.emit('ai-config-data', sessionConfig);
    });

    socket.on('save-ai-config', ({ sessionId, config }) => {
        const allConfigs = loadAiConfig();
        const provider = config && config.provider ? String(config.provider) : 'deepseek';
        allConfigs[sessionId] = {
            enabled: !!(config && config.enabled),
            provider,
            deepseekApiKey: config && config.deepseekApiKey ? String(config.deepseekApiKey) : '',
            openaiApiKey: config && config.openaiApiKey ? String(config.openaiApiKey) : '',
            triggerMode: config && config.triggerMode ? String(config.triggerMode) : 'all',
            keyword: config && config.keyword ? String(config.keyword) : '',
            respondInGroups: !!(config && config.respondInGroups),
            prompt: config && config.prompt ? String(config.prompt) : '',
            proofreadEnabled: typeof (config && config.proofreadEnabled) === 'boolean' ? config.proofreadEnabled : true,
            proofreadProvider: config && config.proofreadProvider ? String(config.proofreadProvider) : 'same',
            proofreadModel: config && config.proofreadModel ? String(config.proofreadModel) : ''
        };
        saveAiConfig(allConfigs);
        socket.emit('ai-config-saved', { success: true });
        
        // Update active clients if needed (not really needed as we load on demand or can cache)
    });

    socket.on('proofread-text', async ({ sessionId, text }) => {
        try {
            const rawText = typeof text === 'string' ? text : '';
            if (!rawText.trim()) {
                socket.emit('proofread-error', { sessionId, error: 'Texto vazio' });
                return;
            }

            const aiConfig = loadAiConfig();
            const config = aiConfig[sessionId] || {};

            const proofreadEnabled = typeof config.proofreadEnabled === 'boolean' ? config.proofreadEnabled : true;
            if (!proofreadEnabled) {
                socket.emit('proofread-error', { sessionId, error: 'Configure seu corretor na aba AGENTE I.A' });
                return;
            }

            const baseProvider = config.provider ? String(config.provider).toLowerCase() : 'deepseek';
            const chosen = config.proofreadProvider ? String(config.proofreadProvider).toLowerCase() : 'same';
            const provider = chosen === 'same' ? baseProvider : chosen;

            const deepseekApiKey = config.deepseekApiKey || config.apiKey || '';
            const openaiApiKey = config.openaiApiKey || '';

            const systemPrompt = 'Corrija o texto para português brasileiro, mantendo o sentido e a formatação. Retorne apenas o texto corrigido.';
            let corrected = '';

            if (provider === 'gpt5mini') {
                if (!openaiApiKey) {
                    socket.emit('proofread-error', { sessionId, error: 'Configure seu corretor na aba AGENTE I.A' });
                    return;
                }
                const openAiChatModel = (config.proofreadModel && String(config.proofreadModel).trim())
                    ? String(config.proofreadModel).trim()
                    : (process.env.OPENAI_CHAT_MODEL ? String(process.env.OPENAI_CHAT_MODEL) : 'gpt-4o-mini');

                const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                    model: openAiChatModel,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: rawText }
                    ],
                    temperature: 0.2,
                    max_tokens: 600
                }, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${openaiApiKey}`
                    },
                    maxBodyLength: Infinity
                });

                corrected = response && response.data && response.data.choices && response.data.choices[0] && response.data.choices[0].message && response.data.choices[0].message.content
                    ? String(response.data.choices[0].message.content)
                    : '';
            } else {
                if (!deepseekApiKey) {
                    socket.emit('proofread-error', { sessionId, error: 'Configure seu corretor na aba AGENTE I.A' });
                    return;
                }
                const response = await axios.post('https://api.deepseek.com/chat/completions', {
                    model: 'deepseek-chat',
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: rawText }
                    ],
                    temperature: 0.2
                }, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${deepseekApiKey}`
                    }
                });

                corrected = response && response.data && response.data.choices && response.data.choices[0] && response.data.choices[0].message && response.data.choices[0].message.content
                    ? String(response.data.choices[0].message.content)
                    : '';
            }

            corrected = String(corrected || '').trim();
            if (!corrected) {
                socket.emit('proofread-error', { sessionId, error: 'Falha ao corrigir texto' });
                return;
            }

            socket.emit('proofread-result', { sessionId, corrected });
        } catch (error) {
            const status = error && error.response && error.response.status ? error.response.status : null;
            const data = error && error.response && error.response.data !== undefined ? error.response.data : null;
            let msg = error && error.message ? String(error.message) : 'Erro ao corrigir texto';
            if (status) msg = `HTTP ${status}: ${msg}`;
            let payload = '';
            try { payload = typeof data === 'string' ? data : JSON.stringify(data); } catch (e) { payload = String(data); }
            if (payload && payload.length > 1500) payload = payload.slice(0, 1500);
            console.error('[proofread-text] Error:', msg, payload);
            socket.emit('proofread-error', { sessionId, error: 'Erro ao corrigir texto' });
        }
    });

    socket.on('get-message-media', async ({ sessionId, chatId, messageId }) => {
        const sessionData = activeClients.get(sessionId);
        if (!hasReadyClient(sessionData)) return;

        try {
            // Find the message in recent history (or fetch it)
            // Ideally we should use client.getMessageById if available, or search in chat
            const chat = await sessionData.client.getChatById(chatId);
            const messages = await chat.fetchMessages({ limit: 50 }); 
            const msg = messages.find(m => m.id._serialized === messageId);
            
            if (msg && msg.hasMedia) {
                const media = await msg.downloadMedia();
                if (media) {
                    socket.emit('message-media', {
                        messageId: messageId,
                        mimetype: media.mimetype,
                        media: media.data,
                        filename: media.filename
                    });
                }
            }
        } catch (e) {
            console.error('Error fetching media:', e);
        }
    });

    socket.on('get-flows-usage', ({ sessionId }) => {
        const usage = getAllFlowsUsage(sessionId);
        socket.emit('flow-usage', usage);
    });

    socket.on('toggle-ai-chat', ({ sessionId, chatId, active }) => {
        const allStatus = loadAiChatStatus();
        if (!allStatus[sessionId]) allStatus[sessionId] = {};

        const aiConfig = loadAiConfig();
        const config = aiConfig[sessionId];
        const globalEnabled = config && config.enabled;

        const current = normalizeBoolean(allStatus[sessionId][chatId], !!globalEnabled);
        const next = normalizeBoolean(active, !current);

        allStatus[sessionId][chatId] = next;
        
        saveAiChatStatus(allStatus);

        if (aiDebounceTimers[sessionId] && aiDebounceTimers[sessionId][chatId]) {
            clearTimeout(aiDebounceTimers[sessionId][chatId]);
            delete aiDebounceTimers[sessionId][chatId];
        }
        
        // Notify frontend to update UI
        socket.emit('ai-chat-status-updated', { chatId, active: next });
        
        // Also notify the specific session if it's different socket
        const sessionData = activeClients.get(sessionId);
        if (sessionData && sessionData.socketId && sessionData.socketId !== socket.id) {
            io.to(sessionData.socketId).emit('ai-chat-status-updated', { chatId, active: next });
        }
    });

    socket.on('send-chat-state', async ({ sessionId, chatId, state }) => {
        try {
            const sessionData = activeClients.get(sessionId);
            if (!sessionData || !sessionData.client) return;
            
            const client = sessionData.client;
            const chat = await client.getChatById(chatId);
            if (!chat) return;

            if (state === 'recording') {
                await chat.sendStateRecording();
            } else if (state === 'typing') {
                await chat.sendStateTyping();
            } else {
                await chat.clearState();
            }
        } catch (e) {
            console.error('[send-chat-state] Error:', e);
        }
    });

    // Get chats for Kanban
    socket.on('get-chats', async (sessionId) => {
        console.log(`[get-chats] Request received for session ${sessionId}`);
        const contactIndex = buildContactIndexForSession(sessionId);
        const contactByDigits = contactIndex.byDigits;
        const deletedChatMeta = loadDeletedChatsMetaForSession(sessionId);
        const sessionData = ensureSessionClientOnDemand(sessionId, {
            forceResume: String(sessionId) === ADMIN_SELF_SESSION_ID
        }) || activeClients.get(sessionId);
        const inflight = getChatsInFlight.get(sessionId);
        if (inflight) {
            try {
                if (inflight.socketIds && socket && socket.id) inflight.socketIds.add(socket.id);
            } catch (e) {}
        }
        
        // --- CACHE STRATEGY: Load immediately if available ---
        const cachedChats = loadChatCache(sessionId);
        const servedCache = !!(cachedChats && cachedChats.length > 0);
        if (servedCache) {
            console.log(`[get-chats] Serving ${cachedChats.length} cached chats for ${sessionId} immediately.`);
            const patchedCache = Array.isArray(cachedChats)
                ? cachedChats.map(c => {
                    const id = c && c.id ? String(c.id) : '';
                    if (!id || (!id.endsWith('@c.us') && !id.endsWith('@lid'))) return c;
                    const resolvedPhone = sanitizeResolvedPhoneForChat(id, c && c.phoneNumber)
                        || (id.endsWith('@lid') ? (getStoredPhoneForLid(id) || findStoredPhoneForLid(id)) : '')
                        || (!id.endsWith('@lid') ? normalizeEvolutionPhone(id.includes('@') ? id.split('@')[0] : '') : '');
                    const phoneDigits = normalizeDigits(resolvedPhone || '');
                    const rec = phoneDigits ? contactByDigits.get(phoneDigits) : null;
                    const nm = rec && rec.name ? String(rec.name).trim() : '';
                    const safeName = pickBestChatLabel(nm, c && c.name ? String(c.name) : '', resolvedPhone);
                    if (c && typeof c === 'object') {
                        return {
                            ...c,
                            name: safeName || (c.name || ''),
                            phoneNumber: resolvedPhone || (c.phoneNumber || '')
                        };
                    }
                    return c;
                })
                : cachedChats;
            const filteredCache = patchedCache.filter(c => {
                if (!c || !c.id) return false;
                const id = String(c.id);
                const ts = c && c.timestamp !== undefined ? c.timestamp : 0;
                const hide = shouldHideDeletedChat(deletedChatMeta, id, ts);
                if (!hide) clearDeletedChatMetaIfReappeared(sessionId, deletedChatMeta, id, ts);
                return !hide;
            });
            socket.emit('chats-loaded', filteredCache);
            scheduleProfilePicHydration(sessionId, sessionData, socket);
        } else {
             // If no cache, emit initializing to show spinner
             socket.emit('session-initializing', sessionId);
        }

        if (inflight) return;
        
        if (canFetchChats(sessionData)) {
            const entry = { socketIds: new Set() };
            if (socket && socket.id) entry.socketIds.add(socket.id);
            getChatsInFlight.set(sessionId, entry);
            try {
                console.log(`[get-chats] Session ${sessionId} is connected. Fetching fresh chats from WA Client...`);
                
                // Retry logic for getChats
                let chats;
                let attempts = 0;
                while (attempts < 3) {
                    try {
                        // Timeout wrapper for getChats to prevent hanging
                        const getChatsPromise = sessionData.client.getChats();
                        const timeoutPromise = new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('Timeout getting chats')), 180000)
                        );
                        chats = await Promise.race([getChatsPromise, timeoutPromise]);
                        console.log(`[get-chats] Fetched ${chats ? chats.length : 0} chats for ${sessionId}`);
                        break;
                    } catch (e) {
                        attempts++;
                        console.warn(`[get-chats] Attempt ${attempts} to get chats failed: ${e.message}`);
                        if (attempts >= 3) throw e;
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }

                if (!chats) chats = [];

                const kanbanData = loadKanbanData();
                const sessionKanban = kanbanData[sessionId] || {};
                
                const aiStatus = loadAiChatStatus();
                const sessionAiStatus = aiStatus[sessionId] || {};
                
                const aiConfig = loadAiConfig();
                const config = aiConfig[sessionId];
                const globalEnabled = config && config.enabled;

                const cacheById = new Map();
                if (Array.isArray(cachedChats)) {
                    for (const c of cachedChats) {
                        if (c && c.id) cacheById.set(String(c.id), c);
                    }
                }

                const formattedChats = [];
                console.log(`[get-chats] Processing ${chats.length} chats for ${sessionId}...`);
                for (const chat of chats) {
                    try {
                        const displayChatId = chat && chat.id && chat.id._serialized ? String(chat.id._serialized) : '';
                        if (!displayChatId) continue;
                        const hide = shouldHideDeletedChat(deletedChatMeta, displayChatId, chat.timestamp);
                        if (!hide) clearDeletedChatMetaIfReappeared(sessionId, deletedChatMeta, displayChatId, chat.timestamp);
                        if (hide) continue;

                        const chatStatus = sessionKanban[displayChatId] || { status: 'todos', tags: [] };
                        const explicitAiStatus = sessionAiStatus[displayChatId];
                        const isAiActive = normalizeBoolean(explicitAiStatus, !!(globalEnabled || false));

                        const cached = cacheById.get(displayChatId) || null;

                        let derivedPhoneNumber =
                            normalizeDigits(String(chat.phoneNumber || '')) ||
                            extractPhoneDigits(chat.name || '') ||
                            null;
                        if (!derivedPhoneNumber && displayChatId.endsWith('@c.us')) derivedPhoneNumber = displayChatId.split('@')[0] || null;
                        else if (!derivedPhoneNumber && displayChatId.endsWith('@lid')) derivedPhoneNumber = extractPhoneDigits(chat.name || '') || null;

                        if (!derivedPhoneNumber && displayChatId.endsWith('@lid')) {
                            const resolvedIdentity = await resolveEvolutionChatIdentity(
                                sessionId,
                                displayChatId,
                                chat.name || (cached && cached.name ? String(cached.name) : ''),
                                cached
                            );
                            if (resolvedIdentity.phoneNumber) derivedPhoneNumber = resolvedIdentity.phoneNumber;
                            if (resolvedIdentity.name && (!chat.name || /^[0-9@._+\-\s]+$/.test(String(chat.name)))) {
                                chat.name = resolvedIdentity.name;
                            }
                            if (resolvedIdentity.profilePictureUrl && !chat.profilePic) {
                                chat.profilePic = resolvedIdentity.profilePictureUrl;
                            }
                        }

                        const phoneNumber =
                            sanitizeResolvedPhoneForChat(displayChatId, derivedPhoneNumber)
                            || sanitizeResolvedPhoneForChat(displayChatId, cached && cached.phoneNumber ? String(cached.phoneNumber) : '')
                            || null;
                        const phoneDigits = normalizeDigits(phoneNumber || '');
                        const rec = phoneDigits ? contactByDigits.get(phoneDigits) : null;
                        const contactName = rec && rec.name ? String(rec.name).trim() : '';
                        const name = chatStatus.customName || contactName || chat.name || (cached && cached.name ? String(cached.name) : '') || phoneNumber || 'Unknown';
                        const profilePic = sanitizeEvolutionUrl(
                            (chat && chat.profilePic) ||
                            (cached && cached.profilePic) ||
                            null
                        );

                        formattedChats.push({
                            id: displayChatId,
                            name,
                            phoneNumber,
                            unreadCount: chat.unreadCount,
                            timestamp: chat.timestamp,
                            lastMessage: chat.lastMessage ? chat.lastMessage.body : '',
                            status: chatStatus.status,
                            tags: chatStatus.status === 'todos' ? [] : (Array.isArray(chatStatus.tags) ? chatStatus.tags : []),
                            profilePic,
                            aiActive: isAiActive
                        });
                    } catch (innerError) {
                        console.error(`Error processing individual chat ${chat?.id?._serialized}:`, innerError.message);
                    }
                }

                console.log(`[get-chats] Finished processing ${formattedChats.length} chats for ${sessionId}. Saving to cache and emitting.`);
                
                // Save to Cache
                saveChatCache(sessionId, formattedChats);
                
                // Emit fresh data
                const latestEntry = getChatsInFlight.get(sessionId);
                const socketIds = latestEntry && latestEntry.socketIds ? Array.from(latestEntry.socketIds) : [];
                if (socketIds.length === 0 && socket && socket.id) socketIds.push(socket.id);
                for (const sid of socketIds) {
                    io.to(sid).emit('chats-loaded', formattedChats);
                    const s = io.sockets.sockets.get(sid);
                    if (s) scheduleProfilePicHydration(sessionId, sessionData, s);
                }
            } catch (error) {
                console.error('Error fetching chats (Main Block):', error);
                if (error.stack) console.error(error.stack);
                const latestEntry = getChatsInFlight.get(sessionId);
                const socketIds = latestEntry && latestEntry.socketIds ? Array.from(latestEntry.socketIds) : [];
                if (socketIds.length === 0 && socket && socket.id) socketIds.push(socket.id);
                for (const sid of socketIds) {
                    io.to(sid).emit('error', 'Error fetching chats: ' + error.message);
                }
            } finally {
                getChatsInFlight.delete(sessionId);
            }
        } else {
            console.log(`[get-chats] Session ${sessionId} status check failed. Client: ${!!sessionData?.client}, Status: ${sessionData?.status}`);
            
            // Check if session exists but is initializing
            if (!servedCache && sessionData && (sessionData.status === 'initializing' || sessionData.status === 'authenticated')) {
                console.log(`[get-chats] Session ${sessionId} is initializing. Emitting 'session-initializing'.`);
                socket.emit('session-initializing', sessionId);
            } else if (!servedCache) {
                console.log(`[get-chats] Session ${sessionId} not connected. Emitting error.`);
                socket.emit('error', 'Session not connected');
            }
        }
    });

    // Update chat status
    socket.on('update-chat-status', ({ sessionId, chatId, status, tags }) => {
        const kanbanData = loadKanbanData();
        if (!kanbanData[sessionId]) {
            kanbanData[sessionId] = {};
        }
        
        // Preserve existing data (like customName)
        const existing = kanbanData[sessionId][chatId] || {};

        const nextStatus = status || existing.status || 'todos';
        let nextTags = existing.tags || [];
        if (nextStatus === 'todos') {
            nextTags = [];
        } else if (Array.isArray(tags)) {
            nextTags = tags;
        }

        kanbanData[sessionId][chatId] = {
            ...existing,
            status: nextStatus,
            tags: nextTags
        };
        
        saveKanbanData(kanbanData);
        
        // Notify client that update was successful
        socket.emit('chat-updated', { chatId, status: nextStatus, tags: kanbanData[sessionId][chatId].tags });
    });

    socket.on('get-kanban-columns', (sessionId) => {
        const kanbanData = loadKanbanData();
        const session = kanbanData && kanbanData[sessionId] ? kanbanData[sessionId] : {};
        const columns = session && Array.isArray(session.__columns) ? session.__columns : null;
        socket.emit('kanban-columns', { sessionId, columns });
    });

    socket.on('save-kanban-columns', ({ sessionId, columns }) => {
        const kanbanData = loadKanbanData();
        if (!kanbanData[sessionId]) kanbanData[sessionId] = {};

        const safeColumns = Array.isArray(columns)
            ? columns
                .filter(c => c && typeof c === 'object')
                .map(c => ({
                    id: typeof c.id === 'string' ? c.id : '',
                    title: typeof c.title === 'string' ? c.title : '',
                    color: typeof c.color === 'string' ? c.color : '#008069'
                }))
                .filter(c => c.id && c.title)
            : [];

        kanbanData[sessionId].__columns = safeColumns;
        saveKanbanData(kanbanData);
        io.emit('kanban-columns-updated', { sessionId, columns: safeColumns });
    });

    // Get Contact Details (Full)
    socket.on('get-contact-details', async ({ sessionId, chatId }) => {
        const sessionData = activeClients.get(sessionId);
        if (!hasReadyClient(sessionData)) {
            socket.emit('contact-details-error', { chatId, error: 'Sessão ainda não está pronta (sincronizando WhatsApp).' });
            return;
        }

        const displayId = String(chatId || '');
        let resolvedId = displayId;

        try {
            resolvedId = await resolveChatIdForClient(sessionData.client, displayId);
        } catch (e) {
            resolvedId = displayId;
        }

        const contacts = loadContacts();
        const savedContact =
            (contacts[sessionId] && contacts[sessionId][displayId]) ||
            (contacts[sessionId] && contacts[sessionId][resolvedId]) ||
            {};
        const contactIndex = buildContactIndexForSession(sessionId);
        let mergedContact = savedContact;
        try {
            const guessDigits = normalizeDigits(
                (resolvedId && String(resolvedId).includes('@c.us')) ? String(resolvedId).split('@')[0] : ''
            ) || normalizeDigits(
                (displayId && String(displayId).includes('@c.us')) ? String(displayId).split('@')[0] : ''
            );
            const byDigits = guessDigits ? contactIndex.byDigits.get(guessDigits) : null;
            if (byDigits && typeof byDigits === 'object') {
                mergedContact = { ...byDigits, ...savedContact };
            }
        } catch (e) {
            mergedContact = savedContact;
        }

        try {
            let contact = null;
            try {
                contact = await sessionData.client.getContactById(resolvedId);
            } catch (e) {
                try {
                    const chat = await sessionData.client.getChatById(resolvedId);
                    contact = await chat.getContact();
                } catch (e2) {}
            }

            let profilePic = contact ? await contact.getProfilePicUrl().catch(() => null) : null;
            if (!profilePic) {
                profilePic = await safeGetProfilePicUrl(sessionData.client, resolvedId).catch(() => null);
            }
            if (!profilePic) {
                try {
                    const chat = await sessionData.client.getChatById(resolvedId);
                    if (chat && typeof chat.getProfilePicUrl === 'function') {
                        profilePic = await chat.getProfilePicUrl().catch(() => null);
                    }
                } catch (e) {}
            }
            const about = contact ? await contact.getAbout().catch(() => null) : null;

            let rawNumber = contact && contact.number ? String(contact.number) : '';
            if (!rawNumber) {
                if (resolvedId.includes('@c.us')) rawNumber = resolvedId.split('@')[0];
            }
            if (!rawNumber) {
                rawNumber = extractPhoneDigits(mergedContact.waNumber || mergedContact.phoneNumber || '') || '';
            }

            const cleanNumber = rawNumber ? rawNumber.replace(/\D/g, '') : '';
            let formattedNumber = cleanNumber ? `+${cleanNumber}` : '';
            if (cleanNumber.startsWith('55') && cleanNumber.length >= 12) {
                const match = cleanNumber.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
                if (match) {
                    formattedNumber = `+55 (${match[1]}) ${match[2]}-${match[3]}`;
                } else {
                    formattedNumber = `+${cleanNumber}`;
                }
            }

            if (!formattedNumber && displayId.includes('@')) {
                const fallback = extractPhoneDigits(displayId.split('@')[0]);
                if (fallback) formattedNumber = `+${fallback}`;
            }

            if (cleanNumber) {
                const updated = {
                    ...mergedContact,
                    waNumber: cleanNumber,
                    waChatId: resolvedId,
                    updatedAt: Date.now()
                };
                if (!contacts[sessionId]) contacts[sessionId] = {};
                if (!contacts[sessionId][displayId]) contacts[sessionId][displayId] = {};
                contacts[sessionId][displayId] = { ...contacts[sessionId][displayId], ...updated };
                saveContacts(contacts);
            }

            const contactIdSerialized = contact && contact.id && contact.id._serialized ? String(contact.id._serialized) : resolvedId;
            const waName = contact ? (contact.name || contact.pushname || '') : '';
            const displayNameFallback = formattedNumber || (cleanNumber ? `+${cleanNumber}` : '') || displayId;

            socket.emit('contact-details', {
                chatId: displayId,
                id: contactIdSerialized,
                displayId,
                resolvedId,
                name: mergedContact.name || waName || displayNameFallback,
                pushname: contact ? contact.pushname : '',
                number: formattedNumber || displayNameFallback,
                rawNumber: cleanNumber || rawNumber || '',
                profilePic: profilePic,
                about: about || '',
                notes: mergedContact.notes || '',
                priority: mergedContact.priority || 'normal'
            });
        } catch (error) {
            console.error('Error fetching contact details:', error);
            socket.emit('contact-details-error', { chatId: displayId, error: 'Erro ao buscar detalhes do contato.' });
        }
    });

    // Save Contact Custom Name
    socket.on('save-contact', async ({ sessionId, chatId, name, notes, priority, phone, identity }) => {
        const contacts = loadContacts();
        if (!contacts[sessionId]) contacts[sessionId] = {};
        
        let resolvedId = String(chatId || '');
        try {
            const sessionData = activeClients.get(sessionId);
            if (sessionData && sessionData.client) {
                resolvedId = await resolveChatIdForClient(sessionData.client, resolvedId);
            }
        } catch (e) {}

        let waNumber = '';
        try {
            if (resolvedId.includes('@c.us')) waNumber = extractPhoneDigits(resolvedId.split('@')[0]);
        } catch (e) {}

        const record = {
            name,
            notes,
            priority,
            phone,
            identityNumber: identity,
            waChatId: resolvedId,
            waNumber,
            updatedAt: Date.now()
        };

        const maybeUser = socket && socket.data && socket.data.userId ? getUserById(socket.data.userId) : null;
        if (maybeUser && getGoogleAuthFromUser(maybeUser) && (name || waNumber)) {
            try {
                const ph = waNumber ? `+${waNumber}` : '';
                const r = await createGoogleContactForUser(maybeUser, { name: name || ph, phone: ph, email: '' });
                if (r && r.ok) {
                    record.googleResourceName = r.resourceName || '';
                    record.googleEtag = r.etag || '';
                }
            } catch (e) {}
        }

        contacts[sessionId][chatId] = record;
        saveContacts(contacts);
        
        // Also update Kanban for backward compatibility/display in board
        const kanbanData = loadKanbanData();
        if (!kanbanData[sessionId]) kanbanData[sessionId] = {};
        if (kanbanData[sessionId][chatId]) {
             kanbanData[sessionId][chatId].customName = name;
             saveKanbanData(kanbanData);
        }
        
        socket.emit('contact-saved', { chatId, name });
    });

    // Export Contacts to CSV
    socket.on('export-contacts', ({ sessionId }) => {
        try {
            const contacts = loadContacts();
            const sessionContacts = contacts[sessionId] || {};
            
            // We also want to include contacts from Kanban that might not have "saved" details but are in the pipeline
            const kanbanData = loadKanbanData();
            const sessionKanban = kanbanData[sessionId] || {};
            
            // Merge unique chatIds
            const allChatIds = new Set([...Object.keys(sessionContacts), ...Object.keys(sessionKanban)]);
            
            const csvRows = [];
            // Header
            csvRows.push(['Name', 'Given Name', 'Additional Name', 'Family Name', 'Yomi Name', 'Given Name Yomi', 'Additional Name Yomi', 'Family Name Yomi', 'Name Prefix', 'Name Suffix', 'Initials', 'Nickname', 'Short Name', 'Maiden Name', 'Birthday', 'Gender', 'Location', 'Billing Information', 'Directory Server', 'Mileage', 'Occupation', 'Hobby', 'Sensitivity', 'Priority', 'Subject', 'Notes', 'Language', 'Photo', 'Group Membership', 'E-mail 1 - Type', 'E-mail 1 - Value', 'Phone 1 - Type', 'Phone 1 - Value', 'Organization 1 - Type', 'Organization 1 - Name', 'Organization 1 - Yomi Name', 'Organization 1 - Title', 'Organization 1 - Department', 'Organization 1 - Symbol', 'Organization 1 - Location', 'Organization 1 - Job Description', 'Website 1 - Type', 'Website 1 - Value']);
            
            allChatIds.forEach(chatId => {
                const saved = sessionContacts[chatId] || {};
                const kanban = sessionKanban[chatId] || {};
                
                // Try to extract number from chatId if possible (e.g. 555199999999@c.us)
                let phoneNumber = '';
                const preferredDigits = extractPhoneDigits(saved.waNumber || saved.phoneNumber || saved.waChatId || chatId);
                if (preferredDigits) {
                    if (preferredDigits.startsWith('55') && preferredDigits.length >= 12) {
                        const match = preferredDigits.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
                        if (match) {
                            phoneNumber = `+55 ${match[1]} ${match[2]}-${match[3]}`;
                        } else {
                            phoneNumber = `+${preferredDigits}`;
                        }
                    } else {
                        phoneNumber = `+${preferredDigits}`;
                    }
                }
                
                const name = saved.name || kanban.customName || phoneNumber || 'Sem Nome';
                const notes = saved.notes || '';
                
                // Map to Google CSV Columns (approximate)
                // Name, ..., Notes, ..., Phone 1 - Type, Phone 1 - Value
                
                // Construct row with empty values for unused columns
                const row = new Array(43).fill('');
                row[0] = name; // Name
                row[25] = notes; // Notes
                row[31] = 'Mobile'; // Phone 1 - Type
                row[32] = phoneNumber; // Phone 1 - Value
                
                // Escape quotes
                const escapedRow = row.map(field => {
                    const stringField = String(field || '');
                    if (stringField.includes(',') || stringField.includes('"') || stringField.includes('\n')) {
                        return `"${stringField.replace(/"/g, '""')}"`;
                    }
                    return stringField;
                });
                
                csvRows.push(escapedRow);
            });
            
            const csvContent = csvRows.join('\n');
            socket.emit('contacts-exported', { csvContent, filename: `contacts_export_${Date.now()}.csv` });
            
        } catch (error) {
            console.error('Error exporting contacts:', error);
            socket.emit('error', 'Erro ao exportar contatos');
        }
    });

    socket.on('mark-chat-read', ({ sessionId, chatId }) => {
        try {
            if (!sessionId || !chatId) return;
            const cache = loadChatCache(sessionId);
            const list = Array.isArray(cache) ? cache : [];
            let changed = false;
            for (const item of list) {
                if (!item) continue;
                const matches = collectPossibleChatIds(sessionId, item.id || '').includes(String(chatId))
                    || collectPossibleChatIds(sessionId, chatId).includes(String(item.id || ''));
                if (matches && Number(item.unreadCount || 0) !== 0) {
                    item.unreadCount = 0;
                    changed = true;
                }
            }
            if (changed) saveChatCache(sessionId, list);
        } catch (error) {
            console.error('Error marking chat as read:', error);
        }
    });

    // Get chat history
    socket.on('get-chat-history', async ({ sessionId, chatId, limit = 100, fullHistory = false, daysBack = 2 }) => {
        let sessionData = ensureSessionClientOnDemand(sessionId, {
            forceResume: String(sessionId) === ADMIN_SELF_SESSION_ID
        }) || activeClients.get(sessionId);
        const originalChatId = chatId;
        try {
            console.log(`Fetching history for ${chatId} with limit ${limit}`);
            const timeout = (ms, label) => new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms));

            let effectiveChatId = chatId;
            if (sessionData && sessionData.client && String(chatId || '').endsWith('@lid')) {
                try {
                    const cached = loadChatCache(sessionId);
                    const list = Array.isArray(cached) ? cached : [];
                    const item = list.find(c => c && String(c.id) === String(chatId));
                    const digits = extractPhoneDigits(item && (item.phoneNumber || item.name));
                    if (digits) {
                        const idResult = await Promise.race([
                            sessionData.client.getNumberId(digits),
                            timeout(8000, 'Timeout getting number id')
                        ]);
                        if (idResult && idResult._serialized) {
                            effectiveChatId = String(idResult._serialized);
                        } else {
                            effectiveChatId = `${digits}@c.us`;
                        }
                    }
                } catch (e) {}
            }

            if (sessionData && sessionData.client && String(effectiveChatId) === String(chatId)) {
                effectiveChatId = sessionData.client && sessionData.client.__provider === 'evolution'
                    ? await resolveEvolutionSendTarget(sessionId, chatId)
                    : await resolveChatIdForClient(sessionData.client, chatId);
            }

            const candidateHistoryIds = collectPossibleChatIds(sessionId, effectiveChatId || originalChatId);
            if (!candidateHistoryIds.includes(originalChatId)) candidateHistoryIds.unshift(String(originalChatId));

            if (String(effectiveChatId) !== String(chatId)) {
                console.log(`[get-chat-history] resolved ${chatId} -> ${effectiveChatId}`);
            }
            let chat = null;



            // 1. Load Local History
            let localHistory = [];
            for (const candidateId of candidateHistoryIds) {
                const file = getHistoryFilePath(sessionId, candidateId);
                if (fs.existsSync(file)) {
                    try {
                        const raw = fs.readFileSync(file, 'utf8');
                        localHistory = JSON.parse(raw);
                        console.log(`[get-chat-history] Loaded ${localHistory.length} local messages for ${candidateId}`);
                        if (Array.isArray(localHistory) && localHistory.length > 0) break;
                    } catch (e) {
                        console.error('Error reading local history:', e);
                    }
                }
            }
            if (!Array.isArray(localHistory) || localHistory.length === 0) {
                const archived = loadArchiveFallback(sessionId, candidateHistoryIds);
                if (Array.isArray(archived.messages) && archived.messages.length > 0) {
                    localHistory = archived.messages;
                    console.log(`[get-chat-history] Loaded ${localHistory.length} archived messages for ${originalChatId}`);
                }
            }
            if (!Array.isArray(localHistory) || localHistory.length === 0) {
                console.log(`[get-chat-history] No local history file for ${originalChatId}`);
            }

            const mergedMap = new Map();

            if (Array.isArray(localHistory)) {
                localHistory.forEach(msg => {
                    if (msg && msg.id) {
                        mergedMap.set(msg.id, {
                            ...msg,
                            timestamp: normalizeEvolutionTimestamp(msg.timestamp)
                        });
                    }
                });
            }

            // 2. Fetch Remote History
            let remoteMessages = [];
            let remoteChatIdForLookup = effectiveChatId || originalChatId;
            if (hasReadyClient(sessionData)) {
                try {
                    const remoteChatId = sessionData.client && sessionData.client.__provider === 'evolution'
                        ? await resolveEvolutionSendTarget(sessionId, effectiveChatId || originalChatId)
                        : await resolveChatIdForClient(sessionData.client, effectiveChatId || originalChatId);
                    remoteChatIdForLookup = remoteChatId;
                    console.log(`[get-chat-history] Fetching remote for ${remoteChatId} (Original: ${originalChatId})`);
                    
                    // Assign to outer chat variable with timeout
                    chat = await Promise.race([
                        sessionData.client.getChatById(remoteChatId),
                        timeout(5000, 'Timeout getting chat')
                    ]);
                    
                    // Pull a larger window so chats reopened from cache/history don't look empty.
                    const fetchLimit = fullHistory ? Math.max(limit || 0, 1000) : Math.max(limit || 0, 300);
                    const messages = await Promise.race([
                        chat.fetchMessages({ limit: fetchLimit }),
                        timeout(10000, 'Timeout fetching messages')
                    ]);
                    
                    console.log(`[get-chat-history] Fetched ${messages.length} remote messages`);

                    remoteMessages = messages.map(msg => ({
                        id: msg.id._serialized,
                        body: msg.body,
                        from: msg.from,
                        to: msg.to,
                        timestamp: normalizeEvolutionTimestamp(msg.timestamp),
                        fromMe: msg.fromMe,
                        type: msg.type,
                        hasMedia: msg.hasMedia,
                        ack: msg.ack
                    }));
                } catch (e) {
                    console.error('Error fetching remote history (continuing with local):', e);
                }
            }

            // Merge Remote
            remoteMessages.forEach(msg => {
                mergedMap.set(msg.id, msg);
            });

            // 3. Fallback: Check if Chat object has a `lastMessage` that is NEWER than anything we have
            // This fixes the issue where sidebar shows "TESTE" but history is stale
            try {
                if (chat && chat.lastMessage) {
                    const lm = chat.lastMessage;
                    // Handle case where lastMessage is the object itself (standard)
                    if (typeof lm === 'object' && lm.body !== undefined) {
                        const lmId = lm.id && lm.id._serialized ? lm.id._serialized : null;
                        
                        // If we have an ID
                        if (lmId) {
                            const existing = mergedMap.get(lmId);
                            const safeTimestamp = typeof lm.timestamp === 'number' ? lm.timestamp : Math.floor(Date.now() / 1000);
                            
                            // If it doesn't exist, add it
                            if (!existing) {
                                console.log(`[get-chat-history] Appending missing lastMessage: ${lmId} - ${lm.body}`);
                                mergedMap.set(lmId, {
                                    id: lmId,
                                    body: lm.body,
                                    from: lm.from,
                                    to: lm.to,
                                    timestamp: safeTimestamp,
                                    fromMe: lm.fromMe,
                                    type: lm.type,
                                    hasMedia: lm.hasMedia,
                                    ack: lm.ack
                                });
                            }
                            // If it exists but body is empty and fallback has body, update it
                            else if ((!existing.body) && lm.body) {
                                console.log(`[get-chat-history] Updating empty message body from lastMessage: ${lmId}`);
                                existing.body = lm.body;
                                existing.timestamp = existing.timestamp || safeTimestamp;
                                mergedMap.set(lmId, existing);
                            }
                        }
                    }
                    else if ((typeof lm === 'string' && lm.trim()) || (chat && chat.lastMessage && chat.lastMessage.body)) {
                        const fallbackBody = typeof lm === 'string' ? lm.trim() : String(chat.lastMessage.body || '').trim();
                        if (fallbackBody) {
                            const fallbackId = `fallback-${String(originalChatId)}-${Number(chat.timestamp || Math.floor(Date.now() / 1000))}`;
                            if (!mergedMap.has(fallbackId)) {
                                console.log(`[get-chat-history] Appending string lastMessage fallback for ${originalChatId}`);
                                mergedMap.set(fallbackId, {
                                    id: fallbackId,
                                    body: fallbackBody,
                                    from: originalChatId,
                                    to: originalChatId,
                                    timestamp: Number(chat.timestamp || Math.floor(Date.now() / 1000)),
                                    fromMe: false,
                                    type: 'chat',
                                    hasMedia: false,
                                    ack: 0
                                });
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('Error checking lastMessage fallback:', e);
            }

            if (mergedMap.size === 0) {
                const cachedChat = getCachedChatByAnyId(sessionId, effectiveChatId || originalChatId);
                const cachedPreview = getChatPreviewSafe(cachedChat && cachedChat.lastMessage);
                const cachedTs = normalizeEvolutionTimestamp(cachedChat && cachedChat.timestamp);
                if (cachedChat && cachedPreview) {
                    mergedMap.set(`cache-preview-${String(cachedChat.id || originalChatId)}-${cachedTs}`, {
                        id: `cache-preview-${String(cachedChat.id || originalChatId)}-${cachedTs}`,
                        body: cachedPreview,
                        from: String(cachedChat.id || originalChatId),
                        to: String(cachedChat.id || originalChatId),
                        timestamp: cachedTs,
                        fromMe: false,
                        type: 'chat',
                        hasMedia: false,
                        ack: 0
                    });
                }
            }

            // Convert to array and sort
            let allSortedMessages = Array.from(mergedMap.values()).map(msg => ({
                ...msg,
                timestamp: normalizeEvolutionTimestamp(msg.timestamp)
            })).sort((a, b) => {
                const tA = typeof a.timestamp === 'number' ? a.timestamp : 0;
                const tB = typeof b.timestamp === 'number' ? b.timestamp : 0;
                return tA - tB;
            });
            
            console.log(`[get-chat-history] Total merged messages: ${allSortedMessages.length}`);

            // PERSIST MERGED HISTORY
            // This ensures that messages fetched from remote or fallback are saved locally.
            // This fixes "what had before" disappearing on refresh.
            try {
                // Keep last 500 to match saveMessageToHistory limit
                const toSave = allSortedMessages.slice(-500);
                const saveIds = Array.from(new Set([originalChatId, effectiveChatId].filter(Boolean).map(v => String(v))));
                for (const saveId of saveIds) {
                    const saveFile = getHistoryFilePath(sessionId, saveId);
                    fs.writeFileSync(saveFile, JSON.stringify(toSave, null, 2));
                }
            } catch (err) {
                console.error('Error saving merged history:', err);
            }

            try {
                const cached = getCachedChatByAnyId(sessionId, originalChatId);
                if (!cached || !cached.profilePic) {
                    let profilePic = null;
                    if (chat && typeof chat.getProfilePicUrl === 'function') {
                        profilePic = await Promise.race([
                            chat.getProfilePicUrl(),
                            timeout(5000, 'Timeout getting profile pic from chat-history')
                        ]).catch(() => null);
                    }
                    if (!profilePic) {
                        profilePic = await safeGetProfilePicUrl(sessionData.client, remoteChatIdForLookup).catch(() => null);
                    }
                    const cleanProfilePic = sanitizeEvolutionUrl(profilePic);
                    if (cleanProfilePic) {
                        const updated = loadChatCache(sessionId);
                        const list = Array.isArray(updated) ? updated : [];
                        const item = list.find(c => c && String(c.id) === String(originalChatId));
                        if (item && item.profilePic !== cleanProfilePic) {
                            item.profilePic = cleanProfilePic;
                            saveChatCache(sessionId, list);
                        }
                        emitToSessionClients(sessionId, 'profile-pic-updated', { chatId: originalChatId, profilePic: cleanProfilePic });
                    }
                }
            } catch (e) {}
            
            const normalizedDaysBack = Math.max(1, Number(daysBack) || 2);
            const cutoffTimestamp = Math.floor(Date.now() / 1000) - (normalizedDaysBack * 86400);
            const recentMessages = fullHistory
                ? allSortedMessages
                : allSortedMessages.filter(msg => Number(msg.timestamp || 0) >= cutoffTimestamp);
            const hasOlderMessages = !fullHistory && recentMessages.length < allSortedMessages.length;

            // Apply limit only to the recent mode so "ver histórico completo" can really expand.
            let finalMessages = fullHistory ? allSortedMessages : recentMessages;
            if (!fullHistory && limit && finalMessages.length > limit) {
                finalMessages = finalMessages.slice(-limit);
            }
            if (!fullHistory && finalMessages.length === 0 && allSortedMessages.length > 0) {
                finalMessages = allSortedMessages.slice(-Math.max(limit || 0, 100));
            }

            const transcriptsStore = loadAiTranscripts();
            const sessionTranscripts = transcriptsStore && transcriptsStore[sessionId] ? transcriptsStore[sessionId] : {};
            
            socket.emit('chat-history', {
                chatId: originalChatId,
                historyMode: fullHistory ? 'full' : 'recent',
                hasOlderMessages,
                daysBack: normalizedDaysBack,
                totalMessages: allSortedMessages.length,
                notReady: !(sessionData && sessionData.client),
                messages: finalMessages.map(msg => ({
                    id: msg.id,
                    body: msg.body,
                    from: msg.from,
                    to: msg.to,
                    timestamp: msg.timestamp,
                    fromMe: msg.fromMe,
                    type: msg.type,
                    hasMedia: msg.hasMedia,
                    ack: msg.ack,
                    media: msg.media, // Include media data if available
                    transcript: sessionTranscripts && sessionTranscripts[msg.id] ? sessionTranscripts[msg.id].transcript : undefined
                }))
            });
        } catch (error) {
            console.error('Error fetching chat history:', error);
            const status = sessionData ? sessionData.status : undefined;
            const msg = error && (error.message || String(error));
            const transient =
                !sessionData ||
                !sessionData.client ||
                (typeof msg === 'string' && (
                    msg.includes('Timeout') ||
                    msg.includes('Target closed') ||
                    msg.includes('Execution context was destroyed') ||
                    msg.includes('Protocol error') ||
                    msg.includes('Session closed') ||
                    msg.includes('Evaluation failed') ||
                    msg.includes('Cannot read properties') ||
                    msg.includes('Cannot read property')
                ));

            if (transient && isConnectedLikeStatus(status)) {
                socket.emit('chat-history', { chatId: originalChatId, messages: [], notReady: true });
            } else {
                socket.emit('chat-history', { chatId: originalChatId, messages: [], error: 'Error fetching chat history' });
            }
        }
    });

    // Get Message Media (On Demand)
    socket.on('get-message-media', async ({ sessionId, chatId, messageId }) => {
        const sessionData = activeClients.get(sessionId);
        if (hasReadyClient(sessionData)) {
            try {
                // We need to find the message object. 
                // Since we don't have getMessageById directly on client in all versions, 
                // we'll try to fetch messages from the chat and find it.
                // This is a bit expensive but works.
                const effectiveChatId = await resolveChatIdForClient(sessionData.client, chatId);
                const chat = await sessionData.client.getChatById(effectiveChatId);
                // Fetch a reasonable amount to find the message (e.g. 50 around it? 
                // actually fetchMessages usually fetches latest. 
                // If it's old, we might miss it. 
                // But for now let's assume it's in the recent history or we fetch more.)
                
                // Optimized: Try to use search if available or just fetch last 100
                // We increase limit to ensure we find the message if it's in the loaded history
                const messages = await chat.fetchMessages({ limit: 500 }); 
                const msg = messages.find(m => m.id._serialized === messageId);
                
                if (msg && msg.hasMedia) {
                    const media = await msg.downloadMedia();
                    if (media) {
                         socket.emit('message-media-loaded', {
                             messageId,
                             media: {
                                 mimetype: media.mimetype,
                                 data: media.data,
                                 filename: media.filename
                             }
                         });
                    } else {
                        socket.emit('media-fetch-error', { messageId, error: 'Media not found or expired' });
                    }
                } else {
                     // Try searching deeper if not found? For now just fail.
                     socket.emit('media-fetch-error', { messageId, error: 'Message not found in recent history' });
                }
            } catch (error) {
                console.error('Error fetching message media:', error);
                socket.emit('media-fetch-error', { messageId, error: error.message });
            }
        }
    });

    // Send message
    socket.on('send-message', async ({ sessionId, chatId, message, isNewContact, tempId }) => {
        const sessionData = activeClients.get(sessionId);
        if (hasReadyClient(sessionData)) {
            try {
                let targetId = chatId;
                
                // If it's a new contact (phone number), format it
                if (isNewContact) {
                    // Remove non-numeric characters
                    const cleanNumber = chatId.replace(/\D/g, '');
                    targetId = `${cleanNumber}@c.us`;
                } else {
                    targetId = sessionData.client && sessionData.client.__provider === 'evolution'
                        ? await resolveEvolutionSendTarget(sessionId, targetId)
                        : await resolveChatIdForClient(sessionData.client, targetId);
                }

                if (sessionData.client && sessionData.client.__provider === 'evolution') {
                    console.log('[evolution-send-attempt]', JSON.stringify({
                        sessionId,
                        originalChatId: chatId,
                        targetId,
                        isNewContact: !!isNewContact,
                        messagePreview: String(message || '').slice(0, 120)
                    }));
                }

                const sentMsg = await sessionData.client.sendMessage(targetId, message);
                socket.emit('message-sent', {
                    chatId: targetId,
                    originalChatId: chatId,
                    tempId: tempId || null,
                    message: {
                        id: sentMsg.id._serialized,
                        body: sentMsg.body,
                        from: sentMsg.from,
                        to: sentMsg.to,
                        timestamp: sentMsg.timestamp,
                        fromMe: sentMsg.fromMe,
                        type: sentMsg.type,
                        ack: typeof sentMsg.ack === 'number' ? sentMsg.ack : 1
                    }
                });
                await handleSentMessage(sessionId, sentMsg, sessionData.client);

                // If it was a new contact, we might need to trigger a chat refresh or add it to Kanban
                if (isNewContact) {
                     // Wait a bit for the chat to be created in WA
                    setTimeout(async () => {
                         try {
                            const chat = await sentMsg.getChat();
                            // Update Kanban status for this new chat
                            const kanbanData = loadKanbanData();
                            if (!kanbanData[sessionId]) kanbanData[sessionId] = {};
                            
                            kanbanData[sessionId][chat.id._serialized] = {
                                status: 'todo',
                                tags: ['new']
                            };
                            saveKanbanData(kanbanData);
                         } catch (e) {
                             console.error("Error updating kanban for new chat", e);
                         }
                    }, 1000);
                }

            } catch (error) {
                console.error('[send-message-error]', JSON.stringify({
                    message: error?.message,
                    chatId,
                    targetId: typeof targetId === 'string' ? targetId : '',
                    provider: sessionData?.client?.__provider || '',
                    stack: error?.stack || '',
                    evolutionResponse: error?.evolutionResponse || error?.response?.data || null
                }));
                socket.emit('error', 'Error sending message: ' + error.message);
            }
        }
    });

    socket.on('send-media', async ({ sessionId, chatId, path: relPath, caption, sendMediaAsDocument, sendAudioAsVoice, isNewContact }) => {
        const sessionData = activeClients.get(sessionId);
        if (hasReadyClient(sessionData)) {
            try {
                const { MessageMedia } = require('whatsapp-web.js');

                let targetId = chatId;
                if (isNewContact) {
                    const cleanNumber = String(chatId || '').replace(/\D/g, '');
                    targetId = `${cleanNumber}@c.us`;
                }

                targetId = sessionData.client && sessionData.client.__provider === 'evolution'
                    ? await resolveEvolutionSendTarget(sessionId, targetId)
                    : await resolveChatIdForClient(sessionData.client, targetId);

                const rawRel = typeof relPath === 'string' ? relPath : '';
                const safeRel = rawRel.replace(/^[/\\]+/, '');
                const publicRoot = path.resolve(PUBLIC_DIR);
                const fullPath = path.resolve(PUBLIC_DIR, safeRel);
                if (!fullPath.startsWith(publicRoot + path.sep)) {
                    throw new Error('Caminho inválido');
                }
                if (!fs.existsSync(fullPath)) {
                    throw new Error('Arquivo não encontrado');
                }

                const maxBytes = 16 * 1024 * 1024;
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat && stat.size > maxBytes) {
                        throw new Error('Arquivo excede 16MB');
                    }
                } catch (e) {
                    if (e && e.message) throw e;
                }

                let tempConvertedPath = null;

                async function maybeConvertVoiceNote(inputPath) {
                    const ext = path.extname(inputPath || '').toLowerCase();
                    if (ext === '.ogg') return inputPath;

                    const ffmpeg = require('fluent-ffmpeg');
                    try {
                        const ffmpegPath = require('ffmpeg-static');
                        if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
                    } catch (e) {
                        console.warn('ffmpeg-static not found, relying on system ffmpeg');
                    }

                    const outName = `ptt-${Date.now()}-${Math.random().toString(16).slice(2)}.ogg`;
                    const outPath = path.join(path.dirname(inputPath), outName);
                    await new Promise((resolve, reject) => {
                        ffmpeg(inputPath)
                            .noVideo()
                            .audioCodec('libopus')
                            .audioChannels(1)
                            .format('ogg')
                            .outputOptions(['-b:a 24k'])
                            .on('end', resolve)
                            .on('error', reject)
                            .save(outPath);
                    });
                    tempConvertedPath = outPath;
                    return outPath;
                }

                const options = {};
                if (sendAudioAsVoice) {
                    options.sendAudioAsVoice = true;
                    options.sendMediaAsDocument = false;
                } else if (typeof sendMediaAsDocument === 'boolean') {
                    options.sendMediaAsDocument = sendMediaAsDocument;
                }
                const cap = typeof caption === 'string' ? caption.trim() : '';
                if (cap) options.caption = cap;

                let chosenPath = fullPath;
                if (sendAudioAsVoice) {
                    try {
                        chosenPath = await maybeConvertVoiceNote(fullPath);
                    } catch (e) {
                        chosenPath = fullPath;
                    }
                }

                let sentMsg;
                let sentMediaPayload = null;
                try {
                    const media = MessageMedia.fromFilePath(chosenPath);
                    sentMediaPayload = {
                        mimetype: media.mimetype || 'application/octet-stream',
                        data: media.data || null,
                        filename: media.filename || path.basename(chosenPath)
                    };
                    sentMsg = await sessionData.client.sendMessage(targetId, media, options);
                } catch (e) {
                    if (sendAudioAsVoice) {
                        const fallbackMedia = MessageMedia.fromFilePath(fullPath);
                        sentMediaPayload = {
                            mimetype: fallbackMedia.mimetype || 'application/octet-stream',
                            data: fallbackMedia.data || null,
                            filename: fallbackMedia.filename || path.basename(fullPath)
                        };
                        const fallbackOptions = {};
                        if (cap) fallbackOptions.caption = cap;
                        fallbackOptions.sendMediaAsDocument = true;
                        sentMsg = await sessionData.client.sendMessage(targetId, fallbackMedia, fallbackOptions);
                    } else {
                        throw e;
                    }
                } finally {
                    if (tempConvertedPath) {
                        try { fs.unlinkSync(tempConvertedPath); } catch (e) {}
                    }
                }

                const fallbackBody = cap || (sendAudioAsVoice ? '🎤 Áudio' : (options.sendMediaAsDocument === false ? '📎 Mídia' : '📎 Arquivo'));
                socket.emit('message-sent', {
                    chatId: targetId,
                    message: {
                        id: sentMsg.id._serialized,
                        body: sentMsg.body || fallbackBody,
                        from: sentMsg.from,
                        to: sentMsg.to,
                        timestamp: sentMsg.timestamp,
                        fromMe: sentMsg.fromMe,
                        type: sentMsg.type,
                        hasMedia: !!sentMsg.hasMedia,
                        ack: typeof sentMsg.ack === 'number' ? sentMsg.ack : 1,
                        media: sentMediaPayload
                    }
                });
                if (sentMsg) {
                    await handleSentMessage(sessionId, sentMsg, sessionData.client, sentMediaPayload);
                }
            } catch (error) {
                console.error('Error sending media:', error);
                socket.emit('media-send-error', { sessionId, chatId, error: 'Erro ao enviar mídia: ' + (error && error.message ? error.message : 'Falha') });
            }
        }
    });
    
    // Schedule Message
    socket.on('schedule-message', ({ sessionId, chatId, message, timestamp, type, flowId }) => {
        if (!scheduledMessages[sessionId]) {
            scheduledMessages[sessionId] = [];
        }

        const kind = type === 'flow' ? 'flow' : 'text';
        const resolvedFlowId = kind === 'flow' ? flowId : null;
        let flowName = null;
        
        if (kind === 'flow' && resolvedFlowId) {
            const flows = loadFlows(sessionId);
            const flow = flows.find(f => String(f.id) === String(resolvedFlowId));
            if (flow) flowName = flow.name;
        }

        const newMessage = {
            id: Date.now() + Math.random().toString(36).substr(2, 9),
            chatId,
            type: kind,
            flowId: resolvedFlowId,
            flowName,
            body: kind === 'flow' ? '' : message,
            timestamp: parseInt(timestamp),
            createdAt: Date.now()
        };

        scheduledMessages[sessionId].push(newMessage);
        saveScheduledMessages(scheduledMessages);

        socket.emit('schedule-created', newMessage);
    });

    // Get Scheduled Messages
    socket.on('get-scheduled-messages', (sessionId) => {
        const messages = scheduledMessages[sessionId] || [];
        socket.emit('scheduled-messages-list', messages);
    });

    // Delete Scheduled Message
    socket.on('delete-scheduled-message', ({ sessionId, id }) => {
        if (scheduledMessages[sessionId]) {
            scheduledMessages[sessionId] = scheduledMessages[sessionId].filter(msg => msg.id !== id);
            saveScheduledMessages(scheduledMessages);
            socket.emit('scheduled-message-deleted', id);
        }
    });

    // --- TAGS MANAGEMENT ---
    socket.on('get-tags', (sessionId) => {
        const tags = loadTags(sessionId);
        // Send default tags if empty
        if (tags.length === 0) {
             const defaultTags = [
                { id: 'urgent', name: 'Urgente', color: '#ff4444' },
                { id: 'new', name: 'Novo Cliente', color: '#00C851' },
                { id: 'vip', name: 'VIP', color: '#ffbb33' },
                { id: 'pending', name: 'Pendente', color: '#33b5e5' }
            ];
            saveTags(sessionId, defaultTags);
            socket.emit('tags-list', { sessionId, tags: defaultTags });
        } else {
            socket.emit('tags-list', { sessionId, tags });
        }
    });

    socket.on('save-tags', ({ sessionId, tags }) => {
        saveTags(sessionId, tags);
        socket.emit('tags-list', { sessionId, tags });
        io.emit('tags-updated', { sessionId, tags });
    });

    // --- FLOWS MANAGEMENT ---
    socket.on('get-flows', (sessionId) => {
        const flows = loadFlows(sessionId);
        socket.emit('flows-list', flows);
        socket.emit('flow-usage', getAllFlowsUsage(sessionId));
    });

    socket.on('get-flow-usage', (payload, cb) => {
        const sessionId = payload && payload.sessionId ? payload.sessionId : null;
        const flowId = payload && payload.flowId !== undefined ? payload.flowId : null;
        let result;
        if (flowId) {
            const items = getFlowUsage(sessionId, flowId);
            result = {
                [String(flowId)]: {
                    count: items.length,
                    waitingCount: items.reduce((acc, it) => acc + (it.waiting ? 1 : 0), 0),
                    items
                }
            };
        } else {
            result = getAllFlowsUsage(sessionId);
        }
        if (typeof cb === 'function') cb({ ok: true, usage: result });
        socket.emit('flow-usage', result);
    });

    socket.on('delete-media', ({ sessionId, filename, fileKey }) => {
        const rawSessionId = sessionId ? String(sessionId) : '';
        const safeSessionId = rawSessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
        if (!safeSessionId) {
            socket.emit('media-delete-error', 'sessionId obrigatório');
            return;
        }

        const sessionDir = path.resolve(path.join(UPLOADS_DIR, safeSessionId));
        let key = fileKey ? String(fileKey) : (filename ? String(filename) : '');
        if (!key || key.includes('..') || path.isAbsolute(key)) {
            socket.emit('media-delete-error', 'Arquivo inválido');
            return;
        }

        if (!key.includes('/')) key = `${safeSessionId}/${key}`;
        if (!key.startsWith(`${safeSessionId}/`)) {
            socket.emit('media-delete-error', 'Arquivo inválido');
            return;
        }

        const candidate = path.resolve(path.join(UPLOADS_DIR, key));
        const filePath = candidate.startsWith(sessionDir) && fs.existsSync(candidate) ? candidate : null;

        if (!filePath) {
            socket.emit('media-delete-error', 'Arquivo não encontrado');
            return;
        }

        fs.unlink(filePath, (err) => {
            if (err) {
                console.error('Error deleting file:', err);
                socket.emit('media-delete-error', 'Erro ao excluir arquivo');
            } else {
                socket.emit('media-deleted');
            }
        });
    });

    socket.on('save-flow', ({ sessionId, flow }, cb) => {
        let flows = loadFlows(sessionId);
        if (!flow || typeof flow !== 'object') {
            if (typeof cb === 'function') cb({ ok: false, error: 'Fluxo inválido' });
            return;
        }
        flow = normalizeFlowDefinition(flow);
        
        const existingIndex = flows.findIndex(f => String(f.id) === String(flow.id));
        if (existingIndex >= 0) {
            const inUse = getFlowUsage(sessionId, flow.id);
            if (inUse.length > 0) {
                const payload = { ok: false, code: 'FLOW_IN_USE', flowId: flow.id, inUse };
                if (typeof cb === 'function') cb(payload);
                socket.emit('flow-save-blocked', payload);
                return;
            }
            flows[existingIndex] = flow;
        } else {
            flows.push(flow);
        }
        
        saveFlows(sessionId, flows);
        emitToSessionClients(sessionId, 'flows-list', flows);
        emitFlowUsage(sessionId);
        if (typeof cb === 'function') cb({ ok: true });
    });

    socket.on('stop-flow-instances', ({ sessionId, flowId }, cb) => {
        if (flowId === undefined || flowId === null) {
            if (typeof cb === 'function') cb({ ok: false, error: 'flowId obrigatório' });
            return;
        }
        const result = stopFlowInstances(sessionId, flowId);
        emitFlowUsage(sessionId);
        if (typeof cb === 'function') cb({ ok: true, ...result });
    });

    socket.on('stop-flow-chat', ({ sessionId, chatId, flowId }, cb) => {
        const result = stopFlowChat(sessionId, chatId, flowId);
        emitFlowUsage(sessionId);
        if (typeof cb === 'function') cb(result);
    });

    socket.on('delete-flow', ({ sessionId, flowId }, cb) => {
        let flows = loadFlows(sessionId);
        const inUse = getFlowUsage(sessionId, flowId);
        if (inUse.length > 0) {
            const payload = { ok: false, code: 'FLOW_IN_USE', flowId, inUse };
            if (typeof cb === 'function') cb(payload);
            socket.emit('flow-delete-blocked', payload);
            return;
        }
        flows = flows.filter(f => String(f.id) !== String(flowId));
        saveFlows(sessionId, flows);
        emitToSessionClients(sessionId, 'flows-list', flows);
        emitFlowUsage(sessionId);
        if (typeof cb === 'function') cb({ ok: true });
    });

    // --- WINBACK CAMPAIGNS ---
    socket.on('get-winback-campaigns', (sessionId) => {
        const campaigns = loadWinbackCampaigns();
        socket.emit('winback-campaigns-list', campaigns[sessionId] || []);
    });

    socket.on('get-winback-stats', (sessionId) => {
        const stats = loadWinbackStats();
        socket.emit('winback-stats-update', stats[sessionId] || { totalSent: 0, campaigns: {} });
    });

    socket.on('create-winback-campaign', ({ sessionId, targets, config }) => {
        if (!sessionId || !targets || !Array.isArray(targets) || targets.length === 0) return;

        const stats = loadWinbackStats();
        if (!stats[sessionId]) stats[sessionId] = { totalSent: 0, campaigns: {} };

        // Monthly Quota Reset
        const now = new Date();
        const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        
        if (stats[sessionId].lastMonth !== currentMonth) {
            stats[sessionId].totalSent = 0;
            stats[sessionId].lastMonth = currentMonth;
            saveWinbackStats(stats);
        }

        // Check Limits (100 per month)
        const currentTotal = stats[sessionId].totalSent || 0;
        if (currentTotal + targets.length > 100) {
            socket.emit('winback-error', { message: `Limite excedido! Você já enviou ${currentTotal} mensagens este mês e tentou agendar mais ${targets.length}. O limite mensal é 100.` });
            return;
        }

        const campaignId = Date.now().toString(36);
        const campaign = {
            id: campaignId,
            createdAt: Date.now(),
            targetsCount: targets.length,
            config,
            status: 'active'
        };

        const campaigns = loadWinbackCampaigns();
        if (!campaigns[sessionId]) campaigns[sessionId] = [];
        campaigns[sessionId].push(campaign);
        saveWinbackCampaigns(campaigns);

        if (!stats[sessionId].campaigns) stats[sessionId].campaigns = {};
        stats[sessionId].campaigns[campaignId] = { total: targets.length, sent: 0 };
        saveWinbackStats(stats);

        const scheduled = loadScheduledMessages();
        if (!scheduled[sessionId]) scheduled[sessionId] = [];

        const scheduledBaseTime = Date.now();
        const MS_PER_HOUR = 3600000;
        const MS_PER_DAY = 86400000;
        const MSGS_PER_DAY = 10;

        let scheduledCount = 0;
        targets.forEach((chatId, index) => {
            const dayIndex = Math.floor(index / MSGS_PER_DAY);
            const hourIndex = index % MSGS_PER_DAY;
            
            // Start from next hour
            const delay = (dayIndex * MS_PER_DAY) + (hourIndex * MS_PER_HOUR) + MS_PER_HOUR;
            const timestamp = scheduledBaseTime + delay;

            // AI Context Setup
            if (config.ai) {
                const aiStatus = loadAiChatStatus();
                if (!aiStatus[sessionId]) aiStatus[sessionId] = {};
                if (!aiStatus[sessionId][chatId]) aiStatus[sessionId][chatId] = {};
                
                aiStatus[sessionId][chatId].context = config.ai.context || '';
                aiStatus[sessionId][chatId].goal = config.ai.goal || '';
                aiStatus[sessionId][chatId].winbackCampaignId = campaignId;
                
                saveAiChatStatus(aiStatus);
            }

            const msg = {
                id: Date.now() + Math.random().toString(36),
                chatId,
                body: config.type === 'flow' ? '' : config.content,
                flowId: config.type === 'flow' ? config.content : undefined,
                timestamp,
                type: config.type,
                simulation: true,
                campaignId
            };
            
            scheduled[sessionId].push(msg);
            scheduledCount++;
        });

        saveScheduledMessages(scheduled);

        socket.emit('winback-campaign-created', { campaignId, scheduledCount });
        socket.emit('winback-campaigns-list', campaigns[sessionId]);
        io.to(`session:${sessionId}`).emit('winback-stats-update', stats[sessionId]);
        io.to(`session:${sessionId}`).emit('scheduled-messages-update', scheduled[sessionId]);
    });

    socket.on('bulk-delete-chats', ({ sessionId, chatIds }) => {
        try {
            const ids = Array.isArray(chatIds) ? chatIds.filter(Boolean).map(String) : [];
            const uniqueIds = Array.from(new Set(ids));
            if (!sessionId || uniqueIds.length === 0) return;

            const kanbanData = loadKanbanData();
            const contacts = loadContacts();
            const aiStatus = loadAiChatStatus();

            uniqueIds.forEach((chatId) => {
                if (kanbanData[sessionId] && kanbanData[sessionId][chatId]) delete kanbanData[sessionId][chatId];
                if (contacts[sessionId] && contacts[sessionId][chatId]) delete contacts[sessionId][chatId];
                if (aiStatus[sessionId] && aiStatus[sessionId][chatId]) delete aiStatus[sessionId][chatId];
            });

            saveKanbanData(kanbanData);
            saveContacts(contacts);
            saveAiChatStatus(aiStatus);
            rememberDeletedChatIds(sessionId, uniqueIds);
            removeChatIdsFromCache(sessionId, uniqueIds);

            const sessionData = activeClients.get(sessionId);
            if (sessionData && sessionData.client) {
                uniqueIds.forEach((chatId) => {
                    deleteChatOnWhatsApp(sessionData.client, sessionId, chatId).catch(() => null);
                });
            }

            console.log(`Bulk deleted ${uniqueIds.length} chats for session ${sessionId}`);
            socket.emit('chats-deleted', uniqueIds);
        } catch (error) {
            console.error('Error handling bulk-delete-chats:', error);
        }
    });

    socket.on('delete-chat', ({ sessionId, chatId }) => {
        try {
            const id = String(chatId || '').trim();
            if (!sessionId || !id) return;
            // 1. Remove from Kanban (sessionKanban)
            const kanbanData = loadKanbanData();
            if (kanbanData[sessionId] && kanbanData[sessionId][id]) {
                delete kanbanData[sessionId][id];
                saveKanbanData(kanbanData);
            }

            // 2. Remove from Contacts (optional, but good for cleanup)
            const contacts = loadContacts();
            if (contacts[sessionId] && contacts[sessionId][id]) {
                delete contacts[sessionId][id];
                saveContacts(contacts);
            }

            // 3. Remove from AI Status (optional)
            const aiStatus = loadAiChatStatus();
            if (aiStatus[sessionId] && aiStatus[sessionId][id]) {
                delete aiStatus[sessionId][id];
                saveAiChatStatus(aiStatus);
            }

            rememberDeletedChatIds(sessionId, [id]);
            removeChatIdsFromCache(sessionId, [id]);

            // 4. Try to delete chat from WhatsApp (Phone)
            // This is "dangerous" as it clears history, but requested "excluir ela dali"
            // Usually we just stop tracking, but let's see if we can delete.
            // Client might not support full delete for everyone, but let's try delete().
            const sessionData = activeClients.get(sessionId);
            if (sessionData && sessionData.client) {
                deleteChatOnWhatsApp(sessionData.client, sessionId, id).catch(() => null);
            }

            console.log(`Chat ${id} deleted for session ${sessionId}`);
            // Broadcast deletion to update UI
            socket.emit('chat-deleted', id); // Confirm to sender
            // io.emit('chat-deleted', chatId); // Or broadcast if multiple tabs

        } catch (error) {
            console.error('Error handling delete-chat:', error);
        }
    });

    const handleManualFlowStart = ({ sessionId, chatId, flowId }, cb) => {
        if (!sessionId || !chatId || flowId === undefined || flowId === null) {
            if (typeof cb === 'function') cb({ ok: false, error: 'sessionId, chatId e flowId são obrigatórios' });
            return;
        }

        const flows = loadFlows(sessionId);
        const flow = flows.find(f => String(f.id) === String(flowId));
        if (!flow) {
            if (typeof cb === 'function') cb({ ok: false, error: 'Fluxo não encontrado' });
            return;
        }

        console.log(`Starting flow ${flow.name} manually for ${chatId}`);
        logFlowDebug(sessionId, chatId, flow, 0, 'manual_start_request', { sourceEvent: 'start-flow' });

        const sessionData = activeClients.get(sessionId);
        if (!hasReadyClient(sessionData)) {
            recordFlowExecutionHistory(sessionId, {
                flowId: flow.id,
                flowName: flow.name,
                chatId,
                status: 'error',
                action: 'start_failed',
                step: 0,
                message: 'Sessão não está pronta para iniciar fluxo',
                error: 'Sessão ainda não está pronta (sincronizando WhatsApp).'
            });
            emitFlowUsage(sessionId);
            if (typeof cb === 'function') cb({ ok: false, error: 'Sessão ainda não está pronta (sincronizando WhatsApp).' });
            return;
        }

        setActiveFlowState(sessionId, chatId, flow, { step: 0, waiting: false, action: 'manual_start' });
        recordFlowExecutionHistory(sessionId, {
            flowId: flow.id,
            flowName: flow.name,
            chatId,
            status: 'running',
            action: 'manual_start',
            step: 0,
            message: 'Fluxo iniciado manualmente'
        });
        logFlowDebug(sessionId, chatId, flow, 0, 'manual_start');
        emitFlowUsage(sessionId);

        if (typeof cb === 'function') cb({ ok: true });
        executeFlowStep(sessionId, chatId, flow, 0, sessionData.client);
    };

    socket.on('start-flow-manually', handleManualFlowStart);
    socket.on('start-flow', handleManualFlowStart);

    socket.on('get-system-stats', (cb) => {
        try {
            const stats = proxyManager.getStats();
            if (typeof cb === 'function') cb(stats);
        } catch (e) {
            if (typeof cb === 'function') cb({ error: e.message });
        }
    });

    // Desvincular socket
    socket.on('disconnect', () => {
        console.log('Cliente desconectado:', socket.id);
    });
});

// Iniciar servidor
function startServer() {
    server.listen(PORT);
}

server.on('listening', () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
    console.log(`Acesse http://localhost:${PORT} para gerenciar as conexões`);
});

server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.error(`Porta ${PORT} em uso. Tentando novamente em 1s...`);
        setTimeout(() => {
            try {
                startServer();
            } catch (e) {
                console.error('Erro ao tentar subir servidor novamente:', e);
            }
        }, 1000);
        return;
    }
    console.error('Erro no servidor HTTP:', err);
    setTimeout(() => process.exit(1), 250);
});

startServer();
