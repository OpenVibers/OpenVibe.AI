'use strict';
/**
 * Rate cards (platform.rate-card@1) and provider states (platform.provider-state@1) for the router.
 *
 * Every price AI charges or ranks on is read from one of these cards, so priceFor/costOf and the cards
 * handed to openvibe-sdk/placement can never disagree. The numbers come from AI's existing price
 * sources, in Live's order, per metric:
 *
 *   models row  cost_in/out/cached_per_mtok (+ its provenance columns, migrations/0004)
 *   pricing     AI_PRICING_JSON, longest model prefix, else its `default` entry (+ optional provenance keys)
 *   flat        AI_INPUT_COST_PER_MTOK / AI_OUTPUT_COST_PER_MTOK
 *   derived     cached input when nothing sets it: 10 % of the input price (the existing rule)
 *
 * Input, cached input and output are separate cards (metric `<kind>-tokens:<model>`, unit_size 1e6, the
 * price per million tokens exactly as configured — never rounded or changed). Rate cards change only by
 * review: this module never makes up a price, an allowance or a provenance.
 *
 * Unknown provenance stays visibly unknown, the same way everywhere: `effective_from` and `verified_at`
 * are UNKNOWN_DATE (the epoch, 1970-01-01) and `source` is `urn:openvibe:ai:unverified:<origin>`, naming
 * where AI took the number from. `free_allowance` is 0 and `reset_period` 'month' unless configured.
 */

