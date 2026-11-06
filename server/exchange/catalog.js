'use strict';
/**
 * The public catalog for OpenVibe.Exchange: every model the network can run, and every offer that
 * serves it, with the price, the measured speed and uptime, and the provider's data policy.
 *
 * It is a read over what the router already knows — the registry's providers and models, the rate
 * cards (server/providers/rate-cards.js) and the runs that actually happened (server/exchange/observed.js)
 * — never a second list of models or prices. Nothing here is per person: a person's own key is not a
 * registry provider, and CUSTOMER_BYOK capacity is never sold as a managed offer.
 *
 * Facts stay visibly unknown when nobody recorded them: a prepaid provider has no per-token price,
 * a model with no traffic has no latency or uptime, and a provider without metadata.data_policy
 * says nothing about training, retention or region.
 */
const rates = require('../providers/rate-cards');
const upstream = require('../providers/upstream');
const observed = require('./observed');
const { allowsOffer } = require('../free-tier');

const FAMILY_BY_PREFIX = [
    ['deepseek', 'DeepSeek'], ['qwen', 'Qwen'], ['qwq', 'Qwen'], ['kimi', 'Kimi'], ['moonshot', 'Kimi'],
    ['glm', 'GLM'], ['zhipu', 'GLM'], ['minimax', 'MiniMax'], ['llama', 'Llama'], ['mistral', 'Mistral'],
    ['mixtral', 'Mistral'], ['gemma', 'Gemma'], ['gpt', 'GPT'], ['o1', 'GPT'], ['o3', 'GPT'], ['claude', 'Claude'],
    ['gemini', 'Gemini'], ['phi', 'Phi'], ['yi', 'Yi'], ['ernie', 'ERNIE'], ['hunyuan', 'Hunyuan'],
];
const UNCENSORED = /abliterat|uncensor/i;
// The org a family belongs to, so the same model served by several providers is one model with several offers.
const ORG_BY_FAMILY = {
    DeepSeek: 'deepseek', Qwen: 'qwen', Kimi: 'moonshot', GLM: 'zai', MiniMax: 'minimax',
    Llama: 'meta-llama', Mistral: 'mistralai', Gemma: 'google', GPT: 'openai', Claude: 'anthropic',
    Gemini: 'google', Phi: 'microsoft', Yi: '01-ai', ERNIE: 'baidu', Hunyuan: 'tencent',
};

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function familyFrom(text) {
    const s = String(text || '').toLowerCase();
    for (const [prefix, name] of FAMILY_BY_PREFIX) if (s.includes(prefix)) return name;
    return null;
}

/** The artifact a row names, without its quant/revision: "deepseek/deepseek-chat". */
function canonicalOf(row, provider) {
    const meta = (row && row.metadata) || {};
    if (typeof meta.id === 'string' && meta.id.includes('/')) {
        return meta.id.replace(/:[^@]*@[^@]*$/, '').replace(/@[^@]*$/, '');
    }
    if (typeof meta.org === 'string' && typeof meta.model === 'string') return `${meta.org}/${meta.model}`;
    const key = String((row && row.model_key) || '');
    if (key.includes('/')) return key;
    const family = familyFrom(key);
    return `${ORG_BY_FAMILY[family] || provider.key}/${key}`;
}

