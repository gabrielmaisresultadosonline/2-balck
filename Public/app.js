document.addEventListener('DOMContentLoaded', function() {
    const USER_TOKEN_KEY = 'zapmro_token';
    const ADMIN_TOKEN_KEY = 'zapmro_admin_token';
    const ROLE_KEY = 'zapmro_role';
    const APP_CONFIG = window.ZAPMRO_CONFIG || {};
    const API_BASE_URL = APP_CONFIG.apiBaseUrl || window.location.origin;
    const SOCKET_URL = APP_CONFIG.socketUrl || API_BASE_URL;
    const DEMO_USER_TOKEN = 'zapmro_demo_user_token';
    const DEMO_ADMIN_TOKEN = 'zapmro_demo_admin_token';
    const DEMO_SESSION_ID = 'demo-session-zapmro';
    let demoSessionConnected = false;
    let demoSessionHasPassword = false;

    let socket = null;
    let currentSessionId = null;
    let authRole = localStorage.getItem(ROLE_KEY) || '';
    let authToken = (authRole === 'admin' ? localStorage.getItem(ADMIN_TOKEN_KEY) : localStorage.getItem(USER_TOKEN_KEY)) || '';
    if (authToken === DEMO_USER_TOKEN || authToken === DEMO_ADMIN_TOKEN) {
        localStorage.removeItem(ROLE_KEY);
        localStorage.removeItem(USER_TOKEN_KEY);
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        authRole = '';
        authToken = '';
    }

    // ============ Histórico de conexões do WhatsApp (por usuário) ============
    const WHATS_HISTORY_KEY = 'zapmro_whats_history';
    let lastKnownConnectedNumber = null; // usado p/ detectar transições
    function getUserHistoryId() {
        try { return (localStorage.getItem('userEmail') || '').trim().toLowerCase() || 'anon'; }
        catch(_) { return 'anon'; }
    }
    function readHistoryStore() {
        try { return JSON.parse(localStorage.getItem(WHATS_HISTORY_KEY) || '{}') || {}; }
        catch(_) { return {}; }
    }
    function writeHistoryStore(store) {
        try { localStorage.setItem(WHATS_HISTORY_KEY, JSON.stringify(store || {})); } catch(_) {}
    }
    function getWhatsHistory() {
        const store = readHistoryStore();
        return store[getUserHistoryId()] || null;
    }
    function saveWhatsHistory(phoneNumber) {
        if (!phoneNumber) return;
        const store = readHistoryStore();
        const uid = getUserHistoryId();
        const prev = store[uid];
        store[uid] = {
            phoneNumber: phoneNumber,
            firstConnectedAt: (prev && prev.phoneNumber === phoneNumber && prev.firstConnectedAt) ? prev.firstConnectedAt : new Date().toISOString(),
            lastConnectedAt: new Date().toISOString()
        };
        writeHistoryStore(store);
    }

    function formatSessionPhone(value) {
        const digits = String(value || '').replace(/\D+/g, '');
        if (!digits) return '';
        if (digits.length === 13) return `+${digits.slice(0,2)} ${digits.slice(2,4)} ${digits.slice(4,9)}-${digits.slice(9)}`;
        if (digits.length === 12) return `+${digits.slice(0,2)} ${digits.slice(2,4)} ${digits.slice(4,8)}-${digits.slice(8)}`;
        if (digits.length === 11) return `(${digits.slice(0,2)}) ${digits.slice(2,7)}-${digits.slice(7)}`;
        if (digits.length === 10) return `(${digits.slice(0,2)}) ${digits.slice(2,6)}-${digits.slice(6)}`;
        return `+${digits}`;
    }
    function clearWhatsHistory() {
        const store = readHistoryStore();
        delete store[getUserHistoryId()];
        writeHistoryStore(store);
    }

    function isDemoAuth() {
        return false;
    }

    function buildApiUrl(path) {
        if (!path) return API_BASE_URL;
        if (/^https?:\/\//i.test(path)) return path;
        return `${API_BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
    }
    
    // Elementos DOM
    const createSessionBtn = document.getElementById('createSessionBtn');
    const qrContainer = document.getElementById('qrContainer');
    const qrVisual = document.getElementById('qrVisual');
    const qrLoading = document.getElementById('qrLoading');
    const qrCodeImg = document.getElementById('qrCode');
    const sessionInfo = document.getElementById('sessionInfo');
    const sessionsContainer = document.getElementById('sessionsContainer');
    const refreshSessionsBtn = document.getElementById('refreshSessionsBtn');
    const logoutBtn = document.getElementById('logoutBtn');

    const rightTitle = document.getElementById('rightTitle');
    const rightHint = document.getElementById('rightHint');
    const connectionPanel = document.getElementById('connectionPanel');
    const mainContent = document.querySelector('.main-content');
    const openCrmBtn = document.getElementById('openCrmBtn');

    const userConnectPanel = document.getElementById('userConnectPanel');

    const tabs = Array.from(document.querySelectorAll('.tab'));
    const authRegister = document.getElementById('authRegister');
    const authLogin = document.getElementById('authLogin');
    const authAdmin = document.getElementById('authAdmin');
    const authSuccess = document.getElementById('authSuccess');
    const authError = document.getElementById('authError');

    const registerName = document.getElementById('registerName');
    const registerEmail = document.getElementById('registerEmail');
    const registerPassword = document.getElementById('registerPassword');
    const registerBtn = document.getElementById('registerBtn');

    const loginEmail = document.getElementById('loginEmail');
    const loginPassword = document.getElementById('loginPassword');
    const loginBtn = document.getElementById('loginBtn');

    const adminEmail = document.getElementById('adminEmail');
    const adminPassword = document.getElementById('adminPassword');
    const adminLoginBtn = document.getElementById('adminLoginBtn');

    const adminPanel = document.getElementById('adminPanel');
    const refreshAdminBtn = document.getElementById('refreshAdminBtn');
    const adminUsersTbody = document.getElementById('adminUsersTbody');
    const adminUsersGrid = document.getElementById('adminUsersGrid');
    const adminSummary = document.getElementById('adminSummary');
    const adminRealIpEl = document.getElementById('adminRealIp');

    function setQrLoadingState(infoHtml) {
        if (qrVisual) qrVisual.classList.remove('is-ready');
        if (qrLoading) qrLoading.style.display = 'flex';
        if (qrCodeImg) {
            qrCodeImg.style.display = 'none';
            qrCodeImg.removeAttribute('src');
            qrCodeImg.onload = null;
            qrCodeImg.onerror = null;
        }
        if (sessionInfo && infoHtml) sessionInfo.innerHTML = infoHtml;
    }

    function setQrReadyState(qrSrc, infoHtml) {
        if (!qrCodeImg) return;
        qrCodeImg.onload = () => {
            if (qrVisual) qrVisual.classList.add('is-ready');
            qrCodeImg.style.display = 'block';
        };
        qrCodeImg.onerror = () => {
            setQrLoadingState(`
                <p><strong>ID da Sessão:</strong> ${currentSessionId || '—'}</p>
                <p><strong>Status:</strong> <span class="status pending">Gerando QR Code...</span></p>
            `);
        };
        qrCodeImg.src = qrSrc || '';
        if (sessionInfo && infoHtml) sessionInfo.innerHTML = infoHtml;
    }

    function resetUserConnectionState(messageHtml) {
        if (qrVisual) qrVisual.classList.remove('is-ready');
        if (qrLoading) {
            qrLoading.style.display = 'none';
            qrLoading.innerHTML = '<i class="fab fa-whatsapp"></i><span>Aguardando ação.</span>';
        }
        if (qrCodeImg) {
            qrCodeImg.style.display = 'none';
            qrCodeImg.removeAttribute('src');
            qrCodeImg.onload = null;
            qrCodeImg.onerror = null;
        }
        if (sessionInfo) {
            sessionInfo.innerHTML = messageHtml || '<p><strong>Status:</strong> <span class="status disconnected">Desconectado</span></p>';
        }
        if (openCrmBtn) openCrmBtn.style.display = 'none';
        setRightPanelVisible(true);
    }

    function showAuthError(msg) {
        if (!authError) return;
        authError.textContent = msg || 'Erro';
        authError.style.display = 'block';
        if (authSuccess) authSuccess.style.display = 'none';
    }

    function showAuthSuccess(msg) {
        if (!authSuccess) return;
        authSuccess.textContent = msg || 'OK';
        authSuccess.style.display = 'block';
        if (authError) authError.style.display = 'none';
    }

    function clearAuthMessages() {
        if (authError) authError.style.display = 'none';
        if (authSuccess) authSuccess.style.display = 'none';
    }

    function setAuth(role, token) {
        authRole = role;
        authToken = token;
        localStorage.setItem(ROLE_KEY, role);
        if (role === 'admin') {
            localStorage.setItem(ADMIN_TOKEN_KEY, token);
            localStorage.removeItem(USER_TOKEN_KEY);
        } else {
            localStorage.setItem(USER_TOKEN_KEY, token);
            localStorage.removeItem(ADMIN_TOKEN_KEY);
        }
    }

    function clearAuth() {
        authRole = '';
        authToken = '';
        localStorage.removeItem(ROLE_KEY);
        localStorage.removeItem(USER_TOKEN_KEY);
        localStorage.removeItem(ADMIN_TOKEN_KEY);
    }

    async function authFetch(url, opts) {
        const options = opts ? { ...opts } : {};
        options.headers = options.headers ? { ...options.headers } : {};
        if (authToken) options.headers.Authorization = `Bearer ${authToken}`;
        return fetch(buildApiUrl(url), options);
    }

    function initSocket() {
        if (!authToken) return;
        if (isDemoAuth()) return;
        if (socket) {
            try { socket.disconnect(); } catch (e) {}
            socket = null;
        }
        socket = io(SOCKET_URL, { auth: { token: authToken } });

        socket.on('sessions-list-update', () => {
            if (authRole === 'admin') loadAdminUsers();
            else loadActiveSessions();
        });

        socket.on('session-password-verified', (data) => {
            if (window.pendingAction && window.pendingAction.sessionId === data.sessionId) {
                if (data.valid) {
                    if (window.pendingAction.type === 'open') {
                        window.location.href = window.pendingAction.url;
                    } else if (window.pendingAction.type === 'disconnect') {
                        window.actualDisconnectSession(data.sessionId);
                    }
                } else {
                    alert('Senha incorreta!');
                }
                window.pendingAction = null;
            }
        });

        socket.on('qr-generated', (data) => {
            if (data.sessionId === currentSessionId) {
                setQrReadyState(data.qr, `
                    <p><strong>ID da Sessão:</strong> ${data.sessionId}</p>
                    <p><strong>Status:</strong> <span class="status pending">Aguardando QR Code</span></p>
                `);
                if (openCrmBtn) openCrmBtn.style.display = 'none';
                setRightPanelVisible(false);
            }
        });

        socket.on('client-ready', (data) => {
            if (data.sessionId === currentSessionId) {
                const info = document.getElementById('sessionInfo');
                if (info) {
                    info.innerHTML = `
                        <p><strong>ID da Sessão:</strong> ${data.sessionId}</p>
                        <p><strong>Status:</strong> <span class="status connected">Conectado</span></p>
                        <p><strong>Número:</strong> ${formatSessionPhone(data.phoneNumber) || data.phoneNumber || 'Não informado'}</p>
                        <p><strong>Nome:</strong> ${data.name || 'Não informado'}</p>
                    `;
                }
                showDashboardAccess(data.sessionId);
            }
            if (authRole === 'admin') loadAdminUsers();
            else loadActiveSessions();
        });

        socket.on('session-status', (data) => {
            if (!data || !data.sessionId) return;
            if (data.sessionId === currentSessionId && (data.status === 'disconnected' || data.status === 'auth_failed' || data.status === 'reconnecting')) {
                resetUserConnectionState(`
                    <p><strong>ID da Sessão:</strong> ${data.sessionId}</p>
                    <p><strong>Status:</strong> <span class="status disconnected">${data.status === 'reconnecting' ? 'Desconectado' : 'Desconectado'}</span></p>
                    <p>Gere um novo QR Code para reconectar seu WhatsApp.</p>
                `);
                currentSessionId = null;
            }
            if (authRole === 'admin') loadAdminUsers();
            else loadActiveSessions();
        });

        socket.on('auth-failed', (data) => {
            if (data.sessionId === currentSessionId) {
                if (qrVisual) qrVisual.classList.remove('is-ready');
                if (qrLoading) {
                    qrLoading.style.display = 'flex';
                    qrLoading.innerHTML = '<i class="fas fa-triangle-exclamation"></i><span>Falha na autenticação. Tente novamente.</span>';
                }
                if (qrCodeImg) {
                    qrCodeImg.style.display = 'none';
                    qrCodeImg.removeAttribute('src');
                }
                if (sessionInfo) {
                    sessionInfo.innerHTML = '<p style="color:#b91c1c;"><strong>Status:</strong> Falha na autenticação. Gere um novo QR Code.</p>';
                }
            }
            if (authRole === 'admin') loadAdminUsers();
            else loadActiveSessions();
        });
    }

    function applyLoggedOutUI() {
        // Se voltamos do modo admin, restaurar elementos compartilhados
        try { resetAdminMutations(); } catch(_){}
        if (logoutBtn) logoutBtn.style.display = 'none';
        document.body.classList.remove('admin-tab-active');
        document.body.classList.add('auth-mode');
        if (userConnectPanel) userConnectPanel.style.display = 'none';
        if (adminPanel) adminPanel.style.display = 'none';
        tabs.forEach(t => t.style.display = '');
        setRightPanelVisible(false);
        if (sessionsContainer) sessionsContainer.innerHTML = '';
        if (refreshSessionsBtn) refreshSessionsBtn.style.display = 'none';
        if (openCrmBtn) openCrmBtn.style.display = 'none';
        if (qrContainer) qrContainer.style.display = 'none';
        setActiveTab('register');
        // reset página de acesso
        const authBlock = document.getElementById('authBlock');
        const welcomeBlock = document.getElementById('welcomeBlock');
        const waPromo = document.getElementById('waPromoBtn');
        const pageTitle = document.getElementById('pageTitle');
        const pageSubtitle = document.getElementById('pageSubtitle');
        const headerText = document.getElementById('headerTextBlock');
        const headerGreet = document.getElementById('headerGreeting');
        const shell = document.querySelector('.auth-shell');
        if (authBlock) authBlock.style.display = '';
        if (welcomeBlock) welcomeBlock.style.display = 'none';
        if (waPromo) waPromo.style.display = '';
        if (headerText) headerText.style.display = '';
        if (headerGreet) headerGreet.style.display = 'none';
        if (pageTitle) pageTitle.textContent = 'Acessar sua conta';
        if (pageSubtitle) pageSubtitle.style.display = '';
        if (shell) shell.classList.remove('is-connected');
        document.body.classList.remove('zapmro-connected');
        if (shell) shell.classList.remove('is-admin');
        document.body.classList.remove('zapmro-admin');
    }

    function applyUserUI() {
        // Reset explícito de qualquer mutação feita pelo applyAdminUI
        resetAdminMutations();
        if (logoutBtn) logoutBtn.style.display = '';
        document.body.classList.remove('admin-tab-active');
        document.body.classList.remove('auth-mode');
        if (userConnectPanel) userConnectPanel.style.display = '';
        if (adminPanel) adminPanel.style.display = 'none';
        tabs.forEach(t => t.style.display = 'none');
        if (authRegister) authRegister.style.display = 'none';
        if (authLogin) authLogin.style.display = 'none';
        if (authAdmin) authAdmin.style.display = 'none';
        // Usuário normal precisa ver o painel de "Sua Conexão" (QR, status, botão de atualizar)
        setRightPanelVisible(true);
        if (rightTitle) { rightTitle.style.display = ''; rightTitle.innerHTML = '<i class="fas fa-plug"></i> Sua Conexão'; }
        if (rightHint)  { rightHint.style.display  = ''; rightHint.textContent = 'Acompanhe o status do seu WhatsApp. Seus dados não se misturam com outros usuários.'; }
        if (sessionsContainer) sessionsContainer.style.display = '';
        if (refreshSessionsBtn) refreshSessionsBtn.style.display = '';
        if (openCrmBtn) openCrmBtn.style.display = 'none';
        // Modo logado: esconder bloco de acesso, mostrar boas-vindas
        const authBlock = document.getElementById('authBlock');
        const welcomeBlock = document.getElementById('welcomeBlock');
        const waPromo = document.getElementById('waPromoBtn');
        const headerText = document.getElementById('headerTextBlock');
        const headerGreet = document.getElementById('headerGreeting');
        const greetName = document.getElementById('greetingName');
        const welcomeName = document.getElementById('welcomeName');
        const welcomeEmail = document.getElementById('welcomeEmail');
        if (authBlock) authBlock.style.display = 'none';
        if (welcomeBlock) welcomeBlock.style.display = '';
        if (waPromo) waPromo.style.display = 'none';
        if (headerText) headerText.style.display = 'none';
        if (headerGreet) headerGreet.style.display = '';
        const email = (localStorage.getItem('userEmail') || '').trim();
        const displayName = email ? email.split('@')[0] : 'Usuário';
        const nice = displayName.charAt(0).toUpperCase() + displayName.slice(1);
        if (greetName) greetName.textContent = 'Olá, ' + nice + ' 👋';
        if (welcomeName) welcomeName.textContent = nice;
        if (welcomeEmail) welcomeEmail.textContent = email || 'Gerencie seu número, sessões e acessos por aqui.';
    }

    // Desfaz mutações do painel de admin que persistem em elementos compartilhados
    function resetAdminMutations() {
        const topActions = document.querySelector('.top-actions');
        const connectionPanelEl = document.getElementById('connectionPanel');
        if (refreshSessionsBtn && topActions && refreshSessionsBtn.parentElement === topActions && connectionPanelEl) {
            connectionPanelEl.appendChild(refreshSessionsBtn);
            refreshSessionsBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Atualizar Lista';
            refreshSessionsBtn.style.marginTop = '20px';
            refreshSessionsBtn.classList.remove('btn-dark');
            refreshSessionsBtn.classList.add('btn-secondary');
            delete refreshSessionsBtn.dataset.adminBound;
        }
        if (rightTitle) rightTitle.style.display = '';
        if (rightHint)  rightHint.style.display  = '';
        if (sessionsContainer) sessionsContainer.style.display = '';
        const headerGreet = document.getElementById('headerGreeting');
        const eyebrow = headerGreet ? headerGreet.querySelector('span') : null;
        if (eyebrow) eyebrow.textContent = 'Bem-vindo(a) de volta';
        const greetName = document.getElementById('greetingName');
        if (greetName) { greetName.style.fontSize = ''; greetName.style.lineHeight = ''; }
        const shell = document.querySelector('.auth-shell');
        if (shell) shell.classList.remove('is-admin');
        document.body.classList.remove('zapmro-admin');
        if (mainContent) mainContent.style.gridTemplateColumns = '';
    }

    function applyAdminUI() {
        if (logoutBtn) logoutBtn.style.display = '';
        document.body.classList.remove('admin-tab-active');
        document.body.classList.remove('auth-mode');
        if (userConnectPanel) userConnectPanel.style.display = 'none';
        if (adminPanel) adminPanel.style.display = '';
        tabs.forEach(t => t.style.display = 'none');
        if (authRegister) authRegister.style.display = 'none';
        if (authLogin) authLogin.style.display = 'none';
        if (authAdmin) authAdmin.style.display = 'none';
        // Título/descrição do admin foram movidos para o cabeçalho — esconder no painel
        if (rightTitle) rightTitle.style.display = 'none';
        if (rightHint) rightHint.style.display = 'none';
        setRightPanelVisible(true);
        if (refreshSessionsBtn) refreshSessionsBtn.style.display = 'none';
        if (sessionsContainer) {
            sessionsContainer.innerHTML = '';
            sessionsContainer.style.display = 'none';
        }
        if (openCrmBtn) openCrmBtn.style.display = 'none';
        const authBlock = document.getElementById('authBlock');
        const welcomeBlock = document.getElementById('welcomeBlock');
        const waPromo = document.getElementById('waPromoBtn');
        const headerText = document.getElementById('headerTextBlock');
        const headerGreet = document.getElementById('headerGreeting');
        const greetName = document.getElementById('greetingName');
        if (authBlock) authBlock.style.display = 'none';
        if (welcomeBlock) welcomeBlock.style.display = 'none';
        if (waPromo) waPromo.style.display = 'none';
        if (headerText) headerText.style.display = 'none';
        if (headerGreet) headerGreet.style.display = '';
        if (greetName) {
            greetName.innerHTML = '<i class="fas fa-shield-halved" style="margin-right:8px; color:#16a34a;"></i>Admin — Dashboard para acompanhar usuários, QR e números conectados.';
            greetName.style.fontSize = '1.15rem';
            greetName.style.lineHeight = '1.3';
        }
        // Ajusta o eyebrow acima do título para algo mais curto
        const eyebrow = headerGreet ? headerGreet.querySelector('span') : null;
        if (eyebrow) eyebrow.textContent = 'Painel do administrador';
        // Mover o botão "Atualizar Lista" para o lado do botão Sair (topo direito)
        const topActions = document.querySelector('.top-actions');
        if (topActions && refreshSessionsBtn && refreshSessionsBtn.parentElement !== topActions) {
            refreshSessionsBtn.textContent = '';
            refreshSessionsBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Atualizar Lista';
            refreshSessionsBtn.style.marginTop = '0';
            refreshSessionsBtn.classList.remove('btn-secondary');
            refreshSessionsBtn.classList.add('btn-dark');
            topActions.insertBefore(refreshSessionsBtn, logoutBtn);
        }
        if (refreshSessionsBtn) {
            refreshSessionsBtn.style.display = '';
            // No admin, esse botão dispara o refresh da lista de admin
            if (!refreshSessionsBtn.dataset.adminBound) {
                refreshSessionsBtn.addEventListener('click', (ev) => {
                    if (authRole === 'admin' && typeof loadAdminUsers === 'function') {
                        ev.preventDefault();
                        ev.stopImmediatePropagation();
                        loadAdminUsers();
                    }
                }, true);
                refreshSessionsBtn.dataset.adminBound = '1';
            }
        }
        // Make admin panel fill the full width (kills the empty white column)
        const shell = document.querySelector('.auth-shell');
        if (shell) shell.classList.add('is-admin');
        document.body.classList.add('zapmro-admin');
        if (mainContent) mainContent.style.gridTemplateColumns = '1fr';
        // Detect the real public IP of this machine
        fetchAdminRealIp();
    }

    function setRightPanelVisible(visible) {
        if (connectionPanel) connectionPanel.style.display = visible ? '' : 'none';
        if (mainContent) mainContent.style.gridTemplateColumns = visible ? '1fr 1fr' : '1fr';
    }

    function getCrmUrl(sessionId) {
        const safeSessionId = encodeURIComponent(String(sessionId || ''));
        return `/crm.html?sessionId=${safeSessionId}&view=whatsapp`;
    }

    function showDashboardAccess(sessionId) {
        const crmUrl = getCrmUrl(sessionId);
        if (qrContainer) {
            qrContainer.style.display = 'block';
            qrContainer.innerHTML = `
                <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; padding: 22px 10px;">
                    <div style="font-weight:900; font-size:1.05rem; color:#111827;">WhatsApp conectado</div>
                    <div class="muted" style="margin:0;">Agora você já pode acessar o dashboard.</div>
                    <a class="btn btn-dark" style="text-decoration:none; width: 100%; max-width: 320px; justify-content:center;" href="${crmUrl}">
                        <i class="fas fa-columns"></i> Acessar dashboard
                    </a>
                </div>
            `;
        }
        if (openCrmBtn) {
            openCrmBtn.href = crmUrl;
            openCrmBtn.style.display = '';
        }
        setRightPanelVisible(true);
    }

    function setActiveTab(tabId) {
        tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
        if (authRegister) authRegister.style.display = tabId === 'register' ? '' : 'none';
        if (authLogin) authLogin.style.display = tabId === 'login' ? '' : 'none';
        if (authAdmin) authAdmin.style.display = tabId === 'admin' ? '' : 'none';
        // Only apply the exclusive admin-tab view when NOT logged in
        const isAdminExclusive = tabId === 'admin' && authRole !== 'admin' && authRole !== 'user';
        document.body.classList.toggle('admin-tab-active', isAdminExclusive);
        // Update page title based on active tab (pre-login only)
        if (authRole !== 'admin' && authRole !== 'user') {
            const pageTitle = document.getElementById('pageTitle');
            if (pageTitle) {
                if (tabId === 'register') pageTitle.textContent = 'Cadastre-se';
                else if (tabId === 'login') pageTitle.textContent = 'Acesse sua conta';
                else if (tabId === 'admin') pageTitle.textContent = 'Painel do administrador';
            }
        }
        clearAuthMessages();
    }

    tabs.forEach(t => {
        t.addEventListener('click', () => setActiveTab(t.dataset.tab));
    });

    async function tryInitFromStoredAuth() {
        if (!authToken) {
            applyLoggedOutUI();
            return;
        }
        if (isDemoAuth()) return;
        clearAuthMessages();
        try {
            if (authRole === 'admin') {
                const r = await authFetch('/api/admin/users');
                if (!r.ok) throw new Error('unauthorized');
                initSocket();
                applyAdminUI();
                await loadAdminUsers();
                return;
            }
            const r = await authFetch('/api/me');
            if (!r.ok) throw new Error('unauthorized');
            initSocket();
            applyUserUI();
            await loadActiveSessions();
        } catch (e) {
            clearAuth();
            if (socket) {
                try { socket.disconnect(); } catch (err) {}
                socket = null;
            }
            applyLoggedOutUI();
        }
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            clearAuth();
            if (socket) {
                try { socket.disconnect(); } catch (e) {}
                socket = null;
            }
            applyLoggedOutUI();
            setActiveTab('login');
        });
    }
    
    // Criar nova sessão
    if (createSessionBtn) createSessionBtn.addEventListener('click', async () => {
        try {
            if (!authToken || authRole === 'admin') {
                showAuthError('Faça login para conectar seu WhatsApp');
                return;
            }
            // Se já existe um histórico salvo, perguntar antes de gerar novo QR
            const hist = getWhatsHistory();
            if (hist && hist.phoneNumber && window.zapmroHistoryChoice) {
                const choice = await window.zapmroHistoryChoice({ phoneNumber: hist.phoneNumber });
                if (!choice) return; // cancelado
                if (choice === 'new') {
                    // Usuário quer conectar outro número: limpar histórico e avisar
                    clearWhatsHistory();
                    if (window.zapmroHistoryInfo) {
                        await window.zapmroHistoryInfo({
                            title: 'Novo número selecionado',
                            tone: 'warning',
                            message: 'Escaneie o QR Code com o <b>novo número</b>. O histórico anterior do número <b>' + hist.phoneNumber + '</b> não será carregado para essa nova conexão — ele fica salvo apenas se você reconectar aquela conta original mais tarde.'
                        });
                    }
                } else if (choice === 'keep') {
                    if (window.zapmroHistoryInfo) {
                        await window.zapmroHistoryInfo({
                            title: 'Manter histórico',
                            tone: 'success',
                            message: 'Escaneie o QR Code com o <b>mesmo número</b> anterior (' + hist.phoneNumber + ') para que o histórico de conversas seja preservado automaticamente.'
                        });
                    }
                }
            }
            const response = await authFetch('/api/create-session', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            const data = await response.json();
            
            if (data.success) {
                currentSessionId = data.sessionId;
                
                // Mostrar container do QR Code
                if (qrContainer) qrContainer.style.display = 'block';
                if (qrLoading) {
                    qrLoading.innerHTML = '<i class="fas fa-spinner"></i><span>Gerando QR Code...</span>';
                }
                setQrLoadingState(`
                    <p><strong>ID da Sessão:</strong> ${data.sessionId}</p>
                    <p><strong>Status:</strong> <span class="status pending">Gerando QR Code...</span></p>
                `);
                if (openCrmBtn) openCrmBtn.style.display = 'none';
                setRightPanelVisible(false);
                
                // Vincular socket à sessão
                if (socket) socket.emit('bind-session', currentSessionId);
                
                // Scroll para o QR Code
                if (qrContainer) qrContainer.scrollIntoView({ behavior: 'smooth' });
                
                // Atualizar lista de sessões
                loadActiveSessions();
            } else {
                showAuthError(data && data.error ? data.error : 'Erro ao criar sessão');
            }
        } catch (error) {
            console.error('Erro ao criar sessão:', error);
            alert('Erro ao criar sessão. Verifique o console.');
        }
    });
    
    // Atualizar lista de sessões
    if (refreshSessionsBtn) refreshSessionsBtn.addEventListener('click', () => {
        if (authRole === 'admin') loadAdminUsers();
        else loadActiveSessions();
    });

    if (refreshAdminBtn) refreshAdminBtn.addEventListener('click', loadAdminUsers);

    async function doJsonPost(url, payload) {
        const r = await fetch(buildApiUrl(url), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {})
        });
        const data = await r.json().catch(() => ({}));
        return { ok: r.ok, data };
    }

    if (registerBtn) registerBtn.addEventListener('click', async () => {
        clearAuthMessages();
        try {
            const payload = {
                name: registerName ? registerName.value : '',
                email: registerEmail ? registerEmail.value : '',
                password: registerPassword ? registerPassword.value : ''
            };
            const { ok, data } = await doJsonPost('/api/auth/register', payload);
            if (!ok || !data.success) {
                showAuthError((data && data.error) ? data.error : 'Erro ao cadastrar');
                return;
            }
            try { localStorage.setItem('userEmail', payload.email || ''); } catch(_) {}
            setAuth('user', data.token);
            showAuthSuccess('Cadastro feito. Conecte seu WhatsApp.');
            initSocket();
            applyUserUI();
            await loadActiveSessions();
        } catch (e) {
            showAuthError('Erro ao cadastrar');
        }
    });

    if (loginBtn) loginBtn.addEventListener('click', async () => {
        clearAuthMessages();
        try {
            const payload = {
                email: loginEmail ? loginEmail.value : '',
                password: loginPassword ? loginPassword.value : ''
            };
            const { ok, data } = await doJsonPost('/api/auth/login', payload);
            if (!ok || !data.success) {
                showAuthError((data && data.error) ? data.error : 'Erro ao entrar');
                return;
            }
            try { localStorage.setItem('userEmail', payload.email || ''); } catch(_) {}
            setAuth('user', data.token);
            showAuthSuccess('Login OK. Conecte seu WhatsApp.');
            initSocket();
            applyUserUI();
            await loadActiveSessions();
        } catch (e) {
            showAuthError('Erro ao entrar');
        }
    });

    if (adminLoginBtn) adminLoginBtn.addEventListener('click', async () => {
        clearAuthMessages();
        try {
            const payload = {
                email: adminEmail ? adminEmail.value : '',
                password: adminPassword ? adminPassword.value : ''
            };
            const { ok, data } = await doJsonPost('/api/admin/login', payload);
            if (!ok || !data.success) {
                showAuthError((data && data.error) ? data.error : 'Erro ao entrar como admin');
                return;
            }
            setAuth('admin', data.token);
            showAuthSuccess('Admin logado.');
            initSocket();
            applyAdminUI();
            await loadAdminUsers();
        } catch (e) {
            showAuthError('Erro ao entrar como admin');
        }
    });
    
    // Carregar sessões ativas
    async function loadActiveSessions() {
        try {
            if (!authToken || authRole === 'admin') return;
            const response = await authFetch('/api/active-sessions');
            if (response.status === 401) {
                clearAuth();
                applyLoggedOutUI();
                return;
            }
            const data = await response.json();
            
            renderSessions(data.sessions);
        } catch (error) {
            console.error('Erro ao carregar sessões:', error);
        }
    }

    function formatDateTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return '';
        return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function formatFullDateTime(ts) {
        if (!ts) return '—';
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return '—';
        return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function relativeTime(ts) {
        if (!ts) return '—';
        const d = new Date(ts).getTime();
        if (Number.isNaN(d)) return '—';
        const diff = Math.max(0, Date.now() - d);
        const s = Math.floor(diff / 1000);
        if (s < 60) return 'Agora';
        const m = Math.floor(s / 60);
        if (m < 60) return `${m} min atrás`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h atrás`;
        const days = Math.floor(h / 24);
        if (days < 30) return `${days}d atrás`;
        return formatFullDateTime(ts);
    }

    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function initials(name, email) {
        const base = (name || (email || '').split('@')[0] || '?').trim();
        const parts = base.split(/\s+/).filter(Boolean);
        if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
        return base.slice(0, 2).toUpperCase();
    }

    let __adminRealIpCache = null;
    async function fetchAdminRealIp() {
        if (!adminRealIpEl) return;
        if (__adminRealIpCache) { adminRealIpEl.textContent = __adminRealIpCache; return; }
        try {
            const res = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
            const j = await res.json();
            __adminRealIpCache = j && j.ip ? j.ip : 'indisponível';
        } catch (_) {
            __adminRealIpCache = 'indisponível';
        }
        adminRealIpEl.textContent = __adminRealIpCache;
    }

    function renderAdminSummary(users) {
        if (!adminSummary) return;
        const total = users.length;
        const connected = users.filter(u => u.status === 'connected' || u.status === 'authenticated').length;
        const disconnected = users.filter(u => u.status === 'disconnected' || u.status === 'auth_failed').length;
        const totalConversations = users.reduce((acc, u) => acc + (Number(u.totalConversations || u.conversations || 0) || 0), 0);
        adminSummary.innerHTML = `
          <div class="admin-summary__card">
            <div class="admin-summary__icon" style="background:linear-gradient(135deg,#0b3d2e,#10a37f);"><i class="fas fa-users"></i></div>
            <div style="min-width:0;">
              <div class="admin-summary__label">Total de usuários</div>
              <div class="admin-summary__value">${total}</div>
            </div>
          </div>
          <div class="admin-summary__card">
            <div class="admin-summary__icon" style="background:linear-gradient(135deg,#047857,#10b981);"><i class="fab fa-whatsapp"></i></div>
            <div style="min-width:0;">
              <div class="admin-summary__label">Conectados agora</div>
              <div class="admin-summary__value">${connected}</div>
            </div>
          </div>
          <div class="admin-summary__card">
            <div class="admin-summary__icon" style="background:linear-gradient(135deg,#b91c1c,#ef4444);"><i class="fas fa-plug-circle-xmark"></i></div>
            <div style="min-width:0;">
              <div class="admin-summary__label">Desconectados</div>
              <div class="admin-summary__value">${disconnected}</div>
            </div>
          </div>
          <div class="admin-summary__card">
            <div class="admin-summary__icon" style="background:linear-gradient(135deg,#1d4ed8,#3b82f6);"><i class="fas fa-comments"></i></div>
            <div style="min-width:0;">
              <div class="admin-summary__label">Conversas (total)</div>
              <div class="admin-summary__value">${totalConversations.toLocaleString('pt-BR')}</div>
            </div>
          </div>
        `;
    }

    function statusMeta(status) {
        if (status === 'connected') return { label: 'Conectado', cls: 'is-on' };
        if (status === 'authenticated' || status === 'initializing') return { label: 'Preparando', cls: 'is-warn' };
        if (status === 'disconnected' || status === 'auth_failed') return { label: 'Desconectado', cls: 'is-off' };
        if (status === 'reconnecting') return { label: 'Reconectando', cls: 'is-warn' };
        if (status === 'none') return { label: 'Sem sessão', cls: 'is-mute' };
        return { label: 'Pendente', cls: 'is-warn' };
    }

    function buildAdminCard(u) {
        const st = statusMeta(u.status || 'none');
        const history = Array.isArray(u.history) ? u.history : [];
        const renderHistoryItem = (h) => {
            const isOn = h.type === 'connect' || h.type === 'connected';
            return `<div class="admin-history__item">
                <span class="admin-history__dot ${isOn ? 'on' : 'off'}"></span>
                <div style="min-width:0; flex:1;">
                    <div class="admin-history__when">${formatFullDateTime(h.at)}</div>
                    <div style="color:#64748b; font-size:0.78rem;">${escapeHtml(h.label || (isOn ? 'Conectou' : 'Desconectou'))}${h.number ? ' • <b>' + escapeHtml(h.number) + '</b>' : ''}</div>
                </div>
            </div>`;
        };
        const previewHtml = history.length
            ? history.slice(0, 2).map(renderHistoryItem).join('')
            : '<div style="padding:10px 6px; color:#94a3b8; font-size:0.82rem;">Sem movimentações registradas ainda.</div>';
        const hasMore = history.length > 2;

        const safeId = escapeHtml(u.id || u.email || '');
        const numberDisplay = u.whatsappNumber ? escapeHtml(u.whatsappNumber) : '—';
        const proxyDisplay = u.proxy ? escapeHtml(u.proxy) : '—';
        const ipDisplay = u.ip || u.lastIp ? escapeHtml(u.ip || u.lastIp) : '—';
        const conversations = Number(u.totalConversations || u.conversations || 0) || 0;
        const contacts = Number(u.totalContacts || u.contacts || 0) || 0;

        const card = document.createElement('div');
        card.className = 'admin-card';
        card.innerHTML = `
            <div class="admin-card__head">
                <div class="admin-card__avatar">${escapeHtml(initials(u.name, u.email))}</div>
                <div class="admin-card__idbox">
                    <div class="admin-card__name" title="${escapeHtml(u.name || '')}">${escapeHtml(u.name || '—')}</div>
                    <div class="admin-card__email">${escapeHtml(u.email || '—')}</div>
                </div>
                <span class="admin-card__pill ${st.cls}"><span class="dot"></span>${st.label}</span>
            </div>

            <div class="admin-card__stats">
                <div class="admin-mini">
                    <div class="admin-mini__label"><i class="fab fa-whatsapp"></i> Número</div>
                    <div class="admin-mini__value" title="${numberDisplay}">${numberDisplay}</div>
                </div>
                <div class="admin-mini">
                    <div class="admin-mini__label"><i class="fas fa-network-wired"></i> Proxy</div>
                    <div class="admin-mini__value" title="${proxyDisplay}">${proxyDisplay}</div>
                </div>
                <div class="admin-mini">
                    <div class="admin-mini__label"><i class="fas fa-globe"></i> IP</div>
                    <div class="admin-mini__value" title="${ipDisplay}">${ipDisplay}</div>
                </div>
                <div class="admin-mini">
                    <div class="admin-mini__label"><i class="fas fa-clock"></i> Último acesso</div>
                    <div class="admin-mini__value" title="${formatFullDateTime(u.lastAccess || u.lastSeen || u.lastQrAt)}">${relativeTime(u.lastAccess || u.lastSeen || u.lastQrAt)}</div>
                </div>
                <div class="admin-mini">
                    <div class="admin-mini__label"><i class="fas fa-comments"></i> Conversas</div>
                    <div class="admin-mini__value">${conversations.toLocaleString('pt-BR')}</div>
                </div>
                <div class="admin-mini">
                    <div class="admin-mini__label"><i class="fas fa-address-book"></i> Contatos</div>
                    <div class="admin-mini__value">${contacts.toLocaleString('pt-BR')}</div>
                </div>
            </div>

            <div class="admin-card__timeline">
                <div class="admin-time">
                    <i class="fas fa-circle-play"></i>
                    <div style="min-width:0;">
                        <div style="font-size:0.68rem; color:#64748b; text-transform:uppercase; letter-spacing:0.1em; font-weight:700;">Conectou em</div>
                        <strong title="${formatFullDateTime(u.connectedAt || u.firstConnectedAt)}">${formatFullDateTime(u.connectedAt || u.firstConnectedAt)}</strong>
                    </div>
                </div>
                <div class="admin-time off">
                    <i class="fas fa-circle-stop"></i>
                    <div style="min-width:0;">
                        <div style="font-size:0.68rem; color:#64748b; text-transform:uppercase; letter-spacing:0.1em; font-weight:700;">Última desconexão</div>
                        <strong title="${formatFullDateTime(u.disconnectedAt || u.lastDisconnectedAt)}">${formatFullDateTime(u.disconnectedAt || u.lastDisconnectedAt)}</strong>
                    </div>
                </div>
            </div>

            <div class="admin-card__actions">
                <button type="button" class="admin-btn history" data-action="open-history"><i class="fas fa-clock-rotate-left"></i> Histórico completo${hasMore ? ' <span style="opacity:.7;">('+history.length+')</span>' : ''}</button>
                <button type="button" class="admin-btn delete" data-action="delete-user" data-id="${safeId}" data-name="${escapeHtml(u.name || u.email || 'usuário')}"><i class="fas fa-trash-can"></i> Excluir</button>
            </div>

            <div class="admin-history-preview" style="margin-top:10px; border-top:1px dashed #e5e7eb; padding-top:10px; display:flex; flex-direction:column; gap:6px;">
                <div style="font-size:0.68rem; color:#64748b; text-transform:uppercase; letter-spacing:0.1em; font-weight:700;">Últimas movimentações</div>
                ${previewHtml}
            </div>
        `;

        // wire up events
        card.querySelector('[data-action="open-history"]').addEventListener('click', () => {
            openAdminHistoryModal(u);
        });
        card.querySelector('[data-action="delete-user"]').addEventListener('click', async (e) => {
            const id = e.currentTarget.getAttribute('data-id');
            const name = e.currentTarget.getAttribute('data-name');
            const ok = await (window.zapmroConfirm ? window.zapmroConfirm({
                title: 'Excluir cadastro?',
                message: `Isso vai remover permanentemente <b>${escapeHtml(name)}</b>, sua sessão do WhatsApp e todo o histórico. A ação não pode ser desfeita.`,
                confirmLabel: 'Excluir',
                cancelLabel: 'Cancelar',
                icon: 'fa-triangle-exclamation'
            }) : Promise.resolve(confirm('Excluir este usuário?')));
            if (!ok) return;
            await deleteAdminUser(id, card);
        });
        return card;
    }

    function openAdminHistoryModal(u) {
        const history = Array.isArray(u.history) ? u.history.slice() : [];
        // sort desc by time
        history.sort((a, b) => (b.at || 0) - (a.at || 0));

        let overlay = document.getElementById('adminHistoryModalOverlay');
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.id = 'adminHistoryModalOverlay';
        overlay.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,42,0.55); backdrop-filter:blur(4px); z-index:10000; display:flex; align-items:center; justify-content:center; padding:20px; animation: ahmFade .18s ease;';

        const items = history.length ? history.map(h => {
            const isOn = h.type === 'connect' || h.type === 'connected';
            const color = isOn ? '#10b981' : '#ef4444';
            const bg = isOn ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.06)';
            return `<div style="display:flex; gap:12px; padding:12px 14px; background:${bg}; border:1px solid ${isOn ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.18)'}; border-radius:12px;">
                <div style="width:10px; height:10px; margin-top:6px; border-radius:50%; background:${color}; box-shadow:0 0 0 4px ${bg}; flex:0 0 auto;"></div>
                <div style="min-width:0; flex:1;">
                    <div style="font-weight:700; color:#0f172a; font-size:0.9rem;">${formatFullDateTime(h.at)}</div>
                    <div style="color:#475569; font-size:0.82rem; margin-top:2px;">${escapeHtml(h.label || (isOn ? 'Conectou' : 'Desconectou'))}${h.number ? ' • <b style="color:#0f172a;">'+escapeHtml(h.number)+'</b>' : ''}</div>
                </div>
                <div style="align-self:center; font-size:0.7rem; font-weight:800; letter-spacing:.08em; text-transform:uppercase; color:${color};">${isOn ? 'Conexão' : 'Desconexão'}</div>
            </div>`;
        }).join('') : '<div style="padding:26px; text-align:center; color:#94a3b8;">Sem histórico registrado para este cadastro.</div>';

        overlay.innerHTML = `
            <div role="dialog" aria-modal="true" style="background:#fff; width:100%; max-width:560px; max-height:85vh; border-radius:20px; box-shadow:0 30px 60px -20px rgba(2,6,23,0.55); display:flex; flex-direction:column; overflow:hidden; animation: ahmSlide .22s ease;">
                <div style="padding:18px 20px; background:linear-gradient(135deg,#065f46,#047857); color:#fff; display:flex; align-items:center; gap:14px;">
                    <div style="width:44px; height:44px; border-radius:12px; background:rgba(255,255,255,0.15); display:grid; place-items:center; font-weight:800;">${escapeHtml(initials(u.name, u.email))}</div>
                    <div style="min-width:0; flex:1;">
                        <div style="font-size:0.7rem; text-transform:uppercase; letter-spacing:.14em; opacity:.85; font-weight:700;">Histórico completo</div>
                        <div style="font-size:1.05rem; font-weight:800; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(u.name || u.email || 'Cadastro')}</div>
                        <div style="font-size:0.78rem; opacity:.85; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(u.email || '')}</div>
                    </div>
                    <button type="button" data-action="close-ahm" aria-label="Fechar" style="border:none; background:rgba(255,255,255,0.15); color:#fff; width:36px; height:36px; border-radius:10px; cursor:pointer; font-size:1rem;"><i class="fas fa-times"></i></button>
                </div>
                <div style="padding:12px 20px 6px; display:flex; gap:8px; flex-wrap:wrap; border-bottom:1px solid #f1f5f9; background:#fafbfc;">
                    <span style="font-size:0.72rem; background:#ecfdf5; color:#065f46; padding:4px 10px; border-radius:999px; font-weight:700;">${history.filter(h => h.type === 'connect' || h.type === 'connected').length} conexões</span>
                    <span style="font-size:0.72rem; background:#fef2f2; color:#991b1b; padding:4px 10px; border-radius:999px; font-weight:700;">${history.filter(h => !(h.type === 'connect' || h.type === 'connected')).length} desconexões</span>
                    <span style="font-size:0.72rem; background:#eef2ff; color:#3730a3; padding:4px 10px; border-radius:999px; font-weight:700;">${history.length} registros</span>
                </div>
                <div style="padding:16px 20px; overflow-y:auto; display:flex; flex-direction:column; gap:10px; flex:1;">${items}</div>
                <div style="padding:14px 20px; border-top:1px solid #f1f5f9; display:flex; justify-content:flex-end; gap:8px; background:#fafbfc;">
                    <button type="button" data-action="close-ahm" style="padding:8px 16px; border-radius:10px; border:1px solid #e2e8f0; background:#fff; color:#334155; font-weight:600; cursor:pointer;">Fechar</button>
                </div>
            </div>
        `;

        // inject keyframes once
        if (!document.getElementById('adminHistoryModalStyles')) {
            const st = document.createElement('style');
            st.id = 'adminHistoryModalStyles';
            st.textContent = '@keyframes ahmFade{from{opacity:0}to{opacity:1}}@keyframes ahmSlide{from{opacity:0;transform:translateY(12px) scale(.98)}to{opacity:1;transform:none}}';
            document.head.appendChild(st);
        }

        const close = () => overlay.remove();
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        overlay.querySelectorAll('[data-action="close-ahm"]').forEach(b => b.addEventListener('click', close));
        document.addEventListener('keydown', function onEsc(ev) {
            if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
        });

        document.body.appendChild(overlay);
    }

    async function deleteAdminUser(id, cardEl) {
        if (!id) return;
        try {
            const res = await authFetch('/api/admin/users/' + encodeURIComponent(id), { method: 'DELETE' });
            if (res.ok) {
                if (cardEl && cardEl.parentNode) cardEl.parentNode.removeChild(cardEl);
                loadAdminUsers();
            } else {
                alert('Não foi possível excluir este usuário.');
            }
        } catch (err) {
            console.error('Erro excluir user:', err);
            alert('Erro ao excluir usuário.');
        }
    }

    function renderAdminUsers(users) {
        if (!adminUsersGrid) return;
        adminUsersGrid.innerHTML = '';
        renderAdminSummary(users);
        if (!users.length) {
            adminUsersGrid.innerHTML = `<div class="admin-empty">
                <i class="fas fa-user-slash"></i>
                Nenhum usuário cadastrado ainda.
            </div>`;
            return;
        }
        users.forEach(u => adminUsersGrid.appendChild(buildAdminCard(u)));
    }

    async function loadAdminUsers() {
        try {
            if (!authToken || authRole !== 'admin') return;
            
            const response = await authFetch('/api/admin/users');
            if (response.status === 401) {
                clearAuth();
                applyLoggedOutUI();
                return;
            }
            const data = await response.json();
            const users = data && data.success && Array.isArray(data.users) ? data.users : [];
            renderAdminUsers(users);
        } catch (e) {
            console.error('Erro ao carregar usuários admin:', e);
            renderAdminUsers([]);
        }
    }

    // Renderizar lista de sessões
    function renderSessions(sessions) {
        const list = Array.isArray(sessions) ? sessions : [];
        // Admin não precisa da seção "WhatsApp Demonstração" no topo — ele já tem o botão "Meu WhatsApp"
        if (authRole === 'admin') {
            if (sessionsContainer) {
                sessionsContainer.innerHTML = '';
                sessionsContainer.style.display = 'none';
            }
            const adminIntroCard = document.querySelector('.admin-intro-card, #adminSessionsWrapper, #adminConnectionsSection');
            if (adminIntroCard) adminIntroCard.style.display = 'none';
            return;
        }
        const hasConnectedLike = list.some(s => s && s.status === 'connected');
        const firstConnected = list.find(s => s && s.status === 'connected') || null;

        // Persistir/detectar histórico do número conectado
        if (firstConnected && firstConnected.phoneNumber) {
            const num = firstConnected.phoneNumber;
            const prev = getWhatsHistory();
            const isNewTransition = lastKnownConnectedNumber !== num;
            saveWhatsHistory(num);
            if (isNewTransition && prev && prev.phoneNumber && prev.phoneNumber !== num && window.zapmroHistoryInfo) {
                window.zapmroHistoryInfo({
                    title: 'Novo número conectado',
                    tone: 'warning',
                    message: 'Você conectou o número <b>' + num + '</b>, diferente do anterior (<b>' + prev.phoneNumber + '</b>). Esta é uma nova conexão e <b>não</b> carrega o histórico do número anterior. O histórico do número novo começará agora.'
                });
            }
            lastKnownConnectedNumber = num;
        } else if (!hasConnectedLike) {
            lastKnownConnectedNumber = null;
        }

        if (authRole === 'user') {
            setRightPanelVisible(hasConnectedLike);
            if (refreshSessionsBtn) refreshSessionsBtn.style.display = hasConnectedLike ? '' : 'none';
            const shell = document.querySelector('.auth-shell');
            if (shell) shell.classList.toggle('is-connected', hasConnectedLike);
            document.body.classList.toggle('zapmro-connected', hasConnectedLike);
            if (connectionPanel) connectionPanel.classList.toggle('is-unified', hasConnectedLike);
            if (createSessionBtn) createSessionBtn.style.display = hasConnectedLike ? 'none' : '';
            if (hasConnectedLike && qrContainer) qrContainer.style.display = 'none';
            const statConn = document.getElementById('statConn');
            const statSessions = document.getElementById('statSessions');
            if (statConn) statConn.textContent = hasConnectedLike ? 'Conectado' : 'Desconectado';
            if (statSessions) statSessions.textContent = String(list.length);
            const hint = document.getElementById('connectHint');
            if (hint) hint.textContent = hasConnectedLike
                ? 'Seu WhatsApp ja esta conectado. Abra o dashboard para continuar.'
                : 'Voce pode conectar apenas 1 aparelho. Gere o QR Code para conectar seu WhatsApp.';
            if (openCrmBtn) {
                if (hasConnectedLike && firstConnected && firstConnected.sessionId) {
                    openCrmBtn.href = getCrmUrl(firstConnected.sessionId);
                    openCrmBtn.style.display = '';
                } else {
                    openCrmBtn.style.display = 'none';
                }
            }
        }

        if (list.length === 0) {
            sessionsContainer.innerHTML = `
                <div class="no-session">
                    <i class="fas fa-plug" style="font-size: 3rem; color: #ddd; margin-bottom: 20px;"></i>
                    <p>Nenhuma conexão ativa no momento</p>
                </div>
            `;
            return;
        }
        
        sessionsContainer.innerHTML = '';
        const useUnified = authRole === 'user' && hasConnectedLike;
        if (useUnified) {
            const heading = document.createElement('h3');
            heading.className = 'unified-heading';
            heading.textContent = 'Sua conta e conexão';
            sessionsContainer.appendChild(heading);
        }

        list.forEach(session => {
            const sessionCard = document.createElement('div');
            sessionCard.className = 'session-card';
            
            let statusClass = 'pending';
            const isConnectedLike = session.status === 'connected';
            const crmUrl = getCrmUrl(session.sessionId);
            if (isConnectedLike) statusClass = 'connected';
            if (session.status === 'auth_failed') statusClass = 'disconnected';
            
            let actionButtons = '';
            const canOpenPanel = session.status !== 'auth_failed';
            if (canOpenPanel) {
                if (session.hasPassword) {
                    actionButtons = `
                        <button onclick="verifyAndOpen('${session.sessionId}', '${crmUrl}')" class="btn btn-whatsapp">
                            <i class="fab fa-whatsapp"></i> Abrir WhatsApp
                        </button>
                        <button onclick="setSessionPassword('${session.sessionId}')" class="btn btn-secondary">
                            <i class="fas fa-lock"></i> Definir Senha
                        </button>
                        <button onclick="verifyAndDisconnect('${session.sessionId}')" class="btn btn-danger">
                            <i class="fas fa-power-off"></i> Desconectar
                        </button>
                        <button onclick="deleteSessionPermanently('${session.sessionId}')" class="btn btn-danger btn-danger--solid">
                            <i class="fas fa-trash"></i> Excluir permanente
                        </button>
                    `;
                } else {
                    actionButtons = `
                        <a href="${crmUrl}" class="btn btn-whatsapp">
                            <i class="fab fa-whatsapp"></i> Abrir WhatsApp
                        </a>
                        <button onclick="setSessionPassword('${session.sessionId}')" class="btn btn-secondary">
                            <i class="fas fa-lock"></i> Definir Senha
                        </button>
                        <button onclick="disconnectSession('${session.sessionId}')" class="btn btn-danger">
                            <i class="fas fa-power-off"></i> Desconectar
                        </button>
                        <button onclick="deleteSessionPermanently('${session.sessionId}')" class="btn btn-danger btn-danger--solid">
                            <i class="fas fa-trash"></i> Excluir permanente
                        </button>
                    `;
                }
            } else {
                actionButtons = `
                    <button onclick="disconnectSession('${session.sessionId}')" class="btn btn-danger">
                        <i class="fas fa-power-off"></i> Desconectar
                    </button>
                    <button onclick="deleteSessionPermanently('${session.sessionId}')" class="btn btn-danger btn-danger--solid">
                        <i class="fas fa-trash"></i> Excluir permanente
                    </button>
                `;
            }

            if (useUnified && isConnectedLike) {
                sessionCard.classList.add('unified-card');
                const email = (localStorage.getItem('userEmail') || '').trim();
                const displayName = email ? (email.split('@')[0].charAt(0).toUpperCase() + email.split('@')[0].slice(1)) : 'Usuário';
                sessionCard.innerHTML = `
                    <div class="uc-user">
                        <div class="uc-user__top">
                            <div class="uc-user__avatar"><i class="fas fa-user"></i></div>
                            <div style="min-width:0;">
                                <div class="uc-user__name">${displayName}</div>
                                <div class="uc-user__email">${email || ''}</div>
                            </div>
                        </div>
                        <div class="uc-stats">
                            <div class="uc-stat">
                                <div class="uc-stat__label">Status</div>
                                <div class="uc-stat__value"><span class="uc-stat__dot"></span><span>Conectado</span></div>
                            </div>
                            <div class="uc-stat">
                                <div class="uc-stat__label">Sessões</div>
                                <div class="uc-stat__value">${list.length}</div>
                            </div>
                            <div class="uc-stat">
                                <div class="uc-stat__label">Plano</div>
                                <div class="uc-stat__value">Teste</div>
                            </div>
                        </div>
                    </div>
                    <div class="uc-conn">
                        <div class="uc-conn__head">
                            <div class="uc-conn__icon"><i class="fab fa-whatsapp"></i></div>
                            <div class="uc-conn__title">${session.name || 'WhatsApp'}</div>
                        </div>
                        <div class="uc-conn__meta"><span>Número:</span> ${formatSessionPhone(session.phoneNumber) || 'Não conectado'}</div>
                        <div class="uc-conn__meta"><span>ID:</span> ${session.sessionId}</div>
                        <span class="uc-badge">CONECTADO</span>
                        <button type="button" class="uc-refresh" onclick="if(window.refreshSessionsBtn)window.refreshSessionsBtn.click();document.getElementById('refreshSessionsBtn')&&document.getElementById('refreshSessionsBtn').click();">
                            <i class="fas fa-sync-alt"></i> Atualizar conexão
                            <strong style="margin-left:6px;">Conexão ativa e estável</strong>
                        </button>
                        <div style="font-size:0.75rem; color:var(--muted); margin-top:-2px;">Sua integração está funcionando normalmente.</div>
                    </div>
                    <div class="uc-actions">
                        ${actionButtons}
                    </div>
                `;
            } else {
            sessionCard.innerHTML = `
                <div class="session-info">
                    <h4>${session.name || 'WhatsApp'}</h4>
                    <p><strong>Numero:</strong> ${formatSessionPhone(session.phoneNumber) || 'Nao conectado'}</p>
                    <p><strong>ID:</strong> ${session.sessionId}</p>
                </div>
                <div>
                    <span class="status ${statusClass}">
                        ${isConnectedLike ? 'Conectado' : session.status === 'auth_failed' ? 'Falha' : 'Pendente'}
                    </span>
                    <div class="session-actions">
                        ${actionButtons}
                    </div>
                </div>
            `;
            }
            sessionsContainer.appendChild(sessionCard);
        });
    }

    // Check auth on load
    tryInitFromStoredAuth();

    // Funções Globais de Segurança
    const internalPrompt = (() => {
        let overlay = null;
        let modal = null;
        let titleEl = null;
        let messageEl = null;
        let inputEl = null;
        let okBtn = null;
        let cancelBtn = null;
        let resolver = null;
        let escHandler = null;

        function ensure() {
            if (overlay) return;

            overlay = document.createElement('div');
            overlay.id = 'internalPromptOverlay';
            overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.45); display:none; align-items:center; justify-content:center; z-index:99999; padding:16px;';

            modal = document.createElement('div');
            modal.style.cssText = 'width:100%; max-width:420px; background:#fff; border-radius:10px; box-shadow:0 10px 30px rgba(0,0,0,0.25); overflow:hidden; font-family:inherit;';

            const header = document.createElement('div');
            header.style.cssText = 'padding:14px 16px; background:#f6f7f9; border-bottom:1px solid #eee; display:flex; align-items:center; justify-content:space-between; gap:10px;';

            titleEl = document.createElement('div');
            titleEl.style.cssText = 'font-weight:700; color:#111;';
            header.appendChild(titleEl);

            const body = document.createElement('div');
            body.style.cssText = 'padding:14px 16px;';

            messageEl = document.createElement('div');
            messageEl.style.cssText = 'color:#333; margin-bottom:12px; line-height:1.35;';
            body.appendChild(messageEl);

            inputEl = document.createElement('input');
            inputEl.style.cssText = 'width:100%; padding:10px 12px; border:1px solid #ddd; border-radius:8px; font-size:14px; outline:none;';
            inputEl.autocomplete = 'current-password';
            body.appendChild(inputEl);

            const footer = document.createElement('div');
            footer.style.cssText = 'padding:14px 16px; display:flex; gap:10px; justify-content:flex-end; border-top:1px solid #eee; background:#fff;';

            cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'btn btn-secondary';
            cancelBtn.style.cssText = 'padding:8px 14px; border-radius:8px; border:1px solid #ddd; background:#fff; cursor:pointer;';
            cancelBtn.textContent = 'Cancelar';

            okBtn = document.createElement('button');
            okBtn.type = 'button';
            okBtn.className = 'btn';
            okBtn.style.cssText = 'padding:8px 14px; border-radius:8px; border:none; background:#008069; color:#fff; cursor:pointer;';
            okBtn.textContent = 'OK';

            footer.appendChild(cancelBtn);
            footer.appendChild(okBtn);

            modal.appendChild(header);
            modal.appendChild(body);
            modal.appendChild(footer);

            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) close(null);
            });

            okBtn.addEventListener('click', () => close(inputEl.value));
            cancelBtn.addEventListener('click', () => close(null));
            inputEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') close(inputEl.value);
                if (e.key === 'Escape') close(null);
            });
        }

        function open({ title, message, placeholder, type = 'text' }) {
            ensure();

            titleEl.textContent = title || 'Confirmação';
            messageEl.textContent = message || '';
            inputEl.value = '';
            inputEl.placeholder = placeholder || '';
            inputEl.type = type;

            overlay.style.display = 'flex';

            if (escHandler) {
                document.removeEventListener('keydown', escHandler, true);
                escHandler = null;
            }

            escHandler = (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    close(null);
                }
            };
            document.addEventListener('keydown', escHandler, true);

            setTimeout(() => inputEl.focus(), 0);

            return new Promise((resolve) => {
                resolver = resolve;
            });
        }

        function close(value) {
            if (!overlay || overlay.style.display === 'none') return;
            overlay.style.display = 'none';

            if (escHandler) {
                document.removeEventListener('keydown', escHandler, true);
                escHandler = null;
            }

            const resolve = resolver;
            resolver = null;
            if (resolve) resolve(value);
        }

        return { open };
    })();

    async function safePrompt({ title, message, placeholder, type = 'text' }) {
        try {
            const v = prompt(message);
            if (v === null || v === undefined) return null;
            return String(v);
        } catch (e) {
            const v = await internalPrompt.open({ title, message, placeholder, type });
            if (v === null || v === undefined) return null;
            return String(v);
        }
    }

    window.setSessionPassword = async function(sessionId) {
        const password = await safePrompt({
            title: 'Definir senha',
            message: 'Defina uma senha para proteger esta sessão:',
            placeholder: 'Senha',
            type: 'password'
        });
        if (password) {
            socket.emit('set-session-password', { sessionId, password });
            alert('Senha definida! Os botões agora estão bloqueados.');
        }
    };

    window.verifyAndOpen = async function(sessionId, url) {
        const password = await safePrompt({
            title: 'Sessão protegida',
            message: 'Esta sessão está protegida. Digite a senha:',
            placeholder: 'Senha',
            type: 'password'
        });
        if (password) {
            window.pendingAction = { type: 'open', sessionId, url };
            socket.emit('verify-session-password', { sessionId, password });
        }
    };

    window.verifyAndDisconnect = async function(sessionId) {
        const password = await safePrompt({
            title: 'Desconectar sessão',
            message: 'Esta sessão está protegida. Digite a senha para desconectar:',
            placeholder: 'Senha',
            type: 'password'
        });
        if (password) {
            window.pendingAction = { type: 'disconnect', sessionId };
            socket.emit('verify-session-password', { sessionId, password });
        }
    };

    // Função real de desconexão (chamada após verificação ou diretamente)
    window.actualDisconnectSession = async function(sessionId) {
         try {
            const response = await authFetch('/api/disconnect-session', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ sessionId })
            });
            
            const data = await response.json();
            
            if (data.success) {
                if (sessionId === currentSessionId) {
                    currentSessionId = null;
                    resetUserConnectionState('<p><strong>Status:</strong> <span class="status disconnected">Desconectado</span></p><p>Gere um novo QR Code para reconectar seu WhatsApp.</p>');
                }
                loadActiveSessions();
            }
        } catch (error) {
            console.error('Erro ao desconectar sessão:', error);
            alert('Erro ao desconectar sessão');
        }
    };

    // Função global para desconectar sessão (legado/sem senha)
    window.disconnectSession = async function(sessionId) {
        const ok = await (window.zapmroConfirm
            ? window.zapmroConfirm({
                title: 'Desconectar WhatsApp?',
                subtitle: 'Esta sessão será encerrada',
                message: 'Você poderá reconectar depois gerando um novo QR Code. Deseja continuar?',
                icon: 'fa-power-off',
                okText: 'Desconectar',
                okIcon: 'fa-power-off',
                tone: 'warning'
            })
            : Promise.resolve(confirm('Tem certeza que deseja desconectar esta sessão?')));
        if (ok) window.actualDisconnectSession(sessionId);
    };

    window.deleteSessionPermanently = async function(sessionId) {
        const okDelete = await (window.zapmroConfirm
            ? window.zapmroConfirm({
                title: 'Excluir permanentemente?',
                subtitle: 'Esta ação não pode ser desfeita',
                message: 'Todos os dados desta sessão serão removidos definitivamente. Você precisará da senha master para confirmar na próxima etapa.',
                icon: 'fa-trash',
                okText: 'Sim, excluir',
                okIcon: 'fa-trash',
                tone: 'danger'
            })
            : Promise.resolve(confirm('Tem certeza que deseja excluir esta sessão permanentemente?')));
        if (!okDelete) return;

        const password = await safePrompt({
            title: 'Excluir sessão permanentemente',
            message: 'Digite a senha master para excluir permanentemente:',
            placeholder: 'Senha master',
            type: 'password'
        });
        if (!password) return;

        socket.emit('delete-session-permanently', { sessionId, password }, (res) => {
            if (res && res.ok) {
                alert('Sessão excluída permanentemente.');
                loadActiveSessions();
                return;
            }
            alert((res && res.error) ? res.error : 'Erro ao excluir sessão.');
        });
    };
    
    // ============ ADMIN — Meu WhatsApp (conexão do próprio admin, IP real) ============
    (function initAdminMyWhats() {
        const ADMIN_SELF_SESSION_ID = 'session_admin_self';
        const openBtn   = document.getElementById('adminMyWhatsBtn');
        const panel     = document.getElementById('adminMyWhatsPanel');
        const closeBtn  = document.getElementById('adminMyWhatsClose');
        const ipEl      = document.getElementById('adminMyWhatsIp');
        const genBtn    = document.getElementById('adminGenerateQrBtn');
        const openCrm   = document.getElementById('adminOpenCrmBtn');
        const discBtn   = document.getElementById('adminDisconnectMyBtn');
        const qrEmpty   = document.getElementById('adminMyWhatsQrEmpty');
        const qrLoaded  = document.getElementById('adminMyWhatsQrLoaded');
        const qrImg     = document.getElementById('adminMyWhatsQrImg');
        const countEl   = document.getElementById('adminMyWhatsCountdown');
        const msgEl     = document.getElementById('adminMyWhatsMsg');
        if (!openBtn || !panel) return;

        let countdownTimer = null;
        let adminSessionId = ADMIN_SELF_SESSION_ID;

        function setMsg(text, kind) {
            if (!msgEl) return;
            if (!text) { msgEl.style.display = 'none'; msgEl.textContent = ''; return; }
            msgEl.style.display = '';
            msgEl.className = 'admin-mywa__msg is-' + (kind || 'info');
            msgEl.innerHTML = text;
        }

        function showQr(dataUrl) {
            if (qrImg) qrImg.src = dataUrl || '';
            if (qrEmpty) qrEmpty.style.display = 'none';
            if (qrLoaded) qrLoaded.style.display = '';
            startCountdown(45);
        }

        function showConnected() {
            if (qrEmpty) {
                qrEmpty.style.display = '';
                qrEmpty.innerHTML = '<i class="fas fa-circle-check" style="color:#10a37f;"></i><p><b>WhatsApp do admin conectado.</b><br>Sua conexão usa o IP real da máquina.</p>';
            }
            if (qrLoaded) qrLoaded.style.display = 'none';
            if (openCrm) openCrm.style.display = '';
            if (discBtn) discBtn.style.display = '';
            if (genBtn)  genBtn.innerHTML = '<i class="fas fa-rotate"></i> Reconectar';
            stopCountdown();
        }

        function resetQr() {
            if (qrLoaded) qrLoaded.style.display = 'none';
            if (qrEmpty) {
                qrEmpty.style.display = '';
                qrEmpty.innerHTML = '<i class="fab fa-whatsapp"></i><p>Clique em <b>Gerar QR Code</b> para conectar seu número.</p>';
            }
            if (openCrm) openCrm.style.display = 'none';
            if (discBtn) discBtn.style.display = 'none';
            if (genBtn)  genBtn.innerHTML = '<i class="fas fa-qrcode"></i> Gerar QR Code';
            stopCountdown();
        }

        function setDisconnectedState() {
            resetQr();
            setMsg('WhatsApp do admin desconectado. Gere um novo QR Code para conectar novamente.', 'info');
        }

        async function refreshAdminSelfState() {
            try {
                const response = await authFetch('/api/admin/self-session-status');
                const data = await response.json().catch(() => ({}));
                const session = data && data.session ? data.session : null;
                adminSessionId = (session && session.sessionId) ? session.sessionId : ADMIN_SELF_SESSION_ID;
                if (socket) socket.emit('bind-session', adminSessionId);
                if (!response.ok || !session) {
                    resetQr();
                    return;
                }
                if (session.status === 'connected') {
                    showConnected();
                    setMsg('WhatsApp conectado com sucesso via IP real.', 'ok');
                    if (openCrm) openCrm.href = getCrmUrl(adminSessionId);
                    return;
                }
                if (session.status === 'authenticated' || session.status === 'initializing' || session.status === 'reconnecting') {
                    resetQr();
                    setMsg('Sessão do admin encontrada. Aguardando sincronização da conexão...', 'info');
                    if (openCrm) openCrm.href = getCrmUrl(adminSessionId);
                    return;
                }
                setDisconnectedState();
            } catch (_) {
                resetQr();
            }
        }

        function startCountdown(sec) {
            stopCountdown();
            let n = sec;
            if (countEl) countEl.textContent = n;
            countdownTimer = setInterval(() => {
                n -= 1;
                if (countEl) countEl.textContent = Math.max(0, n);
                if (n <= 0) { stopCountdown(); resetQr(); setMsg('QR Code expirado. Gere novamente.', 'err'); }
            }, 1000);
        }
        function stopCountdown() { if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } }

        function togglePanel(force) {
            const opening = typeof force === 'boolean' ? force : panel.hasAttribute('hidden');
            if (opening) {
                panel.removeAttribute('hidden');
                panel.setAttribute('aria-hidden', 'false');
                openBtn.setAttribute('aria-expanded', 'true');
                openBtn.classList.add('is-open');
                // Fill IP from the toolbar cache
                const ipTop = document.getElementById('adminRealIp');
                if (ipEl) ipEl.textContent = (ipTop && ipTop.textContent && ipTop.textContent !== 'detectando...') ? ipTop.textContent : 'detectando...';
                if (typeof fetchAdminRealIp === 'function') { try { fetchAdminRealIp(); } catch(_){} }
                setTimeout(() => {
                    const ipNow = document.getElementById('adminRealIp');
                    if (ipEl && ipNow) ipEl.textContent = ipNow.textContent;
                }, 1200);
                refreshAdminSelfState();
                panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } else {
                panel.setAttribute('hidden', '');
                panel.setAttribute('aria-hidden', 'true');
                openBtn.setAttribute('aria-expanded', 'false');
                openBtn.classList.remove('is-open');
            }
        }

        openBtn.addEventListener('click', () => togglePanel());
        if (closeBtn) closeBtn.addEventListener('click', () => togglePanel(false));

        if (genBtn) genBtn.addEventListener('click', async () => {
            setMsg('', null);
            try {
                genBtn.disabled = true;
                genBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Gerando...';
                const r = await authFetch('/api/create-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Zapmro-Admin-Self': '1' },
                    body: JSON.stringify({ adminSelf: true, useRealIp: true })
                });
                const data = await r.json().catch(() => ({}));
                if (r.ok && data && data.success) {
                    adminSessionId = data.sessionId || ADMIN_SELF_SESSION_ID;
                    if (socket) socket.emit('bind-session', adminSessionId);
                    setMsg('Sessão criada. Aguardando QR Code...', 'info');
                } else {
                    setMsg((data && data.error) ? data.error : 'Não foi possível iniciar a sessão do admin.', 'err');
                    resetQr();
                }
            } catch (e) {
                setMsg('Erro de rede ao gerar QR. Tente novamente.', 'err');
                resetQr();
            } finally {
                genBtn.disabled = false;
                if (openCrm && openCrm.style.display === 'none') {
                    genBtn.innerHTML = '<i class="fas fa-qrcode"></i> Gerar QR Code';
                }
            }
        });

        if (discBtn) discBtn.addEventListener('click', () => {
            (async () => {
                try {
                    const r = await authFetch('/api/disconnect-session', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Zapmro-Admin-Self': '1' },
                        body: JSON.stringify({ adminSelf: true, sessionId: adminSessionId || ADMIN_SELF_SESSION_ID })
                    });
                    const data = await r.json().catch(() => ({}));
                    if (r.ok && data && data.success) {
                        setDisconnectedState();
                    } else {
                        setMsg((data && (data.message || data.error)) ? (data.message || data.error) : 'Não foi possível desconectar o WhatsApp do admin.', 'err');
                    }
                } catch (_) {
                    setMsg('Erro de rede ao desconectar o WhatsApp do admin.', 'err');
                }
            })();
        });

        // Listen to socket QR/auth events for the admin's own session
        function bindSocketOnce() {
            if (!socket || socket.__adminMyWhatsBound) return;
            socket.__adminMyWhatsBound = true;
            try { socket.emit('bind-session', adminSessionId || ADMIN_SELF_SESSION_ID); } catch (_) {}
            socket.on('qr-generated', (data) => {
                if (!data) return;
                if (String(data.sessionId || '') !== String(adminSessionId || ADMIN_SELF_SESSION_ID)) return;
                if (data.qr) {
                    showQr(data.qr);
                    setMsg('QR Code gerado. Escaneie com o WhatsApp do admin.', 'info');
                }
            });
            socket.on('client-ready', (data) => {
                if (data && String(data.sessionId || '') === String(adminSessionId || ADMIN_SELF_SESSION_ID)) {
                    showConnected();
                    setMsg('WhatsApp conectado com sucesso via IP real.', 'ok');
                    if (openCrm) openCrm.href = getCrmUrl(adminSessionId);
                }
            });
            socket.on('session-status', (data) => {
                if (!data) return;
                if (String(data.sessionId || '') !== String(adminSessionId || ADMIN_SELF_SESSION_ID)) return;
                if (data.status === 'connected') {
                    showConnected();
                    if (openCrm) openCrm.href = getCrmUrl(adminSessionId);
                    return;
                }
                if (data.status === 'authenticated' || data.status === 'initializing') {
                    resetQr();
                    setMsg('Sessão criada. Aguardando QR Code ou confirmação real da conexão.', 'info');
                    return;
                }
                if (data.status === 'disconnected' || data.status === 'auth_failed') {
                    setDisconnectedState();
                    return;
                }
                if (data.status === 'reconnecting' || data.status === 'initializing') {
                    resetQr();
                    setMsg('Preparando nova conexão do WhatsApp do admin...', 'info');
                }
            });
        }
        const bindInterval = setInterval(() => { if (typeof socket !== 'undefined' && socket) { bindSocketOnce(); clearInterval(bindInterval); } }, 500);
        setTimeout(() => {
            try { refreshAdminSelfState(); } catch (_) {}
        }, 800);
    })();

    // Carregar sessões ao iniciar
    loadActiveSessions();
    
    // Refresh periodically just in case
    setInterval(loadActiveSessions, 5000);

    // ================== PROXY MANAGER (Admin) ==================
    (function initProxyManager() {
        const STORAGE_KEY = 'zapmro_admin_proxys_v1';
        const btn = document.getElementById('adminProxysBtn');
        if (!btn) return;

        const readLocalState = () => {
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                if (raw) return JSON.parse(raw);
            } catch(e){}
            return { proxys: [], history: [] };
        };
        const writeLocalState = (s) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch(e){} };
        const fmt = (ts) => {
            if (!ts) return '—';
            try { return new Date(ts).toLocaleString('pt-BR'); } catch(e){ return String(ts); }
        };

        async function loadState() {
            let serverState = { proxys: [], history: [] };
            try {
                const response = await authFetch('/api/admin/proxies');
                const data = await response.json().catch(() => ({}));
                if (response.ok && data && data.state) {
                    serverState = data.state;
                }
            } catch (_) {}

            const localState = readLocalState();
            const hasServer = serverState && Array.isArray(serverState.proxys) && serverState.proxys.length > 0;
            const hasLocal = localState && Array.isArray(localState.proxys) && localState.proxys.length > 0;
            if (!hasServer && hasLocal) {
                try {
                    return await saveState(localState);
                } catch (_) {
                    return localState;
                }
            }
            writeLocalState(serverState);
            return serverState;
        }

        async function saveState(state) {
            const payload = state && typeof state === 'object' ? state : { proxys: [], history: [] };
            writeLocalState(payload);
            const response = await authFetch('/api/admin/proxies', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ state: payload })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data || !data.success) {
                throw new Error((data && data.error) || 'Erro ao salvar proxies');
            }
            const nextState = data.state || payload;
            writeLocalState(nextState);
            return nextState;
        }

        // Public API used by the rest of the app if it ever wants to assign a new user.
        window.assignProxyForUser = async function() {
            return null;
        };
        window.releaseProxyForUser = async function() {
            return null;
        };

        function totalStats(state) {
            const totalCap = state.proxys.reduce((s,p) => s + (p.limit||0), 0);
            const used = state.proxys.reduce((s,p) => s + ((p.assigned||[]).length), 0);
            return { totalCap, used, free: totalCap - used, count: state.proxys.length };
        }

        async function renderModal() {
            let overlay = document.getElementById('adminProxysOverlay');
            if (overlay) overlay.remove();

            const state = await loadState();
            const stats = totalStats(state);

            overlay = document.createElement('div');
            overlay.id = 'adminProxysOverlay';
            overlay.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,42,0.6); backdrop-filter:blur(4px); z-index:10001; display:flex; align-items:center; justify-content:center; padding:16px; animation: apxFade .18s ease;';

            const proxysHtml = state.proxys.length ? state.proxys.map(p => {
                const used = (p.assigned||[]).length;
                const limit = p.limit || 0;
                const pct = limit ? Math.min(100, (used/limit)*100) : 0;
                const color = pct >= 100 ? '#ef4444' : (pct >= 75 ? '#f59e0b' : '#10b981');
                const listHtml = (p.assigned||[]).length ? (p.assigned||[]).map(a => `
                    <div style="display:flex; align-items:center; gap:8px; padding:6px 8px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; font-size:0.78rem;">
                        <i class="fab fa-whatsapp" style="color:#10b981;"></i>
                        <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(a.userLabel || a.userId)}</span>
                        <span style="color:#64748b; font-size:0.7rem;">${fmt(a.at)}</span>
                        <button data-action="release" data-proxy="${escapeHtml(p.id)}" data-user="${escapeHtml(a.userId)}" title="Liberar deste proxy" style="border:none; background:transparent; color:#ef4444; cursor:pointer;"><i class="fas fa-unlink"></i></button>
                    </div>
                `).join('') : '<div style="padding:8px; color:#94a3b8; font-size:0.78rem; text-align:center;">Nenhum cadastro atribuído.</div>';

                const infoRow = (label, value, icon, mono) => value ? `
                    <div style="display:flex; align-items:center; gap:8px; font-size:0.75rem; min-width:0;">
                        <span style="color:#64748b; display:inline-flex; align-items:center; gap:6px; min-width:96px;"><i class="fas ${icon}" style="color:#94a3b8;"></i>${label}</span>
                        <span style="color:#0f172a; font-weight:700; ${mono ? 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;' : ''} overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(String(value))}</span>
                    </div>` : '';
                const statusColors = {
                    'Disponível': ['#dcfce7','#166534'],
                    'Em uso':     ['#dbeafe','#1e40af'],
                    'Vencido':    ['#fee2e2','#991b1b'],
                    'Pausado':    ['#fef3c7','#92400e']
                };
                const sc = statusColors[p.status] || ['#f1f5f9','#334155'];
                const detailsHtml = `
                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px 14px; padding:10px 12px; background:#f8fafc; border:1px solid #eef2f7; border-radius:10px;">
                        ${infoRow('Usuário',   p.username, 'fa-user', true)}
                        ${infoRow('Senha',     p.password ? '••••••••' : '', 'fa-lock', true)}
                        ${infoRow('Autentic.', p.auth,     'fa-shield-halved')}
                        ${infoRow('IP/Domínio',p.host,     'fa-globe', true)}
                        ${infoRow('Porta',     p.port,     'fa-plug', true)}
                        ${infoRow('Tipo',      p.ipType,   'fa-diagram-project')}
                        ${infoRow('Entrega',   p.deliveryDate,   'fa-truck')}
                        ${infoRow('Vencimento',p.expiryDate,     'fa-calendar-xmark')}
                        ${infoRow('Perfil',    p.profile,  'fa-id-badge')}
                        ${p.status ? `<div style="display:flex; align-items:center; gap:8px; font-size:0.75rem;">
                            <span style="color:#64748b; display:inline-flex; align-items:center; gap:6px; min-width:96px;"><i class="fas fa-signal" style="color:#94a3b8;"></i>Status</span>
                            <span style="font-weight:800; padding:2px 10px; border-radius:999px; background:${sc[0]}; color:${sc[1]};">${escapeHtml(p.status)}</span>
                        </div>` : ''}
                    </div>`;

                return `<div style="border:1px solid #e2e8f0; border-radius:14px; padding:14px; background:#fff; display:flex; flex-direction:column; gap:10px;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <div style="width:38px; height:38px; border-radius:10px; background:linear-gradient(135deg,#eef2ff,#e0e7ff); color:#4338ca; display:grid; place-items:center;"><i class="fas fa-network-wired"></i></div>
                        <div style="flex:1; min-width:0;">
                            <div style="font-weight:800; color:#0f172a; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(p.name)}</div>
                            <div style="font-size:0.75rem; color:#64748b; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(p.host || '')}${p.port ? ':' + escapeHtml(String(p.port)) : ''}</div>
                        </div>
                        <span style="font-size:0.72rem; font-weight:800; padding:4px 10px; border-radius:999px; background:${color}20; color:${color};">${used}/${limit}</span>
                        <button data-action="del-proxy" data-id="${escapeHtml(p.id)}" title="Excluir proxy" style="border:1px solid #fee2e2; background:#fff; color:#b91c1c; border-radius:8px; padding:6px 8px; cursor:pointer;"><i class="fas fa-trash"></i></button>
                    </div>
                    <div style="height:6px; background:#f1f5f9; border-radius:999px; overflow:hidden;"><div style="height:100%; width:${pct}%; background:${color}; transition:width .3s;"></div></div>
                    ${detailsHtml}
                    <div style="display:flex; flex-direction:column; gap:6px;">${listHtml}</div>
                    <div style="display:flex; gap:8px; flex-wrap:wrap;">
                        <input type="text" placeholder="ID/label do cadastro" data-role="assign-label" style="flex:1; min-width:140px; padding:8px 10px; border:1px solid #e2e8f0; border-radius:8px; font-size:0.85rem;">
                        <button data-action="assign-here" data-id="${escapeHtml(p.id)}" style="padding:8px 12px; border-radius:8px; border:none; background:#0f172a; color:#fff; font-weight:700; cursor:pointer;"><i class="fas fa-plus"></i> Atribuir</button>
                    </div>
                </div>`;
            }).join('') : '<div style="grid-column:1/-1; padding:30px; text-align:center; color:#94a3b8; border:1px dashed #e2e8f0; border-radius:14px;">Nenhum proxy cadastrado ainda. Adicione o primeiro abaixo.</div>';

            const historyHtml = state.history.length ? state.history.slice(0, 40).map(h => {
                const isAssign = h.type === 'assign';
                const color = isAssign ? '#10b981' : '#ef4444';
                return `<div style="display:flex; gap:10px; align-items:center; padding:8px 10px; border:1px solid #e2e8f0; border-radius:10px; background:#fff;">
                    <span style="width:8px; height:8px; border-radius:50%; background:${color};"></span>
                    <div style="flex:1; min-width:0;">
                        <div style="font-size:0.82rem; color:#0f172a; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${isAssign ? 'Conectou' : 'Liberou'} — ${escapeHtml(h.userLabel || h.userId)}</div>
                        <div style="font-size:0.72rem; color:#64748b;">Proxy: <b>${escapeHtml(h.proxyName || '—')}</b>${h.reason ? ' • ' + escapeHtml(h.reason) : ''}</div>
                    </div>
                    <span style="font-size:0.72rem; color:#94a3b8;">${fmt(h.at)}</span>
                </div>`;
            }).join('') : '<div style="padding:16px; text-align:center; color:#94a3b8; font-size:0.85rem;">Sem movimentações registradas.</div>';

            overlay.innerHTML = `
                <div role="dialog" aria-modal="true" style="background:#fff; width:100%; max-width:920px; max-height:90vh; border-radius:20px; box-shadow:0 30px 60px -20px rgba(2,6,23,0.6); display:flex; flex-direction:column; overflow:hidden; animation: apxSlide .22s ease;">
                    <div style="padding:18px 22px; background:linear-gradient(135deg,#312e81,#4338ca); color:#fff; display:flex; align-items:center; gap:14px;">
                        <div style="width:46px; height:46px; border-radius:12px; background:rgba(255,255,255,0.16); display:grid; place-items:center;"><i class="fas fa-network-wired"></i></div>
                        <div style="flex:1; min-width:0;">
                            <div style="font-size:0.7rem; text-transform:uppercase; letter-spacing:.14em; opacity:.85; font-weight:700;">Administrador</div>
                            <div style="font-size:1.05rem; font-weight:800;">Gerenciador de Proxys</div>
                            <div style="font-size:0.78rem; opacity:.85;">Distribuição automática por capacidade — enche um proxy antes de passar ao próximo.</div>
                        </div>
                        <button data-action="close-apx" style="border:none; background:rgba(255,255,255,0.15); color:#fff; width:36px; height:36px; border-radius:10px; cursor:pointer;"><i class="fas fa-times"></i></button>
                    </div>

                    <div style="padding:14px 22px; background:#f8fafc; border-bottom:1px solid #eef2f7; display:flex; gap:8px; flex-wrap:wrap;">
                        <span style="font-size:0.72rem; background:#eef2ff; color:#3730a3; padding:4px 10px; border-radius:999px; font-weight:700;">${stats.count} proxys</span>
                        <span style="font-size:0.72rem; background:#ecfdf5; color:#065f46; padding:4px 10px; border-radius:999px; font-weight:700;">${stats.used} em uso</span>
                        <span style="font-size:0.72rem; background:#fef3c7; color:#92400e; padding:4px 10px; border-radius:999px; font-weight:700;">${stats.free} livres</span>
                        <span style="font-size:0.72rem; background:#fee2e2; color:#991b1b; padding:4px 10px; border-radius:999px; font-weight:700;">${stats.totalCap} capacidade total</span>
                    </div>

                    <div style="padding:18px 22px; overflow-y:auto; display:flex; flex-direction:column; gap:20px; flex:1;">
                        <div>
                            <div style="font-size:0.75rem; text-transform:uppercase; letter-spacing:.12em; color:#64748b; font-weight:800; margin-bottom:12px;">Adicionar proxy</div>
                            <div class="apx-form-grid">
                                <label class="apx-field"><span>Nome</span><input id="apxName" placeholder="ex: BR-SP-01"></label>
                                <label class="apx-field apx-col-2"><span>IP / Domínio</span><input id="apxHost" placeholder="proxy.exemplo.com"></label>
                                <label class="apx-field"><span>Porta</span><input id="apxPort" type="number" placeholder="21683"></label>
                                <label class="apx-field"><span>Usuário</span><input id="apxUser" placeholder="usuário do proxy"></label>
                                <label class="apx-field"><span>Senha</span><input id="apxPass" type="text" placeholder="senha do proxy"></label>
                                <label class="apx-field"><span>Autenticação</span>
                                    <select id="apxAuth">
                                        <option value="">Selecione</option>
                                        <option value="HTTP">HTTP</option>
                                        <option value="HTTPS">HTTPS</option>
                                        <option value="SOCKS5">SOCKS5</option>
                                        <option value="SOCKS4">SOCKS4</option>
                                    </select>
                                </label>
                                <label class="apx-field"><span>Tipo</span>
                                    <select id="apxIpType">
                                        <option value="">Selecione</option>
                                        <option value="IPV4">IPV4</option>
                                        <option value="IPV6">IPV6</option>
                                    </select>
                                </label>
                                <label class="apx-field"><span>Entrega</span><input id="apxDelivery" type="date"></label>
                                <label class="apx-field"><span>Vencimento</span><input id="apxExpiry" type="date"></label>
                                <label class="apx-field"><span>Status</span>
                                    <select id="apxStatus">
                                        <option value="Disponível">Disponível</option>
                                        <option value="Em uso">Em uso</option>
                                        <option value="Pausado">Pausado</option>
                                        <option value="Vencido">Vencido</option>
                                    </select>
                                </label>
                                <label class="apx-field"><span>Perfil</span><input id="apxProfile" placeholder="opcional"></label>
                                <label class="apx-field"><span>Conexões máx.</span><input id="apxLimit" type="number" min="1" placeholder="ex: 10"></label>
                                <div class="apx-actions apx-col-full">
                                    <button data-action="add-proxy" class="apx-save-btn"><i class="fas fa-plus"></i> Salvar proxy</button>
                                </div>
                            </div>
                            <div style="font-size:0.72rem; color:#64748b; margin-top:8px; line-height:1.5;">
                                <b>Lógica automática:</b> cada novo cadastro <b>e cada número conectado</b> é atribuído ao proxy mais antigo com espaço livre.
                                Quando um cadastro é excluído ou um número é desconectado, o slot é liberado e volta a ser preenchido antes de o sistema passar para o próximo proxy.
                            </div>
                        </div>

                        <div>
                            <div style="font-size:0.75rem; text-transform:uppercase; letter-spacing:.12em; color:#64748b; font-weight:800; margin-bottom:8px;">Proxys cadastrados</div>
                            <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap:12px;">${proxysHtml}</div>
                        </div>

                        <div>
                            <div style="font-size:0.75rem; text-transform:uppercase; letter-spacing:.12em; color:#64748b; font-weight:800; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
                                <span>Histórico de conexões / desconexões</span>
                                <button data-action="clear-history" style="border:1px solid #e2e8f0; background:#fff; color:#64748b; padding:4px 10px; border-radius:8px; font-size:0.7rem; cursor:pointer;">Limpar</button>
                            </div>
                            <div style="display:flex; flex-direction:column; gap:6px; max-height:260px; overflow-y:auto;">${historyHtml}</div>
                        </div>
                    </div>

                    <div style="padding:14px 22px; border-top:1px solid #eef2f7; background:#f8fafc; display:flex; justify-content:flex-end; gap:8px;">
                        <button data-action="close-apx" style="padding:8px 16px; border-radius:10px; border:1px solid #e2e8f0; background:#fff; color:#334155; font-weight:700; cursor:pointer;">Fechar</button>
                    </div>
                </div>
            `;

            if (!document.getElementById('adminProxysStyles')) {
                const st = document.createElement('style');
                st.id = 'adminProxysStyles';
                st.textContent = `
                @keyframes apxFade{from{opacity:0}to{opacity:1}}
                @keyframes apxSlide{from{opacity:0;transform:translateY(12px) scale(.98)}to{opacity:1;transform:none}}
                .apx-form-grid{display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:12px;}
                .apx-form-grid .apx-col-2{grid-column:span 2;}
                .apx-form-grid .apx-col-full{grid-column:1 / -1;}
                .apx-field{display:flex; flex-direction:column; gap:6px; min-width:0;}
                .apx-field > span{font-size:0.72rem; font-weight:700; color:#475569; letter-spacing:.02em;}
                .apx-field input, .apx-field select{
                    width:100%; box-sizing:border-box; padding:10px 12px;
                    border:1px solid #e2e8f0; border-radius:10px; font-size:0.9rem;
                    background:#fff; color:#0f172a; outline:none; transition:border-color .15s, box-shadow .15s;
                }
                .apx-field input:focus, .apx-field select:focus{border-color:#6366f1; box-shadow:0 0 0 3px rgba(99,102,241,.15);}
                .apx-actions{display:flex; justify-content:flex-end; margin-top:4px;}
                .apx-save-btn{padding:12px 22px; border-radius:10px; border:none; background:linear-gradient(135deg,#4338ca,#6366f1); color:#fff; font-weight:800; cursor:pointer; font-size:0.9rem; box-shadow:0 8px 20px -8px rgba(67,56,202,.55);}
                .apx-save-btn:hover{filter:brightness(1.05);}
                @media (max-width: 820px){
                    .apx-form-grid{grid-template-columns:repeat(2, minmax(0,1fr));}
                    .apx-form-grid .apx-col-2{grid-column:span 2;}
                }
                @media (max-width: 480px){
                    .apx-form-grid{grid-template-columns:1fr;}
                    .apx-form-grid .apx-col-2, .apx-form-grid .apx-col-full{grid-column:1 / -1;}
                }
                `;
                document.head.appendChild(st);
            }

            const close = () => overlay.remove();
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

            overlay.addEventListener('click', async (e) => {
                const t = e.target.closest('[data-action]');
                if (!t) return;
                const action = t.getAttribute('data-action');
                if (action === 'close-apx') return close();
                const s = await loadState();
                if (action === 'add-proxy') {
                    const name = (overlay.querySelector('#apxName').value || '').trim();
                    const host = (overlay.querySelector('#apxHost').value || '').trim();
                    const port = parseInt(overlay.querySelector('#apxPort').value || '0', 10) || null;
                    const limit = parseInt(overlay.querySelector('#apxLimit').value || '0', 10);
                    const username = (overlay.querySelector('#apxUser').value || '').trim();
                    const password = (overlay.querySelector('#apxPass').value || '').trim();
                    const auth = (overlay.querySelector('#apxAuth').value || '').trim();
                    const ipType = (overlay.querySelector('#apxIpType').value || '').trim();
                    const deliveryDate = (overlay.querySelector('#apxDelivery').value || '').trim();
                    const expiryDate = (overlay.querySelector('#apxExpiry').value || '').trim();
                    const status = (overlay.querySelector('#apxStatus').value || 'Disponível').trim();
                    const profile = (overlay.querySelector('#apxProfile').value || '').trim();
                    if (!name || !limit || limit < 1) { alert('Informe nome e limite (>0).'); return; }
                    s.proxys.push({
                        id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6),
                        name, host, port, limit,
                        username, password, auth, ipType,
                        deliveryDate, expiryDate, status, profile,
                        assigned: [], createdAt: Date.now()
                    });
                    await saveState(s); await renderModal();
                } else if (action === 'del-proxy') {
                    const id = t.getAttribute('data-id');
                    const p = s.proxys.find(x => x.id === id);
                    if (p && (p.assigned||[]).length && !confirm('Este proxy tem cadastros atribuídos. Excluir mesmo assim?')) return;
                    s.proxys = s.proxys.filter(x => x.id !== id);
                    s.history.unshift({ type: 'release', proxyId: id, proxyName: p ? p.name : id, userId: '(todos)', userLabel: 'Proxy removido', reason: 'proxy excluído', at: Date.now() });
                    await saveState(s); await renderModal();
                } else if (action === 'assign-here') {
                    const id = t.getAttribute('data-id');
                    const card = t.closest('div[style*="border-radius:14px"]');
                    const inp = card ? card.querySelector('[data-role="assign-label"]') : null;
                    const label = (inp && inp.value || '').trim();
                    if (!label) { alert('Digite o ID/label do cadastro.'); return; }
                    const p = s.proxys.find(x => x.id === id);
                    if (!p) return;
                    if ((p.assigned||[]).length >= p.limit) { alert('Este proxy está cheio.'); return; }
                    p.assigned = p.assigned || [];
                    const uid = 'u_' + Date.now().toString(36);
                    p.assigned.push({ userId: uid, userLabel: label, at: Date.now() });
                    s.history.unshift({ type: 'assign', proxyId: p.id, proxyName: p.name, userId: uid, userLabel: label, at: Date.now() });
                    await saveState(s); await renderModal();
                } else if (action === 'release') {
                    const pid = t.getAttribute('data-proxy');
                    const uid = t.getAttribute('data-user');
                    const p = s.proxys.find(x => x.id === pid);
                    if (!p) return;
                    const a = (p.assigned||[]).find(x => x.userId === uid);
                    p.assigned = (p.assigned||[]).filter(x => x.userId !== uid);
                    s.history.unshift({ type: 'release', proxyId: p.id, proxyName: p.name, userId: uid, userLabel: a ? a.userLabel : uid, reason: 'liberado manualmente', at: Date.now() });
                    await saveState(s); await renderModal();
                } else if (action === 'clear-history') {
                    if (!confirm('Limpar todo o histórico?')) return;
                    s.history = []; await saveState(s); await renderModal();
                }
            });

            document.addEventListener('keydown', function onEsc(ev) {
                if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
            });

            document.body.appendChild(overlay);
        }

        btn.addEventListener('click', () => {
            renderModal().catch((err) => {
                alert((err && err.message) || 'Erro ao abrir proxies');
            });
        });

        if (authRole === 'admin' && authToken) {
            loadState().catch(() => {});
        }
    })();
});
