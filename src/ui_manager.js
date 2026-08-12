import { clearApiLock, clearApiOverride, clearLogs, createExportSnapshot, enableStatePersistence, getActivePool, getApiOverrideState, getRuntimeScope, getUsageStats, loadState, patchActivePoolId, patchEnabledState, patchEntryCollapsedState, patchEntryEnabledState, patchPoolMode, patchPoolNoConsecutive, patchUpdateNoticeSeenVersion, resetAllPluginData, saveState, saveStateDebounced, setApiLock, setPendingApiOverride, toInt } from './plugin_state_store.js';
import { buildFixedSequence, memberIdentity, reconcileMemberCooldown } from './router.js';
import { clearRuntimeHookState } from './runtime_hook.js';
import { makeId, nextFrame, replaceNode } from './compat.js';

const MODAL_IDS = ['kf-main-modal', 'kf-update-notice-modal', 'kf-log-modal', 'kf-dropdown-modal', 'kf-theme-modal', 'kf-color-picker-modal', 'kf-settings-modal', 'kf-floating-skin-modal', 'kf-reset-data-modal', 'kf-failure-modal', 'kf-sequence-modal', 'kf-rename-pool-modal', 'kf-import-export-modal', 'kf-api-override-modal', 'kf-preset-binding-modal'];
const HOT_SAVE_DELAY = 1000;
const STRUCTURE_SAVE_DELAY = 5000;
const UPDATE_NOTICE_VERSION = '1.2.7';
const UPDATE_NOTICE_TEXT = `更新内容如下：

1. 重做插件美化，具体操作可以看帖子说明；
2. 新增“导出全部”；
3. 新增“快捷方式-指定API”功能，可以快速指定下轮请求API，长按“指定下个API”的快捷方式或悬浮图标可以快速切换API；
4. 新增悬浮图标，可设置指定悬浮图标的快捷功能；
5. API条目可以绑定预设，请求对应API条目时自动切换；

2026年8月12日`;

const LEGACY_CHAT_SHORTCUT_WRAPPER_ID = 'kf-chat-toggle-wrapper';
const LEGACY_CHAT_SHORTCUT_BUTTON_ID = 'kf-chat-toggle-btn';
const CHAT_POWER_WRAPPER_ID = 'kf-chat-power-wrapper';
const CHAT_MODE_WRAPPER_ID = 'kf-chat-mode-wrapper';
const CHAT_API_WRAPPER_ID = 'kf-chat-api-wrapper';
const CHAT_POWER_BUTTON_ID = 'kf-chat-power-btn';
const CHAT_MODE_BUTTON_ID = 'kf-chat-mode-btn';
const CHAT_API_BUTTON_ID = 'kf-chat-api-btn';
const FLOATING_ROOT_ID = 'kf-floating-root';
const FLOATING_BUTTON_ID = 'kf-floating-button';
const FLOATING_EDGE_GAP = 8;
const FLOATING_DRAG_THRESHOLD = 8;
const SHORTCUT_LONG_PRESS_MS = 560;
const SHORTCUT_PRESS_MOVE_THRESHOLD = 8;
const FLOATING_SKIN_DEFAULT = 'emperor-metal';
const FLOATING_SKINS = Object.freeze([
    { id: 'emperor-metal', name: '帝王之气', kind: 'metal', url: new URL('../assets/floating-icons/emperor.png', import.meta.url).href },
    { id: 'emperor-primary', name: '天威难料', kind: 'primary', url: new URL('../assets/floating-icons/emperor.png', import.meta.url).href },
    { id: 'q-scepter', name: 'Q版权杖', kind: 'image', url: new URL('../assets/floating-icons/q-scepter.png', import.meta.url).href },
    { id: 'crown', name: '皇冠', kind: 'image', url: new URL('../assets/floating-icons/crown.png', import.meta.url).href },
    { id: 'emperor-cat', name: '吾皇猫', kind: 'image', url: new URL('../assets/floating-icons/emperor-cat.png', import.meta.url).href },
    { id: 'elsa', name: '艾莎', kind: 'image', url: new URL('../assets/floating-icons/elsa.png', import.meta.url).href },
]);
const QR_ASSISTANT_LEGACY_DOM_IDS = [LEGACY_CHAT_SHORTCUT_WRAPPER_ID, LEGACY_CHAT_SHORTCUT_BUTTON_ID];
const QR_ASSISTANT_CURRENT_DOM_IDS = [CHAT_POWER_WRAPPER_ID, CHAT_MODE_WRAPPER_ID, CHAT_API_WRAPPER_ID];
const QR_ASSISTANT_MANAGED_DOM_IDS = [...QR_ASSISTANT_LEGACY_DOM_IDS, ...QR_ASSISTANT_CURRENT_DOM_IDS];
const MAGIC_WAND_CONTAINER_ID = 'kf-magic-wand-container';
const MAGIC_WAND_ENTRY_ID = 'kf-magic-wand-entry';
const LOG_URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
let uiPersistenceReady = false;
let chatShortcutRetryTimer = null;
let chatShortcutObserver = null;
let chatShortcutObserverTarget = null;
let magicWandObserver = null;
let mainPanelBaseHeight = 0;
let keyboardEditReleaseTimer = null;
let apiEntriesEditorOpen = false;
let apiEntriesForcedExpandedIds = new Set();
let colorPickerTargetId = '';
let colorPickerDragging = false;
let colorPickerDraft = { h: 0, s: 1, v: 1 };
let floatingViewportController = null;
let floatingVisibilityTimer = null;
let floatingModalObserver = null;
let presetBindingDraft = null;
let presetBindingCatalog = null;
const THEME_PRESETS = {
    default: { primary: '#1677ff', secondary: '#ffffff' },
    'mist-purple': { primary: '#7659e8', secondary: '#fbfaff' },
    mint: { primary: '#119d9a', secondary: '#f7fffd' },
    sakura: { primary: '#df5f91', secondary: '#fff8fb' },
    'retro-red': { primary: '#681414', secondary: '#d7ccb6' },
    'gray-blue': { primary: '#3d5a80', secondary: '#eaf2f8' },
};

function normalizeProvider(provider) {
    const value = String(provider || 'open').trim().toLowerCase();
    if (value === 'openai' || value === 'deepseek') return 'open';
    if (value === 'gemini' || value === 'claude') return value;
    return 'open';
}

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hexToRgb(hex) {
    return hexToRgbArray(hex).map(value => Math.round(value)).join(', ');
}

function normalizeHex(value, fallback = '#ffffff') {
    const raw = String(value || '').trim();
    const short = /^#([0-9a-f]{3})$/i.exec(raw);
    if (short) return `#${short[1].split('').map(char => char + char).join('')}`.toLowerCase();
    return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : fallback;
}

function hexToRgbArray(hex) {
    const clean = normalizeHex(hex, '#000000');
    return [
        parseInt(clean.slice(1, 3), 16),
        parseInt(clean.slice(3, 5), 16),
        parseInt(clean.slice(5, 7), 16),
    ];
}

function rgbToHex(rgb) {
    return `#${rgb.map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
}

function mixRgb(from, to, amount) {
    return from.map((value, index) => value * (1 - amount) + to[index] * amount);
}

function relativeLuminance(rgb) {
    const channels = rgb.map(value => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    });
    return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function adaptiveText(rgb) {
    return relativeLuminance(rgb) > 0.43 ? '#202938' : '#f7f9fc';
}

function clampNumber(value, min, max) {
    const number = Number(value);
    return Math.min(max, Math.max(min, Number.isFinite(number) ? number : min));
}

function rgbToHsv(rgb) {
    const [r, g, b] = rgb.map(value => clampNumber(value, 0, 255) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue = 0;
    if (delta) {
        if (max === r) hue = 60 * (((g - b) / delta) % 6);
        else if (max === g) hue = 60 * (((b - r) / delta) + 2);
        else hue = 60 * (((r - g) / delta) + 4);
    }
    if (hue < 0) hue += 360;
    return { h: hue, s: max ? delta / max : 0, v: max };
}

function hsvToRgb({ h, s, v }) {
    const hue = ((clampNumber(h, 0, 360) % 360) + 360) % 360;
    const saturation = clampNumber(s, 0, 1);
    const value = clampNumber(v, 0, 1);
    const chroma = value * saturation;
    const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
    const match = value - chroma;
    let channels;
    if (hue < 60) channels = [chroma, x, 0];
    else if (hue < 120) channels = [x, chroma, 0];
    else if (hue < 180) channels = [0, chroma, x];
    else if (hue < 240) channels = [0, x, chroma];
    else if (hue < 300) channels = [x, 0, chroma];
    else channels = [chroma, 0, x];
    return channels.map(channel => (channel + match) * 255);
}

function colorPickerHex() {
    return rgbToHex(hsvToRgb(colorPickerDraft));
}

function setThemeColorControlValue(targetId, value) {
    const color = normalizeHex(value, targetId === 'kf-theme-underline' ? '#1677ff' : '#ffffff');
    $(`#${targetId}`).val(color);
    $(`.kf-color-picker-trigger[data-color-target="${targetId}"]`)
        .val(color)
        .css('--kf-trigger-color', color);
    return color;
}

function renderColorPicker() {
    const hue = clampNumber(colorPickerDraft.h, 0, 360);
    const saturation = clampNumber(colorPickerDraft.s, 0, 1);
    const value = clampNumber(colorPickerDraft.v, 0, 1);
    const rgb = hsvToRgb({ h: hue, s: saturation, v: value }).map(channel => Math.round(channel));
    const hex = rgbToHex(rgb).toUpperCase();
    $('#kf-color-field')
        .css('--kf-picker-hue', hue)
        .attr('aria-valuetext', hex)
        .find('.kf-color-field-pointer')
        .css({ left: `${saturation * 100}%`, top: `${(1 - value) * 100}%` });
    $('#kf-color-hue').val(Math.round(hue)).css('--kf-picker-hue', hue);
    $('#kf-color-preview').css('background-color', hex);
    $('#kf-color-picker-hex').text(hex);
    $('#kf-color-r').val(rgb[0]);
    $('#kf-color-g').val(rgb[1]);
    $('#kf-color-b').val(rgb[2]);
}

function openColorPicker(targetId) {
    colorPickerTargetId = targetId;
    const fallback = targetId === 'kf-theme-underline' ? '#1677ff' : '#ffffff';
    const color = normalizeHex($(`#${targetId}`).val(), fallback);
    colorPickerDraft = rgbToHsv(hexToRgbArray(color));
    $('#kf-color-picker-title').text(targetId === 'kf-theme-underline' ? '选择主色调' : '选择辅色调');
    renderColorPicker();
    $('#kf-color-picker-modal').addClass('kf-show');
    window.setTimeout(() => $('#kf-color-field').trigger('focus'), 0);
}

function closeColorPicker() {
    colorPickerDragging = false;
    closeModal('kf-color-picker-modal');
}

function updateColorPickerFromPointer(event) {
    const field = document.getElementById('kf-color-field');
    if (!field) return;
    const rect = field.getBoundingClientRect();
    colorPickerDraft.s = clampNumber((event.clientX - rect.left) / rect.width, 0, 1);
    colorPickerDraft.v = 1 - clampNumber((event.clientY - rect.top) / rect.height, 0, 1);
    renderColorPicker();
}

function resolveThemePalette(theme = {}) {
    const primary = normalizeHex(theme.underline, '#1677ff');
    const secondary = normalizeHex(theme.bgMain, '#ffffff');
    const mode = theme.mode === 'dark' ? 'dark' : 'light';
    const primaryRgb = hexToRgbArray(primary);
    const secondaryRgb = hexToRgbArray(secondary);
    const white = [255, 255, 255];
    const black = [0, 0, 0];
    let surface;
    let surfaceSoft;
    let surfaceStrong;
    let pageStart;
    let pageEnd;
    let shadow;

    if (mode === 'dark') {
        const night = [23, 27, 34];
        surface = mixRgb(night, secondaryRgb, 0.055);
        surface = mixRgb(surface, primaryRgb, 0.020);
        surfaceSoft = mixRgb(surface, white, 0.060);
        surfaceStrong = mixRgb(surface, white, 0.115);
        pageStart = mixRgb(surface, [12, 15, 20], 0.28);
        pageStart = mixRgb(pageStart, primaryRgb, 0.018);
        pageEnd = mixRgb(surface, [7, 9, 13], 0.48);
        shadow = black;
    } else {
        surface = mixRgb(secondaryRgb, white, 0.72);
        surfaceSoft = mixRgb(surface, primaryRgb, 0.020);
        surfaceStrong = mixRgb(surface, white, 0.42);
        pageStart = mixRgb(surface, primaryRgb, 0.028);
        pageEnd = mixRgb(surface, primaryRgb, 0.060);
        shadow = mixRgb(primaryRgb, [42, 72, 112], 0.72);
    }

    const ink = hexToRgbArray(adaptiveText(surface));
    const muted = mixRgb(ink, surface, 0.43);
    const mutedLight = mixRgb(ink, surface, 0.60);
    const primaryStrong = mode === 'dark'
        ? mixRgb(primaryRgb, white, 0.10)
        : mixRgb(primaryRgb, black, 0.09);

    return {
        mode,
        primary,
        secondary,
        primaryStrong: rgbToHex(primaryStrong),
        surface: rgbToHex(surface),
        surfaceSoft: rgbToHex(surfaceSoft),
        surfaceStrong: rgbToHex(surfaceStrong),
        pageStart: rgbToHex(pageStart),
        pageEnd: rgbToHex(pageEnd),
        ink: rgbToHex(ink),
        muted: rgbToHex(muted),
        mutedLight: rgbToHex(mutedLight),
        onPrimary: adaptiveText(primaryRgb),
        onPrimaryStrong: adaptiveText(primaryStrong),
        onSecondary: adaptiveText(secondaryRgb),
        shadow: rgbToHex(shadow),
    };
}

function setThemeVars(target, theme) {
    if (!target) return;
    const palette = resolveThemePalette(theme);
    target.dataset.themeMode = palette.mode;
    target.style.setProperty('--primary', palette.primary);
    target.style.setProperty('--primary-strong', palette.primaryStrong);
    target.style.setProperty('--primary-rgb', hexToRgb(palette.primary));
    target.style.setProperty('--secondary', palette.secondary);
    target.style.setProperty('--secondary-rgb', hexToRgb(palette.secondary));
    target.style.setProperty('--surface', palette.surface);
    target.style.setProperty('--surface-soft', palette.surfaceSoft);
    target.style.setProperty('--surface-strong', palette.surfaceStrong);
    target.style.setProperty('--surface-rgb', hexToRgb(palette.surface));
    target.style.setProperty('--page-bg-start', palette.pageStart);
    target.style.setProperty('--page-bg-end', palette.pageEnd);
    target.style.setProperty('--ink', palette.ink);
    target.style.setProperty('--muted', palette.muted);
    target.style.setProperty('--muted-light', palette.mutedLight);
    target.style.setProperty('--on-primary', palette.onPrimary);
    target.style.setProperty('--on-primary-strong', palette.onPrimaryStrong);
    target.style.setProperty('--on-secondary', palette.onSecondary);
    target.style.setProperty('--shadow-color', hexToRgb(palette.shadow));
    target.style.setProperty('--line', `rgba(${hexToRgb(palette.primary)}, 0.11)`);
    target.style.setProperty('--line-strong', `rgba(${hexToRgb(palette.primary)}, 0.18)`);
    target.style.setProperty('--bg-main', palette.surface);
    target.style.setProperty('--bg-sub', palette.surfaceSoft);
    target.style.setProperty('--text-main', palette.ink);
    target.style.setProperty('--text-sub', palette.ink);
    target.style.setProperty('--text-accent', palette.onPrimary);
    target.style.setProperty('--underline-color', palette.primary);
    target.style.setProperty('--underline-rgb', hexToRgb(palette.primary));
}

function updateGlobalToggleState(state) {
    const enabled = state.enabled !== false;
    const toggle = $('#kf-global-toggle');
    toggle.toggleClass('kf-active', enabled);
    toggle.attr('data-enabled', String(enabled));
    toggle.find('.kf-global-toggle-label').text(enabled ? '插件已开启' : '插件已关闭');
}

function updateModeState(state) {
    const pool = getActivePool(state);
    $('#kf-root').attr('data-mode', pool.mode);
    $('#kf-mode-fixed').prop('checked', pool.mode === 'fixed');
    $('#kf-mode-random').prop('checked', pool.mode === 'random');
    $('#kf-no-streak').prop('checked', !!pool.random?.noConsecutive);
}

function getQrAssistantSettings() {
    try {
        return window.SillyTavern?.getContext?.()?.extensionSettings?.['qr-assistant'] || null;
    } catch (error) {
        return null;
    }
}

function isQrAssistantRuntimePresent() {
    return !!(
        window.quickReplyMenu ||
        Array.isArray(window.qrAssistantExtensionApi) ||
        document.body?.classList?.contains('qra-enabled')
    );
}

function isQrAssistantRuntimeLoaded() {
    return !!(
        window.quickReplyMenu ||
        document.getElementById('qr-assistant') ||
        document.body?.classList?.contains('qra-enabled') ||
        document.body?.classList?.contains('qra-disabled')
    );
}

function isQrAssistantEnabled() {
    if (!isQrAssistantRuntimeLoaded()) return false;
    const settings = getQrAssistantSettings();
    if (!settings || typeof settings !== 'object') return false;
    return settings.enabled !== false;
}

function applyQrAssistantRefresh() {
    try {
        window.quickReplyMenu?.applyWhitelistDOMChanges?.();
    } catch (error) {
        // QR Assistant is optional; failure should not affect native shortcuts.
    }
}

function enabledQrAssistantButtons(state) {
    const modeEnabled = state.shortcuts?.modeEnabled !== false;
    const powerEnabled = state.shortcuts?.powerEnabled !== false;
    const apiEnabled = state.shortcuts?.apiEnabled === true;
    const buttons = [];
    if (powerEnabled) {
        buttons.push({
            dom_id: CHAT_POWER_WRAPPER_ID,
            group_name: 'API随机临幸：插件开关',
            button_name: svgDataImage(emperorSvg({ imageSafe: true }), 'API随机临幸插件开关'),
        });
    }
    if (modeEnabled) {
        buttons.push({
            dom_id: CHAT_MODE_WRAPPER_ID,
            group_name: 'API随机临幸：模式切换',
            button_name: svgDataImage(lotterySvg({ imageSafe: true }), 'API随机临幸模式切换'),
        });
    }
    if (apiEnabled) {
        buttons.push({
            dom_id: CHAT_API_WRAPPER_ID,
            group_name: 'API随机临幸：指定API',
            button_name: '<i class="fa-regular fa-circle-stop"></i>',
        });
    }
    return buttons;
}

function registerQrAssistantShortcuts(state) {
    if (!isQrAssistantRuntimePresent()) return false;
    if (!Array.isArray(window.qrAssistantExtensionApi)) {
        window.qrAssistantExtensionApi = [];
    }
    const enabledButtons = enabledQrAssistantButtons(state);
    const enabledById = new Map(enabledButtons.map(entry => [entry.dom_id, entry]));
    const seenCurrentIds = new Set();
    const registry = [];
    for (const item of window.qrAssistantExtensionApi) {
        const domId = String(item?.dom_id || '');
        if (QR_ASSISTANT_LEGACY_DOM_IDS.includes(domId)) continue;
        if (QR_ASSISTANT_CURRENT_DOM_IDS.includes(domId)) {
            const replacement = enabledById.get(domId);
            if (!replacement || seenCurrentIds.has(domId)) continue;
            registry.push({ ...replacement });
            seenCurrentIds.add(domId);
            continue;
        }
        registry.push(item);
    }
    for (const entry of enabledButtons) {
        if (!seenCurrentIds.has(entry.dom_id)) registry.push({ ...entry });
    }
    window.qrAssistantExtensionApi = registry;
    applyQrAssistantRefresh();
    return true;
}

function unregisterQrAssistantShortcuts() {
    if (!Array.isArray(window.qrAssistantExtensionApi)) return;
    window.qrAssistantExtensionApi = window.qrAssistantExtensionApi.filter(item => !QR_ASSISTANT_MANAGED_DOM_IDS.includes(item?.dom_id));
    applyQrAssistantRefresh();
}

function migrateQrAssistantWhitelistSession(state) {
    const qrSettings = getQrAssistantSettings();
    if (!Array.isArray(qrSettings?.whitelist)) return false;
    const whitelist = qrSettings.whitelist;
    const hadLegacy = QR_ASSISTANT_LEGACY_DOM_IDS.some(domId => whitelist.includes(domId));
    if (!hadLegacy) return false;
    const replacements = enabledQrAssistantButtons(state).map(entry => entry.dom_id);
    const nextWhitelist = whitelist.filter(domId => !QR_ASSISTANT_LEGACY_DOM_IDS.includes(domId));
    for (const domId of replacements) {
        if (!nextWhitelist.includes(domId)) nextWhitelist.push(domId);
    }
    if (nextWhitelist.length === whitelist.length && nextWhitelist.every((domId, index) => domId === whitelist[index])) return false;
    qrSettings.whitelist = nextWhitelist;
    applyQrAssistantRefresh();
    return true;
}

function isQrAssistantWhitelisted(domId) {
    const qrSettings = getQrAssistantSettings();
    if (!qrSettings || !Array.isArray(qrSettings.whitelist)) return true;
    return qrSettings.whitelist.includes(domId);
}

function syncQrAssistantManagedVisibility(wrapper, button, hasQrAssistant) {
    if (!wrapper) return;
    const shouldHide = !!hasQrAssistant && !isQrAssistantWhitelisted(wrapper.id);
    wrapper.classList.toggle('kf-qr-managed-hidden', shouldHide);
    button?.classList?.toggle('kf-qr-managed-hidden', shouldHide);
    if (!hasQrAssistant) {
        wrapper.classList.remove('kf-qr-managed-hidden');
        button?.classList?.remove('kf-qr-managed-hidden');
    }
}

