const STORAGE_KEY = 'karmaflip_state_v1';

function defaultPool() {
    return {
        id: 'pool_default',
        name: 'Default Pool',
        mode: 'random',
        enabled: true,
        random: { noConsecutive: false, windowTurns: 10 },
        entries: [],
    };
}

export function getDefaultState() {
    return {
        version: 2,
        activePoolId: 'pool_default',
        settings: { scope: 'chat' },
        pools: [defaultPool()],
        runtime: {},
        logs: [],
    };
}

function safeParse(jsonText) {
    try { return JSON.parse(jsonText); } catch { return null; }
}

function normalizePool(pool) {
    const p = { ...defaultPool(), ...(pool || {}) };
    if (!Array.isArray(p.entries)) {
        p.entries = Array.isArray(p.members) ? p.members.map(m => ({
            id: m.id || `e_${crypto.randomUUID()}`,
            profileId: m.profileId || '',
            name: m.name || 'Unnamed API',
            apiUrl: m.apiUrl || '',
            secretId: m.secretId || '',
            api: m.api || 'custom',
            model: m.model || '',
            cooldownTurns: m.maxTriggersInWindow || 0,
            pityTurns: 0,
            weight: m.weight || 30,
            fixedTurns: 1,
            enabled: m.enabled !== false,
            selected: false,
        })) : [];
    }
    p.random = { noConsecutive: false, windowTurns: 10, ...(p.random || {}) };
    return p;
}

export function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultState();

    const parsed = safeParse(raw);
    if (!parsed || typeof parsed !== 'object') return getDefaultState();

    const merged = { ...getDefaultState(), ...parsed };
    if (!Array.isArray(merged.pools) || merged.pools.length === 0) merged.pools = [defaultPool()];
    merged.pools = merged.pools.map(normalizePool);
    if (!merged.pools.find(p => p.id === merged.activePoolId)) merged.activePoolId = merged.pools[0].id;
    return merged;
}

export function saveState(state) { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
export function getActivePool(state) { return state.pools.find(p => p.id === state.activePoolId) || state.pools[0]; }

export function getChatScopeId() {
    const context = window.SillyTavern?.getContext?.();
    const chatId = context?.chatId || context?.chat?.id;
    return chatId ? `chat:${chatId}` : 'chat:global';
}

export function getRuntimeScope(state) {
    const key = getChatScopeId();
    if (!state.runtime[key]) state.runtime[key] = { turn: 0, memberStats: {}, fixedCursor: 0, lastPick: null };
    return state.runtime[key];
}

export function pushLog(state, entry) {
    if (!Array.isArray(state.logs)) state.logs = [];
    state.logs.unshift({ time: new Date().toISOString(), ...entry });
    if (state.logs.length > 200) state.logs = state.logs.slice(0, 200);
}
