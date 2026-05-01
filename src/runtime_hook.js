import { getActivePool, loadState, pushLog, saveStateAsync } from './plugin_state_store.js';
import { disableMemberByFailure, markRequestFailure, markRequestSuccess, pickMember } from './router.js';

let fetchPatched = false;
let originalFetch = null;
let triggerReason = 'send';

function toast(type, message) {
    if (window.toastr?.[type]) window.toastr[type](message);
    else console[type === 'error' ? 'error' : 'log'](`[KarmaFlip] ${message}`);
}

function setReason(reason) {
    triggerReason = reason;
}

function bindTriggerEvents() {
    $(document).off('click.karmaFlipSend', '#send_but').on('click.karmaFlipSend', '#send_but', () => setReason('send'));
    $(document).off('click.karmaFlipSwipe', '.swipe_left, .swipe_right').on('click.karmaFlipSwipe', '.swipe_left, .swipe_right', () => setReason('swipe'));
    $(document).off('click.karmaFlipRegen', '#option_regenerate').on('click.karmaFlipRegen', '#option_regenerate', () => setReason('regenerate'));
    $(document).off('click.karmaFlipContinue', '#option_continue').on('click.karmaFlipContinue', '#option_continue', () => setReason('continue'));
}

function isChatRequest(url) {
    const target = String(url || '');
    return target.includes('/api/backends/chat-completions/generate') || target.includes('/v1/chat/completions');
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

async function sendWithMember(input, init, originalBody, state, pool, picked, member, requestKey, onStatus) {
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

        const state = loadState();
        const pool = getActivePool(state);
        if (state.enabled === false || !Array.isArray(pool.entries) || !pool.entries.length) return originalFetch(input, init);

        const originalBody = String(init.body);
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
                result = await sendWithMember(input, init, originalBody, state, pool, picked, member, `${triggerReason}|${Date.now()}|${switchAttempt}|${retryAttempt}`, onStatus);
                if (result.ok) {
                    saveStateAsync(state);
                    return result.response;
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
                result = await sendWithMember(input, init, originalBody, state, pool, picked, member, `${triggerReason}|${Date.now()}|${switchAttempt}|confirm`, onStatus);
                if (result.ok) {
                    saveStateAsync(state);
                    return result.response;
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
