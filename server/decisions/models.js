'use strict';
/**
 * The models that can answer decisions (2026-11-14; the owner's "easy to switch, more providers, smarter
 * routing"). One list, read from what the router already knows — the registry's providers and models, the
 * rate cards and the runs that really happened — so a model is never listed twice or priced twice.
 *
 *   GET /api/v1/decisions/models → { models: [...], count, generated_at }
 *
 *   { id, provider, name, price_in_per_mtok, price_out_per_mtok, speed_p50_ms, calibrated, max_questions,
 *     inputs: ['text', 'image', …], available }
 *
 *   id             "<provider>/<model>" — what POST /api/v1/decisions takes as `model`.
 *   price_*        USD per 1M tokens; null when the provider publishes no price (a free offer).
 *   speed_p50_ms   the measured median answer time; null when nobody measured it (never zero).
 *   calibrated     true only for Google's Decisions API, whose probabilities are calibrated. Every other
 *                  model estimates them, and the answer says so.
 *   max_questions  how many questions one call may carry.
 *   inputs         what the model can read: text, image, audio, video, document.
 *   available      the offer can answer right now: a key is configured and its circuit is closed.
 *
 * Two kinds of model are here:
 *   gemini/gemini-decision-1   Google's Decisions API (one forward pass, calibrated probabilities, pictures,
 *                              audio, video and PDFs; $0.10 per 1M input tokens, nothing for output).
 *   <provider>/<model>         every catalogue model that can answer with structured output (a JSON schema)
 *                              from an active provider: the router's cheap route can ask it the same
 *                              closed-set questions, and its probabilities are estimated.
 *
 * The read is cached for ten minutes: the list moves when a provider or a price changes, not every second.
 */
const { providerSecret } = require('../util');
const upstream = require('../providers/upstream');

const GEMINI_PROVIDER = 'gemini';
const GEMINI_MODEL = 'gemini-decision-1';
const GEMINI_ID = GEMINI_PROVIDER + '/' + GEMINI_MODEL;
const GEMINI_PER_MTOK = 0.10;
const GEMINI_MAX_QUESTIONS = 1000;
const GEMINI_INPUTS = Object.freeze(['text', 'image', 'audio', 'video', 'document']);
/** The router's structured route answers at most this many questions in one call (server/workflows/decide.js). */
const ROUTER_MAX_QUESTIONS = 100;
const CACHE_TTL_MS = 10 * 60 * 1000;

/** The price of an offer: null means the provider publishes no per-token price (a free offer). */
const priceOf = (offer) => {
    const p = offer && offer.price;
    if (!p) return { in: null, out: null };
    return { in: p.in == null ? null : Number(p.in), out: p.out == null ? null : Number(p.out) };
};

/** The measured median answer time of an offer, or null when nobody measured it. */
const speedOf = (offer) => {
    const s = offer && offer.speed;
    const v = s && s.p50_ms != null ? Number(s.p50_ms) : null;
    return Number.isFinite(v) ? v : null;
};

/** Cheapest first: a free offer (no published price) comes before a priced one. */
const byPrice = (a, b) => {
    const pa = (a.price_in_per_mtok == null ? 0 : a.price_in_per_mtok) + (a.price_out_per_mtok == null ? 0 : a.price_out_per_mtok);
    const pb = (b.price_in_per_mtok == null ? 0 : b.price_in_per_mtok) + (b.price_out_per_mtok == null ? 0 : b.price_out_per_mtok);
    return pa - pb || String(a.id).localeCompare(String(b.id));
};

/**
 * The decision models of one service. `catalog` is the Exchange catalogue (server/exchange/catalog.js); the
 * default one is built here from the registry, the pool and the database.
 */
