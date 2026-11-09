'use strict';
const { PROVIDERS } = require('../providers/pool-providers');
const { SOURCES } = require('../pricebook/sources');
const { canonicalOf, slugOf, kindOf } = require('./catalog');
const { createModelMetadata, lookupMetadata, bare, URL } = require('./model-metadata');
const TTL_MS = 60_000;
const recordKey = (provider, model) => `${provider}\0${String(model).toLowerCase()}`;
const num = (v) => v == null || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v);
const webUrl = (v) => typeof v === 'string' && /^https:\/\//.test(v) ? v : null;

function buildOffers({ providers = [], rows = [], changes = [], catalogue = {}, metadata = {}, observations = [], presets = PROVIDERS }) {
    const publicKeys = new Set([...presets.map(p => p.key), ...SOURCES.filter(s => s.role === 'own').map(s => s.provider)]);
    const byProvider = new Map(providers.filter(p => publicKeys.has(p.key)).map((p) => [p.key, p]));
    const seeds = new Map();
    const ownUrls = new Set(SOURCES.filter(s => s.role === 'own').map(s => s.url));
    for (const p of presets) for (const m of p.models || []) {
        // OpenRouter is a cross-reference in this pricebook, never an own-page price.
        if (p.role === 'cross-reference' || p.key === 'openrouter') continue;
        if (m.source) ownUrls.add(m.source);
        seeds.set(recordKey(p.key, m.model_key), { p, m });
    }
    const records = new Map([...seeds].map(([key, { p, m }]) => [key, {
        provider_key: p.key, model_key: m.model_key, display_name: m.display_name,
        type: m.type || 'chat', context_window: m.context_window, max_output: m.max_output,
        cost: { ...m.cost, source: m.source, verified_at: m.checked }, metadata: m,
    }]));
    for (const row of rows) {
        if (publicKeys.has(row.provider_key) && (ownUrls.has(row.cost?.source) || ownUrls.has(row.metadata?.price_book?.source))) records.set(recordKey(row.provider_key, row.model_key), row);
    }
    for (const observed of observations) {
        const exactKey = recordKey(observed.provider_key, observed.model_key);
        const key = records.has(exactKey) ? exactKey : [...records.keys()].find(k => {
            const r = records.get(k);
            return r.provider_key === observed.provider_key && bare(r.model_key) === bare(observed.model_key);
        }) || recordKey(observed.provider_key, observed.model_key);
        const price = typeof observed.price === 'string' ? JSON.parse(observed.price) : observed.price;
        const old = records.get(key);
        records.set(key, { ...old, provider_key: observed.provider_key, model_key: old?.model_key || observed.model_key,
            cost: { in_per_mtok: price.in, out_per_mtok: price.out, cached_per_mtok: price.cached,
                source: observed.source, verified_at: observed.checked_at } });
    }
    const routed = (catalogue.models || []).flatMap(m => (m.offers || []).map(o => ({ ...o, canonical: m.canonical || m.slug })));
    const offers = [];
    for (const [key, row] of records) {
        const seed = seeds.get(key);
        const p = byProvider.get(row.provider_key) || presets.find(p => p.key === row.provider_key)
            || (SOURCES.some(s => s.role === 'own' && s.provider === row.provider_key) ? { key: row.provider_key } : null);
        if (!p || p.metadata?.hidden || p.metadata?.synthetic || p.provider_access === 'CUSTOMER_BYOK') continue;
        const facts = { ...seed?.m, ...row.metadata };
        const canonical = canonicalOf(row, p); const model = slugOf(canonical);
        const meta = lookupMetadata(metadata.entries || [], row.model_key, row.provider_key);
        // Explicit projection only: no provider credentials, account ids or arbitrary metadata.
        const offer = {
            model, provider: p.key, provider_name: p.display_name || p.key,
            provider_model: row.model_key, name: row.display_name || row.model_key, kind: kindOf(row),
            price: { in: num(row.cost?.in_per_mtok), out: num(row.cost?.out_per_mtok), cached: num(row.cost?.cached_per_mtok), currency: 'USD', per: '1M tokens' },
            price_source: webUrl(row.cost?.source), price_checked_at: row.cost?.verified_at || facts.checked || null,
            routed: routed.some(o => o.provider === p.key && String(o.model).toLowerCase() === String(row.model_key).toLowerCase()),
            uncensored: seed?.m.uncensored === true || presets.find(preset => preset.key === p.key)?.uncensored === true,
            provider_access: p.provider_access || 'UNVERIFIED', field_sources: {},
        };
        // Pending price changes are the latest observed own-page price, even before the router
        // approves charging it. Never publish the change log's actor, note or account data.
        const observed = changes.filter(c => c.provider_key === p.key && c.model_key === row.model_key && ownUrls.has(c.source))
            .sort((a,b) => String(b.checked_at).localeCompare(String(a.checked_at)));
        for (const [field, short] of [['in_per_mtok','in'], ['out_per_mtok','out'], ['cached_per_mtok','cached']]) {
            const change = observed.find(c => c.field === field);
            if (change && (!offer.price_checked_at || String(change.checked_at) >= String(offer.price_checked_at))) offer.price[short] = num(change.new_price);
        }
        if (observed[0] && (!offer.price_checked_at || String(observed[0].checked_at) >= String(offer.price_checked_at))) {
            offer.price_source = webUrl(observed[0].source); offer.price_checked_at = observed[0].checked_at;
        }
        if (!offer.price_source) offer.price = { in: null, out: null, cached: null, currency: 'USD', per: '1M tokens' };
        const own = { maker: facts.maker, context: row.context_window, max_output: row.max_output,
            open_weights: facts.open_weights, licence: facts.licence || facts.license,
            release_date: facts.release_date, knowledge_cutoff: facts.knowledge_cutoff, modalities: facts.modalities };
        for (const field of Object.keys(own)) {
            const fromProvider = own[field] != null && webUrl(seed?.m.source || row.cost?.source);
            const value = (fromProvider ? own[field] : meta[field]) ?? null;
            offer[field] = ['context', 'max_output'].includes(field) ? num(value)
                : field === 'open_weights' ? (typeof value === 'boolean' ? value : null)
                : field === 'modalities' ? (value && typeof value === 'object' ? {
                    input: Array.isArray(value.input) ? value.input.filter(v => typeof v === 'string') : [],
                    output: Array.isArray(value.output) ? value.output.filter(v => typeof v === 'string') : [],
                } : null) : (typeof value === 'string' ? value : null);
            if (offer[field] != null) offer.field_sources[field] = fromProvider ? (seed?.m.source || row.cost.source) : URL;
        }
        offers.push(offer);
    }
    return offers.sort((a,b) => a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider) || a.provider_model.localeCompare(b.provider_model));
}