function updateChatShortcut(state) {
    const modeEnabled = state.shortcuts?.modeEnabled !== false;
    const powerEnabled = state.shortcuts?.powerEnabled !== false;
    const apiEnabled = state.shortcuts?.apiEnabled === true;
    if (!modeEnabled && !powerEnabled && !apiEnabled) {
        document.getElementById(LEGACY_CHAT_SHORTCUT_WRAPPER_ID)?.remove();
        document.getElementById(CHAT_POWER_WRAPPER_ID)?.remove();
        document.getElementById(CHAT_MODE_WRAPPER_ID)?.remove();
        document.getElementById(CHAT_API_WRAPPER_ID)?.remove();
        unregisterQrAssistantShortcuts();
        return;
    }
    const pool = getActivePool(state);
    const enabled = state.enabled !== false;
    const powerButton = $(`#${CHAT_POWER_BUTTON_ID}`);
    const modeButton = $(`#${CHAT_MODE_BUTTON_ID}`);
    const apiButton = $(`#${CHAT_API_BUTTON_ID}`);
    if (!powerEnabled) powerButton.remove();
    if (!modeEnabled) modeButton.remove();
    if (!apiEnabled) apiButton.remove();
    if (powerButton.length) {
        powerButton.attr('role', 'button');
        powerButton.attr('tabindex', '0');
        powerButton.attr('data-enabled', enabled ? 'true' : 'false');
        powerButton.attr('title', enabled ? '点击关闭 KarmaFlip 插件' : '点击开启 KarmaFlip 插件');
        powerButton.attr('aria-label', `KarmaFlip 插件开关，当前${enabled ? '已启用' : '已关闭'}`);
        powerButton.html(emperorIcon());
    }
    if (modeButton.length) {
        modeButton.attr('role', 'button');
        modeButton.attr('tabindex', '0');
        modeButton.attr('data-mode', pool.mode === 'random' ? 'random' : 'fixed');
        modeButton.attr('title', `点击切换固定/随机，当前${pool.mode === 'random' ? '随机模式' : '固定模式'}`);
        modeButton.attr('aria-label', `KarmaFlip 模式切换，当前${pool.mode === 'random' ? '随机模式' : '固定模式'}`);
        modeButton.html(lotteryIcon());
    }
    if (apiButton.length) {
        apiButton.attr('role', 'button');
        apiButton.attr('tabindex', '0');
        apiButton.attr('title', '点击指定下个请求 API；长按顺序切换当前锁定 API');
        apiButton.attr('aria-label', '指定下个请求 API，长按顺序切换当前锁定 API');
        apiButton.html('<i class="fa-regular fa-circle-stop"></i>');
    }
}

function createChatShortcutWrapper(id) {
    const wrapper = document.createElement('div');
    wrapper.id = id;
    wrapper.className = 'qr--buttons qr--color kf-chat-shortcut-wrapper';
    wrapper.style.setProperty('--qr--color', 'rgba(0,0,0,0)');
    return wrapper;
}

function bindQrWrapperProxy(wrapper, buttonId) {
    if (!wrapper || wrapper.dataset.kfQrProxyBound === 'true') return;
    wrapper.dataset.kfQrProxyBound = 'true';
    wrapper.addEventListener('click', event => {
        if (event.target?.closest?.(`#${buttonId}`)) return;
        event.preventDefault();
        event.stopPropagation();
        document.getElementById(buttonId)?.click();
    });
}

function bindShortcutActivation(target, action) {
    target.off('.kfShortcut')
        .on('click.kfShortcut', function (event) {
            event.preventDefault();
            event.stopPropagation();
            action(event);
        })
        .on('keydown.kfShortcut', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            action(event);
        });
}

function removeNodeIfPresent(node) {
    if (node?.parentNode) node.parentNode.removeChild(node);
}

function isNullArtifactNode(node) {
    if (!node) return false;
    if (node.nodeType === Node.TEXT_NODE) return String(node.textContent || '').trim() === 'null';
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const text = String(node.textContent || '').trim().toLowerCase();
    if (text !== 'null') return false;
    return node.classList?.contains('qr--button')
        || node.classList?.contains('qr--buttons')
        || node.classList?.contains('remote-ctrl-btn')
        || node.classList?.contains('menu_button')
        || node.classList?.contains('interactable');
}

function cleanupSiblingNullArtifacts(anchor) {
    if (!anchor?.parentNode) return;
    const nearestSibling = (node, direction) => {
        let cursor = node?.[direction] || null;
        while (cursor && cursor.nodeType === Node.TEXT_NODE && !String(cursor.textContent || '').trim()) {
            cursor = cursor[direction];
        }
        return cursor;
    };
    for (const sibling of [nearestSibling(anchor, 'previousSibling'), nearestSibling(anchor, 'nextSibling')]) {
        if (isNullArtifactNode(sibling)) removeNodeIfPresent(sibling);
    }
}

function cleanupQrBarNullArtifacts() {
    const qrBar = document.getElementById('qr--bar');
    if (!qrBar) return;
    qrBar.querySelectorAll('.qr--button, .qr--buttons, .remote-ctrl-btn, .menu_button, .interactable').forEach(node => {
        if (isNullArtifactNode(node)) removeNodeIfPresent(node);
    });
    qrBar.querySelectorAll('.qr--buttons').forEach(container => {
        for (const child of Array.from(container.childNodes)) {
            if (child.nodeType === Node.TEXT_NODE && String(child.textContent || '').trim().toLowerCase() === 'null') {
                removeNodeIfPresent(child);
            }
        }
    });
    for (const child of Array.from(qrBar.childNodes)) {
        if (isNullArtifactNode(child)) removeNodeIfPresent(child);
    }
}

function cleanupQrAssistantNullArtifacts() {
    const menu = document.getElementById('qr-assistant');
    if (!menu) return;
    menu.querySelectorAll('.action-item[data-source="RawDomElement"]').forEach(node => {
        const domId = String(node.dataset?.domId || '');
        if (!QR_ASSISTANT_MANAGED_DOM_IDS.includes(domId)) return;
        const label = String(node.dataset?.label || '').trim().toLowerCase();
        const text = String(node.textContent || '').trim().toLowerCase();
        if (label === 'null' || text === 'null') removeNodeIfPresent(node);
    });
}

function cleanupLegacyChatShortcutArtifacts() {
    [
        document.getElementById(LEGACY_CHAT_SHORTCUT_WRAPPER_ID),
        document.getElementById(LEGACY_CHAT_SHORTCUT_BUTTON_ID),
        ...document.querySelectorAll(`#qr--bar [id="${LEGACY_CHAT_SHORTCUT_WRAPPER_ID}"], #qr--bar [id="${LEGACY_CHAT_SHORTCUT_BUTTON_ID}"]`),
    ].filter(Boolean).forEach(node => {
        cleanupSiblingNullArtifacts(node);
        cleanupSiblingNullArtifacts(node.parentElement);
        removeNodeIfPresent(node);
    });

    if (Array.isArray(window.qrAssistantExtensionApi)) {
        window.qrAssistantExtensionApi = window.qrAssistantExtensionApi.filter(item => (
            item?.dom_id !== LEGACY_CHAT_SHORTCUT_WRAPPER_ID
            && item?.dom_id !== LEGACY_CHAT_SHORTCUT_BUTTON_ID
        ));
    }

    cleanupQrBarNullArtifacts();
    const qrBar = document.getElementById('qr--bar');
    if (!qrBar) return;
    const anchors = [
        document.getElementById(CHAT_POWER_WRAPPER_ID),
        document.getElementById(CHAT_MODE_WRAPPER_ID),
        document.getElementById(CHAT_API_WRAPPER_ID),
        document.getElementById(CHAT_POWER_BUTTON_ID),
        document.getElementById(CHAT_MODE_BUTTON_ID),
        document.getElementById(CHAT_API_BUTTON_ID),
    ].filter(Boolean);
    for (const anchor of anchors) {
        cleanupSiblingNullArtifacts(anchor);
        cleanupSiblingNullArtifacts(anchor.parentElement);
    }
    qrBar.querySelectorAll('.kf-chat-shortcut-wrapper, .kf-chat-shortcut-btn').forEach(node => {
        for (const child of Array.from(node.childNodes)) {
            if (isNullArtifactNode(child)) removeNodeIfPresent(child);
        }
    });
    cleanupQrAssistantNullArtifacts();
}

function scheduleShortcutArtifactCleanup() {
    cleanupLegacyChatShortcutArtifacts();
    window.setTimeout(cleanupLegacyChatShortcutArtifacts, 0);
    window.setTimeout(cleanupLegacyChatShortcutArtifacts, 300);
}

