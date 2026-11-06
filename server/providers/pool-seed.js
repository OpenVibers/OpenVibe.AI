'use strict';
/**
 * Seeding the providers OpenVibe buys capacity from (server/providers/pool-providers.js) into the registry.
 *
 * A provider is off until the owner puts its key in the owner settings (D11: `ai.provider_keys`): its `secret_ref` is
 * `vault:<key>`, and the pool skips a provider whose key does not resolve (`no_credentials`), so a provider without a
 * key is never offered, never called and never costs anything. The key slot itself appears in the owner's settings
 * because the store's schema is built from the registry's providers (server/settings.js).
 *
 * The models carry the price the price book recorded, with the page it was read from and the day it was read. A row
 * the owner has since edited keeps its price: the catalogue only fills a price that is missing or that the catalogue
 * itself wrote (its own source).
 *
 * The provider's own model list is the authority for the exact id (the catalogue sync, server/providers/catalog.js):
 * when the owner syncs a provider, `applyCatalogPrices` gives the provider's own id the price the catalogue recorded
 * for that model (matched by name) and retires the row the catalogue seeded under a name the provider does not use.
 */

const pool = require('./pool-providers');

/** The registry row of one catalogued provider. */
function recordOf(p) {
    return {
        key: p.key, display_name: p.display_name, kind: 'openai', status: 'active',
        base_url: p.base_url, auth_mode: 'bearer', secret_ref: `vault:${p.key}`,
        default_model: p.default_model || null, capabilities: p.capabilities, timeout_ms: p.timeout_ms,
        priority: p.priority, billing_profile: 'metered', provider_access: p.provider_access,
        metadata: {
            catalog: 'pool-providers',
            data_policy: p.data_policy,
            ...(p.uncensored ? { uncensored: true } : {}),
            ...(p.role ? { role: p.role } : {}),
        },
    };
}

/** The registry row of one catalogued model: the price, where it came from and what the model can do. */
function modelOf(p, m) {
    const metadata = {
        catalog: 'pool-providers',
        family: m.family || null,
        id_source: 'price-book',
        checked: m.checked || null,
        ...(m.note ? { note: m.note } : {}),
        ...(m.uncensored ? { uncensored: true } : {}),
        data_policy: p.data_policy,
    };
    return {
        provider_key: p.key, model_key: m.model_key, display_name: m.display_name || m.model_key,
        type: 'chat', status: 'active', context_window: m.context_window || null, max_output: m.max_output || null,
        cost: {
            in_per_mtok: m.cost.in_per_mtok, out_per_mtok: m.cost.out_per_mtok,
            cached_per_mtok: m.cost.cached_per_mtok == null ? null : m.cost.cached_per_mtok,
            effective_from: m.checked || null, source: m.source || null, verified_at: m.checked || null,
        },
        supports: { json: true, tools: m.supports.tools !== false, streaming: true, vision: m.supports.vision === true },
        metadata,
    };
}

/** Did the catalogue write this price? Then the catalogue may refresh it; a person's own price it may not. */
function cataloguePrice(row) {
    const source = row && row.cost && row.cost.source;
    if (!source) return false;
    return pool.PROVIDERS.some((p) => p.models.some((m) => m.source === source));
}

/**
 * Seed the catalogued providers and their models. A provider the owner has edited (its origin is not 'catalog')
 * keeps everything the owner set: only its key slot and its catalogue metadata are refreshed. A model the owner has
 * edited keeps its price and its status; a price the catalogue wrote is refreshed when the catalogue changes.
 *
 * → { providers: [key], models: [key], skipped: [key] }
 */
