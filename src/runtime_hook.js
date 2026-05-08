import { getActivePool, loadState, pushLog, saveStateAsync } from './plugin_state_store.js';
import { disableMemberByFailure, markRequestFailure, markRequestSuccess, pickMember } from './router.js';

let fetchPatched = false;
let originalFetch = null;
let activeGrant = null;
let externalSendBlockUntil = 0;
let generationEventsBound = false;
let generationBindRetryTimer = null;
const GRANT_TTL_MS = 2500;
const EXTERNAL_SEND_BLOCK_MS = 2500;
const EXTERNAL_SEND_EVENTS = ['phone:sendToChat', 'STKarmaFlip:external-send'];

function toast(type, message) {
    if (window.toastr?.[type]) window.toastr[type](message);
    else console[type === 'error' ? 'error' : 'log'](`[KarmaFlip] ${message}`);
}

function grantPrimaryGeneration(reason) {
    activeGrant = {
        reason,
        expiresAt: Date.now() + GRANT_TTL_MS,
        consumed: false,
    };
}

function markExternalSend() {
    externalSendBlockUntil = Date.now() + EXTERNAL_SEND_BLOCK_MS;
    activeGrant = null;
}

function consumeGrant() {
    const now = Date.now();
    if (now < externalSendBlockUntil) {
        activeGrant = null;
        return null;
    }
    if (!activeGrant || activeGrant.consumed || activeGrant.expiresAt < now) {
        activeGrant = null;
        return null;
    }
    activeGrant.consumed = true;
    const reason = activeGrant.reason;
    activeGrant = null;
    return reason;
}

function peekGrant() {
    const now = Date.now();
    if (now < externalSendBlockUntil) {
        activeGrant = null;
        return null;
    }
    if (!activeGrant || activeGrant.consumed || activeGrant.expiresAt < now) {
        activeGrant = null;
        return null;
    }
    return activeGrant.reason;
}

function generationReason(type) {
    const value = typeof type === 'object' && type !== null
        ? String(type.type || type.reason || 'send')
        : String(type || 'send');
    if (value === 'normal') return 'send';
    return value;
}

function isPrimaryGeneration(type, details, dryRun) {
    const payload = typeof type === 'object' && type !== null ? type : details;
    if (dryRun === true || payload?.dryRun === true || payload?.dry_run === true) return false;
    if (payload?.automatic_trigger === true) return false;
    if (payload?.quiet_prompt || payload?.quietImage || payload?.quiet === true) return false;
    const value = typeof type === 'object' && type !== null
        ? String(type.type || type.reason || 'send')
        : String(type || 'send');
    return !['quiet', 'impersonate'].includes(value);
}

function bindGenerationEvents() {
    if (generationEventsBound) return;
    if (generationBindRetryTimer) {
        clearTimeout(generationBindRetryTimer);
        generationBindRetryTimer = null;
    }
    const context = window.SillyTavern?.getContext?.() || {};
    const eventSource = context.eventSource;
    const eventTypes = context.event_types || {};
    const generationStarted = eventTypes.GENERATION_STARTED;
    if (eventSource?.on && generationStarted) {
        eventSource.on(generationStarted, (type, details, dryRun) => {
            if (isPrimaryGeneration(type, details, dryRun)) grantPrimaryGeneration(generationReason(type));
            else activeGrant = null;
        });
        generationEventsBound = true;
    }
    if (!generationEventsBound) {
        generationBindRetryTimer = setTimeout(bindGenerationEvents, 1000);
    }
    for (const eventName of EXTERNAL_SEND_EVENTS) {
        window.removeEventListener(eventName, markExternalSend, true);
        window.addEventListener(eventName, markExternalSend, true);
    }
}

function isChatRequest(url) {
    const target = String(url || '');
    return target.includes('/api/backends/chat-completions/generate');
}

function parseBody(body) {
    try {
        return JSON.parse(body);
    } catch {
        return null;
    }
}

function isBackgroundRequest(payload) {
    if (!payload || typeof payload !== 'object') return true;
    return payload.quiet === true ||
        payload.skip_save === true ||
        payload.dryRun === true ||
        payload.dry_run === true ||
        payload.isVirtualPhoneApiCall === true;
}

function buildRequest(input, init, originalBody, member) {
    if (!['open', 'openai', 'deepseek'].includes(member.provider || 'open')) {
        throw new Error(`暂不支持接口类型：${member.provider || 'unknown'}`);
    }
    const payload = JSON.parse(originalBody);
    payload.chat_completion_source = 'openai';
    payload.reverse_proxy = String(member.apiUrl || '').replace(/\/+$/, '');
    payload.proxy_password = member.key;
    payload.model = member.model;
    return { input, init: { ...init, body: JSON.stringify(payload) } };
}

function chooseRequest(state, pool, blockedIds = new Set()) {
    const originalEntries = pool.entries;
    pool.entries = originalEntries.filter(e => !blockedIds.has(e.id));
    try {
        return pickMember(state, pool);
    } finally {
        pool.entries = originalEntries;
    }
}

function validRuntimeEntries(pool, mode) {
    return (pool.entries || []).filter(entry =>
        entry &&
        entry.enabled !== false &&
        entry.apiUrl &&
        entry.key &&
        entry.model &&
        (mode !== 'random' || Number(entry.weight) > 0)
    );
}

function retryLimit(state) {
    const count = Number(state.failure?.retryCount);
    return Number.isFinite(count) ? Math.max(1, Math.round(count)) : 3;
}

function isUserAbortError(error, init) {
    if (init?.signal?.aborted) return true;
    if (error?.name === 'AbortError') return true;
    const message = String(error?.message || error || '').toLowerCase();
    return /\b(abort|aborted|cancelled|canceled)\b/.test(message);
}