function svgDataImage(svg, alt) {
    const compact = String(svg || '').replace(/\s+/g, ' ').trim();
    const encoded = encodeURIComponent(compact)
        .replace(/'/g, '%27')
        .replace(/"/g, '%22');
    return `<img class="kf-chat-shortcut-img" src="data:image/svg+xml,${encoded}" alt="${esc(alt)}" />`;
}

function getInlineReplyHost() {
    return document.querySelector('#qr--bar .qr--buttons')
        || document.querySelector('#qr--bar');
}

function getChatShortcutObserverTarget() {
    return document.getElementById('send_form')
        || document.getElementById('qr--bar')
        || getInlineReplyHost()?.closest?.('#send_form, #qr--bar')
        || null;
}

function chatShortcutRelevantSelector() {
    return [
        '#qr--bar',
        '.qr--buttons',
        `#${LEGACY_CHAT_SHORTCUT_WRAPPER_ID}`,
        `#${LEGACY_CHAT_SHORTCUT_BUTTON_ID}`,
        `#${CHAT_POWER_WRAPPER_ID}`,
        `#${CHAT_MODE_WRAPPER_ID}`,
        `#${CHAT_API_WRAPPER_ID}`,
        `#${CHAT_POWER_BUTTON_ID}`,
        `#${CHAT_MODE_BUTTON_ID}`,
        `#${CHAT_API_BUTTON_ID}`,
        '.kf-chat-shortcut-wrapper',
        '.kf-chat-shortcut-btn',
    ].join(',');
}

function isChatShortcutNodeRelevant(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!element) return false;
    const selector = chatShortcutRelevantSelector();
    return !!(
        element.matches?.(selector)
        || element.closest?.(selector)
        || element.querySelector?.(selector)
    );
}

function isChatShortcutMutationRelevant(mutation) {
    if (!mutation) return false;
    const target = mutation.target;
    const observerTarget = chatShortcutObserverTarget;
    if (target && target !== observerTarget && isChatShortcutNodeRelevant(target)) return true;
    if (observerTarget?.id === 'qr--bar' && target === observerTarget) return true;
    return [...mutation.addedNodes, ...mutation.removedNodes].some(isChatShortcutNodeRelevant);
}

function emperorIcon() {
    return `
        <div class="qr--button-label" aria-hidden="true">
            ${emperorSvg()}
        </div>
    `;
}

function emperorSvg(options = {}) {
    const fill = options.imageSafe ? '#111111' : 'currentColor';
    return `
        <svg class="kf-chat-shortcut-icon kf-chat-emperor-icon" xmlns="http://www.w3.org/2000/svg" viewBox="50 20 300 360" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
            <path d="M 75 65 L 72 69 L 72 73 L 74 75 L 81 77 L 82 78 L 139 78 L 141 79 L 144 84 L 147 101 L 151 110 L 157 116 L 164 120 L 166 120 L 167 121 L 169 121 L 176 124 L 179 124 L 186 127 L 186 143 L 184 145 L 120 145 L 119 144 L 118 145 L 115 142 L 115 136 L 114 135 L 114 130 L 113 129 L 112 119 L 111 118 L 110 111 L 108 108 L 108 106 L 106 102 L 101 96 L 95 96 L 93 97 L 93 113 L 94 114 L 94 118 L 95 119 L 95 122 L 96 123 L 96 126 L 97 127 L 97 130 L 98 131 L 98 135 L 99 136 L 99 141 L 100 142 L 100 221 L 99 222 L 99 227 L 98 228 L 98 232 L 97 233 L 97 237 L 96 238 L 96 241 L 95 242 L 93 253 L 92 254 L 91 260 L 90 261 L 90 263 L 89 264 L 89 266 L 86 273 L 86 276 L 84 279 L 83 284 L 81 287 L 81 289 L 79 292 L 79 294 L 77 298 L 76 306 L 79 309 L 82 309 L 83 308 L 87 307 L 91 303 L 97 291 L 97 289 L 99 286 L 99 284 L 100 283 L 100 281 L 101 280 L 101 278 L 104 271 L 104 268 L 105 267 L 105 264 L 106 263 L 106 260 L 107 259 L 107 256 L 108 255 L 108 251 L 109 250 L 109 247 L 110 246 L 110 242 L 111 241 L 111 237 L 112 236 L 112 231 L 113 230 L 113 225 L 114 224 L 114 218 L 115 217 L 115 209 L 116 208 L 116 192 L 117 191 L 117 168 L 118 167 L 118 161 L 119 160 L 159 160 L 160 161 L 185 161 L 186 162 L 186 176 L 184 178 L 166 180 L 158 184 L 142 199 L 140 203 L 140 205 L 138 208 L 138 210 L 136 213 L 136 216 L 134 220 L 134 223 L 133 224 L 133 227 L 132 228 L 132 231 L 131 232 L 131 236 L 130 237 L 129 249 L 128 250 L 128 258 L 127 259 L 127 268 L 126 269 L 126 287 L 125 288 L 125 321 L 126 322 L 126 325 L 128 328 L 128 330 L 131 332 L 135 331 L 139 327 L 139 325 L 140 324 L 140 306 L 141 305 L 141 282 L 142 281 L 142 253 L 143 252 L 143 238 L 144 237 L 144 232 L 145 231 L 145 228 L 146 227 L 148 219 L 155 206 L 163 197 L 165 197 L 170 194 L 172 194 L 176 192 L 184 191 L 186 193 L 186 359 L 187 360 L 187 365 L 188 366 L 190 373 L 191 374 L 195 374 L 197 373 L 199 371 L 201 367 L 201 362 L 202 361 L 202 193 L 203 192 L 210 192 L 211 193 L 217 194 L 223 197 L 233 206 L 239 216 L 240 222 L 241 223 L 241 227 L 242 228 L 242 234 L 243 235 L 243 242 L 244 243 L 244 250 L 245 251 L 245 259 L 246 260 L 246 268 L 247 269 L 247 279 L 248 280 L 248 317 L 249 318 L 249 323 L 250 324 L 250 328 L 251 329 L 251 331 L 252 332 L 258 332 L 260 330 L 260 325 L 261 324 L 261 312 L 262 311 L 262 275 L 261 274 L 261 257 L 260 256 L 260 244 L 259 243 L 259 236 L 258 235 L 258 230 L 257 229 L 257 226 L 256 225 L 256 222 L 255 221 L 254 216 L 246 199 L 237 189 L 236 189 L 231 185 L 229 185 L 226 183 L 215 181 L 214 180 L 208 179 L 207 178 L 203 177 L 202 176 L 202 172 L 201 171 L 201 163 L 203 160 L 271 160 L 272 161 L 272 175 L 273 176 L 273 200 L 274 201 L 274 213 L 275 214 L 275 222 L 276 223 L 276 229 L 277 230 L 278 241 L 279 242 L 279 246 L 280 247 L 280 251 L 281 252 L 281 256 L 282 257 L 282 260 L 283 261 L 283 265 L 284 266 L 285 273 L 292 290 L 294 292 L 295 295 L 297 297 L 300 303 L 303 306 L 305 310 L 307 311 L 312 311 L 314 310 L 314 305 L 313 304 L 313 302 L 312 301 L 312 299 L 311 298 L 307 284 L 305 281 L 305 279 L 303 276 L 303 274 L 299 266 L 299 263 L 298 262 L 297 256 L 296 255 L 296 250 L 295 249 L 295 246 L 294 245 L 294 240 L 293 239 L 293 235 L 292 234 L 292 229 L 291 228 L 291 224 L 290 223 L 289 215 L 288 214 L 288 210 L 287 209 L 287 203 L 286 202 L 286 193 L 285 192 L 285 184 L 286 183 L 286 166 L 287 165 L 287 156 L 288 155 L 289 140 L 290 139 L 290 134 L 291 133 L 291 130 L 292 129 L 292 125 L 293 124 L 294 117 L 295 116 L 296 110 L 297 109 L 297 106 L 298 105 L 296 96 L 294 94 L 292 94 L 288 96 L 285 99 L 283 103 L 282 109 L 280 113 L 280 116 L 278 120 L 278 123 L 277 124 L 277 127 L 276 128 L 276 132 L 275 133 L 275 136 L 274 137 L 274 141 L 272 144 L 207 144 L 206 145 L 204 144 L 203 145 L 201 143 L 201 128 L 203 126 L 205 126 L 206 125 L 210 125 L 211 124 L 213 124 L 220 121 L 226 116 L 237 109 L 237 108 L 239 106 L 239 104 L 241 100 L 241 97 L 242 96 L 242 93 L 243 92 L 245 81 L 248 78 L 258 78 L 259 79 L 283 79 L 284 80 L 298 80 L 299 79 L 305 79 L 306 78 L 309 78 L 310 77 L 312 77 L 315 75 L 319 74 L 320 73 L 320 71 L 319 70 L 318 66 L 316 65 L 301 65 L 300 64 L 276 64 L 275 63 L 87 63 L 86 64 Z M 159 79 L 160 78 L 226 78 L 228 79 L 230 82 L 230 90 L 229 91 L 228 96 L 223 102 L 223 103 L 215 109 L 213 109 L 209 111 L 205 111 L 204 112 L 191 112 L 190 111 L 185 111 L 184 110 L 180 110 L 176 108 L 170 107 L 164 102 L 160 93 L 160 88 L 159 87 Z M 128 31 L 128 35 L 129 37 L 132 39 L 189 39 L 190 40 L 204 40 L 205 41 L 237 41 L 238 42 L 245 42 L 246 41 L 252 41 L 253 40 L 255 40 L 259 38 L 262 35 L 262 32 L 258 28 L 256 27 L 253 27 L 252 26 L 139 26 L 138 27 L 131 28 L 129 29 Z" fill="${fill}" stroke="${fill}" stroke-width="10" paint-order="stroke fill" stroke-linejoin="round" fill-rule="evenodd" clip-rule="evenodd" />
        </svg>
    `;
}

function lotteryIcon() {
    return `
        <div class="qr--button-label" aria-hidden="true">
            ${lotterySvg()}
        </div>
    `;
}

function lotterySvg(options = {}) {
    const stroke = options.imageSafe ? '#111111' : 'currentColor';
    const fill = options.imageSafe ? 'none' : 'var(--kf-shortcut-fill, transparent)';
    const dotFill = options.imageSafe ? '#ffffff' : 'var(--kf-shortcut-dot, Canvas)';
    return `
        <svg class="kf-chat-shortcut-icon kf-chat-lottery-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M 8.5 9 Q 12 7.5 15.5 9" fill="none" stroke="${stroke}" stroke-width="1.5" />
            <line x1="10" y1="10" x2="7" y2="4" stroke="${stroke}" stroke-width="1" stroke-linecap="round" />
            <line x1="11" y1="10" x2="9.5" y2="2.5" stroke="${stroke}" stroke-width="1" stroke-linecap="round" />
            <line x1="14" y1="10" x2="16.5" y2="5" stroke="${stroke}" stroke-width="1" stroke-linecap="round" />
            <line x1="13" y1="10" x2="14.5" y2="3.5" stroke="${stroke}" stroke-width="1" stroke-linecap="round" />
            <line x1="12" y1="10" x2="12" y2="4" stroke="${stroke}" stroke-width="1.5" stroke-linecap="butt" />
            <line class="kf-mode-accent kf-mode-accent-stroke" x1="12" y1="4" x2="12" y2="1.5" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" />
            <path d="M 8.5 9 Q 12 10.5 15.5 9 L 14.5 21 Q 12 22 9.5 21 Z" fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" />
            <polygon class="kf-mode-accent kf-mode-accent-fill" points="12,13.5 13.5,15.5 12,17.5 10.5,15.5" fill="${stroke}" stroke="${stroke}" stroke-width="1" stroke-linejoin="round"/>
            <circle cx="12" cy="15.5" r="0.8" fill="${dotFill}" />
        </svg>
    `;
}

function scheduleChatShortcutRetry(state, rerender, setStatus) {
    if (chatShortcutRetryTimer) return;
    chatShortcutRetryTimer = window.setTimeout(() => {
        chatShortcutRetryTimer = null;
        ensureChatShortcut(state, rerender, setStatus);
    }, 1200);
}

function ensureChatShortcut(state, rerender, setStatus) {
    const modeEnabled = state.shortcuts?.modeEnabled !== false;
    const powerEnabled = state.shortcuts?.powerEnabled !== false;
    const apiEnabled = state.shortcuts?.apiEnabled === true;
    if (!modeEnabled && !powerEnabled && !apiEnabled) {
        cleanupLegacyChatShortcutArtifacts();
        document.getElementById(CHAT_POWER_WRAPPER_ID)?.remove();
        document.getElementById(CHAT_MODE_WRAPPER_ID)?.remove();
        document.getElementById(CHAT_API_WRAPPER_ID)?.remove();
        unregisterQrAssistantShortcuts();
        applyQrAssistantRefresh();
        return;
    }
    const qrAssistantRegistered = registerQrAssistantShortcuts(state);
    const qrAssistantEnabled = isQrAssistantEnabled();
    if (qrAssistantEnabled) migrateQrAssistantWhitelistSession(state);
    const host = getInlineReplyHost();
    if (!host) {
        observeChatShortcutHost(state, rerender, setStatus);
        scheduleChatShortcutRetry(state, rerender, setStatus);
        return;
    }
    if (chatShortcutRetryTimer) {
        window.clearTimeout(chatShortcutRetryTimer);
        chatShortcutRetryTimer = null;
    }
    observeChatShortcutHost(state, rerender, setStatus);

    cleanupLegacyChatShortcutArtifacts();
    let powerWrapper = document.getElementById(CHAT_POWER_WRAPPER_ID);
    let modeWrapper = document.getElementById(CHAT_MODE_WRAPPER_ID);
    let apiWrapper = document.getElementById(CHAT_API_WRAPPER_ID);
    let powerShell = document.getElementById(CHAT_POWER_BUTTON_ID);
    let modeShell = document.getElementById(CHAT_MODE_BUTTON_ID);
    let apiShell = document.getElementById(CHAT_API_BUTTON_ID);
    if (powerEnabled && !powerShell) {
        powerShell = document.createElement('div');
        powerShell.id = CHAT_POWER_BUTTON_ID;
        powerShell.className = 'remote-ctrl-btn qr--button menu_button interactable kf-chat-shortcut-btn';
        powerShell.setAttribute('role', 'button');
        powerShell.tabIndex = 0;
    }
    if (modeEnabled && !modeShell) {
        modeShell = document.createElement('div');
        modeShell.id = CHAT_MODE_BUTTON_ID;
        modeShell.className = 'remote-ctrl-btn qr--button menu_button interactable kf-chat-shortcut-btn';
        modeShell.setAttribute('role', 'button');
        modeShell.tabIndex = 0;
    }
    if (apiEnabled && !apiShell) {
        apiShell = document.createElement('div');
        apiShell.id = CHAT_API_BUTTON_ID;
        apiShell.className = 'remote-ctrl-btn qr--button menu_button interactable kf-chat-shortcut-btn';
        apiShell.setAttribute('role', 'button');
        apiShell.tabIndex = 0;
    }
    if (!powerEnabled) {
        powerShell?.remove();
        powerWrapper?.remove();
        powerWrapper = null;
    } else {
        if (!powerWrapper) powerWrapper = createChatShortcutWrapper(CHAT_POWER_WRAPPER_ID);
        if (powerShell.parentElement !== powerWrapper) powerWrapper.appendChild(powerShell);
        bindQrWrapperProxy(powerWrapper, CHAT_POWER_BUTTON_ID);
    }
    if (!modeEnabled) {
        modeShell?.remove();
        modeWrapper?.remove();
        modeWrapper = null;
    } else {
        if (!modeWrapper) modeWrapper = createChatShortcutWrapper(CHAT_MODE_WRAPPER_ID);
        if (modeShell.parentElement !== modeWrapper) modeWrapper.appendChild(modeShell);
        bindQrWrapperProxy(modeWrapper, CHAT_MODE_BUTTON_ID);
    }
    if (!apiEnabled) {
        apiShell?.remove();
        apiWrapper?.remove();
        apiWrapper = null;
    } else {
        if (!apiWrapper) apiWrapper = createChatShortcutWrapper(CHAT_API_WRAPPER_ID);
        if (apiShell.parentElement !== apiWrapper) apiWrapper.appendChild(apiShell);
        bindQrWrapperProxy(apiWrapper, CHAT_API_BUTTON_ID);
    }
    if (modeWrapper && modeWrapper.parentElement !== host) host.prepend(modeWrapper);
    if (powerWrapper && powerWrapper.parentElement !== host) host.prepend(powerWrapper);
    if (apiWrapper && apiWrapper.parentElement !== host) host.prepend(apiWrapper);
    syncQrAssistantManagedVisibility(powerWrapper, powerShell, qrAssistantEnabled);
    syncQrAssistantManagedVisibility(modeWrapper, modeShell, qrAssistantEnabled);
    syncQrAssistantManagedVisibility(apiWrapper, apiShell, qrAssistantEnabled);
    cleanupLegacyChatShortcutArtifacts();
    if (qrAssistantRegistered) applyQrAssistantRefresh();
    bindChatShortcut(state, rerender, setStatus);
    updateChatShortcut(state);
}

function observeChatShortcutHost(state, rerender, setStatus) {
    if (typeof MutationObserver === 'undefined') return;
    const target = getChatShortcutObserverTarget();
    if (!target) {
        if (chatShortcutObserver) chatShortcutObserver.disconnect();
        chatShortcutObserver = null;
        chatShortcutObserverTarget = null;
        scheduleChatShortcutRetry(state, rerender, setStatus);
        return;
    }
    if (chatShortcutObserver && chatShortcutObserverTarget === target) return;
    if (chatShortcutObserver) chatShortcutObserver.disconnect();
    chatShortcutObserverTarget = target;
    chatShortcutObserver = new MutationObserver(mutations => {
        if (state.shortcuts?.modeEnabled === false && state.shortcuts?.powerEnabled === false && state.shortcuts?.apiEnabled !== true) return;
        if (!mutations.some(isChatShortcutMutationRelevant)) return;
        const currentTarget = getChatShortcutObserverTarget();
        if (currentTarget && currentTarget !== chatShortcutObserverTarget) {
            observeChatShortcutHost(state, rerender, setStatus);
            return;
        }
        cleanupLegacyChatShortcutArtifacts();
        const powerWrapper = document.getElementById(CHAT_POWER_WRAPPER_ID);
        const modeWrapper = document.getElementById(CHAT_MODE_WRAPPER_ID);
        const apiWrapper = document.getElementById(CHAT_API_WRAPPER_ID);
        const host = getInlineReplyHost();
        if (!host) {
            scheduleChatShortcutRetry(state, rerender, setStatus);
            return;
        }
        const powerOk = state.shortcuts?.powerEnabled === false || powerWrapper?.parentElement === host;
        const modeOk = state.shortcuts?.modeEnabled === false || modeWrapper?.parentElement === host;
        const apiOk = state.shortcuts?.apiEnabled !== true || apiWrapper?.parentElement === host;
        if (powerOk && modeOk && apiOk) return;
        ensureChatShortcut(state, rerender, setStatus);
    });
    chatShortcutObserver.observe(target, { childList: true, subtree: true });
}

function shouldShowUpdateNotice(state) {
    return String(state?.ui?.updateNoticeSeenVersion || '') !== UPDATE_NOTICE_VERSION;
}

function populateUpdateNotice() {
    $('#kf-update-notice-body').text(UPDATE_NOTICE_TEXT);
}

function openUpdateNotice(state) {
    if (!shouldShowUpdateNotice(state)) return;
    populateUpdateNotice();
    $('#kf-update-notice-modal').addClass('kf-show');
}

function confirmUpdateNotice(state) {
    patchUpdateNoticeSeenVersion(state, UPDATE_NOTICE_VERSION);
    closeModal('kf-update-notice-modal');
}

function openMainPanel(state) {
    resetMainPanelKeyboardLock();
    $('#kf-main-modal').addClass('kf-show');
    rememberMainPanelBaseHeight();
    openUpdateNotice(state);
}

function closeExtensionsMenu() {
    const menu = $('#extensionsMenu');
    if (!menu.length) return;
    menu.fadeOut?.(100);
    menu.hide();
}

function closeMainPanel() {
    resetMainPanelKeyboardLock();
    $('#kf-main-modal').removeClass('kf-show');
}

function focusApiEntriesEditorEntry(entryId) {
    nextFrame(() => {
        const list = document.getElementById('kf-entry-list');
        const row = [...(list?.querySelectorAll?.('.kf-entry-block') || [])]
            .find(node => String(node.dataset?.id || '') === String(entryId || ''));
        if (!list || !row) return;
        row.setAttribute('tabindex', '-1');
        row.classList.add('kf-entry-focus-target');
        row.focus({ preventScroll: true });
        const listRect = list.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        list.scrollTo({
            top: list.scrollTop + rowRect.top - listRect.top - Math.max(0, (listRect.height - rowRect.height) / 2),
            behavior: 'smooth',
        });
        window.setTimeout(() => row.classList.remove('kf-entry-focus-target'), 1600);
    });
}

function openApiEntriesEditor(state, entryId, rerender, setStatus) {
    if (state.ui?.compactApiEntries !== true) return;
    syncAllFromControls(state);
    const entries = getActivePool(state).entries || [];
    const entry = entries.find(item => item.id === entryId);
    if (!entry) return;
    apiEntriesEditorOpen = true;
    apiEntriesForcedExpandedIds = new Set(
        entries.filter(item => item.collapsed).map(item => String(item.id || '')),
    );
    rerender();
    focusApiEntriesEditorEntry(entry.id);
    setStatus(`正在编辑 API 条目：${entry.name || '未命名 API'}`);
}

function closeApiEntriesEditor(state, rerender, setStatus) {
    if (!apiEntriesEditorOpen) return false;
    syncAllFromControls(state);
    persistStructure(state);
    apiEntriesEditorOpen = false;
    apiEntriesForcedExpandedIds.clear();
    closeDropdown();
    resetMainPanelKeyboardLock();
    rerender();
    rememberMainPanelBaseHeight();
    setStatus('API 条目修改已应用');
    return true;
}

function ensureMagicWandEntry() {
    document.querySelectorAll(`#${MAGIC_WAND_ENTRY_ID}.menu_button`).forEach(node => node.remove());
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;

    let container = document.getElementById(MAGIC_WAND_CONTAINER_ID);
    if (!container) {
        container = document.createElement('div');
        container.id = MAGIC_WAND_CONTAINER_ID;
        container.className = 'extension_container';
    }

    let entry = document.getElementById(MAGIC_WAND_ENTRY_ID);
    if (!entry) {
        entry = document.createElement('div');
        entry.id = MAGIC_WAND_ENTRY_ID;
        entry.className = 'list-group-item flex-container flexGap5 interactable kf-magic-wand-entry';
        entry.title = 'API随机临幸';
        entry.setAttribute('aria-label', '打开 API随机临幸');
        entry.innerHTML = '<div class="fa-fw fa-solid fa-dice extensionsMenuExtensionButton"></div><span>API随机临幸</span>';
        entry.addEventListener('click', event => {
            event.preventDefault();
            closeExtensionsMenu();
            openMainPanel(loadState());
        });
    }
    if (entry.parentElement !== container) {
        container.appendChild(entry);
    }
    if (container.parentElement !== menu) {
        menu.appendChild(container);
    }
    return true;
}

function observeMagicWandEntry() {
    if (magicWandObserver || typeof MutationObserver === 'undefined') return;
    ensureMagicWandEntry();
    magicWandObserver = new MutationObserver(mutations => {
        const relevant = mutations.some(mutation => {
            const target = mutation.target;
            if (target?.id === 'extensionsMenu' || target?.id === 'extensionsMenuButton') return true;
            for (const node of mutation.addedNodes || []) {
                if (node.nodeType !== 1) continue;
                if (node.id === 'extensionsMenu' || node.querySelector?.('#extensionsMenu')) return true;
            }
            return false;
        });
        if (relevant) ensureMagicWandEntry();
    });
    magicWandObserver.observe(document.body, { childList: true, subtree: true });
}

function toggleGlobalEnabled(state, setStatus) {
    patchEnabledState(state, state.enabled === false);
    updateGlobalToggleState(state);
    updateChatShortcut(state);
    updateFloatingButton(state);
    showToast(state.enabled !== false ? '[已开启插件] 陛下，该翻牌子了~' : '[已关闭插件] 传令！陛下今日不翻牌。', 'info', 2200);
    setStatus(state.enabled !== false ? '插件已开启' : '插件已关闭');
}

function renderApiOverrideModal(state) {
    const pool = getActivePool(state);
    const list = $('#kf-api-override-list').empty();
    const message = $('#kf-api-override-message');
    const lockButton = $('#kf-api-override-lock');
    const restoreButton = $('#kf-api-override-restore');
    const startButton = $('#kf-api-override-start');

    if (state.enabled === false) {
        message.text('插件未开启').show();
        lockButton.hide();
        restoreButton.hide();
        startButton.show();
        return;
    }

    message.hide().empty();
    lockButton.show();
    restoreButton.show();
    startButton.hide();
    const override = getApiOverrideState(state);
    const lockPool = override.lock
        ? (state.pools || []).find(item => item?.id === override.lock.poolId) || null
        : null;
    const lockedEntry = override.lock
        ? (lockPool?.entries || []).find(item => item?.id === override.lock.entryId) || null
        : null;
    if (override.lock) {
        const lockedLabel = lockedEntry
            ? `${lockedEntry.name || '未命名 API'} / ${lockedEntry.model || '未选择模型'}`
            : 'API 已不存在';
        message.text(`当前聊天已锁定：${lockedLabel}`).show();
    }
    const selected = override.lock?.poolId === pool.id
        ? override.lock
        : (override.pending?.poolId === pool.id
            ? override.pending
            : (override.floorBinding?.poolId === pool.id ? override.floorBinding : null));
    lockButton
        .text(override.lock ? '取消锁定' : '锁定该API')
        .toggleClass('kf-primary-btn', !!override.lock)
        .toggleClass('kf-secondary-btn', !override.lock)
        .prop('disabled', !override.lock && !selected);
    const entries = Array.isArray(pool.entries) ? pool.entries : [];
    if (!entries.length) {
        message.text('当前组合没有 API 条目').show();
        return;
    }

    for (const entry of entries) {
        const hasUrl = !!String(entry.apiUrl || '').trim();
        const hasModel = !!String(entry.model || '').trim();
        const selectable = hasUrl && hasModel;
        const isSelected = selected?.entryId === entry.id;
        list.append(`
            <button type="button" class="kf-api-override-option${isSelected ? ' kf-selected' : ''}" data-entry-id="${esc(entry.id)}" ${selectable ? '' : 'disabled'}>
                <span class="kf-api-override-name">${esc(entry.name || '未命名 API')}</span>
                <span class="kf-api-override-model">${esc(entry.model || '未选择模型')}</span>
                ${selectable ? '' : '<span class="kf-api-override-invalid">无URL或未选择模型</span>'}
            </button>
        `);
    }
}

function openApiOverrideModal(state) {
    renderApiOverrideModal(state);
    $('#kf-api-override-modal').addClass('kf-show');
}

function setPoolMode(state, nextMode, rerender, setStatus) {
    const pool = getActivePool(state);
    const mode = nextMode === 'random' ? 'random' : 'fixed';
    if (pool.mode === mode) {
        updateModeState(state);
        updateChatShortcut(state);
        updateFloatingButton(state);
        return;
    }
    patchPoolMode(state, mode);
    const equalized = maybeEqualizeWeights(state);
    updateModeState(state);
    updateChatShortcut(state);
    updateFloatingButton(state);
    showToast(`切换成[${mode === 'random' ? '随机模式' : '固定模式'}] 太后让朕这个！`, 'info', 2200);
    setStatus(mode === 'random' ? '已切换到随机模式' : '已切换到固定模式');
    if (equalized) rerender();
}

function cycleLockedApi(state, setStatus) {
    const lock = getApiOverrideState(state).lock;
    if (!lock) {
        showToast('当前聊天尚未锁定 API，请先在指定 API 窗口中选择并锁定', 'warning', 3200);
        setStatus('当前聊天尚未锁定 API');
        return false;
    }
    const pool = (state.pools || []).find(item => String(item?.id) === String(lock.poolId));
    const entries = Array.isArray(pool?.entries) ? pool.entries : [];
    const currentIndex = entries.findIndex(entry => String(entry?.id) === String(lock.entryId));
    if (!pool || currentIndex < 0) {
        showToast('当前锁定的 API 已不存在，请重新选择锁定 API', 'error', 3600);
        setStatus('当前锁定的 API 已不存在');
        return false;
    }

    let nextEntry = null;
    for (let offset = 1; offset < entries.length; offset += 1) {
        const candidate = entries[(currentIndex + offset) % entries.length];
        if (!String(candidate?.apiUrl || '').trim() || !String(candidate?.model || '').trim()) continue;
        nextEntry = candidate;
        break;
    }
    if (!nextEntry) {
        showToast('当前锁定组合中没有其他 URL 和模型完整的 API', 'warning', 3200);
        setStatus('没有其他可顺序切换的 API');
        return false;
    }

    const nextLock = setApiLock(state, pool.id, nextEntry.id);
    if (!nextLock) {
        showToast('当前没有可绑定的聊天，无法切换锁定 API', 'warning', 3200);
        return false;
    }
    persistHot(state);
    if ($('#kf-api-override-modal').hasClass('kf-show')) renderApiOverrideModal(state);
    const label = `${nextEntry.name || '未命名 API'} / ${nextEntry.model}`;
    showToast(`已顺序切换锁定 API：${label}`, 'info', 2600);
    setStatus(`已顺序切换锁定 API：${nextEntry.name || nextEntry.model}`);
    return true;
}

function bindChatShortcut(state, rerender, setStatus) {
    const powerButton = $(`#${CHAT_POWER_BUTTON_ID}`);
    const modeButton = $(`#${CHAT_MODE_BUTTON_ID}`);
    const apiButton = $(`#${CHAT_API_BUTTON_ID}`);
    bindShortcutActivation(powerButton, () => {
        toggleGlobalEnabled(state, setStatus);
    });
    bindShortcutActivation(modeButton, () => {
        const pool = getActivePool(state);
        setPoolMode(state, pool.mode === 'random' ? 'fixed' : 'random', rerender, setStatus);
    });
    bindShortcutLongPress(
        apiButton,
        () => openApiOverrideModal(state),
        () => cycleLockedApi(state, setStatus),
    );
}


function normalizeFloatingAction(action) {
    const value = String(action || 'none').trim().toLowerCase();
    return ['mode', 'power', 'api', 'panel'].includes(value) ? value : 'none';
}

function normalizeFloatingSkin(skin) {
    const value = String(skin || FLOATING_SKIN_DEFAULT).trim().toLowerCase();
    return FLOATING_SKINS.some(item => item.id === value) ? value : FLOATING_SKIN_DEFAULT;
}

function floatingSkinVisual(skinId, preview = false) {
    const skin = FLOATING_SKINS.find(item => item.id === normalizeFloatingSkin(skinId)) || FLOATING_SKINS[0];
    const sizeClass = preview ? ' kf-floating-skin-preview-visual' : '';
    if (skin.kind === 'metal' || skin.kind === 'primary') {
        return `<span class="kf-floating-skin-visual kf-floating-skin-mask kf-floating-skin-${skin.kind}${sizeClass}" style="--kf-floating-skin-url:url(&quot;${esc(skin.url)}&quot;)" aria-hidden="true"><img class="kf-floating-skin-fallback" src="${esc(skin.url)}" alt="" draggable="false"></span>`;
    }
    return `<img class="kf-floating-skin-visual kf-floating-skin-image kf-floating-skin-${esc(skin.id)}${sizeClass}" src="${esc(skin.url)}" alt="" draggable="false" aria-hidden="true">`;
}

function renderFloatingSkinChoices(selectedSkin) {
    const selected = normalizeFloatingSkin(selectedSkin);
    const grid = $('#kf-floating-skin-grid').empty();
    for (const skin of FLOATING_SKINS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `kf-floating-skin-card${skin.id === selected ? ' kf-selected' : ''}`;
        button.dataset.skin = skin.id;
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', skin.id === selected ? 'true' : 'false');
        button.innerHTML = `<span class="kf-floating-skin-preview">${floatingSkinVisual(skin.id, true)}</span><span class="kf-floating-skin-name">${esc(skin.name)}</span>`;
        grid.append(button);
    }
    $('#kf-floating-skin-modal').attr('data-selected-skin', selected);
}

function openFloatingSkinModal() {
    renderFloatingSkinChoices($('#kf-floating-skin').val());
    $('#kf-floating-skin-modal').addClass('kf-show');
}

function bindShortcutLongPress(target, clickAction, longPressAction) {
    let press = null;
    let suppressClick = false;
    const clearPress = () => {
        if (press?.timer) window.clearTimeout(press.timer);
        press = null;
    };
    target.off('.kfShortcut')
        .on('pointerdown.kfShortcut', function (event) {
            if (event.button !== undefined && event.button !== 0) return;
            clearPress();
            suppressClick = false;
            const pointerId = event.pointerId;
            press = {
                pointerId,
                startX: Number(event.clientX || 0),
                startY: Number(event.clientY || 0),
                timer: window.setTimeout(() => {
                    if (!press || press.pointerId !== pointerId) return;
                    suppressClick = true;
                    press.timer = null;
                    longPressAction(event);
                }, SHORTCUT_LONG_PRESS_MS),
            };
            try {
                this.setPointerCapture?.(pointerId);
            } catch {
                // Pointer capture is optional on older mobile WebViews.
            }
        })
        .on('pointermove.kfShortcut', function (event) {
            if (!press || press.pointerId !== event.pointerId || !press.timer) return;
            const distance = Math.hypot(
                Number(event.clientX || 0) - press.startX,
                Number(event.clientY || 0) - press.startY,
            );
            if (distance > SHORTCUT_PRESS_MOVE_THRESHOLD) clearPress();
        })
        .on('pointerup.kfShortcut pointercancel.kfShortcut lostpointercapture.kfShortcut', clearPress)
        .on('contextmenu.kfShortcut', function (event) {
            if (!press && !suppressClick) return;
            event.preventDefault();
            event.stopPropagation();
        })
        .on('click.kfShortcut', function (event) {
            event.preventDefault();
            event.stopPropagation();
            if (suppressClick) {
                suppressClick = false;
                return;
            }
            clickAction(event);
        })
        .on('keydown.kfShortcut', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            clickAction(event);
        });
}

function cloneBooleanRecord(raw) {
    const result = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'boolean' && String(key || '').trim()) result[String(key)] = value;
    }
    return result;
}

function promptOrderForPreset(preset) {
    const lists = Array.isArray(preset?.prompt_order) ? preset.prompt_order : [];
    return lists.find(item => String(item?.character_id) === '100001')?.order
        || lists.find(item => Array.isArray(item?.order))?.order
        || [];
}

async function readNativePresetBindingCatalog(presetName) {
    const [{ getPresetManager }] = await Promise.all([
        import('/scripts/preset-manager.js'),
    ]);
    const manager = getPresetManager?.('openai') || getPresetManager?.();
    if (!manager) throw new Error('当前酒馆未提供聊天补全预设管理器');
    const presets = [...new Set((manager.getAllPresets?.() || []).map(name => String(name || '').trim()).filter(Boolean))];
    const currentName = String(manager.getSelectedPresetName?.() || '').trim();
    const selectedName = String(presetName || currentName || presets[0] || '').trim();
    const ctx = window.SillyTavern?.getContext?.() || {};
    const preset = selectedName === currentName && ctx.chatCompletionSettings
        ? ctx.chatCompletionSettings
        : (selectedName ? manager.getCompletionPresetByName?.(selectedName) : null);
    const promptMap = new Map((Array.isArray(preset?.prompts) ? preset.prompts : [])
        .filter(Boolean)
        .map(prompt => [String(prompt.identifier || ''), prompt]));
    const prompts = promptOrderForPreset(preset)
        .filter(item => item?.identifier)
        .map(item => {
            const id = String(item.identifier);
            const prompt = promptMap.get(id);
            return {
                key: id,
                name: String(prompt?.name || id),
                meta: String(prompt?.role || (prompt?.system_prompt ? 'system' : 'prompt')),
                scope: 'Prompt',
                enabled: item.enabled !== false,
            };
        });

    const globalScripts = Array.isArray(ctx.extensionSettings?.regex) ? ctx.extensionSettings.regex : [];
    const scopedScripts = Array.isArray(ctx.characters?.[ctx.characterId]?.data?.extensions?.regex_scripts)
        ? ctx.characters[ctx.characterId].data.extensions.regex_scripts
        : [];
    const presetScripts = selectedName
        ? manager.readPresetExtensionField?.({ name: selectedName, path: 'regex_scripts' })
        : [];
    const regex = [];
    for (const [scope, label, scripts] of [
        ['global', '全局', globalScripts],
        ['scoped', '角色', scopedScripts],
        ['preset', '预设', Array.isArray(presetScripts) ? presetScripts : []],
    ]) {
        for (const script of scripts) {
            const id = String(script?.id || '').trim();
            if (!id) continue;
            regex.push({
                key: `${scope}:${id}`,
                name: String(script?.scriptName || id),
                meta: String(script?.findRegex || ''),
                scope: label,
                enabled: script?.disabled !== true,
            });
        }
    }
    return { manager, presets, selectedName, presetExists: !!preset, prompts, regex };
}

function presetBindingRows() {
    if (!presetBindingDraft || !presetBindingCatalog) return [];
    return presetBindingDraft.tab === 'regex' ? presetBindingCatalog.regex : presetBindingCatalog.prompts;
}

function presetBindingStateMap() {
    return presetBindingDraft?.tab === 'regex' ? presetBindingDraft.regexStates : presetBindingDraft?.promptStates;
}

