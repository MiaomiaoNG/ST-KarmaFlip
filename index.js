import { initUI } from './src/ui_manager.js';
import { installRuntimeHook } from './src/runtime_hook.js';

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
        console.log(`[${moduleName}] Initializing...`);

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

        console.log(`[${moduleName}] Loaded.`);
    }

    return { init };
})();

jQuery(async () => {
    await KarmaFlip.init();
});
