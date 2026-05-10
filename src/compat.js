let fallbackCounter = 0;

export function makeId(prefix = 'id') {
    const safePrefix = String(prefix || 'id').replace(/[^A-Za-z0-9_-]/g, '') || 'id';
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `${safePrefix}_${uuid}`;
    fallbackCounter += 1;
    const time = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 10);
    return `${safePrefix}_${time}_${fallbackCounter.toString(36)}_${random}`;
}

export function nextFrame(callback) {
    const raf = globalThis.requestAnimationFrame || (fn => globalThis.setTimeout(fn, 16));
    return raf(callback);
}

export function replaceNode(oldNode, newNode) {
    if (!oldNode || !newNode) return;
    if (typeof oldNode.replaceWith === 'function') {
        oldNode.replaceWith(newNode);
        return;
    }
    oldNode.parentNode?.replaceChild(newNode, oldNode);
}
