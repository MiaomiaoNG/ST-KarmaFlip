const LIMIT = 30;
const VERSION = 'KF 1.2.8 / E3';
const entries = [];
let notifyQueued = false;
let reportedErrors = new WeakSet();
const definitions = {
    prepare: ['P01', 'API预选', '插件预选操作异常'],
    preset: ['P02', '临时设置', '插件应用临时设置失败'],
    ready: ['P03', '请求改写', '插件接管操作异常'],
    'route-mismatch': ['P04', '请求改写', '路由字段写入不一致'],
    'retry-build': ['P05', '重试构造', '插件重试请求构造失败'],
    stream: ['P06', '流式设置', '插件设置解析来源失败'],
    'stream-mismatch': ['P07', '流式设置', '解析来源写入不一致'],
    restore: ['P08', '状态恢复', '插件恢复临时状态失败'],
    'restore-mismatch': ['P09', '状态恢复', '临时字段恢复不一致'],
    'batch-unsupported': ['P10', '接管路径', '已预选 API，但插件不支持 TN 批量流式接管'],
};
const checks = new Set(['route-mismatch', 'stream-mismatch', 'restore-mismatch', 'batch-unsupported']);
const fields = new Set(['chat_completion_source', 'reverse_proxy', 'proxy_password', 'model', 'google_model', 'claude_model']);
function notify() {
    if (notifyQueued) return;
    notifyQueued = true;
    queueMicrotask(() => {
        notifyQueued = false;
        window.dispatchEvent(new CustomEvent('STKarmaFlip:logs-updated'));
    });
}

// Called only at plugin-owned operations, never at fetch/body-reading boundaries.
// Unknown ownership is deliberately omitted rather than blaming the plugin.
export function recordPluginError(kind, error = null, field = '') {
    try {
        const definition = definitions[kind];
        if (!definition) return;
        let location = '';
        let type = '';
        if (error) {
            const message = String(error.message || '');
            if (/abort|cancel|fetch|network|load.*module|import.*module|ENOENT|EACCES|ERR_FILE|failed to load|网络|文件|请求失败/i.test(message)) return;
            if (!['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError'].includes(error.name)) return;
            if (reportedErrors.has(error)) return;
            const firstFrame = String(error.stack || '').split('\n').slice(1).find(line => /\.js:\d+:\d+/.test(line)) || '';
            const match = firstFrame.match(/(?:\/|\\)(runtime_hook|router|compat|plugin_state_store)\.js:(\d+):(\d+)/);
            if (!match) return;
            location = match[1] + '.js:' + match[2] + ':' + match[3];
            type = error.name;
            reportedErrors.add(error);
        } else if (!checks.has(kind)) return;
        const safeField = fields.has(field) ? field : '';
        const key = [definition[0], location, safeField, type].join('|');
        const index = entries.findIndex(item => item.key === key);
        const previous = index < 0 ? null : entries.splice(index, 1)[0];
        entries.unshift({ key, code: definition[0], stage: definition[1], message: definition[2],
            field: safeField, location, type, count: (previous?.count || 0) + 1,
            timestamp: Date.now(), time: new Date().toTimeString().slice(0, 8) });
        entries.length = Math.min(entries.length, LIMIT);
        notify();
    } catch { /* Error reporting must not break generation. */ }
}
export function getPluginErrors() {
    return entries.map(({ key, ...entry }) => ({ ...entry }));
}
export function formatPluginError(entry) {
    return entry.time + ' [' + entry.stage + '/' + entry.code + '] ' + entry.message
        + (entry.field ? ' · ' + entry.field : '')
        + (entry.type ? ' · ' + entry.type : '')
        + (entry.location ? ' @' + entry.location : '')
        + (entry.count > 1 ? ' ×' + entry.count : '');
}
export function diagnosticText(items = entries) {
    return VERSION + '\n' + (items.length ? items.map(formatPluginError).join('\n') : '未记录到插件内部错误');
}
export function clearDiagnostics() {
    entries.length = 0;
    reportedErrors = new WeakSet();
    notify();
}