async function seedPoolProviders({ registry, actor = 'system' }) {
    const out = { providers: [], models: [], skipped: [] };
    for (const p of pool.PROVIDERS) {
        const prev = await registry.getProvider(p.key);
        if (!prev) {
            await registry.upsertProvider(recordOf(p), { actor, origin: 'catalog' });
            out.providers.push(p.key);
        } else if (prev.origin === 'catalog') {
            // The catalogue owns this row: keep the owner's status and key slot, refresh the rest.
            await registry.upsertProvider({
                ...recordOf(p),
                status: prev.status,
                secret_ref: prev.secret_ref || `vault:${p.key}`,
                provider_access: prev.provider_access || p.provider_access,
                metadata: { ...prev.metadata, ...recordOf(p).metadata },
            }, { actor, origin: 'catalog' });
        } else {
            out.skipped.push(p.key);   // the owner's own provider: never touched
        }
        for (const m of p.models) {
            const row = await registry.getModel(p.key, m.model_key);
            if (!row) {
                await registry.upsertModel(modelOf(p, m), { actor });
                out.models.push(`${p.key}/${m.model_key}`);
                continue;
            }
            if (row.status !== 'active') continue;                       // the owner turned it off: it stays off
            if (row.cost.in_per_mtok != null && !cataloguePrice(row)) continue;   // a person's own price: it stays
            const next = modelOf(p, m);
            await registry.upsertModel({
                ...next,
                status: row.status,
                context_window: row.context_window ?? next.context_window,
                max_output: row.max_output ?? next.max_output,
                metadata: { ...row.metadata, ...next.metadata },
            }, { actor });
        }
    }
    return out;
}

/**
 * After the owner syncs a provider's own model list: give the provider's own ids the prices the catalogue recorded
 * (matched by the model's name, its namespace aside) and retire the row the catalogue seeded under a name the
 * provider does not use, so only one row per model ever serves.
 *
 * → { priced: [model_key], retired: [model_key] }
 */
async function applyCatalogPrices({ registry, provider, actor = 'system' }) {
    const out = { priced: [], retired: [] };
    const p = pool.byKey.get(provider.key);
    if (!p) return out;
    const rows = await registry.listModels({ provider: provider.key });
    for (const row of rows) {
        const price = pool.priceOf(provider.key, row.model_key);
        if (!price) continue;
        const own = row.cost.in_per_mtok != null && !cataloguePrice(row);
        if (own) continue;                                  // a person's own price: the catalogue does not touch it
        if (row.cost.in_per_mtok === price.cost.in_per_mtok && row.cost.source === price.source) continue;
        await registry.upsertModel({
            provider_key: row.provider_key, model_key: row.model_key, display_name: row.display_name,
            type: row.type, status: row.status,
            context_window: row.context_window, max_output: row.max_output,
            cost: {
                in_per_mtok: price.cost.in_per_mtok, out_per_mtok: price.cost.out_per_mtok,
                cached_per_mtok: price.cost.cached_per_mtok == null ? null : price.cost.cached_per_mtok,
                effective_from: price.checked || null, source: price.source || null, verified_at: price.checked || null,
            },
            supports: row.supports,
            metadata: { ...row.metadata, family: price.family || row.metadata.family || null, id_source: 'provider-list' },
        }, { actor });
        out.priced.push(row.model_key);
    }
    // A catalogue row whose model the provider lists under another id: the provider's own id wins, so the catalogue
    // row is retired (it stays readable, it does not serve).
    for (const m of p.models) {
        const other = rows.find((r) => r.model_key !== m.model_key && pool.leaf(r.model_key) === pool.leaf(m.model_key));
        if (!other) continue;
        const row = await registry.getModel(provider.key, m.model_key);
        if (!row || row.status !== 'active') continue;
        await registry.upsertModel({
            provider_key: provider.key, model_key: m.model_key, status: 'disabled',
            metadata: { ...row.metadata, listed: false, missing_since: new Date().toISOString(), merged_into: other.model_key },
        }, { actor });
        out.retired.push(m.model_key);
    }
    return out;
}

module.exports = { seedPoolProviders, applyCatalogPrices, recordOf, modelOf, cataloguePrice };