const UNKNOWN_DATE = '1970-01-01';
const unverified = (origin) => `urn:openvibe:ai:unverified:${origin}`;
const KINDS = { in: 'input', cached: 'cached-input', out: 'output' };
const RESET_PERIODS = ['day', 'month', 'none'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const URI = /^[a-z][a-z0-9+.-]*:[^\s]+$/i;

const metricFor = (kind, model) => (model ? `${KINDS[kind]}-tokens:${model}` : `${KINDS[kind]}-tokens`);
const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const isDate = (v) => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** Configured provenance (a models row or an AI_PRICING_JSON entry), each field only when it is valid. */
function provenance(src = {}) {
    const p = {};
    if (isDate(src.effective_from)) p.effective_from = src.effective_from;
    if (isDate(src.effective_until)) p.effective_until = src.effective_until;
    if (typeof src.source === 'string' && URI.test(src.source)) p.source = src.source;
    if (isDate(src.verified_at)) p.verified_at = src.verified_at;
    if (finite(src.free_allowance) && Number(src.free_allowance) >= 0) p.free_allowance = Number(src.free_allowance);
    if (RESET_PERIODS.includes(src.reset_period)) p.reset_period = src.reset_period;
    return p;
}

/** Longest-prefix AI_PRICING_JSON entry for a model, else its `default` entry, else null. */
function tableEntry(table, model) {
    const m = String(model || '').toLowerCase();
    let best = null; let bestLen = -1;
    for (const [k, v] of Object.entries(table || {})) {
        const key = String(k).toLowerCase();
        if (key === 'default') continue;
        if (m.startsWith(key) && key.length > bestLen && v && typeof v === 'object') { best = v; bestLen = key.length; }
    }
    if (!best && table && table.default && typeof table.default === 'object') best = table.default;
    return best;
}

/** One platform.rate-card@1: exactly the schema's fields, unknown provenance per the convention above. */
function card(providerKey, model, kind, price, origin, prov = {}) {
    const c = {
        id: `${model ? `${providerKey}:${model}` : providerKey}/${KINDS[kind]}-tokens`,
        provider: providerKey,
        metric: metricFor(kind, model),
        unit_size: 1e6,
        unit_price_usd: price,
        free_allowance: prov.free_allowance ?? 0,
        reset_period: prov.reset_period || 'month',
        effective_from: prov.effective_from || UNKNOWN_DATE,
        source: prov.source || unverified(origin),
        verified_at: prov.verified_at || UNKNOWN_DATE,
    };
    if (prov.effective_until) c.effective_until = prov.effective_until;
    return c;
}

/** A price taken from elsewhere keeps the entry's allowance terms but not its source or dates. */
const allowanceOnly = (prov) => ({ free_allowance: prov.free_allowance, reset_period: prov.reset_period });

/**
 * The cards for one provider + model: { in, cached, out } from the models row, else AI_PRICING_JSON, else
 * the flat rates (cached: else 10 % of input). `flat: false` is the person's-own-key path, which never
 * used the models row or the flat rates: AI_PRICING_JSON only, else 0.
 */
function buildCards({ providerKey, model, row = null, pricing = {}, flat = true }) {
    const make = (kind, price, origin, prov) => card(providerKey, model, kind, price, origin, prov);
    if (flat && row && row.cost && Number.isFinite(row.cost.in_per_mtok)) {
        const prov = provenance(row.cost);
        const inRate = row.cost.in_per_mtok;
        return {
            in: make('in', inRate, 'models', prov),
            cached: row.cost.cached_per_mtok != null ? make('cached', Number(row.cost.cached_per_mtok), 'models', prov)
                : make('cached', inRate * 0.1, 'derived', allowanceOnly(prov)),
            out: make('out', Number(row.cost.out_per_mtok) || 0, 'models', prov),
        };
    }
    const best = tableEntry(pricing.table, model);
    const prov = provenance(best || {});
    if (!flat) {
        // A person's own key: AI_PRICING_JSON only, as before (an unset price is 0, never the flat rates).
        const b = best || {};
        const inRate = Number(b.in) || 0;
        return {
            in: make('in', inRate, best && b.in != null ? 'pricing' : 'unpriced', prov),
            cached: b.cached != null ? make('cached', Number(b.cached), 'pricing', prov) : make('cached', inRate * 0.1, 'derived', allowanceOnly(prov)),
            out: make('out', Number(b.out) || 0, best && b.out != null ? 'pricing' : 'unpriced', prov),
        };
    }
    const has = (field) => Boolean(best) && best[field] != null && best[field] !== '' && Number.isFinite(Number(best[field]));
    const inRate = has('in') ? Number(best.in) : pricing.inputPerMtok;
    return {
        in: has('in') ? make('in', inRate, 'pricing', prov) : make('in', inRate, 'flat', allowanceOnly(prov)),
        cached: has('cached') ? make('cached', Number(best.cached), 'pricing', prov) : make('cached', inRate * 0.1, 'derived', allowanceOnly(prov)),
        out: has('out') ? make('out', Number(best.out), 'pricing', prov) : make('out', pricing.outputPerMtok, 'flat', allowanceOnly(prov)),
    };
}

/** Per-million-token prices read off the cards. */
const pricesOf = (cards) => ({ in: cards.in.unit_price_usd, out: cards.out.unit_price_usd, cached: cards.cached.unit_price_usd });

/** USD for one call's usage, priced on its cards (input excludes the cached part, as providers bill). */
function costOfUsage(cards, usage = {}) {
    const cached = usage.cached || 0;
    const input = Math.max(0, (usage.input || 0) - cached);
    return (input / cards.in.unit_size) * cards.in.unit_price_usd + (cached / cards.cached.unit_size) * cards.cached.unit_price_usd
        + ((usage.output || 0) / cards.out.unit_size) * cards.out.unit_price_usd;
}

/** How far back a never-resetting ('none') card counts usage: usage_daily keeps every day, so the window is bounded. */
const NONE_LOOKBACK_DAYS = 366;

/**
 * The billing period that holds `now` for a reset period, UTC. 'none' never resets: from the card's
 * `effective_from` (`since`, when known) up to now, but never further back than NONE_LOOKBACK_DAYS.
 * An `effective_from` later than the start of today (a card not yet in effect) counts from the
 * start of today, matching usageSince's day bound.
 */
function periodOf(resetPeriod, now, since) {
    const d = new Date(now);
    if (resetPeriod === 'day') {
        const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        return { start, end: start + 86400000 };
    }
    if (resetPeriod === 'none') {
        const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        const floor = today - NONE_LOOKBACK_DAYS * 86400000;
        const from = since ? Date.parse(since) : NaN;
        return { start: Number.isFinite(from) && from > floor ? Math.min(from, today) : floor, end: now };
    }
    return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}
const cardPeriod = (card, now) => periodOf(card.reset_period, now, card.effective_from);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The first usage_daily day any of these cards counts: the query bound for one provider's state. */
function usageSince(cards, now) {
    return dayOf(Math.min(...cards.map(c => cardPeriod(c, now).start)));
}

const BREAKER_HEALTH = { closed: 'up', half_open: 'degraded', open: 'down' };

/**
 * One platform.provider-state@1 for a provider. Each metric counts and forecasts over its own card's period
 * (a provider's models may reset differently), from usage_daily rows {day, model_key, tokens_in, tokens_out,
 * tokens_cached}; a row without `day` is taken as inside every period. The state's own period_start/period_end
 * is the shortest reset period among its cards (day, else month, else none). The reserve only when the
 * provider's config sets one, and the breaker as health.
 */
function providerState({ provider, cards, usageRows = [], breaker = 'closed', reserve = null, now }) {
    const periods = {};
    const used = {};
    for (const c of cards) { periods[c.metric] = cardPeriod(c, now); used[c.metric] = 0; }
    const firstDay = Object.fromEntries(Object.entries(periods).map(([m, p]) => [m, dayOf(p.start)]));
    for (const r of usageRows) {
        const model = r.model_key || null;
        const add = (kind, n) => {
            const m = metricFor(kind, model);
            if (m in used && !(r.day && String(r.day) < firstDay[m])) used[m] += Math.max(0, Number(n) || 0);
        };
        add('in', (Number(r.tokens_in) || 0) - (Number(r.tokens_cached) || 0));
        add('cached', r.tokens_cached);
        add('out', r.tokens_out);
    }
    const forecast = Object.fromEntries(Object.entries(used).map(([m, n]) => {
        const { start, end } = periods[m];
        const elapsed = Math.max(1, now - start);
        return [m, n * (Math.max(elapsed, end - start) / elapsed)];
    }));
    const shortest = RESET_PERIODS.find(rp => cards.some(c => c.reset_period === rp));
    const { start, end } = shortest ? cardPeriod(cards.find(c => c.reset_period === shortest), now) : periodOf('month', now);
    const state = {
        provider, period_start: new Date(start).toISOString(), period_end: new Date(Math.max(end, start)).toISOString(),
        usage: used, forecast,
    };
    const res = reserve && typeof reserve === 'object'
        ? Object.fromEntries(Object.entries(reserve).filter(([, v]) => finite(v) && Number(v) >= 0 && Number(v) <= 1).map(([m, v]) => [m, Number(v)]))
        : {};
    if (Object.keys(res).length) state.reserve = res;
    state.health = BREAKER_HEALTH[breaker] || 'up';
    state.updated_at = new Date(now).toISOString();
    return state;
}

module.exports = { UNKNOWN_DATE, unverified, metricFor, provenance, tableEntry, buildCards, pricesOf, costOfUsage, periodOf, usageSince, providerState, NONE_LOOKBACK_DAYS, BREAKER_HEALTH };
