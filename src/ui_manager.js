import { enableStatePersistence, getActivePool, loadState, saveState, saveStateDebounced, toInt } from './plugin_state_store.js';

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

function silenceLongPressTransition() {
    const longPress = $('#kf-long-press');
    if (!longPress.length) return;
    longPress.addClass('kf-silent-state');
    window.clearTimeout(longPress.data('kfSilentTimer'));
    longPress.data('kfSilentTimer', window.setTimeout(() => {
        longPress.removeClass('kf-silent-state');
    }, 80));
}

function applyBrush(root, style) {
    let blend = 'multiply';
    let opacity = '1';
    const resolvedStyle = style === 'simple' ? 'simple' : 'marker';
    root.style.setProperty('--brush-blend', blend);
    root.style.setProperty('--brush-opacity', opacity);
    root.dataset.brush = resolvedStyle;
    for (const target of [document.getElementById('theme-modal'), document.getElementById('logModal'), document.getElementById('dropdownModal'), document.getElementById('settings-modal'), document.getElementById('failure-modal')].filter(Boolean)) {
        target.style.setProperty('--brush-blend', blend);
        target.style.setProperty('--brush-opacity', opacity);
        target.dataset.brush = resolvedStyle;
    }
}

function applyTheme(state) {
    const root = document.getElementById('kf-root');
    if (!root) return;
    silenceLongPressTransition();
    const theme = state.theme || {};
    const targets = [root, document.getElementById('theme-modal'), document.getElementById('logModal'), document.getElementById('dropdownModal'), document.getElementById('settings-modal'), document.getElementById('failure-modal')].filter(Boolean);
    for (const target of targets) {
        const underline = theme.underline || '#617b9b';
        target.style.setProperty('--bg-main', theme.bgMain || '#ffffff');
        target.style.setProperty('--bg-sub', theme.bgSub || '#f7f9fc');
        target.style.setProperty('--text-main', contrastText(theme.bgMain || '#ffffff'));
        target.style.setProperty('--text-sub', contrastText(theme.bgSub || '#f7f9fc'));
        target.style.setProperty('--text-accent', contrastText(underline));
        target.style.setProperty('--underline-color', underline);
        target.style.setProperty('--underline-rgb', hexToRgb(underline));
        target.style.setProperty('--marker-blur', `${theme.blur || '0.6'}px`);
    }
    applyBrush(root, theme.brush || 'marker');

    $('#kf-theme-bg-main').val(theme.bgMain || '#ffffff');
    $('#kf-theme-bg-sub').val(theme.bgSub || '#f7f9fc');
    $('#kf-theme-underline').val(theme.underline || '#617b9b');
    $('#kf-theme-blur').val(theme.blur || '0.6');
    $('#kf-theme-brush').val(theme.brush === 'simple' ? 'simple' : 'marker');
    const simple = theme.brush === 'simple';
    $('#kf-theme-blur-row').toggle(!simple);
    $('#kf-theme-blur').prop('disabled', simple);
    $('#kf-failure-retry-count').val(Math.max(1, toInt(state.failure?.retryCount || 3)));
    $('#kf-failure-alert-enabled').prop('checked', !!state.failure?.alertEnabled);
}

function mkPool(name = null) {
    return {
        id: `pool_${crypto.randomUUID()}`,
        name: name || `新组合_${new Date().toLocaleTimeString()}`,
        mode: 'fixed',
        enabled: true,
        random: { noConsecutive: false },
        entries: [],
    };
}

function clonePool(pool) {
    const p = JSON.parse(JSON.stringify(pool));
    p.id = `pool_${crypto.randomUUID()}`;
    p.name = `${pool.name}_副本`;
    p.entries = p.entries.map(e => ({ ...e, id: `e_${crypto.randomUUID()}` }));
    return p;
}

function addEntry(pool) {
    pool.entries.push({
        id: `e_${crypto.randomUUID()}`,
        enabled: true,
        name: 'New API',
        apiUrl: '',
        key: '',
        provider: 'open',
        model: '',
        fixedRuns: 1,
        weight: 1,
        pityTurns: 0,
        cooldownTurns: 0,
        modelOptions: [],
    });
}

