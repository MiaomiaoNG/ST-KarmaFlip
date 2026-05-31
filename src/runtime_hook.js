import { getActivePool, loadState, pushLog, toInt } from './plugin_state_store.js';
import { disableMemberByFailure, markRequestFailure, markRequestSuccess, pickMember } from './router.js';
import { makeId } from './compat.js';

let chatSettingsBound = false;
let fetchRetryBound = false;
let bindRetryTimer = null;
let originalFetch = null;
const pendingRequests = new Map();

const TEXT_GENERATION_TYPES = new Set(['normal', 'swipe', 'continue', 'append', 'regenerate']);
const TRACE_FIELD = 'karmaflip_trace_id';
const PENDING_TTL = 30000;
const PERF_WARN_MS = {
    chatSettings: 12,
    mvuScan: 8,
    pickMember: 6,
    traceRead: 4,
    responseCheck: 20,
};
const MVU_PROMPT_PATTERNS = [
    /<additional_information\b/i,
    /<past_observe\b/i,
    /<must>\s*指令/i,
    /遵循\s*<must>\s*指令/i,
    /\[Start a new Chat\]/i,
    /<macro\b/i,
    /\bMacro\b/i,
];

function normalizeBaseUrl(apiUrl) {
    return String(apiUrl || '').trim().replace(/\/+$/, '');
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

function generationType(generateData) {
    return String(generateData?.type || 'normal');
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
        entry.key &&
        entry.model &&
        (mode !== 'random' || toInt(entry.weight) > 0);
}

function validRuntimeEntries(pool) {
    return (pool.entries || []).filter(entry => canUseEntry(entry, pool.mode));
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
    const text = sampled.map(message => contentToText(message?.content)).join('\n');
    const matched = MVU_PROMPT_PATTERNS.some(pattern => pattern.test(text));
    warnSlowPath('mvu-scan', startedAt, PERF_WARN_MS.mvuScan);
    return matched;
}

function isGenerateFetch(input) {
    const url = typeof input === 'string' ? input : input?.url;
    return String(url || '').includes('/api/backends/chat-completions/generate');
}

function patchGenerateData(generateData, member) {
    generateData.chat_completion_source = 'openai';
    generateData.reverse_proxy = normalizeBaseUrl(member.apiUrl);
    generateData.proxy_password = member.key;
    generateData.model = member.model;
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
    if (contentType.includes('text/event-stream')) return { failed: false, detail: '', reason: 'sse-pass' };

    if (!response.ok) {
        const result = { failed: true, detail: await responseText(response), reason: 'http' };
        warnSlowPath('response-check', startedAt, PERF_WARN_MS.responseCheck);
        return result;
    }
    if (!contentType.includes('application/json')) return { failed: false, detail: '', reason: 'non-json' };
    const text = await responseText(response);
    const payload = parseJson(text);
    const message = businessErrorMessage(payload);
    const result = message
        ? { failed: true, detail: message || text, reason: 'business-json' }
        : { failed: false, detail: '', reason: 'json-ok' };
    warnSlowPath('response-check', startedAt, PERF_WARN_MS.responseCheck);
    return result;
}

function queueLog(state, entry) {
    setTimeout(() => {
        pushLog(state, entry);
    }, 0);
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

function makeRetryInit(init, member) {
    return {
        ...init,
        body: patchBodyForMember(init.body, member),
    };
}

function makeTraceId() {
    return makeId('kf');
}

function startPendingRequest(state, pool, picked, member, type) {
    const id = makeTraceId();
    pendingRequests.set(id, {
        id,
        state,
        pool,
        picked,
        member,
        type,
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
        markRequestSuccess(pending.state, pending.pool, member, `${pending.type}|${Date.now()}|${retryIndex}`);
        queueLog(pending.state, { event: 'request', trigger: pending.type, mode: picked.detail.mode, apiName: member.name, model: member.model, success: true, status: response.status });
        return { ok: true, response };
    }
    const count = markRequestFailure(pending.state, member);
    const detail = businessFailure.detail;
    queueLog(pending.state, { event: 'request', trigger: pending.type, mode: picked.detail.mode, apiName: member.name, model: member.model, success: false, status: response.status, detail });
    return { ok: false, response, count };
}

async function runRetryPlan(input, init, pending, onStatus) {
    const state = pending.state;
    const pool = pending.pool;
    const maxFailures = retryLimit(state);
    const delayMs = retryDelayMs(state);
    const alertEnabled = !!state.failure?.alertEnabled;
    const availableEntries = validRuntimeEntries(pool);
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
            currentPicked = chooseRequest(state, pool, blockedIds);
            currentMember = currentPicked?.member;
            if (!currentMember) break;
            retryDebug('switch-member', {
                traceId: pending.id,
                switchAttempt,
                blockedIds: [...blockedIds],
                apiName: currentMember?.name || '',
                model: currentMember?.model || '',
            });
            queueLog(state, { event: 'pick', trigger: pending.type, mode: currentPicked.detail.mode, apiName: currentMember.name, model: currentMember.model, success: true });
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
                queueLog(state, { event: 'request-error', trigger: pending.type, mode: currentPicked.detail.mode, apiName: currentMember.name, model: currentMember.model, success: false, error: String(error?.message || error), detail: `第 ${count} 次失败` });
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
                queueLog(state, { event: 'request-error', trigger: pending.type, mode: currentPicked.detail.mode, apiName: currentMember.name, model: currentMember.model, success: false, error: String(error?.message || error) });
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

    eventSource.on(eventName, (generateData) => {
        const startedAt = nowMs();
        try {
            const state = loadState();
            if (state.enabled === false) return;
            if (!isTextGeneration(generateData) || isBackgroundRequest(generateData)) return;
            if (isMvuAnalysisRequest(generateData)) return;

            const pool = getActivePool(state);
            if (!Array.isArray(pool.entries) || !pool.entries.length) return;
            if (!validRuntimeEntries(pool).length) return;

            const pickStartedAt = nowMs();
            const picked = pickMember(state, pool);
            warnSlowPath('pick-member', pickStartedAt, PERF_WARN_MS.pickMember);
            if (!picked?.member) return;

            const member = picked.member;
            patchGenerateData(generateData, member);

            const type = generationType(generateData);
            generateData[TRACE_FIELD] = startPendingRequest(state, pool, picked, member, type);
            queueLog(state, { event: 'pick', trigger: type, mode: picked.detail.mode, apiName: member.name, model: member.model, success: true });
            showModelAlert(state, member);
            if (typeof onStatus === 'function') onStatus(`命中: ${memberLabel(member)} | ${type}`);
        } catch (error) {
            reportRuntimeError('CHAT_COMPLETION_SETTINGS_READY 处理失败', error);
        } finally {
            warnSlowPath('chat-settings', startedAt, PERF_WARN_MS.chatSettings);
        }
    });

    chatSettingsBound = true;
}

export function installRuntimeHook(onStatus) {
    bindChatCompletionSettings(onStatus);
    bindRetryFetch(onStatus);
}
