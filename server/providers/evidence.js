'use strict';
/**
 * AI Exchange P7: expected cost per successful alias request, from measured evidence (PLAN §D, §E).
 *
 * This is AI's router using the ONE planner, openvibe-sdk/placement planAi(): planAi keeps the hard gates, the
 * expected-cost-per-success arithmetic in integer nano-USD (D1), the sparse-evidence marking and its hysteresis
 * margin. This module only prepares the planner's AI Exchange inputs from what AI has measured, adds the
 * N-consecutive-decision rule, the cache affinity and the small exploration share, and explains the answer.
 *
 *   economy  the lowest expected cost per success, where
 *            price_after_cache = input*(1-hit)*retail_in + input*hit*retail_cached + output*retail_out (+ fee)
 *            expected cost per success = price_after_cache / max(success_rate, floor)
 *   fast     the lowest p50 TTFT, then the highest decode tokens/s (planAi's latency objective, priced flat so
 *            the measured latency is what decides)
 *   balanced the normalised cost per success and normalised TTFT weighed together
 *   private  never reaches here: the route already excludes every non-local offer
 *
 * Nothing here is a second planner: the order planAi produces is the order the router tries, with the
 * incumbent kept for N decisions and a warm prompt-prefix cache as a tie-break. The explanation carries only
 * ids, counts, nano-USD and rates — never a prompt, an endpoint, a key or a host.
 */
const placement = require('openvibe-sdk/placement');
const { nanoUsd, chargeTokens, costPerSuccessNano, formatNanoUsd } = require('openvibe-sdk/cost');
const { tokensOf, leadingText } = require('./task');
const { offerKey } = require('./metrics');

const POLICIES = { cheapest: 'economy', fastest: 'fast', balanced: 'balanced', auto: 'auto', private: 'private', exact: 'exact' };
const OBJECTIVE = { cheapest: 'cheapest', fastest: 'fastest', balanced: 'balanced', auto: 'balanced' };
const MIN_PROMPT_TOKENS = 1;
const PPM = 1000000n;

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const nanoFromUsd = (usd) => {
    const n = Number(usd);
    if (!Number.isFinite(n) || n < 0) return null;
    return String(Math.round(n * 1e9));
};

/** Integer nano-USD per million rates from the retail card, else from the route's rate cards (free: zeros). */
function nanoRatesOf({ free = false, retail = null, cards = null } = {}) {
    const zero = { input_nano_usd_per_m: '0', cached_read_nano_usd_per_m: '0', cache_write_nano_usd_per_m: '0', output_nano_usd_per_m: '0', per_request_nano_usd: '0' };
    if (free) return zero;
    if (retail && retail.input_nano_usd_per_m != null && retail.output_nano_usd_per_m != null) {
        const cardCached = cards && cards.cached ? nanoFromUsd(cards.cached.unit_price_usd) : null;
        return {
            input_nano_usd_per_m: String(retail.input_nano_usd_per_m),
            cached_read_nano_usd_per_m: retail.cached_read_nano_usd_per_m != null ? String(retail.cached_read_nano_usd_per_m) : (cardCached != null ? cardCached : String(retail.input_nano_usd_per_m)),
            cache_write_nano_usd_per_m: retail.cache_write_nano_usd_per_m != null ? String(retail.cache_write_nano_usd_per_m) : '0',
            output_nano_usd_per_m: String(retail.output_nano_usd_per_m),
            per_request_nano_usd: retail.per_request_nano_usd != null ? String(retail.per_request_nano_usd) : '0',
        };
    }
    if (!cards) return null;
    const input = nanoFromUsd(cards.in && cards.in.unit_price_usd);
    const cached = nanoFromUsd(cards.cached && cards.cached.unit_price_usd);
    const put = nanoFromUsd(cards.cache_write && cards.cache_write.unit_price_usd);
    const output = nanoFromUsd(cards.out && cards.out.unit_price_usd);
    if (input == null || cached == null || output == null) return null;
    return {
        input_nano_usd_per_m: input, cached_read_nano_usd_per_m: cached, cache_write_nano_usd_per_m: put || '0',
        output_nano_usd_per_m: output, per_request_nano_usd: '0',
    };
}

