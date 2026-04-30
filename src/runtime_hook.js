import { getActivePool, loadState, pushLog, saveState } from './plugin_state_store.js';
import { markRequestFailure, markRequestSuccess, pickMember } from './router.js';

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

async function askSwitchAfterFixedFailure(member, nextMember) {
    const message = `[${member.name}]已连续错误三次，是否切换下一个API[${nextMember?.name || '无可用API'}]发起请求？`;
    return confirm(message);
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
        if (!pool?.enabled || !Array.isArray(pool.entries) || !pool.entries.length) return originalFetch(input, init);

        const originalBody = String(init.body);
        const blockedIds = new Set();
        let lastError = null;
        let lastResponse = null;

        for (let attempt = 0; attempt < 3; attempt += 1) {
            const picked = chooseRequest(state, pool, blockedIds);
            if (!picked?.member) break;
            const member = picked.member;
            const requestKey = `${triggerReason}|${Date.now()}|${attempt}`;

            try {
                const request = buildRequest(input, init, originalBody, member);
                if (typeof onStatus === 'function') onStatus(`命中: ${member.name} | ${member.model || '未填模型'} | ${triggerReason}`);
                const response = await originalFetch(request.input, request.init);
                if (response.ok) {
                    markRequestSuccess(state, pool, member, requestKey);
                    pushLog(state, { event: 'request', trigger: triggerReason, mode: picked.detail.mode, apiName: member.name, model: member.model, success: true, status: response.status });
                    saveState(state);
                    return response;
                }

                lastResponse = response;
                const count = markRequestFailure(state, member);
                pushLog(state, { event: 'request', trigger: triggerReason, mode: picked.detail.mode, apiName: member.name, model: member.model, success: false, status: response.status });

                if (pool.mode === 'fixed' && count >= 3) {
                    blockedIds.add(member.id);
                    const next = chooseRequest(state, pool, blockedIds)?.member;
                    const ok = await askSwitchAfterFixedFailure(member, next);
                    if (!ok || !next) break;
                } else if (pool.mode === 'random') {
                    blockedIds.add(member.id);
                    if (count >= 3) toast('warning', `[${member.name}]连续请求错误达三次，已停用该模型`);
                    else toast('warning', `[${member.name}]请求出错，已重新随机抽选模型发送请求`);
                }
            } catch (error) {
                lastError = error;
                const count = markRequestFailure(state, member);
                pushLog(state, { event: 'request-error', trigger: triggerReason, mode: picked.detail.mode, apiName: member.name, model: member.model, success: false, error: String(error?.message || error) });
                blockedIds.add(member.id);
                if (pool.mode === 'random') {
                    if (count >= 3) toast('warning', `[${member.name}]连续请求错误达三次，已停用该模型`);
                    else toast('warning', `[${member.name}]请求出错，已重新随机抽选模型发送请求`);
                }
            }
        }

        saveState(state);
        if (lastError) throw lastError;
        if (lastResponse) return lastResponse;
        return originalFetch(input, init);
    };

    fetchPatched = true;
}
