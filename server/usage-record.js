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

// ── The shape of a call (ai.call.recorded@1 1.1.0) ─────────────────────────────────────
//
// The new fields are all optional. The operation is one of the contract's names: the run's own operation
// (generate, summarize, chat, embed, image, speak, transcribe) is mapped onto it, never invented.
const OPERATIONS = Object.freeze(['chat', 'completion', 'embedding', 'image', 'image_edit', 'speech', 'transcription',
    'translation', 'rerank', 'moderation', 'decision', 'realtime', 'batch', 'tool', 'other']);
const PLACES = Object.freeze(['provider', 'machine', 'community', 'plan', 'host']);
const OP_ALIASES = Object.freeze({
    chat: 'chat', complete: 'chat', completion: 'completion', messages: 'chat', passthrough: 'chat',
    generate: 'chat', summarize: 'chat', classify: 'chat', extract: 'chat', enrich: 'chat',
    embed: 'embedding', embedding: 'embedding',
    transcribe: 'transcription', transcription: 'transcription', translate: 'translation', translation: 'translation',
    image: 'image', image_edit: 'image_edit', picture: 'image',
    speak: 'speech', speech: 'speech', rerank: 'rerank', moderation: 'moderation',
    decide: 'decision', decision: 'decision', realtime: 'realtime', batch: 'batch', tool: 'tool', other: 'other',
});

/**
 * The contract's operation for a run: the workflow key names the special ones (decide.*, moderation.*,
 * live.translate, a rerank), then the operation the engine/provider called, then the workflow's first step.
 */
function operationOf({ workflowKey = null, workflow = null, operation = null } = {}) {
    const key = String(workflowKey || '');
    if (/^decide\./.test(key)) return 'decision';
    if (/moderation/.test(key)) return 'moderation';
    if (/translat/.test(key)) return 'translation';
    if (/rerank/.test(key)) return 'rerank';
    if (operation) {
        const mapped = OP_ALIASES[String(operation).toLowerCase()];
        if (mapped) return mapped;
        return 'other';
    }
    const steps = workflow && Array.isArray(workflow.steps) ? workflow.steps : [];
    const step = steps.find(s => s && ['llm', 'passthrough', 'complete', 'messages', 'transcribe', 'embed', 'image', 'speak', 'picture'].includes(s.kind)) || steps[0];
    if (!step) {
        if (/image/.test(key)) return 'image';
        if (/embed/.test(key)) return 'embedding';
        if (/transcri|\.stt\b/.test(key)) return 'transcription';
        if (/speak|speech|tts/.test(key)) return 'speech';
        return null;
    }
    if (step.kind === 'transcribe') return 'transcription';
    if (step.kind === 'embed') return 'embedding';
    if (step.kind === 'image' || step.kind === 'picture') return 'image';
    if (step.kind === 'speak') return 'speech';
    if (step.operation) return OP_ALIASES[String(step.operation).toLowerCase()] || 'other';
    return 'chat';
}

/**
 * The contract's error class, from a provider attempt's class and its words. The provider router's five
 * classes (balance, auth, rate_limit, transient, request) are finer than the meter needs; the meter keeps
 * the shape the ledger and Report group by (rate_limited, timeout, context_length, refused, auth, server,
 * network, invalid).
 */
function errorClassOf({ failureClass = null, code = null, message = null, status = null } = {}) {
    const text = `${code || ''} ${message || ''}`.toLowerCase();
    const cls = failureClass ? String(failureClass) : null;
    if (cls === 'rate_limit') return 'rate_limited';
    if (cls === 'auth' || cls === 'balance') return 'auth';
    if (cls === 'transient') {
        if (code === 'provider.timeout' || /timeout|timed out|no response within/.test(text)) return 'timeout';
        if (code === 'provider.unreachable' || code === 'provider.stream_broken'
            || /fetch failed|econn|etimedout|eai_again|socket|connection|network|unreachable/.test(text)) return 'network';
        return 'server';
    }
    if (cls === 'request') {
        if (/context (length|window)|too long|maximum context|token limit/.test(text)) return 'context_length';
        if (/refus|floor_refused|policy/.test(text)) return 'refused';
        return 'invalid';
    }
    if (/rate[ _-]?limit/.test(text)) return 'rate_limited';
    if (/timeout|timed out/.test(text)) return 'timeout';
    if (/context (length|window)|too long|maximum context/.test(text)) return 'context_length';
    if (/refus|floor_refused/.test(text)) return 'refused';
    if (/unauthorized|forbidden|permission|auth/.test(text) || status === 401 || status === 403) return 'auth';
    if (/network|unreachable|fetch failed|econn/.test(text)) return 'network';
    if (/invalid|bad request|schema|400|422/.test(text) || (status != null && status >= 400 && status < 500)) return 'invalid';
    if (/server|unavailable|resting/.test(text) || (status != null && status >= 500)) return 'server';
    return null;
}

/**
 * Output tokens per second after the first delta: the decode speed the Exchange's Measured panels show.
 * Null when the call did not stream, or when there are too few tokens (under 8) or too little time
 * (under 200 ms) for the number to mean anything.
 */
function tpsOf({ output = 0, streamed = false, firstDeltaAt = null, finishedAt = null } = {}) {
    if (!streamed || firstDeltaAt == null || finishedAt == null) return null;
    const tokens = Number(output) || 0;
    const start = Number(firstDeltaAt);
    const end = typeof finishedAt === 'number' ? finishedAt : Date.parse(finishedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const ms = end - start;
    if (tokens < 8 || !(ms >= 200)) return null;
    return Math.round((tokens / (ms / 1000)) * 100) / 100;
}

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
    attempts = 1, outcome = 'succeeded', at = new Date(),
    operation = null, streamed = null, tps = null, queue_ms: queueMs = null, task = null, task_id: taskId = null,
    task_ms: taskMs = null, harness = null, place = null, error_class: errorClass = null, fallbacks = null,
    cache_hit: cacheHit = null, tool_calls: toolCalls = null, region = null }) {
    if (!PAID_BY.includes(paidBy)) throw new Error(`paid_by must be one of ${PAID_BY.join(', ')}`);
    const bounded = (v, max) => (v == null ? null : String(v).slice(0, max));
    const int = (v) => (v == null ? null : Math.max(0, Math.round(Number(v) || 0)));
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
        operation: operation && OPERATIONS.includes(String(operation)) ? String(operation) : null,
        streamed: streamed == null ? null : Boolean(streamed),
        tps: tps == null || !Number.isFinite(Number(tps)) ? null : Math.round(Math.max(0, Number(tps)) * 100) / 100,
        queue_ms: int(queueMs),
        task: bounded(task, 120),
        task_id: bounded(taskId, 120),
        task_ms: int(taskMs),
        harness: bounded(harness, 60),
        place: place && PLACES.includes(String(place)) ? String(place) : null,
        error_class: bounded(errorClass, 60),
        fallbacks: fallbacks == null ? null : Math.min(50, int(fallbacks)),
        cache_hit: cacheHit == null ? null : Boolean(cacheHit),
        tool_calls: int(toolCalls),
        region: bounded(region, 40),
    };
}

module.exports = { PAID_BY, OPERATIONS, PLACES, money, pricesOf, moneyOf, operationOf, errorClassOf, tpsOf, recordOf, iso };