/**
 * The retail card's input and cached_read rates weighted by the measured cache-hit ratio, plus output at the
 * expected output length, in integer nano-USD. All BigInt; each component is rounded up once (D1).
 */
function priceAfterCacheNano({ promptTokens = 0, outputTokens = 0, cacheHitRatio = 0, rates } = {}) {
    const input = BigInt(Math.max(0, Math.floor(Number(promptTokens) || 0)));
    const output = BigInt(Math.max(0, Math.floor(Number(outputTokens) || 0)));
    const ppm = BigInt(Math.max(0, Math.min(1000000, Math.round(clamp01(cacheHitRatio) * 1000000))));
    const cached = (input * ppm) / PPM;
    const uncached = input - cached;
    return chargeTokens(uncached, rates.input_nano_usd_per_m)
        + chargeTokens(cached, rates.cached_read_nano_usd_per_m)
        + chargeTokens(output, rates.output_nano_usd_per_m)
        + nanoUsd(rates.per_request_nano_usd);
}

/**
 * One integer input rate that prices the whole prompt at the same total as the two-part price. planAi's cost
 * function takes one usage and one rate card per candidate, so the measured cache ratio is carried in the
 * blended rate; this picks the integer rate whose ceiling charge equals the exact two-part charge when one
 * exists (otherwise the rounded-up nearest, never a cheaper rate).
 */
function blendedInputRateNano({ promptTokens = 0, cacheHitRatio = 0, rates } = {}) {
    const input = BigInt(Math.max(0, Math.floor(Number(promptTokens) || 0)));
    if (!input) return '0';
    const ppm = BigInt(Math.max(0, Math.min(1000000, Math.round(clamp01(cacheHitRatio) * 1000000))));
    const cached = (input * ppm) / PPM;
    const uncached = input - cached;
    const desired = chargeTokens(uncached, rates.input_nano_usd_per_m) + chargeTokens(cached, rates.cached_read_nano_usd_per_m);
    if (!desired) return '0';
    const base = (desired * PPM) / input;
    for (const candidate of [base - 1n, base, base + 1n, base + 2n].filter((x) => x >= 0n)) {
        if (chargeTokens(input, candidate) === desired) return candidate.toString();
    }
    return ((desired * PPM + input - 1n) / input).toString();
}

/** The measured p_success and its count: Bench is used only when it is not sparse and has a success rate. */
function combineEvidence({ metric = null, bench = null, minSamples = 20, prior = 0.9 } = {}) {
    const floor = Math.max(1, Number(minSamples) || 20);
    const sources = [];
    if (metric && metric.sample_count >= floor && Number.isFinite(metric.success_rate)) {
        sources.push({ p: clamp01(metric.success_rate), n: metric.sample_count, source: 'ewma' });
    }
    if (bench && bench.status === 'ok' && bench.samples >= floor && bench.success_rate != null) {
        sources.push({ p: clamp01(bench.success_rate), n: bench.samples, source: 'bench' });
    }
    const total = sources.reduce((n, s) => n + s.n, 0);
    const p = total ? sources.reduce((sum, s) => sum + s.p * s.n, 0) / total : null;
    const raw = metric && metric.sample_count > 0 ? { p_success: clamp01(metric.success_rate), confidence: 1, samples: metric.sample_count, source: 'ewma' } : null;
    return {
        // planAi rejects p <= 0 as 'no chance'; the brief prices it at the success floor instead, so a measured
        // zero stays an eligible (very expensive) last resort and the floor decides its cost per success.
        evidence: sources.length ? { p_success: Math.max(1e-9, p), confidence: 1, samples: total, source: sources.map((s) => s.source).join('+') } : raw,
        p_success: sources.length ? Math.max(1e-9, p) : null,
        samples: total || (metric ? metric.sample_count : 0),
        sparse: !sources.length,
        source: sources.length ? sources.map((s) => s.source).join('+') : (raw ? 'ewma' : 'prior'),
        bench,
        metric,
        minSamples: floor,
        prior,
    };
}