function renderPresetBindingList() {
    const list = $('#kf-preset-binding-list').empty();
    if (!presetBindingDraft || !presetBindingCatalog) return;
    const query = String($('#kf-preset-binding-search').val() || '').trim().toLowerCase();
    const states = presetBindingStateMap();
    const rows = presetBindingRows().filter(row => !query
        || row.name.toLowerCase().includes(query)
        || row.meta.toLowerCase().includes(query)
        || row.scope.toLowerCase().includes(query));
    for (const row of rows) {
        const enabled = Object.prototype.hasOwnProperty.call(states, row.key) ? states[row.key] : row.enabled;
        const item = document.createElement('div');
        item.className = 'kf-preset-binding-item';
        item.dataset.key = row.key;
        item.innerHTML = `<span class="kf-preset-binding-grip" aria-hidden="true">⠿</span><button class="kf-preset-binding-toggle" type="button" aria-label="${enabled ? '关闭' : '开启'} ${esc(row.name)}" aria-pressed="${enabled ? 'true' : 'false'}"></button><span class="kf-preset-binding-item-copy"><span class="kf-preset-binding-item-name" title="${esc(row.name)}">${esc(row.name)}</span><span class="kf-preset-binding-item-meta">${esc(row.meta)}</span></span><span class="kf-preset-binding-scope">${esc(row.scope)}</span>`;
        list.append(item);
    }
    const overrideCount = Object.keys(presetBindingDraft.promptStates).length + Object.keys(presetBindingDraft.regexStates).length;
    const availability = presetBindingCatalog.presetExists ? '' : ' · 绑定预设当前不存在';
    $('#kf-preset-binding-status').text(`${rows.length} 个条目 · ${overrideCount} 项自定义开关${availability}`);
}

async function refreshPresetBindingCatalog({ resetStates = false } = {}) {
    if (!presetBindingDraft) return;
    $('#kf-preset-binding-status').text('正在读取酒馆预设…');
    $('#kf-preset-binding-list').empty();
    try {
        presetBindingCatalog = await readNativePresetBindingCatalog(presetBindingDraft.presetName);
        presetBindingDraft.presetName = presetBindingCatalog.selectedName;
        if (resetStates) {
            presetBindingDraft.promptStates = {};
            presetBindingDraft.regexStates = {};
        }
        const select = $('#kf-preset-binding-select').empty();
        const names = [...presetBindingCatalog.presets];
        if (presetBindingDraft.presetName && !names.includes(presetBindingDraft.presetName)) names.unshift(presetBindingDraft.presetName);
        for (const name of names) {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name === presetBindingDraft.presetName && !presetBindingCatalog.presets.includes(name)
                ? `${name}（已不存在）`
                : name;
            option.selected = name === presetBindingDraft.presetName;
            select.append(option);
        }
        $('.kf-preset-binding-select-wrap').toggleClass('kf-bound', !!presetBindingDraft.presetName);
        renderPresetBindingList();
    } catch (error) {
        presetBindingCatalog = null;
        $('#kf-preset-binding-status').text(error?.message || '读取酒馆预设失败');
    }
}

async function openPresetBindingModal(state, entry) {
    const pool = getActivePool(state);
    const binding = entry?.presetBinding || {};
    presetBindingDraft = {
        poolId: String(pool?.id || ''),
        entryId: String(entry?.id || ''),
        presetName: String(binding.presetName || ''),
        promptStates: cloneBooleanRecord(binding.promptStates),
        regexStates: cloneBooleanRecord(binding.regexStates),
        tab: 'prompts',
    };
    presetBindingCatalog = null;
    $('#kf-preset-binding-search').val('');
    $('.kf-preset-binding-tab').removeClass('kf-active').attr('aria-selected', 'false')
        .filter('[data-binding-tab="prompts"]').addClass('kf-active').attr('aria-selected', 'true');
    $('#kf-preset-binding-modal').addClass('kf-show');
    await refreshPresetBindingCatalog();
}

function closePresetBindingModal() {
    presetBindingDraft = null;
    presetBindingCatalog = null;
    closeModal('kf-preset-binding-modal');
}

function floatingActionLabel(action) {
    return {
        mode: '切换固定或随机模式',
        power: '开启或关闭插件',
        api: '指定下个请求 API',
        panel: '打开插件主界面',
    }[normalizeFloatingAction(action)] || 'KarmaFlip 悬浮按钮';
}

function floatingViewportBounds() {
    const viewport = window.visualViewport;
    return {
        left: Number(viewport?.offsetLeft || 0),
        top: Number(viewport?.offsetTop || 0),
        width: Math.max(0, Number(viewport?.width || window.innerWidth || 0)),
        height: Math.max(0, Number(viewport?.height || window.innerHeight || 0)),
    };
}

function clampFloatingPosition(left, top, button) {
    const viewport = floatingViewportBounds();
    const width = Math.max(1, button?.offsetWidth || 46);
    const height = Math.max(1, button?.offsetHeight || 46);
    const minLeft = viewport.left + FLOATING_EDGE_GAP;
    const minTop = viewport.top + FLOATING_EDGE_GAP;
    const maxLeft = Math.max(minLeft, viewport.left + viewport.width - width - FLOATING_EDGE_GAP);
    const maxTop = Math.max(minTop, viewport.top + viewport.height - height - FLOATING_EDGE_GAP);
    return {
        left: Math.min(maxLeft, Math.max(minLeft, Number(left) || 0)),
        top: Math.min(maxTop, Math.max(minTop, Number(top) || 0)),
    };
}

function defaultFloatingPosition(button) {
    const viewport = floatingViewportBounds();
    const width = Math.max(1, button?.offsetWidth || 46);
    const height = Math.max(1, button?.offsetHeight || 46);
    return clampFloatingPosition(
        viewport.left + viewport.width - width - 18,
        viewport.top + (viewport.height * 0.72) - (height / 2),
        button,
    );
}

function applyFloatingPosition(state, options = {}) {
    const button = document.getElementById(FLOATING_BUTTON_ID);
    if (!button) return null;
    const saved = state.shortcuts?.floatingPosition;
    const requested = options.position || (
        Number.isFinite(Number(saved?.left)) && Number.isFinite(Number(saved?.top))
            ? { left: Number(saved.left), top: Number(saved.top) }
            : defaultFloatingPosition(button)
    );
    const next = clampFloatingPosition(requested.left, requested.top, button);
    button.style.left = `${Math.round(next.left)}px`;
    button.style.top = `${Math.round(next.top)}px`;
    button.style.right = 'auto';
    button.style.bottom = 'auto';
    if (options.persist) {
        const persistedLeft = Math.round(next.left);
        const persistedTop = Math.round(next.top);
        const unchanged = Number(saved?.left) === persistedLeft && Number(saved?.top) === persistedTop;
        state.shortcuts = state.shortcuts || {};
        state.shortcuts.floatingPosition = {
            left: persistedLeft,
            top: persistedTop,
        };
        if (!unchanged) persistHot(state);
    }
    return next;
}

function isFloatingButtonSuppressed() {
    return MODAL_IDS.some(id => document.getElementById(id)?.classList.contains('kf-show'));
}

function ensureFloatingButtonVisible(state, button = document.getElementById(FLOATING_BUTTON_ID)) {
    if (!button?.isConnected || isFloatingButtonSuppressed()) return null;
    const rect = button.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    const viewport = floatingViewportBounds();
    const viewportRight = viewport.left + viewport.width;
    const viewportBottom = viewport.top + viewport.height;
    const outside = rect.right <= viewport.left
        || rect.left >= viewportRight
        || rect.bottom <= viewport.top
        || rect.top >= viewportBottom;
    const saved = state.shortcuts?.floatingPosition;
    const requested = outside && Number.isFinite(Number(saved?.left)) && Number.isFinite(Number(saved?.top))
        ? { left: Number(saved.left), top: Number(saved.top) }
        : (outside ? defaultFloatingPosition(button) : { left: rect.left, top: rect.top });
    const next = clampFloatingPosition(requested.left, requested.top, button);
    const corrected = Math.abs(rect.left - next.left) > 0.5 || Math.abs(rect.top - next.top) > 0.5;
    return applyFloatingPosition(state, { position: next, persist: corrected });
}

function updateFloatingButton(state) {
    const button = document.getElementById(FLOATING_BUTTON_ID);
    if (!button) return;
    const action = normalizeFloatingAction(state.shortcuts?.floatingAction);
    const skin = normalizeFloatingSkin(state.shortcuts?.floatingSkin);
    const label = action === 'api'
        ? '点击指定下个请求 API；长按顺序切换当前锁定 API'
        : floatingActionLabel(action);
    if (button.dataset.skin !== skin) {
        button.dataset.skin = skin;
        button.innerHTML = floatingSkinVisual(skin);
    }
    button.dataset.action = action;
    button.dataset.enabled = state.enabled === false ? 'false' : 'true';
    button.dataset.mode = getActivePool(state)?.mode === 'random' ? 'random' : 'fixed';
    button.title = label;
    button.setAttribute('aria-label', label);
    setThemeVars(button, state.theme || {});
}

function activateFloatingButton(state, rerender, setStatus) {
    const action = normalizeFloatingAction(state.shortcuts?.floatingAction);
    if (action === 'mode') {
        const pool = getActivePool(state);
        setPoolMode(state, pool.mode === 'random' ? 'fixed' : 'random', rerender, setStatus);
    } else if (action === 'power') {
        toggleGlobalEnabled(state, setStatus);
    } else if (action === 'api') {
        openApiOverrideModal(state);
    } else if (action === 'panel') {
        openMainPanel(state);
    }
    updateFloatingButton(state);
}

function bindFloatingButton(button, state, rerender, setStatus) {
    if (!button || button.dataset.kfFloatingBound === 'true') return;
    button.dataset.kfFloatingBound = 'true';
    let drag = null;
    let lastTapAt = 0;

    const clearLongPress = () => {
        if (drag?.longPressTimer) window.clearTimeout(drag.longPressTimer);
        if (drag) drag.longPressTimer = null;
    };

    button.addEventListener('pointerdown', event => {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = button.getBoundingClientRect();
        drag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: rect.left,
            startTop: rect.top,
            moved: false,
            longPressed: false,
            longPressTimer: null,
        };
        if (normalizeFloatingAction(state.shortcuts?.floatingAction) === 'api') {
            const pointerId = event.pointerId;
            drag.longPressTimer = window.setTimeout(() => {
                if (!drag || drag.pointerId !== pointerId || drag.moved) return;
                drag.longPressTimer = null;
                drag.longPressed = true;
                cycleLockedApi(state, setStatus);
                updateFloatingButton(state);
            }, SHORTCUT_LONG_PRESS_MS);
        }
        button.setPointerCapture?.(event.pointerId);
    });
    button.addEventListener('pointermove', event => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (drag.longPressed) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        const deltaX = event.clientX - drag.startX;
        const deltaY = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(deltaX, deltaY) < FLOATING_DRAG_THRESHOLD) return;
        clearLongPress();
        drag.moved = true;
        button.classList.add('kf-dragging');
        applyFloatingPosition(state, {
            position: { left: drag.startLeft + deltaX, top: drag.startTop + deltaY },
        });
        event.preventDefault();
        event.stopPropagation();
    });
    const finishDrag = (event, persist) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const moved = drag.moved;
        const longPressed = drag.longPressed;
        clearLongPress();
        drag = null;
        button.classList.remove('kf-dragging');
        button.releasePointerCapture?.(event.pointerId);
        if (moved && persist) {
            const rect = button.getBoundingClientRect();
            applyFloatingPosition(state, { position: { left: rect.left, top: rect.top }, persist: true });
        } else if (!moved && !longPressed && persist) {
            event.preventDefault();
            event.stopPropagation();
            const now = Date.now();
            if (now - lastTapAt > 500) {
                lastTapAt = now;
                activateFloatingButton(state, rerender, setStatus);
            }
        }
    };
    button.addEventListener('pointerup', event => finishDrag(event, true));
    button.addEventListener('pointercancel', event => finishDrag(event, false));
    button.addEventListener('contextmenu', event => {
        if (normalizeFloatingAction(state.shortcuts?.floatingAction) !== 'api') return;
        event.preventDefault();
        event.stopPropagation();
    });
    button.addEventListener('dragstart', event => event.preventDefault());
    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.detail === 0) activateFloatingButton(state, rerender, setStatus);
    });
}

function teardownFloatingViewportListeners() {
    floatingViewportController?.abort?.();
    floatingViewportController = null;
    window.clearInterval(floatingVisibilityTimer);
    floatingVisibilityTimer = null;
    floatingModalObserver?.disconnect?.();
    floatingModalObserver = null;
    if (window.STKarmaFlip?.floatingCleanup === teardownFloatingViewportListeners) {
        delete window.STKarmaFlip.floatingCleanup;
    }
}

function bindFloatingViewportListeners(state) {
    if (!floatingViewportController) {
        window.STKarmaFlip?.floatingCleanup?.();
        floatingViewportController = new AbortController();
        const options = { passive: true, signal: floatingViewportController.signal };
        const reposition = () => ensureFloatingButtonVisible(state);
        window.addEventListener('resize', reposition, options);
        window.visualViewport?.addEventListener?.('resize', reposition, options);
        window.visualViewport?.addEventListener?.('scroll', reposition, options);
    }
    if (!floatingModalObserver) {
        floatingModalObserver = new MutationObserver(() => {
            const root = document.getElementById(FLOATING_ROOT_ID);
            if (!root) return;
            const suppressed = isFloatingButtonSuppressed();
            root.hidden = suppressed;
            root.setAttribute('aria-hidden', String(suppressed));
            if (!suppressed) window.requestAnimationFrame(() => ensureFloatingButtonVisible(state));
        });
        for (const id of MODAL_IDS) {
            const modal = document.getElementById(id);
            if (modal) floatingModalObserver.observe(modal, { attributes: true, attributeFilter: ['class'] });
        }
    }
    window.clearInterval(floatingVisibilityTimer);
    floatingVisibilityTimer = window.setInterval(() => ensureFloatingButtonVisible(state), 3000);
    window.STKarmaFlip = window.STKarmaFlip || {};
    window.STKarmaFlip.floatingCleanup = teardownFloatingViewportListeners;
}

function ensureFloatingButton(state, rerender, setStatus) {
    const action = normalizeFloatingAction(state.shortcuts?.floatingAction);
    if (action === 'none') {
        document.getElementById(FLOATING_ROOT_ID)?.remove();
        teardownFloatingViewportListeners();
        return;
    }
    let root = document.getElementById(FLOATING_ROOT_ID);
    if (!root) {
        root = document.createElement('div');
        root.id = FLOATING_ROOT_ID;
        root.className = 'kf-floating-root';
        document.body.appendChild(root);
    }
    let button = document.getElementById(FLOATING_BUTTON_ID);
    if (!button) {
        button = document.createElement('button');
        button.id = FLOATING_BUTTON_ID;
        button.className = 'kf-floating-button';
        button.type = 'button';
        button.draggable = false;
        root.appendChild(button);
    }
    bindFloatingButton(button, state, rerender, setStatus);
    bindFloatingViewportListeners(state);
    updateFloatingButton(state);
    applyFloatingPosition(state);
    const suppressed = isFloatingButtonSuppressed();
    root.hidden = suppressed;
    root.setAttribute('aria-hidden', String(suppressed));
    if (!suppressed) ensureFloatingButtonVisible(state, button);
}

function applyThemeVisual(theme = {}) {
    const root = document.getElementById('kf-root');
    if (!root) return;
    const targets = [root, ...MODAL_IDS.map(id => document.getElementById(id)), document.getElementById('kf-toast-layer'), document.getElementById(FLOATING_BUTTON_ID)].filter(Boolean);
    for (const target of targets) setThemeVars(target, theme);
}

function applyTheme(state) {
    const theme = state.theme || {};
    applyThemeVisual(theme);
    populateThemeControls(state);
    populateSettingsControls(state);
    updateChatShortcut(state);
}

function populateThemeControls(state) {
    const theme = state.theme || {};
    const primary = normalizeHex(theme.underline, '#1677ff');
    const secondary = normalizeHex(theme.bgMain, '#ffffff');
    const mode = theme.mode === 'dark' ? 'dark' : 'light';
    const requestedPreset = String(theme.preset || 'default');
    const presetConfig = THEME_PRESETS[requestedPreset];
    const preset = presetConfig
        && normalizeHex(presetConfig.primary, '') === primary
        && normalizeHex(presetConfig.secondary, '') === secondary
        ? requestedPreset
        : 'custom';
    setThemeColorControlValue('kf-theme-bg-main', secondary);
    $('#kf-theme-bg-sub').val(resolveThemePalette({ ...theme, bgMain: secondary, underline: primary, mode }).surfaceSoft);
    setThemeColorControlValue('kf-theme-underline', primary);
    $('#kf-theme-primary-hex').val(primary.toUpperCase());
    $('#kf-theme-secondary-hex').val(secondary.toUpperCase());
    $('#kf-theme-preset').val(preset);
    $('.kf-theme-preset').toggleClass('kf-active', false)
        .filter(function () { return String($(this).data('preset') || '') === preset; }).addClass('kf-active');
    $('.kf-theme-mode').toggleClass('kf-active', false)
        .filter(`[data-theme-mode="${mode}"]`).addClass('kf-active');
    $('.kf-theme-quick-btn').each(function () {
        const active = String($(this).data('themeMode') || '') === mode;
        $(this).toggleClass('kf-active', active).attr('aria-pressed', String(active));
    });
}

function readThemeDraftFromControls() {
    const primary = normalizeHex($('#kf-theme-underline').val(), '#1677ff');
    const secondary = normalizeHex($('#kf-theme-bg-main').val(), '#ffffff');
    const mode = String($('.kf-theme-mode.kf-active').data('themeMode') || 'light') === 'dark' ? 'dark' : 'light';
    const palette = resolveThemePalette({ underline: primary, bgMain: secondary, mode });
    return {
        bgMain: secondary,
        bgSub: palette.surfaceSoft,
        underline: primary,
        mode,
        preset: String($('#kf-theme-preset').val() || 'default'),
    };
}

function previewThemeFromControls() {
    const draft = readThemeDraftFromControls();
    $('#kf-theme-bg-sub').val(draft.bgSub);
    applyThemeVisual(draft);
}

function closeThemeModal(state) {
    closeModal('kf-theme-modal');
    populateThemeControls(state);
    applyTheme(state);
}

function populateSettingsControls(state) {
    $('#kf-failure-retry-count').val(Math.max(1, toInt(state.failure?.retryCount || 3)));
    $('#kf-failure-retry-delay').val(toInt(state.failure?.retryDelaySeconds ?? 3));
    $('#kf-failure-alert-enabled').prop('checked', !!state.failure?.alertEnabled);
    $('#kf-model-alert-enabled').prop('checked', !!state.failure?.modelAlertEnabled);
    $('#kf-shortcut-mode-enabled').prop('checked', state.shortcuts?.modeEnabled !== false);
    $('#kf-shortcut-power-enabled').prop('checked', state.shortcuts?.powerEnabled !== false);
    $('#kf-shortcut-api-enabled').prop('checked', state.shortcuts?.apiEnabled === true);
    $('#kf-floating-action').val(normalizeFloatingAction(state.shortcuts?.floatingAction));
    $('#kf-floating-skin').val(normalizeFloatingSkin(state.shortcuts?.floatingSkin));
    $('#kf-compact-api-entries').prop('checked', state.ui?.compactApiEntries === true);
}

function mkPool(name = null) {
    return {
        id: makeId('pool'),
        name: name || `新组合_${new Date().toLocaleTimeString()}`,
        mode: 'fixed',
        enabled: true,
        random: { noConsecutive: false },
        entries: [],
    };
}

function clonePool(pool) {
    const p = JSON.parse(JSON.stringify(pool));
    p.id = makeId('pool');
    p.name = `${pool.name}_副本`;
    p.entries = p.entries.map(e => ({ ...e, id: makeId('e') }));
    return p;
}

function cloneEntry(entry) {
    return {
        id: makeId('e'),
        presetId: '',
        enabled: entry?.enabled !== false,
        name: String(entry?.name || ''),
        apiUrl: String(entry?.apiUrl || entry?.url || ''),
        key: String(entry?.key || ''),
        provider: normalizeProvider(entry?.provider),
        model: String(entry?.model || ''),
        fixedRuns: Math.max(1, toInt(entry?.fixedRuns || 1)),
        weight: toInt(entry?.weight || 0),
        pityTurns: toInt(entry?.pityTurns || 0),
        cooldownTurns: toInt(entry?.cooldownTurns || 0),
        collapsed: !!entry?.collapsed,
        modelOptions: Array.isArray(entry?.modelOptions) ? entry.modelOptions.map(x => String(x)).filter(Boolean) : [],
        presetBinding: entry?.presetBinding ? JSON.parse(JSON.stringify(entry.presetBinding)) : null,
    };
}

function clonePoolForImport(pool) {
    const cloned = {
        id: makeId('pool'),
        name: String(pool?.name || `导入组合_${new Date().toLocaleTimeString()}`),
        mode: pool?.mode === 'random' ? 'random' : 'fixed',
        enabled: pool?.enabled !== false,
        random: { noConsecutive: !!pool?.random?.noConsecutive },
        entries: Array.isArray(pool?.entries) ? pool.entries.map(cloneEntry) : [],
    };
    if (!cloned.entries.length) addEntry(cloned);
    return cloned;
}

function addEntry(pool) {
    pool.entries.push({
        id: makeId('e'),
        enabled: true,
        name: '',
        apiUrl: '',
        key: '',
        provider: 'open',
        model: '',
        fixedRuns: 1,
        weight: 1,
        pityTurns: 0,
        cooldownTurns: 0,
        collapsed: false,
        modelOptions: [],
        presetBinding: null,
    });
}

function savedApiEntries(state) {
    const map = new Map();
    for (const preset of state.apiPresets || []) {
        const name = String(preset.name || '').trim();
        if (name && isMeaningfulApiEntry(preset) && !map.has(name)) map.set(name, preset);
    }
    for (const pool of state.pools || []) {
        for (const entry of pool.entries || []) {
            const name = String(entry.name || '').trim();
            if (name && isMeaningfulApiEntry(entry) && !map.has(name)) map.set(name, entry);
        }
    }
    return [...map.values()];
}

function findSavedApiEntry(state, name, excludeId) {
    const target = String(name || '').trim();
    if (!target) return null;
    for (const preset of state.apiPresets || []) {
        if (preset.id !== excludeId && String(preset.name || '').trim() === target) return preset;
    }
    for (const pool of state.pools || []) {
        for (const entry of pool.entries || []) {
            if (entry.id !== excludeId && String(entry.name || '').trim() === target) return entry;
        }
    }
    return null;
}

function renderPresetLists(state) {
    return state;
}

function isPlaceholderApiName(name) {
    return String(name || '').trim().toLowerCase() === 'new api';
}

function isMeaningfulApiEntry(entry) {
    if (!entry) return false;
    return [
        isPlaceholderApiName(entry.name) ? '' : entry.name,
        entry.apiUrl || entry.url,
        entry.key,
        entry.model,
    ].some(value => String(value || '').trim());
}

function sameApiIdentity(entry, target) {
    if (!entry || !target) return false;
    const targetId = String(target.id || '').trim();
    const targetPresetId = String(target.presetId || '').trim();
    const entryId = String(entry.id || '').trim();
    const entryPresetId = String(entry.presetId || '').trim();
    if (targetId && (entryId === targetId || entryPresetId === targetId)) return true;
    if (targetPresetId && (entryId === targetPresetId || entryPresetId === targetPresetId)) return true;

    const targetName = String(target.name || '').trim();
    const entryName = String(entry.name || '').trim();
    if (targetName && entryName && targetName === entryName) return true;

    const fields = ['apiUrl', 'key', 'model'];
    return fields.every(field => String(entry[field] || '').trim() === String(target[field] || '').trim())
        && fields.some(field => String(target[field] || '').trim());
}

