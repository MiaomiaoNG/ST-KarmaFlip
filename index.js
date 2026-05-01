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

    function ensureStylesheet(id, href) {
        if (document.getElementById(id)) return;
        const link = document.createElement('link');
        link.id = id;
        link.rel = 'stylesheet';
        link.href = href;
        document.head.appendChild(link);
    }

    async function init() {
        console.log(`[${moduleName}] Initializing...`);

        ensureStylesheet('st-karmaflip-theme-simple', `${extensionFolderPath}styles/theme-simple.css`);

        const html = await $.get(`${extensionFolderPath}index.html`);
        $('#extensions_settings').append(html);

        await initUI(setStatus);
        runAfterStartup(() => installRuntimeHook(setStatus));

        console.log(`[${moduleName}] Loaded.`);
    }

    return { init };
})();

jQuery(async () => {
    await KarmaFlip.init();
});
