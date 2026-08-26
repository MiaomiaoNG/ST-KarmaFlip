import { bindApiOverrideToFloor, clearFloorApiBinding, clearPendingApiOverride, getActivePool, getApiOverrideState, getRuntimeScope, loadState, pushLog, toInt } from './plugin_state_store.js';
import { disableMemberByFailure, markRequestFailure, markRequestSuccess, pickMember } from './router.js';
import { makeId } from './compat.js';

let chatSettingsBound = false;
let fetchRetryBound = false;
let generationLifecycleBound = false;
let bindRetryTimer = null;
let originalFetch = null;
let preparedSelection = null;
let activePresetTransaction = null;
let nativePresetModulesPromise = null;
let preparationSequence = 0;
const pendingRequests = new Map();

export function clearRuntimeHookState() {
    pendingRequests.clear();
    discardPreparedSelection();
}

const TEXT_GENERATION_TYPES = new Set(['normal', 'swipe', 'continue', 'append', 'regenerate']);
const TRACE_FIELD = 'karmaflip_trace_id';
const PENDING_TTL = 30000;
const PRESET_TRANSACTION_TTL = 120000;
const PERF_WARN_MS = {
    chatSettings: 12,
    mvuScan: 8,
    pickMember: 6,
    traceRead: 4,
    responseCheck: 20,
};
const MVU_STRONG_PROMPT_PATTERNS = [
    /<additional_information\b/i,
    /<past_observe\b/i,
    /<must>\s*指令/i,
    /<macro\b/i,
];

function normalizeBaseUrl(apiUrl) {
    return String(apiUrl || '').trim().replace(/\/+$/, '');
}

function providerBaseUrl(apiUrl, provider) {
    const baseUrl = normalizeBaseUrl(apiUrl);
    if (String(provider || '').trim().toLowerCase() === 'gemini') {
        return baseUrl.replace(/\/v1(?:beta)?$/i, '');
    }
    return baseUrl;
}

function providerSource(provider) {
    const value = String(provider || 'open').trim().toLowerCase();
    if (value === 'gemini') return 'makersuite';
    if (value === 'claude') return 'claude';
    return 'openai';
}

function nowMs() {
    if (typeof performance?.now === 'function') return performance.now();
    return Date.now();
}

function warnSlowPath(label, startedAt, threshold) {
    const elapsed = nowMs() - startedAt;
    if (elapsed < threshold) return;
    console.warn(`[KarmaFlip] slow path: ${label} ${elapsed.toFixed(1)}ms`);
}

function retryDebug(stage, detail = {}) {
    console.debug('[KarmaFlip] retry-debug:', stage, detail);
}

function context() {
    return window.SillyTavern?.getContext?.() || {};
}

function cloneData(value) {
    if (value == null) return value;
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // Fall through for older/custom SillyTavern data objects.
        }
    }
    return JSON.parse(JSON.stringify(value));
}

function booleanRecord(raw) {
    const result = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
    for (const [key, value] of Object.entries(raw)) {
        if (String(key || '').trim() && typeof value === 'boolean') result[String(key)] = value;
    }
    return result;
}

function normalizedPresetBinding(member) {
    const presetName = String(member?.presetBinding?.presetName || '').trim();
    if (!presetName) return null;
    return {
        presetName,
        promptStates: booleanRecord(member.presetBinding?.promptStates),
        regexStates: booleanRecord(member.presetBinding?.regexStates),
    };
}

function presetBindingSignature(member) {
    const binding = normalizedPresetBinding(member);
    if (!binding) return '';
    const sorted = record => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
    return JSON.stringify({
        presetName: binding.presetName,
        promptStates: sorted(binding.promptStates),
        regexStates: sorted(binding.regexStates),
    });
}

function matchingBinding(a, b) {
    return presetBindingSignature(a) === presetBindingSignature(b);
}

function replaceObject(target, snapshot) {
    if (!target || typeof target !== 'object') return;
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, cloneData(snapshot) || {});
}

function snapshotProperties(target, keys) {
    const snapshot = new Map();
    if (!target || typeof target !== 'object') return snapshot;
    for (const key of keys) {
        if (!key || snapshot.has(key)) continue;
        snapshot.set(key, {
            existed: Object.prototype.hasOwnProperty.call(target, key),
            value: target[key],
        });
    }
    return snapshot;
}

function restoreProperties(target, snapshot) {
    if (!target || typeof target !== 'object' || !(snapshot instanceof Map)) return;
    for (const [key, item] of snapshot) {
        if (item?.existed) target[key] = item.value;
        else delete target[key];
    }
}

function findPromptOrder(settings) {
    const lists = Array.isArray(settings?.prompt_order) ? settings.prompt_order : [];
    return lists.find(item => String(item?.character_id) === '100001')?.order
        || lists.find(item => Array.isArray(item?.order))?.order
        || [];
}

function updateScriptStates(scripts, states, scope) {
    if (!Array.isArray(scripts)) return;
    for (const script of scripts) {
        const key = `${scope}:${String(script?.id || '')}`;
        if (!Object.prototype.hasOwnProperty.call(states, key)) continue;
        script.disabled = states[key] !== true;
    }
}

function snapshotScriptStates(scripts) {
    return (Array.isArray(scripts) ? scripts : []).map(script => ({ script, disabled: script?.disabled === true }));
}

function restoreScriptStates(snapshot) {
    for (const item of snapshot || []) {
        if (item?.script) item.script.disabled = item.disabled === true;
    }
}

