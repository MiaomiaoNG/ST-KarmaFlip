import { clearLogs, enableStatePersistence, getActivePool, getRuntimeScope, getUsageStats, loadState, patchActivePoolId, patchEnabledState, patchEntryCollapsedState, patchEntryEnabledState, patchPoolMode, saveState, saveStateDebounced, toInt } from './plugin_state_store.js';
import { makeId, nextFrame, replaceNode } from './compat.js';

const MODAL_IDS = ['kf-log-modal', 'kf-dropdown-modal', 'kf-theme-modal', 'kf-settings-modal', 'kf-failure-modal', 'kf-api-test-modal', 'kf-sequence-modal', 'kf-rename-pool-modal', 'kf-import-export-modal'];
const HOT_SAVE_DELAY = 1000;
const STRUCTURE_SAVE_DELAY = 5000;
const CHAT_SHORTCUT_WRAPPER_ID = 'kf-chat-toggle-wrapper';
const CHAT_POWER_BUTTON_ID = 'kf-chat-power-btn';
const CHAT_MODE_BUTTON_ID = 'kf-chat-mode-btn';
let uiPersistenceReady = false;
let chatShortcutRetryTimer = null;
let chatShortcutObserver = null;
const THEME_PRESETS = {
    default: { bgMain: '#ffffff', bgSub: '#f7f9fc', underline: '#617b9b' },
    'deep-space': { bgMain: '#1a1d24', bgSub: '#242831', underline: '#5c7c99' },
    'black-coffee': { bgMain: '#24211e', bgSub: '#302c28', underline: '#ad7c59' },
    'night-fir': { bgMain: '#1b211d', bgSub: '#242c26', underline: '#688e73' },
    'soft-dark': { bgMain: '#141414', bgSub: '#1f1f1f', underline: '#666666' },
};

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function contrastText(hex) {
    const clean = String(hex || '#ffffff').replace('#', '');
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return yiq >= 128 ? '#000000' : '#ffffff';
}

function hexToRgb(hex) {
    const clean = String(hex || '#617b9b').replace('#', '');
    const value = clean.length === 3
        ? clean.split('').map(x => x + x).join('')
        : clean.padEnd(6, '0').slice(0, 6);
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return [r, g, b].map(x => Number.isFinite(x) ? x : 0).join(', ');
}

function setThemeVars(target, theme) {
    if (!target) return;
    const underline = theme.underline || '#617b9b';
    target.style.setProperty('--bg-main', theme.bgMain || '#ffffff');
    target.style.setProperty('--bg-sub', theme.bgSub || '#f7f9fc');
    target.style.setProperty('--text-main', contrastText(theme.bgMain || '#ffffff'));
    target.style.setProperty('--text-sub', contrastText(theme.bgSub || '#f7f9fc'));
    target.style.setProperty('--text-accent', contrastText(underline));
    target.style.setProperty('--underline-color', underline);
    target.style.setProperty('--underline-rgb', hexToRgb(underline));
}

function applyBrush(root, style) {
    let blend = 'multiply';
    let opacity = '1';
    const resolvedStyle = ['simple', 'native'].includes(style) ? style : 'simple';
    root.style.setProperty('--brush-blend', blend);
    root.style.setProperty('--brush-opacity', opacity);
    root.dataset.brush = resolvedStyle;
    for (const target of MODAL_IDS.map(id => document.getElementById(id)).filter(Boolean)) {
        target.style.setProperty('--brush-blend', blend);
        target.style.setProperty('--brush-opacity', opacity);
        target.dataset.brush = resolvedStyle;
    }
    const toastLayer = document.getElementById('kf-toast-layer');
    if (toastLayer) toastLayer.dataset.brush = resolvedStyle;
    applyNativeClasses(resolvedStyle === 'native');
}

function applyNativeClasses(enabled) {
    const root = $('#kf-root');
    const modals = $('.kf-modal-overlay');
    const scope = root.add(modals);
    scope.find('.kf-action-btn').toggleClass('menu_button', enabled);
    scope.find('.kf-inner-input,.kf-inner-select,select,textarea,.kf-stepper-input').toggleClass('text_pole', enabled);
    modals.toggleClass('popup kf-native-popup', enabled);
}

function updateGlobalToggleState(state) {
    const enabled = state.enabled !== false;
    const toggle = $('#kf-global-toggle');
    toggle.toggleClass('kf-active', enabled);
    toggle.text(enabled ? '插件已开启' : '插件已关闭');
}

function updateModeState(state) {
    const pool = getActivePool(state);
    $('#kf-root').attr('data-mode', pool.mode);
    $('#kf-mode-fixed').prop('checked', pool.mode === 'fixed');
    $('#kf-mode-random').prop('checked', pool.mode === 'random');
    $('#kf-no-streak').prop('checked', !!pool.random?.noConsecutive);
}

function updateThemePresetVisibility(state) {
    const brush = state.theme?.brush === 'native' ? 'native' : 'simple';
    $('#kf-theme-preset-row').toggle(brush === 'simple');
}

