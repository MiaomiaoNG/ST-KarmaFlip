import { getActivePool, loadState, pushLog, saveStateAsync } from './plugin_state_store.js';
import { disableMemberByFailure, markRequestFailure, markRequestSuccess, pickMember } from './router.js';

let fetchPatched = false;
let originalFetch = null;
let activeGrant = null;
let externalSendBlockUntil = 0;
const GRANT_TTL_MS = 2500;
const EXTERNAL_SEND_BLOCK_MS = 2500;
const EXTERNAL_SEND_EVENTS = ['phone:sendToChat', 'STKarmaFlip:external-send'];

function toast(type, message) {
    if (window.toastr?.[type]) window.toastr[type](message);
    else console[type === 'error' ? 'error' : 'log'](`[KarmaFlip] ${message}`);
}

function isTrustedUserEvent(event) {
    return !!event && event.isTrusted === true;
}

function isPlainEnterSend(event) {
    if (!event || event.key !== 'Enter') return false;
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return false;
    const target = event.target;
    return !!target && (target.id === 'send_textarea' || target.closest?.('#send_textarea'));
}

function grantPrimaryGeneration(reason, event) {
    if (!isTrustedUserEvent(event)) return;
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

function bindTriggerEvents() {
    $(document).off('click.karmaFlipSend', '#send_but').on('click.karmaFlipSend', '#send_but', event => grantPrimaryGeneration('send', event.originalEvent || event));
    $(document).off('click.karmaFlipSwipe', '.swipe_left, .swipe_right').on('click.karmaFlipSwipe', '.swipe_left, .swipe_right', event => grantPrimaryGeneration('swipe', event.originalEvent || event));
    $(document).off('click.karmaFlipRegen', '#option_regenerate').on('click.karmaFlipRegen', '#option_regenerate', event => grantPrimaryGeneration('regenerate', event.originalEvent || event));
    $(document).off('click.karmaFlipContinue', '#option_continue').on('click.karmaFlipContinue', '#option_continue', event => grantPrimaryGeneration('continue', event.originalEvent || event));
    $(document).off('keydown.karmaFlipSend', '#send_textarea').on('keydown.karmaFlipSend', '#send_textarea', event => {
        const original = event.originalEvent || event;
        if (isPlainEnterSend(original)) grantPrimaryGeneration('send', original);
    });
    for (const eventName of EXTERNAL_SEND_EVENTS) {
        window.removeEventListener(eventName, markExternalSend, true);
        window.addEventListener(eventName, markExternalSend, true);
    }
}

function isChatRequest(url) {
    const target = String(url || '');
    return target.includes('/api/backends/chat-completions/generate') || target.includes('/v1/chat/completions');
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
    bindTriggerEvents();
    if (fetchPatched) return;
    originalFetch = window.fetch.bind(window);

    window.fetch = async function karmaFlipFetch(input, init) {
        const url = typeof input === 'string' ? input : input?.url;
        if (!isChatRequest(url) || !init?.body || typeof init.body !== 'string') return originalFetch(input, init);

        const originalBody = String(init.body);
        const payload = parseBody(originalBody);
        if (isBackgroundRequest(payload)) return originalFetch(input, init);

        const triggerReason = consumeGrant();
        if (!triggerReason) return originalFetch(input, init);

        const state = loadState();
        const pool = getActivePool(state);
        if (state.enabled === false || !Array.isArray(pool.entries) || !pool.entries.length) return originalFetch(input, init);

        const blockedIds = new Set();
        let lastError = null;
        let lastResponse = null;
        const maxFailures = retryLimit(state);
        const alertEnabled = !!state.failure?.alertEnabled;
        const maxSwitches = Math.max(1, (pool.entries || []).length);

        for (let switchAttempt = 0; switchAttempt < maxSwitches; switchAttempt += 1) {
            const picked = chooseRequest(state, pool, blockedIds);
            if (!picked?.member) break;
            const member = picked.member;
            let result = null;

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
