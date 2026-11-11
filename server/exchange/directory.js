'use strict';

/** Public, explicit fields from the full registry. Disabled and retired rows remain discoverable. */
async function directoryModels(registry) {
    const presets = require('../providers/pool-providers').byKey;
    const publicSource = (provider, value) => {
        const preset = presets.get(provider.key);
        if (!preset) return null;
        try {
            const url = new URL(value);
            const origins = [preset.models_endpoint, preset.docs_url, ...(preset.models || []).map(m => m.source)]
                .filter(Boolean).map(source => { try { return new URL(source).origin; } catch { return null; } });
            return url.protocol === 'https:' && !url.username && !url.password && origins.includes(url.origin) ? url.href : null;
        } catch { return null; }
    };
    const providers = new Map((await registry.listProviders()).map(p => [p.key, p]));
    const models = [];
    for (const row of await registry.listModels()) {
        const provider = providers.get(row.provider_key);
        if (!provider || provider.kind === 'stub' || provider.metadata?.synthetic || provider.metadata?.hidden || row.metadata?.hidden) continue;
        const meta = row.metadata || {};
        const retired = Boolean(meta.missing_since);
        const preview = /(?:^|[-_])(?:preview|experimental|exp)(?:$|[-_])/i.test(row.model_key);
        const status = retired ? 'retired' : preview ? 'preview' : 'available';
        const price = row.cost || {};
        models.push({
            id: `${row.provider_key}/${row.model_key}`,
            provider: row.provider_key,
            provider_name: provider.display_name,
            model: row.model_key,
            name: row.display_name || row.model_key,
            family: typeof meta.family === 'string' ? meta.family : null,
            version: typeof meta.version === 'string' ? meta.version : null,
            status,
            routing_enabled: row.status === 'active' && provider.status === 'active' && !retired,
            context_window: row.context_window == null ? null : Number(row.context_window),
            max_output: row.max_output == null ? null : Number(row.max_output),
            type: row.type,
            modalities: [...new Set(['text', ...(row.supports?.vision || row.type === 'image' ? ['image'] : []), ...(['stt', 'speech'].includes(row.type) ? ['audio'] : [])])],
            supports: { tools: Boolean(row.supports?.tools), json: Boolean(row.supports?.json), vision: Boolean(row.supports?.vision) },
            price: { input_per_million: price.in_per_mtok ?? null, output_per_million: price.out_per_mtok ?? null,
                cached_per_million: price.cached_per_mtok ?? null, source: publicSource(provider, price.source), checked_at: price.verified_at || null },
            first_seen_at: row.created_at || null,
            updated_at: row.updated_at || null,
            retired_at: retired ? meta.missing_since : null,
            source: publicSource(provider, meta.listed ? provider.metadata?.models_endpoint : price.source),
        });
    }
    return { generated_at: new Date().toISOString(), count: models.length, models };
}

module.exports = { directoryModels };