/** The measured TTFT: Bench's p50 when it is usable, else the EWMA of the first-token time. */
function measuredTtft({ metric = null, bench = null, minSamples = 20 } = {}) {
    const floor = Math.max(1, Number(minSamples) || 20);
    if (bench && bench.status === 'ok' && bench.samples >= floor && bench.ttft_p50_ms != null) {
        return { ms: Number(bench.ttft_p50_ms), source: 'bench_p50', samples: bench.samples };
    }
    if (metric && metric.ttft_samples >= floor && metric.ttft_ms != null) {
        return { ms: Number(metric.ttft_ms), source: 'ewma', samples: metric.ttft_samples };
    }
    return { ms: null, source: metric && metric.ttft_samples > 0 ? 'sparse' : 'absent', samples: metric ? metric.ttft_samples : 0 };
}

/** The measured decode throughput: Bench first, else the EWMA of output tokens per decode second. */
function measuredDecode({ metric = null, bench = null, minSamples = 20 } = {}) {
    const floor = Math.max(1, Number(minSamples) || 20);
    if (bench && bench.status === 'ok' && bench.samples >= floor && bench.decode_tokens_per_s != null) {
        return { tps: Number(bench.decode_tokens_per_s), source: 'bench', samples: bench.samples };
    }
    if (metric && metric.decode_samples >= floor && metric.decode_tps != null) {
        return { tps: Number(metric.decode_tps), source: 'ewma', samples: metric.decode_samples };
    }
    return { tps: null, source: metric && metric.decode_samples > 0 ? 'sparse' : 'absent', samples: metric ? metric.decode_samples : 0 };
}

/** A measured cache-hit ratio, or zero (the conservative, uncached price) when it is not measured enough. */
function measuredCache({ metric = null, minSamples = 20 } = {}) {
    const floor = Math.max(1, Number(minSamples) || 20);
    if (metric && metric.cache_samples >= floor) return { ratio: clamp01(metric.cache_hit_ratio), source: 'ewma', samples: metric.cache_samples };
    return { ratio: 0, source: metric && metric.cache_samples > 0 ? 'sparse' : 'absent', samples: metric ? metric.cache_samples : 0 };
}

function labelFor(policy) { return POLICIES[policy] || policy || 'router'; }

function reasonFor({ policy, chosen = null, samples = 0, sparse = true }) {
    const n = Math.max(0, Number(samples) || 0);
    const label = labelFor(policy);
    if (!chosen) return `${label}: no eligible candidate`;
    if (policy === 'cheapest') return sparse ? `${label}: lowest measured price, no measured success yet (n=${n})` : `${label}: lowest cost per success (n=${n})`;
    if (policy === 'fastest') return sparse ? `${label}: lowest measured TTFT, no measured success yet (n=${n})` : `${label}: lowest measured TTFT (n=${n})`;
    return sparse ? `${label}: cost and latency, no measured successful rate yet (n=${n})` : `${label}: cost and latency weighed (n=${n})`;
}

