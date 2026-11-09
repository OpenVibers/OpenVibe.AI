'use strict';
const { AiError } = require('../util');
const { checkEffort } = require('./providers');
const round = v => v == null ? null : Math.round(Number(v) * 1e8) / 1e8;
function createAnalytics({ db, catalog, registry = null, pool = null, clock = { now: () => Date.now() } }) {
    const cache = new Map();
    async function estimate(query) {
        const model = query.model;
        if (typeof model !== 'string' || !model || model.length > 256) throw new AiError(422, 'input.invalid', 'model is required');
        const effort = checkEffort(query.effort || 'medium');
        if (effort === 'auto') throw new AiError(422, 'input.invalid', 'estimate requires a resolved effort');
        const kind = query.kind === undefined ? null : query.kind;
        if (kind !== null && (typeof kind !== 'string' || !/^[a-z][a-z0-9_.-]{0,99}$/.test(kind))) throw new AiError(422, 'input.invalid', 'invalid kind');
        const input = query.input_tokens === undefined ? null : Number(query.input_tokens);
        if (input !== null && (!Number.isSafeInteger(input) || input < 1 || input > 10000000)) throw new AiError(422, 'input.invalid', 'input_tokens must be an integer from 1 to 10000000');
        const key = JSON.stringify([model, effort, kind, input]);
        const hit = cache.get(key);
        if (hit && hit.until > clock.now()) return hit.value;
        const data = await catalog.models({ days: 7 });
        const prices = [];
        for (const m of data.models || []) for (const o of m.offers || []) {
            if (![m.slug, m.canonical, o.model, `${o.provider}/${o.model}`].includes(model) || !o.price) continue;
            prices.push({ provider: o.provider, model: o.model, pin: o.price.in, pout: o.price.out, pcached: o.price.cached == null ? o.price.in : o.price.cached });
        }
        // Catalog provider names are public upstream names (the internal shared route
        // may display as openai). Receipts keep route keys; price those exact routes.
        if (registry && pool && prices.length) {
            const publicPrices = prices.splice(0);
            const providers = new Map((await registry.listProviders()).map(p => [p.key, p]));
            for (const row of await registry.listModels()) {
                const provider = providers.get(row.provider_key);
                if (!provider) continue;
                const shown = require('../providers/upstream').upstreamOf(provider).key;
                if (!publicPrices.some(p => p.provider === shown && p.model === row.model_key)) continue;
                const cards = await pool.rateCardsFor(row.provider_key, row.model_key);
                if (!cards) continue;
                const p = require('../providers/rate-cards').pricesOf(cards);
                prices.push({ provider: row.provider_key, model: row.model_key, pin: p.in, pout: p.out, pcached: p.cached == null ? p.in : p.cached });
            }
        }
        const basis = { window_days: 30, percentile: [25, 75], model, effort, kind, input_tokens: input, pricing: 'current offer prices; output/input and cache/input ratios when input_tokens supplied' };
        const row = prices.length ? await db.prepare(`WITH samples AS (
            SELECT a.body::jsonb AS b FROM ai_receipts a JOIN runs r ON r.id = a.run_id
            WHERE a.created_at >= ? AND r.status = 'succeeded' AND r.synthetic = 0
              AND COALESCE(NULLIF(a.body::jsonb->>'effort_requested', 'auto'), a.body::jsonb->>'effort_applied') = ?
              AND (?::text IS NULL OR a.body::jsonb->>'kind' = ?)
        ), tokens AS (
            SELECT b, (b->'usage'->>'tokens_in')::numeric ti,
                (b->'usage'->>'tokens_out')::numeric tout,
                COALESCE((b->'usage'->>'tokens_cached')::numeric, 0) tc
            FROM samples
        ), costs AS (
            SELECT ((GREATEST(ti - LEAST(tc, ti), 0) * p.pin + LEAST(tc, ti) * p.pcached + tout * p.pout)
                * CASE WHEN ?::numeric IS NULL THEN 1 ELSE ?::numeric / NULLIF(ti, 0) END) / 1000000 AS cost
            FROM tokens JOIN jsonb_to_recordset(?::jsonb) AS p(provider text, model text, pin numeric, pout numeric, pcached numeric)
                ON b->'offer'->>'provider' = p.provider AND b->'offer'->>'model' = p.model
            WHERE ti > 0 AND tout >= 0
        ) SELECT COUNT(cost)::int n, percentile_cont(0.25) WITHIN GROUP (ORDER BY cost) low,
            percentile_cont(0.75) WITHIN GROUP (ORDER BY cost) high FROM costs`).get(new Date(clock.now() - 30 * 86400000).toISOString(), effort, kind, kind, input, input, JSON.stringify(prices)) : { n: 0 };
        const n = Number(row.n);
        const value = { low_usd: n < 20 ? null : round(row.low), high_usd: n < 20 ? null : round(row.high), n, basis: { ...basis, status: n < 20 ? 'no_data' : 'receipts' } };
        if (cache.size >= 128) cache.delete(cache.keys().next().value);
        cache.set(key, { until: clock.now() + 30000, value });
        return value;
    }
    async function ladder(id, principal) {
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new AiError(422, 'input.invalid', 'invalid ladder id');
        const subject = principal.subject || {};
        const ob = principal.onBehalfOf || principal.claims && principal.claims.on_behalf_of;
        const owner = typeof ob === 'object' ? ob && ob.id : ob;
        const rows = await db.prepare(`SELECT (body::jsonb->>'effort_rung')::int rung,
            COUNT(*)::int n, SUM(COALESCE((body::jsonb->>'cost_usd')::numeric, 0)) cost_usd
            FROM ai_receipts WHERE body::jsonb->>'ladder_id' = ?
            AND ((requester_type = ? AND requester_id = ?) OR (owner_type = 'user' AND owner_id = ?))
            GROUP BY (body::jsonb->>'effort_rung')::int ORDER BY rung`).all(id, subject.type || '', subject.id || '', owner || (subject.type === 'user' ? subject.id : ''));
        if (!rows.length) throw new AiError(404, 'ladder.not_found', 'no such ladder');
        const rungs = rows.map(r => ({ rung: Number(r.rung), n: Number(r.n), cost_usd: round(r.cost_usd) }));
        return { ladder_id: id, cost_usd: round(rungs.reduce((n, r) => n + r.cost_usd, 0)), rungs };
    }
    return { estimate, ladder };
}
async function cacheShares(db, clock) {
    const rows = await db.prepare(`SELECT q.provider_key, q.model_key, SUM(q.tokens_in)::numeric input,
        SUM(q.tokens_cached)::numeric cached FROM requests q JOIN runs r ON r.id = q.run_id
        WHERE q.created_at >= ? AND q.status = 'ok' AND r.synthetic = 0
        GROUP BY q.provider_key, q.model_key`).all(new Date(clock.now() - 7 * 86400000).toISOString());
    return new Map(rows.map(r => [`${r.provider_key}/${r.model_key}`, Number(r.input) > 0 ? Math.min(1, Math.max(0, Number(r.cached) / Number(r.input))) : null]));
}
module.exports = { createAnalytics, cacheShares };