async function nativePresetModules() {
    if (!nativePresetModulesPromise) {
        nativePresetModulesPromise = Promise.all([
            import('/scripts/preset-manager.js'),
            import('/scripts/openai.js'),
        ]).then(([presetModule, openaiModule]) => ({
            manager: presetModule.getPresetManager?.('openai') || presetModule.getPresetManager?.(),
            oaiSettings: openaiModule.oai_settings,
            settingsToUpdate: openaiModule.settingsToUpdate,
        }));
    }
    return nativePresetModulesPromise;
}

function restorePresetTransaction(expectedToken = null) {
    const transaction = activePresetTransaction;
    if (expectedToken !== null && transaction?.token !== expectedToken) return false;
    activePresetTransaction = null;
    if (!transaction) return false;
    if (transaction.timeoutId) clearTimeout(transaction.timeoutId);
    try {
        restoreProperties(transaction.oaiSettings, transaction.settingsSnapshot);
        if (transaction.select) transaction.select.value = transaction.selectedValue;
        restoreScriptStates(transaction.globalSnapshot);
        restoreScriptStates(transaction.scopedSnapshot);
        const ext = transaction.extensionSettings;
        if (ext) {
            if (transaction.hadCharacterAllowed) ext.character_allowed_regex = transaction.characterAllowedSnapshot;
            else delete ext.character_allowed_regex;
            if (transaction.hadPresetAllowed) ext.preset_allowed_regex = transaction.presetAllowedSnapshot;
            else delete ext.preset_allowed_regex;
        }
    } catch (error) {
        console.error('[KarmaFlip] 还原酒馆预设内存状态失败:', error);
    }
    return true;
}

function restorePreparedRuntime(prepared) {
    if (!prepared?.runtimeScope || !prepared.runtimeSnapshot) return;
    replaceObject(prepared.runtimeScope, prepared.runtimeSnapshot);
}

function discardPreparedSelection(expectedToken = null) {
    const prepared = preparedSelection;
    if (expectedToken !== null && prepared?.token !== expectedToken) {
        restorePresetTransaction(expectedToken);
        return false;
    }
    preparedSelection = null;
    restorePreparedRuntime(prepared);
    restorePresetTransaction(prepared?.token ?? expectedToken);
    return !!prepared;
}

function applyMemberConnectionSettings(oaiSettings, member) {
    const source = providerSource(member?.provider);
    oaiSettings.chat_completion_source = source;
    // The final URL/Key are patched into generateData at SETTINGS_READY. Keeping
    // them out of oai_settings avoids SillyTavern's reverse-proxy confirmation.
    oaiSettings.reverse_proxy = '';
    oaiSettings.proxy_password = '';
    if (source === 'makersuite') oaiSettings.google_model = String(member?.model || '');
    else if (source === 'claude') oaiSettings.claude_model = String(member?.model || '');
    else oaiSettings.openai_model = String(member?.model || '');
}

