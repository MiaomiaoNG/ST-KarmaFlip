export async function loadTavernApis() {
    const contextProfiles = window.SillyTavern?.getContext?.()?.extensionSettings?.connectionManager?.profiles;
    const fromContext = normalize(contextProfiles);
    if (fromContext.length) return fromContext;

    const winProfiles = window.extension_settings?.connectionManager?.profiles;
    const fromWindow = normalize(winProfiles);
    if (fromWindow.length) return fromWindow;

    try {
        for (const req of [() => fetch('/api/settings/get', { method: 'POST' }), () => fetch('/api/settings/get', { method: 'GET' })]) {
            const res = await req();
            if (!res.ok) continue;
            const data = await res.json();
            const profiles = data?.extensions?.connectionManager?.profiles;
            const list = normalize(profiles);
            if (list.length) return list;
        }
    } catch {}

    return [];
}

function normalize(profiles) {
    if (!Array.isArray(profiles)) return [];
    const result = [];
    const seen = new Set();

    for (const p of profiles) {
        if (!p || typeof p !== 'object') continue;
        if (p.mode !== 'cc') continue;
        const item = {
            source: 'tavern',
            profileId: String(p.id || ''),
            name: String(p.name || 'Unnamed API'),
            apiUrl: String(p['api-url'] || ''),
            secretId: String(p['secret-id'] || ''),
            api: String(p.api || 'custom'),
            model: String(p.model || ''),
        };
        const k = `${item.profileId}|${item.name}|${item.apiUrl}|${item.secretId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        result.push(item);
    }

    return result;
}
