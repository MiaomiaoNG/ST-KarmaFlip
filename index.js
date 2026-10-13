import { initUI } from './src/ui_manager.js';
import { installRuntimeHook, hasActiveDiagnosticRequest } from './src/runtime_hook.js';
import { recordDiagnostic } from './src/runtime_diagnostics.js';

// Scope global diagnostics to this extension's own source files.
const diagnosticRoot = new URL('.', import.meta.url).href;
recordDiagnostic('boot');
const hostDiagnosticFiles = ['/script.js', '/scripts/openai.js', '/scripts/sse-stream.js'].map(path => new URL(path, window.location.href).href);
window.addEventListener('error', event => {
    if (String(event.filename || '').startsWith(diagnosticRoot)) {
        recordDiagnostic('runtime', { location: 'window-error' }, event.error || new Error());
    } else if (hasActiveDiagnosticRequest() && hostDiagnosticFiles.includes(String(event.filename || '').split('?')[0])) {
        recordDiagnostic('hostError', { location: 'window-error' }, event.error || new Error());
    }
});
window.addEventListener('unhandledrejection', event => {
    if (String(event.reason?.stack || '').includes(diagnosticRoot)) {
        recordDiagnostic('runtime', { location: 'unhandled-rejection' }, event.reason);
    } else if (hasActiveDiagnosticRequest() && hostDiagnosticFiles.some(file => String(event.reason?.stack || '').includes(file))) {
        recordDiagnostic('hostError', { location: 'unhandled-rejection' }, event.reason);
    }
});

const KarmaFlip = (() => {
    const moduleName = 'API随机临幸';
    const extensionFolderPath = new URL('.', import.meta.url).pathname;

    function setStatus(text) {
        $('#kf-status').text(text);
    }

    function runAfterStartup(task) {
        window.setTimeout(task, 500);
    }

    async function revealLayoutWhenStyled(root, guardedNodes) {
        const mainModal = document.getElementById('kf-main-modal');
        if (!root || !mainModal) throw new Error('V3 layout root is missing');
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            if (getComputedStyle(mainModal).position === 'fixed') {
                root.hidden = false;
                guardedNodes.forEach(node => { node.hidden = false; });
                return;
            }
            await new Promise(resolve => window.setTimeout(resolve, 25));
        }
        throw new Error('V3 layout stylesheet did not load');
    }

    async function init() {
        console.log(`[KarmaFlip] [${moduleName}] Initializing...`);

        const html = await $.get(`${extensionFolderPath}layout-v3.html`);
        $('.kf-inline-drawer').remove();
        $('#kf-extension-root').remove();
        document.body.insertAdjacentHTML('beforeend', html);

        const root = document.getElementById('kf-extension-root');
        const guardedNodes = [...(root?.querySelectorAll?.('.kf-modal-overlay') || [])];
        guardedNodes.forEach(node => { node.hidden = true; });
        await initUI(setStatus);
        await revealLayoutWhenStyled(root, guardedNodes);
        runAfterStartup(() => installRuntimeHook(setStatus));

        console.log(`[KarmaFlip] [${moduleName}] Loaded.`);
    }

    return { init };
})();

jQuery(async () => {
    try {
        await KarmaFlip.init();
    } catch (error) {
        recordDiagnostic('runtime', { location: 'initialize' }, error);
        console.error('[KarmaFlip] 初始化失败:', error);
    }
});
