function normalizeProfile(profile) {
    if (!profile || typeof profile !== 'object') return null;
    if (profile.mode !== 'cc') return null;

    return {
        profileId: String(profile.id || ''),
        name: String(profile.name || 'Unnamed API'),
        apiUrl: String(profile['api-url'] || ''),
        secretId: String(profile['secret-id'] || ''),
        api: String(profile.api || 'custom'),
        model: String(profile.model || ''),
    };
}

function fromContextExtensionSettings() {
    const context = window.SillyTavern?.getContext?.();
    const profiles = context?.extensionSettings?.connectionManager?.profiles;
    if (!Array.isArray(profiles)) return [];
    return profiles.map(normalizeProfile).filter(Boolean);
}

function fromWindowExtensionSettings() {
    const ext = window.extension_settings;
    const profiles = ext?.connectionManager?.profiles;
    if (!Array.isArray(profiles)) return [];
    return profiles.map(normalizeProfile).filter(Boolean);
}

async function fromSettingsApi() {
    try {
        const attempts = [
            () => fetch('/api/settings/get', { method: 'POST' }),
            () => fetch('/api/settings/get', { method: 'GET' }),
        ];

        for (const run of attempts) {
            const response = await run();
            if (!response.ok) continue;
            const data = await response.json();
            const profiles = data?.extensions?.connectionManager?.profiles;
            if (Array.isArray(profiles)) {
                return profiles.map(normalizeProfile).filter(Boolean);
            }
        }

        return [];
    } catch {
        return [];
    }
}

function dedupe(list) {
    const seen = new Set();
    const result = [];
    for (const item of list) {
        const key = item.profileId || `${item.name}|${item.apiUrl}|${item.secretId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(item);
    }
    return result;
}

export async function fetchApiProfiles() {
    const contextList = fromContextExtensionSettings();
    if (contextList.length > 0) return dedupe(contextList);

    const windowList = fromWindowExtensionSettings();
    if (windowList.length > 0) return dedupe(windowList);

    const remote = await fromSettingsApi();
    return dedupe(remote);
}