function persistHot(state, delay = HOT_SAVE_DELAY) {
    if (!uiPersistenceReady) {
        saveState(state, { persist: false });
        return;
    }
    saveStateDebounced(state, delay);
}

function persistStructure(state) {
    persistHot(state, STRUCTURE_SAVE_DELAY);
}

function persistNow(state) {
    if (!uiPersistenceReady) {
        saveState(state, { persist: false });
        return;
    }
    saveState(state);
}

function getApiPresetNames(state) {
    return savedApiEntries(state).map(entry => entry.name).filter(Boolean);
}

function deleteSavedApiEntry(state, target) {
    if (!target) return false;
    const before = Array.isArray(state.apiPresets) ? state.apiPresets.length : 0;
    let removedEntries = 0;
    state.apiPresets = (state.apiPresets || []).filter(preset => !sameApiIdentity(preset, target));
    for (const pool of state.pools || []) {
        const entries = Array.isArray(pool.entries) ? pool.entries : [];
        pool.entries = entries.filter(entry => {
            const keep = !sameApiIdentity(entry, target);
            if (!keep) removedEntries += 1;
            return keep;
        });
    }
    return state.apiPresets.length !== before || removedEntries > 0;
}

function getModelOptions(entry) {
    const values = new Set();
    if (entry.model) values.add(entry.model);
    for (const model of entry.modelOptions || []) values.add(model);
    return [...values].sort((a, b) => a.localeCompare(b));
}

function applyEntryPreset(target, preset) {
    if (!preset) return;
    target.presetId = preset.id || target.presetId || '';
    target.enabled = preset.enabled !== false;
    target.name = preset.name || target.name;
    target.apiUrl = preset.apiUrl || '';
    target.key = preset.key || '';
    target.provider = normalizeProvider(preset.provider);
    target.model = preset.model || '';
    target.modelOptions = Array.isArray(preset.modelOptions) ? [...preset.modelOptions] : [];
}

function copyEntryForPreset(entry) {
    return {
        id: makeId('preset'),
        presetId: '',
        enabled: entry.enabled !== false,
        name: String(entry.name || ''),
        apiUrl: String(entry.apiUrl || ''),
        key: String(entry.key || ''),
        provider: normalizeProvider(entry.provider),
        model: String(entry.model || ''),
    };
}

function copyPresetForImport(entry) {
    return copyEntryForPreset({
        enabled: entry?.enabled !== false,
        name: String(entry?.name || ''),
        apiUrl: String(entry?.apiUrl || entry?.url || ''),
        key: String(entry?.key || ''),
        provider: normalizeProvider(entry?.provider),
        model: String(entry?.model || ''),
        modelOptions: Array.isArray(entry?.modelOptions) ? entry.modelOptions.map(x => String(x)).filter(Boolean) : [],
    });
}

function saveApiPreset(state, entry) {
    if (!isMeaningfulApiEntry(entry)) return;
    if (!Array.isArray(state.apiPresets)) state.apiPresets = [];
    const name = isPlaceholderApiName(entry.name) ? '' : String(entry.name || '').trim();
    const previousName = String(entry._previousPresetName || '').trim();
    const preset = copyEntryForPreset({ ...entry, name });
    const presetId = String(entry.presetId || '').trim();
    let index = presetId ? state.apiPresets.findIndex(item => item.id === presetId) : -1;
    if (index < 0) index = state.apiPresets.findIndex(item => item.id === entry.id);
    if (index < 0 && previousName) index = state.apiPresets.findIndex(item => String(item.name || '').trim() === previousName);
    if (index < 0) index = state.apiPresets.findIndex(item => String(item.name || '').trim() === name);
    if (index >= 0) {
        preset.id = state.apiPresets[index].id || preset.id;
        preset.modelOptions = Array.isArray(entry.modelOptions)
            ? entry.modelOptions.map(x => String(x)).filter(Boolean)
            : (Array.isArray(state.apiPresets[index].modelOptions) ? [...state.apiPresets[index].modelOptions] : []);
        state.apiPresets[index] = preset;
    } else {
        if (Array.isArray(entry.modelOptions)) preset.modelOptions = entry.modelOptions.map(x => String(x)).filter(Boolean);
        state.apiPresets.push(preset);
    }
    entry.presetId = preset.id;
    delete entry._previousPresetName;
}

function saveApiPresetIfNamed(state, entry) {
    if (isMeaningfulApiEntry(entry)) saveApiPreset(state, entry);
}

function renderPool(state) {
    const pool = getActivePool(state);
    $('#kf-pool-picker-display').val(pool.name);
    $('#kf-pool-picker').show();
    updateModeState(state);
    updateGlobalToggleState(state);
    updateChatShortcut(state);
}

function providerSelect(entry) {
    const options = [
        ['open', 'OpenAI', 'OpenAI 兼容'],
        ['gemini', 'Gemini', 'Gemini 官方'],
        ['claude', 'Claude', 'Claude 官方'],
    ];
    const provider = normalizeProvider(entry.provider);
    const selectedOption = options.find(([value]) => value === provider) || options[0];
    const selected = selectedOption[1];
    const accessibleLabel = selectedOption[2];
    return `
        <div class="kf-select-wrapper kf-provider-wrapper kf-two-strokes kf-accent-fill kf-entry-side-control">
            <button type="button" class="kf-inner-select kf-entry-provider-display" data-provider="${esc(provider)}" aria-label="接口：${esc(accessibleLabel)}" title="${esc(accessibleLabel)}">
                <span class="kf-provider-label">${esc(selected)}</span>
                <svg class="kf-provider-caret" aria-hidden="true"><use href="#kf-i-chevron"/></svg>
            </button>
        </div>
    `;
}

function providerOptions() {
    return [
        { value: 'open', label: 'OpenAI' },
        { value: 'gemini', label: 'Gemini' },
        { value: 'claude', label: 'Claude' },
    ];
}

function fanIcon(expanded) {
    const svgProps = 'class="kf-fan-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
    return expanded
        ? `<svg ${svgProps}>
            <line x1="16" y1="17" x2="19" y2="4"/>
            <line x1="16" y1="17" x2="4" y2="12"/>
            <polyline points="4,12 7,8 11,5 15,3.5 19,4"/>
            <line x1="16" y1="17" x2="7" y2="8"/>
            <line x1="16" y1="17" x2="11" y2="5"/>
            <line x1="16" y1="17" x2="15" y2="3.5"/>
            <circle cx="16" cy="17" r="1" fill="currentColor" stroke="none"/>
        </svg>`
        : `<svg ${svgProps}>
            <!-- 这里是合拢扇子的代码 -->
            <path d="M 15.5 16.5 L 6 5 L 9 3 L 17.5 14.5 Z"/>
            <line x1="7.5" y1="4" x2="16.5" y2="15.5"/>
            <circle cx="16.5" cy="15.5" r="1" fill="currentColor" stroke="none"/>
            <!-- 顺滑版流苏 (顺着扇身的倾斜角度往右下方延伸) -->
            <line x1="16.5" y1="15.5" x2="18" y2="17.5"/>
            <circle cx="18" cy="18" r="0.8"/>
            <line x1="18.5" y1="19" x2="18.5" y2="22"/>
            <line x1="17.5" y1="20" x2="21" y2="20.5"/>
        </svg>`;
}

function updateEntryCollapsedRow(row, collapsed) {
    const isCollapsed = !!collapsed;
    row.toggleClass('kf-collapsed', isCollapsed);
    const button = row.find('.kf-collapse');
    if (!button.length) return;
    const label = isCollapsed ? '展开连接信息' : '折叠连接信息';
    button.attr('aria-label', label);
    button.attr('title', label);
    button.html(fanIcon(!isCollapsed));
}

function trashIcon() {
    return '<svg class="kf-trash-icon" aria-hidden="true"><use href="#kf-i-trash"/></svg>';
}

function renderEntries(state) {
    const pool = getActivePool(state);
    const root = $('#kf-entry-list').empty();
    const apiPresetNames = getApiPresetNames(state);
    const compact = state.ui?.compactApiEntries === true && !apiEntriesEditorOpen;
    $('#kf-api-entries-block').toggleClass('kf-api-entries-modal-open', apiEntriesEditorOpen);
    $('#kf-main-modal').toggleClass('kf-api-entries-open', apiEntriesEditorOpen);

    for (const entry of pool.entries || []) {
        const enabledChecked = entry.enabled !== false ? 'checked' : '';
        const nameHasOptions = apiPresetNames.some(name => name !== entry.name);
        const nameArrow = nameHasOptions ? '<button class="kf-dropdown-arrow kf-entry-name-arrow" type="button" aria-label="选择 API 名称"><svg><use href="#kf-i-chevron"/></svg></button>' : '';
        if (compact) {
            root.append(`
                <div class="kf-entry-block kf-compact-entry" data-id="${esc(entry.id)}">
                    <div class="kf-row kf-entry-row-top">
                        <label class="kf-toggle-chip kf-entry-enabled-wrap">
                            <input type="checkbox" class="kf-entry-enabled" ${enabledChecked}>
                            <span class="kf-check-box"></span>
                            <span class="kf-check-text kf-accent-fill">启用</span>
                        </label>
                        <div class="kf-input-wrapper kf-entry-name-wrap"><span class="kf-label">名称</span><input type="text" class="kf-inner-input kf-dropdown-input kf-entry-name" value="${esc(entry.name)}" placeholder="API 名称">${nameArrow}</div>
                        <div class="kf-entry-actions">
                            <button class="kf-icon-btn kf-entry-window" type="button" aria-label="打开完整 API 条目" title="打开完整 API 条目">${entryWindowIcon()}</button>
                            <button class="kf-icon-btn kf-del" type="button" aria-label="删除 API 条目" title="删除 API 条目">${trashIcon()}</button>
                        </div>
                    </div>
                </div>
            `);
            continue;
        }
        const collapsed = !!entry.collapsed;
        const forceExpanded = apiEntriesEditorOpen
            && collapsed
            && apiEntriesForcedExpandedIds.has(String(entry.id || ''));
        const visualCollapsed = collapsed && !forceExpanded;
        const collapsedClass = visualCollapsed ? ' kf-collapsed' : '';
        const preserveCollapsed = forceExpanded ? ' data-preserve-collapsed="true"' : '';
        const collapseIcon = fanIcon(!visualCollapsed);
        const collapseLabel = visualCollapsed ? '展开连接信息' : '折叠连接信息';
        const modelHasOptions = getModelOptions(entry).some(model => model !== entry.model);
        const modelArrow = modelHasOptions ? '<button class="kf-dropdown-arrow kf-entry-model-arrow" type="button" aria-label="选择模型"><svg><use href="#kf-i-chevron"/></svg></button>' : '';
        const urlPlaceholder = providerUrlPlaceholder(entry.provider);
        root.append(`
            <div class="kf-entry-block${collapsedClass}" data-id="${esc(entry.id)}"${preserveCollapsed}>
                <div class="kf-row kf-entry-row-top">
                    <label class="kf-toggle-chip kf-entry-enabled-wrap">
                        <input type="checkbox" class="kf-entry-enabled" ${enabledChecked}>
                        <span class="kf-check-box"></span>
                        <span class="kf-check-text kf-accent-fill">启用</span>
                    </label>
                    <div class="kf-input-wrapper kf-entry-name-wrap"><span class="kf-label">名称</span><input type="text" class="kf-inner-input kf-dropdown-input kf-entry-name" value="${esc(entry.name)}" placeholder="API 名称">${nameArrow}</div>
                    <div class="kf-entry-actions">
                        <button class="kf-icon-btn kf-collapse" type="button" aria-label="${collapseLabel}" title="${collapseLabel}">${collapseIcon}</button>
                        <button class="kf-icon-btn kf-del" type="button" aria-label="删除 API 条目" title="删除 API 条目">${trashIcon()}</button>
                    </div>
                </div>
                <div class="kf-row kf-entry-details kf-entry-secret-details">
                    <div class="kf-input-wrapper kf-flex-1"><span class="kf-label">URL</span><input type="text" class="kf-inner-input kf-entry-url" value="${esc(entry.apiUrl)}" placeholder="${esc(urlPlaceholder)}"></div>
                </div>
                <div class="kf-row kf-entry-details kf-entry-secret-details kf-entry-side-row">
                    <div class="kf-input-wrapper kf-flex-1 kf-entry-key-wrap">
                        <span class="kf-label">KEY</span>
                        <input type="text" class="kf-inner-input kf-entry-key kf-key-masked" value="${esc(entry.key)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="latin" enterkeyhint="done" lang="en">
                        <button class="kf-eye-btn kf-key-eye" type="button" aria-label="显示 KEY" title="显示 KEY">
                            <svg><use href="#kf-i-eye"/></svg>
                        </button>
                    </div>
                    ${providerSelect(entry)}
                </div>
                <div class="kf-row kf-entry-details kf-entry-side-row">
                    <div class="kf-input-wrapper kf-flex-1"><span class="kf-label">模型</span><input type="text" class="kf-inner-input kf-dropdown-input kf-entry-model" value="${esc(entry.model)}">${modelArrow}</div>
                    <div class="kf-entry-model-actions kf-entry-side-control">
                        <button class="kf-icon-btn kf-fetch-models" type="button" aria-label="拉取模型" title="拉取模型"><svg><use href="#kf-i-refresh"/></svg></button>
                        <button class="kf-icon-btn kf-entry-preset-settings${entry.presetBinding?.presetName ? ' kf-bound' : ''}" type="button" aria-label="预设设置" title="${entry.presetBinding?.presetName ? `已绑定：${esc(entry.presetBinding.presetName)}` : '预设设置'}"><i class="fa-solid fa-sliders" aria-hidden="true"></i></button>
                    </div>
                </div>
                <div class="kf-row kf-fixed-only kf-entry-details">
                    <div class="kf-input-wrapper kf-flex-1"><span class="kf-label">运行次数</span><input type="number" min="1" class="kf-inner-input kf-entry-fixed-runs" value="${esc(entry.fixedRuns || 1)}"></div>
                </div>
                <div class="kf-row kf-random-only kf-entry-details">
                    <div class="kf-input-wrapper kf-flex-1"><span class="kf-label">权重</span><input type="number" min="0" class="kf-inner-input kf-entry-weight" value="${esc(entry.weight)}"></div>
                    <div class="kf-input-wrapper kf-flex-1"><span class="kf-label">保底</span><input type="number" min="0" class="kf-inner-input kf-entry-pity" value="${esc(entry.pityTurns)}"></div>
                    <div class="kf-input-wrapper kf-flex-1"><span class="kf-label">冷却</span><input type="number" min="0" class="kf-inner-input kf-entry-cooldown" value="${esc(entry.cooldownTurns)}"></div>
                </div>
            </div>
        `);
    }
}

function logKind(log) {
    const event = String(log.event || '');
    if (event === 'pick') return 'pick';
    if (log.success === false || event.includes('error')) return 'error';
    return 'success';
}

function logTimeParts(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return { full: String(value || ''), clock: String(value || '') };
    const pad = value => String(value).padStart(2, '0');
    const day = [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
    ].join('-');
    const clock = [pad(date.getHours()), pad(date.getMinutes())].join(':');
    return { full: `${day} ${clock}`, clock };
}

function entryWindowIcon() {
    return '<svg aria-hidden="true"><use href="#kf-i-external"/></svg>';
}

function createLogSummary(log, kind) {
    const summary = document.createElement('div');
    summary.className = 'kf-log-summary';

    const badge = document.createElement('span');
    badge.className = `kf-log-badge kf-${kind}`;
    badge.textContent = kind === 'pick' ? '抽选' : (kind === 'error' ? '报错' : '成功');

    const api = document.createElement('span');
    api.className = 'kf-log-api-name';
    const model = document.createElement('span');
    model.className = 'kf-log-model';
    const apiName = String(log.apiName || '').trim();
    const modelName = String(log.model || '').trim();
    api.textContent = apiName || '未命名 API';
    api.title = api.textContent;
    model.textContent = modelName || '未填模型';
    model.title = model.textContent;

    const time = document.createElement('span');
    time.className = 'kf-log-time';
    const timeParts = logTimeParts(log.time);
    time.textContent = timeParts.full;

    const floor = document.createElement('span');
    floor.className = 'kf-log-floor';
    floor.textContent = log.messageId !== undefined && Number.isInteger(Number(log.messageId))
        ? `#${Number(log.messageId)}`
        : (log.status ? `HTTP ${log.status}` : '');
    summary.append(badge, api, model, time, floor);
    return summary;
}

function createLogRow(log) {
    const kind = logKind(log);
    const row = document.createElement('article');
    row.className = 'kf-log-row';
    row.dataset.kind = kind;
    row.appendChild(createLogSummary(log, kind));
    if (kind !== 'error') return row;

    const detail = document.createElement('div');
    detail.className = 'kf-log-detail';
    const apiUrl = String(log.apiUrl || '').trim();
    if (apiUrl) appendCopyableLogText(detail, `URL: ${apiUrl}`);
    const responseDetail = String(log.responseBody ?? log.error ?? log.detail ?? '');
    if (responseDetail) {
        if (apiUrl) detail.appendChild(document.createTextNode('\n'));
        appendCopyableLogText(detail, responseDetail);
    }
    if (detail.childNodes.length) row.appendChild(detail);
    return row;
}

function createUsageStatRow(stat) {
    const row = document.createElement('article');
    row.className = 'kf-log-api-stat';
    const head = document.createElement('div');
    head.className = 'kf-log-api-stat-head';
    const main = document.createElement('div');
    main.className = 'kf-log-api-stat-main';
    const name = document.createElement('div');
    name.className = 'kf-log-stat-api-name';
    name.textContent = stat.apiName || '未命名';
    main.append(name);
    const total = document.createElement('div');
    total.className = 'kf-log-api-total';
    total.textContent = `共 ${stat.count || 0} 次`;
    head.append(main, total);

    const models = document.createElement('div');
    models.className = 'kf-log-model-stats';
    for (const item of stat.models || []) {
        const modelRow = document.createElement('div');
        modelRow.className = 'kf-log-model-stat-row';
        const model = document.createElement('span');
        model.className = 'kf-log-stat-model';
        model.textContent = item.model || '未填模型';
        model.title = model.textContent;
        const count = document.createElement('span');
        count.className = 'kf-log-stat-count';
        count.textContent = `${item.count || 0} 次`;
        modelRow.append(model, count);
        models.appendChild(modelRow);
    }
    row.append(head, models);
    return row;
}

function groupUsageStats(stats) {
    const groups = new Map();
    for (const stat of stats || []) {
        const apiName = stat.apiName || '未命名';
        const apiUrl = stat.apiUrl || '';
        const key = `${apiName}||${apiUrl}`;
        if (!groups.has(key)) groups.set(key, { apiName, apiUrl, count: 0, lastTime: '', models: [] });
        const group = groups.get(key);
        group.count += Number(stat.count || 0);
        if (String(stat.lastTime || '') > group.lastTime) group.lastTime = String(stat.lastTime || '');
        group.models.push({ model: stat.model, count: Number(stat.count || 0), lastTime: stat.lastTime });
    }
    return [...groups.values()]
        .map(group => ({
            ...group,
            models: group.models.sort((a, b) => b.count - a.count || String(b.lastTime || '').localeCompare(String(a.lastTime || ''))),
        }))
        .sort((a, b) => b.count - a.count || String(b.lastTime || '').localeCompare(String(a.lastTime || '')));
}

function splitLogUrl(rawUrl) {
    let url = String(rawUrl || '').replace(/[.,;!?，。；：！？、]+$/u, '');
    const bracketPairs = [['(', ')'], ['[', ']'], ['{', '}']];
    for (const [open, close] of bracketPairs) {
        while (url.endsWith(close) && url.split(close).length > url.split(open).length) {
            url = url.slice(0, -1);
        }
    }
    return { url, trailing: String(rawUrl || '').slice(url.length) };
}

function appendCopyableLogText(target, text) {
    const value = String(text || '');
    let cursor = 0;
    LOG_URL_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(LOG_URL_PATTERN)) {
        const rawUrl = match[0];
        const { url, trailing } = splitLogUrl(rawUrl);
        target.appendChild(document.createTextNode(value.slice(cursor, match.index)));
        let valid = false;
        try {
            valid = ['http:', 'https:'].includes(new URL(url).protocol);
        } catch {
            valid = false;
        }
        if (valid) {
            const link = document.createElement('span');
            link.className = 'kf-log-copy-url';
            link.dataset.url = url;
            link.tabIndex = 0;
            link.setAttribute('role', 'button');
            link.setAttribute('title', '点击复制 URL');
            link.textContent = url;
            target.appendChild(link);
            target.appendChild(document.createTextNode(trailing));
        } else {
            target.appendChild(document.createTextNode(rawUrl));
        }
        cursor = match.index + rawUrl.length;
    }
    target.appendChild(document.createTextNode(value.slice(cursor)));
}

async function copyTextToClipboard(text) {
    const value = String(text || '');
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
            return;
        }
    } catch {
        // Clipboard API may be unavailable in some WebView contexts; use the legacy fallback below.
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try {
        copied = document.execCommand('copy');
    } finally {
        textarea.remove();
    }
    if (!copied) throw new Error('copy failed');
}

function currentLogFilter() {
    return $('.kf-log-filter.kf-active').data('filter') || 'all';
}

function renderLogs(state, filter = currentLogFilter()) {
    const source = loadState();
    const titles = {
        all: ['全部日志', '按时间倒序'],
        error: ['报错', 'API 返回的原始信息'],
        pick: ['抽选记录', '按时间倒序'],
        stats: ['次数统计', '记录API与模型的成功请求次数'],
    };
    const resolvedFilter = ['all', 'error', 'pick', 'stats'].includes(filter) ? filter : 'all';
    const [title, meta] = titles[resolvedFilter];
    $('#kf-log-panel-title').text(title);
    $('#kf-log-panel-meta').text(meta);
    const logBox = $('#kf-logs-list').empty();
    const node = logBox.get(0);
    if (!node) return;
    const fragment = document.createDocumentFragment();

    if (resolvedFilter === 'stats') {
        groupUsageStats(getUsageStats()).slice(0, 50).forEach(stat => fragment.appendChild(createUsageStatRow(stat)));
    } else {
        const logs = [...(source.logs || [])].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
        const filtered = logs.filter(log => {
            if (resolvedFilter === 'error') return logKind(log) === 'error';
            if (resolvedFilter === 'pick') return log.event === 'pick';
            return String(log.event || '') !== 'stats';
        });
        filtered.slice(0, 50).forEach(log => fragment.appendChild(createLogRow(log)));
    }
    node.appendChild(fragment);
    nextFrame(() => { node.scrollTop = 0; });
}

