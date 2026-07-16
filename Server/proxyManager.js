const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const PROXY_FILE = path.join(DATA_DIR, 'proxy_sessions.json');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function buildEmptyState() {
    return {
        proxys: [],
        history: [],
        sessionAssignments: {}
    };
}

function normalizeInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function normalizeText(value) {
    return String(value || '').trim();
}

function normalizeProxy(proxy) {
    const id = normalizeText(proxy && proxy.id) || `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const assigned = Array.isArray(proxy && proxy.assigned)
        ? proxy.assigned
            .map(item => ({
                userId: normalizeText(item && item.userId),
                userLabel: normalizeText(item && item.userLabel),
                at: Number(item && item.at) || Date.now()
            }))
            .filter(item => item.userId)
        : [];
    return {
        id,
        name: normalizeText(proxy && proxy.name) || id,
        host: normalizeText(proxy && proxy.host),
        port: normalizeText(proxy && proxy.port),
        username: normalizeText(proxy && proxy.username),
        password: normalizeText(proxy && proxy.password),
        auth: normalizeText(proxy && proxy.auth) || 'HTTP',
        ipType: normalizeText(proxy && proxy.ipType),
        deliveryDate: normalizeText(proxy && proxy.deliveryDate),
        expiryDate: normalizeText(proxy && proxy.expiryDate),
        status: normalizeText(proxy && proxy.status) || 'Disponível',
        profile: normalizeText(proxy && proxy.profile),
        limit: normalizeInt(proxy && proxy.limit, 1),
        assigned,
        createdAt: Number(proxy && proxy.createdAt) || Date.now()
    };
}

function normalizeState(input) {
    const state = input && typeof input === 'object' ? input : {};
    const proxys = Array.isArray(state.proxys) ? state.proxys.map(normalizeProxy) : [];
    const history = Array.isArray(state.history)
        ? state.history.map(item => ({
            type: normalizeText(item && item.type) || 'assign',
            proxyId: normalizeText(item && item.proxyId),
            proxyName: normalizeText(item && item.proxyName),
            userId: normalizeText(item && item.userId),
            userLabel: normalizeText(item && item.userLabel),
            reason: normalizeText(item && item.reason),
            at: Number(item && item.at) || Date.now()
        })).filter(item => item.proxyId || item.userId)
        : [];
    const sessionAssignments = {};
    for (const proxy of proxys) {
        for (const item of proxy.assigned) {
            if (item.userId) {
                sessionAssignments[item.userId] = proxy.id;
            }
        }
    }
    return { proxys, history, sessionAssignments };
}

function loadData() {
    if (!fs.existsSync(PROXY_FILE)) {
        return buildEmptyState();
    }
    try {
        const raw = JSON.parse(fs.readFileSync(PROXY_FILE, 'utf8'));
        if (raw && Array.isArray(raw.proxys)) {
            return normalizeState(raw);
        }
        // Legacy format fallback
        return buildEmptyState();
    } catch (e) {
        console.error('Error loading proxy data:', e);
        return buildEmptyState();
    }
}

function saveData(data) {
    try {
        fs.writeFileSync(PROXY_FILE, JSON.stringify(normalizeState(data), null, 2));
    } catch (e) {
        console.error('Error saving proxy data:', e);
    }
}

function isProxyUsable(proxy) {
    if (!proxy) return false;
    const status = normalizeText(proxy.status).toLowerCase();
    if (!proxy.host || !proxy.port) return false;
    if (status === 'pausado' || status === 'vencido') return false;
    return true;
}

function buildProxyConfig(proxy) {
    if (!proxy || !isProxyUsable(proxy)) return null;
    const protocolRaw = normalizeText(proxy.auth || 'HTTP').toLowerCase();
    const protocol = protocolRaw === 'https' ? 'https' : (protocolRaw === 'socks5' ? 'socks5' : (protocolRaw === 'socks4' ? 'socks4' : 'http'));
    return {
        id: proxy.id,
        name: proxy.name,
        host: proxy.host,
        port: String(proxy.port),
        username: proxy.username || '',
        password: proxy.password || '',
        protocol,
        proxyUrl: `${protocol}://${proxy.host}:${proxy.port}`,
        proxySessionId: proxy.id,
        isNew: false
    };
}

function ensureAssignmentLabel(proxy, waSessionId, userLabel) {
    if (!proxy) return false;
    proxy.assigned = Array.isArray(proxy.assigned) ? proxy.assigned : [];
    const existing = proxy.assigned.find(item => String(item.userId) === String(waSessionId));
    if (existing) {
        if (userLabel && existing.userLabel !== userLabel) {
            existing.userLabel = userLabel;
            return true;
        }
        return false;
    }
    proxy.assigned.push({
        userId: String(waSessionId),
        userLabel: userLabel || String(waSessionId),
        at: Date.now()
    });
    return true;
}

function recordHistory(state, entry) {
    state.history = Array.isArray(state.history) ? state.history : [];
    state.history.unshift({
        type: normalizeText(entry && entry.type) || 'assign',
        proxyId: normalizeText(entry && entry.proxyId),
        proxyName: normalizeText(entry && entry.proxyName),
        userId: normalizeText(entry && entry.userId),
        userLabel: normalizeText(entry && entry.userLabel),
        reason: normalizeText(entry && entry.reason),
        at: Number(entry && entry.at) || Date.now()
    });
    state.history = state.history.slice(0, 300);
}

