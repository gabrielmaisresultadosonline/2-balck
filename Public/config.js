window.ZAPMRO_CONFIG = (function () {
    function trimTrailingSlash(value) {
        return String(value || '').replace(/\/+$/, '');
    }

    function normalizeBaseUrl(value) {
        const cleaned = trimTrailingSlash(value);
        if (!cleaned) return window.location.origin;
        if (/^https?:\/\//i.test(cleaned)) return cleaned;
        if (cleaned.startsWith('/')) return `${window.location.origin}${cleaned}`;
        return `https://${cleaned}`;
    }

    const DEFAULT_BACKEND_URL = window.location.origin;
    const LEGACY_PREVIEW_BACKEND_URL = 'https://id-preview--df801dd6-da4a-4664-b8a4-670096f5bf0a.lovable.app';

    // Corrige automaticamente a configuração antiga que apontava o front para o preview protegido,
    // mantendo suporte a qualquer backend externo configurado manualmente pelo usuário.
    if (trimTrailingSlash(localStorage.getItem('zapmro_api_base_url') || '') === LEGACY_PREVIEW_BACKEND_URL) {
        localStorage.setItem('zapmro_api_base_url', DEFAULT_BACKEND_URL);
    }
    if (trimTrailingSlash(localStorage.getItem('zapmro_socket_url') || '') === LEGACY_PREVIEW_BACKEND_URL) {
        localStorage.setItem('zapmro_socket_url', DEFAULT_BACKEND_URL);
    }

    // Persist default backend URL on first load so o front sempre aponta pro backend correto.
    if (!localStorage.getItem('zapmro_api_base_url')) {
        localStorage.setItem('zapmro_api_base_url', DEFAULT_BACKEND_URL);
    }
    if (!localStorage.getItem('zapmro_socket_url')) {
        localStorage.setItem('zapmro_socket_url', DEFAULT_BACKEND_URL);
    }

    const storedApiBaseUrl = trimTrailingSlash(localStorage.getItem('zapmro_api_base_url') || '');
    const storedSocketBaseUrl = trimTrailingSlash(localStorage.getItem('zapmro_socket_url') || '');

    const apiBaseUrl = normalizeBaseUrl(
        window.ZAPMRO_API_BASE_URL || storedApiBaseUrl || DEFAULT_BACKEND_URL
    );
    const socketUrl = normalizeBaseUrl(
        window.ZAPMRO_SOCKET_URL || storedSocketBaseUrl || apiBaseUrl
    );

    function buildApiUrl(path) {
        if (!path) return apiBaseUrl;
        if (/^https?:\/\//i.test(path)) return path;
        return `${apiBaseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    }

    return {
        apiBaseUrl,
        socketUrl,
        socketIoScriptUrl: `${socketUrl}/socket.io/socket.io.js`,
        buildApiUrl
    };
})();
