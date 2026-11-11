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
const privacy = require('./privacy');
const traits = require('../providers/traits');
const { allowsOffer } = require('../free-tier');
const { offerStatus } = require('../providers/failure');

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

// A community machine is a person's machine offering capacity (Node's "Offer to the network"). The host's own
// local deployments (metadata.local) are OpenVibe's own hardware, not a stranger's: they are labelled private.
const isCommunity = (provider) => Boolean(provider && provider.metadata && provider.metadata.community === true);

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

const usd6 = (n) => (n == null || !Number.isFinite(Number(n)) ? (n ?? null) : Math.round(Number(n) * 1e6) / 1e6);

/** The later of two days ("YYYY-MM-DD"), or the one there is. */
const laterOf = (a, b) => {
    const x = a ? String(a).slice(0, 10) : null;
    const y = b ? String(b).slice(0, 10) : null;
    if (!x) return y;
    if (!y) return x;
    return x > y ? x : y;
};

function createCatalog({ db, registry, pool, env = process.env, clock = { now: () => Date.now() }, config = null, fidelity = null }) {
    // The free-tier admission rules are the router's (server/free-tier.js): the catalog marks an offer with what
    // the free allowance and the anonymous Try it may actually use. config.freeUse is fixed at boot, like the
    // provider keys and upstreams the rest of this read shows.
    const freeUse = config && config.freeUse ? config.freeUse : undefined;
    const seen = observed.createObserved({ db, clock });

    /**
     * The price book's log: the day each model's price was last read and changed. The catalog reads it, so the
     * date it shows is the date the book recorded, not a number written into the code. One read for the whole
     * catalog; a service whose database has no log yet simply has nothing to add.
     */
    async function loggedChecks() {
        const rows = await db.prepare(`SELECT DISTINCT ON (provider_key, model_key) provider_key, model_key, checked_at
            FROM price_changes WHERE status IN ('applied', 'approved') ORDER BY provider_key, model_key, created_at DESC`)
            .all().catch(() => []);
        const map = new Map();
        for (const row of rows || []) map.set(`${row.provider_key}/${row.model_key}`, String(row.checked_at || '').slice(0, 10));
        return map;
    }

    /**
     * Every live offer, grouped by the model it serves.
     * days: the window the measured speed, uptime and request counts cover.
     * kind: only models of this kind (chat, embedding, stt, image); null for every kind.
     */
    async function models({ days = 7, kind = null } = {}) {
        const now = clock.now();
        const providers = await registry.listProviders();
        const byKey = new Map(providers.map((p) => [p.key, p]));
        const fidelityMap = fidelity ? await fidelity.read() : new Map();
        // The router's per-offer circuit (server/providers/index.js, migrations/0060) is the authority; a
        // provider-level provider_health row is still read for a state written before it (or by a test).
        // Measured failures are folded in below: over 5% of at least 10 requests in the last hour is degraded.
        const circuits = await db.prepare('SELECT * FROM provider_circuits').all().catch(() => []);
        const circuitBy = new Map((circuits || []).map((c) => [`${c.provider_key}/${c.model_key || ''}`, c]));
        const healthRows = await db.prepare('SELECT provider_key, state, opened_at, exhausted_at FROM provider_health').all().catch(() => []);
        const healthByKey = new Map((healthRows || []).map((h) => [h.provider_key, h]));
        const hourAgo = new Date(now - 3600000).toISOString();
        const measuredRows = await db.prepare(`SELECT provider_key, model_key,
                COUNT(*)::bigint AS requests,
                COUNT(*) FILTER (WHERE status IN ('error', 'timeout'))::bigint AS failures,
                MIN(created_at) FILTER (WHERE status IN ('error', 'timeout')) AS first_error,
                MIN(created_at) FILTER (WHERE error_class = 'balance') AS first_balance,
                MIN(created_at) FILTER (WHERE error_class = 'auth') AS first_auth,
                MAX(created_at) FILTER (WHERE status = 'ok') AS last_ok
            FROM requests WHERE created_at >= ? AND status IN ('ok', 'error', 'timeout')
            GROUP BY provider_key, model_key`).all(hourAgo).catch(() => []);
        const measuredBy = new Map((measuredRows || []).map((r) => [`${r.provider_key}/${r.model_key || ''}`, r]));
        const statusFor = (providerKey, modelKey) => {
            const key = `${providerKey}/${modelKey || ''}`;
            let circuit = circuitBy.get(key) || circuitBy.get(`${providerKey}/`) || null;
            if (!circuit) {
                const legacy = healthByKey.get(providerKey);
                if (legacy && legacy.state && legacy.state !== 'closed') {
                    circuit = { state: legacy.state, failure_class: legacy.exhausted_at ? 'balance' : null,
                        opened_at: legacy.opened_at, status_reason: legacy.exhausted_at ? 'the provider says the account is out of credit' : null };
                }
            }
            return offerStatus({ circuit, measured: measuredBy.get(key) || measuredBy.get(`${providerKey}/`) || null });
        };
        const upstreamByKey = new Map();
        for (const p of providers) upstreamByKey.set(p.key, upstream.upstreamOf(p));
        // What the price book recorded: the day a price was read and changed (server/pricebook/).
        const logged = await loggedChecks();
        // The measured refusal rates (server/refusal/): what each offer refused, and the day it was
        // measured. An offer nobody measured has no rate: null, never zero.
        const refusalRows = await db.prepare('SELECT provider_key, model_key, refusal_rate, prompt_set, measured_at, measured_on FROM refusal_rates').all().catch(() => []);
        const refusalBy = new Map((refusalRows || []).map((r) => [`${r.provider_key}/${r.model_key}`, r]));

        // The free allowance a provider states, and what it has used this period (usage_daily): the Exchange
        // shows the tokens that are left and their end date, beside the offer.
        const allowanceUsedCache = new Map();
        const allowanceUsedFor = async (providerKey, since) => {
            const cacheKey = `${providerKey}|${since || ''}`;
            if (allowanceUsedCache.has(cacheKey)) return allowanceUsedCache.get(cacheKey);
            let used = 0;
            try {
                const row = since
                    ? await db.prepare('SELECT COALESCE(SUM(tokens_in + tokens_out), 0)::bigint AS t FROM usage_daily WHERE provider_key = ? AND day >= ?').get(providerKey, since)
                    : await db.prepare('SELECT COALESCE(SUM(tokens_in + tokens_out), 0)::bigint AS t FROM usage_daily WHERE provider_key = ?').get(providerKey);
                used = Number((row && row.t) || 0);
            } catch { used = 0; }
            allowanceUsedCache.set(cacheKey, used);
            return used;
        };

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
            // The day this price was checked: what the price book logged, or the day the rate card carries.
            const checkedAt = laterOf(logged.get(`${row.provider_key}/${row.model_key}`), cards ? cards.out.verified_at : null);
            // The refusal rate of this offer, as the refusal job measured it.
            const refusal = refusalBy.get(`${row.provider_key}/${row.model_key}`) || null;
            const health = statusFor(provider.key, row.model_key);
            const providerTraits = (provider.metadata && provider.metadata.traits) || null;
            const allowanceRecord = traits.freeAllowanceOf(provider);
            const allowance = allowanceRecord
                ? traits.allowanceLeft(provider, { used: await allowanceUsedFor(provider.key, traits.allowancePeriodStart(provider, now)), now })
                : null;
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
                // up | degraded | down, measured from this offer's circuit and the last hour of requests.
                status: health.status,
                status_reason: health.status_reason,
                status_since: health.status_since,
                status_class: health.status_class,
                // Rounded to the micro-dollar: a derived cached price was printed as 0.020000000000000004.
                on_our_gpus: provider.key.startsWith('gpu.'),
                fixed_price: row.metadata?.owner_fixed_price === true,
                price: price ? { in: usd6(price.in), out: usd6(price.out), cached: usd6(price.cached), per: '1M tokens', currency: 'USD' } : null,
                // Where the number came from and when someone checked it; null when nobody recorded it.
                price_source: cards && cards.out.source && !String(cards.out.source).startsWith('urn:openvibe:ai:unverified:') ? cards.out.source : null,
                // When the price was checked: the day the price book recorded, or the day the card carries.
                price_checked_at: checkedAt && checkedAt !== rates.UNKNOWN_DATE ? checkedAt : null,
                // The same day in words: what the catalog shows under the price is when somebody read it.
                price_checked: checkedAt && checkedAt !== rates.UNKNOWN_DATE ? `price checked ${checkedAt}` : null,
                // The tier the offer runs on: an offer that names Flex (the OpenRouter Particle pin) says so;
                // a provider that sells a Flex tier is marked with the tier, never assumed to be serving it.
                service_tier: (row.metadata && row.metadata.service_tier) || null,
                // The classes of work the offer may answer. null means every class (the usual case).
                latency_class: traits.latencyClassesOf(provider, row),
                // The free allowance the provider states: tokens left, the period and its end date.
                free_allowance: allowance ? {
                    tokens: allowance.tokens, used: allowance.used, left: allowance.left, period: allowance.period,
                    shared: allowance.shared, ends_at: allowance.ends_at, ended: allowance.ended,
                } : null,
                data_policy: policyOf(provider),
                // The privacy label of this offer, from the same facts the router uses (server/exchange/privacy.js):
                // Private (zero retention, no training, or the host's own deployment), Anonymized, Community.
                privacy: privacy.view(privacy.labelFor({ record: provider })),
                // The measured refusal rate: a fraction between 0 and 1 (0.75 is three probes out of
                // four refused), with the day it was measured. null when nobody measured this offer.
                refusal_rate: refusal && refusal.refusal_rate != null ? Number(refusal.refusal_rate) : null,
                refusal_measured_on: refusal ? (String(refusal.measured_on || '').slice(0, 10) || null) : null,
                refusal_prompt_set: refusal ? (refusal.prompt_set || null) : null,
                // Bench's measured provider fidelity for this exact endpoint: score, n, interval, the model
                // it was compared on and when. Null when nobody measured it (missing is not zero).
                fidelity: fidelityMap.get(`${String(up.key).toLowerCase()}\0${String(row.model_key).toLowerCase()}`) || null,
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
                    open_weights: row.metadata?.open_weights === true,
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
        const measuredStats = observed.fold(measured, drafts);
        const shares = await require('../effort/analytics').cacheShares(db, clock);
        for (const d of drafts) {
            const stats = measuredStats.get(d);
            if (stats && stats.succeeded + stats.failed >= 20) {
                d.offer.cache_hit_share_7d = shares.get(`${d.providerKey}/${d.modelKey}`) ?? d.offer.cache_hit_share_7d;
            }
        }
        // The router's own measurements win once they have 20 samples; until then the observed runs' numbers stay.
        const performance = await db.prepare('SELECT * FROM provider_metrics').all();
        for (const d of drafts) {
            const p = performance.find((m) => m.provider_key === d.providerKey && m.model_key === d.modelKey);
            if (p && Number(p.ttft_samples) >= 20) d.offer.speed.ttft_ms = Number(p.ttft_ms);
            if (p && Number(p.decode_samples) >= 20) d.offer.speed.tokens_per_second = Number(p.decode_tps);
            d.offer.error_rate = d.offer.uptime == null ? null : 1 - d.offer.uptime;
        }

        const daysByModel = await db.prepare("SELECT model_key,substr(created_at,1,10) AS activity_day,COUNT(*)::int requests FROM runs WHERE created_at >= ? AND synthetic=0 AND status='succeeded' GROUP BY model_key,substr(created_at,1,10)").all(new Date(now-7*86400000).toISOString());
        const firstTokens = measured.latencies.map(r=>r.ttft_ms == null ? NaN : Number(r.ttft_ms)).filter(Number.isFinite).sort((a,b)=>a-b);
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
            // The model's own prompt-cache share over the same attempts, across its offers (null when no offer has
            // enough attempts to measure one).
            let tokensIn = 0, tokensCached = 0;
            for (const d of drafts) {
                if (!m.offers.includes(d.offer)) continue;
                const s = measuredStats.get(d);
                tokensIn += s.tokens_in;
                tokensCached += s.tokens_cached;
            }
            m.cache_hit_share_7d = tokensIn > 0 && m.offers.some((o) => o.cache_hit_share_7d != null)
                ? Math.min(1, Math.max(0, Math.round((tokensCached / tokensIn) * 10000) / 10000)) : null;
            const activity = new Map();
            for (const d of daysByModel.filter(d=>m.offers.some(o=>o.model===d.model_key))) activity.set(d.activity_day,(activity.get(d.activity_day)||0)+Number(d.requests));
            m.activity = [...activity].sort(([a],[b])=>a.localeCompare(b)).map(([day,requests])=>({day,requests}));
            m.community = m.offers.some((o) => o.trust === 'community');
            m.priced = m.offers.some((o) => o.price);
            // Free right now: a free-tier offer whose provider can answer (not exhausted, not down).
            for (const o of m.offers) o.free_now = Boolean(o.free_tier) && (o.status === 'up' || o.status === 'degraded');
            m.free_now = m.offers.some((o) => o.free_now);
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
            median_ttft_ms: firstTokens.length >= 20 ? firstTokens[Math.floor(firstTokens.length/2)] : null,
            window_days: days,
            ...(kind ? { kind } : {}),
            count: models.length,
            // Whether any chat model can serve the free allowance right now (Exchange says "free paused" when not).
            free_available: models.some((m) => m.kind === 'chat' && m.free_now),
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