function getAssignment(waSessionId, userLabel = '', excludeProxyId = null) {
    const sid = normalizeText(waSessionId);
    if (!sid) return null;

    const data = loadData();
    const mappedProxyId = normalizeText(data.sessionAssignments[sid]);
    if (mappedProxyId && (!excludeProxyId || mappedProxyId !== excludeProxyId)) {
        const proxy = data.proxys.find(item => item && item.id === mappedProxyId);
        if (proxy && isProxyUsable(proxy)) {
            const changed = ensureAssignmentLabel(proxy, sid, userLabel);
            if (changed) saveData(data);
            const config = buildProxyConfig(proxy);
            if (config) return { ...config, isNew: false };
        }
    }

    const candidates = data.proxys
        .filter(proxy => proxy && proxy.id !== excludeProxyId && isProxyUsable(proxy))
        .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    const target = candidates.find(proxy => (Array.isArray(proxy.assigned) ? proxy.assigned.length : 0) < normalizeInt(proxy.limit, 1));
    if (!target) return null;

    ensureAssignmentLabel(target, sid, userLabel);
    data.sessionAssignments[sid] = target.id;
    recordHistory(data, {
        type: 'assign',
        proxyId: target.id,
        proxyName: target.name,
        userId: sid,
        userLabel: userLabel || sid
    });
    saveData(data);
    const config = buildProxyConfig(target);
    return config ? { ...config, isNew: true } : null;
}

function releaseAssignment(waSessionId, reason = 'liberado') {
    const sid = normalizeText(waSessionId);
    if (!sid) return null;
    const data = loadData();
    const proxyId = normalizeText(data.sessionAssignments[sid]);
    if (!proxyId) return null;

    const proxy = data.proxys.find(item => item && item.id === proxyId);
    let removedLabel = sid;
    if (proxy) {
        const current = Array.isArray(proxy.assigned) ? proxy.assigned : [];
        const found = current.find(item => String(item.userId) === sid);
        if (found && found.userLabel) removedLabel = found.userLabel;
        proxy.assigned = current.filter(item => String(item.userId) !== sid);
    }
    delete data.sessionAssignments[sid];
    recordHistory(data, {
        type: 'release',
        proxyId,
        proxyName: proxy ? proxy.name : proxyId,
        userId: sid,
        userLabel: removedLabel,
        reason
    });
    saveData(data);
    return proxyId;
}

function reassignProxy(waSessionId, userLabel = '') {
    const oldProxyId = releaseAssignment(waSessionId, 'rotacionado');
    return getAssignment(waSessionId, userLabel, oldProxyId);
}

function getStats() {
    const data = loadData();
    const proxys = Array.isArray(data.proxys) ? data.proxys : [];
    const totalCap = proxys.reduce((sum, proxy) => sum + normalizeInt(proxy && proxy.limit, 0), 0);
    const used = proxys.reduce((sum, proxy) => sum + ((proxy && Array.isArray(proxy.assigned)) ? proxy.assigned.length : 0), 0);
    const activeProxies = proxys.filter(proxy => proxy && Array.isArray(proxy.assigned) && proxy.assigned.length > 0).length;
    const proxySessions = {};
    proxys.forEach(proxy => {
        if (!proxy) return;
        proxySessions[proxy.id] = {
            count: Array.isArray(proxy.assigned) ? proxy.assigned.length : 0,
            createdAt: proxy.createdAt || Date.now(),
            name: proxy.name || proxy.id,
            host: proxy.host || '',
            port: proxy.port || ''
        };
    });
    return {
        totalConnections: used,
        activeProxies,
        maxConnections: totalCap,
        available: Math.max(0, totalCap - used),
        count: proxys.length,
        used,
        free: Math.max(0, totalCap - used),
        totalCap,
        assignments: data.sessionAssignments || {},
        proxySessions,
        proxys
    };
}

function getProxyForSession(waSessionId) {
    const sid = normalizeText(waSessionId);
    if (!sid) return null;
    const data = loadData();
    const proxyId = normalizeText(data.sessionAssignments[sid]);
    if (!proxyId) return null;
    const proxy = data.proxys.find(item => item && item.id === proxyId);
    if (!proxy) return `session-${proxyId}`;
    return proxy.name || `${proxy.host}:${proxy.port}`;
}

function getProxyConfigForSession(waSessionId) {
    const sid = normalizeText(waSessionId);
    if (!sid) return null;
    const data = loadData();
    const proxyId = normalizeText(data.sessionAssignments[sid]);
    if (!proxyId) return null;
    const proxy = data.proxys.find(item => item && item.id === proxyId);
    return buildProxyConfig(proxy);
}

function getProxyRecordForSession(waSessionId) {
    const sid = normalizeText(waSessionId);
    if (!sid) return null;
    const data = loadData();
    const proxyId = normalizeText(data.sessionAssignments[sid]);
    if (!proxyId) return null;
    return data.proxys.find(item => item && item.id === proxyId) || null;
}

function getAdminState() {
    return loadData();
}

function saveAdminState(state) {
    const normalized = normalizeState(state);
    saveData(normalized);
    return normalized;
}

module.exports = {
    getAssignment,
    releaseAssignment,
    reassignProxy,
    getStats,
    getProxyForSession,
    getProxyConfigForSession,
    getProxyRecordForSession,
    getAdminState,
    saveAdminState
};
