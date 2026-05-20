import { getRuntimeScope, toInt } from './plugin_state_store.js';

function validEntries(pool, runtime) {
    return (pool.entries || []).filter(e =>
        e &&
        e.enabled !== false &&
        !runtime?.disabledByFailure?.[e.id] &&
        e.apiUrl &&
        e.key &&
        e.model
    );
}

function weightedPick(entries) {
    const weighted = entries
        .map(e => ({ entry: e, weight: toInt(e.weight) }))
        .filter(item => item.weight > 0);
    const total = weighted.reduce((sum, x) => sum + x.weight, 0);
    if (total <= 0) return null;
    let r = Math.random() * total;
    for (const item of weighted) {
        r -= item.weight;
        if (r < 0) return item.entry;
    }
    return weighted[weighted.length - 1]?.entry || null;
}

function reduceCooldowns(runtime) {
    for (const id of Object.keys(runtime.cooldowns || {})) {
        runtime.cooldowns[id] = Math.max(0, toInt(runtime.cooldowns[id]) - 1);
    }
}

function clearCooldowns(runtime) {
    for (const id of Object.keys(runtime.cooldowns || {})) runtime.cooldowns[id] = 0;
}

function buildFixedSequence(entries, avoidConsecutive) {
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

function fixedPick(pool, runtime) {
    const entries = validEntries(pool, runtime);
    const sequence = buildFixedSequence(entries, !!pool.random?.noConsecutive);
    if (!sequence.length) return null;
    const idx = runtime.fixedCursor % sequence.length;
    runtime.fixedCursor = (idx + 1) % sequence.length;
    return sequence[idx];
}

function randomPick(pool, runtime) {
    const active = validEntries(pool, runtime).filter(e => toInt(e.weight) > 0);
    if (!active.length) return { member: null, blocked: [] };

    const pity = active
        .filter(e => toInt(e.pityTurns) > 0 && toInt(runtime.missStreaks?.[e.id]) >= toInt(e.pityTurns))
        .sort((a, b) => toInt(runtime.missStreaks?.[b.id]) - toInt(runtime.missStreaks?.[a.id]));
    if (pity.length) return { member: pity[0], blocked: [] };

    const blocked = [];
    let candidates = active.filter(e => {
        const onCooldown = toInt(runtime.cooldowns?.[e.id]) > 0;
        const streakBlocked = pool.random?.noConsecutive && runtime.lastPick?.memberId === e.id && active.length > 1;
        if (onCooldown || streakBlocked) blocked.push(e.name);
        return !onCooldown && !streakBlocked;
    });

    if (!candidates.length) {
        clearCooldowns(runtime);
        candidates = active.filter(e => !(pool.random?.noConsecutive && runtime.lastPick?.memberId === e.id && active.length > 1));
        if (!candidates.length) candidates = active;
    }

    return { member: weightedPick(candidates), blocked };
}

function updateMissStreaks(pool, runtime, member) {
    for (const entry of validEntries(pool, runtime)) {
        runtime.missStreaks[entry.id] = entry.id === member.id ? 0 : toInt(runtime.missStreaks[entry.id]) + 1;
    }
}

export function pickMember(state, pool) {
    const runtime = getRuntimeScope(state);
    runtime.turn += 1;
    let member = null;
    let detail = { mode: pool.mode || 'fixed', cooldownBlocked: [] };

    if (pool.mode === 'random') {
        const result = randomPick(pool, runtime);
        member = result.member;
        detail.cooldownBlocked = result.blocked;
    } else {
        member = fixedPick(pool, runtime);
    }

    return { member, detail };
}

export function markRequestSuccess(state, pool, member, requestKey) {
    const runtime = getRuntimeScope(state);
    reduceCooldowns(runtime);
    runtime.cooldowns[member.id] = pool.mode === 'random' ? toInt(member.cooldownTurns) : 0;
    runtime.failures[member.id] = 0;
    runtime.lastPick = { memberId: member.id, requestKey };
    updateMissStreaks(pool, runtime, member);
}

export function markRequestFailure(state, member) {
    const runtime = getRuntimeScope(state);
    runtime.cooldowns[member.id] = 0;
    runtime.failures[member.id] = toInt(runtime.failures[member.id]) + 1;
    return runtime.failures[member.id];
}

export function disableMemberByFailure(state, member) {
    const runtime = getRuntimeScope(state);
    runtime.disabledByFailure[member.id] = true;
}