function syncEntryFromRow(entry, row, state) {
    const previousName = String(entry.name || '').trim();
    entry.enabled = row.find('.kf-entry-enabled').prop('checked');
    entry.name = String(row.find('.kf-entry-name').val() || '');
    if (!entry.presetId && previousName && previousName !== String(entry.name || '').trim()) entry._previousPresetName = previousName;
    if (row.hasClass('kf-compact-entry')) return;
    entry.provider = normalizeProvider(row.find('.kf-entry-provider-display').data('provider'));
    entry.apiUrl = String(row.find('.kf-entry-url').val() || '');
    entry.key = String(row.find('.kf-entry-key').val() || '');
    entry.model = String(row.find('.kf-entry-model').val() || '');
    entry.fixedRuns = Math.max(1, toInt(row.find('.kf-entry-fixed-runs').val() || 1));
    entry.weight = toInt(row.find('.kf-entry-weight').val());
    entry.pityTurns = toInt(row.find('.kf-entry-pity').val());
    entry.cooldownTurns = toInt(row.find('.kf-entry-cooldown').val());
    reconcileMemberCooldown(state, entry.id, entry.cooldownTurns);
    if (row.attr('data-preserve-collapsed') !== 'true') entry.collapsed = row.hasClass('kf-collapsed');
}

function setKeyMaskState(input, masked) {
    const keyInput = $(input);
    keyInput.toggleClass('kf-key-masked', !!masked);
    const button = keyInput.closest('.kf-input-wrapper').find('.kf-key-eye');
    button.attr('aria-label', masked ? '显示 KEY' : '隐藏 KEY');
    button.attr('title', masked ? '显示 KEY' : '隐藏 KEY');
    button.html(`<svg aria-hidden="true"><use href="#kf-i-${masked ? 'eye' : 'eye-off'}"/></svg>`);
}

function rememberMainPanelBaseHeight() {
    window.setTimeout(() => {
        const box = document.querySelector('#kf-main-modal .kf-main-box');
        if (!box) return;
        const height = Math.round(box.getBoundingClientRect().height);
        if (height > 0) mainPanelBaseHeight = height;
    }, 0);
}

function resetMainPanelKeyboardLock() {
    if (keyboardEditReleaseTimer) {
        window.clearTimeout(keyboardEditReleaseTimer);
        keyboardEditReleaseTimer = null;
    }
    mainPanelBaseHeight = 0;
    const box = document.querySelector('#kf-main-modal .kf-main-box');
    if (!box) return;
    box.style.removeProperty('--kf-keyboard-lock-height');
    box.classList.remove('kf-keyboard-editing');
}

function lockMainPanelForKeyboard() {
    if (keyboardEditReleaseTimer) {
        window.clearTimeout(keyboardEditReleaseTimer);
        keyboardEditReleaseTimer = null;
    }
    const box = document.querySelector('#kf-main-modal .kf-main-box');
    if (!box) return;
    const currentHeight = Math.round(box.getBoundingClientRect().height);
    if (!mainPanelBaseHeight && currentHeight > 0) mainPanelBaseHeight = currentHeight;
    const lockedHeight = Math.max(mainPanelBaseHeight || currentHeight || 0, currentHeight || 0);
    if (lockedHeight > 0) {
        box.style.setProperty('--kf-keyboard-lock-height', `${lockedHeight}px`);
        box.classList.add('kf-keyboard-editing');
    }
}

function releaseMainPanelKeyboardLockSoon() {
    if (keyboardEditReleaseTimer) window.clearTimeout(keyboardEditReleaseTimer);
    keyboardEditReleaseTimer = window.setTimeout(() => {
        const active = document.activeElement;
        if (active?.closest?.('#kf-main-modal input, #kf-main-modal textarea, #kf-main-modal select')) return;
        const box = document.querySelector('#kf-main-modal .kf-main-box');
        if (box) {
            box.style.removeProperty('--kf-keyboard-lock-height');
            box.classList.remove('kf-keyboard-editing');
        }
        keyboardEditReleaseTimer = null;
        rememberMainPanelBaseHeight();
    }, 260);
}

function scrollEntryIntoKeyboardView(input) {
    const entry = input?.closest?.('.kf-entry-block') || input;
    const scroller = document.getElementById('kf-entry-list');
    if (!entry || !scroller) return;
    window.setTimeout(() => {
        const entryRect = entry.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        if (!entryRect.height || !scrollerRect.height) return;
        const entryCenter = entryRect.top + entryRect.height / 2;
        const targetCenter = scrollerRect.top + scrollerRect.height * 0.5;
        scroller.scrollTo({
            top: scroller.scrollTop + entryCenter - targetCenter,
            behavior: 'smooth',
        });
    }, 320);
}

function syncAllEntries(state) {
    const pool = getActivePool(state);
    $('#kf-entry-list .kf-entry-block').each(function () {
        const id = $(this).data('id');
        const entry = pool.entries.find(e => e.id === id);
        if (entry) syncEntryFromRow(entry, $(this), state);
    });
}

function syncPoolFromControls(state) {
    const pool = getActivePool(state);
    const nextName = String($('#kf-pool-picker-display').val() || '').trim();
    if (nextName) pool.name = nextName;
    pool.mode = $('#kf-mode-random').prop('checked') ? 'random' : 'fixed';
    pool.random.noConsecutive = $('#kf-no-streak').prop('checked');
    return pool;
}

function syncThemeFromControls(state) {
    const draft = readThemeDraftFromControls();
    state.theme.bgMain = draft.bgMain;
    state.theme.bgSub = draft.bgSub;
    state.theme.underline = draft.underline;
    state.theme.mode = draft.mode;
    delete state.theme.brush;
    state.theme.preset = draft.preset;
}

function readFailureSettingsDraft() {
    return {
        retryCount: Math.max(1, toInt($('#kf-failure-retry-count').val() || 3)),
        retryDelaySeconds: toInt($('#kf-failure-retry-delay').val() ?? 3),
        alertEnabled: $('#kf-failure-alert-enabled').prop('checked'),
        modelAlertEnabled: $('#kf-model-alert-enabled').prop('checked'),
        compactApiEntries: $('#kf-compact-api-entries').prop('checked'),
        shortcuts: {
            modeEnabled: $('#kf-shortcut-mode-enabled').prop('checked'),
            powerEnabled: $('#kf-shortcut-power-enabled').prop('checked'),
            apiEnabled: $('#kf-shortcut-api-enabled').prop('checked'),
            floatingAction: normalizeFloatingAction($('#kf-floating-action').val()),
            floatingSkin: normalizeFloatingSkin($('#kf-floating-skin').val()),
        },
    };
}

function sameFailureSettings(state, draft) {
    return Math.max(1, toInt(state.failure?.retryCount || 3)) === draft.retryCount
        && toInt(state.failure?.retryDelaySeconds ?? 3) === draft.retryDelaySeconds
        && !!state.failure?.alertEnabled === draft.alertEnabled
        && !!state.failure?.modelAlertEnabled === draft.modelAlertEnabled
        && (state.ui?.compactApiEntries === true) === draft.compactApiEntries
        && (state.shortcuts?.modeEnabled !== false) === draft.shortcuts.modeEnabled
        && (state.shortcuts?.powerEnabled !== false) === draft.shortcuts.powerEnabled
        && (state.shortcuts?.apiEnabled === true) === draft.shortcuts.apiEnabled
        && normalizeFloatingAction(state.shortcuts?.floatingAction) === draft.shortcuts.floatingAction
        && normalizeFloatingSkin(state.shortcuts?.floatingSkin) === draft.shortcuts.floatingSkin;
}

function applyFailureSettingsDraft(state, draft) {
    state.failure.retryCount = draft.retryCount;
    state.failure.retryDelaySeconds = draft.retryDelaySeconds;
    state.failure.alertEnabled = draft.alertEnabled;
    state.failure.modelAlertEnabled = draft.modelAlertEnabled;
    state.ui = state.ui || {};
    state.ui.compactApiEntries = draft.compactApiEntries;
    state.shortcuts = state.shortcuts || {};
    state.shortcuts.modeEnabled = draft.shortcuts.modeEnabled;
    state.shortcuts.powerEnabled = draft.shortcuts.powerEnabled;
    state.shortcuts.apiEnabled = draft.shortcuts.apiEnabled;
    state.shortcuts.floatingAction = draft.shortcuts.floatingAction;
    state.shortcuts.floatingSkin = draft.shortcuts.floatingSkin;
}

function syncAllFromControls(state) {
    syncPoolFromControls(state);
    syncAllEntries(state);
}

function syncActivePoolPresets(state) {
    const pool = getActivePool(state);
    for (const entry of pool.entries || []) saveApiPresetIfNamed(state, entry);
}

function saveThemeFromModal(state, setStatus) {
    syncThemeFromControls(state);
    applyTheme(state);
    persistNow(state);
    closeModal('kf-theme-modal');
    setStatus('美化设置已保存');
}

function saveFailureSettingsFromModal(state, rerender, setStatus) {
    const draft = readFailureSettingsDraft();
    const unchanged = sameFailureSettings(state, draft);
    const compactChanged = (state.ui?.compactApiEntries === true) !== draft.compactApiEntries;
    applyFailureSettingsDraft(state, draft);
    if (toInt(state.failure?.retryDelaySeconds) === 0) {
        showToast('间隔次数过短可能会触发上限，请注意', 'warning', 3600);
    }
    if (!unchanged) {
        if (state.shortcuts?.modeEnabled === false && state.shortcuts?.powerEnabled === false && state.shortcuts?.apiEnabled !== true) updateChatShortcut(state);
        else ensureChatShortcut(state, rerender, setStatus);
        persistNow(state);
    } else {
        scheduleShortcutArtifactCleanup();
    }
    ensureFloatingButton(state, rerender, setStatus);
    if (compactChanged) rerender();
    closeModal('kf-settings-modal');
    setStatus(unchanged ? '请求设置未变更' : '请求设置已保存');
}

function entryReady(entry, mode) {
    return entry &&
        entry.enabled !== false &&
        String(entry.apiUrl || '').trim() &&
        String(entry.model || '').trim() &&
        (mode !== 'random' || toInt(entry.weight) > 0);
}

function sequenceLabel(entry) {
    const name = String(entry?.name || '未命名').trim();
    const model = String(entry?.model || '未填模型').trim();
    return `[${name}] [${model}]`;
}

function openSequenceModal(summary, rows) {
    $('#kf-sequence-summary').text(summary || '');
    const list = $('#kf-sequence-list').empty();
    for (const row of rows || []) {
        $('<div class="kf-sequence-item"></div>').text(row).appendTo(list);
    }
    $('#kf-sequence-modal').addClass('kf-show');
}

function showSequenceCheck(state) {
    if (state.enabled === false) {
        openSequenceModal('插件暂未开启，开启后显示api顺序', []);
        return;
    }
    syncAllEntries(state);
    const pool = getActivePool(state);
    pool.random = { ...(pool.random || {}), noConsecutive: $('#kf-no-streak').prop('checked') };
    const runtime = getRuntimeScope(state);
    const mode = pool.mode === 'random' ? 'random' : 'fixed';
    const entries = (pool.entries || []).filter(entry => entryReady(entry, mode) && !runtime.disabledByFailure?.[entry.id]);
    const summary = `${mode === 'random' ? '随机模式' : '固定模式'} ${pool.random?.noConsecutive ? '已勾选连续' : '未勾选连续'}`;
    if (!entries.length) {
        openSequenceModal(summary, ['当前组合没有可用于检测的 API 条目']);
        return;
    }
    if (mode === 'fixed') {
        const sequence = buildFixedSequence(entries, !!pool.random?.noConsecutive);
        const cursor = sequence.length ? toInt(runtime.fixedCursor) % sequence.length : 0;
        const preview = sequence.slice(cursor).concat(sequence.slice(0, cursor));
        openSequenceModal(summary, preview.map((entry, index) => `${index + 1}. ${sequenceLabel(entry)}`));
        return;
    }
    const lastIdentity = runtime.lastPick?.identity || (runtime.lastPick?.memberId ? `entry:${runtime.lastPick.memberId}` : '');
    const active = entries;
    if (!active.length) {
        openSequenceModal(summary, ['当前可用条目已被失败流程临时停用']);
        return;
    }
    const noConsecutiveBlocked = new Set();
    let candidates = active.filter(entry => {
        const blocked = pool.random?.noConsecutive && lastIdentity === memberIdentity(entry) && active.length > 1;
        if (blocked) noConsecutiveBlocked.add(entry.id);
        return !blocked;
    });
    if (!candidates.length) candidates = active;
    let cooldownCandidates = candidates.filter(entry => toInt(runtime.cooldowns?.[entry.id]) <= 0);
    if (!cooldownCandidates.length) cooldownCandidates = candidates;
    const candidateIds = new Set(candidates.map(entry => entry.id));
    const usableIds = new Set(cooldownCandidates.map(entry => entry.id));
    const usable = cooldownCandidates.length ? cooldownCandidates : active;
    const total = usable.reduce((sum, entry) => sum + toInt(entry.weight), 0);
    const rows = active.map(entry => {
        if (noConsecutiveBlocked.has(entry.id)) return `${sequenceLabel(entry)} 详情：因避免连续设置，本轮不参与`;
        const cooldown = toInt(runtime.cooldowns?.[entry.id]);
        if (cooldown > 0 && candidateIds.has(entry.id) && !usableIds.has(entry.id)) return `${sequenceLabel(entry)} 冷却中 详情：冷却还剩 ${cooldown} 回合`;
        const percent = total > 0 && usableIds.has(entry.id) ? Math.round((toInt(entry.weight) / total) * 100) : 0;
        return `${sequenceLabel(entry)} 详情：当前概率约 ${percent}%`;
    });
    openSequenceModal(summary, rows);
}

function shouldEqualize(pool) {
    const weights = (pool.entries || []).filter(e => e.enabled !== false && toInt(e.weight) > 0).map(e => toInt(e.weight));
    if (weights.length < 2) return false;
    return Math.max(...weights) / Math.min(...weights) >= 10;
}

function equalize(pool) {
    for (const entry of pool.entries || []) {
        if (entry.enabled !== false && toInt(entry.weight) > 0) entry.weight = 1;
    }
}

function maybeEqualizeWeights(state) {
    const pool = getActivePool(state);
    if (pool.mode !== 'random' || !shouldEqualize(pool)) return false;
    const ok = confirm('当前权重差距较大，是否允许插件按照API数量自动均等权重？');
    if (!ok) return false;
    equalize(pool);
    return true;
}

function reorderEntriesByIds(state, orderedIds) {
    const pool = getActivePool(state);
    const entries = pool.entries || [];
    const byId = new Map(entries.map(entry => [String(entry.id), entry]));
    const next = orderedIds.map(id => byId.get(String(id))).filter(Boolean);
    for (const entry of entries) {
        if (!next.includes(entry)) next.push(entry);
    }
    if (next.length !== entries.length) return false;
    pool.entries = next;
    return true;
}

