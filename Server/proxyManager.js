const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const PROXY_FILE = path.join(DATA_DIR, 'proxy_sessions.json');

// Constants provided by user
const PROXY_HOST = 'brd.superproxy.io';
const PROXY_PORT = '33335';
const PROXY_USER_BASE = 'brd-customer-hl_6023a3bf-zone-isp_proxy1';
const PROXY_PASS = 'xf483qaw1yj7';
const MAX_CONNECTIONS_PER_PROXY = 3;
const MAX_TOTAL_CONNECTIONS = 9;

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadData() {
    if (!fs.existsSync(PROXY_FILE)) {
        return {
            proxySessions: {}, // proxySessionId -> { count: number, createdAt: number }
            sessionAssignments: {}, // waSessionId -> proxySessionId
            totalConnections: 0
        };
    }
    try {
        return JSON.parse(fs.readFileSync(PROXY_FILE, 'utf8'));
    } catch (e) {
        console.error('Error loading proxy data:', e);
        return { proxySessions: {}, sessionAssignments: {}, totalConnections: 0 };
    }
}

function saveData(data) {
    try {
        fs.writeFileSync(PROXY_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Error saving proxy data:', e);
    }
}

function generateProxySessionId() {
    // Random string for Bright Data session (using random 8 chars)
    return Math.random().toString(36).substring(2, 10);
}

function getAssignment(waSessionId, excludeProxyId = null) {
    const data = loadData();
    
    // Check global limit if this is a new connection (not in assignments)
    const currentTotal = Object.keys(data.sessionAssignments).length;
    if (!data.sessionAssignments[waSessionId] && currentTotal >= MAX_TOTAL_CONNECTIONS) {
        throw new Error(`Limite global de ${MAX_TOTAL_CONNECTIONS} conexões atingido.`);
    }

    // Check if already assigned
    if (data.sessionAssignments[waSessionId]) {
        const proxyId = data.sessionAssignments[waSessionId];
        // If we want to exclude this one, we shouldn't return it.
        // But typically this function is called after releaseAssignment if we are reassigning.
        // However, if called directly with excludeProxyId, we should handle it?
        // Let's assume reassignProxy calls releaseAssignment first.
        
        if (!excludeProxyId || proxyId !== excludeProxyId) {
            // Ensure the proxy session exists in our tracking (in case of manual deletion)
            if (!data.proxySessions[proxyId]) {
                data.proxySessions[proxyId] = { count: 1, createdAt: Date.now() };
            }
            
            return {
                proxyUrl: `http://${PROXY_HOST}:${PROXY_PORT}`,
                username: `${PROXY_USER_BASE}-session-${proxyId}`,
                password: PROXY_PASS,
                proxySessionId: proxyId,
                isNew: false
            };
        }
    }

    // Find a proxy session with available slots
    let assignedProxyId = null;
    
    // Iterate over existing proxies to find one with < 3 connections
    for (const [pId, info] of Object.entries(data.proxySessions)) {
        if (excludeProxyId && pId === excludeProxyId) continue;
        
        if (info.count < MAX_CONNECTIONS_PER_PROXY) {
            assignedProxyId = pId;
            break;
        }
    }

    // If no existing proxy has space, create a new one
    if (!assignedProxyId) {
        assignedProxyId = generateProxySessionId();
        // Ensure we don't accidentally generate the same excluded ID (highly unlikely but possible)
        while (excludeProxyId && assignedProxyId === excludeProxyId) {
             assignedProxyId = generateProxySessionId();
        }
        
        data.proxySessions[assignedProxyId] = {
            count: 0,
            createdAt: Date.now()
        };
    }

    // Assign
    data.proxySessions[assignedProxyId].count++;
    data.sessionAssignments[waSessionId] = assignedProxyId;
    
    saveData(data);

    return {
        proxyUrl: `http://${PROXY_HOST}:${PROXY_PORT}`,
        username: `${PROXY_USER_BASE}-session-${assignedProxyId}`,
        password: PROXY_PASS,
        proxySessionId: assignedProxyId,
        isNew: true
    };
}

function releaseAssignment(waSessionId) {
    const data = loadData();
    const proxyId = data.sessionAssignments[waSessionId];
    
    if (proxyId && data.proxySessions[proxyId]) {
        data.proxySessions[proxyId].count--;
        if (data.proxySessions[proxyId].count <= 0) {
            delete data.proxySessions[proxyId];
        }
        delete data.sessionAssignments[waSessionId];
        saveData(data);
    }
    return proxyId; // Return the released proxy ID
}

function reassignProxy(waSessionId) {
    const oldProxyId = releaseAssignment(waSessionId);
    return getAssignment(waSessionId, oldProxyId);
}

function getStats() {
    const data = loadData();
    return {
        totalConnections: Object.keys(data.sessionAssignments).length,
        activeProxies: Object.keys(data.proxySessions).length,
        maxConnections: MAX_TOTAL_CONNECTIONS,
        assignments: data.sessionAssignments,
        proxySessions: data.proxySessions
    };
}

function getProxyForSession(waSessionId) {
    const data = loadData();
    const proxyId = data.sessionAssignments[waSessionId];
    if (!proxyId) return null;
    return `session-${proxyId}`;
}

module.exports = {
    getAssignment,
    releaseAssignment,
    reassignProxy,
    getStats,
    getProxyForSession
};
