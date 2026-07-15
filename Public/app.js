document.addEventListener('DOMContentLoaded', function() {
    const USER_TOKEN_KEY = 'zapmro_token';
    const ADMIN_TOKEN_KEY = 'zapmro_admin_token';
    const ROLE_KEY = 'zapmro_role';
    const APP_CONFIG = window.ZAPMRO_CONFIG || {};
    const API_BASE_URL = APP_CONFIG.apiBaseUrl || window.location.origin;
    const SOCKET_URL = APP_CONFIG.socketUrl || API_BASE_URL;

    let socket = null;
    let currentSessionId = null;
    let authRole = localStorage.getItem(ROLE_KEY) || '';
    let authToken = (authRole === 'admin' ? localStorage.getItem(ADMIN_TOKEN_KEY) : localStorage.getItem(USER_TOKEN_KEY)) || '';

    function buildApiUrl(path) {
        if (!path) return API_BASE_URL;
        if (/^https?:\/\//i.test(path)) return path;
        return `${API_BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
    }
    
    // Elementos DOM
    const createSessionBtn = document.getElementById('createSessionBtn');
    const qrContainer = document.getElementById('qrContainer');
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
    const registerPromo = document.getElementById('registerPromo');
    const registerBtn = document.getElementById('registerBtn');

    const loginEmail = document.getElementById('loginEmail');
    const loginPromo = document.getElementById('loginPromo');
    const loginBtn = document.getElementById('loginBtn');

    const adminEmail = document.getElementById('adminEmail');
    const adminPassword = document.getElementById('adminPassword');
    const adminLoginBtn = document.getElementById('adminLoginBtn');

    const adminPanel = document.getElementById('adminPanel');
    const refreshAdminBtn = document.getElementById('refreshAdminBtn');
    const adminUsersTbody = document.getElementById('adminUsersTbody');

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
        if (socket) {
            try { socket.disconnect(); } catch (e) {}
            socket = null;
        }
        socket = io(SOCKET_URL, { auth: { token: authToken } });

        socket.on('system-stats-update', (stats) => {
             const el = document.getElementById('testSlotsAvailable');
             if (el && stats) {
                 const avail = Math.max(0, stats.maxConnections - stats.totalConnections);
                 el.textContent = `Vagas: ${avail}/${stats.maxConnections}`;
                 el.style.display = 'inline-block';
                 if (avail <= 0) {
                      el.style.color = '#991b1b';
                      el.style.background = '#fee2e2';
                 } else {
                      el.style.color = '#111827';
                      el.style.background = 'rgba(255,255,255,0.4)';
                 }
             }
        });

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
                if (qrCodeImg) qrCodeImg.src = data.qr;
                if (sessionInfo) {
                    sessionInfo.innerHTML = `
                        <p><strong>ID da Sessão:</strong> ${data.sessionId}</p>
                        <p><strong>Status:</strong> <span class="status pending">Aguardando QR Code</span></p>
                    `;
                }
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
                        <p><strong>Número:</strong> ${data.phoneNumber}</p>
                        <p><strong>Nome:</strong> ${data.name || 'Não informado'}</p>
                    `;
                }
                showDashboardAccess(data.sessionId);
            }
            if (authRole === 'admin') loadAdminUsers();
            else loadActiveSessions();
        });

        socket.on('auth-failed', (data) => {
            if (data.sessionId === currentSessionId) {
                if (qrContainer) qrContainer.innerHTML = '<p style="color:red;">Falha na autenticação. Tente novamente.</p>';
            }
            if (authRole === 'admin') loadAdminUsers();
            else loadActiveSessions();
        });
    }

    function applyLoggedOutUI() {
        if (logoutBtn) logoutBtn.style.display = 'none';
        if (userConnectPanel) userConnectPanel.style.display = 'none';
        if (adminPanel) adminPanel.style.display = 'none';
        tabs.forEach(t => t.style.display = '');
        setRightPanelVisible(false);
        if (sessionsContainer) sessionsContainer.innerHTML = '';
        if (refreshSessionsBtn) refreshSessionsBtn.style.display = 'none';
        if (openCrmBtn) openCrmBtn.style.display = 'none';
        if (qrContainer) qrContainer.style.display = 'none';
        setActiveTab('register');
    }

    function applyUserUI() {
        if (logoutBtn) logoutBtn.style.display = '';
        if (userConnectPanel) userConnectPanel.style.display = '';
        if (adminPanel) adminPanel.style.display = 'none';
        tabs.forEach(t => t.style.display = 'none');
        if (authRegister) authRegister.style.display = 'none';
        if (authLogin) authLogin.style.display = 'none';
        if (authAdmin) authAdmin.style.display = 'none';
        setRightPanelVisible(false);
        if (refreshSessionsBtn) refreshSessionsBtn.style.display = 'none';
        if (openCrmBtn) openCrmBtn.style.display = 'none';
    }

    function applyAdminUI() {
        if (logoutBtn) logoutBtn.style.display = '';
        if (userConnectPanel) userConnectPanel.style.display = 'none';
        if (adminPanel) adminPanel.style.display = '';
        tabs.forEach(t => t.style.display = 'none');
        if (authRegister) authRegister.style.display = 'none';
        if (authLogin) authLogin.style.display = 'none';
        if (authAdmin) authAdmin.style.display = 'none';
        if (rightTitle) rightTitle.innerHTML = '<i class="fas fa-shield-halved"></i> Admin';
        if (rightHint) rightHint.textContent = 'Dashboard para acompanhar usuários, QR e números conectados.';
        setRightPanelVisible(true);
        if (refreshSessionsBtn) refreshSessionsBtn.style.display = 'none';
        if (openCrmBtn) openCrmBtn.style.display = 'none';
    }

    function setRightPanelVisible(visible) {
        if (connectionPanel) connectionPanel.style.display = visible ? '' : 'none';
        if (mainContent) mainContent.style.gridTemplateColumns = visible ? '1fr 1fr' : '1fr';
    }

    function showDashboardAccess(sessionId) {
        if (qrContainer) {
            qrContainer.style.display = 'block';
            qrContainer.innerHTML = `
                <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; padding: 22px 10px;">
                    <div style="font-weight:900; font-size:1.05rem; color:#111827;">WhatsApp conectado</div>
                    <div class="muted" style="margin:0;">Agora você já pode acessar o dashboard.</div>
                    <a class="btn btn-dark" style="text-decoration:none; width: 100%; max-width: 320px; justify-content:center;" href="/crm.html?sessionId=${encodeURIComponent(String(sessionId || ''))}&view=whatsapp">
                        <i class="fas fa-columns"></i> Acessar dashboard
                    </a>
                </div>
            `;
        }
        if (openCrmBtn) {
            openCrmBtn.href = `/crm.html?sessionId=${encodeURIComponent(String(sessionId || ''))}&view=whatsapp`;
            openCrmBtn.style.display = '';
        }
        setRightPanelVisible(true);
    }

    function setActiveTab(tabId) {
        tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
        if (authRegister) authRegister.style.display = tabId === 'register' ? '' : 'none';
        if (authLogin) authLogin.style.display = tabId === 'login' ? '' : 'none';
        if (authAdmin) authAdmin.style.display = tabId === 'admin' ? '' : 'none';
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
                promoCode: registerPromo ? registerPromo.value : ''
            };
            const { ok, data } = await doJsonPost('/api/auth/register', payload);
            if (!ok || !data.success) {
                showAuthError((data && data.error) ? data.error : 'Erro ao cadastrar');
                return;
            }
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
                promoCode: loginPromo ? loginPromo.value : ''
            };
            const { ok, data } = await doJsonPost('/api/auth/login', payload);
            if (!ok || !data.success) {
                showAuthError((data && data.error) ? data.error : 'Erro ao entrar');
                return;
            }
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
            
            if (!adminUsersTbody) return;
            adminUsersTbody.innerHTML = '';
            
            if (users.length === 0) {
                const tr = document.createElement('tr');
                tr.innerHTML = '<td colspan="6" style="padding:10px; text-align:center;">Nenhum usuário encontrado</td>';
                adminUsersTbody.appendChild(tr);
            }

            users.forEach(u => {
                const tr = document.createElement('tr');
                const status = u.status || 'none';
                let statusLabel = 'Pendente';
                let color = '#92400e'; // orange/brown for pending

                if (status === 'connected' || status === 'authenticated') {
                    statusLabel = 'Conectado';
                    color = '#166534'; // green
                } else if (status === 'auth_failed' || status === 'disconnected') {
                    statusLabel = 'Desconectado';
                    color = '#991b1b'; // red
                } else if (status === 'reconnecting') {
                    statusLabel = 'Reconectando';
                    color = '#ea580c'; // orange
                } else if (status === 'none') {
                    statusLabel = 'Sem Sessão';
                    color = '#64748b'; // slate
                }

                tr.innerHTML = `
                    <td data-label="Usuário" style="padding:10px; border-bottom:1px solid #eef2f7; font-weight:800;">${(u.name || '—')}</td>
                    <td data-label="Email" style="padding:10px; border-bottom:1px solid #eef2f7; color:#334155;">${(u.email || '—')}</td>
                    <td data-label="Status" style="padding:10px; border-bottom:1px solid #eef2f7;">
                        <span style="display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:999px; font-weight:900; background:#f1f5f9; color:${color}; border:1px solid #e2e8f0;">
                            ${statusLabel}
                        </span>
                    </td>
                    <td data-label="Proxy" style="padding:10px; border-bottom:1px solid #eef2f7; color:#64748b; font-size:0.9em; font-family:monospace;">${(u.proxy || '—')}</td>
                    <td data-label="Número" style="padding:10px; border-bottom:1px solid #eef2f7; color:#0f172a;">${(u.whatsappNumber || '—')}</td>
                    <td data-label="Último QR" style="padding:10px; border-bottom:1px solid #eef2f7; color:#334155;">${formatDateTime(u.lastQrAt) || '—'}</td>
                `;
                adminUsersTbody.appendChild(tr);
            });
        } catch (e) {
            console.error('Erro ao carregar usuários admin:', e);
        }
    }
    
    // Renderizar lista de sessões
    function renderSessions(sessions) {
        const list = Array.isArray(sessions) ? sessions : [];
        const hasConnectedLike = list.some(s => s && (s.status === 'connected' || s.status === 'authenticated'));
        const firstConnected = list.find(s => s && (s.status === 'connected' || s.status === 'authenticated')) || null;

        if (authRole === 'user') {
            setRightPanelVisible(hasConnectedLike);
            if (refreshSessionsBtn) refreshSessionsBtn.style.display = hasConnectedLike ? '' : 'none';
            if (openCrmBtn) {
                if (hasConnectedLike && firstConnected && firstConnected.sessionId) {
                    openCrmBtn.href = `/crm.html?sessionId=${encodeURIComponent(String(firstConnected.sessionId))}&view=whatsapp`;
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
        
        list.forEach(session => {
            const sessionCard = document.createElement('div');
            sessionCard.className = 'session-card';
            
            let statusClass = 'pending';
            const isConnectedLike = session.status === 'connected' || session.status === 'authenticated';
            if (isConnectedLike) statusClass = 'connected';
            if (session.status === 'auth_failed') statusClass = 'disconnected';
            
            let actionButtons = '';
            
            const canOpenPanel = session.status !== 'auth_failed';
            if (canOpenPanel) {
                if (session.hasPassword) {
                    // Protected Buttons
                    actionButtons = `
                        <button onclick="verifyAndOpen('${session.sessionId}', '/crm.html?sessionId=${session.sessionId}&view=whatsapp')" 
                           class="btn" style="padding: 5px 15px; justify-content: center; background: #25D366; width: 100%; margin-bottom: 5px;">
                            <i class="fab fa-whatsapp"></i> Abrir WhatsApp 🔒
                        </button>
                        <button onclick="verifyAndOpen('${session.sessionId}', '/crm.html?sessionId=${session.sessionId}')" 
                           class="btn" style="padding: 5px 15px; justify-content: center; width: 100%; margin-bottom: 5px;">
                            <i class="fas fa-columns"></i> Abrir CRM 🔒
                        </button>
                        <button onclick="verifyAndDisconnect('${session.sessionId}')" 
                                class="btn btn-danger" style="padding: 5px 15px; width: 100%;">
                            <i class="fas fa-power-off"></i> Desconectar 🔒
                        </button>
                        <button onclick="deleteSessionPermanently('${session.sessionId}')" 
                                class="btn btn-danger" style="padding: 5px 15px; width: 100%; background:#b91c1c; margin-top:5px;">
                            <i class="fas fa-trash"></i> Excluir permanente
                        </button>
                    `;
                } else {
                    // Unprotected Buttons + Set Password Option
                    actionButtons = `
                        <a href="/crm.html?sessionId=${session.sessionId}&view=whatsapp" 
                           class="btn" style="padding: 5px 15px; text-decoration: none; justify-content: center; background: #25D366; margin-bottom: 5px;">
                            <i class="fab fa-whatsapp"></i> Abrir WhatsApp
                        </a>
                        <a href="/crm.html?sessionId=${session.sessionId}" 
                           class="btn" style="padding: 5px 15px; text-decoration: none; justify-content: center; margin-bottom: 5px;">
                            <i class="fas fa-columns"></i> Abrir CRM
                        </a>
                        <button onclick="setSessionPassword('${session.sessionId}')" 
                                class="btn btn-secondary" style="padding: 5px 15px; background: #6c757d; margin-bottom: 5px;">
                            <i class="fas fa-lock"></i> Definir Senha
                        </button>
                        <button onclick="disconnectSession('${session.sessionId}')" 
                                class="btn btn-danger" style="padding: 5px 15px;">
                            <i class="fas fa-power-off"></i> Desconectar
                        </button>
                        <button onclick="deleteSessionPermanently('${session.sessionId}')" 
                                class="btn btn-danger" style="padding: 5px 15px; background:#b91c1c;">
                            <i class="fas fa-trash"></i> Excluir permanente
                        </button>
                    `;
                }
            } else {
                 // Disconnect only (no password needed usually for broken sessions, but let's keep it simple)
                 actionButtons = `
                    <button onclick="disconnectSession('${session.sessionId}')" 
                            class="btn btn-danger" style="padding: 5px 15px;">
                        <i class="fas fa-power-off"></i> Desconectar
                    </button>
                    <button onclick="deleteSessionPermanently('${session.sessionId}')" 
                            class="btn btn-danger" style="padding: 5px 15px; background:#b91c1c;">
                        <i class="fas fa-trash"></i> Excluir permanente
                    </button>
                 `;
            }

            sessionCard.innerHTML = `
                <div class="session-info">
                    <h4>${session.name || 'WhatsApp'}</h4>
                    <p><strong>Número:</strong> ${session.phoneNumber || 'Não conectado'}</p>
                    <p><strong>ID:</strong> ${session.sessionId}</p>
                </div>
                <div>
                    <span class="status ${statusClass}" style="display: inline-block; margin-bottom: 10px;">
                        ${isConnectedLike ? 'Conectado' : 
                          session.status === 'auth_failed' ? 'Falha' : 'Pendente'}
                    </span>
                    <div style="display: flex; gap: 5px; flex-direction: column;">
                        ${actionButtons}
                    </div>
                </div>
            `;
            
            sessionsContainer.appendChild(sessionCard);
        });
    }

    // Check public availability
    async function checkAvailability() {
        try {
            const r = await fetch(buildApiUrl('/api/public-stats'));
            const data = await r.json();
            if (data.success) {
                const el = document.getElementById('testSlotsAvailable');
                if (el) {
                    el.textContent = `Vagas: ${data.available}/${data.maxConnections}`;
                    el.style.display = 'inline-block';
                    if (data.available <= 0) {
                         el.style.color = '#991b1b';
                         el.style.background = '#fee2e2';
                    } else {
                         el.style.color = '#111827';
                         el.style.background = 'rgba(255,255,255,0.4)';
                    }
                }
            }
        } catch (e) {
            console.error('Failed to fetch stats', e);
        }
    }
    checkAvailability();

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
                    if (qrContainer) qrContainer.style.display = 'none';
                    currentSessionId = null;
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
        if (confirm('Tem certeza que deseja desconectar esta sessão?')) {
            window.actualDisconnectSession(sessionId);
        }
    };

    window.deleteSessionPermanently = async function(sessionId) {
        if (!confirm('Tem certeza que deseja excluir esta sessão permanentemente?')) return;

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
    
    // Carregar sessões ao iniciar
    loadActiveSessions();
    
    // Refresh periodically just in case
    setInterval(loadActiveSessions, 5000);
});