function savedApiEntries(state) {
    const map = new Map();
    for (const preset of state.apiPresets || []) {
        const name = String(preset.name || '').trim();
        if (name && !map.has(name)) map.set(name, preset);
    }
    for (const pool of state.pools || []) {
        for (const entry of pool.entries || []) {
            const name = String(entry.name || '').trim();
            if (name && !map.has(name)) map.set(name, entry);
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

function getApiPresetNames(state) {
    return savedApiEntries(state).map(entry => entry.name).filter(Boolean);
}

function getModelOptions(entry) {
    const values = new Set();
    if (entry.model) values.add(entry.model);
    for (const model of entry.modelOptions || []) values.add(model);
    return [...values].sort((a, b) => a.localeCompare(b));
}

function applyEntryPreset(target, preset) {
    if (!preset) return;
    target.name = preset.name || target.name;
    target.apiUrl = preset.apiUrl || '';
    target.key = preset.key || '';
    target.provider = preset.provider || 'open';
    target.model = preset.model || '';
    target.fixedRuns = Math.max(1, toInt(preset.fixedRuns || 1));
    target.weight = toInt(preset.weight);
    target.pityTurns = toInt(preset.pityTurns);
    target.cooldownTurns = toInt(preset.cooldownTurns);
    target.modelOptions = Array.isArray(preset.modelOptions) ? [...preset.modelOptions] : [];
}

function copyEntryForPreset(entry) {
    return {
        id: `preset_${crypto.randomUUID()}`,
        enabled: entry.enabled !== false,
        name: String(entry.name || ''),
        apiUrl: String(entry.apiUrl || ''),
        key: String(entry.key || ''),
        provider: String(entry.provider || 'open'),
        model: String(entry.model || ''),
        fixedRuns: Math.max(1, toInt(entry.fixedRuns || 1)),
        weight: toInt(entry.weight),
        pityTurns: toInt(entry.pityTurns),
        cooldownTurns: toInt(entry.cooldownTurns),
        modelOptions: Array.isArray(entry.modelOptions) ? [...entry.modelOptions] : [],
    };
}

function saveApiPreset(state, entry) {
    if (!entry?.name) return;
    if (!Array.isArray(state.apiPresets)) state.apiPresets = [];
    const name = String(entry.name || '').trim();
    const preset = copyEntryForPreset({ ...entry, name });
    const index = state.apiPresets.findIndex(item => String(item.name || '').trim() === name);
    if (index >= 0) {
        preset.id = state.apiPresets[index].id || preset.id;
        state.apiPresets[index] = preset;
    } else {
        state.apiPresets.push(preset);
    }
}

function renderPool(state) {
    const pool = getActivePool(state);
    silenceLongPressTransition();
    const longPress = $('#kf-long-press');
    $('#group-select-display').val(pool.name);
    $('#group-select-wrapper').show();
    $('#kf-root').attr('data-mode', pool.mode);
    $('#mode-fixed').prop('checked', pool.mode === 'fixed');
    $('#mode-random').prop('checked', pool.mode === 'random');
    $('#kf-no-streak').prop('checked', !!pool.random?.noConsecutive);
    longPress.toggleClass('active', state.enabled !== false);
    $('#kf-long-press-text').text(state.enabled !== false ? '插件全局生效（长按关闭）' : '插件已关闭（长按启动）');
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
        <div class="select-wrapper provider-wrapper two-strokes brush-stroke flex-3">
            <input type="text" class="inner-select dropdown-input kf-entry-provider-display" value="${esc(selected)}" data-provider="${esc(entry.provider || 'open')}" readonly>
            <button class="dropdown-arrow kf-entry-provider-arrow" type="button">▼</button>
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

function renderEntries(state) {
    const pool = getActivePool(state);
    const root = $('#kf-entry-list').empty();
    const apiPresetNames = getApiPresetNames(state);

    for (const entry of pool.entries || []) {
        const enabledChecked = entry.enabled !== false ? 'checked' : '';
        const nameHasOptions = apiPresetNames.some(name => name !== entry.name);
        const modelHasOptions = getModelOptions(entry).some(model => model !== entry.model);
        const nameArrow = nameHasOptions ? '<button class="dropdown-arrow kf-entry-name-arrow" type="button">▼</button>' : '';
        const modelArrow = modelHasOptions ? '<button class="dropdown-arrow kf-entry-model-arrow" type="button">▼</button>' : '';
        root.append(`
            <div class="entry-block" data-id="${esc(entry.id)}">
                <div class="row">
                    <label class="marker-checkbox flex-1">
                        <input type="checkbox" class="kf-entry-enabled" ${enabledChecked}>
                        <span class="kf-check-box"></span>
                        <span class="text brush-stroke">启用</span>
                    </label>
                    <div class="input-wrapper flex-7"><span class="label">名称</span><input type="text" class="inner-input dropdown-input kf-entry-name" value="${esc(entry.name)}">${nameArrow}</div>
                </div>
                <div class="row">
                    <div class="input-wrapper flex-7"><span class="label">URL</span><input type="text" class="inner-input kf-entry-url" value="${esc(entry.apiUrl)}" placeholder="https://api.openai.com/v1"></div>
                    ${providerSelect(entry)}
                </div>
                <div class="row">
                    <div class="input-wrapper flex-1"><span class="label">KEY</span><input type="password" class="inner-input kf-entry-key" value="${esc(entry.key)}"></div>
                    <div class="input-wrapper flex-1"><span class="label">模型</span><input type="text" class="inner-input dropdown-input kf-entry-model" value="${esc(entry.model)}">${modelArrow}</div>
                    <button class="marker-btn brush-stroke kf-fetch-models">拉取模型</button>
                </div>
                <div class="row fixed-only">
                    <div class="input-wrapper flex-1"><span class="label">运行次数</span><input type="number" min="1" class="inner-input kf-entry-fixed-runs" value="${esc(entry.fixedRuns || 1)}"></div>
                </div>
                <div class="row random-only">
                    <div class="input-wrapper flex-1"><span class="label">权重</span><input type="number" min="0" class="inner-input kf-entry-weight" value="${esc(entry.weight)}"></div>
                    <div class="input-wrapper flex-1"><span class="label">保底回合</span><input type="number" min="0" class="inner-input kf-entry-pity" value="${esc(entry.pityTurns)}"></div>
                    <div class="input-wrapper flex-1"><span class="label">冷却回合</span><input type="number" min="0" class="inner-input kf-entry-cooldown" value="${esc(entry.cooldownTurns)}"></div>
                </div>
                <div class="entry-actions-grid entry-bottom-actions">
                    <button class="marker-btn brush-stroke kf-entry-save">保存</button>
                    <button class="marker-btn brush-stroke kf-del">删除</button>
                </div>
            </div>
        `);
    }
}

function formatLog(log) {
    const type = log.success === false || String(log.event || '').includes('error') ? '报错' : '抽选记录';
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

function currentLogFilter() {
    return $('.kf-log-filter.active').data('filter') || 'all';
}

function renderLogs(state, filter = currentLogFilter()) {
    const logs = [...(state.logs || [])].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    const filtered = logs.filter(log => {
        if (filter === 'error') return log.success === false || String(log.event || '').includes('error');
        if (filter === 'pick') return ['pick', 'request'].includes(log.event);
        return true;
    });
    const lines = filtered.slice(-50).map(formatLog);
    $('#kf-logs-list').val(lines.join('\n'));
}

function syncEntryFromRow(entry, row) {
    entry.enabled = row.find('.kf-entry-enabled').prop('checked');
    entry.name = String(row.find('.kf-entry-name').val() || '');
    entry.provider = String(row.find('.kf-entry-provider-display').data('provider') || 'open');
    entry.apiUrl = String(row.find('.kf-entry-url').val() || '');
    entry.key = String(row.find('.kf-entry-key').val() || '');
    entry.model = String(row.find('.kf-entry-model').val() || '');
    entry.fixedRuns = Math.max(1, toInt(row.find('.kf-entry-fixed-runs').val() || 1));
    entry.weight = toInt(row.find('.kf-entry-weight').val());
    entry.pityTurns = toInt(row.find('.kf-entry-pity').val());
    entry.cooldownTurns = toInt(row.find('.kf-entry-cooldown').val());
}

function syncAllEntries(state) {
    const pool = getActivePool(state);
    $('#kf-entry-list .entry-block').each(function () {
        const id = $(this).data('id');
        const entry = pool.entries.find(e => e.id === id);
        if (entry) syncEntryFromRow(entry, $(this));
    });
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

function closeModal(id) {
    $(`#${id}`).removeClass('show');
}

function hoistModals() {
    for (const id of ['logModal', 'dropdownModal', 'theme-modal', 'settings-modal', 'failure-modal']) {
        let node = document.getElementById(id);
        if (!node) continue;
        if (node.dataset.kfStopBound) {
            const cleanNode = node.cloneNode(true);
            node.replaceWith(cleanNode);
            node = cleanNode;
        }
        if (node.parentElement !== document.body) document.body.appendChild(node);
    }
}

function openFailureDecision(message, actions) {
    return new Promise(resolve => {
        const previousResolver = window.STKarmaFlip.failureResolver;
        if (typeof previousResolver === 'function') previousResolver('cancel');
        window.STKarmaFlip.failureResolver = resolve;
        $('#kf-failure-message').text(message || '');
        const box = $('#kf-failure-actions').empty();
        for (const action of actions || []) {
            box.append(`<button class="marker-btn brush-stroke" data-value="${esc(action.value)}">${esc(action.label)}</button>`);
        }
        box.off('click.kfFailure').on('click.kfFailure', '.marker-btn', function () {
            const value = String($(this).data('value') || '');
            $('#failure-modal').removeClass('show');
            box.off('click.kfFailure');
            window.STKarmaFlip.failureResolver = null;
            resolve(value);
        });
        $('#failure-modal').addClass('show');
    });
}

window.STKarmaFlip = window.STKarmaFlip || {};
window.STKarmaFlip.openFailureDecision = openFailureDecision;

function isMobileWidth() {
    return window.matchMedia?.('(max-width: 650px)')?.matches || window.innerWidth <= 650;
}

function closeDropdown() {
    $('#dropdownModal').removeClass('show');
    $('#kf-mobile-options').empty();
}

function openOptionPicker(input, options, title, onPick) {
    const unique = [...new Set((options || []).map(x => String(x || '').trim()).filter(Boolean))];
    if (!unique.length) return;
    const choose = (value) => {
        closeDropdown();
        input.val(value).trigger('input');
        onPick?.(value);
    };

    closeDropdown();
    $('#kf-dropdown-title').text(title || '选择');
    const box = $('#kf-mobile-options').empty();
    for (const option of unique) {
        box.append(`<div class="kf-mobile-option" data-value="${esc(option)}">${esc(option)}</div>`);
    }
    box.off('click.kfDrop').on('click.kfDrop', '.kf-mobile-option', function () {
        choose(String($(this).data('value')));
    });
    $('#dropdownModal').addClass('show');
}

function openGroupPicker(state, rerender) {
    const input = $('#group-select-display');
    const options = (state.pools || []).map(pool => pool.name);
    openOptionPicker(input, options, '选择组合', (name) => {
        const pool = (state.pools || []).find(item => item.name === name);
        if (!pool) return;
        state.activePoolId = pool.id;
        saveState(state);
        rerender();
    });
}

function openEntryNamePicker(state, row, input, rerender) {
    const pool = getActivePool(state);
    const entry = pool.entries.find(e => e.id === row.data('id'));
    const options = getApiPresetNames(state);
    openOptionPicker(input, options, '选择 API 设定', (name) => {
        if (!entry) return;
        const preset = findSavedApiEntry(state, name, entry.id);
        if (preset) {
            applyEntryPreset(entry, preset);
            saveState(state);
            rerender();
        } else {
            entry.name = name;
            saveState(state);
        }
    });
}

function openEntryModelPicker(state, row, input, rerender) {
    const pool = getActivePool(state);
    const entry = pool.entries.find(e => e.id === row.data('id'));
    if (!entry) return;
    openOptionPicker(input, getModelOptions(entry), '选择模型', (model) => {
        entry.model = model;
        saveState(state);
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

function bindLongPress(state, rerender, setStatus) {
    let timer = null;
    const area = $('#kf-long-press');
    area.off('.kfLP');
    const start = (event) => {
        if (event.button === 2) return;
        const enabled = state.enabled !== false;
        area.addClass(enabled ? 'pressing-off' : 'pressing-on');
        timer = setTimeout(() => {
            state.enabled = !(state.enabled !== false);
            area.removeClass('pressing-on pressing-off');
            saveState(state);
            rerender();
            setStatus(state.enabled !== false ? '插件全局生效' : '插件已关闭');
        }, 800);
    };
    const cancel = () => {
        clearTimeout(timer);
        area.removeClass('pressing-on pressing-off');
    };
    area.on('mousedown.kfLP touchstart.kfLP', start);
    $(window).off('mouseup.kfLP touchend.kfLP').on('mouseup.kfLP touchend.kfLP', cancel);
}

function isDragExcluded(target) {
    return !!$(target).closest('input,textarea,select,button,label,.dropdown-input,.dropdown-arrow,.marker-checkbox,.select-wrapper,.input-wrapper').length;
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
        list.children('.entry-block,.kf-drag-placeholder').each(function () {
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
        const rows = list.children('.entry-block').not(drag.row);
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
            saveState(state);
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

    list.on('pointerdown.kf', '.entry-block', function (event) {
        if (event.button && event.button !== 0) return;
        if (isDragExcluded(event.target)) return;
        const row = $(this);
        if (list.children('.entry-block').length < 2) return;
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
    $('#group-select-display').off('dblclick.kf blur.kf keydown.kf').on('dblclick.kf', function () {
        openGroupPicker(state, rerender);
    }).on('blur.kf', function () {
        const pool = getActivePool(state);
        const nextName = String($(this).val() || '').trim();
        if (nextName && nextName !== pool.name) {
            pool.name = nextName;
            saveState(state);
            rerender();
        } else {
            $(this).val(pool.name);
        }
    }).on('keydown.kf', function (event) {
        if (event.key === 'Enter') $(this).trigger('blur');
        if (event.key === 'Escape') rerender();
    });
    $('#group-select-arrow').off('pointerdown.kf click.kf').on('pointerdown.kf', function (event) {
        event.preventDefault();
        event.stopPropagation();
    }).on('click.kf', function (event) {
        event.preventDefault();
        event.stopPropagation();
        openGroupPicker(state, rerender);
    });

    $('#mode-fixed,#mode-random').off('change.kf').on('change.kf', function () {
        const pool = getActivePool(state);
        pool.mode = String($(this).val()) === 'random' ? 'random' : 'fixed';
        saveState(state);
        rerender();
    });
    $('#kf-no-streak').off('change.kf').on('change.kf', function () {
        getActivePool(state).random.noConsecutive = $(this).prop('checked');
        saveState(state);
        setStatus('避免连续命中已更新');
    });
    $('#kf-btn-new-pool').off('click.kf').on('click.kf', () => {
        syncAllEntries(state);
        const pool = mkPool();
        state.pools.push(pool);
        state.activePoolId = pool.id;
        saveState(state);
        rerender();
    });
    $('#kf-btn-copy-pool').off('click.kf').on('click.kf', () => {
        syncAllEntries(state);
        const pool = clonePool(getActivePool(state));
        state.pools.push(pool);
        state.activePoolId = pool.id;
        saveState(state);
        rerender();
    });
    $('#kf-btn-delete-pool').off('click.kf').on('click.kf', () => {
        if (state.pools.length <= 1) return setStatus('至少保留一个组合');
        state.pools = state.pools.filter(p => p.id !== state.activePoolId);
        state.activePoolId = state.pools[0].id;
        saveState(state);
        rerender();
    });
    $('#kf-btn-add-entry').off('click.kf').on('click.kf', () => {
        addEntry(getActivePool(state));
        saveState(state);
        rerender();
    });

    $('#kf-entry-list').off('.kf');
    $('#kf-entry-list').on('input.kf change.kf', 'input,select', function () {
        syncAllEntries(state);
        renderPresetLists(state);
        saveStateDebounced(state);
    });
    $('#kf-entry-list').on('change.kf', '.kf-entry-name', function () {
        const pool = getActivePool(state);
        const row = $(this).closest('.entry-block');
        const entry = pool.entries.find(e => e.id === row.data('id'));
        if (!entry) return;
        syncEntryFromRow(entry, row);
        const name = String($(this).val() || '').trim();
        const preset = findSavedApiEntry(state, name, entry.id);
        if (preset) {
            applyEntryPreset(entry, preset);
            saveState(state);
            rerender();
        }
    });
    $('#kf-entry-list').on('dblclick.kf', '.kf-entry-name', function () {
        const row = $(this).closest('.entry-block');
        openEntryNamePicker(state, row, $(this), rerender);
    });
    $('#kf-entry-list').on('pointerdown.kf click.kf', '.kf-entry-name-arrow', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (event.type !== 'click') return;
        const row = $(this).closest('.entry-block');
        openEntryNamePicker(state, row, row.find('.kf-entry-name'), rerender);
    });
    $('#kf-entry-list').on('click.kf', '.kf-entry-provider-display,.kf-entry-provider-arrow', function (event) {
        event.preventDefault();
        event.stopPropagation();
        const pool = getActivePool(state);
        const row = $(this).closest('.entry-block');
        const entry = pool.entries.find(e => e.id === row.data('id'));
        if (!entry) return;
        const options = providerOptions();
        openOptionPicker($(this), options.map(option => option.label), '选择接口', (label) => {
            const option = options.find(item => item.label === label);
            if (!option) return;
            entry.provider = option.value;
            saveState(state);
            rerender();
        });
    });
    $('#kf-entry-list').on('dblclick.kf', '.kf-entry-model', function () {
        const row = $(this).closest('.entry-block');
        openEntryModelPicker(state, row, $(this), rerender);
    });
    $('#kf-entry-list').on('pointerdown.kf click.kf', '.kf-entry-model-arrow', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (event.type !== 'click') return;
        const row = $(this).closest('.entry-block');
        openEntryModelPicker(state, row, row.find('.kf-entry-model'), rerender);
    });
    $('#kf-entry-list').on('click.kf', '.kf-entry-save', function () {
        const pool = getActivePool(state);
        const row = $(this).closest('.entry-block');
        const entry = pool.entries.find(e => e.id === row.data('id'));
        if (entry) syncEntryFromRow(entry, row);
        if (entry) saveApiPreset(state, entry);
        saveState(state);
        renderPresetLists(state);
        setStatus('条目已保存');
    });
    $('#kf-entry-list').on('click.kf', '.kf-del', function () {
        const pool = getActivePool(state);
        const id = $(this).closest('.entry-block').data('id');
        pool.entries = pool.entries.filter(e => e.id !== id);
        saveState(state);
        rerender();
    });
    bindEntryDragSort(state, rerender, setStatus);
    $('#kf-entry-list').on('click.kf', '.kf-fetch-models', async function () {
        const pool = getActivePool(state);
        const row = $(this).closest('.entry-block');
        const entry = pool.entries.find(e => e.id === row.data('id'));
        if (!entry) return;
        syncEntryFromRow(entry, row);
        if (entry.provider !== 'open' && entry.provider !== 'openai' && entry.provider !== 'deepseek') {
            return setStatus('当前仅支持 OpenAI-compatible 获取模型');
        }
        try {
            const models = await fetchOpenAICompatibleModels(entry);
            saveState(state);
            rerender();
            setStatus(`已获取 ${models.length} 个模型`);
        } catch (error) {
            setStatus(error?.message || '获取模型失败');
            alert(error?.message || '获取模型失败');
        }
    });

    $('#kf-btn-settings').off('click.kf').on('click.kf', () => $('#settings-modal').addClass('show'));
    $('#kf-btn-save').off('click.kf').on('click.kf', () => {
        syncAllEntries(state);
        const pool = getActivePool(state);
        for (const entry of pool.entries || []) saveApiPreset(state, entry);
        if (pool.mode === 'random' && shouldEqualize(pool)) {
            const ok = confirm('当前权重差距较大，是否允许插件按照API数量自动均等权重？');
            if (ok) equalize(pool);
        }
        saveState(state);
        rerender();
        setStatus('已保存');
    });
    $('#kf-btn-logs').off('click.kf').on('click.kf', () => {
        renderLogs(state);
        $('#logModal').addClass('show');
    });
    $('#kf-log-close').off('click.kf').on('click.kf', () => closeModal('logModal'));
    $('.kf-log-filter').off('click.kf').on('click.kf', function () {
        $('.kf-log-filter').removeClass('active');
        $(this).addClass('active');
        renderLogs(state, String($(this).data('filter') || 'all'));
    });
    $('#kf-btn-theme').off('click.kf').on('click.kf', () => $('#theme-modal').addClass('show'));
    $('#kf-theme-close').off('click.kf').on('click.kf', () => closeModal('theme-modal'));
    $('#kf-settings-close').off('click.kf').on('click.kf', () => closeModal('settings-modal'));
    $('#kf-dropdown-close').off('click.kf').on('click.kf', () => closeDropdown());
    $('.modal-overlay').off('pointerdown.kf mousedown.kf touchstart.kf click.kf')
        .on('pointerdown.kf mousedown.kf touchstart.kf', function (event) {
            event.stopPropagation();
        })
        .on('click.kf', function (event) {
            event.stopPropagation();
            if (this.id === 'failure-modal') return;
            if (event.target === this) $(this).removeClass('show');
        });
    $('.modal-overlay .modal-box').off('pointerdown.kf mousedown.kf touchstart.kf click.kf')
        .on('pointerdown.kf mousedown.kf touchstart.kf click.kf', function (event) {
            event.stopPropagation();
        });
    $(document).off('mousedown.kfDropdown').on('mousedown.kfDropdown', function (event) {
        if ($(event.target).closest('#dropdownModal,.dropdown-input').length) return;
        closeDropdown();
    });

    $('#kf-theme-bg-main,#kf-theme-bg-sub,#kf-theme-underline,#kf-theme-blur,#kf-theme-brush').off('input.kf change.kf').on('input.kf change.kf', function () {
        state.theme.bgMain = $('#kf-theme-bg-main').val();
        state.theme.bgSub = $('#kf-theme-bg-sub').val();
        state.theme.underline = $('#kf-theme-underline').val();
        state.theme.brush = String($('#kf-theme-brush').val() || 'marker');
        if (state.theme.brush !== 'simple') state.theme.blur = String($('#kf-theme-blur').val() || '0.6');
        applyTheme(state);
        saveStateDebounced(state);
    });
    $('#kf-failure-retry-count,#kf-failure-alert-enabled').off('input.kf change.kf').on('input.kf change.kf', function () {
        state.failure.retryCount = Math.max(1, toInt($('#kf-failure-retry-count').val() || 3));
        state.failure.alertEnabled = $('#kf-failure-alert-enabled').prop('checked');
        saveStateDebounced(state);
    });
    $('.kf-stepper-up,.kf-stepper-down').off('click.kf').on('click.kf', function () {
        const input = $('#kf-failure-retry-count');
        const delta = $(this).hasClass('kf-stepper-up') ? 1 : -1;
        const next = Math.max(1, toInt(input.val() || 3) + delta);
        input.val(next).trigger('change');
    });

    bindLongPress(state, rerender, setStatus);
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
    setTimeout(enableStatePersistence, 800);
    setStatus('已加载');
}