/** The incumbent and the challenger's consecutive-decision streak, persisted (migrations/0026). */
function createIncumbents({ db, clock = { now: () => Date.now() }, decisions = 3 } = {}) {
    const decisionsNow = () => Math.max(1, Number(typeof decisions === 'function' ? decisions() : decisions) || 3);
    const select = db.prepare('SELECT * FROM routing_incumbents WHERE decision_key = ?');
    const upsert = db.prepare(`INSERT INTO routing_incumbents
            (decision_key, provider_key, model_key, challenger_provider, challenger_model, challenger_streak, updated_at)
        VALUES (@decision_key, @provider_key, @model_key, @challenger_provider, @challenger_model, @challenger_streak, @updated_at)
        ON CONFLICT(decision_key) DO UPDATE SET
            provider_key = excluded.provider_key, model_key = excluded.model_key,
            challenger_provider = excluded.challenger_provider, challenger_model = excluded.challenger_model,
            challenger_streak = excluded.challenger_streak, updated_at = excluded.updated_at`);
    const idOf = (p, m) => offerKey(p, m);
    const split = (id) => {
        const i = String(id || '').indexOf(':');
        return i < 0 ? { provider: String(id || ''), model: '' } : { provider: String(id).slice(0, i), model: String(id).slice(i + 1) };
    };
    const stamp = () => new Date(clock.now()).toISOString();

    /**
     * planAi chose `chosen` under the configured minGain. The incumbent is replaced only after `decisions`
     * consecutive choices of the same challenger; a challenger that goes away resets the streak.
     */
    async function apply(key, chosenId, inPool) {
        const row = await select.get(String(key));
        if (!row || !row.provider_key) {
            const chosen = split(chosenId);
            await upsert.run({ decision_key: String(key), provider_key: chosen.provider, model_key: chosen.model,
                challenger_provider: null, challenger_model: null, challenger_streak: 0, updated_at: stamp() });
            return { incumbent: chosenId, chosen: chosenId, switched: true, initial: true, streak: 0, decisions: decisionsNow() };
        }
        const incumbentId = idOf(row.provider_key, row.model_key || '');
        if (!inPool.has(incumbentId)) {
            const chosen = split(chosenId);
            await upsert.run({ decision_key: String(key), provider_key: chosen.provider, model_key: chosen.model,
                challenger_provider: null, challenger_model: null, challenger_streak: 0, updated_at: stamp() });
            return { incumbent: chosenId, chosen: chosenId, switched: true, initial: false, failover: true, streak: 0, decisions: decisionsNow() };
        }
        if (chosenId === incumbentId) {
            await upsert.run({ decision_key: String(key), ...row, provider_key: row.provider_key, model_key: row.model_key,
                challenger_provider: null, challenger_model: null, challenger_streak: 0, updated_at: stamp() });
            return { incumbent: incumbentId, chosen: chosenId, switched: false, initial: false, streak: 0, decisions: decisionsNow() };
        }
        const same = row.challenger_provider === split(chosenId).provider && (row.challenger_model || '') === split(chosenId).model;
        const streak = same ? Number(row.challenger_streak || 0) + 1 : 1;
        if (streak >= decisionsNow()) {
            const chosen = split(chosenId);
            await upsert.run({ decision_key: String(key), provider_key: chosen.provider, model_key: chosen.model,
                challenger_provider: null, challenger_model: null, challenger_streak: 0, updated_at: stamp() });
            return { incumbent: chosenId, chosen: chosenId, switched: true, initial: false, streak: 0, decisions: decisionsNow() };
        }
        const challenger = split(chosenId);
        await upsert.run({ decision_key: String(key), provider_key: row.provider_key, model_key: row.model_key,
            challenger_provider: challenger.provider, challenger_model: challenger.model, challenger_streak: streak, updated_at: stamp() });
        return { incumbent: incumbentId, chosen: incumbentId, switched: false, initial: false, streak, decisions: decisionsNow() };
    }

    async function get(key) {
        const row = await select.get(String(key));
        if (!row || !row.provider_key) return null;
        return { provider: row.provider_key, model: row.model_key || '', id: idOf(row.provider_key, row.model_key || ''), streak: Number(row.challenger_streak) || 0 };
    }

    return { apply, get, decisions: decisionsNow };
}