function createDecisionModels({ registry, pool, db, config = {}, env = process.env, clock = { now: () => Date.now() }, log = console, catalog = null }) {
    const catalogue = catalog || require('../exchange/catalog').createCatalog({ db, registry, pool, config, env, clock });
    let cached = null;

    /** Google's Decisions API model: always listed, available when a Gemini key is there. */
    async function geminiEntry() {
        let available = false;
        try {
            const row = registry && registry.getProvider ? await registry.getProvider(GEMINI_PROVIDER) : null;
            available = Boolean(row ? providerSecret(row, env) : env.GEMINI_API_KEY);
        } catch { available = false; }
        return {
            id: GEMINI_ID, provider: GEMINI_PROVIDER, name: "Google's Decisions API",
            price_in_per_mtok: GEMINI_PER_MTOK, price_out_per_mtok: 0, speed_p50_ms: null,
            calibrated: true, max_questions: GEMINI_MAX_QUESTIONS, inputs: [...GEMINI_INPUTS], available,
        };
    }

    /** Every catalogue model that can answer with structured output, from an active provider. */
    async function catalogueEntries() {
        const providers = new Map((await registry.listProviders()).map((p) => [p.key, p]));
        const rows = await registry.listModels();
        const cat = await catalogue.models({ days: 7, kind: 'chat' });
        // The catalogue's offers, by the upstream that serves them and the model it serves.
        const offers = new Map();
        for (const m of cat.models || []) {
            for (const o of m.offers || []) offers.set(o.provider + '/' + o.model, { offer: o, modalities: m.modalities || ['text'] });
        }
        const out = [];
        const seen = new Set();
        for (const row of rows) {
            if (!row || row.status !== 'active') continue;
            if (!['chat', 'vision'].includes(row.type)) continue;
            const supports = row.supports || {};
            if (!supports.json) continue;                      // structured output only
            const p = providers.get(row.provider_key);
            if (!p || p.status !== 'active') continue;
            if (p.kind === 'stub' || (p.metadata && (p.metadata.synthetic || p.metadata.hidden === true))) continue;
            const up = upstream.upstreamOf(p);
            if (!up) continue;
            const found = offers.get(up.key + '/' + row.model_key);
            if (!found) continue;                               // not offered: no key, or not sellable
            const id = row.provider_key + '/' + row.model_key;
            if (seen.has(id)) continue;
            seen.add(id);
            const price = priceOf(found.offer);
            const inputs = (found.modalities || ['text']).filter((m) => ['text', 'image', 'audio'].includes(m));
            out.push({
                id, provider: row.provider_key, name: row.display_name || row.model_key,
                price_in_per_mtok: price.in, price_out_per_mtok: price.out,
                speed_p50_ms: speedOf(found.offer),
                calibrated: false, max_questions: ROUTER_MAX_QUESTIONS,
                inputs: inputs.length ? inputs : ['text'],
                available: found.offer.status === 'up' || found.offer.status === 'degraded',
            });
        }
        return out;
    }

    async function build() {
        const list = [];
        try { list.push(await geminiEntry()); } catch (err) { log.warn('[ai] decisions models: the Google model could not be read: ' + String(err && err.message || err).slice(0, 160)); }
        try { list.push(...await catalogueEntries()); }
        catch (err) { log.warn('[ai] decisions models: the catalogue could not be read: ' + String(err && err.message || err).slice(0, 160)); }
        list.sort((a, b) => (a.calibrated === b.calibrated ? byPrice(a, b) : (a.calibrated ? -1 : 1)));
        return { models: list, count: list.length, generated_at: new Date(clock.now()).toISOString() };
    }

    /** The list, cached for ten minutes. */
    async function list({ force = false } = {}) {
        if (!force && cached && clock.now() - cached.at < CACHE_TTL_MS) return cached.value;
        const value = await build();
        cached = { at: clock.now(), value };
        return value;
    }

    /** One model by its id ("<provider>/<model>"), or null when there is none. */
    async function find(id) {
        const wanted = String(id == null ? '' : id).trim();
        if (!wanted) return null;
        const all = await list();
        return all.models.find((m) => m.id === wanted) || null;
    }

    /** The ladder of a kind when the owner set none: the available structured models, cheapest first. */
    async function defaultLadder() {
        const all = await list();
        return all.models.filter((m) => !m.calibrated && m.available).sort(byPrice).map((m) => m.id);
    }

    return { list, find, defaultLadder, invalidate: () => { cached = null; }, CACHE_TTL_MS, GEMINI_ID, GEMINI_MODEL, GEMINI_PROVIDER };
}

module.exports = {
    createDecisionModels, GEMINI_ID, GEMINI_MODEL, GEMINI_PROVIDER, GEMINI_PER_MTOK, GEMINI_MAX_QUESTIONS,
    GEMINI_INPUTS, ROUTER_MAX_QUESTIONS, CACHE_TTL_MS, byPrice,
};