async function beginPresetTransaction(member, token) {
    const binding = normalizedPresetBinding(member);
    const { manager, oaiSettings, settingsToUpdate } = await nativePresetModules();
    if (!oaiSettings) throw new Error('当前酒馆未提供聊天补全设置');
    if (token !== null && token !== undefined && preparedSelection?.token !== token) {
        return { active: false, presetApplied: false, reason: 'stale' };
    }
    const currentName = String(manager?.getSelectedPresetName?.() || '').trim();
    const preset = !binding
        ? null
        : (binding.presetName === currentName
            ? oaiSettings
            : manager?.getCompletionPresetByName?.(binding.presetName));
    const presetAvailable = !binding || (!!manager && !!preset);

    const ctx = context();
    const extensionSettings = ctx.extensionSettings || window.extension_settings || {};
    const globalScripts = Array.isArray(extensionSettings.regex) ? extensionSettings.regex : [];
    const scopedScripts = Array.isArray(ctx.characters?.[ctx.characterId]?.data?.extensions?.regex_scripts)
        ? ctx.characters[ctx.characterId].data.extensions.regex_scripts
        : [];
    const select = document.getElementById('settings_preset_openai');
    const changedSettingKeys = new Set([
        'chat_completion_source',
        'reverse_proxy',
        'proxy_password',
        'openai_model',
        'google_model',
        'claude_model',
    ]);
    if (binding && presetAvailable) {
        for (const mapping of Object.values(settingsToUpdate || {})) {
            const settingsKey = mapping?.[1];
            if (settingsKey) changedSettingKeys.add(settingsKey);
        }
        changedSettingKeys.add('preset_settings_openai');
    }
    const transaction = {
        token,
        oaiSettings,
        settingsSnapshot: snapshotProperties(oaiSettings, changedSettingKeys),
        select,
        selectedValue: select?.value,
        extensionSettings,
        hadCharacterAllowed: Object.prototype.hasOwnProperty.call(extensionSettings, 'character_allowed_regex'),
        hadPresetAllowed: Object.prototype.hasOwnProperty.call(extensionSettings, 'preset_allowed_regex'),
        characterAllowedSnapshot: extensionSettings.character_allowed_regex,
        presetAllowedSnapshot: extensionSettings.preset_allowed_regex,
        globalSnapshot: snapshotScriptStates(globalScripts),
        scopedSnapshot: snapshotScriptStates(scopedScripts),
        timeoutId: null,
    };
    activePresetTransaction = transaction;

    try {
        if (binding && presetAvailable) {
            for (const [presetKey, mapping] of Object.entries(settingsToUpdate || {})) {
                const settingsKey = mapping?.[1];
                if (!settingsKey) continue;
                if (presetKey === 'extensions') {
                    oaiSettings[settingsKey] = cloneData(preset.extensions) || {};
                } else if (preset[presetKey] !== undefined) {
                    oaiSettings[settingsKey] = cloneData(preset[presetKey]);
                }
            }
            oaiSettings.preset_settings_openai = binding.presetName;
            if (select) {
                const value = manager.findPreset?.(binding.presetName);
                if (value != null) select.value = String(value);
            }

            const promptOrder = findPromptOrder(oaiSettings);
            for (const item of promptOrder) {
                const identifier = String(item?.identifier || '');
                if (Object.prototype.hasOwnProperty.call(binding.promptStates, identifier)) {
                    item.enabled = binding.promptStates[identifier];
                }
            }

            updateScriptStates(globalScripts, binding.regexStates, 'global');
            updateScriptStates(scopedScripts, binding.regexStates, 'scoped');
            const presetScripts = oaiSettings?.extensions?.regex_scripts;
            updateScriptStates(presetScripts, binding.regexStates, 'preset');

            const avatar = ctx.characters?.[ctx.characterId]?.avatar;
            const needsScoped = Object.entries(binding.regexStates).some(([key, enabled]) => key.startsWith('scoped:') && enabled);
            if (needsScoped && avatar) {
                extensionSettings.character_allowed_regex = Array.isArray(extensionSettings.character_allowed_regex)
                    ? [...extensionSettings.character_allowed_regex]
                    : [];
                if (!extensionSettings.character_allowed_regex.includes(avatar)) extensionSettings.character_allowed_regex.push(avatar);
            }
            const needsPreset = Object.entries(binding.regexStates).some(([key, enabled]) => key.startsWith('preset:') && enabled);
            if (needsPreset) {
                const currentAllowed = extensionSettings.preset_allowed_regex;
                extensionSettings.preset_allowed_regex = currentAllowed && typeof currentAllowed === 'object'
                    ? { ...currentAllowed }
                    : {};
                extensionSettings.preset_allowed_regex.openai = Array.isArray(currentAllowed?.openai)
                    ? [...currentAllowed.openai]
                    : [];
                if (!extensionSettings.preset_allowed_regex.openai.includes(binding.presetName)) {
                    extensionSettings.preset_allowed_regex.openai.push(binding.presetName);
                }
            }
        }

        applyMemberConnectionSettings(oaiSettings, member);
        if (binding && !presetAvailable) {
            console.warn(`[KarmaFlip] 绑定预设不存在，已保留当前预设并仅应用 API 类型与模型：${binding.presetName}`);
            showRuntimeToast(`绑定的酒馆预设“${binding.presetName}”产生变动，本次请求使用酒馆当前预设`, 'warning', 4200);
        }
        transaction.timeoutId = setTimeout(() => restorePresetTransaction(token), PRESET_TRANSACTION_TTL);
        return {
            active: true,
            presetApplied: presetAvailable,
            reason: presetAvailable ? 'applied' : 'missing-preset',
        };
    } catch (error) {
        restorePresetTransaction(token);
        throw error;
    }
}

function generationType(generateData) {
    return String(generateData?.type || 'normal');
}

function targetMessageId(type) {
    const chat = context()?.chat;
    const length = Array.isArray(chat) ? chat.length : 0;
    // Mirrors SillyTavern's getNextMessageId(): a Swipe replaces the last floor;
    // other chat generation types create the floor at the current chat length.
    return type === 'swipe' ? Math.max(0, length - 1) : length;
}

function compatiblePreparedMessageId(preparedMessageId, currentMessageId) {
    const prepared = Number(preparedMessageId);
    const current = Number(currentMessageId);
    if (!Number.isInteger(prepared) || !Number.isInteger(current)) return false;
    // SillyTavern inserts/removes one chat item between the pre-generation event
    // and SETTINGS_READY for normal sends, regenerate and continue operations.
    return Math.abs(current - prepared) <= 1;
}

function isBackgroundRequest(generateData) {
    if (!generateData || typeof generateData !== 'object') return true;
    return generateData.quiet === true ||
        generateData.skip_save === true ||
        generateData.dryRun === true ||
        generateData.dry_run === true ||
        generateData.isVirtualPhoneApiCall === true;
}

function canUseEntry(entry, mode) {
    return entry &&
        entry.enabled !== false &&
        entry.apiUrl &&
        entry.model &&
        (mode !== 'random' || toInt(entry.weight) > 0);
}

function validRuntimeEntries(pool) {
    return (pool.entries || []).filter(entry => canUseEntry(entry, pool.mode));
}