function updateChatShortcut(state) {
    const modeEnabled = state.shortcuts?.modeEnabled !== false;
    const powerEnabled = state.shortcuts?.powerEnabled !== false;
    if (!modeEnabled && !powerEnabled) {
        document.getElementById(CHAT_SHORTCUT_WRAPPER_ID)?.remove();
        return;
    }
    const pool = getActivePool(state);
    const enabled = state.enabled !== false;
    const powerButton = $(`#${CHAT_POWER_BUTTON_ID}`);
    const modeButton = $(`#${CHAT_MODE_BUTTON_ID}`);
    if (!powerEnabled) powerButton.remove();
    if (!modeEnabled) modeButton.remove();
    if (powerButton.length) {
        powerButton.attr('data-enabled', enabled ? 'true' : 'false');
        powerButton.attr('title', enabled ? '点击关闭 KarmaFlip 插件' : '点击开启 KarmaFlip 插件');
        powerButton.attr('aria-label', `KarmaFlip 插件开关，当前${enabled ? '已启用' : '已关闭'}`);
        powerButton.html(emperorIcon());
    }
    if (modeButton.length) {
        modeButton.attr('data-mode', pool.mode === 'random' ? 'random' : 'fixed');
        modeButton.attr('title', `点击切换固定/随机，当前${pool.mode === 'random' ? '随机模式' : '固定模式'}`);
        modeButton.attr('aria-label', `KarmaFlip 模式切换，当前${pool.mode === 'random' ? '随机模式' : '固定模式'}`);
        modeButton.html(lotteryIcon());
    }
}

function getInlineReplyHost() {
    return document.querySelector('#qr--bar > .qr--buttons')
        || document.querySelector('.qr--buttons')
        || document.querySelector('#qr--bar');
}

function emperorIcon() {
    return `
        <div class="qr--button-label" aria-hidden="true">
            <svg class="kf-chat-shortcut-icon kf-chat-emperor-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" fill="none" stroke="currentColor" stroke-width="2.0" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="7" y1="3" x2="17" y2="3" />
                <line x1="12" y1="3" x2="12" y2="21" />
                <line x1="9.5" y1="7" x2="14.5" y2="7" />
                <path d="M 6.5 17 V 12.5 Q 6.5 11 8.5 11 H 15.5 Q 17.5 11 17.5 12.5 V 17" />
                <path d="M 12 13.5 Q 9.5 13.5 9.5 17 V 19.5" />
                <path d="M 12 13.5 Q 14.5 13.5 14.5 17 V 19.5" />
            </svg>
        </div>
    `;
}

function lotteryIcon() {
    return `
        <div class="qr--button-label" aria-hidden="true">
            <svg class="kf-chat-shortcut-icon kf-chat-lottery-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M 8.5 9 Q 12 7.5 15.5 9" fill="none" stroke="currentColor" stroke-width="1.5" />
                <line x1="10" y1="10" x2="7" y2="4" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
                <line x1="11" y1="10" x2="9.5" y2="2.5" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
                <line x1="14" y1="10" x2="16.5" y2="5" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
                <line x1="13" y1="10" x2="14.5" y2="3.5" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
                <line x1="12" y1="10" x2="12" y2="4" stroke="currentColor" stroke-width="1.5" stroke-linecap="butt" />
                <line class="kf-mode-accent kf-mode-accent-stroke" x1="12" y1="4" x2="12" y2="1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                <path d="M 8.5 9 Q 12 10.5 15.5 9 L 14.5 21 Q 12 22 9.5 21 Z" fill="var(--kf-shortcut-fill, transparent)" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
                <polygon class="kf-mode-accent kf-mode-accent-fill" points="12,13.5 13.5,15.5 12,17.5 10.5,15.5" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>
                <circle cx="12" cy="15.5" r="0.8" fill="var(--kf-shortcut-dot, Canvas)" />
            </svg>
        </div>
    `;
}

function ensureChatShortcut(state, rerender, setStatus) {
    const modeEnabled = state.shortcuts?.modeEnabled !== false;
    const powerEnabled = state.shortcuts?.powerEnabled !== false;
    if (!modeEnabled && !powerEnabled) {
        document.getElementById(CHAT_SHORTCUT_WRAPPER_ID)?.remove();
        return;
    }
    const host = getInlineReplyHost();
    if (!host) {
        if (!chatShortcutRetryTimer) {
            chatShortcutRetryTimer = window.setTimeout(() => {
                chatShortcutRetryTimer = null;
                ensureChatShortcut(state, rerender, setStatus);
            }, 1200);
        }
        return;
    }
    if (chatShortcutRetryTimer) {
        window.clearTimeout(chatShortcutRetryTimer);
        chatShortcutRetryTimer = null;
    }

    let wrapper = document.getElementById(CHAT_SHORTCUT_WRAPPER_ID);
    let powerShell = document.getElementById(CHAT_POWER_BUTTON_ID);
    let modeShell = document.getElementById(CHAT_MODE_BUTTON_ID);
    document.getElementById('kf-chat-toggle-btn')?.remove();
    if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.id = CHAT_SHORTCUT_WRAPPER_ID;
        wrapper.className = 'qr--buttons qr--color';
        wrapper.style.setProperty('--qr--color', 'rgba(0,0,0,0)');
    }
    if (powerEnabled && !powerShell) {
        powerShell = document.createElement('button');
        powerShell.id = CHAT_POWER_BUTTON_ID;
        powerShell.type = 'button';
        powerShell.className = 'remote-ctrl-btn qr--button menu_button interactable kf-chat-shortcut-btn';
    }
    if (modeEnabled && !modeShell) {
        modeShell = document.createElement('button');
        modeShell.id = CHAT_MODE_BUTTON_ID;
        modeShell.type = 'button';
        modeShell.className = 'remote-ctrl-btn qr--button menu_button interactable kf-chat-shortcut-btn';
    }
    if (!powerEnabled) powerShell?.remove();
    else if (powerShell.parentElement !== wrapper) wrapper.appendChild(powerShell);
    if (!modeEnabled) modeShell?.remove();
    else if (modeShell.parentElement !== wrapper) wrapper.appendChild(modeShell);
    if (wrapper.parentElement !== host) host.prepend(wrapper);
    bindChatShortcut(state, rerender, setStatus);
    updateChatShortcut(state);
}

