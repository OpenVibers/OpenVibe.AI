'use strict';
/**
 * The record of one AI call (plan L40) and the money of it.
 *
 * OpenVibe.AI does not keep the meter: it writes one ai.call.recorded@1 per run through its own events publisher
 * (server/events.js) and OpenVibe.Report keeps the ledger. So this module builds the record and the money, and
 * nothing else: no tables, no roll-ups, no routes.
 *
 * The record carries the tokens (with the cache read and the cache write counted apart), the list cost, the charged
 * cost, the fee and what the cache saved. It never carries a prompt or an answer.
 */
const { num } = require('./providers/usage');

const PAID_BY = ['own_key', 'openvibe_key', 'plan', 'own_machine', 'free_tier', 'network_allowance', 'org_key'];

const iso = (v) => (v instanceof Date ? v : new Date(v)).toISOString();
/** Six decimals, the way money is written here. */
const money = (v) => Math.round((Number(v) || 0) * 1e6) / 1e6;

// ── The money of one record ────────────────────────────────────────────────────────────

/**
 * The prices of one call, from the human-typed price table (server/providers/rate-cards.js cards): the input,
 * the output, the cache read and the cache write, each per million tokens.
 *
 * A cache price that nobody typed is not made up: the cache tokens are then priced at the plain input price and
 * the record says so ('no cache price'). The card's own source says where each number came from.
 */
function pricesOf(cards) {
    const origin = (c) => {
        const m = /^urn:openvibe:ai:unverified:(.+)$/.exec(String((c && c.source) || ''));
        return m ? m[1] : 'models';
    };
    const typed = (c) => {
        const o = origin(c);
        return o !== 'derived' && o !== 'flat' && o !== 'unpriced';
    };
    const inPrice = cards && cards.in ? Number(cards.in.unit_price_usd) || 0 : 0;
    const outPrice = cards && cards.out ? Number(cards.out.unit_price_usd) || 0 : 0;
    const cacheReadTyped = Boolean(cards && cards.cached && typed(cards.cached));
    const cacheWriteTyped = Boolean(cards && cards.cache_write && typed(cards.cache_write));
    return {
        in: inPrice,
        out: outPrice,
        cache_read: cacheReadTyped ? Number(cards.cached.unit_price_usd) || 0 : inPrice,
        cache_write: cacheWriteTyped ? Number(cards.cache_write.unit_price_usd) || 0 : inPrice,
        cache_priced: cacheReadTyped && cacheWriteTyped,
        source: (cacheReadTyped && cacheWriteTyped) ? origin(cards.in) : 'no cache price',
        date: (cards && cards.in && cards.in.verified_at && cards.in.verified_at !== '1970-01-01') ? cards.in.verified_at
            : (cards && cards.in && cards.in.effective_from && cards.in.effective_from !== '1970-01-01' ? cards.in.effective_from : null),
    };
}

/**
 * The money of one record: what the tokens cost at the list prices, what the cache saved against the plain input
 * price, and what the payer was charged. A person's own key, their own machine, their plan, a free tier and an
 * organisation's key are never charged here (0): the money left their own pocket. The OpenVibe key and the
 * network's allowance pay the list cost; the OpenVibe key also carries the network's fee.
 */
function moneyOf({ prices, tokens, paidBy, feeRate = 0 }) {
    const input = num(tokens.input);
    const output = num(tokens.output);
    const cacheRead = num(tokens.cache_read);
    const cacheWrite = num(tokens.cache_write);
    const list = money((input / 1e6) * prices.in + (output / 1e6) * prices.out
        + (cacheRead / 1e6) * prices.cache_read + (cacheWrite / 1e6) * prices.cache_write);
    const atInputPrice = money(((cacheRead + cacheWrite) / 1e6) * prices.in);
    const asPriced = money((cacheRead / 1e6) * prices.cache_read + (cacheWrite / 1e6) * prices.cache_write);
    const saved = money(Math.max(0, atInputPrice - asPriced));
    const pays = paidBy === 'openvibe_key' || paidBy === 'network_allowance';
    const charged = pays ? list : 0;
    const fee = paidBy === 'openvibe_key' ? money(charged * (Number(feeRate) || 0)) : 0;
    return { list_cost_usd: list, charged_usd: charged, fee_usd: fee, cache_saved_usd: saved };
}

// ── The record ─────────────────────────────────────────────────────────────────────────

/** One record, ready to be published: the numbers checked, the text never carried. */
function recordOf({ system = 'ai', run_id: runId = null, turn_id: turnId = null, subject = null, attribution = '', surface = '',
    provider = null, model = null, effort = null, paid_by: paidBy, paid_by_detail: paidByDetail = null,
    input = 0, output = 0, reasoning = 0, cache_read: cacheRead = 0, cache_write: cacheWrite = 0, cache_write_ttl: cacheWriteTtl = null,
    images = 0, audio_seconds: audioSeconds = 0, video_seconds: videoSeconds = 0,
    list_cost_usd: listCost = 0, charged_usd: charged = 0, fee_usd: fee = 0, cache_saved_usd: cacheSaved = 0,
    price_source: priceSource = '', price_date: priceDate = null, latency_ms: latencyMs = null, ttft_ms: ttftMs = null,
    attempts = 1, outcome = 'succeeded', at = new Date() }) {
    if (!PAID_BY.includes(paidBy)) throw new Error(`paid_by must be one of ${PAID_BY.join(', ')}`);
    return {
        system: String(system || 'ai'),
        run_id: runId || null,
        turn_id: turnId || null,
        subject: subject || null,
        attribution: String(attribution || ''),
        surface: String(surface || ''),
        provider: provider || null,
        model: model || null,
        effort: effort || null,
        paid_by: paidBy,
        paid_by_detail: paidByDetail || null,
        tokens_input: num(input),
        tokens_output: num(output),
        tokens_reasoning: num(reasoning),
        tokens_cache_read: num(cacheRead),
        tokens_cache_write: num(cacheWrite),
        cache_write_ttl: cacheWriteTtl || null,
        images: num(images),
        audio_seconds: Number(audioSeconds) || 0,
        video_seconds: Number(videoSeconds) || 0,
        list_cost_usd: money(listCost),
        charged_usd: money(charged),
        fee_usd: money(fee),
        cache_saved_usd: money(cacheSaved),
        price_source: String(priceSource || ''),
        price_date: priceDate || null,
        latency_ms: latencyMs == null ? null : num(latencyMs),
        ttft_ms: ttftMs == null ? null : num(ttftMs),
        attempts: Math.max(0, num(attempts)),
        outcome: String(outcome || 'succeeded'),
        at: iso(at),
    };
}

module.exports = { PAID_BY, money, pricesOf, moneyOf, recordOf, iso };
