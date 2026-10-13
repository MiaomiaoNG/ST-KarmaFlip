const LIMIT = 120;
const BUILD = '1.2.8 / diagnostics-2';
const records = [];
let notifyQueued = false;
const labels = {
    installed: '诊断已就绪', prepare: '开始正文预选', ready: 'API 接管完成',
    attempt: '发起请求', response: '收到响应头', checked: '响应检查完成',
    delivered: '原响应已交给酒馆', token: '首次酒馆流式文本事件',
    ended: '生成结束', stopped: '生成停止', abort: '请求取消信号',
    superseded: '下一轮开始，结束上一轮诊断', failure: '请求处理异常',
    runtime: '插件运行异常', unmatched: '请求标记未匹配（可能未接管）',
    boot: '插件入口已执行', hooksMissing: '酒馆接管事件尚不可用',
    batch: '检测到 TN 批量流式通道：未经过本插件标准 READY 接管',
    untracked: '旁路请求观察：仅诊断，未接管或修改请求',
    missingReady: '预选结束但未被 READY 认领：检查旁路或取消',
    batchUnknown: '无法唯一关联 TN 候选状态，仅观察请求头；不代表没有错误',
    batchState: 'TN 候选状态汇总（不是网络流内容）', batchError: 'TN 已捕获的候选错误',
    cancel: '酒馆发出取消接口请求', hostError: '生成期间酒馆未捕获异常（不直接判定插件责任）',
};
const sources = new Set(['openai', 'claude', 'makersuite', 'custom', 'vertexai', 'openrouter', 'deepseek', 'cohere', 'mistralai', 'xai']);

function notify() {
    if (notifyQueued) return;
    notifyQueued = true;
    queueMicrotask(() => {
        notifyQueued = false;
        window.dispatchEvent(new CustomEvent('STKarmaFlip:logs-updated'));
    });
}

// Whitelist structural metadata; never store bodies, URLs, keys or raw messages.
export function recordDiagnostic(stage, data = {}, error = null) {
    try {
        if (!labels[stage]) return;
        const detail = {};
        if (/^(kf_[A-Za-z0-9_-]+|prep_\d+)$/.test(data.traceId || '')) detail.traceId = data.traceId.slice(0, 100);
        for (const key of ['elapsedMs', 'attempt', 'status', 'textEvents', 'nonEmptyTextEvents', 'candidateCount', 'errorCount', 'doneCount', 'stoppedCount', 'candidateIndex']) {
            if (Number.isFinite(data[key])) detail[key] = Math.max(0, Math.round(data[key]));
        }
        for (const key of ['stream', 'ok', 'sourceMatches', 'streamEventSupported', 'prepared', 'proxyTemporarilyEmpty']) {
            if (typeof data[key] === 'boolean') detail[key] = data[key];
        }
        for (const key of ['requestSource', 'parserSource']) {
            if (typeof data[key] === 'string') detail[key] = sources.has(data[key]) ? data[key] : 'other';
        }
        if (typeof data.contentType === 'string') {
            const type = data.contentType.toLowerCase().split(';')[0].trim();
            detail.contentType = ['text/event-stream', 'application/json', 'text/plain', 'text/html', ''].includes(type) ? type || 'missing' : 'other';
        }
        if (['prepare', 'ready', 'fetch', 'response-check', 'restore', 'window-error', 'unhandled-rejection', 'initialize'].includes(data.location)) detail.location = data.location;
        if (['single', 'batch', 'cancel-stream', 'cancel-generation'].includes(data.route)) detail.route = data.route;
        if (error) {
            detail.errorType = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'NetworkError'].includes(error.name) ? error.name : 'Error';
            const message = String(error.message || '');
            detail.errorCategory = /abort|cancel/i.test(message) ? '取消' : /fetch|network|connection/i.test(message) ? '网络或连接' : /timeout|timed out/i.test(message) ? '超时' : /JSON|parse/i.test(message) ? '解析' : '运行异常（原始消息省略以保护隐私）';
            detail.frames = [...String(error.stack || '').matchAll(/\b(runtime_hook|runtime_diagnostics|ui_manager|plugin_state_store|router|compat|index|openai|sse-stream|script)\.js:(\d+):(\d+)/g)].slice(0, 6).map(m => m[1] + '.js:' + m[2] + ':' + m[3]);
        }
        records.unshift({ time: new Date().toISOString(), stage: labels[stage], ...detail });
        records.length = Math.min(records.length, LIMIT);
        notify();
    } catch { /* Diagnostics must never interrupt generation. */ }
}

export function diagnosticText(summary = '') {
    return 'KarmaFlip 插件运行诊断 | ' + BUILD
        + '\n仅当前页面会话，最多 ' + LIMIT + ' 条，最新在前。'
        + '\ntextEvents=文本事件次数，nonEmptyTextEvents=非空文本事件次数；事件不是网络数据包，没有事件不能证明网络未返回。'
        + '\n不包含密钥、URL、提示词、回复正文或原始异常消息。\n'
        + summary + '\n\n'
        + (records.length ? records.map(record => JSON.stringify(record)).join('\n') : '暂无诊断，请重现问题后复制。');
}

export function clearDiagnostics() {
    records.length = 0;
    notify();
}