function observeChatShortcutHost(state, rerender, setStatus) {
    if (chatShortcutObserver || typeof MutationObserver === 'undefined') return;
    chatShortcutObserver = new MutationObserver(() => {
        if (state.shortcuts?.modeEnabled === false && state.shortcuts?.powerEnabled === false) return;
        const wrapper = document.getElementById(CHAT_SHORTCUT_WRAPPER_ID);
        const host = getInlineReplyHost();
        if (!host || wrapper?.parentElement === host) return;
        ensureChatShortcut(state, rerender, setStatus);
    });
    chatShortcutObserver.observe(document.body, { childList: true, subtree: true });
}

function toggleGlobalEnabled(state, setStatus) {
    patchEnabledState(state, state.enabled === false);
    updateGlobalToggleState(state);
    updateChatShortcut(state);
    showToast(state.enabled !== false ? '[已开启插件] 陛下，该翻牌子了~' : '[已关闭插件] 传令！陛下今日不翻牌。', 'info', 2200);
    setStatus(state.enabled !== false ? '插件已开启' : '插件已关闭');
}

function setPoolMode(state, nextMode, rerender, setStatus) {
    const pool = getActivePool(state);
    const mode = nextMode === 'random' ? 'random' : 'fixed';
    if (pool.mode === mode) {
        updateModeState(state);
        updateChatShortcut(state);
        return;
    }
    patchPoolMode(state, mode);
    const equalized = maybeEqualizeWeights(state);
    updateModeState(state);
    updateChatShortcut(state);
    showToast(`切换成[${mode === 'random' ? '随机模式' : '固定模式'}] 太后让朕这个！`, 'info', 2200);
    setStatus(mode === 'random' ? '已切换到随机模式' : '已切换到固定模式');
    if (equalized) rerender();
}

function bindPressHold(area, options = {}) {
    let timer = null;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let longTriggered = false;
    const threshold = Number(options.threshold) || 560;
    const moveTolerance = Number(options.moveTolerance) || 8;
    const clear = () => {
        if (timer) window.clearTimeout(timer);
        timer = null;
        pointerId = null;
        area.removeClass('pressing-on pressing-off');
    };

    area.off('.kfHold');
    area.on('pointerdown.kfHold', function (event) {
        if (event.button && event.button !== 0) return;
        const active = typeof options.isActive === 'function' ? !!options.isActive() : false;
        pointerId = event.pointerId;
        startX = Number(event.clientX || 0);
        startY = Number(event.clientY || 0);
        longTriggered = false;
        area.addClass(active ? 'pressing-off' : 'pressing-on');
        area.get(0)?.setPointerCapture?.(event.pointerId);
        timer = window.setTimeout(() => {
            longTriggered = true;
            clear();
            options.onLong?.(event);
        }, threshold);
    });
    area.on('pointermove.kfHold', function (event) {
        if (pointerId !== event.pointerId) return;
        const movedX = Math.abs(Number(event.clientX || 0) - startX);
        const movedY = Math.abs(Number(event.clientY || 0) - startY);
        if (movedX > moveTolerance || movedY > moveTolerance) clear();
    });
    area.on('pointerup.kfHold', function (event) {
        if (pointerId !== null && pointerId !== event.pointerId) return;
        const shouldRunShort = !longTriggered;
        clear();
        if (shouldRunShort) options.onShort?.(event);
    });
    area.on('pointercancel.kfHold pointerleave.kfHold', function (event) {
        if (pointerId !== null && pointerId !== event.pointerId) return;
        clear();
    });
}

function bindChatShortcut(state, rerender, setStatus) {
    const powerButton = $(`#${CHAT_POWER_BUTTON_ID}`);
    const modeButton = $(`#${CHAT_MODE_BUTTON_ID}`);
    powerButton.off('.kfShortcut').on('click.kfShortcut', function (event) {
        event.preventDefault();
        event.stopPropagation();
        toggleGlobalEnabled(state, setStatus);
    });
    modeButton.off('.kfShortcut').on('click.kfShortcut', function (event) {
        event.preventDefault();
        event.stopPropagation();
        const pool = getActivePool(state);
        setPoolMode(state, pool.mode === 'random' ? 'fixed' : 'random', rerender, setStatus);
    });
}

function applyTheme(state) {
    const root = document.getElementById('kf-root');
    if (!root) return;
    const theme = state.theme || {};
    const targets = [root, ...MODAL_IDS.map(id => document.getElementById(id)), document.getElementById('kf-toast-layer')].filter(Boolean);
    for (const target of targets) setThemeVars(target, theme);
    applyBrush(root, theme.brush || 'simple');

    $('#kf-theme-bg-main').val(theme.bgMain || '#ffffff');
    $('#kf-theme-bg-sub').val(theme.bgSub || '#f7f9fc');
    $('#kf-theme-underline').val(theme.underline || '#617b9b');
    const resolvedBrush = ['simple', 'native'].includes(theme.brush) ? theme.brush : 'simple';
    $('#kf-theme-brush').val(resolvedBrush);
    $('#kf-theme-preset').val(String(theme.preset || 'default'));
    $('#kf-failure-retry-count').val(Math.max(1, toInt(state.failure?.retryCount || 3)));
    $('#kf-failure-retry-delay').val(toInt(state.failure?.retryDelaySeconds ?? 3));
    $('#kf-failure-alert-enabled').prop('checked', !!state.failure?.alertEnabled);
    $('#kf-model-alert-enabled').prop('checked', !!state.failure?.modelAlertEnabled);
    $('#kf-shortcut-mode-enabled').prop('checked', state.shortcuts?.modeEnabled !== false);
    $('#kf-shortcut-power-enabled').prop('checked', state.shortcuts?.powerEnabled !== false);
    updateThemePresetVisibility(state);
    updateChatShortcut(state);
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
        provider: String(entry?.provider || 'open'),
        model: String(entry?.model || ''),
        fixedRuns: Math.max(1, toInt(entry?.fixedRuns || 1)),
        weight: toInt(entry?.weight || 0),
        pityTurns: toInt(entry?.pityTurns || 0),
        cooldownTurns: toInt(entry?.cooldownTurns || 0),
        collapsed: !!entry?.collapsed,
        modelOptions: Array.isArray(entry?.modelOptions) ? entry.modelOptions.map(x => String(x)).filter(Boolean) : [],
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
    target.provider = preset.provider || 'open';
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
        provider: String(entry.provider || 'open'),
        model: String(entry.model || ''),
    };
}

