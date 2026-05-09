import { getActivePool, loadState, pushLog, saveStateAsync, toInt } from './plugin_state_store.js';
import { disableMemberByFailure, markRequestFailure, markRequestSuccess, pickMember } from './router.js';

let chatSettingsBound = false;
let fetchRetryBound = false;
let bindRetryTimer = null;
let originalFetch = null;
const pendingRequests = new Map();

const TEXT_GENERATION_TYPES = new Set(['normal', 'swipe', 'continue', 'append', 'regenerate']);
const LOG_PERSIST_DELAY = 5000;
const TRACE_FIELD = 'karmaflip_trace_id';
const PENDING_TTL = 30000;
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
    const messages = Array.isArray(generateData?.messages) ? generateData.messages : [];
    if (!messages.length) return false;
    const sampled = messages.length <= 4
        ? messages
        : [messages[0], messages[1], messages[messages.length - 2], messages[messages.length - 1]];
    const text = sampled.map(message => contentToText(message?.content)).join('\n');
    return MVU_PROMPT_PATTERNS.some(pattern => pattern.test(text));
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
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (contentType.includes('text/event-stream')) return { failed: false, detail: '' };

    if (!response.ok) {
        return { failed: true, detail: await responseText(response) };
    }
    if (!contentType.includes('application/json')) return { failed: false, detail: '' };
    const text = await responseText(response);
    const payload = parseJson(text);
    const message = businessErrorMessage(payload);
    return message ? { failed: true, detail: message || text } : { failed: false, detail: '' };
}

function queueLog(state, entry) {
    setTimeout(() => {
        pushLog(state, entry);
        saveStateAsync(state, LOG_PERSIST_DELAY);
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
    if (globalThis.crypto?.randomUUID) return `kf_${globalThis.crypto.randomUUID()}`;
    return `kf_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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
    const body = String(init?.body || '');
    if (!body.includes(TRACE_FIELD)) return null;
    try {
        const match = body.match(new RegExp(`"${TRACE_FIELD}"\\s*:\\s*"([^"]+)"`));
        const traceId = String(match?.[1] || '');
        if (!traceId) return null;
        return {
            traceId,
            init,
        };
    } catch {
        return null;
    }
}

async function fetchWithMember(input, init, pending, picked, member, retryIndex) {
    const requestInit = retryIndex === 0 && sameMember(member, pending.member)
        ? init
        : makeRetryInit(init, member);
    const response = await originalFetch(input, requestInit);
    const businessFailure = await responseBusinessFailure(response);
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
    const alertEnabled = !!state.failure?.alertEnabled;
    const availableEntries = validRuntimeEntries(pool);
    const onlyOneAvailable = availableEntries.length === 1;
    const maxSwitches = Math.max(1, availableEntries.length);
    const blockedIds = new Set();
    let lastResponse = null;
    let lastError = null;
    let currentPicked = pending.picked;
    let currentMember = pending.member;

    for (let switchAttempt = 0; switchAttempt < maxSwitches; switchAttempt += 1) {
        if (switchAttempt > 0) {
            currentPicked = chooseRequest(state, pool, blockedIds);
            currentMember = currentPicked?.member;
            if (!currentMember) break;
            queueLog(state, { event: 'pick', trigger: pending.type, mode: currentPicked.detail.mode, apiName: currentMember.name, model: currentMember.model, success: true });
            showModelAlert(state, currentMember);
            if (typeof onStatus === 'function') onStatus(`命中: ${memberLabel(currentMember)} | ${pending.type}`);
        }

        for (let retryAttempt = 0; retryAttempt < maxFailures; retryAttempt += 1) {
            try {
                const result = await fetchWithMember(input, init, pending, currentPicked, currentMember, retryAttempt);
                if (result.ok) return result.response;
                lastResponse = result.response;
            } catch (error) {
                if (isUserAbortError(error, init)) throw error;
                const count = markRequestFailure(state, currentMember);
                lastError = error;
                queueLog(state, { event: 'request-error', trigger: pending.type, mode: currentPicked.detail.mode, apiName: currentMember.name, model: currentMember.model, success: false, error: String(error?.message || error), detail: `第 ${count} 次失败` });
            }
        }

        if (onlyOneAvailable) {
            await askFailureDecision(onlyActiveFailureMessage(), [{ value: 'ok', label: '确认' }], 'ok');
            break;
        }

        if (!alertEnabled) {
            blockedIds.add(currentMember.id);
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
            continue;
        }
        if (decision === 'confirm') {
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
                continue;
            }
            if (nextDecision === 'disable-cancel') disableMemberByFailure(state, currentMember);
            break;
        }
    }

    saveStateAsync(state);
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
        if (!traced) return originalFetch(input, init);
        cleanupPendingRequests();
        const pending = consumePendingRequest(traced.traceId);
        if (!pending) return originalFetch(input, traced.init);
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
        const state = loadState();
        if (state.enabled === false) return;
        if (!isTextGeneration(generateData) || isBackgroundRequest(generateData)) return;
        if (isMvuAnalysisRequest(generateData)) return;

        const pool = getActivePool(state);
        if (!Array.isArray(pool.entries) || !pool.entries.length) return;
        if (!validRuntimeEntries(pool).length) return;

        const picked = pickMember(state, pool);
        if (!picked?.member) return;

        const member = picked.member;
        patchGenerateData(generateData, member);

        const type = generationType(generateData);
        generateData[TRACE_FIELD] = startPendingRequest(state, pool, picked, member, type);
        queueLog(state, { event: 'pick', trigger: type, mode: picked.detail.mode, apiName: member.name, model: member.model, success: true });
        showModelAlert(state, member);
        if (typeof onStatus === 'function') onStatus(`命中: ${memberLabel(member)} | ${type}`);
    });

    chatSettingsBound = true;
}

export function installRuntimeHook(onStatus) {
    bindChatCompletionSettings(onStatus);
    bindRetryFetch(onStatus);
}