function createRoutingEvidence({ db, config = {}, clock = { now: () => Date.now() }, metrics, bench = null, resolveOffer, random = Math.random, log = console } = {}) {
    // D11 owner settings: the feature flag and its parameters are read live, so an ai.exchange change applies from
    // the next decision (the pool gates record/choose on enabled()).
    let minSamples, alpha, floor, prior, affinityGain, minGain, decisions, share, expectedOutput;
    function refreshCfg() {
        const cfg = config.routingEvidence || config || {};
        minSamples = Math.max(1, Number(cfg.minSamples) || 20);
        alpha = cfg.alpha;
        floor = Math.max(0.01, Math.min(1, Number(cfg.successFloor) || 0.1));
        prior = Math.max(0.01, Math.min(1, Number(cfg.prior) || 0.9));
        affinityGain = Math.max(0, Math.min(1, Number(cfg.affinityGain) || 0.05));
        minGain = Math.max(0, Math.min(1, cfg.minGain != null ? Number(cfg.minGain) : Number(config.placement && config.placement.minGain) || 0.15));
        decisions = Math.max(1, Number(cfg.hysteresisDecisions) || 3);
        share = Math.max(0, Math.min(1, Number(cfg.explorationShare) || 0));
        expectedOutput = Math.max(1, Number(cfg.expectedOutputTokens) || 512);
    }
    refreshCfg();
    const incumbents = createIncumbents({ db, clock, decisions: () => decisions });
    const store = metrics || require('./metrics').createProviderMetrics({ db, clock, alpha: () => alpha });

    async function record(attempt) { refreshCfg(); return await store.record(attempt); }

    function promptTokensOf(req) {
        const tokens = tokensOf(leadingText(req || {}));
        return Math.max(MIN_PROMPT_TOKENS, tokens);
    }

    function outputTokensOf(req) {
        const wanted = Number(req && req.maxTokens);
        return Math.max(1, Math.floor(Number.isFinite(wanted) && wanted > 0 ? wanted : expectedOutput));
    }

    function optOut(ctx = {}, prefs = {}) {
        return Boolean(ctx.exact || ctx.credential || ctx.routePin || ctx.exploration === false
            || (prefs && (prefs.only_my_keys === true || prefs.exploration === false))
            || (Array.isArray(ctx.selfCredentials) && ctx.selfCredentials.length));
    }

    /**
     * Prepare one candidate's planner inputs from the retail card, the measured row and Bench's exact-id
     * evidence. `resolveOffer` is the pool's own catalogue lookup, so no second catalogue is read here.
     */
    async function prepare(candidate, { promptTokens, outputTokens, metricsById = null }) {
        refreshCfg();
        const offer = await resolveOffer(candidate);
        if (!offer) return null;
        const metric = (metricsById ? metricsById.get(offer.id) : (await store.all()).get(offer.id)) || null;
        const benchRow = offer.exactId && bench ? await bench.get(offer.exactId) : { status: 'absent', samples: 0, exact_id: offer.exactId || null };
        const evidence = combineEvidence({ metric, bench: benchRow, minSamples, prior });
        const ttft = measuredTtft({ metric, bench: benchRow, minSamples });
        const decode = measuredDecode({ metric, bench: benchRow, minSamples });
        const cache = measuredCache({ metric, minSamples });
        const rates = nanoRatesOf({ free: offer.free, retail: offer.retail, cards: offer.cards });
        if (!rates) return { ...offer, metric, bench: benchRow, evidence, ttft, decode, cache, rates: null, priceNano: null, costPerSuccess: null };
        const priceNano = priceAfterCacheNano({ promptTokens, outputTokens, cacheHitRatio: cache.ratio, rates });
        const blended = blendedInputRateNano({ promptTokens, cacheHitRatio: cache.ratio, rates });
        const plannerRate = { ...rates, input_nano_usd_per_m: blended, cached_read_nano_usd_per_m: '0' };
        return { ...offer, metric, bench: benchRow, evidence, ttft, decode, cache, rates, plannerRate, priceNano, costPerSuccess: null };
    }

    function policyOrder(policy, prepared, weights, warmId = null, affinityGain = 0.05) {
        const key = (p) => (p.costPerSuccess == null ? Infinity : Number(p.costPerSuccess));
        const maxCost = Math.max(0, ...prepared.map(key).filter(Number.isFinite));
        const maxTtft = Math.max(0, ...prepared.map((p) => (p.ttft.ms == null ? 0 : p.ttft.ms)));
        const tps = (p) => (p.decode.tps == null ? -1 : p.decode.tps);
        const costScore = (p) => (maxCost ? key(p) / maxCost : 0);
        const ttftScore = (p) => (p.ttft.ms == null ? 1 : p.ttft.ms / (maxTtft || 1));
        for (const p of prepared) {
            p.score = policy === 'cheapest' ? key(p)
                : policy === 'fastest' ? (p.ttft.ms == null ? Infinity : p.ttft.ms)
                    : costScore(p) * weights.cost + ttftScore(p) * weights.latency;
        }
        const sorted = [...prepared].sort((a, b) => {
            if (policy === 'cheapest') {
                if (key(a) !== key(b)) return key(a) - key(b);
            } else if (policy === 'fastest') {
                const ta = a.ttft.ms == null ? Infinity : a.ttft.ms;
                const tb = b.ttft.ms == null ? Infinity : b.ttft.ms;
                if (ta !== tb) return ta - tb;
                if (tps(a) !== tps(b)) return tps(b) - tps(a);
            } else {
                if (a.score !== b.score) return a.score - b.score;
                if (tps(a) !== tps(b)) return tps(b) - tps(a);
            }
            if (key(a) !== key(b)) return key(a) - key(b);
            return String(a.id).localeCompare(String(b.id));
        });
        // Cache affinity (L36 Y7): the deployment that served the same prompt prefix last stays first while it
        // is within the configured margin of the policy's best. It is a preference, not a gate.
        const warm = warmId ? sorted.find((p) => p.id === warmId) : null;
        if (warm && sorted[0] !== warm) {
            const best = sorted[0].score;
            const gap = warm.score - best;
            const within = policy === 'fastest'
                ? Number.isFinite(best) && gap <= best * affinityGain
                : Number.isFinite(best) && best >= 0 && gap <= Math.max(best * affinityGain, affinityGain * 1e-9);
            if (within) return { sorted: [warm, ...sorted.filter((p) => p !== warm)], affinity: true };
        }
        return { sorted, affinity: false };
    }

    /**
     * The router's evidence decision for one alias request. Returns the full order and the explain view.
     * `list` is the router's already-eligible order; `ctx.exact` is never passed here.
     */
    async function choose({ routeKey = null, policy, list = [], req = {}, ctx = {}, warmDeployment = null, preferred = null } = {}) {
        refreshCfg();
        const preparedRaw = [];
        const promptTokens = promptTokensOf(req);
        const outputTokens = outputTokensOf(req);
        const metricsById = await store.all();
        for (const c of list) {
            if (!c || c.provider === 'stub') continue;
            const prepared = await prepare(c, { promptTokens, outputTokens, metricsById });
            if (prepared) preparedRaw.push(prepared);
        }
        const prepared = preparedRaw.filter((p) => p.plannerRate && p.priceNano != null);
        const plannedIds = new Set(prepared.map((p) => p.id));
        const unplanned = list.filter((c) => c && (c.provider === 'stub' || !plannedIds.has(offerKey(c.provider, c.model || ''))))
            .map((c) => ({ provider: c.provider, model: c.model || null }));
        for (const p of prepared) {
            const eff = p.evidence.samples >= minSamples && p.evidence.p_success != null ? p.evidence.p_success : prior;
            p.pSuccess = eff;
            p.costPerSuccess = costPerSuccessNano(p.priceNano, eff, floor);
        }
        if (!prepared.length) {
            return {
                order: list,
                view: {
                    policy, objective: OBJECTIVE[policy] || 'balanced', reason: `${labelFor(policy)}: no candidate has a retail rate`,
                    chosen: null, incumbent: null, switched: false, streak: 0, decisions,
                    prompt_tokens: promptTokens, output_tokens: outputTokens, cache_hit_ratio: 0, cache_evidence: 'absent',
                    bench: { status: 'absent', samples: 0, minimum: minSamples },
                    exploration: { share, used: false }, candidates: [],
                },
            };
        }
        const weights = { cost: Number(config.placement && config.placement.costWeight) || 0.5, latency: Number(config.placement && config.placement.latencyWeight) || 0.5 };
        const warmId = warmDeployment && warmDeployment.provider ? offerKey(warmDeployment.provider, warmDeployment.model || '') : null;
        const ordered = policyOrder(policy, prepared, weights, warmId, affinityGain);
        const sorted = ordered.sorted;
        const decisionKey = `${String(routeKey || (ctx && ctx.routeKey) || 'alias')}|${policy}`;
        const inPool = new Set(prepared.map((p) => p.id));
        const incumbentRow = await incumbents.get(decisionKey);
        const incumbentId = incumbentRow && inPool.has(incumbentRow.id) ? incumbentRow.id : null;

        // planAi is the one planner: hard gates already passed, its job here is the measured cost per success,
        // the sparse marking and the hysteresis margin. Cache affinity is a tie-break applied to the order.
        const objective = OBJECTIVE[policy] || 'balanced';
        const zero = { input_nano_usd_per_m: '0', cached_read_nano_usd_per_m: '0', cache_write_nano_usd_per_m: '0', output_nano_usd_per_m: '0', per_request_nano_usd: '0' };
        const plannerRates = {};
        const candidates = prepared.map((p) => {
            plannerRates[p.id] = policy === 'fastest' ? zero : p.plannerRate;
            // Fast is a strict p50 TTFT order: encode the decode-tiebreak as a sub-millisecond part so planAi's
            // latency comparison keeps TTFT primary and decode tokens/s second.
            const latency = p.ttft.ms == null ? null : (policy === 'fastest' && p.decode.tps != null ? p.ttft.ms + (1 / p.decode.tps) * 1e-6 : p.ttft.ms);
            return {
                id: p.id, deployment_id: p.id, model_id: p.exactId || p.id,
                model: { id: p.exactId || p.id }, provider_access: p.access || null, paid_managed: false,
                status: 'ready', latency_ms: latency, retail_rate: plannerRates[p.id],
            };
        });
        const evidenceMap = {};
        for (const p of prepared) if (p.evidence.evidence) evidenceMap[p.id] = p.evidence.evidence;
        const planned = prepared.length ? placement.planAi(
            { objective, capabilities: [], paid_managed: false },
            candidates,
            { enabled: true, now: clock.now(), current: incumbentId, minGain, usage: { input_tokens: promptTokens, output_tokens: outputTokens },
                evidence: evidenceMap, rates: plannerRates, pFloor: floor, prior, sparseSampleFloor: minSamples },
        ) : { chosen: null, explain: { candidates: [] } };
        let chosenId = planned.chosen || (sorted[0] && sorted[0].id) || null;
        const decision = await incumbents.apply(decisionKey, chosenId, inPool);
        const keeperId = decision.incumbent || chosenId;
        const chosen = prepared.find((p) => p.id === keeperId) || sorted[0] || null;

        // Order: the incumbent first (hysteresis), then the policy order. Exploration may put one non-incumbent
        // first for exactly one request; it never changes the incumbent or the streak.
        // Cache affinity can put the warm deployment first even when the incumbent is kept for hysteresis;
        // it stays within the margin. Otherwise the incumbent comes first.
        const warmFirst = ordered.affinity ? sorted[0] : null;
        let order = sorted.map((p) => p.id);
        if (warmFirst) order = [warmFirst.id, ...order.filter((id) => id !== warmFirst.id)];
        else if (chosen) order = [chosen.id, ...order.filter((id) => id !== chosen.id)];
        let exploration = null;
        if (share > 0 && !optOut(ctx, ctx.selfPreferences) && sorted.length > 1 && random() < share) {
            const pick = sorted.find((p) => p.id !== keeperId);
            if (pick) {
                exploration = { share, provider: pick.provider, model: pick.model };
                order = [pick.id, ...order.filter((id) => id !== pick.id)];
            }
        }
        // L37: a soft preference still leads, as it does in the existing router; evidence ranks the rest.
        const preferredOffer = preferred
            ? prepared.find((p) => (!preferred.provider || p.provider === preferred.provider) && (!preferred.model || p.model === preferred.model))
            : null;
        if (preferredOffer) {
            order = [preferredOffer.id, ...order.filter((id) => id !== preferredOffer.id)];
            exploration = null;
        }
        const orderAsCandidates = order.map((id) => prepared.find((p) => p.id === id)).filter(Boolean).map((p) => ({ provider: p.provider, model: p.model }));
        const first = orderAsCandidates[0] || null;
        const candidatesView = sorted.map((p) => {
            const plannerCand = planned.explain && (planned.explain.candidates || []).find((c) => c.id === p.id);
            return {
                provider: p.provider, model: p.model,
                expected_cost_nano_usd: formatNanoUsd(p.priceNano),
                price_after_cache_nano_usd: formatNanoUsd(p.priceNano),
                cost_per_success_nano_usd: p.costPerSuccess == null ? null : formatNanoUsd(p.costPerSuccess),
                p_success: Number((plannerCand ? plannerCand.p_success : p.pSuccess).toFixed(6)),
                samples: p.evidence.samples,
                sparse_evidence: plannerCand ? Boolean(plannerCand.sparse_evidence) : p.evidence.sparse,
                evidence_source: plannerCand ? plannerCand.evidence_source : p.evidence.source,
                cache_hit_ratio: p.cache.ratio,
                cache_evidence: p.cache.source,
                cache_samples: p.metric ? p.metric.cache_samples : 0,
                timeout_rate: p.metric ? p.metric.timeout_rate : (p.bench && p.bench.timeout_rate != null ? p.bench.timeout_rate : null),
                metric_samples: p.metric ? p.metric.sample_count : 0,
                ttft_ms: p.ttft.ms,
                ttft_p50_ms: p.ttft.source === 'bench_p50' ? p.ttft.ms : null,
                ttft_source: p.ttft.source,
                measured_success_rate: p.metric ? p.metric.success_rate : (p.bench && p.bench.success_rate != null ? p.bench.success_rate : null),
                decode_tokens_per_s: p.decode.tps,
                decode_source: p.decode.source,
                bench: { status: p.bench.status, samples: p.bench.samples || 0, minimum: minSamples },
                selected: first ? p.id === offerKey(first.provider, first.model || '') : false,
            };
        });
        const actual = first ? prepared.find((p) => p.id === offerKey(first.provider, first.model || '')) : chosen;
        const chosenBench = actual ? actual.bench : { status: 'absent', samples: 0 };
        const reason = reasonFor({ policy, chosen, samples: chosen ? chosen.evidence.samples : 0, sparse: chosen ? chosen.evidence.sparse : true });
        const view = {
            policy, objective,
            reason: warmFirst ? `${reason}; cache affinity` : (exploration ? `${reason}; exploring one alternative` : reason),
            affinity: warmFirst && !preferredOffer ? { provider: warmFirst.provider, model: warmFirst.model, within_margin: true } : null,
            chosen: first ? offerKey(first.provider, first.model || '') : (chosen ? chosen.id : null), incumbent: decision.incumbent, switched: decision.switched,
            streak: decision.streak, decisions: decision.decisions,
            prompt_tokens: promptTokens, output_tokens: outputTokens,
            cache_hit_ratio: actual ? actual.cache.ratio : 0, cache_evidence: actual ? actual.cache.source : 'absent',
            bench: { status: chosenBench.status || 'absent', samples: chosenBench.samples || 0, minimum: minSamples },
            exploration: exploration ? { ...exploration, used: true } : { share, used: false },
            preferred: preferredOffer ? { provider: preferredOffer.provider, model: preferredOffer.model } : null,
            candidates: candidatesView,
        };
        return { order: [...orderAsCandidates, ...unplanned], view };
    }

    return { record, choose, prepare, incumbents, store, enabled: () => Boolean(config.routingEvidence && config.routingEvidence.enabled), minSamples, alpha, floor, prior, share, decisions };
}

module.exports = {
    createRoutingEvidence, createIncumbents, nanoRatesOf, priceAfterCacheNano, blendedInputRateNano,
    combineEvidence, measuredTtft, measuredDecode, measuredCache, reasonFor,
    POLICIES, OBJECTIVE, MIN_PROMPT_TOKENS,
};