function copyPresetForImport(entry) {
    return copyEntryForPreset({
        enabled: entry?.enabled !== false,
        name: String(entry?.name || ''),
        apiUrl: String(entry?.apiUrl || entry?.url || ''),
        key: String(entry?.key || ''),
        provider: String(entry?.provider || 'open'),
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
        preset.modelOptions = Array.isArray(state.apiPresets[index].modelOptions) ? [...state.apiPresets[index].modelOptions] : [];
        state.apiPresets[index] = preset;
    } else {
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
        ['open', 'OpenAI 兼容'],
        ['openai', 'Open AI 官方'],
        ['gemini', 'Gemini 官方'],
        ['deepseek', 'Deepseek官方'],
    ];
    const selected = options.find(([value]) => value === entry.provider)?.[1] || options[0][1];
    return `
        <div class="kf-select-wrapper kf-provider-wrapper kf-two-strokes kf-accent-fill kf-flex-3">
            <input type="text" class="kf-inner-select kf-dropdown-input kf-entry-provider-display" value="${esc(selected)}" data-provider="${esc(entry.provider || 'open')}" readonly>
            <button class="kf-dropdown-arrow kf-entry-provider-arrow" type="button">▼</button>
        </div>
    `;
}

function providerOptions() {
    return [
        { value: 'open', label: 'OpenAI 兼容' },
        { value: 'openai', label: 'Open AI 官方' },
        { value: 'gemini', label: 'Gemini 官方' },
        { value: 'deepseek', label: 'Deepseek官方' },
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
    const label = isCollapsed ? '展开 API 条目' : '折叠 API 条目';
    button.attr('aria-label', label);
    button.attr('title', label);
    button.html(fanIcon(!isCollapsed));
}

function trashIcon() {
    return `<svg class="kf-trash-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 7 H20"/>
        <path d="M10 7 V5 H14 V7"/>
        <path d="M7 7 L8 20 H16 L17 7"/>
        <path d="M10 11 V17"/>
        <path d="M14 11 V17"/>
    </svg>`;
}

function renderEntries(state) {
    const pool = getActivePool(state);
    const root = $('#kf-entry-list').empty();
    const apiPresetNames = getApiPresetNames(state);

    for (const entry of pool.entries || []) {
        const enabledChecked = entry.enabled !== false ? 'checked' : '';
        const collapsed = !!entry.collapsed;
        const collapsedClass = collapsed ? ' kf-collapsed' : '';
        const collapseIcon = fanIcon(!collapsed);
        const collapseLabel = collapsed ? '展开 API 条目' : '折叠 API 条目';
        const nameHasOptions = apiPresetNames.some(name => name !== entry.name);
        const modelHasOptions = getModelOptions(entry).some(model => model !== entry.model);
        const nameArrow = nameHasOptions ? '<button class="kf-dropdown-arrow kf-entry-name-arrow" type="button">▼</button>' : '';
        const modelArrow = modelHasOptions ? '<button class="kf-dropdown-arrow kf-entry-model-arrow" type="button">▼</button>' : '';
        root.append(`
            <div class="kf-entry-block${collapsedClass}" data-id="${esc(entry.id)}">
                <div class="kf-row kf-entry-row-top">
                    <label class="kf-toggle-chip kf-entry-enabled-wrap">
                        <input type="checkbox" class="kf-entry-enabled" ${enabledChecked}>
                        <span class="kf-check-box"></span>
                        <span class="kf-check-text kf-accent-fill">启用</span>
                    </label>
                    <div class="kf-input-wrapper kf-entry-name-wrap"><span class="kf-label">名称</span><input type="text" class="kf-inner-input kf-dropdown-input kf-entry-name" value="${esc(entry.name)}" placeholder="API 名称">${nameArrow}</div>
                    <button class="kf-icon-btn kf-collapse" type="button" aria-label="${collapseLabel}" title="${collapseLabel}">${collapseIcon}</button>
                    <button class="kf-icon-btn kf-del" type="button" aria-label="删除 API 条目" title="删除 API 条目">${trashIcon()}</button>
                </div>
                <div class="kf-row kf-entry-details">
                    <div class="kf-input-wrapper kf-flex-7"><span class="kf-label">URL</span><input type="text" class="kf-inner-input kf-entry-url" value="${esc(entry.apiUrl)}" placeholder="https://api.openai.com/v1"></div>
                    ${providerSelect(entry)}
                </div>
                <div class="kf-row kf-entry-details">
                    <div class="kf-input-wrapper kf-flex-1 kf-entry-key-wrap">
                        <span class="kf-label">KEY</span>
                        <input type="password" class="kf-inner-input kf-entry-key" value="${esc(entry.key)}">
                        <button class="kf-eye-btn kf-key-eye" type="button" aria-label="显示 KEY" title="显示 KEY">
                            <i class="fa-regular fa-eye"></i>
                        </button>
                    </div>
                    <button class="kf-action-btn kf-accent-fill kf-test-api" type="button">测试</button>
                </div>
                <div class="kf-row kf-entry-details">
                    <div class="kf-input-wrapper kf-flex-1"><span class="kf-label">模型</span><input type="text" class="kf-inner-input kf-dropdown-input kf-entry-model" value="${esc(entry.model)}">${modelArrow}</div>
                    <button class="kf-action-btn kf-accent-fill kf-fetch-models">拉取模型</button>
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

function formatLog(log) {
    const event = String(log.event || '');
    const type = event === 'pick'
        ? '抽选记录'
        : (log.success === false || event.includes('error') ? '发送报错' : '发送结果');
    const date = new Date(log.time);
    const pad = value => String(value).padStart(2, '0');
    const timestamp = [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
    ].join('-') + ' ' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join(':');
    const parts = [
        log.event || 'unknown',
        log.trigger || '',
        log.mode || '',
        log.apiName || '',
        log.model || '',
        log.success === false ? '失败' : '成功',
    ].filter(Boolean);
    const status = log.status ? `HTTP ${log.status}` : '';
    const error = log.error ? String(log.error) : '';
    const detail = log.detail ? String(log.detail) : '';
    return `[${type}][${timestamp}]${parts.join(' - ')}${status ? ` - ${status}` : ''}${error ? ` - ${error}` : ''}${detail ? ` - ${detail}` : ''}`;
}

function formatUsageStat(stat) {
    const date = new Date(stat.lastTime);
    const pad = value => String(value).padStart(2, '0');
    const timestamp = Number.isNaN(date.getTime())
        ? String(stat.lastTime || '')
        : [
            date.getFullYear(),
            pad(date.getMonth() + 1),
            pad(date.getDate()),
        ].join('-') + ' ' + [pad(date.getHours()), pad(date.getMinutes())].join(':');
    return `[${stat.apiName || '未命名'}] [${stat.model || '未填模型'}] 调取次数(包括固定和随机模式) - ${stat.count || 0} - ${timestamp}`;
}

function currentLogFilter() {
    return $('.kf-log-filter.kf-active').data('filter') || 'all';
}

function renderLogs(state, filter = currentLogFilter()) {
    const source = loadState();
    let lines = [];
    if (filter === 'stats') {
        lines = getUsageStats().slice(0, 50).map(formatUsageStat);
    } else {
        const logs = [...(source.logs || [])].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
        const filtered = logs.filter(log => {
            if (filter === 'error') return log.success === false || String(log.event || '').includes('error');
            if (filter === 'pick') return ['pick', 'request'].includes(log.event);
            return String(log.event || '') !== 'stats';
        });
        lines = filtered.slice(-50).map(formatLog);
    }
    const logBox = $('#kf-logs-list');
    logBox.text(lines.join('\n'));
    const node = logBox.get(0);
    if (node) {
        nextFrame(() => {
            node.scrollTop = node.scrollHeight;
        });
    }
}

function syncEntryFromRow(entry, row) {
    const previousName = String(entry.name || '').trim();
    entry.enabled = row.find('.kf-entry-enabled').prop('checked');
    entry.name = String(row.find('.kf-entry-name').val() || '');
    if (!entry.presetId && previousName && previousName !== String(entry.name || '').trim()) entry._previousPresetName = previousName;
    entry.provider = String(row.find('.kf-entry-provider-display').data('provider') || 'open');
    entry.apiUrl = String(row.find('.kf-entry-url').val() || '');
    entry.key = String(row.find('.kf-entry-key').val() || '');
    entry.model = String(row.find('.kf-entry-model').val() || '');
    entry.fixedRuns = Math.max(1, toInt(row.find('.kf-entry-fixed-runs').val() || 1));
    entry.weight = toInt(row.find('.kf-entry-weight').val());
    entry.pityTurns = toInt(row.find('.kf-entry-pity').val());
    entry.cooldownTurns = toInt(row.find('.kf-entry-cooldown').val());
    entry.collapsed = row.hasClass('kf-collapsed');
}

function syncAllEntries(state) {
    const pool = getActivePool(state);
    $('#kf-entry-list .kf-entry-block').each(function () {
        const id = $(this).data('id');
        const entry = pool.entries.find(e => e.id === id);
        if (entry) syncEntryFromRow(entry, $(this));
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
    state.theme.bgMain = $('#kf-theme-bg-main').val();
    state.theme.bgSub = $('#kf-theme-bg-sub').val();
    state.theme.underline = $('#kf-theme-underline').val();
    const brush = String($('#kf-theme-brush').val() || 'simple');
    state.theme.brush = ['simple', 'native'].includes(brush) ? brush : 'simple';
    state.theme.preset = String($('#kf-theme-preset').val() || 'default');
}

function applyThemePreset(state, presetKey) {
    const preset = THEME_PRESETS[presetKey] || THEME_PRESETS.default;
    state.theme.bgMain = preset.bgMain;
    state.theme.bgSub = preset.bgSub;
    state.theme.underline = preset.underline;
    state.theme.preset = presetKey in THEME_PRESETS ? presetKey : 'default';
}

function syncFailureFromControls(state) {
    state.failure.retryCount = Math.max(1, toInt($('#kf-failure-retry-count').val() || 3));
    state.failure.retryDelaySeconds = toInt($('#kf-failure-retry-delay').val() ?? 3);
    state.failure.alertEnabled = $('#kf-failure-alert-enabled').prop('checked');
    state.failure.modelAlertEnabled = $('#kf-model-alert-enabled').prop('checked');
    state.shortcuts = state.shortcuts || {};
    state.shortcuts.modeEnabled = $('#kf-shortcut-mode-enabled').prop('checked');
    state.shortcuts.powerEnabled = $('#kf-shortcut-power-enabled').prop('checked');
}

function syncAllFromControls(state) {
    syncPoolFromControls(state);
    syncAllEntries(state);
    syncThemeFromControls(state);
    syncFailureFromControls(state);
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

function saveFailureSettingsFromModal(state, setStatus) {
    syncFailureFromControls(state);
    if (toInt(state.failure?.retryDelaySeconds) === 0) {
        showToast('间隔次数过短可能会触发上限，请注意', 'warning', 3600);
    }
    persistNow(state);
    closeModal('kf-settings-modal');
    setStatus('请求设置已保存');
}

function entryReady(entry, mode) {
    return entry &&
        entry.enabled !== false &&
        String(entry.apiUrl || '').trim() &&
        String(entry.key || '').trim() &&
        String(entry.model || '').trim() &&
        (mode !== 'random' || toInt(entry.weight) > 0);
}

function buildFixedPreview(entries, avoidConsecutive) {
    const expanded = [];
    for (const entry of entries) {
        const runs = Math.max(1, toInt(entry.fixedRuns || 1));
        for (let i = 0; i < runs; i += 1) expanded.push(entry);
    }
    if (!avoidConsecutive || expanded.length < 2) return expanded;
    const buckets = entries.map(entry => ({ entry, left: Math.max(1, toInt(entry.fixedRuns || 1)) }));
    const result = [];
    let remaining = buckets.reduce((sum, bucket) => sum + bucket.left, 0);
    while (remaining > 0) {
        let progressed = false;
        for (const bucket of buckets) {
            if (bucket.left <= 0) continue;
            const last = result[result.length - 1];
            if (last?.id === bucket.entry.id && buckets.some(item => item.left > 0 && item.entry.id !== bucket.entry.id)) {
                continue;
            }
            result.push(bucket.entry);
            bucket.left -= 1;
            remaining -= 1;
            progressed = true;
        }
        if (!progressed) break;
    }
    return result;
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
    syncAllEntries(state);
    const pool = getActivePool(state);
    const runtime = getRuntimeScope(state);
    const mode = pool.mode === 'random' ? 'random' : 'fixed';
    const entries = (pool.entries || []).filter(entry => entryReady(entry, mode) && !runtime.disabledByFailure?.[entry.id]);
    const summary = `${mode === 'random' ? '随机模式' : '固定模式'} ${pool.random?.noConsecutive ? '已勾选连续' : '未勾选连续'}`;
    if (!entries.length) {
        openSequenceModal(summary, ['当前组合没有可用于检测的 API 条目']);
        return;
    }
    if (mode === 'fixed') {
        const sequence = buildFixedPreview(entries, !!pool.random?.noConsecutive);
        const cursor = sequence.length ? toInt(runtime.fixedCursor) % sequence.length : 0;
        const preview = sequence.slice(cursor).concat(sequence.slice(0, cursor));
        openSequenceModal(summary, preview.map((entry, index) => `${index + 1}. ${sequenceLabel(entry)}`));
        return;
    }
    const lastId = runtime.lastPick?.memberId;
    const active = entries;
    if (!active.length) {
        openSequenceModal(summary, ['当前可用条目已被失败流程临时停用']);
        return;
    }
    let candidates = active.filter(entry => {
        const onCooldown = toInt(runtime.cooldowns?.[entry.id]) > 0;
        const streakBlocked = pool.random?.noConsecutive && lastId === entry.id && active.length > 1;
        return !onCooldown && !streakBlocked;
    });
    if (!candidates.length) {
        candidates = active.filter(entry => !(pool.random?.noConsecutive && lastId === entry.id && active.length > 1));
        if (!candidates.length) candidates = active;
    }
    const candidateIds = new Set(candidates.map(entry => entry.id));
    const usable = candidates.length ? candidates : active;
    const total = usable.reduce((sum, entry) => sum + toInt(entry.weight), 0);
    const rows = active.map(entry => {
        const cooldown = toInt(runtime.cooldowns?.[entry.id]);
        if (cooldown > 0) return `${sequenceLabel(entry)} 冷却中 详情：冷却还剩 ${cooldown} 回合`;
        const blockedByStreak = pool.random?.noConsecutive && lastId === entry.id && active.length > 1 && !candidateIds.has(entry.id);
        if (blockedByStreak) return `${sequenceLabel(entry)} 详情：避免连续，本轮暂不参与`;
        const percent = total > 0 && candidateIds.has(entry.id) ? Math.round((toInt(entry.weight) / total) * 100) : 0;
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
    setStatus(`已导入 ${result.pools} 个组合，${result.presets} 个 API 条目`);
}

function closeModal(id) {
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
    const state = loadState();
    const root = document.getElementById('kf-root');
    const resolvedBrush = root?.dataset?.brush || state.theme?.brush || 'simple';
    layer.get(0).dataset.brush = ['simple', 'native'].includes(resolvedBrush) ? resolvedBrush : 'simple';
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

function isMobileWidth() {
    return window.matchMedia?.('(max-width: 650px)')?.matches || window.innerWidth <= 650;
}

function closeDropdown() {
    $('#kf-dropdown-modal').removeClass('kf-show');
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
    const box = $('#kf-mobile-options').empty();
    for (const option of unique) {
        const deleteButton = config.deletable
            ? '<button class="kf-option-delete kf-action-btn kf-accent-fill" type="button">删除</button>'
            : '';
        if (config.deletable) {
            box.append(`<div class="kf-mobile-option-row" data-value="${esc(option.value)}">${deleteButton}<button class="kf-mobile-option kf-option-label kf-option-name" type="button" data-value="${esc(option.value)}">${esc(option.label)}</button></div>`);
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
    openOptionPicker(input, options, '选择 API 设定', (name) => {
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

async function fetchOpenAICompatibleModels(entry) {
    if (!entry.apiUrl) throw new Error('请先填写 URL');
    if (!entry.key) throw new Error('请先填写 KEY');
    const context = window.SillyTavern?.getContext?.() || {};
    const requestHeaders = typeof context.getRequestHeaders === 'function'
        ? context.getRequestHeaders()
        : { 'Content-Type': 'application/json' };
    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: {
            ...requestHeaders,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            chat_completion_source: 'openai',
            reverse_proxy: normalizeBaseUrl(entry.apiUrl),
            proxy_password: entry.key,
        }),
    });
    if (!response.ok) {
        throw new Error(`获取模型失败：HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (payload?.error) throw new Error('获取模型失败：接口返回错误');
    const models = Array.isArray(payload?.data)
        ? payload.data.map(item => String(item?.id || '')).filter(Boolean)
        : [];
    if (!models.length) throw new Error('获取模型失败：返回结果没有 data[].id');
    entry.modelOptions = models;
    if (!entry.model) entry.model = models[0];
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

async function testOpenAICompatibleEntry(entry) {
    if (!entry.apiUrl) throw new Error('请先填写 URL');
    if (!entry.key) throw new Error('请先填写 KEY');
    if (!['open', 'openai', 'deepseek'].includes(entry.provider || 'open')) {
        throw new Error(`暂不支持接口类型：${entry.provider || 'unknown'}`);
    }
    const context = window.SillyTavern?.getContext?.() || {};
    const requestHeaders = typeof context.getRequestHeaders === 'function'
        ? context.getRequestHeaders()
        : { 'Content-Type': 'application/json' };
    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: {
            ...requestHeaders,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            chat_completion_source: 'openai',
            reverse_proxy: normalizeBaseUrl(entry.apiUrl),
            proxy_password: entry.key,
        }),
    });
    const body = await readResponseText(response);
    const payload = parseMaybeJson(body);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}${body ? `\n${body}` : ''}`);
    }
    const failure = statusFailureMessage(payload, body);
    if (failure) throw new Error(failure);
    const models = Array.isArray(payload?.data)
        ? payload.data.map(item => String(item?.id || '')).filter(Boolean)
        : [];
    const ok = payload === true || payload?.ok === true || payload?.success === true || payload?.result === true || payload?.online === true || payload?.connected === true || models.length > 0;
    if (!ok) {
        return {
            status: response.status,
            models,
            body: body || '状态接口返回空内容',
            uncertain: true,
        };
    }
    return {
        status: response.status,
        models,
        body: body || responsePreview(payload),
    };
}

function showApiTestResult(ok, message, detail = '') {
    $('#kf-api-test-status')
        .toggleClass('kf-success', !!ok)
        .toggleClass('kf-error', !ok)
        .text(message || (ok ? '测试成功' : '测试失败'));
    $('#kf-api-test-detail').text(detail || '');
    $('#kf-api-test-modal').addClass('kf-show');
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
        getActivePool(state).random.noConsecutive = $(this).prop('checked');
        persistStructure(state);
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
        syncEntryFromRow(entry, row);
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
        syncEntryFromRow(entry, row);
        persistStructure(state);
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
        syncEntryFromRow(entry, row);
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
    $('#kf-entry-list').on('click.kf', '.kf-entry-provider-display,.kf-entry-provider-arrow', function (event) {
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
        entry.provider = option.value;
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
        const reveal = input.attr('type') === 'password';
        input.attr('type', reveal ? 'text' : 'password');
        button.attr('aria-label', reveal ? '隐藏 KEY' : '显示 KEY');
        button.attr('title', reveal ? '隐藏 KEY' : '显示 KEY');
        button.html(`<i class="fa-regular ${reveal ? 'fa-eye-slash' : 'fa-eye'}"></i>`);
    });
    $('#kf-entry-list').on('click.kf', '.kf-collapse', function (event) {
        event.preventDefault();
        event.stopPropagation();
        const pool = getActivePool(state);
        const row = $(this).closest('.kf-entry-block');
        const entryId = String(row.data('id') || '');
        const entry = pool.entries.find(e => e.id === entryId);
        if (!entry) return;
        const nextCollapsed = !entry.collapsed;
        patchEntryCollapsedState(state, pool.id, entryId, nextCollapsed);
        updateEntryCollapsedRow(row, nextCollapsed);
    });
    $('#kf-entry-list').on('click.kf', '.kf-del', function () {
        const pool = getActivePool(state);
        const id = $(this).closest('.kf-entry-block').data('id');
        const entry = pool.entries.find(e => e.id === id);
        if (!entry || !deleteSavedApiEntry(state, entry)) {
            pool.entries = pool.entries.filter(e => e.id !== id);
        }
        persistStructure(state);
        rerender();
    });
    bindEntryDragSort(state, rerender, setStatus);
    $('#kf-entry-list').on('click.kf', '.kf-fetch-models', async function () {
        const pool = getActivePool(state);
        const row = $(this).closest('.kf-entry-block');
        const entry = pool.entries.find(e => e.id === row.data('id'));
        if (!entry) return;
        syncEntryFromRow(entry, row);
        if (entry.provider !== 'open' && entry.provider !== 'openai' && entry.provider !== 'deepseek') {
            return setStatus('当前仅支持 OpenAI-compatible 获取模型');
        }
        try {
            const models = await fetchOpenAICompatibleModels(entry);
            rerender();
            setStatus(`已获取 ${models.length} 个模型`);
        } catch (error) {
            const message = error?.message || '获取模型失败';
            setStatus(message);
            showToast(message, 'error');
        }
    });
    $('#kf-entry-list').on('click.kf', '.kf-test-api', async function () {
        const pool = getActivePool(state);
        const row = $(this).closest('.kf-entry-block');
        const entry = pool.entries.find(e => e.id === row.data('id'));
        if (!entry) return;
        syncEntryFromRow(entry, row);
        const button = $(this);
        button.prop('disabled', true).text('测试中');
        try {
            const result = await testOpenAICompatibleEntry(entry);
            showApiTestResult(
                !result.uncertain,
                `${result.uncertain ? '状态未确认' : '连接成功'}：HTTP ${result.status}`,
                result.models.length ? `可用模型数：${result.models.length}\n${result.models.join('\n')}` : result.body,
            );
            setStatus(result.uncertain ? 'API连通状态未确认' : 'API连通测试成功');
        } catch (error) {
            const message = String(error?.message || error || '测试失败');
            showApiTestResult(false, '连接失败', message);
            setStatus('API连通测试失败');
        } finally {
            button.prop('disabled', false).text('测试');
        }
    });

    $('#kf-btn-settings').off('click.kf').on('click.kf', () => $('#kf-settings-modal').addClass('kf-show'));
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
    $('.kf-log-filter').off('click.kf').on('click.kf', function () {
        $('.kf-log-filter').removeClass('kf-active');
        $(this).addClass('kf-active');
        renderLogs(state, String($(this).data('filter') || 'all'));
    });
    $('#kf-btn-theme').off('click.kf').on('click.kf', () => $('#kf-theme-modal').addClass('kf-show'));
    $('#kf-theme-close,#kf-theme-cancel').off('click.kf').on('click.kf', () => closeModal('kf-theme-modal'));
    $('#kf-settings-close,#kf-settings-cancel').off('click.kf').on('click.kf', () => closeModal('kf-settings-modal'));
    $('#kf-theme-confirm').off('click.kf').on('click.kf', () => saveThemeFromModal(state, setStatus));
    $('#kf-settings-confirm').off('click.kf').on('click.kf', () => saveFailureSettingsFromModal(state, setStatus));
    $('#kf-api-test-close').off('click.kf').on('click.kf', () => closeModal('kf-api-test-modal'));
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
            if (event.target === this) $(this).removeClass('kf-show');
        });
    $('.kf-modal-overlay .kf-modal-box').not('#kf-failure-modal .kf-modal-box').off('pointerdown.kf mousedown.kf touchstart.kf click.kf')
        .on('pointerdown.kf mousedown.kf touchstart.kf click.kf', function (event) {
            event.stopPropagation();
        });
    $(document).off('mousedown.kfDropdown').on('mousedown.kfDropdown', function (event) {
        if ($(event.target).closest('#kf-dropdown-modal,.kf-dropdown-input').length) return;
        closeDropdown();
    });

    $('#kf-theme-brush').off('input.kf change.kf').on('input.kf change.kf', function () {
        syncThemeFromControls(state);
        updateThemePresetVisibility(state);
        applyTheme(state);
        persistStructure(state);
    });
    $('#kf-theme-preset').off('change.kf').on('change.kf', function () {
        const presetKey = String($(this).val() || 'default');
        applyThemePreset(state, presetKey);
        applyTheme(state);
        persistStructure(state);
    });
    $('#kf-theme-bg-main,#kf-theme-bg-sub,#kf-theme-underline').off('input.kf change.kf').on('input.kf change.kf', function () {
        syncThemeFromControls(state);
        state.theme.preset = 'default';
        $('#kf-theme-preset').val('default');
        applyTheme(state);
        persistStructure(state);
    });
    $('#kf-failure-retry-count,#kf-failure-retry-delay,#kf-failure-alert-enabled,#kf-model-alert-enabled,#kf-shortcut-mode-enabled,#kf-shortcut-power-enabled').off('input.kf change.kf').on('input.kf change.kf', function () {
        syncFailureFromControls(state);
        if (this.id === 'kf-failure-retry-delay' && toInt($(this).val()) === 0) {
            showToast('间隔次数过短可能会触发上限，请注意', 'warning', 3600);
        }
        if (state.shortcuts?.modeEnabled === false && state.shortcuts?.powerEnabled === false) updateChatShortcut(state);
        else ensureChatShortcut(state, rerender, setStatus);
        persistStructure(state);
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
    };

    rerender();
    ensureChatShortcut(state, rerender, setStatus);
    observeChatShortcutHost(state, rerender, setStatus);
    $(window).off('STKarmaFlip:logs-updated.kf').on('STKarmaFlip:logs-updated.kf', () => {
        if ($('#kf-log-modal').hasClass('kf-show')) renderLogs(state);
    });
    setTimeout(() => {
        uiPersistenceReady = true;
        enableStatePersistence();
    }, 800);
    setStatus('已加载');
}
