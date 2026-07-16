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

function toMessageTarget(value) {
    const raw = String(value || '').trim();
    if (!raw) return raw;
    if (raw.endsWith('@g.us') || raw.endsWith('@lid') || raw.endsWith('@newsletter')) return raw;
    const digits = toDigits(raw);
    return digits || raw;
}

function compactObject(value) {
    return Object.fromEntries(
        Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null && item !== '')
    );
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
        try {
            const response = await this.http.request({
                method,
                url,
                ...options
            });
            return this.unwrap(response);
        } catch (error) {
            const responseData = error && error.response ? error.response.data : null;
            if (responseData) {
                error.evolutionResponse = responseData;
                const extraMessage =
                    responseData?.response?.message ||
                    responseData?.response?.error ||
                    responseData?.error ||
                    '';
                if (extraMessage && !String(error.message || '').includes(extraMessage)) {
                    error.message = `${error.message} - ${extraMessage}`;
                }
            }
            throw error;
        }
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

    async setInstanceProxy(instanceName, proxyConfig = {}) {
        return this.request('post', `/instance/proxy/${encodeURIComponent(instanceName)}`, {
            data: {
                host: String(proxyConfig.host || '').trim(),
                port: String(proxyConfig.port || '').trim(),
                username: String(proxyConfig.username || '').trim(),
                password: String(proxyConfig.password || '').trim()
            }
        });
    }

    async removeInstanceProxy(instanceName) {
        return this.request('delete', `/instance/proxy/${encodeURIComponent(instanceName)}`);
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

    async findContacts(instanceName, payload = {}) {
        return this.request('post', `/chat/findContacts/${encodeURIComponent(instanceName)}`, {
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
                number: toMessageTarget(numberOrJid),
                text: String(text || ''),
                ...options
            }
        });
    }

    async sendMedia(instanceName, numberOrJid, mediaPayload, options = {}) {
        return this.request('post', `/message/sendMedia/${encodeURIComponent(instanceName)}`, {
            data: {
                number: toMessageTarget(numberOrJid),
                ...mediaPayload,
                ...options
            }
        });
    }

    async sendWhatsAppAudio(instanceName, numberOrJid, audioBase64, options = {}) {
        return this.request('post', `/message/sendWhatsAppAudio/${encodeURIComponent(instanceName)}`, {
            data: {
                number: toMessageTarget(numberOrJid),
                audio: audioBase64,
                ...options
            }
        });
    }

    async sendReaction(instanceName, payload = {}, options = {}) {
        return this.request('post', `/message/sendReaction/${encodeURIComponent(instanceName)}`, {
            data: {
                reaction: String(payload.reaction || options.reaction || '').trim(),
                key: payload.key || options.key || null,
                ...options
            }
        });
    }

    async deleteMessage(instanceName, payload = {}, options = {}) {
        return this.request('delete', `/message/delete/${encodeURIComponent(instanceName)}`, {
            data: {
                chat: String(payload.chat || payload.remoteJid || '').trim(),
                messageId: String(payload.messageId || payload.id || '').trim(),
                fromMe: payload.fromMe === true,
                participant: payload.participant ? String(payload.participant).trim() : undefined,
                ...options
            }
        });
    }

    async sendButtons(instanceName, numberOrJid, payload = {}, options = {}) {
        const data = payload && typeof payload === 'object' ? payload : {};
        const buttons = Array.isArray(data.buttons)
            ? data.buttons.map((button) => {
                const type = String(button && button.type || 'reply').toLowerCase();
                const displayText = button && (button.displayText || button.text || button.title)
                    ? String(button.displayText || button.text || button.title).trim()
                    : '';
                if (type === 'url') {
                    return compactObject({
                        type,
                        displayText,
                        url: button && button.url ? String(button.url).trim() : ''
                    });
                }
                if (type === 'call') {
                    return compactObject({
                        type,
                        displayText,
                        phoneNumber: button && button.phoneNumber ? String(button.phoneNumber).trim() : ''
                    });
                }
                return compactObject({
                    id: button && (button.id || button.buttonId) ? String(button.id || button.buttonId).trim() : '',
                    displayText
                });
            }).filter((button) => {
                if (!button.displayText) return false;
                if (button.type === 'url') return !!button.url;
                if (button.type === 'call') return !!button.phoneNumber;
                return !!button.id;
            })
            : [];
        return this.request('post', `/message/sendButtons/${encodeURIComponent(instanceName)}`, {
            data: {
                number: toMessageTarget(numberOrJid),
                ...compactObject({
                    title: data.title || '',
                    description: data.description || data.text || '',
                    footer: data.footer || data.footerText || '',
                    image: data.image || data.imageUrl || undefined
                }),
                buttons,
                ...options
            }
        });
    }

    async sendList(instanceName, numberOrJid, payload = {}, options = {}) {
        const data = payload && typeof payload === 'object' ? payload : {};
        const sections = Array.isArray(data.sections)
            ? data.sections.map((section) => compactObject({
                title: section && section.title ? String(section.title).trim() : '',
                rows: Array.isArray(section && section.rows)
                    ? section.rows.map((row) => compactObject({
                        rowId: row && (row.rowId || row.id) ? String(row.rowId || row.id).trim() : '',
                        title: row && row.title ? String(row.title).trim() : '',
                        description: row && row.description ? String(row.description).trim() : ''
                    })).filter((row) => row.title && row.rowId)
                    : []
            })).filter((section) => Array.isArray(section.rows) && section.rows.length > 0)
            : [];
        return this.request('post', `/message/sendList/${encodeURIComponent(instanceName)}`, {
            data: {
                number: toMessageTarget(numberOrJid),
                ...compactObject({
                    title: data.title || '',
                    description: data.description || data.text || '',
                    buttonText: data.buttonText || 'Abrir menu'
                }),
                footerText: String(data.footerText ?? data.footer ?? ''),
                sections,
                ...options
            }
        });
    }

    async sendCarousel(instanceName, numberOrJid, payload = {}, options = {}) {
        const data = payload && typeof payload === 'object' ? payload : {};
        const cards = Array.isArray(data.cards)
            ? data.cards.map((card) => compactObject({
                title: card && card.title ? String(card.title).trim() : '',
                description: card && card.description ? String(card.description).trim() : '',
                image: card && card.image ? String(card.image).trim() : undefined,
                imageUrl: card && card.imageUrl ? String(card.imageUrl).trim() : undefined,
                buttons: Array.isArray(card && card.buttons)
                    ? card.buttons.map((button) => {
                        const type = String(button && button.type || 'reply').toLowerCase();
                        const base = compactObject({
                            type,
                            displayText: button && (button.displayText || button.text) ? String(button.displayText || button.text).trim() : ''
                        });
                        if (type === 'reply') return compactObject({ ...base, id: button && button.id ? String(button.id).trim() : '' });
                        if (type === 'url') return compactObject({ ...base, url: button && button.url ? String(button.url).trim() : '' });
                        if (type === 'call') return compactObject({ ...base, phoneNumber: button && button.phoneNumber ? String(button.phoneNumber).trim() : '' });
                        return base;
                    }).filter((button) => button.displayText)
                    : []
            })).filter((card) => card.title || card.description || card.image || card.imageUrl)
            : [];
        return this.request('post', `/message/sendCarousel/${encodeURIComponent(instanceName)}`, {
            data: {
                number: toMessageTarget(numberOrJid),
                ...compactObject({
                    description: data.description || data.text || '',
                    footerText: data.footerText || data.footer || ''
                }),
                cards,
                ...options
            }
        });
    }

    normalizeInstanceState(payload) {
        const data = payload && typeof payload === 'object' ? payload : {};
        const instance = data.instance && typeof data.instance === 'object' ? data.instance : data;
        const me = instance.me && typeof instance.me === 'object' ? instance.me : (data.me && typeof data.me === 'object' ? data.me : {});
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
            number:
                instance.number ||
                instance.ownerJid ||
                instance.owner ||
                instance.phone ||
                instance.wuid ||
                me.id ||
                me.user ||
                data.number ||
                data.ownerJid ||
                data.owner ||
                data.phone ||
                null,
            profileName:
                instance.profileName ||
                instance.name ||
                instance.profile?.name ||
                me.name ||
                me.pushName ||
                data.profileName ||
                data.name ||
                null,
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