function pageMarket(snapshot, query = {}) {
    const limit = query.limit == null ? 100 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('limit must be an integer from 1 to 500');
    if (query.open_weights != null && !['true','false'].includes(String(query.open_weights))) throw new Error('open_weights must be true or false');
    if (query.kind != null && !['chat','embedding','stt','image'].includes(query.kind)) throw new Error('unknown kind');
    let offset = 0;
    if (query.cursor) {
        if (!/^\d+$/.test(query.cursor) || !Number.isSafeInteger(Number(query.cursor))) throw new Error('invalid cursor');
        offset = Number(query.cursor);
    }
    const offers = snapshot.offers.filter(o => (!query.maker || o.maker?.toLowerCase() === String(query.maker).toLowerCase()) &&
        (query.open_weights == null || o.open_weights === (String(query.open_weights) === 'true')) && (!query.kind || o.kind === query.kind));
    return { $schema: 'exchange.market@1', generated_at: snapshot.generated_at, metadata: snapshot.metadata,
        total_models: new Set(offers.map(o => bare(o.model))).size, total_offers: offers.length,
        offers: offers.slice(offset, offset + limit), next_cursor: offset + limit < offers.length ? String(offset + limit) : null };
}

function createMarket({ db, registry, catalog, config, clock = { now: Date.now }, metadata = null }) {
    const source = metadata || createModelMetadata({ db, now: () => clock.now(), enabled: config?.nodeEnv !== 'test' && process.env.NODE_ENV !== 'test' });
    let hit = null; let pending = null;
    async function snapshot() {
        if (hit && clock.now() < hit.until) return hit.value;
        if (!pending) pending = (async () => {
            const [providers, rows, changes, catalogue, meta, observations] = await Promise.all([
                registry.listProviders(), registry.listModels(),
                db.prepare('SELECT provider_key, model_key, field, new_price, source, checked_at FROM price_changes ORDER BY checked_at DESC').all(),
                catalog(), source.read(),
                db.prepare('SELECT provider_key, model_key, price, source, checked_at FROM exchange_market_prices').all(),
            ]);
            const value = { generated_at: new Date(clock.now()).toISOString(), metadata: { source: URL, checked_at: meta.checked_at, stale: meta.stale },
                offers: buildOffers({ providers, rows, changes, catalogue, metadata: meta, observations }) };
            hit = { value, until: clock.now() + TTL_MS }; return value;
        })().finally(() => { pending = null; });
        return pending;
    }
    return { async read(query) { return pageMarket(await snapshot(), query); } };
}
module.exports = { buildOffers, pageMarket, createMarket, TTL_MS };