function findApiOverride(state, pool, messageId) {
    const override = getApiOverrideState(state);
    let ref = override.lock;
    let source = 'lock';
    let targetPool = pool;

    if (ref) {
        targetPool = (state.pools || []).find(item => item?.id === ref.poolId) || null;
        const lockedMember = (targetPool?.entries || []).find(entry => entry?.id === ref.entryId) || null;
        if (!targetPool || !lockedMember) {
            showRuntimeToast('当前聊天锁定的 API 已不存在，请在指定 API 窗口中取消锁定', 'error', 4200);
            return { invalid: true, source };
        }
        if (!String(lockedMember.apiUrl || '').trim() || !String(lockedMember.model || '').trim()) {
            showRuntimeToast('当前聊天锁定的 API 无URL或未选择模型，本次请求无法由插件接管', 'error', 4200);
            return { invalid: true, member: lockedMember, source };
        }
        return {
            member: lockedMember,
            pool: targetPool,
            source,
            picked: {
                member: lockedMember,
                detail: { mode: 'locked', cooldownBlocked: [], forced: true },
            },
        };
    }

    ref = override.pending;
    source = 'pending';

    if (ref && ref.poolId !== pool.id) {
        clearPendingApiOverride(state);
        ref = null;
    }
    if (!ref) {
        const binding = override.floorBinding;
        if (binding && (binding.poolId !== pool.id || Number(binding.messageId) !== Number(messageId))) {
            clearFloorApiBinding(state);
        } else if (binding) {
            ref = binding;
            source = 'floor';
        }
    }
    if (!ref) return null;

    const member = (pool.entries || []).find(entry => entry?.id === ref.entryId) || null;
    if (!member) {
        if (source === 'pending') clearPendingApiOverride(state);
        else clearFloorApiBinding(state);
        showRuntimeToast('指定的 API 已不存在，本次恢复自动选择', 'warning', 3600);
        return null;
    }
    if (!String(member.apiUrl || '').trim() || !String(member.model || '').trim()) {
        showRuntimeToast('指定 API 无URL或未选择模型，本次请求无法由插件接管', 'error', 4200);
        return { invalid: true, member, source };
    }
    return {
        member,
        pool: targetPool,
        source,
        picked: {
            member,
            detail: { mode: 'specified', cooldownBlocked: [], forced: true },
        },
    };
}

function isTextGeneration(generateData) {
    return TEXT_GENERATION_TYPES.has(generationType(generateData));
}

function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(contentToText).filter(Boolean).join('\n');
    if (content && typeof content === 'object') {
        return contentToText(content.text || content.content || content.value || '');
    }
    return '';
}

function isMvuAnalysisRequest(generateData) {
    const startedAt = nowMs();
    const messages = Array.isArray(generateData?.messages) ? generateData.messages : [];
    if (!messages.length) return false;
    const sampled = messages.length <= 4
        ? messages
        : [messages[0], messages[1], messages[messages.length - 2], messages[messages.length - 1]];
    const matchedFeatures = new Array(MVU_STRONG_PROMPT_PATTERNS.length).fill(false);
    let matchedCount = 0;
    let matched = false;
    for (const message of sampled) {
        const text = contentToText(message?.content);
        for (let index = 0; index < MVU_STRONG_PROMPT_PATTERNS.length; index += 1) {
            if (matchedFeatures[index] || !MVU_STRONG_PROMPT_PATTERNS[index].test(text)) continue;
            matchedFeatures[index] = true;
            matchedCount += 1;
            if (matchedCount >= 2) {
                matched = true;
                break;
            }
        }
        if (matched) break;
    }
    warnSlowPath('mvu-scan', startedAt, PERF_WARN_MS.mvuScan);
    return matched;
}

function isGenerateFetch(input) {
    const url = typeof input === 'string' ? input : input?.url;
    return String(url || '').includes('/api/backends/chat-completions/generate');
}

function patchGenerateData(generateData, member) {
    const source = providerSource(member.provider);
    generateData.chat_completion_source = source;
    generateData.reverse_proxy = providerBaseUrl(member.apiUrl, member.provider);
    generateData.proxy_password = member.key;
    generateData.model = member.model;
    if (source === 'makersuite') generateData.google_model = member.model;
    if (source === 'claude') generateData.claude_model = member.model;
}

function patchBodyForMember(body, member) {
    const payload = JSON.parse(String(body));
    delete payload[TRACE_FIELD];
    patchGenerateData(payload, member);
    return JSON.stringify(payload);
}

function sameMember(a, b) {
    return String(a?.id || '') === String(b?.id || '');
}

function retryLimit(state) {
    const count = Number(state.failure?.retryCount);
    return Number.isFinite(count) ? Math.max(1, Math.round(count)) : 3;
}

function retryDelayMs(state) {
    const seconds = Number(state.failure?.retryDelaySeconds);
    if (!Number.isFinite(seconds)) return 3000;
    return Math.max(0, Math.round(seconds)) * 1000;
}

function wait(ms) {
    if (!ms) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
}

function memberLabel(member) {
    return `${member?.name || '未命名'} | ${member?.model || '未填模型'}`;
}

function failureMessage(member, count) {
    return `[${member.name || '未命名'}] [${member.model || '未填模型'}]已失败${count}次，是否继续发起请求？`;
}

function secondFailureMessage(member) {
    return `[${member.name || '未命名'}] [${member.model || '未填模型'}]再次请求失败，已暂停，是否使用下一个API？`;
}

function onlyActiveFailureMessage() {
    return '当前组合唯一启动API请求失败，无法自动更换，请检查';
}

function isUserAbortError(error, init) {
    if (init?.signal?.aborted) return true;
    if (error?.name === 'AbortError') return true;
    const message = String(error?.message || error || '').toLowerCase();
    return /\b(abort|aborted|cancelled|canceled)\b/.test(message);
}

function toast(type, message) {
    if (window.toastr?.[type]) window.toastr[type](message);
    else console[type === 'error' ? 'error' : 'log'](`[KarmaFlip] ${message}`);
}