async function askFailureDecision(message, actions, fallback) {
    const opener = window.STKarmaFlip?.openFailureDecision;
    if (typeof opener !== 'function') {
        toast('warning', message);
        return fallback;
    }
    return opener(message, actions);
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

async function sendWithMember(input, init, originalBody, state, pool, picked, member, requestKey, triggerReason, onStatus) {
    const request = buildRequest(input, init, originalBody, member);
    if (typeof onStatus === 'function') onStatus(`命中: ${member.name} | ${member.model || '未填模型'} | ${triggerReason}`);
    try {
        const response = await originalFetch(request.input, request.init);
        if (response.ok) {
            markRequestSuccess(state, pool, member, requestKey);
            pushLog(state, { event: 'request', trigger: triggerReason, mode: picked.detail.mode, apiName: member.name, model: member.model, success: true, status: response.status });
            return { ok: true, response };
        }
        const count = markRequestFailure(state, member);
        pushLog(state, { event: 'request', trigger: triggerReason, mode: picked.detail.mode, apiName: member.name, model: member.model, success: false, status: response.status });
        return { ok: false, response, count };
    } catch (error) {
        if (isUserAbortError(error, request.init)) return { ok: false, error, aborted: true };
        const count = markRequestFailure(state, member);
        pushLog(state, { event: 'request-error', trigger: triggerReason, mode: picked.detail.mode, apiName: member.name, model: member.model, success: false, error: String(error?.message || error) });
        return { ok: false, error, count };
    }
}

export function installRuntimeHook(onStatus) {
    bindGenerationEvents();
    if (fetchPatched) return;
    originalFetch = window.fetch.bind(window);

    window.fetch = async function karmaFlipFetch(input, init) {
        const state = loadState();
        if (state.enabled === false) return originalFetch(input, init);

        const url = typeof input === 'string' ? input : input?.url;
        if (!isChatRequest(url) || !init?.body || typeof init.body !== 'string') return originalFetch(input, init);

        if (!peekGrant()) return originalFetch(input, init);

        const originalBody = String(init.body);
        const payload = parseBody(originalBody);
        if (isBackgroundRequest(payload)) return originalFetch(input, init);

        const triggerReason = consumeGrant();
        if (!triggerReason) return originalFetch(input, init);

        const pool = getActivePool(state);
        if (state.enabled === false || !Array.isArray(pool.entries) || !pool.entries.length) return originalFetch(input, init);

        const blockedIds = new Set();
        let lastError = null;
        let lastResponse = null;
        const maxFailures = retryLimit(state);
        const alertEnabled = !!state.failure?.alertEnabled;
        const availableEntries = validRuntimeEntries(pool, pool.mode);
        const onlyOneAvailable = availableEntries.length === 1;
        const maxSwitches = Math.max(1, availableEntries.length);

        for (let switchAttempt = 0; switchAttempt < maxSwitches; switchAttempt += 1) {
            const picked = chooseRequest(state, pool, blockedIds);
            if (!picked?.member) break;
            const member = picked.member;
            let result = null;
            pushLog(state, { event: 'pick', trigger: triggerReason, mode: picked.detail.mode, apiName: member.name, model: member.model, success: true });

            for (let retryAttempt = 0; retryAttempt < maxFailures; retryAttempt += 1) {
                result = await sendWithMember(input, init, originalBody, state, pool, picked, member, `${triggerReason}|${Date.now()}|${switchAttempt}|${retryAttempt}`, triggerReason, onStatus);
                if (result.ok) {
                    saveStateAsync(state);
                    return result.response;
                }
                if (result.aborted) {
                    saveStateAsync(state);
                    throw result.error;
                }
                lastResponse = result.response || lastResponse;
                lastError = result.error || lastError;
            }

            if (onlyOneAvailable) {
                await askFailureDecision(
                    onlyActiveFailureMessage(),
                    [{ value: 'ok', label: '确认' }],
                    'ok',
                );
                break;
            }

            if (!alertEnabled) {
                blockedIds.add(member.id);
                continue;
            }

            const decision = await askFailureDecision(
                failureMessage(member, maxFailures),
                [
                    { value: 'confirm', label: '确认' },
                    { value: 'switch', label: '切换API' },
                    { value: 'cancel', label: '取消' },
                ],
                'switch',
            );
            if (decision === 'cancel') break;
            if (decision === 'switch') {
                blockedIds.add(member.id);
                continue;
            }
            if (decision === 'confirm') {
                result = await sendWithMember(input, init, originalBody, state, pool, picked, member, `${triggerReason}|${Date.now()}|${switchAttempt}|confirm`, triggerReason, onStatus);
                if (result.ok) {
                    saveStateAsync(state);
                    return result.response;
                }
                if (result.aborted) {
                    saveStateAsync(state);
                    throw result.error;
                }
                lastResponse = result.response || lastResponse;
                lastError = result.error || lastError;
                const nextDecision = await askFailureDecision(
                    secondFailureMessage(member),
                    [
                        { value: 'use-next', label: '使用下一个API' },
                        { value: 'disable-cancel', label: '取消并停用该API' },
                        { value: 'cancel-keep', label: '取消，不停用该API' },
                    ],
                    'use-next',
                );
                if (nextDecision === 'use-next') {
                    if (pool.mode === 'random') disableMemberByFailure(state, member);
                    blockedIds.add(member.id);
                    continue;
                }
                if (nextDecision === 'disable-cancel') disableMemberByFailure(state, member);
                break;
            }
        }

        saveStateAsync(state);
        if (lastError) throw lastError;
        if (lastResponse) return lastResponse;
        return originalFetch(input, init);
    };

    fetchPatched = true;
}