const slugOf = (canonical) => String(canonical)
    .toLowerCase()
    .split('/')
    .map((part) => part.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .join('/');

function familyOf(row, provider, canonical) {
    const meta = (row && row.metadata) || {};
    if (typeof meta.family === 'string' && meta.family.trim()) return meta.family.trim();
    return familyFrom(canonical) || provider.display_name || provider.key;
}

/**
 * The kind a model is offered as. `vision` is a chat model that also sees images, so it is chat here; the
 * catalog has separate kinds for embeddings, speech-to-text and image generation, never mixed into chat.
 */
function kindOf(row) {
    const type = (row && row.type) || 'chat';
    return type === 'vision' ? 'chat' : type;
}
const KINDS = ['chat', 'embedding', 'stt', 'image'];

function policyOf(provider) {
    const p = provider && provider.metadata && provider.metadata.data_policy;
    if (!p || typeof p !== 'object') return null;
    const trains = typeof p.trains === 'boolean' ? p.trains : (typeof p.training === 'boolean' ? p.training : null);
    const retention = Number.isFinite(Number(p.retention_days)) ? Number(p.retention_days) : null;
    const region = typeof p.region === 'string' && p.region ? p.region : null;
    const anonymized = typeof p.anonymized === 'boolean' ? p.anonymized : null;
    if (trains == null && retention == null && region == null && anonymized == null) return null;
    return { trains, retention_days: retention, region, anonymized };
}

const isCommunity = (provider) => Boolean(provider && provider.metadata && (provider.metadata.local === true || provider.metadata.community === true));

function capabilitiesOf(row) {
    const s = (row && row.supports) || {};
    return { tools: Boolean(s.tools), json: Boolean(s.json), vision: Boolean(s.vision) || row.type === 'vision', stream: Boolean(s.streaming) };
}

function modalitiesOf(row) {
    const out = new Set(['text']);
    if (capabilitiesOf(row).vision) out.add('image');
    if (row.type === 'stt') out.add('audio');
    if (row.type === 'image') out.add('image');
    return [...out];
}

function createCatalog({ db, registry, pool, env = process.env, clock = { now: () => Date.now() }, config = null }) {
    // The free-tier admission rules are the router's (server/free-tier.js): the catalog marks an offer with what
    // the free allowance and the anonymous Try it may actually use. config.freeUse is fixed at boot, like the
    // provider keys and upstreams the rest of this read shows.
    const freeUse = config && config.freeUse ? config.freeUse : undefined;
    const seen = observed.createObserved({ db, clock });

    /**
     * Every live offer, grouped by the model it serves.
     * days: the window the measured speed, uptime and request counts cover.
     * kind: only models of this kind (chat, embedding, stt, image); null for every kind.
     */
    async function models({ days = 7, kind = null } = {}) {
        const now = clock.now();
        const providers = await registry.listProviders();
        const byKey = new Map(providers.map((p) => [p.key, p]));
        const upstreamByKey = new Map();
        for (const p of providers) upstreamByKey.set(p.key, upstream.upstreamOf(p));

        const groups = new Map();
        const drafts = [];
        for (const row of await registry.listModels()) {
            const provider = byKey.get(row.provider_key);
            if (!provider || provider.kind === 'stub' || (provider.metadata && provider.metadata.synthetic)) continue;
            if (provider.metadata && provider.metadata.hidden === true) continue;
            if (row.status !== 'active' || provider.status !== 'active') continue;
            // A model is an offer only when the key its provider needs is configured now. A record with no
            // usable upstream (the internal `shared` label with no real provider behind it) is never shown.
            if (!upstream.configured(provider, env)) continue;
            const up = upstreamByKey.get(provider.key);
            if (!up || !upstream.serves(up, provider, row)) continue;
            // Capacity the network may not resell is never an offer: a person's own key, or a restricted one.
            if (provider.provider_access === 'CUSTOMER_BYOK' || provider.provider_access === 'RESTRICTED') continue;
            if (!['chat', 'vision', 'embedding', 'stt', 'image'].includes(row.type)) continue;

            // The catalog shows the real upstream, never the router's internal key ("shared").
            const shown = { key: up.key, display_name: up.name };
            const canonical = canonicalOf(row, shown);
            const slug = slugOf(canonical);
            if (!slug) continue;
            const cards = await pool.rateCardsFor(provider.key, row.model_key);
            const price = cards ? rates.pricesOf(cards) : null;
            const offer = {
                provider: up.key,
                provider_name: up.name,
                model: row.model_key,
                kind: kindOf(row),
                // The exact artifact id a caller may pin (`org/model[:quant]@revision`); null when nobody recorded one.
                id: (row.metadata && typeof row.metadata.id === 'string') ? row.metadata.id : null,
                trust: isCommunity(provider) ? 'community' : 'first-party',
                access: provider.provider_access || 'UNVERIFIED',
                free: cards == null,
                // What the free allowance and the anonymous Try it may use, distinct from `free` above (prepaid
                // capacity with no per-token card): both its provider is a named AI_FREE_PROVIDERS source and its
                // output price is at or below AI_FREE_MAX_OUTPUT_PRICE_USD_PER_MTOK.
                free_tier: allowsOffer({ providerKey: provider.key, providerRecord: provider, outputPrice: price ? price.out : null }, freeUse),
                price: price ? { in: price.in, out: price.out, cached: price.cached, per: '1M tokens', currency: 'USD' } : null,
                // Where the number came from and when someone checked it; null when nobody recorded it.
                price_source: cards && cards.out.source && !String(cards.out.source).startsWith('urn:openvibe:ai:unverified:') ? cards.out.source : null,
                price_checked_at: cards && cards.out.verified_at && cards.out.verified_at !== rates.UNKNOWN_DATE ? cards.out.verified_at : null,
                data_policy: policyOf(provider),
                updated_at: row.updated_at || provider.updated_at || null,
            };
            if (!groups.has(slug)) {
                groups.set(slug, {
                    slug, canonical,
                    name: row.display_name || row.model_key,
                    family: familyOf(row, shown, canonical),
                    kind: kindOf(row),
                    variant: (row.metadata && row.metadata.variant) || null,
                    uncensored: UNCENSORED.test(`${canonical} ${(row.metadata && row.metadata.variant) || ''}`) || Boolean(row.metadata && row.metadata.uncensored === true),
                    type: row.type,
                    context: num(row.context_window),
                    max_output: num(row.max_output),
                    capabilities: capabilitiesOf(row),
                    modalities: modalitiesOf(row),
                    description: (row.metadata && typeof row.metadata.description === 'string' && row.metadata.description) || null,
                    offers: [], offers_listed: 0,
                });
            }
            const g = groups.get(slug);
            g.offers.push(offer);
            g.offers_listed += 1;
            drafts.push({ providerKey: provider.key, modelKey: row.model_key, offer });
            if (row.type === 'vision') g.capabilities.vision = true;
            if (!g.context && row.context_window) g.context = num(row.context_window);
            if (!g.description && row.metadata && typeof row.metadata.description === 'string') g.description = row.metadata.description;
        }

        // What those offers actually did: real runs (cached answers counted apart), TTFT where recorded,
        // else the answering attempt's total latency.
        const measured = await seen.read({ days });
        observed.fold(measured, drafts);

        let models = [...groups.values()];
        if (kind) models = models.filter((m) => m.kind === kind);
        for (const m of models) {
            m.offers.sort((a, b) => {
                const pa = a.price ? a.price.in + a.price.out : Number.POSITIVE_INFINITY;
                const pb = b.price ? b.price.in + b.price.out : Number.POSITIVE_INFINITY;
                return pa - pb || a.provider.localeCompare(b.provider);
            });
            m.requests_7d = m.offers.reduce((n, o) => n + o.requests_7d, 0);
            m.requests_today = m.offers.reduce((n, o) => n + o.requests_today, 0);
            m.cached_7d = m.offers.reduce((n, o) => n + o.cached_7d, 0);
            m.cached_today = m.offers.reduce((n, o) => n + o.cached_today, 0);
            m.community = m.offers.some((o) => o.trust === 'community');
            m.priced = m.offers.some((o) => o.price);
            delete m.offers_listed;
        }
        models.sort((a, b) => b.requests_7d - a.requests_7d || b.requests_today - a.requests_today || a.name.localeCompare(b.name));

        const families = new Map();
        const kinds = new Map();
        for (const m of models) {
            const f = families.get(m.family) || { name: m.family, models: 0, offers: 0 };
            f.models += 1;
            f.offers += m.offers.length;
            families.set(m.family, f);
            const k = kinds.get(m.kind) || { kind: m.kind, models: 0, offers: 0 };
            k.models += 1;
            k.offers += m.offers.length;
            kinds.set(m.kind, k);
        }
        return {
            generated_at: new Date(now).toISOString(),
            window_days: days,
            ...(kind ? { kind } : {}),
            count: models.length,
            families: [...families.values()].sort((a, b) => b.models - a.models || a.name.localeCompare(b.name)),
            kinds: [...kinds.values()].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)),
            models,
        };
    }

    /** One model by its slug ("deepseek/deepseek-chat"), from the same read. */
    async function model(slug, opts = {}) {
        const all = await models(opts);
        return all.models.find((m) => m.slug === String(slug || '').toLowerCase()) || null;
    }

    return { models, model, policyOf, canonicalOf, slugOf };
}

createCatalog.dayOf = dayOf;
createCatalog.slugOf = slugOf;
createCatalog.familyOf = familyOf;
createCatalog.kindOf = kindOf;
module.exports = { createCatalog, slugOf, canonicalOf, dayOf, kindOf, KINDS };