function isModelAlertEnabled(state) {
    const latest = loadState();
    return !!(latest.failure?.modelAlertEnabled || state.failure?.modelAlertEnabled);
}

function showModelAlert(state, member) {
    if (!isModelAlertEnabled(state)) return;
    const message = `翻牌！本轮抽到的是[${member?.model || '未填模型'}]`;
    const shower = window.STKarmaFlip?.showToast;
    if (typeof shower === 'function') shower(message, 'info', 2600);
    else toast('info', message);
}

function showRuntimeToast(message, type = 'info', timeout = 2800) {
    const shower = window.STKarmaFlip?.showToast;
    if (typeof shower === 'function') shower(message, type, timeout);
    else toast(type, message);
}

function reportRuntimeError(stage, error) {
    console.error(`[KarmaFlip] ${stage}，已放弃本次插件接管:`, error);
    showRuntimeToast('KarmaFlip 插件运行出错，本次请求将使用酒馆默认 API', 'error', 4200);
}

async function askFailureDecision(message, actions, fallback) {
    const opener = window.STKarmaFlip?.openFailureDecision;
    if (typeof opener !== 'function') {
        toast('warning', message);
        return fallback;
    }
    return opener(message, actions);
}

async function responseText(response) {
    try {
        return await response.clone().text();
    } catch {
        return '';
    }
}

function parseJson(text) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function businessErrorMessage(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const error = payload.error || payload.response?.error;
    if (error) {
        if (typeof error === 'string') return error;
        if (typeof error?.message === 'string') return error.message;
        try {
            return JSON.stringify(error);
        } catch {
            return String(error);
        }
    }
    if (payload.quota_error === true) return 'quota_error';
    if (payload.success === false || payload.ok === false || payload.result === false) {
        return payload.message || payload.reason || '业务状态返回失败';
    }
    if (typeof payload.message === 'string' && /unauthorized|invalid|error|failed|forbidden|quota/i.test(payload.message)) {
        return payload.message;
    }
    return '';
}

async function responseBusinessFailure(response) {
    const startedAt = nowMs();
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (!response.ok) {
        const result = { failed: true, detail: await responseText(response), reason: 'http' };
        warnSlowPath('response-check', startedAt, PERF_WARN_MS.responseCheck);
        return result;
    }
    if (contentType.includes('text/event-stream')) return { failed: false, detail: '', reason: 'sse-pass' };
    if (!contentType.includes('application/json')) return { failed: false, detail: '', reason: 'non-json' };
    const text = await responseText(response);
    const payload = parseJson(text);
    const message = businessErrorMessage(payload);
    const result = message
        ? { failed: true, detail: text || message, reason: 'business-json' }
        : { failed: false, detail: '', reason: 'json-ok' };
    warnSlowPath('response-check', startedAt, PERF_WARN_MS.responseCheck);
    return result;
}

function queueLog(state, entry) {
    setTimeout(() => {
        pushLog(state, entry);
    }, 0);
}

function chooseRequest(state, pool, blockedIds = new Set(), bindingMember = null) {
    const originalEntries = pool.entries;
    pool.entries = originalEntries.filter(e => !blockedIds.has(e.id) && (!bindingMember || matchingBinding(e, bindingMember)));
    try {
        return pickMember(state, pool);
    } finally {
        pool.entries = originalEntries;
    }
}

function makeRetryInit(init, member) {
    return {
        ...init,
        body: patchBodyForMember(init.body, member),
    };
}

function makeTraceId() {
    return makeId('kf');
}

function startPendingRequest(state, pool, picked, member, type, messageId, forced = false, locked = false) {
    const id = makeTraceId();
    pendingRequests.set(id, {
        id,
        state,
        pool,
        picked,
        member,
        type,
        messageId,
        forced,
        locked,
        expiresAt: Date.now() + PENDING_TTL,
    });
    return id;
}

function consumePendingRequest(id) {
    const pending = pendingRequests.get(id);
    pendingRequests.delete(id);
    if (!pending || pending.expiresAt < Date.now()) return null;
    return pending;
}

function cleanupPendingRequests() {
    const now = Date.now();
    for (const [id, pending] of pendingRequests.entries()) {
        if (!pending || pending.expiresAt < now) pendingRequests.delete(id);
    }
}

function readTraceRequest(init) {
    const startedAt = nowMs();
    const body = init?.body;
    if (typeof body !== 'string' || !body.includes(TRACE_FIELD)) return null;

    const keyIndex = body.indexOf(`"${TRACE_FIELD}"`);
    if (keyIndex === -1) return null;
    const colonIndex = body.indexOf(':', keyIndex + TRACE_FIELD.length + 2);
    if (colonIndex === -1) return null;
    const valueQuoteStart = body.indexOf('"', colonIndex + 1);
    if (valueQuoteStart === -1) return null;
    const valueQuoteEnd = body.indexOf('"', valueQuoteStart + 1);
    if (valueQuoteEnd === -1) return null;

    const traceId = body.slice(valueQuoteStart + 1, valueQuoteEnd);
    if (!traceId) return null;
    warnSlowPath('trace-read', startedAt, PERF_WARN_MS.traceRead);
    return {
        traceId,
        init,
    };
}