function exportJson(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportStamp() {
    const date = new Date();
    const pad = value => String(value).padStart(2, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join('');
}

function exportCurrentPool(state) {
    syncAllFromControls(state);
    syncActivePoolPresets(state);
    const pool = getActivePool(state);
    exportJson(`ST-KarmaFlip-current-pool-${exportStamp()}.json`, {
        kind: 'ST-KarmaFlip/pool',
        version: 1,
        exportedAt: new Date().toISOString(),
        pool,
    });
}

function exportAllPools(state) {
    syncAllFromControls(state);
    syncActivePoolPresets(state);
    exportJson(`ST-KarmaFlip-all-pools-${exportStamp()}.json`, {
        kind: 'ST-KarmaFlip/pools',
        version: 1,
        exportedAt: new Date().toISOString(),
        activePoolId: state.activePoolId,
        pools: state.pools || [],
    });
}

function exportApiPresets(state) {
    syncAllFromControls(state);
    syncActivePoolPresets(state);
    exportJson(`ST-KarmaFlip-api-presets-${exportStamp()}.json`, {
        kind: 'ST-KarmaFlip/apiPresets',
        version: 1,
        exportedAt: new Date().toISOString(),
        apiPresets: state.apiPresets || [],
    });
}

function exportAllConfig(state) {
    syncAllFromControls(state);
    syncActivePoolPresets(state);
    exportJson(`ST-KarmaFlip-full-${exportStamp()}.json`, {
        kind: 'ST-KarmaFlip/full',
        version: 1,
        exportedAt: new Date().toISOString(),
        state: createExportSnapshot(state),
    });
}

function readImportPools(payload) {
    if (payload?.kind === 'ST-KarmaFlip/pool' && payload.pool) return [payload.pool];
    if (payload?.kind === 'ST-KarmaFlip/pools' && Array.isArray(payload.pools)) return payload.pools;
    if (payload?.pool && payload.pool.entries) return [payload.pool];
    if (Array.isArray(payload?.pools)) return payload.pools;
    if (payload?.entries && payload?.name) return [payload];
    return [];
}

function readImportPresets(payload) {
    if (payload?.kind === 'ST-KarmaFlip/apiPresets' && Array.isArray(payload.apiPresets)) return payload.apiPresets;
    if (Array.isArray(payload?.apiPresets)) return payload.apiPresets;
    if (Array.isArray(payload?.entries) && !payload.name) return payload.entries;
    if (Array.isArray(payload) && payload.some(item => item?.apiUrl || item?.url || item?.key || item?.model)) return payload;
    if (payload?.apiUrl || payload?.url || payload?.key || payload?.model) return [payload];
    return [];
}

function importConfigPayload(state, payload) {
    if (payload?.kind === 'ST-KarmaFlip/full' && payload.state && typeof payload.state === 'object') {
        const imported = createExportSnapshot(payload.state);
        for (const key of ['enabled', 'activePoolId', 'pools', 'apiPresets', 'theme', 'failure', 'shortcuts', 'ui']) {
            state[key] = imported[key];
        }
        return {
            pools: imported.pools.length,
            presets: imported.apiPresets.length,
            full: true,
        };
    }
    const pools = readImportPools(payload).map(clonePoolForImport);
    const presets = readImportPresets(payload).map(copyPresetForImport);
    if (!pools.length && !presets.length) {
        throw new Error('未识别到可导入的组合或 API 条目');
    }
    if (!Array.isArray(state.pools)) state.pools = [];
    if (!Array.isArray(state.apiPresets)) state.apiPresets = [];
    state.pools.push(...pools);
    state.apiPresets.push(...presets);
    if (pools.length) state.activePoolId = pools[pools.length - 1].id;
    return { pools: pools.length, presets: presets.length };
}

async function importFromFile(state, file, rerender, setStatus) {
    const text = await file.text();
    const payload = JSON.parse(text);
    const result = importConfigPayload(state, payload);
    persistNow(state);
    rerender();
    closeModal('kf-import-export-modal');
    setStatus(result.full
        ? `已恢复完整配置：${result.pools} 个组合，${result.presets} 个 API 条目`
        : `已导入 ${result.pools} 个组合，${result.presets} 个 API 条目`);
}

function closeModal(id) {
    if (id === 'kf-main-modal') resetMainPanelKeyboardLock();
    $(`#${id}`).removeClass('kf-show');
}

function hoistModals() {
    for (const id of MODAL_IDS) {
        let node = document.getElementById(id);
        if (!node) continue;
        if (node.dataset.kfStopBound) {
            const cleanNode = node.cloneNode(true);
            replaceNode(node, cleanNode);
            node = cleanNode;
        }
        if (node.parentElement !== document.body) document.body.appendChild(node);
    }
}

function openFailureDecision(message, actions) {
    return new Promise(resolve => {
        const previousResolver = window.STKarmaFlip.failureResolver;
        if (typeof previousResolver === 'function') previousResolver('cancel');
        let settled = false;
        let timer = null;
        const modal = $('#kf-failure-modal');
        const box = $('#kf-failure-actions').empty();
        const finish = (value, notify = false) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            modal.removeClass('kf-show');
            box.off('click.kfFailure');
            modal.off('click.kfFailureCancel');
            $(document).off('keydown.kfFailureCancel');
            window.STKarmaFlip.failureResolver = null;
            if (notify) showToast('已取消轮询', 'warning');
            resolve(value);
        };
        window.STKarmaFlip.failureResolver = value => finish(value || 'cancel');
        $('#kf-failure-message').text(message || '');
        for (const action of actions || []) {
            box.append(`<button class="kf-action-btn kf-accent-fill" data-value="${esc(action.value)}">${esc(action.label)}</button>`);
        }
        box.off('click.kfFailure').on('click.kfFailure', '.kf-action-btn', function () {
            finish(String($(this).data('value') || 'cancel'));
        });
        modal.off('click.kfFailureCancel').on('click.kfFailureCancel', function (event) {
            if ($(event.target).closest('.kf-action-btn').length) return;
            finish('cancel', true);
        });
        $(document).off('keydown.kfFailureCancel').on('keydown.kfFailureCancel', function (event) {
            if (event.key === 'Escape') finish('cancel', true);
        });
        timer = window.setTimeout(() => finish('cancel', true), 8000);
        modal.addClass('kf-show');
    });
}

window.STKarmaFlip = window.STKarmaFlip || {};
window.STKarmaFlip.openFailureDecision = openFailureDecision;

function ensureToastLayer() {
    let layer = $('#kf-toast-layer');
    if (layer.length) {
        if (layer.get(0).parentElement !== document.body) document.body.appendChild(layer.get(0));
        layer.attr('data-global-toast', 'true');
        return layer;
    }
    layer = $('<div id="kf-toast-layer" class="kf-toast-layer"></div>');
    layer.attr('data-global-toast', 'true');
    document.body.appendChild(layer.get(0));
    return layer;
}

function showToast(message, type = 'info', timeout = 2800) {
    const layer = ensureToastLayer();
    const item = $(`<div class="kf-toast kf-toast-${esc(type)} kf-accent-fill"></div>`).text(message || '');
    layer.append(item);
    nextFrame(() => item.addClass('kf-show'));
    window.setTimeout(() => {
        item.removeClass('kf-show');
        window.setTimeout(() => item.remove(), 220);
    }, timeout);
}

window.STKarmaFlip.showToast = showToast;

function closeDropdown() {
    $('#kf-dropdown-modal').removeClass('kf-show kf-api-name-picker');
    $('#kf-mobile-options').empty();
}

function normalizePickerOptions(options) {
    const map = new Map();
    for (const option of options || []) {
        const item = typeof option === 'object' && option !== null
            ? { value: String(option.value ?? option.name ?? '').trim(), label: String(option.label ?? option.name ?? option.value ?? '').trim(), item: option.item || option }
            : { value: String(option || '').trim(), label: String(option || '').trim(), item: null };
        if (item.value && !map.has(item.value)) map.set(item.value, item);
    }
    return [...map.values()];
}

function openOptionPicker(input, options, title, onPick, config = {}) {
    const unique = normalizePickerOptions(options);
    if (!unique.length) return;
    const choose = (value) => {
        closeDropdown();
        input.val(value);
        onPick?.(value);
    };

    closeDropdown();
    $('#kf-dropdown-title').text(title || '选择');
    $('#kf-dropdown-modal').toggleClass('kf-api-name-picker', config.kind === 'api-name');
    const box = $('#kf-mobile-options').empty();
    for (const option of unique) {
        const deleteButton = config.deletable
            ? `<button class="kf-option-delete kf-icon-btn kf-danger" type="button" title="删除 API 条目" aria-label="删除 API 条目">${trashIcon()}</button>`
            : '';
        if (config.deletable) {
            const detail = String(option.item?.model || option.item?.apiUrl || '').trim();
            const detailHtml = detail ? `<span class="kf-option-meta">${esc(detail)}</span>` : '';
            box.append(`<div class="kf-mobile-option-row" data-value="${esc(option.value)}"><button class="kf-mobile-option kf-option-label kf-option-name" type="button" data-value="${esc(option.value)}"><span class="kf-option-title">${esc(option.label)}</span>${detailHtml}</button>${deleteButton}</div>`);
        } else {
            box.append(`<div class="kf-mobile-option" data-value="${esc(option.value)}">${esc(option.label)}</div>`);
        }
    }
    box.data('kfOptions', unique);
    box.off('click.kfDrop').on('click.kfDrop', '.kf-mobile-option', function () {
        choose(String($(this).data('value')));
    }).on('click.kfDrop', '.kf-option-delete', function (event) {
        event.preventDefault();
        event.stopPropagation();
        const row = $(this).closest('.kf-mobile-option-row');
        const value = String(row.data('value') || '');
        const item = (box.data('kfOptions') || []).find(option => option.value === value)?.item || { name: value };
        const result = config.onDelete?.(item, value);
        if (result === false) return;
        const nextOptions = (box.data('kfOptions') || []).filter(option => option.value !== value);
        box.data('kfOptions', nextOptions);
        row.remove();
        if (!nextOptions.length) closeDropdown();
    });
    $('#kf-dropdown-modal').addClass('kf-show');
}

function openGroupPicker(state, rerender) {
    const input = $('#kf-pool-picker-display');
    const options = (state.pools || []).map(pool => pool.name);
    openOptionPicker(input, options, '选择组合', (name) => {
        const pool = (state.pools || []).find(item => item.name === name);
        if (!pool) return;
        patchActivePoolId(state, pool.id);
        rerender();
    });
}

function openRenamePoolModal(state) {
    const pool = getActivePool(state);
    $('#kf-rename-pool-input').val(pool.name || '');
    $('#kf-rename-pool-modal').addClass('kf-show');
    window.setTimeout(() => $('#kf-rename-pool-input').trigger('focus').trigger('select'), 0);
}

function closeRenamePoolModal() {
    closeModal('kf-rename-pool-modal');
}

function renameActivePool(state, rerender, setStatus) {
    const pool = getActivePool(state);
    const name = String($('#kf-rename-pool-input').val() || '').trim();
    if (!name) {
        showToast('组合名称不能为空', 'warning');
        return;
    }
    pool.name = name;
    persistNow(state);
    closeRenamePoolModal();
    rerender();
    setStatus('组合名称已修改');
}

function openEntryNamePicker(state, row, input, rerender) {
    const pool = getActivePool(state);
    const entry = pool.entries.find(e => e.id === row.data('id'));
    const options = savedApiEntries(state).map(item => ({ value: item.name, label: item.name, item }));
    openOptionPicker(input, options, '选择 API 名称', (name) => {
        if (!entry) return;
        const preset = findSavedApiEntry(state, name, entry.id);
        if (preset) {
            applyEntryPreset(entry, preset);
            rerender();
        } else {
            entry.name = name;
        }
        saveApiPreset(state, entry);
        persistNow(state);
    }, {
        kind: 'api-name',
        deletable: true,
        onDelete: (item) => {
            const deleted = deleteSavedApiEntry(state, item);
            if (!deleted) {
                showToast('该条目未保存为 API 预设，无法从预设列表删除', 'warning');
                return false;
            }
            persistStructure(state);
            rerender();
            showToast('API 条目已删除', 'info');
            return true;
        },
    });
}

function openEntryModelPicker(state, row, input, rerender) {
    const pool = getActivePool(state);
    const entry = pool.entries.find(e => e.id === row.data('id'));
    if (!entry) return;
    openOptionPicker(input, getModelOptions(entry), '选择模型', (model) => {
        entry.model = model;
        saveApiPreset(state, entry);
        persistStructure(state);
        rerender();
    });
}

function normalizeBaseUrl(apiUrl) {
    return String(apiUrl || '').trim().replace(/\/+$/, '');
}

function providerBaseUrl(apiUrl, provider) {
    const baseUrl = normalizeBaseUrl(apiUrl);
    if (normalizeProvider(provider) === 'gemini') {
        return baseUrl.replace(/\/v1(?:beta)?$/i, '');
    }
    return baseUrl;
}

function chatCompletionSource(provider) {
    const normalized = normalizeProvider(provider);
    if (normalized === 'gemini') return 'makersuite';
    if (normalized === 'claude') return 'claude';
    return 'openai';
}

function providerLabel(provider) {
    const normalized = normalizeProvider(provider);
    if (normalized === 'gemini') return 'Gemini 官方';
    if (normalized === 'claude') return 'Claude 官方';
    return 'OpenAI 兼容';
}

function providerUrlPlaceholder(provider) {
    const normalized = normalizeProvider(provider);
    if (normalized === 'gemini') return 'https://generativelanguage.googleapis.com';
    if (normalized === 'claude') return 'https://api.anthropic.com/v1';
    return 'https://api.openai.com/v1';
}

function anthropicModelsUrl(apiUrl) {
    const baseUrl = normalizeBaseUrl(apiUrl).replace(/\/v1$/i, '');
    return `${baseUrl}/v1/models`;
}

function buildStatusPayload(entry) {
    const source = chatCompletionSource(entry.provider);
    const payload = {
        chat_completion_source: source,
        reverse_proxy: providerBaseUrl(entry.apiUrl, entry.provider),
        proxy_password: entry.key,
        model: entry.model || '',
    };
    if (source === 'makersuite') payload.google_model = entry.model || '';
    if (source === 'claude') payload.claude_model = entry.model || '';
    return payload;
}

function requestHeaders() {
    const context = window.SillyTavern?.getContext?.() || {};
    return typeof context.getRequestHeaders === 'function'
        ? context.getRequestHeaders()
        : { 'Content-Type': 'application/json' };
}

async function postChatBackend(path, payload) {
    return fetch(path, {
        method: 'POST',
        headers: {
            ...requestHeaders(),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });
}

function modelsFromStatusPayload(payload) {
    if (Array.isArray(payload?.data)) {
        return payload.data.map(item => String(item?.id || item?.name || '')).filter(Boolean);
    }
    if (Array.isArray(payload)) {
        return payload.map(item => String(item?.id || item?.name || item || '')).filter(Boolean);
    }
    return [];
}

async function fetchClaudeModels(entry) {
    const response = await fetch(anthropicModelsUrl(entry.apiUrl), {
        method: 'GET',
        headers: {
            'x-api-key': entry.key,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
        },
    });
    const body = await readResponseText(response);
    const payload = parseMaybeJson(body);
    if (!response.ok) {
        const detail = statusFailureMessage(payload, body);
        throw new Error(`获取模型失败：HTTP ${response.status}${detail ? `\n${detail}` : ''}`);
    }
    if (payload?.error) throw new Error(`获取模型失败：${responsePreview(payload.error)}`);
    const models = modelsFromStatusPayload(payload);
    if (!models.length) throw new Error('获取模型失败：返回结果没有模型列表');
    return models;
}

async function fetchProviderModels(entry) {
    if (!entry.apiUrl) throw new Error('请先填写 URL');
    if (normalizeProvider(entry.provider) === 'claude') return fetchClaudeModels(entry);
    const response = await postChatBackend('/api/backends/chat-completions/status', buildStatusPayload(entry));
    if (!response.ok) {
        throw new Error(`获取模型失败：HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (payload?.error) throw new Error('获取模型失败：接口返回错误');
    const models = modelsFromStatusPayload(payload);
    if (!models.length) throw new Error('获取模型失败：返回结果没有模型列表');
    return models;
}

function responsePreview(payload) {
    if (typeof payload === 'string') return payload;
    try {
        return JSON.stringify(payload, null, 2);
    } catch {
        return String(payload);
    }
}

async function readResponseText(response) {
    return await response.text();
}

function parseMaybeJson(text) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function statusFailureMessage(payload, rawBody) {
    if (payload === false) return rawBody || 'false';
    if (!payload || typeof payload !== 'object') return '';
    const failureKeys = ['ok', 'success', 'result', 'online', 'connected'];
    if (failureKeys.some(key => payload[key] === false)) {
        return payload.message || payload.error || payload.reason || rawBody || responsePreview(payload);
    }
    if (payload.error) return responsePreview(payload.error);
    if (typeof payload.message === 'string' && /fail|error|incorrect|invalid|down|unauthorized/i.test(payload.message)) {
        return payload.message;
    }
    return '';
}

function isDragExcluded(target) {
    return !!$(target).closest('input,textarea,select,button,label,.kf-dropdown-input,.kf-dropdown-arrow,.kf-toggle-chip,.kf-select-wrapper,.kf-input-wrapper').length;
}

function bindEntryDragSort(state, rerender, setStatus) {
    const list = $('#kf-entry-list');
    let timer = null;
    let drag = null;

    const clearTimer = () => {
        if (timer) clearTimeout(timer);
        timer = null;
    };

    const cleanup = () => {
        clearTimer();
        $(document).off('.kfEntryDrag');
        if (drag?.row?.length) {
            drag.row.removeClass('kf-dragging').css({ position: '', left: '', top: '', width: '', zIndex: '', pointerEvents: '', transform: '' });
        }
        drag?.placeholder?.remove();
        list.removeClass('kf-drag-active');
        drag = null;
    };

    const orderedIdsFromDom = () => {
        const ids = [];
        list.children('.kf-entry-block,.kf-drag-placeholder').each(function () {
            const node = $(this);
            if (node.hasClass('kf-drag-placeholder')) {
                if (drag?.id) ids.push(String(drag.id));
                return;
            }
            const id = String(node.data('id') || '');
            if (id && id !== String(drag?.id || '')) ids.push(id);
        });
        return ids;
    };

    const placePlaceholder = (clientY) => {
        if (!drag) return;
        const rows = list.children('.kf-entry-block').not(drag.row);
        let placed = false;
        rows.each(function () {
            const row = $(this);
            const rect = this.getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) {
                drag.placeholder.insertBefore(row);
                placed = true;
                return false;
            }
            return true;
        });
        if (!placed) list.append(drag.placeholder);
    };

    const autoScroll = (clientY) => {
        const node = list.get(0);
        if (!node) return;
        const rect = node.getBoundingClientRect();
        const edge = 42;
        if (clientY < rect.top + edge) node.scrollTop -= 12;
        if (clientY > rect.bottom - edge) node.scrollTop += 12;
    };

    const move = (event) => {
        if (!drag) return;
        const dy = event.clientY - drag.startY;
        drag.row.css('transform', `translate3d(0, ${dy}px, 0)`);
        placePlaceholder(event.clientY);
        autoScroll(event.clientY);
        event.preventDefault();
    };

    const finish = (event) => {
        if (!drag) {
            cleanup();
            return;
        }
        if (event?.type === 'pointercancel') {
            cleanup();
            return;
        }
        const orderedIds = orderedIdsFromDom();
        const changed = reorderEntriesByIds(state, orderedIds);
        cleanup();
        if (changed) {
            persistStructure(state);
            rerender();
            setStatus('条目顺序已更新');
        }
    };

    const startDrag = (row, event) => {
        event.preventDefault();
        syncAllEntries(state);
        const rect = row.get(0).getBoundingClientRect();
        const placeholder = $('<div class="kf-drag-placeholder"></div>').height(rect.height);
        row.after(placeholder);
        drag = {
            row,
            placeholder,
            id: row.data('id'),
            startY: event.clientY,
        };
        list.addClass('kf-drag-active');
        row.addClass('kf-dragging').css({
            position: 'fixed',
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            zIndex: 10050,
            pointerEvents: 'none',
            transform: 'translate3d(0, 0, 0)',
        });
        row.get(0).setPointerCapture?.(event.pointerId);
        $(document)
            .on('pointermove.kfEntryDrag', move)
            .on('pointerup.kfEntryDrag pointercancel.kfEntryDrag', finish);
    };

    list.on('pointerdown.kf', '.kf-entry-block', function (event) {
        if (event.button && event.button !== 0) return;
        if (isDragExcluded(event.target)) return;
        const row = $(this);
        if (list.children('.kf-entry-block').length < 2) return;
        clearTimer();
        timer = setTimeout(() => startDrag(row, event), 420);
        $(document)
            .off('pointerup.kfEntryPrep pointercancel.kfEntryPrep pointermove.kfEntryPrep')
            .on('pointermove.kfEntryPrep', prepEvent => {
                if (Math.abs(prepEvent.clientY - event.clientY) > 8 || Math.abs(prepEvent.clientX - event.clientX) > 8) clearTimer();
            })
            .on('pointerup.kfEntryPrep pointercancel.kfEntryPrep', () => {
                clearTimer();
                $(document).off('.kfEntryPrep');
            });
    });
}

function bind(state, rerender, setStatus) {
    $('#kf-pool-picker-display').prop('readonly', true).off('click.kf keydown.kf').on('click.kf', function () {
        openGroupPicker(state, rerender);
    }).on('keydown.kf', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openGroupPicker(state, rerender);
        }
    });
    $('#kf-pool-picker-arrow').off('pointerdown.kf click.kf').on('pointerdown.kf', function (event) {
        event.preventDefault();
        event.stopPropagation();
    }).on('click.kf', function (event) {
        event.preventDefault();
        event.stopPropagation();
        openGroupPicker(state, rerender);
    });

    $('#kf-mode-fixed,#kf-mode-random').off('change.kf').on('change.kf', function () {
        setPoolMode(state, String($(this).val()), rerender, setStatus);
    });
    $('#kf-no-streak').off('change.kf').on('change.kf', function () {
        patchPoolNoConsecutive(state, $(this).prop('checked'));
        updateChatShortcut(state);
        setStatus('避免连续命中已更新');
    });
    $('#kf-btn-new-pool').off('click.kf').on('click.kf', () => {
        syncAllFromControls(state);
        const pool = mkPool();
        state.pools.push(pool);
        state.activePoolId = pool.id;
        persistNow(state);
        rerender();
    });
    $('#kf-btn-copy-pool').off('click.kf').on('click.kf', () => {
        syncAllFromControls(state);
        const pool = clonePool(getActivePool(state));
        state.pools.push(pool);
        state.activePoolId = pool.id;
        persistNow(state);
        rerender();
    });
    $('#kf-btn-rename-pool').off('click.kf').on('click.kf', () => openRenamePoolModal(state));
    $('#kf-btn-delete-pool').off('click.kf').on('click.kf', () => {
        if (state.pools.length <= 1) return setStatus('至少保留一个组合');
        state.pools = state.pools.filter(p => p.id !== state.activePoolId);
        state.activePoolId = state.pools[0].id;
        persistNow(state);
        rerender();
    });
    $('#kf-btn-add-entry').off('click.kf').on('click.kf', () => {
        addEntry(getActivePool(state));
        persistNow(state);
        rerender();
    });
    $('#kf-btn-sequence-check').off('click.kf').on('click.kf', () => showSequenceCheck(state));

    $('#kf-entry-list').off('.kf');
    $('#kf-entry-list').on('change.kf', '.kf-entry-name', function () {
        const pool = getActivePool(state);
        const row = $(this).closest('.kf-entry-block');
        const entry = pool.entries.find(e => e.id === row.data('id'));
        if (!entry) return;
        syncEntryFromRow(entry, row, state);
        const name = String($(this).val() || '').trim();
        const preset = findSavedApiEntry(state, name, entry.id);
        if (preset) {
            applyEntryPreset(entry, preset);
            rerender();
        }
        saveApiPreset(state, entry);
        persistStructure(state);
        setStatus('API条目名称已保存');
    });
    $('#kf-entry-list').on('input.kf', '.kf-entry-name,.kf-entry-url,.kf-entry-key,.kf-entry-model,.kf-entry-fixed-runs,.kf-entry-weight,.kf-entry-pity,.kf-entry-cooldown', function () {
        const row = $(this).closest('.kf-entry-block');
        const entry = getActivePool(state).entries.find(e => e.id === row.data('id'));
        if (!entry) return;
        syncEntryFromRow(entry, row, state);
        persistStructure(state);
    });
    $('#kf-entry-list').on('focusin.kf', '.kf-entry-key', function () {
        setKeyMaskState(this, false);
    });
    $('#kf-entry-list').on('focusout.kf', '.kf-entry-key', function () {
        setKeyMaskState(this, true);
    });
    $('#kf-entry-list').on('focusin.kf', '.kf-entry-name,.kf-entry-url,.kf-entry-key,.kf-entry-model,.kf-entry-fixed-runs,.kf-entry-weight,.kf-entry-pity,.kf-entry-cooldown', function () {
        lockMainPanelForKeyboard();
        scrollEntryIntoKeyboardView(this);
    });
    $('#kf-entry-list').on('focusout.kf', '.kf-entry-name,.kf-entry-url,.kf-entry-key,.kf-entry-model,.kf-entry-fixed-runs,.kf-entry-weight,.kf-entry-pity,.kf-entry-cooldown', function () {
        releaseMainPanelKeyboardLockSoon();
    });
    $('#kf-entry-list').on('change.kf', '.kf-entry-enabled', function () {
        const pool = getActivePool(state);
        const row = $(this).closest('.kf-entry-block');
        const entryId = String(row.data('id') || '');
        const enabled = $(this).prop('checked');
        const entry = patchEntryEnabledState(state, pool.id, entryId, enabled);
        if (!entry) return;
    });
    $('#kf-entry-list').on('change.kf', '.kf-entry-url,.kf-entry-key,.kf-entry-model,.kf-entry-fixed-runs,.kf-entry-weight,.kf-entry-pity,.kf-entry-cooldown', function () {
        const row = $(this).closest('.kf-entry-block');
        const entry = getActivePool(state).entries.find(e => e.id === row.data('id'));
        if (!entry) return;
        syncEntryFromRow(entry, row, state);
        const equalized = $(this).hasClass('kf-entry-weight') && maybeEqualizeWeights(state);
        persistStructure(state);
        if (equalized) rerender();
    });
    $('#kf-entry-list').on('dblclick.kf', '.kf-entry-name', function () {
        const row = $(this).closest('.kf-entry-block');
        openEntryNamePicker(state, row, $(this), rerender);
    });
    $('#kf-entry-list').on('pointerdown.kf click.kf', '.kf-entry-name-arrow', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (event.type !== 'click') return;
        const row = $(this).closest('.kf-entry-block');
        openEntryNamePicker(state, row, row.find('.kf-entry-name'), rerender);
    });
    $('#kf-entry-list').on('click.kf', '.kf-entry-provider-display', function (event) {
        event.preventDefault();
        event.stopPropagation();
        const pool = getActivePool(state);
        const row = $(this).closest('.kf-entry-block');
        const entry = pool.entries.find(e => e.id === row.data('id'));
        if (!entry) return;
        const options = providerOptions();
        openOptionPicker($(this), options.map(option => option.label), '选择接口', (label) => {
            const option = options.find(item => item.label === label);
            if (!option) return;
            const nextProvider = normalizeProvider(option.value);
            if (entry.provider !== nextProvider) {
                entry.provider = nextProvider;
                entry.model = '';
                entry.modelOptions = [];
            }
            persistStructure(state);
            rerender();
        });
    });
    $('#kf-entry-list').on('dblclick.kf', '.kf-entry-model', function () {
        const row = $(this).closest('.kf-entry-block');
        openEntryModelPicker(state, row, $(this), rerender);
    });
    $('#kf-entry-list').on('pointerdown.kf click.kf', '.kf-entry-model-arrow', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (event.type !== 'click') return;
        const row = $(this).closest('.kf-entry-block');
        openEntryModelPicker(state, row, row.find('.kf-entry-model'), rerender);
    });
    $('#kf-entry-list').on('click.kf', '.kf-key-eye', function (event) {
        event.preventDefault();
        event.stopPropagation();
        const button = $(this);
        const input = button.closest('.kf-input-wrapper').find('.kf-entry-key');
        const reveal = input.hasClass('kf-key-masked');
        setKeyMaskState(input, !reveal);
    });
    $('#kf-entry-list').on('click.kf', '.kf-entry-window', function (event) {
        event.preventDefault();
        event.stopPropagation();
        const entryId = String($(this).closest('.kf-entry-block').data('id') || '');
        openApiEntriesEditor(state, entryId, rerender, setStatus);
    });
    $('#kf-entry-list').on('click.kf', '.kf-collapse', function (event) {
        event.preventDefault();
        event.stopPropagation();
        const pool = getActivePool(state);
        const row = $(this).closest('.kf-entry-block');
        const entryId = String(row.data('id') || '');
        const entry = pool.entries.find(e => e.id === entryId);
        if (!entry) return;
        const nextCollapsed = !row.hasClass('kf-collapsed');
        if (row.attr('data-preserve-collapsed') === 'true') {
            row.removeAttr('data-preserve-collapsed');
            apiEntriesForcedExpandedIds.delete(entryId);
        }
        patchEntryCollapsedState(state, pool.id, entryId, nextCollapsed);
        updateEntryCollapsedRow(row, nextCollapsed);
    });
    $('#kf-entry-list').on('click.kf', '.kf-del', function () {
        const pool = getActivePool(state);
        const row = $(this).closest('.kf-entry-block');
        const id = row.data('id');
        const entry = pool.entries.find(e => e.id === id);
        if (entry) {
            syncEntryFromRow(entry, row, state);
            saveApiPresetIfNamed(state, entry);
        }
        pool.entries = pool.entries.filter(e => e.id !== id);
        persistStructure(state);
        rerender();
    });
    bindEntryDragSort(state, rerender, setStatus);
    $('#kf-entry-list').on('click.kf', '.kf-fetch-models', async function () {
        const pool = getActivePool(state);
        const row = $(this).closest('.kf-entry-block');
        const entry = pool.entries.find(e => e.id === row.data('id'));
        if (!entry) return;
        syncEntryFromRow(entry, row, state);
        setStatus(`正在获取${providerLabel(entry.provider)}模型，请稍候`);
        try {
            const models = await fetchProviderModels(entry);
            entry.model = '';
            entry.modelOptions = models;
            saveApiPreset(state, entry);
            persistStructure(state);
            rerender();
            setStatus(`已获取 ${models.length} 个模型，请重新选择模型`);
        } catch (error) {
            const message = error?.message || '获取模型失败';
            setStatus(message);
            showToast(message, 'error');
        }
    });
    $('#kf-entry-list').on('click.kf', '.kf-entry-preset-settings', async function (event) {
        event.preventDefault();
        event.stopPropagation();
        const row = $(this).closest('.kf-entry-block');
        const entry = getActivePool(state).entries.find(item => item.id === row.data('id'));
        if (!entry) return;
        syncEntryFromRow(entry, row, state);
        await openPresetBindingModal(state, entry);
    });
    $('#kf-btn-settings').off('click.kf').on('click.kf', () => {
        populateSettingsControls(state);
        $('#kf-settings-modal').addClass('kf-show');
    });
    $('#kf-main-close').off('click.kf').on('click.kf', () => {
        if (!closeApiEntriesEditor(state, rerender, setStatus)) closeMainPanel();
    });
    $('#kf-btn-import-export').off('click.kf').on('click.kf', () => $('#kf-import-export-modal').addClass('kf-show'));
    $('#kf-import-export-close').off('click.kf').on('click.kf', () => closeModal('kf-import-export-modal'));
    $('#kf-export-current-pool').off('click.kf').on('click.kf', () => {
        exportCurrentPool(state);
        setStatus('当前组合已导出');
    });
    $('#kf-export-all-pools').off('click.kf').on('click.kf', () => {
        exportAllPools(state);
        setStatus('全部组合已导出');
    });
    $('#kf-export-api-presets').off('click.kf').on('click.kf', () => {
        exportApiPresets(state);
        setStatus('API 条目已导出');
    });
    $('#kf-export-all-config').off('click.kf').on('click.kf', () => {
        exportAllConfig(state);
        setStatus('全部配置已导出');
    });
    $('#kf-import-config').off('click.kf').on('click.kf', () => $('#kf-import-file').val('').trigger('click'));
    $('#kf-import-file').off('change.kf').on('change.kf', async function () {
        const file = this.files?.[0];
        if (!file) return;
        try {
            await importFromFile(state, file, rerender, setStatus);
        } catch (error) {
            const message = String(error?.message || error || '导入失败');
            showToast(message, 'error');
            setStatus('导入失败');
        }
    });
    $('#kf-btn-logs').off('click.kf').on('click.kf', () => {
        $('#kf-log-modal').addClass('kf-show');
        renderLogs(state);
    });
    $('#kf-log-close').off('click.kf').on('click.kf', () => closeModal('kf-log-modal'));
    $('#kf-log-clear').off('click.kf').on('click.kf', () => {
        clearLogs(state);
        renderLogs(state);
        setStatus('日志已清空');
    });
    $('#kf-logs-list').off('.kfLogUrl')
        .on('click.kfLogUrl', '.kf-log-copy-url', async function (event) {
            event.preventDefault();
            event.stopPropagation();
            try {
                await copyTextToClipboard(String($(this).attr('data-url') || ''));
                showToast('URL 已复制', 'info');
            } catch {
                showToast('URL 复制失败，请长按链接手动复制', 'error');
            }
        })
        .on('keydown.kfLogUrl', '.kf-log-copy-url', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            $(this).trigger('click');
        });
    $('.kf-log-filter').off('click.kf').on('click.kf', function () {
        $('.kf-log-filter').removeClass('kf-active');
        $(this).addClass('kf-active');
        renderLogs(state, String($(this).data('filter') || 'all'));
    });
    $('#kf-btn-theme').off('click.kf').on('click.kf', () => {
        populateThemeControls(state);
        applyTheme(state);
        $('#kf-theme-modal').addClass('kf-show');
    });
    $('#kf-theme-close,#kf-theme-cancel').off('click.kf').on('click.kf', () => closeThemeModal(state));
    $('#kf-settings-close,#kf-settings-cancel').off('click.kf').on('click.kf', () => {
        closeModal('kf-floating-skin-modal');
        closeModal('kf-settings-modal');
    });
    $('#kf-floating-skin-open').off('click.kf').on('click.kf', openFloatingSkinModal);
    $('#kf-floating-skin-close,#kf-floating-skin-cancel').off('click.kf').on('click.kf', () => closeModal('kf-floating-skin-modal'));
    $('#kf-floating-skin-grid').off('click.kf').on('click.kf', '.kf-floating-skin-card', function () {
        const skin = normalizeFloatingSkin($(this).attr('data-skin'));
        $('#kf-floating-skin-modal').attr('data-selected-skin', skin);
        $('.kf-floating-skin-card').removeClass('kf-selected').attr('aria-checked', 'false');
        $(this).addClass('kf-selected').attr('aria-checked', 'true');
    });
    $('#kf-floating-skin-confirm').off('click.kf').on('click.kf', () => {
        $('#kf-floating-skin').val(normalizeFloatingSkin($('#kf-floating-skin-modal').attr('data-selected-skin')));
        closeModal('kf-floating-skin-modal');
    });
    $('#kf-preset-binding-close').off('click.kf').on('click.kf', closePresetBindingModal);
    $('#kf-preset-binding-select').off('change.kf').on('change.kf', async function () {
        if (!presetBindingDraft) return;
        presetBindingDraft.presetName = String($(this).val() || '').trim();
        await refreshPresetBindingCatalog({ resetStates: true });
    });
    $('.kf-preset-binding-tab').off('click.kf').on('click.kf', function () {
        if (!presetBindingDraft) return;
        presetBindingDraft.tab = $(this).attr('data-binding-tab') === 'regex' ? 'regex' : 'prompts';
        $('.kf-preset-binding-tab').removeClass('kf-active').attr('aria-selected', 'false');
        $(this).addClass('kf-active').attr('aria-selected', 'true');
        renderPresetBindingList();
    });
    $('#kf-preset-binding-search').off('input.kf').on('input.kf', renderPresetBindingList);
    $('#kf-preset-binding-list').off('click.kf').on('click.kf', '.kf-preset-binding-toggle', function () {
        if (!presetBindingDraft || !presetBindingCatalog) return;
        const key = String($(this).closest('.kf-preset-binding-item').attr('data-key') || '');
        const row = presetBindingRows().find(item => item.key === key);
        const states = presetBindingStateMap();
        if (!row || !states) return;
        const current = Object.prototype.hasOwnProperty.call(states, key) ? states[key] : row.enabled;
        const next = !current;
        if (next === row.enabled) delete states[key];
        else states[key] = next;
        renderPresetBindingList();
    });
    $('#kf-preset-binding-clear').off('click.kf').on('click.kf', () => {
        if (!presetBindingDraft) return closePresetBindingModal();
        const pool = (state.pools || []).find(item => String(item?.id) === presetBindingDraft.poolId);
        const entry = (pool?.entries || []).find(item => String(item?.id) === presetBindingDraft.entryId);
        if (entry) {
            entry.presetBinding = null;
            persistStructure(state);
        }
        closePresetBindingModal();
        rerender();
        setStatus('已取消该 API 条目的预设绑定');
    });
    $('#kf-preset-binding-confirm').off('click.kf').on('click.kf', () => {
        if (!presetBindingDraft?.presetName || !presetBindingCatalog?.presetExists) {
            showToast('请选择一个当前存在的酒馆预设', 'warning', 2800);
            return;
        }
        const pool = (state.pools || []).find(item => String(item?.id) === presetBindingDraft.poolId);
        const entry = (pool?.entries || []).find(item => String(item?.id) === presetBindingDraft.entryId);
        if (!entry) return closePresetBindingModal();
        entry.presetBinding = {
            presetName: presetBindingDraft.presetName,
            promptStates: cloneBooleanRecord(presetBindingDraft.promptStates),
            regexStates: cloneBooleanRecord(presetBindingDraft.regexStates),
        };
        persistStructure(state);
        const presetName = presetBindingDraft.presetName;
        closePresetBindingModal();
        rerender();
        setStatus(`已绑定酒馆预设：${presetName}`);
    });
    $('#kf-main-modal').off('click.kfApiEditorBackdrop', '#kf-api-entries-backdrop').on('click.kfApiEditorBackdrop', '#kf-api-entries-backdrop', function (event) {
        event.stopPropagation();
        closeApiEntriesEditor(state, rerender, setStatus);
    });
    $('#kf-api-override-close').off('click.kf').on('click.kf', () => closeModal('kf-api-override-modal'));
    $('#kf-api-override-list').off('click.kf').on('click.kf', '.kf-api-override-option', function () {
        const pool = getActivePool(state);
        const entryId = String($(this).attr('data-entry-id') || '');
        const entry = (pool.entries || []).find(item => item.id === entryId);
        if (!entry || !String(entry.apiUrl || '').trim() || !String(entry.model || '').trim()) return;
        if (getApiOverrideState(state).lock) {
            const lock = setApiLock(state, pool.id, entry.id);
            if (!lock) {
                showToast('当前没有可绑定的聊天，请先进入一个聊天窗口', 'warning', 3200);
                return;
            }
            persistHot(state);
            renderApiOverrideModal(state);
            showToast(`已更换锁定 API：${entry.name || '未命名 API'} / ${entry.model}`, 'info', 2600);
            setStatus(`已更换锁定 API：${entry.name || entry.model}`);
            return;
        }
        setPendingApiOverride(state, pool.id, entry.id);
        renderApiOverrideModal(state);
        showToast(`已指定下个请求 API：${entry.name || '未命名 API'} / ${entry.model}`, 'info', 2600);
        setStatus(`已指定 API：${entry.name || entry.model}`);
    });
    $('#kf-api-override-lock').off('click.kf').on('click.kf', () => {
        const override = getApiOverrideState(state);
        if (override.lock) {
            clearApiLock(state);
            persistHot(state);
            renderApiOverrideModal(state);
            showToast('已取消当前聊天的 API 锁定', 'info', 2200);
            setStatus('已取消 API 锁定');
            return;
        }
        const pool = getActivePool(state);
        const selected = override.pending?.poolId === pool.id
            ? override.pending
            : (override.floorBinding?.poolId === pool.id ? override.floorBinding : null);
        const entry = (pool.entries || []).find(item => item.id === selected?.entryId);
        if (!entry) {
            showToast('请先选择需要锁定的 API', 'warning', 2400);
            return;
        }
        const lock = setApiLock(state, pool.id, entry.id);
        if (!lock) {
            showToast('当前没有可绑定的聊天，请先进入一个聊天窗口', 'warning', 3200);
            return;
        }
        persistHot(state);
        renderApiOverrideModal(state);
        showToast(`当前聊天已锁定 API：${entry.name || '未命名 API'} / ${entry.model}`, 'info', 2800);
        setStatus(`已锁定 API：${entry.name || entry.model}`);
    });
    $('#kf-api-override-restore').off('click.kf').on('click.kf', () => {
        clearApiOverride(state);
        persistHot(state);
        renderApiOverrideModal(state);
        showToast('已恢复自动选择 API', 'info', 2200);
        setStatus('已恢复自动选择 API');
    });
    $('#kf-api-override-start').off('click.kf').on('click.kf', () => {
        if (state.enabled === false) toggleGlobalEnabled(state, setStatus);
        renderApiOverrideModal(state);
    });
    $('#kf-theme-confirm').off('click.kf').on('click.kf', () => saveThemeFromModal(state, setStatus));
    $('#kf-settings-confirm').off('click.kf').on('click.kf', () => saveFailureSettingsFromModal(state, rerender, setStatus));
    $('#kf-clear-all-data').off('click.kf').on('click.kf', () => $('#kf-reset-data-modal').addClass('kf-show'));
    $('#kf-reset-data-cancel').off('click.kf').on('click.kf', () => closeModal('kf-reset-data-modal'));
    $('#kf-reset-data-confirm').off('click.kf').on('click.kf', () => {
        clearRuntimeHookState();
        resetAllPluginData(state);
        const pool = getActivePool(state);
        if (pool && !pool.entries.length) addEntry(pool);
        persistNow(state);
        closeModal('kf-reset-data-modal');
        closeModal('kf-settings-modal');
        rerender();
        ensureChatShortcut(state, rerender, setStatus);
        ensureFloatingButton(state, rerender, setStatus);
        showToast('插件全部数据已清除，已恢复默认设置', 'info', 3200);
        setStatus('全部数据已清除');
    });
    $('#kf-update-notice-close,#kf-update-notice-confirm').off('click.kf').on('click.kf', () => confirmUpdateNotice(state));
    $('#kf-sequence-confirm').off('click.kf').on('click.kf', () => closeModal('kf-sequence-modal'));
    $('#kf-rename-pool-close,#kf-rename-pool-cancel').off('click.kf').on('click.kf', () => closeRenamePoolModal());
    $('#kf-rename-pool-confirm').off('click.kf').on('click.kf', () => renameActivePool(state, rerender, setStatus));
    $('#kf-rename-pool-input').off('keydown.kf').on('keydown.kf', function (event) {
        if (event.key === 'Enter') renameActivePool(state, rerender, setStatus);
        if (event.key === 'Escape') closeRenamePoolModal();
    });
    $('#kf-dropdown-close').off('click.kf').on('click.kf', () => closeDropdown());
    $('.kf-modal-overlay').off('pointerdown.kf mousedown.kf touchstart.kf click.kf')
        .on('pointerdown.kf mousedown.kf touchstart.kf', function (event) {
            event.stopPropagation();
        })
        .on('click.kf', function (event) {
            event.stopPropagation();
            if (event.target !== this) return;
            if (this.id === 'kf-theme-modal') closeThemeModal(state);
            else if (this.id === 'kf-color-picker-modal') closeColorPicker();
            else if (this.id === 'kf-update-notice-modal') confirmUpdateNotice(state);
            else if (this.id === 'kf-main-modal' && apiEntriesEditorOpen) closeApiEntriesEditor(state, rerender, setStatus);
            else if (this.id === 'kf-preset-binding-modal') closePresetBindingModal();
            else $(this).removeClass('kf-show');
        });
    $('.kf-modal-overlay .kf-modal-box').not('#kf-failure-modal .kf-modal-box').off('pointerdown.kf mousedown.kf touchstart.kf click.kf')
        .on('pointerdown.kf mousedown.kf touchstart.kf click.kf', function (event) {
            event.stopPropagation();
        });
    $(document).off('mousedown.kfDropdown').on('mousedown.kfDropdown', function (event) {
        if ($(event.target).closest('#kf-dropdown-modal,.kf-dropdown-input').length) return;
        closeDropdown();
    });

    $('.kf-color-picker-trigger').off('click.kf').on('click.kf', function () {
        openColorPicker(String($(this).data('colorTarget') || 'kf-theme-underline'));
    });
    $('#kf-color-picker-close,#kf-color-picker-cancel').off('click.kf').on('click.kf', () => closeColorPicker());
    $('#kf-color-picker-confirm').off('click.kf').on('click.kf', function () {
        if (!colorPickerTargetId) return closeColorPicker();
        const color = setThemeColorControlValue(colorPickerTargetId, colorPickerHex());
        $(`#${colorPickerTargetId}`).val(color).trigger('input');
        closeColorPicker();
    });
    $('#kf-color-hue').off('input.kf change.kf').on('input.kf change.kf', function () {
        colorPickerDraft.h = clampNumber($(this).val(), 0, 360);
        renderColorPicker();
    });
    $('#kf-color-r,#kf-color-g,#kf-color-b').off('input.kf change.kf').on('input.kf change.kf', function () {
        const values = ['#kf-color-r', '#kf-color-g', '#kf-color-b'].map(selector => String($(selector).val() ?? '').trim());
        if (values.some(value => value === '')) return;
        colorPickerDraft = rgbToHsv(values.map(value => clampNumber(value, 0, 255)));
        renderColorPicker();
    });
    $('#kf-color-field').off('pointerdown.kf keydown.kf')
        .on('pointerdown.kf', function (event) {
            event.preventDefault();
            colorPickerDragging = true;
            updateColorPickerFromPointer(event);
        })
        .on('keydown.kf', function (event) {
            const step = event.shiftKey ? 0.05 : 0.01;
            if (event.key === 'ArrowLeft') colorPickerDraft.s = clampNumber(colorPickerDraft.s - step, 0, 1);
            else if (event.key === 'ArrowRight') colorPickerDraft.s = clampNumber(colorPickerDraft.s + step, 0, 1);
            else if (event.key === 'ArrowUp') colorPickerDraft.v = clampNumber(colorPickerDraft.v + step, 0, 1);
            else if (event.key === 'ArrowDown') colorPickerDraft.v = clampNumber(colorPickerDraft.v - step, 0, 1);
            else return;
            event.preventDefault();
            renderColorPicker();
        });
    $(document).off('pointermove.kfColorPicker pointerup.kfColorPicker pointercancel.kfColorPicker')
        .on('pointermove.kfColorPicker', function (event) {
            if (colorPickerDragging) updateColorPickerFromPointer(event);
        })
        .on('pointerup.kfColorPicker pointercancel.kfColorPicker', function () {
            colorPickerDragging = false;
        });
    $(document).off('keydown.kfColorPicker').on('keydown.kfColorPicker', function (event) {
        if (event.key !== 'Escape') return;
        if ($('#kf-color-picker-modal').hasClass('kf-show')) closeColorPicker();
        else if (apiEntriesEditorOpen) closeApiEntriesEditor(state, rerender, setStatus);
    });

    $('.kf-theme-preset').off('click.kf').on('click.kf', function () {
        const presetKey = String($(this).data('preset') || 'default');
        const preset = THEME_PRESETS[presetKey] || THEME_PRESETS.default;
        $('#kf-theme-preset').val(presetKey);
        setThemeColorControlValue('kf-theme-underline', preset.primary);
        setThemeColorControlValue('kf-theme-bg-main', preset.secondary);
        $('#kf-theme-primary-hex').val(preset.primary.toUpperCase());
        $('#kf-theme-secondary-hex').val(preset.secondary.toUpperCase());
        $('.kf-theme-preset').removeClass('kf-active');
        $(this).addClass('kf-active');
        previewThemeFromControls();
    });
    $('.kf-theme-mode').off('click.kf').on('click.kf', function () {
        $('.kf-theme-mode').removeClass('kf-active');
        $(this).addClass('kf-active');
        previewThemeFromControls();
    });
    $('.kf-theme-quick-btn').off('click.kf').on('click.kf', function () {
        state.theme.mode = String($(this).data('themeMode') || '') === 'dark' ? 'dark' : 'light';
        applyTheme(state);
        persistNow(state);
        setStatus(state.theme.mode === 'dark' ? '已切换夜间模式' : '已切换白天模式');
    });
    $('#kf-theme-underline,#kf-theme-bg-main').off('input.kf change.kf').on('input.kf change.kf', function () {
        const isPrimary = this.id === 'kf-theme-underline';
        const color = normalizeHex($(this).val(), isPrimary ? '#1677ff' : '#ffffff');
        setThemeColorControlValue(this.id, color);
        $(isPrimary ? '#kf-theme-primary-hex' : '#kf-theme-secondary-hex').val(color.toUpperCase());
        $('#kf-theme-preset').val('custom');
        $('.kf-theme-preset').removeClass('kf-active');
        previewThemeFromControls();
    });
    $('#kf-theme-primary-hex,#kf-theme-secondary-hex').off('input.kf change.kf').on('input.kf change.kf', function (event) {
        const isPrimary = this.id === 'kf-theme-primary-hex';
        const fallback = isPrimary ? '#1677ff' : '#ffffff';
        const raw = String($(this).val() || '').trim();
        if (event.type === 'input' && !/^#[0-9a-f]{6}$/i.test(raw)) return;
        const color = normalizeHex(raw, fallback);
        $(this).val(color.toUpperCase());
        setThemeColorControlValue(isPrimary ? 'kf-theme-underline' : 'kf-theme-bg-main', color);
        $('#kf-theme-preset').val('custom');
        $('.kf-theme-preset').removeClass('kf-active');
        previewThemeFromControls();
    });
    $('#kf-theme-reset').off('click.kf').on('click.kf', function () {
        const preset = THEME_PRESETS.default;
        $('#kf-theme-preset').val('default');
        setThemeColorControlValue('kf-theme-underline', preset.primary);
        setThemeColorControlValue('kf-theme-bg-main', preset.secondary);
        $('#kf-theme-primary-hex').val(preset.primary.toUpperCase());
        $('#kf-theme-secondary-hex').val(preset.secondary.toUpperCase());
        $('.kf-theme-preset').removeClass('kf-active').filter('[data-preset="default"]').addClass('kf-active');
        $('.kf-theme-mode').removeClass('kf-active').filter('[data-theme-mode="light"]').addClass('kf-active');
        previewThemeFromControls();
    });
    $('#kf-failure-retry-count,#kf-failure-retry-delay,#kf-failure-alert-enabled,#kf-model-alert-enabled,#kf-shortcut-mode-enabled,#kf-shortcut-power-enabled,#kf-shortcut-api-enabled,#kf-compact-api-entries').off('input.kf change.kf').on('input.kf change.kf', function () {
        if (this.id === 'kf-failure-retry-delay' && toInt($(this).val()) === 0) {
            showToast('间隔次数过短可能会触发上限，请注意', 'warning', 3600);
        }
    });
    $('#kf-floating-action').off('change.kf').on('change.kf', function () {
        const matchingQrToggle = {
            mode: '#kf-shortcut-mode-enabled',
            power: '#kf-shortcut-power-enabled',
            api: '#kf-shortcut-api-enabled',
        }[normalizeFloatingAction($(this).val())];
        if (matchingQrToggle) $(matchingQrToggle).prop('checked', false);
    });
    $('.kf-stepper-up,.kf-stepper-down').off('click.kf').on('click.kf', function () {
        const targetId = String($(this).data('stepperTarget') || 'kf-failure-retry-count');
        const input = $(`#${targetId}`);
        const delta = $(this).hasClass('kf-stepper-up') ? 1 : -1;
        const min = toInt(input.attr('min') || 0);
        const fallback = targetId === 'kf-failure-retry-delay' ? 3 : 1;
        const next = Math.max(min, toInt(input.val() || fallback) + delta);
        input.val(next).trigger('change');
    });
    $('#kf-global-toggle').off('click.kf').on('click.kf', function () {
        toggleGlobalEnabled(state, setStatus);
    });
}

export async function initUI(setStatus) {
    hoistModals();
    window.STKarmaFlip?.floatingCleanup?.();
    document.getElementById(FLOATING_ROOT_ID)?.remove();
    const state = loadState();
    const pool = getActivePool(state);
    let changed = false;
    if (!pool.entries.length) {
        addEntry(pool);
        changed = true;
    }
    if (changed) saveState(state, { persist: false });

    const rerender = (options = {}) => {
        applyTheme(state);
        renderPresetLists(state);
        renderPool(state);
        renderEntries(state);
        if (options.renderLogs) renderLogs(state);
        bind(state, rerender, setStatus);
        ensureFloatingButton(state, rerender, setStatus);
    };

    rerender();
    ensureChatShortcut(state, rerender, setStatus);
    observeChatShortcutHost(state, rerender, setStatus);
    observeMagicWandEntry();
    $(window).off('STKarmaFlip:logs-updated.kf').on('STKarmaFlip:logs-updated.kf', () => {
        if ($('#kf-log-modal').hasClass('kf-show')) renderLogs(state);
    });
    setTimeout(() => {
        uiPersistenceReady = true;
        enableStatePersistence();
    }, 800);
    setStatus('已加载');
}
