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

    const storedApiBaseUrl = trimTrailingSlash(localStorage.getItem('zapmro_api_base_url') || '');
    const storedSocketBaseUrl = trimTrailingSlash(localStorage.getItem('zapmro_socket_url') || '');

    const apiBaseUrl = normalizeBaseUrl(
        window.ZAPMRO_API_BASE_URL || storedApiBaseUrl || window.location.origin
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