async function fetchWithMember(input, init, pending, picked, member, retryIndex) {
    const requestInit = retryIndex === 0 && sameMember(member, pending.member)
        ? init
        : makeRetryInit(init, member);
    retryDebug('attempt', {
        traceId: pending.id,
        retryIndex,
        mode: picked.detail.mode,
        apiName: member?.name || '',
        model: member?.model || '',
    });
    const response = await originalFetch(input, requestInit);
    const businessFailure = await responseBusinessFailure(response);
    retryDebug('response-check', {
        traceId: pending.id,
        retryIndex,
        status: response.status,
        ok: response.ok,
        reason: businessFailure.reason,
        failed: businessFailure.failed,
    });
    if (!businessFailure.failed) {
        markRequestSuccess(pending.state, pending.pool, member, `${pending.type}|${Date.now()}|${retryIndex}`, { forced: pending.forced });
        if (pending.forced && !pending.locked) {
            bindApiOverrideToFloor(pending.state, pending.pool.id, member.id, pending.messageId);
        }
        queueLog(pending.state, { event: 'request', trigger: pending.type, mode: picked.detail.mode, apiName: member.name, apiUrl: member.apiUrl, model: member.model, messageId: pending.messageId, success: true, status: response.status, statusText: response.statusText });
        return { ok: true, response };
    }
    const count = markRequestFailure(pending.state, member);
    const detail = businessFailure.detail;
    queueLog(pending.state, { event: 'request', trigger: pending.type, mode: picked.detail.mode, apiName: member.name, apiUrl: member.apiUrl, model: member.model, messageId: pending.messageId, success: false, status: response.status, statusText: response.statusText, responseBody: detail });
    return { ok: false, response, count };
}

async function runForcedRetryPlan(input, init, pending) {
    const state = pending.state;
    const member = pending.member;
    const maxFailures = retryLimit(state);
    const delayMs = retryDelayMs(state);
    let lastResponse = null;
    let lastError = null;

    retryDebug('forced-plan-start', {
        traceId: pending.id,
        maxFailures,
        delayMs,
        apiName: member?.name || '',
        model: member?.model || '',
        messageId: pending.messageId,
    });

    for (let retryAttempt = 0; retryAttempt < maxFailures; retryAttempt += 1) {
        if (retryAttempt > 0) await wait(delayMs);
        try {
            const result = await fetchWithMember(input, init, pending, pending.picked, member, retryAttempt);
            if (result.ok) return result.response;
            lastResponse = result.response;
            lastError = null;
        } catch (error) {
            if (isUserAbortError(error, init)) throw error;
            const count = markRequestFailure(state, member);
            lastError = error;
            lastResponse = null;
            retryDebug('forced-network-error', {
                traceId: pending.id,
                retryAttempt,
                apiName: member?.name || '',
                model: member?.model || '',
                count,
                error: String(error?.message || error),
            });
            queueLog(state, { event: 'request-error', trigger: pending.type, mode: 'specified', apiName: member.name, apiUrl: member.apiUrl, model: member.model, messageId: pending.messageId, success: false, error: String(error?.message || error), detail: `第 ${count} 次失败` });
        }
    }

    const forcedLabel = pending.locked ? '锁定 API' : '指定 API';
    const retainedLabel = pending.locked ? '锁定' : '指定';
    await askFailureDecision(
        `${forcedLabel} [${memberLabel(member)}] 已达到 ${maxFailures} 次重试上限，未切换其他 API；当前${retainedLabel}仍保留。`,
        [{ value: 'close', label: '关闭' }],
        'close',
    );
    if (lastError) throw lastError;
    if (lastResponse) return lastResponse;
    throw new Error('指定 API 请求失败');
}

