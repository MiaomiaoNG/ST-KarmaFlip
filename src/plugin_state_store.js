const MODULE_KEY = 'STApiSwitcher';
const OLD_STORAGE_KEY = 'karmaflip_state_v4';
let persistenceEnabled = false;
let pendingPersist = false;
let persistTimer = null;

export function toInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.round(n));
}

function defaultPool() {
    return {
        id: 'pool_default',
        name: '默认组合',
        mode: 'fixed',
        enabled: true,
        random: { noConsecutive: false },
        entries: [],
    };
}

export function getDefaultState() {
    return {
        version: 5,
        activePoolId: 'pool_default',
        pools: [defaultPool()],
        apiPresets: [],
        theme: {
            bgMain: '#ffffff',
            bgSub: '#f7f9fc',
            underline: '#617b9b',
            blur: '0.6',
            brush: 'marker',
        },
        runtime: {},
        logs: [],
    };
}

function context() {
    return window.SillyTavern?.getContext?.() || {};
}

function extensionSettings() {
    const ctx = context();
    if (!ctx.extensionSettings) ctx.extensionSettings = window.extension_settings || {};
    if (!ctx.extensionSettings[MODULE_KEY]) ctx.extensionSettings[MODULE_KEY] = getDefaultState();
    return ctx.extensionSettings;
}

function normalizeEntry(entry) {
    const e = { ...(entry || {}) };
    e.id = String(e.id || `e_${crypto.randomUUID()}`);
    e.enabled = e.enabled !== false;
    e.name = String(e.name || 'New API');
    e.apiUrl = String(e.apiUrl || e.url || '');
    e.key = String(e.key || '');
    e.provider = String(e.provider || 'open');
    e.model = String(e.model || '');
    e.fixedRuns = Math.max(1, toInt(e.fixedRuns || 1));
    e.weight = toInt(e.weight || 0);
    e.pityTurns = toInt(e.pityTurns || 0);
    e.cooldownTurns = toInt(e.cooldownTurns || 0);
    e.disabledByFailure = !!e.disabledByFailure;
    e.modelOptions = Array.isArray(e.modelOptions) ? e.modelOptions.map(x => String(x)).filter(Boolean) : [];
    return e;
}

function normalizePreset(preset) {
    const p = normalizeEntry(preset);
    p.id = String(p.id || `preset_${crypto.randomUUID()}`);
    return p;
}

function normalizePool(pool) {
    const p = { ...defaultPool(), ...(pool || {}) };
    p.id = String(p.id || `pool_${crypto.randomUUID()}`);
    p.name = String(p.name || '默认组合');
    p.mode = p.mode === 'random' ? 'random' : 'fixed';
    p.enabled = p.enabled !== false;
    p.random = { noConsecutive: false, ...(p.random || {}) };
    p.entries = Array.isArray(p.entries) ? p.entries.map(normalizeEntry) : [];
    return p;
}

function normalizeState(raw) {
    const s = { ...getDefaultState(), ...(raw || {}) };
    s.version = 5;
    s.pools = Array.isArray(s.pools) && s.pools.length ? s.pools.map(normalizePool) : [defaultPool()];
    s.apiPresets = Array.isArray(s.apiPresets) ? s.apiPresets.map(normalizePreset) : [];
    if (!s.pools.find(p => p.id === s.activePoolId)) s.activePoolId = s.pools[0].id;
    if (!s.runtime || typeof s.runtime !== 'object') s.runtime = {};
    s.theme = { ...getDefaultState().theme, ...(s.theme || {}) };
    if (!Array.isArray(s.logs)) s.logs = [];
    if (s.logs.length > 50) s.logs = s.logs.slice(0, 50);
    return s;
}

export function loadState() {
    const settings = extensionSettings();
    if (!settings[MODULE_KEY]?.pools?.length) {
        try {
            const old = localStorage.getItem(OLD_STORAGE_KEY);
            if (old) settings[MODULE_KEY] = normalizeState(JSON.parse(old));
        } catch {
            settings[MODULE_KEY] = getDefaultState();
        }
    }
    settings[MODULE_KEY] = normalizeState(settings[MODULE_KEY]);
    return settings[MODULE_KEY];
}

function persistSettings() {
    const ctx = context();
    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    else if (typeof window.saveSettingsDebounced === 'function') window.saveSettingsDebounced();
}

export function enableStatePersistence() {
    persistenceEnabled = true;
    if (!pendingPersist) return;
    pendingPersist = false;
    persistSettings();
}

export function saveState(state, options = {}) {
    extensionSettings()[MODULE_KEY] = normalizeState(state);
    if (options.persist === false) return;
    if (!persistenceEnabled) {
        pendingPersist = true;
        return;
    }
    persistSettings();
}

export function saveStateDebounced(state, delay = 400) {
    extensionSettings()[MODULE_KEY] = normalizeState(state);
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
        persistTimer = null;
        saveState(state);
    }, delay);
}

export function getActivePool(state) {
    return state.pools.find(p => p.id === state.activePoolId) || state.pools[0];
}

export function getRuntimeScope(state) {
    const chatId = context()?.chatId || 'global';
    const key = `chat:${chatId}`;
    if (!state.runtime[key]) {
        state.runtime[key] = { turn: 0, cooldowns: {}, failures: {}, missStreaks: {}, fixedCursor: 0, lastPick: null };
    }
    const scope = state.runtime[key];
    if (!scope.cooldowns) scope.cooldowns = {};
    if (!scope.failures) scope.failures = {};
    if (!scope.missStreaks) scope.missStreaks = {};
    if (typeof scope.fixedCursor !== 'number') scope.fixedCursor = 0;
    return scope;
}

export function pushLog(state, entry) {
    if (!Array.isArray(state.logs)) state.logs = [];
    state.logs.unshift({ time: new Date().toISOString(), ...entry });
    if (state.logs.length > 50) state.logs = state.logs.slice(0, 50);
}
