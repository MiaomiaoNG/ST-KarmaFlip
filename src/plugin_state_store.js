import { makeId } from './compat.js';

const MODULE_KEY = 'STApiSwitcher';
const OLD_STORAGE_KEY = 'karmaflip_state_v4';
const MAX_STORED_LOGS = 50;
const DEFAULT_PERSIST_DELAY = 1200;
let persistenceEnabled = false;
let pendingPersist = false;
let persistTimer = null;
let persistDueAt = 0;
let cachedState = null;
let enabledPersistDirty = false;
let modePersistDirty = false;
let lightPersistDirty = false;
let pendingState = null;
let persistHooksBound = false;
const runtimeScopes = {};
const LOG_EVENT_NAME = 'STKarmaFlip:logs-updated';
const usageStats = new Map();

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
        random: { noConsecutive: false },
        entries: [],
    };
}

export function getDefaultState() {
    return {
        version: 5,
        enabled: true,
        activePoolId: 'pool_default',
        pools: [defaultPool()],
        apiPresets: [],
        theme: {
            bgMain: '#ffffff',
            bgSub: '#f7f9fc',
            underline: '#617b9b',
            brush: 'simple',
            preset: 'default',
        },
        failure: {
            retryCount: 3,
            retryDelaySeconds: 3,
            alertEnabled: false,
            modelAlertEnabled: false,
        },
        shortcuts: {
            modeEnabled: true,
            powerEnabled: true,
        },
        ui: {
            updateNoticeSeenVersion: '',
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

function copyModelOptions(list) {
    return Array.isArray(list) ? list.map(x => String(x)).filter(Boolean) : [];
}

function isPlaceholderApiName(name) {
    return String(name || '').trim().toLowerCase() === 'new api';
}

function isMeaningfulApiEntry(entry) {
    if (!entry) return false;
    return [
        isPlaceholderApiName(entry.name) ? '' : entry.name,
        entry.apiUrl || entry.url,
        entry.key,
        entry.model,
    ].some(value => String(value || '').trim());
}

function normalizeProvider(provider) {
    const value = String(provider || 'open').trim().toLowerCase();
    if (value === 'openai' || value === 'deepseek') return 'open';
    if (value === 'gemini' || value === 'claude') return value;
    return 'open';
}

function normalizeEntry(entry) {
    const e = entry || {};
    return {
        id: String(e.id || makeId('e')),
        presetId: e.presetId ? String(e.presetId) : '',
        enabled: e.enabled !== false,
        name: isPlaceholderApiName(e.name) ? '' : String(e.name || ''),
        apiUrl: String(e.apiUrl || e.url || ''),
        key: String(e.key || ''),
        provider: normalizeProvider(e.provider),
        model: String(e.model || ''),
        fixedRuns: Math.max(1, toInt(e.fixedRuns || 1)),
        weight: toInt(e.weight || 0),
        pityTurns: toInt(e.pityTurns || 0),
        cooldownTurns: toInt(e.cooldownTurns || 0),
        collapsed: !!e.collapsed,
        modelOptions: copyModelOptions(e.modelOptions),
    };
}

function normalizePreset(preset) {
    const p = normalizeEntry(preset);
    p.id = String(p.id || makeId('preset'));
    return p;
}

function normalizePool(pool) {
    const p = { ...defaultPool(), ...(pool || {}) };
    p.id = String(p.id || makeId('pool'));
    p.name = String(p.name || '默认组合');
    p.mode = p.mode === 'random' ? 'random' : 'fixed';
    p.random = { noConsecutive: false, ...(p.random || {}) };
    p.entries = Array.isArray(p.entries) ? p.entries.map(normalizeEntry) : [];
    return p;
}

function findPoolEntry(source, poolId, entryId) {
    const pools = Array.isArray(source?.pools) ? source.pools : [];
    const activePool = pools.find(pool => pool.id === poolId) || pools[0];
    if (!activePool?.entries?.length) return { pool: activePool, entry: null };
    const entry = activePool.entries.find(item => item.id === entryId) || null;
    return { pool: activePool, entry };
}

function findPresetByEntry(source, entry) {
    if (!entry || !Array.isArray(source?.apiPresets)) return null;
    const presetId = String(entry.presetId || '').trim();
    if (presetId) {
        const matched = source.apiPresets.find(item => String(item.id || '').trim() === presetId);
        if (matched) return matched;
    }
    const name = String(entry.name || '').trim();
    if (!name) return null;
    return source.apiPresets.find(item => String(item.name || '').trim() === name) || null;
}

function normalizeState(raw) {
    const s = { ...getDefaultState(), ...(raw || {}) };
    s.version = 5;
    s.pools = Array.isArray(s.pools) && s.pools.length ? s.pools.map(normalizePool) : [defaultPool()];
    s.apiPresets = Array.isArray(s.apiPresets) ? s.apiPresets.map(normalizePreset) : [];
    if (!s.pools.find(p => p.id === s.activePoolId)) s.activePoolId = s.pools[0].id;
    const activePool = s.pools.find(p => p.id === s.activePoolId) || s.pools[0];
    s.enabled = typeof raw?.enabled === 'boolean' ? raw.enabled : activePool?.enabled !== false;
    s.runtime = {};
    s.theme = { ...getDefaultState().theme, ...(s.theme || {}) };
    delete s.theme.blur;
    s.theme.brush = ['simple', 'native'].includes(s.theme.brush) ? s.theme.brush : 'simple';
    s.theme.preset = String(s.theme.preset || 'default');
    s.failure = {
        ...getDefaultState().failure,
        ...(s.failure || {}),
        retryCount: Math.max(1, toInt(s.failure?.retryCount || 3)),
        retryDelaySeconds: toInt(s.failure?.retryDelaySeconds ?? 3),
        alertEnabled: !!s.failure?.alertEnabled,
        modelAlertEnabled: !!s.failure?.modelAlertEnabled,
    };
    s.shortcuts = {
        ...getDefaultState().shortcuts,
        ...(s.shortcuts || {}),
        modeEnabled: s.shortcuts?.modeEnabled ?? s.shortcuts?.enabled ?? true,
        powerEnabled: s.shortcuts?.powerEnabled ?? s.shortcuts?.enabled ?? true,
    };
    s.shortcuts.modeEnabled = s.shortcuts.modeEnabled !== false;
    s.shortcuts.powerEnabled = s.shortcuts.powerEnabled !== false;
    s.ui = {
        ...getDefaultState().ui,
        ...(s.ui || {}),
        updateNoticeSeenVersion: String(s.ui?.updateNoticeSeenVersion || ''),
    };
    s.logs = [];
    return s;
}

function findSettingsPoolEntry(poolId, entryId) {
    const targetState = extensionSettings()[MODULE_KEY];
    const hit = findPoolEntry(targetState, poolId, entryId);
    return { state: targetState, ...hit };
}

function hasOwn(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function hasLegacyStateData(raw) {
    if (!raw || typeof raw !== 'object') return false;
    if (hasOwn(raw, 'logs')) return true;
    if (hasOwn(raw, 'runtime')) return true;
    if (hasOwn(raw?.theme, 'blur')) return true;
    const hasLegacyProvider = entry => ['openai', 'deepseek'].includes(String(entry?.provider || '').trim().toLowerCase());
    const pools = Array.isArray(raw.pools) ? raw.pools : [];
    if (pools.some(pool =>
        hasOwn(pool, 'enabled') ||
        (Array.isArray(pool?.entries) && pool.entries.some(entry => hasOwn(entry, 'modelOptions') || hasLegacyProvider(entry)))
    )) return true;
    const presets = Array.isArray(raw.apiPresets) ? raw.apiPresets : [];
    if (presets.some(hasLegacyProvider)) return true;
    if (presets.some(preset => hasOwn(preset, 'modelOptions'))) return true;
    return false;
}

function buildPersistedEntry(entry) {
    const normalized = normalizeEntry(entry);
    return {
        id: normalized.id,
        presetId: normalized.presetId,
        enabled: normalized.enabled,
        name: normalized.name,
        apiUrl: normalized.apiUrl,
        key: normalized.key,
        provider: normalized.provider,
        model: normalized.model,
        fixedRuns: normalized.fixedRuns,
        weight: normalized.weight,
        pityTurns: normalized.pityTurns,
        cooldownTurns: normalized.cooldownTurns,
        collapsed: normalized.collapsed,
    };
}

function buildPersistedPreset(preset) {
    const normalized = normalizePreset(preset);
    return {
        id: normalized.id,
        enabled: normalized.enabled,
        name: normalized.name,
        apiUrl: normalized.apiUrl,
        key: normalized.key,
        provider: normalized.provider,
        model: normalized.model,
    };
}

function buildLivePresetFromEntry(entry, presetId) {
    const normalized = normalizeEntry(entry);
    return {
        id: String(presetId || makeId('preset')),
        presetId: '',
        enabled: normalized.enabled,
        name: normalized.name,
        apiUrl: normalized.apiUrl,
        key: normalized.key,
        provider: normalized.provider,
        model: normalized.model,
        modelOptions: copyModelOptions(entry?.modelOptions),
    };
}

function findPresetIndex(presets, entry) {
    const presetId = String(entry?.presetId || '').trim();
    const entryId = String(entry?.id || '').trim();
    const previousName = String(entry?._previousPresetName || '').trim();
    const name = String(entry?.name || '').trim();
    let index = presetId ? presets.findIndex(item => String(item?.id || '').trim() === presetId) : -1;
    if (index < 0 && entryId) index = presets.findIndex(item => String(item?.id || '').trim() === entryId);
    if (index < 0 && previousName) index = presets.findIndex(item => String(item?.name || '').trim() === previousName);
    if (index < 0 && name) index = presets.findIndex(item => String(item?.name || '').trim() === name);
    return index;
}

function syncApiPresetsInPlace(state) {
    if (!Array.isArray(state?.apiPresets)) state.apiPresets = [];
    state.apiPresets = state.apiPresets.filter(isMeaningfulApiEntry);
    for (const pool of state?.pools || []) {
        for (const entry of pool?.entries || []) {
            if (!isMeaningfulApiEntry(entry)) continue;
            const name = isPlaceholderApiName(entry?.name) ? '' : String(entry?.name || '').trim();
            const index = findPresetIndex(state.apiPresets, entry);
            const existing = index >= 0 ? state.apiPresets[index] : null;
            const preset = buildLivePresetFromEntry({ ...entry, name }, existing?.id || entry?.presetId || undefined);
            if (index >= 0) state.apiPresets[index] = preset;
            else state.apiPresets.push(preset);
            entry.presetId = preset.id;
            delete entry._previousPresetName;
        }
    }
}

function createPersistedState(source) {
    const base = source && typeof source === 'object' ? source : getDefaultState();
    syncApiPresetsInPlace(base);
    const pools = Array.isArray(base.pools) && base.pools.length ? base.pools : [defaultPool()];
    const activePoolId = pools.find(pool => pool.id === base.activePoolId)?.id || pools[0].id;
    const snapshot = {
        version: 5,
        enabled: base.enabled !== false,
        activePoolId,
        pools: pools.map(pool => ({
            id: String(pool?.id || makeId('pool')),
            name: String(pool?.name || '默认组合'),
            mode: pool?.mode === 'random' ? 'random' : 'fixed',
            random: { noConsecutive: !!pool?.random?.noConsecutive },
            entries: Array.isArray(pool?.entries) ? pool.entries.map(buildPersistedEntry) : [],
        })),
        apiPresets: Array.isArray(base.apiPresets) ? base.apiPresets.map(buildPersistedPreset) : [],
        theme: {
            ...getDefaultState().theme,
            ...(base.theme || {}),
            brush: ['simple', 'native'].includes(base?.theme?.brush) ? base.theme.brush : 'simple',
            preset: String(base?.theme?.preset || 'default'),
        },
        failure: {
            ...getDefaultState().failure,
            ...(base.failure || {}),
            retryCount: Math.max(1, toInt(base?.failure?.retryCount || 3)),
            retryDelaySeconds: toInt(base?.failure?.retryDelaySeconds ?? 3),
            alertEnabled: !!base?.failure?.alertEnabled,
            modelAlertEnabled: !!base?.failure?.modelAlertEnabled,
        },
        shortcuts: {
            ...getDefaultState().shortcuts,
            ...(base.shortcuts || {}),
            modeEnabled: base?.shortcuts?.modeEnabled ?? base?.shortcuts?.enabled ?? true,
            powerEnabled: base?.shortcuts?.powerEnabled ?? base?.shortcuts?.enabled ?? true,
        },
        ui: {
            ...getDefaultState().ui,
            ...(base.ui || {}),
            updateNoticeSeenVersion: String(base?.ui?.updateNoticeSeenVersion || ''),
        },
    };
    snapshot.shortcuts.modeEnabled = snapshot.shortcuts.modeEnabled !== false;
    snapshot.shortcuts.powerEnabled = snapshot.shortcuts.powerEnabled !== false;
    return normalizeState(snapshot);
}

export function loadState() {
    if (cachedState) return cachedState;
    const settings = extensionSettings();
    const rawState = settings[MODULE_KEY];
    const legacyDetected = hasLegacyStateData(rawState);
    const legacyLocalState = localStorage.getItem(OLD_STORAGE_KEY);
    let migratedFromLocal = false;
    if (!settings[MODULE_KEY]?.pools?.length) {
        try {
            if (legacyLocalState) {
                settings[MODULE_KEY] = normalizeState(JSON.parse(legacyLocalState));
                migratedFromLocal = true;
            }
        } catch {
            settings[MODULE_KEY] = getDefaultState();
        }
    }
    const cleaned = createPersistedState(settings[MODULE_KEY]);
    settings[MODULE_KEY] = cleaned;
    cachedState = normalizeState(cleaned);
    if (legacyLocalState) {
        try { localStorage.removeItem(OLD_STORAGE_KEY); } catch {}
    }
    if (legacyDetected || migratedFromLocal) {
        pendingState = cachedState;
        pendingPersist = true;
    }
    return cachedState;
}

function persistSettings() {
    const ctx = context();
    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    else if (typeof window.saveSettingsDebounced === 'function') window.saveSettingsDebounced();
}

function persistSnapshot(source) {
    extensionSettings()[MODULE_KEY] = createPersistedState(source);
    persistSettings();
}

function clearEnabledPersistDirty() {
    enabledPersistDirty = false;
}

function clearModePersistDirty() {
    modePersistDirty = false;
}

function markLightPersistDirty() {
    bindPersistHooks();
    lightPersistDirty = true;
    if (!persistenceEnabled) pendingPersist = true;
}

function clearLightPersistDirty() {
    lightPersistDirty = false;
}

function clearPersistTimer() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    persistDueAt = 0;
}

function flushScheduledPersist() {
    if (!pendingState) {
        pendingPersist = false;
        clearPersistTimer();
        return;
    }
    const source = pendingState;
    pendingState = null;
    pendingPersist = false;
    clearPersistTimer();
    if (!persistenceEnabled) {
        pendingState = source;
        pendingPersist = true;
        return;
    }
    persistSnapshot(source);
}

function flushEnabledPersist() {
    if (!enabledPersistDirty) return;
    clearEnabledPersistDirty();
    if (!persistenceEnabled) {
        pendingPersist = true;
        return;
    }
    persistSettings();
}

function flushModePersist() {
    if (!modePersistDirty) return;
    clearModePersistDirty();
    if (!persistenceEnabled) {
        pendingPersist = true;
        return;
    }
    persistSettings();
}

function flushLightPersist() {
    if (!lightPersistDirty) return;
    clearLightPersistDirty();
    if (!persistenceEnabled) {
        pendingPersist = true;
        return;
    }
    persistSettings();
}

function flushPendingPersistence() {
    flushEnabledPersist();
    flushModePersist();
    flushLightPersist();
    flushScheduledPersist();
}

function bindPersistHooks() {
    if (persistHooksBound) return;
    persistHooksBound = true;
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushPendingPersistence();
    });
    window.addEventListener('pagehide', () => {
        flushPendingPersistence();
    });
}

function queuePersistBackground(source, delay = DEFAULT_PERSIST_DELAY) {
    bindPersistHooks();
    pendingState = source;
    pendingPersist = true;
    if (!persistenceEnabled) return;
    const safeDelay = Math.max(0, Number(delay) || 0);
    const nextDueAt = Date.now() + safeDelay;
    if (persistTimer && persistDueAt && persistDueAt <= nextDueAt) return;
    clearPersistTimer();
    persistDueAt = nextDueAt;
    persistTimer = setTimeout(() => {
        flushScheduledPersist();
    }, safeDelay);
}

function queuePersistDebounced(source, delay = DEFAULT_PERSIST_DELAY) {
    bindPersistHooks();
    pendingState = source;
    pendingPersist = true;
    if (!persistenceEnabled) return;
    const safeDelay = Math.max(0, Number(delay) || 0);
    clearPersistTimer();
    persistDueAt = Date.now() + safeDelay;
    persistTimer = setTimeout(() => {
        flushScheduledPersist();
    }, safeDelay);
}

export function enableStatePersistence() {
    persistenceEnabled = true;
    bindPersistHooks();
    if (!pendingPersist && !enabledPersistDirty && !modePersistDirty && !lightPersistDirty) return;
    flushPendingPersistence();
}

export function saveState(state, options = {}) {
    const source = state && typeof state === 'object' ? state : loadState();
    cachedState = source;
    if (options.persist === false) return;
    clearEnabledPersistDirty();
    clearModePersistDirty();
    clearLightPersistDirty();
    pendingState = null;
    pendingPersist = false;
    clearPersistTimer();
    if (!persistenceEnabled) {
        pendingState = source;
        pendingPersist = true;
        return;
    }
    persistSnapshot(source);
}

export function saveStateAsync(state, delay = 0) {
    const source = state && typeof state === 'object' ? state : loadState();
    cachedState = source;
    clearEnabledPersistDirty();
    clearLightPersistDirty();
    queuePersistBackground(source, delay);
}

export function saveStateDebounced(state, delay = 400) {
    const source = state && typeof state === 'object' ? state : loadState();
    cachedState = source;
    clearEnabledPersistDirty();
    clearLightPersistDirty();
    queuePersistDebounced(source, delay);
}

export function patchEnabledState(state, enabled) {
    const source = state && typeof state === 'object' ? state : loadState();
    const normalized = enabled !== false;
    source.enabled = normalized;
    cachedState = source;
    const settings = extensionSettings();
    if (settings[MODULE_KEY] !== source) {
        settings[MODULE_KEY] = { ...(settings[MODULE_KEY] || {}), enabled: normalized };
    } else {
        settings[MODULE_KEY].enabled = normalized;
    }
    bindPersistHooks();
    enabledPersistDirty = true;
    if (!persistenceEnabled) pendingPersist = true;
    return source;
}

export function patchPoolMode(state, mode) {
    const source = state && typeof state === 'object' ? state : loadState();
    const normalized = mode === 'random' ? 'random' : 'fixed';
    const pool = getActivePool(source);
    if (!pool) return null;
    pool.mode = normalized;
    cachedState = source;
    const settings = extensionSettings();
    const targetState = settings[MODULE_KEY];
    if (targetState === source) {
        const targetPool = Array.isArray(targetState?.pools)
            ? targetState.pools.find(item => item.id === pool.id)
            : null;
        if (targetPool) targetPool.mode = normalized;
    } else if (targetState && Array.isArray(targetState.pools)) {
        const targetPool = targetState.pools.find(item => item.id === pool.id);
        if (targetPool) targetPool.mode = normalized;
    }
    bindPersistHooks();
    modePersistDirty = true;
    if (!persistenceEnabled) pendingPersist = true;
    return pool;
}

export function patchPoolNoConsecutive(state, enabled) {
    const source = state && typeof state === 'object' ? state : loadState();
    const normalized = !!enabled;
    const pool = getActivePool(source);
    if (!pool) return null;
    pool.random = { ...(pool.random || {}), noConsecutive: normalized };
    cachedState = source;
    const settings = extensionSettings();
    const targetState = settings[MODULE_KEY];
    const syncPool = targetPool => {
        if (!targetPool) return;
        targetPool.random = { ...(targetPool.random || {}), noConsecutive: normalized };
    };
    if (targetState === source) {
        const targetPool = Array.isArray(targetState?.pools)
            ? targetState.pools.find(item => item.id === pool.id)
            : null;
        syncPool(targetPool);
    } else if (targetState && Array.isArray(targetState.pools)) {
        syncPool(targetState.pools.find(item => item.id === pool.id));
    }
    markLightPersistDirty();
    return pool;
}

export function patchActivePoolId(state, poolId) {
    const source = state && typeof state === 'object' ? state : loadState();
    const normalized = String(poolId || '');
    const pool = Array.isArray(source.pools) ? source.pools.find(item => item.id === normalized) : null;
    if (!pool) return null;
    source.activePoolId = normalized;
    cachedState = source;
    const settings = extensionSettings();
    if (settings[MODULE_KEY] !== source) {
        settings[MODULE_KEY] = { ...(settings[MODULE_KEY] || {}), activePoolId: normalized };
    } else {
        settings[MODULE_KEY].activePoolId = normalized;
    }
    markLightPersistDirty();
    return pool;
}

export function patchUpdateNoticeSeenVersion(state, version) {
    const source = state && typeof state === 'object' ? state : loadState();
    const normalized = String(version || '');
    source.ui = { ...(source.ui || {}), updateNoticeSeenVersion: normalized };
    cachedState = source;
    const settings = extensionSettings();
    const targetState = settings[MODULE_KEY];
    const syncUi = target => {
        if (!target) return;
        target.ui = { ...(target.ui || {}), updateNoticeSeenVersion: normalized };
    };
    if (targetState === source) {
        syncUi(targetState);
    } else if (targetState && typeof targetState === 'object') {
        syncUi(targetState);
    } else {
        settings[MODULE_KEY] = { ...(settings[MODULE_KEY] || {}), ui: { updateNoticeSeenVersion: normalized } };
    }
    markLightPersistDirty();
    return source.ui;
}

export function patchEntryEnabledState(state, poolId, entryId, enabled) {
    const source = state && typeof state === 'object' ? state : loadState();
    const normalized = enabled !== false;
    const hit = findPoolEntry(source, poolId, entryId);
    if (!hit.entry) return null;
    hit.entry.enabled = normalized;
    const preset = findPresetByEntry(source, hit.entry);
    if (preset) preset.enabled = normalized;
    cachedState = source;
    const settingsHit = findSettingsPoolEntry(poolId, entryId);
    if (settingsHit.entry) settingsHit.entry.enabled = normalized;
    const settingsPreset = findPresetByEntry(settingsHit.state, hit.entry);
    if (settingsPreset) settingsPreset.enabled = normalized;
    markLightPersistDirty();
    return hit.entry;
}

export function patchEntryCollapsedState(state, poolId, entryId, collapsed) {
    const source = state && typeof state === 'object' ? state : loadState();
    const normalized = !!collapsed;
    const hit = findPoolEntry(source, poolId, entryId);
    if (!hit.entry) return null;
    hit.entry.collapsed = normalized;
    cachedState = source;
    const settingsHit = findSettingsPoolEntry(poolId, entryId);
    if (settingsHit.entry) settingsHit.entry.collapsed = normalized;
    markLightPersistDirty();
    return hit.entry;
}

export function getActivePool(state) {
    return state.pools.find(p => p.id === state.activePoolId) || state.pools[0];
}

function usageStatKey(apiName, model) {
    return `${String(apiName || '').trim()}||${String(model || '').trim()}`;
}

function updateUsageStats(log) {
    if (String(log?.event || '') !== 'pick') return;
    const apiName = String(log?.apiName || '').trim() || '未命名';
    const model = String(log?.model || '').trim() || '未填模型';
    const key = usageStatKey(apiName, model);
    const previous = usageStats.get(key);
    usageStats.set(key, {
        apiName,
        model,
        count: (previous?.count || 0) + 1,
        lastTime: String(log?.time || new Date().toISOString()),
    });
}

export function getUsageStats() {
    return [...usageStats.values()].sort((a, b) => {
        if ((b.count || 0) !== (a.count || 0)) return (b.count || 0) - (a.count || 0);
        return String(b.lastTime || '').localeCompare(String(a.lastTime || ''));
    });
}

export function clearLogs(state) {
    if (state && typeof state === 'object') state.logs = [];
    usageStats.clear();
    window.dispatchEvent?.(new CustomEvent(LOG_EVENT_NAME));
}

export function getRuntimeScope(state) {
    const chatId = context()?.chatId || 'global';
    const key = `chat:${chatId}`;
    if (!runtimeScopes[key]) {
        runtimeScopes[key] = {
            turn: 0,
            cooldowns: {},
            failures: {},
            disabledByFailure: {},
            missStreaks: {},
            fixedCursor: 0,
            lastPick: null,
        };
    }
    const scope = runtimeScopes[key];
    if (!scope.cooldowns) scope.cooldowns = {};
    if (!scope.failures) scope.failures = {};
    if (!scope.disabledByFailure) scope.disabledByFailure = {};
    if (!scope.missStreaks) scope.missStreaks = {};
    if (typeof scope.fixedCursor !== 'number') scope.fixedCursor = 0;
    return scope;
}

export function pushLog(state, entry) {
    if (!Array.isArray(state.logs)) state.logs = [];
    const log = { time: new Date().toISOString(), ...entry };
    state.logs.unshift(log);
    if (state.logs.length > MAX_STORED_LOGS) state.logs = state.logs.slice(0, MAX_STORED_LOGS);
    updateUsageStats(log);
    window.dispatchEvent?.(new CustomEvent(LOG_EVENT_NAME));
}