async function runRetryPlan(input, init, pending, onStatus) {
    if (pending.forced) return runForcedRetryPlan(input, init, pending);
    const state = pending.state;
    const pool = pending.pool;
    const maxFailures = retryLimit(state);
    const delayMs = retryDelayMs(state);
    const alertEnabled = !!state.failure?.alertEnabled;
    const availableEntries = validRuntimeEntries(pool).filter(entry => matchingBinding(entry, pending.member));
    const onlyOneAvailable = availableEntries.length === 1;
    const maxSwitches = Math.max(1, availableEntries.length);
    const blockedIds = new Set();
    let lastResponse = null;
    let lastError = null;
    let currentPicked = pending.picked;
    let currentMember = pending.member;
    retryDebug('plan-start', {
        traceId: pending.id,
        mode: pool.mode,
        maxFailures,
        delayMs,
        alertEnabled,
        availableCount: availableEntries.length,
        initialApiName: currentMember?.name || '',
        initialModel: currentMember?.model || '',
    });

    for (let switchAttempt = 0; switchAttempt < maxSwitches; switchAttempt += 1) {
        if (switchAttempt > 0) {
            currentPicked = chooseRequest(state, pool, blockedIds, pending.member);
            currentMember = currentPicked?.member;
            if (!currentMember) break;
            retryDebug('switch-member', {
                traceId: pending.id,
                switchAttempt,
                blockedIds: [...blockedIds],
                apiName: currentMember?.name || '',
                model: currentMember?.model || '',
            });
            queueLog(state, { event: 'pick', trigger: pending.type, mode: currentPicked.detail.mode, apiName: currentMember.name, apiUrl: currentMember.apiUrl, model: currentMember.model, messageId: pending.messageId, success: true });
            showModelAlert(state, currentMember);
            if (typeof onStatus === 'function') onStatus(`命中: ${memberLabel(currentMember)} | ${pending.type}`);
        }

        for (let retryAttempt = 0; retryAttempt < maxFailures; retryAttempt += 1) {
            if (retryAttempt > 0) await wait(delayMs);
            try {
                const result = await fetchWithMember(input, init, pending, currentPicked, currentMember, retryAttempt);
                if (result.ok) return result.response;
                lastResponse = result.response;
            } catch (error) {
                if (isUserAbortError(error, init)) throw error;
                const count = markRequestFailure(state, currentMember);
                lastError = error;
                retryDebug('network-error', {
                    traceId: pending.id,
                    retryAttempt,
                    apiName: currentMember?.name || '',
                    model: currentMember?.model || '',
                    count,
                    error: String(error?.message || error),
                });
                queueLog(state, { event: 'request-error', trigger: pending.type, mode: currentPicked.detail.mode, apiName: currentMember.name, apiUrl: currentMember.apiUrl, model: currentMember.model, messageId: pending.messageId, success: false, error: String(error?.message || error), detail: `第 ${count} 次失败` });
            }
        }

        if (onlyOneAvailable) {
            retryDebug('only-one-stop', { traceId: pending.id, apiName: currentMember?.name || '', model: currentMember?.model || '' });
            showRuntimeToast(onlyActiveFailureMessage(), 'error', 4200);
            break;
        }

        if (!alertEnabled) {
            blockedIds.add(currentMember.id);
            retryDebug('auto-switch-after-failures', { traceId: pending.id, blockedIds: [...blockedIds] });
            await wait(delayMs);
            continue;
        }

        const decision = await askFailureDecision(
            failureMessage(currentMember, maxFailures),
            [
                { value: 'confirm', label: '确认' },
                { value: 'switch', label: '切换API' },
                { value: 'cancel', label: '取消' },
            ],
            'switch',
        );
        if (decision === 'cancel') break;
        if (decision === 'switch') {
            blockedIds.add(currentMember.id);
            retryDebug('user-switch-after-failures', { traceId: pending.id, blockedIds: [...blockedIds] });
            await wait(delayMs);
            continue;
        }
        if (decision === 'confirm') {
            await wait(delayMs);
            try {
                const result = await fetchWithMember(input, init, pending, currentPicked, currentMember, maxFailures);
                if (result.ok) return result.response;
                lastResponse = result.response;
            } catch (error) {
                if (isUserAbortError(error, init)) throw error;
                lastError = error;
                queueLog(state, { event: 'request-error', trigger: pending.type, mode: currentPicked.detail.mode, apiName: currentMember.name, apiUrl: currentMember.apiUrl, model: currentMember.model, messageId: pending.messageId, success: false, error: String(error?.message || error) });
            }
            const nextDecision = await askFailureDecision(
                secondFailureMessage(currentMember),
                [
                    { value: 'use-next', label: '使用下一个API' },
                    { value: 'disable-cancel', label: '取消并停用该API' },
                    { value: 'cancel-keep', label: '取消，不停用该API' },
                ],
                'use-next',
            );
            if (nextDecision === 'use-next') {
                if (pool.mode === 'random') disableMemberByFailure(state, currentMember);
                blockedIds.add(currentMember.id);
                retryDebug('user-use-next-after-extra-fail', { traceId: pending.id, blockedIds: [...blockedIds] });
                await wait(delayMs);
                continue;
            }
            if (nextDecision === 'disable-cancel') disableMemberByFailure(state, currentMember);
            break;
        }
    }

    if (lastError) throw lastError;
    if (lastResponse) return lastResponse;
    return originalFetch(input, init);
}

function bindRetryFetch(onStatus) {
    if (fetchRetryBound) return;
    originalFetch = window.fetch.bind(window);
    window.fetch = async function karmaFlipRetryFetch(input, init) {
        if (!isGenerateFetch(input) || !init?.body || typeof init.body !== 'string') {
            return originalFetch(input, init);
        }
        const traced = readTraceRequest(init);
        if (!traced) {
            retryDebug('skip-no-trace', { url: typeof input === 'string' ? input : input?.url });
            return originalFetch(input, init);
        }
        cleanupPendingRequests();
        const pending = consumePendingRequest(traced.traceId);
        if (!pending) {
            retryDebug('skip-missing-pending', { traceId: traced.traceId });
            return originalFetch(input, traced.init);
        }
        retryDebug('trace-matched', { traceId: traced.traceId, type: pending.type });
        return runRetryPlan(input, traced.init, pending, onStatus);
    };
    fetchRetryBound = true;
}

async function prepareGenerationSelection(type, options, dryRun) {
    if (dryRun || !TEXT_GENERATION_TYPES.has(String(type || ''))) return;
    if (options?.quietImage === true || String(options?.quiet_prompt || '').trim()) return;

    discardPreparedSelection();

    const state = loadState();
    if (state.enabled === false) return;
    const pool = getActivePool(state);
    const messageId = targetMessageId(String(type));
    const override = findApiOverride(state, pool, messageId);
    if (override?.invalid) return;
    if (!override && (!Array.isArray(pool?.entries) || !validRuntimeEntries(pool).length)) return;

    const runtimeScope = getRuntimeScope(state);
    const runtimeSnapshot = cloneData(runtimeScope);
    const picked = override?.picked || pickMember(state, pool);
    if (!picked?.member) {
        replaceObject(runtimeScope, runtimeSnapshot);
        return;
    }
    const token = ++preparationSequence;
    const prepared = {
        token,
        state,
        runtimeScope,
        runtimeSnapshot,
        pool: override?.pool || pool,
        picked,
        member: picked.member,
        override,
        type: String(type),
        messageId,
        expiresAt: Date.now() + PENDING_TTL,
    };
    preparedSelection = prepared;
    try {
        prepared.presetResult = await beginPresetTransaction(picked.member, token);
    } catch (error) {
        discardPreparedSelection(token);
        throw error;
    }
}

