const axios = require('axios');

function trimSlash(value) {
    return String(value || '').replace(/\/+$/, '');
}

function toDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function toRemoteJid(value) {
    const raw = String(value || '').trim();
    if (!raw) return raw;
    if (raw.includes('@')) return raw;
    const digits = toDigits(raw);
    return digits ? `${digits}@s.whatsapp.net` : raw;
}

class EvolutionApi {
    constructor({ baseUrl, apiKey, integration = 'WHATSAPP-BAILEYS' }) {
        this.baseUrl = trimSlash(baseUrl);
        this.apiKey = String(apiKey || '').trim();
        this.integration = integration || 'WHATSAPP-BAILEYS';
        this.http = axios.create({
            baseURL: this.baseUrl,
            timeout: 30000,
            headers: {
                apikey: this.apiKey,
                'Content-Type': 'application/json'
            }
        });
    }

    isConfigured() {
        return !!(this.baseUrl && this.apiKey);
    }

    unwrap(response) {
        if (!response) return null;
        const data = response.data;
        if (data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'data')) {
            return data.data;
        }
        return data;
    }

    async request(method, url, options = {}) {
        const response = await this.http.request({
            method,
            url,
            ...options
        });
        return this.unwrap(response);
    }

    async verify() {
        return this.request('post', '/verify-creds');
    }

    async fetchInstances() {
        return this.request('get', '/instance/fetchInstances');
    }

    async getInstance(instanceName) {
        const list = await this.fetchInstances();
        const items = Array.isArray(list) ? list : (Array.isArray(list?.instances) ? list.instances : []);
        return items.find(item => String(item?.name || item?.instanceName || item?.instance || '') === String(instanceName)) || null;
    }

    async createInstance(instanceName, webhookConfig = null, extra = {}) {
        return this.request('post', '/instance/create', {
            data: {
                instanceName,
                qrcode: true,
                integration: this.integration,
                ...(webhookConfig ? { webhook: webhookConfig } : {}),
                ...extra
            }
        });
    }

    async connectInstance(instanceName) {
        return this.request('get', `/instance/connect/${encodeURIComponent(instanceName)}`);
    }

    async connectionState(instanceName) {
        return this.request('get', `/instance/connectionState/${encodeURIComponent(instanceName)}`);
    }

    async logoutInstance(instanceName) {
        return this.request('delete', `/instance/logout/${encodeURIComponent(instanceName)}`);
    }

    async deleteInstance(instanceName) {
        return this.request('delete', `/instance/delete/${encodeURIComponent(instanceName)}`);
    }

    async setWebhook(instanceName, webhookConfig) {
        return this.request('post', `/webhook/set/${encodeURIComponent(instanceName)}`, {
            data: {
                webhook: webhookConfig
            }
        });
    }

    async findChats(instanceName, payload = {}) {
        return this.request('post', `/chat/findChats/${encodeURIComponent(instanceName)}`, {
            data: payload
        });
    }

    async findMessages(instanceName, payload = {}) {
        return this.request('post', `/chat/findMessages/${encodeURIComponent(instanceName)}`, {
            data: payload
        });
    }

    async checkNumbers(instanceName, numbers) {
        return this.request('post', `/chat/whatsappNumbers/${encodeURIComponent(instanceName)}`, {
            data: {
                numbers: Array.isArray(numbers) ? numbers : [numbers]
            }
        });
    }

    async setPresence(instanceName, numberOrJid, presence = 'composing', delay = 1000) {
        return this.request('post', `/chat/sendPresence/${encodeURIComponent(instanceName)}`, {
            data: {
                number: String(numberOrJid || ''),
                presence,
                delay
            }
        });
    }

    async fetchProfilePictureUrl(instanceName, numberOrJid) {
        return this.request('post', `/chat/fetchProfilePictureUrl/${encodeURIComponent(instanceName)}`, {
            data: {
                number: String(numberOrJid || '')
            }
        });
    }

    async fetchProfile(instanceName, numberOrJid) {
        return this.request('post', `/chat/fetchProfile/${encodeURIComponent(instanceName)}`, {
            data: {
                number: String(numberOrJid || '')
            }
        });
    }

    async archiveChat(instanceName, remoteJid, archive = true) {
        return this.request('post', `/chat/archiveChat/${encodeURIComponent(instanceName)}`, {
            data: {
                chat: String(remoteJid || ''),
                archive
            }
        });
    }

    async getBase64FromMediaMessage(instanceName, rawMessage) {
        return this.request('post', `/chat/getBase64FromMediaMessage/${encodeURIComponent(instanceName)}`, {
            data: {
                message: rawMessage
            }
        });
    }

    async sendText(instanceName, numberOrJid, text, options = {}) {
        return this.request('post', `/message/sendText/${encodeURIComponent(instanceName)}`, {
            data: {
                number: String(numberOrJid || ''),
                text: String(text || ''),
                ...options
            }
        });
    }

    async sendMedia(instanceName, numberOrJid, mediaPayload, options = {}) {
        return this.request('post', `/message/sendMedia/${encodeURIComponent(instanceName)}`, {
            data: {
                number: String(numberOrJid || ''),
                ...mediaPayload,
                ...options
            }
        });
    }

    async sendWhatsAppAudio(instanceName, numberOrJid, audioBase64, options = {}) {
        return this.request('post', `/message/sendWhatsAppAudio/${encodeURIComponent(instanceName)}`, {
            data: {
                number: String(numberOrJid || ''),
                audio: audioBase64,
                ...options
            }
        });
    }

    normalizeInstanceState(payload) {
        const data = payload && typeof payload === 'object' ? payload : {};
        const instance = data.instance && typeof data.instance === 'object' ? data.instance : data;
        const state =
            instance.state ||
            instance.connectionStatus ||
            instance.status ||
            data.state ||
            data.connectionStatus ||
            data.status ||
            'close';
        return {
            state: String(state || 'close').toLowerCase(),
            number: instance.number || instance.ownerJid || data.number || null,
            profileName: instance.profileName || instance.name || data.profileName || data.name || null,
            profilePictureUrl: instance.profilePictureUrl || data.profilePictureUrl || null,
            raw: data
        };
    }

    normalizeQr(payload) {
        const data = payload && typeof payload === 'object' ? payload : {};
        const instance = data.instance && typeof data.instance === 'object' ? data.instance : data;
        const qr = instance.qrcode || data.qrcode || data.qr || {};
        const base64 = qr.base64 || data.base64 || data.qrCode || data.qr || null;
        const code = qr.code || data.code || null;
        const pairingCode = qr.pairingCode || data.pairingCode || null;
        return { base64, code, pairingCode, raw: data };
    }

    normalizeRemoteJid(value) {
        return toRemoteJid(value);
    }

    normalizeDigits(value) {
        return toDigits(value);
    }
}

module.exports = {
    EvolutionApi,
    toDigits,
    toRemoteJid
};
