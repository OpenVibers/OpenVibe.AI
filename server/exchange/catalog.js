'use strict';
/**
 * The public catalog for OpenVibe.Exchange: every model the network can run, and every offer that
 * serves it, with the price, the measured speed and uptime, and the provider's data policy.
 *
 * It is a read over what the router already knows — the registry's providers and models, the rate
 * cards (server/providers/rate-cards.js) and the daily stats (provider_stats_daily) — never a second
 * list of models or prices. Nothing here is per person: a person's own key is not a registry
 * provider, and CUSTOMER_BYOK capacity is never sold as a managed offer.
 *
 * Facts stay visibly unknown when nobody recorded them: a prepaid provider has no per-token price,
 * a model with no traffic has no latency or uptime, and a provider without metadata.data_policy
 * says nothing about training, retention or region.
 */
const rates = require('../providers/rate-cards');

const DAY_MS = 86400000;
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

function policyOf(provider) {
    const p = provider && provider.metadata && provider.metadata.data_policy;
    if (!p || typeof p !== 'object') return null;
    const trains = typeof p.trains === 'boolean' ? p.trains : (typeof p.training === 'boolean' ? p.training : null);
    const retention = Number.isFinite(Number(p.retention_days)) ? Number(p.retention_days) : null;
    const region = typeof p.region === 'string' && p.region ? p.region : null;
    if (trains == null && retention == null && region == null) return null;
    return { trains, retention_days: retention, region };
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

function createCatalog({ db, registry, pool, clock = { now: () => Date.now() } }) {
    const getStats = db.prepare(`SELECT provider, model,
            SUM(requests)::bigint AS requests, SUM(ok)::bigint AS ok, SUM(errors)::bigint AS errors,
            CASE WHEN SUM(requests) > 0 THEN SUM(COALESCE(latency_p50_ms, 0) * requests) / SUM(requests) END AS p50,
            CASE WHEN SUM(requests) > 0 THEN SUM(COALESCE(latency_p95_ms, 0) * requests) / SUM(requests) END AS p95
        FROM provider_stats_daily WHERE day >= ? GROUP BY provider, model`);
    const getToday = db.prepare(`SELECT provider, model, SUM(requests)::bigint AS requests
        FROM provider_stats_daily WHERE day = ? GROUP BY provider, model`);

    async function statsFor(days, today) {
        const from = dayOf(clock.now() - Math.max(1, days) * DAY_MS);
        const map = new Map();
        for (const r of await getStats.all(from)) {
            map.set(`${r.provider}\u0000${r.model || ''}`, {
                requests: Number(r.requests) || 0, ok: Number(r.ok) || 0, errors: Number(r.errors) || 0,
                p50: num(r.p50), p95: num(r.p95),
            });
        }
        for (const r of await getToday.all(today)) {
            const key = `${r.provider}\u0000${r.model || ''}`;
            const hit = map.get(key);
            if (hit) hit.today = Number(r.requests) || 0;
            else map.set(key, { requests: 0, ok: 0, errors: 0, p50: null, p95: null, today: Number(r.requests) || 0 });
        }
        return map;
    }

    /**
     * Every live offer, grouped by the model it serves.
     * days: the window the measured speed, uptime and request counts cover.
     */
    async function models({ days = 7 } = {}) {
        const now = clock.now();
        const today = dayOf(now);
        const stats = await statsFor(days, today);
        const providers = await registry.listProviders();
        const byKey = new Map(providers.map((p) => [p.key, p]));
        const health = new Map();
        for (const p of providers) {
            try { health.set(p.key, await pool.health(p.key)); } catch (e) { health.set(p.key, null); }
        }

        const groups = new Map();
        for (const row of await registry.listModels()) {
            const provider = byKey.get(row.provider_key);
            if (!provider || provider.kind === 'stub' || (provider.metadata && provider.metadata.synthetic)) continue;
            if (provider.metadata && provider.metadata.hidden === true) continue;
            if (row.status !== 'active' || provider.status !== 'active') continue;
            // Capacity the network may not resell is never an offer: a person's own key, or a restricted one.
            if (provider.provider_access === 'CUSTOMER_BYOK' || provider.provider_access === 'RESTRICTED') continue;
            if (!['chat', 'vision', 'embedding', 'stt', 'image'].includes(row.type)) continue;

            const canonical = canonicalOf(row, provider);
            const slug = slugOf(canonical);
            if (!slug) continue;
            const cards = await pool.rateCardsFor(provider.key, row.model_key);
            const price = cards ? rates.pricesOf(cards) : null;
            const st = stats.get(`${provider.key}\u0000${row.model_key}`) || { requests: 0, ok: 0, errors: 0, p50: null, p95: null, today: 0 };
            const uptime = st.requests > 0 ? st.ok / st.requests : null;
            const offer = {
                provider: provider.key,
                provider_name: provider.display_name || provider.key,
                model: row.model_key,
                // The exact artifact id a caller may pin (`org/model[:quant]@revision`); null when nobody recorded one.
                id: (row.metadata && typeof row.metadata.id === 'string') ? row.metadata.id : null,
                trust: isCommunity(provider) ? 'community' : 'first-party',
                access: provider.provider_access || 'UNVERIFIED',
                free: cards == null,
                price: price ? { in: price.in, out: price.out, cached: price.cached, per: '1M tokens', currency: 'USD' } : null,
                speed: { p50_ms: st.p50, p95_ms: st.p95 },
                uptime,
                requests_7d: st.requests,
                requests_today: st.today || 0,
                data_policy: policyOf(provider),
                updated_at: row.updated_at || provider.updated_at || null,
            };
            if (!groups.has(slug)) {
                groups.set(slug, {
                    slug, canonical,
                    name: row.display_name || row.model_key,
                    family: familyOf(row, provider, canonical),
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
            if (row.type === 'vision') g.capabilities.vision = true;
            if (!g.context && row.context_window) g.context = num(row.context_window);
            if (!g.description && row.metadata && typeof row.metadata.description === 'string') g.description = row.metadata.description;
        }

        const models = [...groups.values()];
        for (const m of models) {
            m.offers.sort((a, b) => {
                const pa = a.price ? a.price.in + a.price.out : Number.POSITIVE_INFINITY;
                const pb = b.price ? b.price.in + b.price.out : Number.POSITIVE_INFINITY;
                return pa - pb || a.provider.localeCompare(b.provider);
            });
            m.requests_7d = m.offers.reduce((n, o) => n + o.requests_7d, 0);
            m.requests_today = m.offers.reduce((n, o) => n + o.requests_today, 0);
            m.community = m.offers.some((o) => o.trust === 'community');
            m.priced = m.offers.some((o) => o.price);
            delete m.offers_listed;
        }
        models.sort((a, b) => b.requests_7d - a.requests_7d || b.requests_today - a.requests_today || a.name.localeCompare(b.name));

        const families = new Map();
        for (const m of models) {
            const f = families.get(m.family) || { name: m.family, models: 0, offers: 0 };
            f.models += 1;
            f.offers += m.offers.length;
            families.set(m.family, f);
        }
        return {
            generated_at: new Date(now).toISOString(),
            window_days: days,
            count: models.length,
            families: [...families.values()].sort((a, b) => b.models - a.models || a.name.localeCompare(b.name)),
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
module.exports = { createCatalog, slugOf, canonicalOf, dayOf };