function matchingPreparedSelection(type, messageId) {
    const prepared = preparedSelection;
    if (!prepared || prepared.expiresAt < Date.now()) {
        if (prepared) discardPreparedSelection(prepared.token);
        return null;
    }
    if (prepared.type !== String(type) || !compatiblePreparedMessageId(prepared.messageId, messageId)) {
        retryDebug('prepared-selection-mismatch', {
            preparedType: prepared.type,
            currentType: String(type),
            preparedMessageId: prepared.messageId,
            currentMessageId: messageId,
            messageIdDelta: Number(messageId) - Number(prepared.messageId),
        });
        discardPreparedSelection(prepared.token);
        return null;
    }
    preparedSelection = null;
    return prepared;
}

function bindGenerationLifecycle(eventSource, eventTypes) {
    if (generationLifecycleBound) return;
    const prepareEvent = eventTypes.GENERATION_AFTER_COMMANDS || eventTypes.GENERATION_STARTED;
    if (!prepareEvent) return;
    const prepare = async (type, options, dryRun) => {
        try {
            await prepareGenerationSelection(type, options, dryRun);
        } catch (error) {
            console.error('[KarmaFlip] 发送前应用绑定预设失败:', error);
            showRuntimeToast('绑定预设应用失败，本次继续使用酒馆当前预设', 'error', 4200);
        }
    };
    if (typeof eventSource.makeLast === 'function') eventSource.makeLast(prepareEvent, prepare);
    else eventSource.on(prepareEvent, prepare);
    if (eventTypes.GENERATION_STOPPED) {
        eventSource.on(eventTypes.GENERATION_STOPPED, () => {
            const prepared = preparedSelection;
            if (prepared) discardPreparedSelection(prepared.token);
        });
    }
    generationLifecycleBound = true;
}

function bindChatCompletionSettings(onStatus) {
    if (chatSettingsBound) return;
    if (bindRetryTimer) {
        clearTimeout(bindRetryTimer);
        bindRetryTimer = null;
    }

    const ctx = context();
    const eventSource = ctx.eventSource;
    const eventTypes = ctx.event_types || {};
    const eventName = eventTypes.CHAT_COMPLETION_SETTINGS_READY;

    if (!eventSource?.on || !eventName) {
        bindRetryTimer = setTimeout(() => bindChatCompletionSettings(onStatus), 1000);
        return;
    }

    bindGenerationLifecycle(eventSource, eventTypes);

    eventSource.on(eventName, async (generateData) => {
        const startedAt = nowMs();
        let prepared = null;
        try {
            const state = loadState();
            if (state.enabled === false) return;
            if (!isTextGeneration(generateData) || isBackgroundRequest(generateData)) return;

            const pool = getActivePool(state);
            const type = generationType(generateData);
            const messageId = targetMessageId(type);
            prepared = matchingPreparedSelection(type, messageId);
            if (isMvuAnalysisRequest(generateData)) {
                if (prepared) {
                    restorePreparedRuntime(prepared);
                }
                return;
            }
            const override = prepared?.override ?? findApiOverride(state, pool, messageId);
            if (override?.invalid) return;
            if (!prepared && !override && (!Array.isArray(pool?.entries) || !validRuntimeEntries(pool).length)) return;

            const pickStartedAt = nowMs();
            const picked = prepared?.picked || override?.picked || pickMember(state, pool);
            warnSlowPath('pick-member', pickStartedAt, PERF_WARN_MS.pickMember);
            if (!picked?.member) return;

            const member = picked.member;
            const requestPool = prepared?.pool || override?.pool || pool;
            if (!prepared && normalizedPresetBinding(member)) {
                console.warn('[KarmaFlip] 本轮未在提示词构建前取得预选，绑定预设不会在 READY 阶段补切。', {
                    type,
                    messageId,
                    apiName: member?.name || '',
                    presetName: normalizedPresetBinding(member)?.presetName || '',
                });
                showRuntimeToast('绑定预设未能及时应用，本轮已使用酒馆当前预设；API 配置仍正常生效。', 'warning', 4200);
            }
            patchGenerateData(generateData, member);

            generateData[TRACE_FIELD] = startPendingRequest(state, requestPool, picked, member, type, messageId, !!override, override?.source === 'lock');
            queueLog(state, { event: 'pick', trigger: type, mode: picked.detail.mode, apiName: member.name, apiUrl: member.apiUrl, model: member.model, messageId, success: true });
            showModelAlert(state, member);
            const pickLabel = override?.source === 'lock' ? '锁定' : (override ? '指定' : '命中');
            if (typeof onStatus === 'function') onStatus(`${pickLabel}: ${memberLabel(member)} | ${type} | #${messageId}`);
        } catch (error) {
            reportRuntimeError('CHAT_COMPLETION_SETTINGS_READY 处理失败', error);
        } finally {
            if (prepared?.token !== undefined) restorePresetTransaction(prepared.token);
            warnSlowPath('chat-settings', startedAt, PERF_WARN_MS.chatSettings);
        }
    });

    chatSettingsBound = true;
}

export function installRuntimeHook(onStatus) {
    bindChatCompletionSettings(onStatus);
    bindRetryFetch(onStatus);
}
