'use strict';
/**
 * Seeding the providers OpenVibe buys capacity from (server/providers/pool-providers.js) into the registry.
 *
 * A provider is off until the owner puts its key in the owner settings (D11: `ai.provider_keys`): its `secret_ref` is
 * `vault:<key>`, and the pool skips a provider whose key does not resolve (`no_credentials`), so a provider without a
 * key is never offered, never called and never costs anything. The key slot itself appears in the owner's settings
 * because the store's schema is built from the registry's providers (server/settings.js).
 *
 * The models carry the price the provider's own page gave, with that page and the day it was read. A price nobody
 * publishes is null, never a guess. A row the owner has since edited keeps its price: the catalogue only fills a
 * price that is missing or that the catalogue itself wrote (its own source).
 *
 * The provider's own model list is the authority for the exact id (the catalogue sync, server/providers/catalog.js):
 * when the owner syncs a provider, `applyCatalogPrices` gives the provider's own id the price the catalogue recorded
 * for that model (matched by name) and retires the row the catalogue seeded under a name the provider does not use.
 */

const pool = require('./pool-providers');
const { providerSecret } = require('../util');

/** The registry row of one catalogued provider. */
function recordOf(p) {
    return {
        key: p.key, display_name: p.display_name, kind: p.kind, status: 'disabled',
        base_url: p.base_url, auth_mode: p.auth_mode, secret_ref: p.auth_mode === 'none' ? null : `vault:${p.key}`,
        default_model: p.default_model || null, capabilities: p.capabilities, timeout_ms: p.timeout_ms,
        priority: p.priority, billing_profile: 'metered', provider_access: p.provider_access,
        metadata: {
            catalog: 'pool-providers',
            api_family: p.api_family, models_endpoint: p.models_endpoint,
            model_sync_interval_minutes: p.models_endpoint ? 1440 : 0,
            check_endpoint: p.check_endpoint || null,
            models_public: p.models_public === true, models_dev_id: p.models_dev_id || null,
            auth_header: p.auth_header || null, docs_url: p.docs_url || null,
            search_adapters: p.search_adapters || [],
            data_policy: p.data_policy,
            // A provider's published request limits, kept by the router (server/providers/rate-gate.js).
            rate_limits: p.rate_limits || null,
            // What the provider gives away without a paid plan, with the page and day it was read.
            free_tier: p.free_tier || null,
            // The privacy label of the provider: `private` only where its own terms say it keeps nothing and trains on
            // nothing, `anonymized` for everyone else. The wording and the page it was read from travel with it.
            privacy: p.privacy,
            // The tiers the provider itself sells and at what price (BA1): a Flex tier, a batch API.
            ...(p.tier_rates ? { tier_rates: p.tier_rates } : {}),
            // The traits beyond price (latency class, concurrency, free allowance, payment, sources).
            ...(p.traits ? { traits: p.traits } : {}),
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
        // The price came from the provider's own page, not from an aggregator's.
        id_source: 'provider-page',
        checked: m.checked || null,
        // What the provider states the weights are served in. Null unless it says so.
        quantization: m.quantization == null ? null : m.quantization,
        // The rate at which this model refuses. Null until a provider publishes its own or a measurement job owns it.
        refusal_rate: m.refusal_rate == null ? null : m.refusal_rate,
        ...(m.note ? { note: m.note } : {}),
        ...(m.uncensored ? { uncensored: true } : {}),
        // A per-offer fact: the OpenRouter provider routing it pins, the service tier it runs on, and any
        // latency classes narrower than the provider's.
        ...(m.routing ? { routing: m.routing } : {}),
        ...(m.service_tier ? { service_tier: m.service_tier } : {}),
        ...(Array.isArray(m.latency_classes) ? { latency_classes: m.latency_classes } : {}),
        data_policy: p.data_policy,
        privacy: p.privacy,
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
async function seedPoolProviders({ registry, actor = 'system', env = process.env }) {
    const out = { providers: [], models: [], skipped: [] };
    for (const p of pool.PROVIDERS) {
        const prev = await registry.getProvider(p.key);
        if (!prev) {
            await registry.upsertProvider(recordOf(p), { actor, origin: 'catalog' });
            out.providers.push(p.key);
        } else if (prev.origin === 'catalog') {
            const defaults = recordOf(p);
            const configured = prev.auth_mode === 'none' || Boolean(providerSecret(prev, env));
            if (configured && prev.base_url !== p.base_url) {
                defaults.metadata.models_endpoint = prev.base_url ? `${prev.base_url.replace(/\/+$/, '')}/models` : null;
                defaults.metadata.check_endpoint = null;
            }
            const metadata = { ...defaults.metadata, ...prev.metadata, search_adapters: [...new Set([...(prev.metadata.search_adapters || []), ...(defaults.metadata.search_adapters || [])])] };
            if (p.key === 'gemini' && prev.base_url === p.base_url && prev.metadata.models_endpoint === `${p.base_url}/models`)
                metadata.models_endpoint = defaults.metadata.models_endpoint;
            if (!configured && prev.base_url !== p.base_url) {
                metadata.models_endpoint = defaults.metadata.models_endpoint;
                metadata.api_family = defaults.metadata.api_family;
            }
            // A key is bound to its origin. A documentation refresh must never move a working
            // provider or change its wire format; endpoint changes are explicit owner edits.
            await registry.upsertProvider({
                ...defaults,
                ...(configured ? { base_url: prev.base_url, kind: prev.kind, auth_mode: prev.auth_mode } : {}),
                status: prev.status === 'active' && !configured ? 'disabled' : prev.status,
                secret_ref: prev.secret_ref,
                provider_access: prev.provider_access || p.provider_access,
                metadata,
            }, { actor, origin: 'catalog' });
        } else {
            out.skipped.push(p.key);
            const protocol = recordOf(p).metadata;
            if (prev.base_url !== p.base_url) {
                protocol.models_endpoint = prev.base_url ? `${prev.base_url.replace(/\/+$/, '')}/models` : null;
                protocol.check_endpoint = null;
            }
            const additions = Object.fromEntries(Object.entries(protocol).filter(([k]) => ['api_family', 'models_endpoint', 'model_sync_interval_minutes', 'check_endpoint', 'models_public', 'models_dev_id', 'auth_header', 'docs_url', 'search_adapters'].includes(k) && prev.metadata[k] === undefined));
            if (p.key === 'gemini' && prev.base_url === p.base_url && prev.metadata.models_endpoint === `${p.base_url}/models`)
                additions.models_endpoint = protocol.models_endpoint;
            const engines = [...new Set([...(prev.metadata.search_adapters || []), ...(protocol.search_adapters || [])])];
            if (engines.length !== (prev.metadata.search_adapters || []).length) additions.search_adapters = engines;
            if (Object.keys(additions).length) await registry.upsertProvider({ key: p.key, metadata: { ...prev.metadata, ...additions } }, { actor, origin: prev.origin });
        }
        for (const m of p.models) {
            const row = await registry.getModel(p.key, m.model_key);
            if (!row) {
                await registry.upsertModel(modelOf(p, m), { actor });
                out.models.push(`${p.key}/${m.model_key}`);
                continue;
            }
            if (row.status !== 'active') {
                // The owner turned the model off: it stays off, and its price and status are the owner's. The
                // catalogue still records the offer's own routing and service tier (the OpenRouter Particle pin),
                // because those are facts about the offer, not a price or a switch.
                const next = modelOf(p, m);
                const facts = {};
                if (m.routing && JSON.stringify((row.metadata && row.metadata.routing) || null) !== JSON.stringify(m.routing)) facts.routing = m.routing;
                if (m.service_tier && !(row.metadata && row.metadata.service_tier)) facts.service_tier = m.service_tier;
                if (Object.keys(facts).length) await registry.upsertModel({ ...row, metadata: { ...(row.metadata || {}), ...facts } }, { actor });
                continue;
            }
            if (row.metadata && row.metadata.price_book) continue;    // the price book owns this price: it refreshes it
            if (row.cost.in_per_mtok != null && !cataloguePrice(row)) continue;   // a person's own price: it stays
            const next = modelOf(p, m);
            await registry.upsertModel({
                ...next,
                display_name: row.metadata?.owner_display_name ? row.display_name : next.display_name,
                status: row.status,
                context_window: row.context_window ?? next.context_window,
                max_output: row.max_output ?? next.max_output,
                metadata: { ...row.metadata, ...next.metadata,
                    ...(row.metadata?.owner_content_tier ? { uncensored: row.metadata.uncensored, min_age: row.metadata.min_age } : {}) },
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
        if (row.metadata && row.metadata.price_book) continue;         // the price book owns this price
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
