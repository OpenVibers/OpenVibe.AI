'use strict';
/**
 * Provider pool and router.
 *
 *   pool.adapter(key)          the adapter for a provider record (rebuilt when the record changes)
 *   pool.health(key)           circuit-breaker state
 *   pool.execute(route, op, req, ctx)
 *        tries the route's candidates in order, skipping ones that are disabled, circuit-open,
 *        missing credentials or that do not support the operation; applies a strict timeout and
 *        cancellation to every call and one retry on a transient failure; records one request-log
 *        row per attempt or skip (fallback = 1 for every non-first candidate) and returns
 *        { result, provider, model, fallbackUsed, explain }. When nothing answers it throws
 *        AiError 503 provider.unavailable — an explicit state, never a made-up answer.
 *
 * A route either names a `capability` and the pool is built from every provider that can serve it,
 * ordered by openvibe-sdk/placement (objective, price, measured latency, health, with hysteresis
 * through placement_state.current); or it pins `[primary, ...fallbacks]`. `explain` (objective,
 * reasons, selected, candidates with their excluded reasons) rides every run response.
 *
 * Circuit breaker per provider: `failureThreshold` consecutive failures open it for `cooldownMs`;
 * after that one half-open probe decides whether it closes again.
 */
const placement = require('openvibe-sdk/placement');
const { AiError, resolveSecret, sha256 } = require('../util');
const { retryable, sleep, ProviderError } = require('./common');
const { createStubProvider } = require('./stub');
const { createOpenAiProvider } = require('./openai');
const { createAnthropicProvider } = require('./anthropic');
const { createHttpSeamProvider } = require('./http');
const { createWhisperProvider } = require('./whisper');
const rates = require('./rate-cards');

/** 4xx that the request itself caused (bad image, schema, max_tokens...), as opposed to auth, rate or availability. */
function callerFault(err) {
    const st = err && err.status;
    return Number.isInteger(st) && st >= 400 && st < 500 && ![401, 403, 404, 408, 429].includes(st);
}

/** An upstream 429 is rate-limit capacity, not provider ill health: it shifts to the next candidate but must not open the circuit. */
function rateLimited(err) {
    return (err && err.status === 429) || (err && err.code === 'provider.rate_limited');
}

function createProviderPool({ db, registry, config, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, env = process.env, log = console, credentialFetch = null }) {
    const cache = new Map();          // key -> { stamp, adapter }
    const stats = {};                 // key -> { calls, failures, ... } (in memory; tests + /api/ready)

    function statFor(key) { return stats[key] || (stats[key] = { calls: 0, ok: 0, failures: 0, skipped: 0 }); }

    function build(p) {
        const apiKey = resolveSecret(p.secret_ref, env);
        switch (p.kind) {
            case 'stub': return createStubProvider(p, { stats: statFor(p.key) });
            case 'openai': return createOpenAiProvider(p, { apiKey, fetchImpl });
            case 'anthropic': return createAnthropicProvider(p, { apiKey, fetchImpl });
            case 'http': return createHttpSeamProvider(p, { apiKey, fetchImpl });
            case 'whisper': return createWhisperProvider(p, { config });
            default: throw new Error(`unknown provider kind ${p.kind}`);
        }
    }

    async function adapter(key) {
        const p = await registry.getProvider(key);
        if (!p) return null;
        const stamp = `${p.updated_at}|${p.secret_ref}|${resolveSecret(p.secret_ref, env) ? 1 : 0}`;
        const hit = await cache.get(key);
        if (hit && hit.stamp === stamp) return { record: p, adapter: hit.adapter };
        const a = build(p);
        cache.set(key, { stamp, adapter: a });
        return { record: p, adapter: a };
    }

    // ── Circuit breaker ────────────────────────────────────
    const getHealth = db.prepare('SELECT * FROM provider_health WHERE provider_key = ?');
    const putHealth = db.prepare(`INSERT INTO provider_health (provider_key, state, consecutive_failures, opened_at, last_error, last_success_at, last_failure_at)
        VALUES (@provider_key, @state, @consecutive_failures, @opened_at, @last_error, @last_success_at, @last_failure_at)
        ON CONFLICT(provider_key) DO UPDATE SET state = excluded.state, consecutive_failures = excluded.consecutive_failures, opened_at = excluded.opened_at,
          last_error = excluded.last_error, last_success_at = excluded.last_success_at, last_failure_at = excluded.last_failure_at`);
    async function health(key) {
        const h = await getHealth.get(key) || { provider_key: key, state: 'closed', consecutive_failures: 0, opened_at: null, last_error: null, last_success_at: null, last_failure_at: null };
        if (h.state === 'open' && clock.now() - (h.opened_at || 0) >= config.breaker.cooldownMs) return { ...h, state: 'half_open' };
        return h;
    }
    async function recordSuccess(key) {
        const h = await health(key);
        if (h.state !== 'closed') await registry.audit('system', 'provider.circuit_closed', 'provider', key, { metadata: { after_failures: h.consecutive_failures } });
        await putHealth.run({ ...h, provider_key: key, state: 'closed', consecutive_failures: 0, opened_at: null, last_success_at: clock.now() });
    }
    async function recordFailure(key, err) {
        const h = await health(key);
        const failures = (h.consecutive_failures || 0) + 1;
        const open = h.state === 'half_open' || failures >= config.breaker.failureThreshold;
        if (open && h.state !== 'open') await registry.audit('system', 'provider.circuit_opened', 'provider', key, { metadata: { failures, error: String(err && err.message || err).slice(0, 200) } });
        await putHealth.run({ ...h, provider_key: key, state: open ? 'open' : 'closed', consecutive_failures: failures, opened_at: open ? clock.now() : h.opened_at, last_error: String(err && err.message || err).slice(0, 500), last_failure_at: clock.now() });
    }
    async function resetHealth(key) { await db.prepare('DELETE FROM provider_health WHERE provider_key = ?').run(key); }

    // ── Pricing: platform.rate-card@1 per metric (server/providers/rate-cards.js; models row -> AI_PRICING_JSON -> flat) ──
    /** The { in, cached, out } rate cards for a provider + model, or null for a provider that is never billed (stub, whisper). */
    async function rateCardsFor(providerKey, model) {
        const p = await registry.getProvider(providerKey);
        if (!p || p.kind === 'stub' || p.kind === 'whisper') return null;
        const row = model ? await registry.getModel(providerKey, model) : null;
        return rates.buildCards({ providerKey, model: model || null, row, pricing: config.pricing });
    }
    async function priceFor(providerKey, model) {
        const cards = await rateCardsFor(providerKey, model);
        return cards ? rates.pricesOf(cards) : { in: 0, out: 0, cached: 0 };
    }
    async function costOf(providerKey, model, usage) {
        const cards = await rateCardsFor(providerKey, model);
        return cards ? rates.costOfUsage(cards, usage) : 0;
    }

    // ── Provider state: platform.provider-state@1 per provider, from usage_daily and the breaker ──
    const getPeriodUsage = db.prepare(`SELECT day, model_key, SUM(tokens_in)::bigint AS tokens_in, SUM(tokens_out)::bigint AS tokens_out, SUM(tokens_cached)::bigint AS tokens_cached
        FROM usage_daily WHERE provider_key = ? AND day >= ? GROUP BY day, model_key`);
    /** One state per provider over the cards the plan uses (cards: { provider: [card, ...] }); each card counts its own period. */
    async function providerStates(cardsByProvider) {
        const now = clock.now();
        const out = [];
        for (const [key, cards] of Object.entries(cardsByProvider)) {
            const usageRows = (await getPeriodUsage.all(key, rates.usageSince(cards, now)))
                .map(r => ({ day: r.day, model_key: r.model_key, tokens_in: Number(r.tokens_in), tokens_out: Number(r.tokens_out), tokens_cached: Number(r.tokens_cached) }));
            const p = await registry.getProvider(key);
            out.push(rates.providerState({ provider: key, cards, usageRows, breaker: (await health(key)).state, reserve: p && p.metadata ? p.metadata.reserve : null, now }));
        }
        return out;
    }

    // ── Routing ────────────────────────────────────────────
    /** A provider that is never billed: the deterministic stub and the local servers (llama.cpp, whisper.cpp). */
    function isFreeProvider(p) {
        return p.kind === 'stub' || p.kind === 'whisper' || Boolean(p.metadata && p.metadata.paid === false);
    }
    const offerId = (provider, model) => (model ? `${provider}:${model}` : provider);
    const splitOfferId = (id) => {
        const i = String(id).indexOf(':');
        return i < 0 ? { provider: id, model: null } : { provider: id.slice(0, i), model: id.slice(i + 1) };
    };

    // ── Capability pool (T6 phase 1): placement over every provider that can serve the capability ──
    const getRouteState = db.prepare('SELECT * FROM placement_state WHERE route_key = ?');
    const getProviderStats = db.prepare(`SELECT provider, MAX(latency_p95_ms) AS p95, SUM(requests)::bigint AS requests, SUM(errors)::bigint AS errors
        FROM provider_stats_daily WHERE day >= ? GROUP BY provider`);
    async function statsByProvider(days = 7) {
        const from = new Date(clock.now() - days * 86400000).toISOString().slice(0, 10);
        const m = new Map();
        for (const r of await getProviderStats.all(from)) m.set(r.provider, { p95: r.p95 == null ? null : Number(r.p95), requests: Number(r.requests), errors: Number(r.errors) });
        return m;
    }

    /**
     * The order the router tries for a capability route: openvibe-sdk/placement ranks every provider whose
     * capabilities cover the operation, by objective, price (the model rate card), measured latency and
     * health (placement_state error rate + the breaker); hysteresis through the route's current placement.
     * The stub is never a placement candidate (synthetic output must not win on price) — it is appended last.
     */
    async function poolCandidates(route, features, operation) {
        const stats = await statsByProvider();
        const offers = [];
        const rateCards = [];
        const cardsByProvider = {};
        const seen = new Set();
        const addOffer = async (p, model, caps) => {
            const id = offerId(p.key, model);
            if (seen.has(id)) return;
            seen.add(id);
            const creds = p.auth_mode === 'none' || Boolean(resolveSecret(p.secret_ref, env));
            const h = await health(p.key);
            const st = stats.get(p.key) || { p95: null, requests: 0, errors: 0 };
            const errorRate = st.requests ? st.errors / st.requests : 0;
            const status = p.status !== 'active' || !creds ? 'down' : h.state === 'open' ? 'down' : (h.state === 'half_open' || errorRate > 0.5) ? 'degraded' : 'up';
            const free = isFreeProvider(p);
            // Placement prices an offer on one card: input tokens, the part of a call known before it runs.
            // The cached-input and output cards ride along (costOf bills all three; the state counts each metric).
            const cards = free ? null : await rateCardsFor(p.key, model);
            offers.push({
                offer_id: id, kind: 'provider', provider: p.key, region: 'global',
                trust: (p.metadata && p.metadata.local) || p.kind === 'stub' ? 'community' : 'first-party',
                capabilities: caps, latency_ms: st.p95 ? { p95: st.p95 } : {}, health: { status },
                pricing: cards ? { model: 'metered', rate_card: cards.in.id } : { model: 'prepaid' },
            });
            if (cards) {
                rateCards.push(cards.in, cards.cached, cards.out);
                (cardsByProvider[p.key] || (cardsByProvider[p.key] = [])).push(cards.in, cards.cached, cards.out);
            }
        };
        for (const p of await registry.listProviders()) {
            if (p.key === 'stub' || !p.capabilities.some(f => features.includes(f))) continue;
            await addOffer(p, (route.constraints && route.constraints.model) || p.default_model || null, p.capabilities);
        }
        // A pinned candidate stays in the pool even when the provider's capability list is incomplete (migration):
        // the pin is an explicit admin assertion that it can serve the route's capability.
        for (const pin of route.pinned || []) {
            if (!pin || !pin.provider || pin.provider === 'stub') continue;
            const p = await registry.getProvider(pin.provider);
            if (!p) continue;
            const caps = route.capability && !p.capabilities.includes(route.capability) ? [...p.capabilities, route.capability] : p.capabilities;
            await addOffer(p, pin.model || p.default_model || null, caps);
        }
        const c = route.constraints || {};
        const requirements = {
            kind: 'ai', mobility: 'request', latency_class: c.latency_class || 'interactive', objective: c.objective || 'balanced',
            capabilities: features, units: Number(c.units) || 1, latency_op: operation,
            ...(c.max_latency_ms != null ? { max_latency_ms: Number(c.max_latency_ms) } : {}),
            ...(c.max_cost_usd != null ? { max_cost_usd: Number(c.max_cost_usd) } : {}),
            ...(c.trust ? { trust: c.trust } : {}),
            ...(c.authority ? { authority: c.authority } : {}),
        };
        const state = await getRouteState.get(route.key);
        const current = state && state.current_provider ? offerId(state.current_provider, state.current_model) : null;
        const states = await providerStates(cardsByProvider);
        const result = placement.plan(requirements, offers, {
            rateCards, states, now: clock.now(), current, minGain: config.placement.minGain,
            weights: { cost: config.placement.costWeight, latency: config.placement.latencyWeight },
        });
        const byId = new Map(offers.map(o => [o.offer_id, o]));
        const explain = {
            objective: result.objective, reasons: result.reasons, selected: result.selected,
            candidates: result.candidates.map((x) => {
                const o = byId.get(x.id) || {};
                return { provider: o.provider || splitOfferId(x.id).provider, model: splitOfferId(x.id).model, eligible: Boolean(x.eligible),
                    excluded_reason: x.excluded_because || null, cost: x.estimated_cost_usd == null ? null : x.estimated_cost_usd, latency: x.estimated_latency_ms == null ? null : x.estimated_latency_ms };
            }),
        };
        const order = [];
        if (result.selected) order.push(result.selected);
        const rest = result.candidates.filter(x => x.id !== result.selected).sort((a, b) => {
            const ea = a.eligible && Number.isFinite(a.estimated_cost_usd) ? 0 : 1;
            const eb = b.eligible && Number.isFinite(b.estimated_cost_usd) ? 0 : 1;
            return ea - eb || (a.score ?? Infinity) - (b.score ?? Infinity);
        });
        for (const x of rest) order.push(x.id);
        return { order: order.map(splitOfferId), explain, placement: result, rateCards, states };
    }

    /** A pinned route: [primary, ...fallbacks], exactly as before. */
    async function pinnedCandidates(route, features) {
        const list = [route.primary, ...(route.fallbacks || [])].filter(c => c && c.provider);
        const explain = { objective: null, reasons: ['pinned route: the primary, then its fallbacks'], selected: null, candidates: [] };
        for (const c of list) {
            const entry = await adapter(c.provider);
            const p = entry && entry.record;
            const why = await skipReason(p, entry && entry.adapter, features);
            explain.candidates.push({ provider: c.provider, model: c.model || (p && p.default_model) || null, eligible: !why, excluded_reason: why, cost: null, latency: null });
        }
        return { order: list.map(c => ({ provider: c.provider, model: c.model || null })), explain };
    }

    async function candidates(route, features, operation) {
        const { order, explain, placement: result = null, ...rest } = route.capability && operation
            ? await poolCandidates(route, features, operation)
            : await pinnedCandidates(route, features);
        if (config.stubFallback && !order.some(c => c.provider === 'stub') && await registry.getProvider('stub')) {
            order.push({ provider: 'stub', model: null });
            explain.candidates.push({ provider: 'stub', model: null, eligible: true, excluded_reason: null, cost: 0, latency: null });
        }
        return { order, explain, placement: result, rateCards: rest.rateCards || [], states: rest.states || [] };   // placement: the platform.placement-result@1 explain is built from (pool routes)
    }

    async function skipReason(p, a, features) {
        if (!p || !a) return 'unknown_provider';
        if (p.status !== 'active') return 'disabled';
        if (p.auth_mode !== 'none' && !resolveSecret(p.secret_ref, env)) return 'no_credentials';
        if (features.some(f => !a.supports(f))) return 'unsupported';
        if ((await health(p.key)).state === 'open') return 'circuit_open';
        return null;
    }

    /**
     * ctx: { runId, routeKey, routeVersion, signal, logRequest(entry), debugRaw }
     * req: canonical request (system, messages, image, json, maxTokens, temperature, cacheKey, input, filePath, ...)
     */
    /**
     * A run with a person's own key (server/credentials.js): that provider only, no fallback, no circuit breaker
     * shared with anyone, chat operations only; the base URL they chose is reached through guardedFetch. One
     * request-log row per attempt under provider_key byo:<owner>:<subject>, priced by the model's list price.
     */
    async function executeWithCredential(cred, operation, req, ctx = {}) {
        // Text operations are all chat completions on the person's provider (templated workflows use generate).
        if (!['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich'].includes(operation)) throw new AiError(422, 'credential.unsupported', `a person's own key is used for text only, not ${operation}`);
        const guardedFetch = credentialFetch || require('./guarded-fetch').guardedFetch;
        // The person's model for this role: the run's input.role, else the Live role its route names (live.director).
        const wanted = ctx.role || ((/^live\.(chat|vision|director|summary|legacy)$/.exec(ctx.routeKey || '') || [])[1]) || null;
        const role = wanted && cred.models[wanted] ? wanted : null;
        const model = (req.image && cred.models.vision) || (role && cred.models[role]) || cred.models.chat || (cred.provider === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-4o-mini');
        const record = { key: cred.providerKey, kind: cred.provider, base_url: cred.base_url, capabilities: ['chat', 'json', 'vision'], timeout_ms: 60000 };
        const a = cred.provider === 'anthropic' ? createAnthropicProvider(record, { apiKey: cred.apiKey, fetchImpl: guardedFetch }) : createOpenAiProvider(record, { apiKey: cred.apiKey, fetchImpl: guardedFetch });
        const base = { operation, provider_key: cred.providerKey, model_key: model, route_key: ctx.routeKey || null, route_version: ctx.routeVersion || null, fallback: 0, prompt_hash: ctx.promptHash || null };
        const timeoutMs = Math.max(1000, Math.min(req.timeoutMs || 60000, 120000));
        let lastErr = null;
        for (let attempt = 0; attempt <= config.providerRetries; attempt++) {
            if (ctx.signal && ctx.signal.aborted) throw new AiError(409, 'run.cancelled', 'run was cancelled');
            const t0 = Date.now();
            try {
                const result = await a.chat({ ...req, model, signal: ctx.signal, timeoutMs });
                const usage = result.usage || { input: 0, output: 0, cached: 0 };
                const cost = rates.costOfUsage(rates.buildCards({ providerKey: cred.providerKey, model: result.model || model, pricing: config.pricing, flat: false }), usage);
                const latency = Date.now() - t0;
                if (ctx.logRequest) {
                    ctx.logRequest({ ...base, model_key: result.model || model, status: 'ok', output_hash: sha256(result.json || result.text || ''), tokens_in: usage.input || 0, tokens_out: usage.output || 0,
                        tokens_cached: usage.cached || 0, tokens_estimated: usage.estimated ? 1 : 0, cost_usd: cost, latency_ms: latency });
                }
                return { result, provider: cred.providerKey, providerKind: cred.provider, model: result.model || model, fallbackUsed: false, usage, cost, latencyMs: latency, synthetic: false, tried: [], startedAt: t0 };
            } catch (err) {
                lastErr = err;
                if (ctx.signal && ctx.signal.aborted) throw new AiError(409, 'run.cancelled', 'run was cancelled');
                if (ctx.logRequest) ctx.logRequest({ ...base, status: err && err.code === 'provider.timeout' ? 'timeout' : 'error', latency_ms: Date.now() - t0, error: String(err && err.message || err).slice(0, 500) });
                if (err && err.code === 'EADDRNOTPUBLIC') throw new AiError(422, 'credential.endpoint_refused', err.message);
                if (attempt < config.providerRetries && retryable(err)) { await sleep(config.retryDelayMs, ctx.signal).catch(() => {}); continue; }
                break;
            }
        }
        throw new AiError(502, 'credential.provider_failed', `the person's own provider did not answer: ${String(lastErr && lastErr.message || lastErr).slice(0, 200)}`);
    }

    async function execute(route, operation, req, ctx = {}) {
        if (ctx.credential) return await executeWithCredential(ctx.credential, operation, req, ctx);
        const features = [operation];
        if (req.image) features.push('vision');
        if (req.json) features.push('json');
        const tried = [];
        const { order: list, explain } = await candidates(route, features, operation);
        for (let i = 0; i < list.length; i++) {
            const c = list[i];
            const entry = await adapter(c.provider);
            const p = entry && entry.record;
            const a = entry && entry.adapter;
            const model = c.model || (p && p.default_model) || null;
            const fallback = i > 0;
            const base = { operation, provider_key: c.provider, model_key: model, route_key: ctx.routeKey || null, route_version: ctx.routeVersion || null, fallback: fallback ? 1 : 0, prompt_hash: ctx.promptHash || null, input_hash: ctx.inputHash || null };
            const why = await skipReason(p, a, features);
            if (why) {
                statFor(c.provider).skipped++;
                tried.push({ provider: c.provider, skipped: why });
                if (ctx.logRequest) ctx.logRequest({ ...base, status: 'skipped', skip_reason: why });
                continue;
            }
            const timeoutMs = Math.max(1000, Math.min(req.timeoutMs || route.timeout_ms || p.timeout_ms || 30000, p.timeout_ms || 600000));
            const retries = config.providerRetries;
            let lastErr = null;
            for (let attempt = 0; attempt <= retries; attempt++) {
                if (ctx.signal && ctx.signal.aborted) throw new AiError(409, 'run.cancelled', 'run was cancelled');
                const started = clock.now();
                const t0 = Date.now();
                try {
                    const fn = a[operation];
                    if (typeof fn !== 'function') throw new ProviderError(`${operation} not implemented`, { code: 'provider.unsupported' });
                    statFor(c.provider).calls += p.kind === 'stub' ? 0 : 1;   // stub counts its own calls
                    const result = await fn({ ...req, model, signal: ctx.signal, timeoutMs });
                    const latency = Date.now() - t0;
                    const usage = result.usage || { input: 0, output: 0, cached: 0 };
                    const cost = await costOf(c.provider, result.model || model, usage);
                    statFor(c.provider).ok++;
                    await recordSuccess(c.provider);
                    if (ctx.logRequest) {
                        ctx.logRequest({
                            ...base, model_key: result.model || model, status: 'ok', output_hash: sha256(result.json || result.text || result.vectors || result.segments || ''),
                            tokens_in: usage.input || 0, tokens_out: usage.output || 0, tokens_cached: usage.cached || 0, tokens_estimated: usage.estimated ? 1 : 0,
                            cost_usd: cost, latency_ms: latency,
                            debug_prompt: ctx.debugRaw ? JSON.stringify({ system: req.system, messages: req.messages }).slice(0, 200000) : null,
                            debug_response: ctx.debugRaw ? String(result.text || '').slice(0, 200000) : null,
                        });
                    }
                    explain.selected = c.provider;
                    return { result, provider: c.provider, providerKind: p.kind, model: result.model || model, fallbackUsed: fallback, usage, cost, latencyMs: latency, synthetic: Boolean(result.synthetic || a.synthetic), tried, startedAt: started, explain };
                } catch (err) {
                    lastErr = err;
                    if (ctx.signal && ctx.signal.aborted) {
                        if (ctx.logRequest) ctx.logRequest({ ...base, status: 'cancelled', latency_ms: Date.now() - t0, error: 'cancelled' });
                        throw new AiError(409, 'run.cancelled', 'run was cancelled');
                    }
                    statFor(c.provider).failures++;
                    if (ctx.logRequest) ctx.logRequest({ ...base, status: err && err.code === 'provider.timeout' ? 'timeout' : 'error', latency_ms: Date.now() - t0, error: String(err && err.message || err).slice(0, 500) });
                    if (attempt < retries && retryable(err)) { await sleep(config.retryDelayMs + Math.floor(Math.random() * Math.min(700, config.retryDelayMs)), ctx.signal).catch(() => {}); continue; }
                    break;
                }
            }
            // A request the provider rejected as malformed is the caller's fault, not a sign the
            // provider is unhealthy; a 429 is capacity, not health either, and moves on without
            // opening the circuit. Neither must take a shared provider away from other callers.
            if (!callerFault(lastErr) && !rateLimited(lastErr)) await recordFailure(c.provider, lastErr);
            tried.push({ provider: c.provider, error: String(lastErr && lastErr.message || lastErr).slice(0, 200) });
            log.warn(`[ai] ${operation} via ${c.provider}/${model || '-'} failed: ${lastErr && lastErr.message}`);
        }
        explain.selected = null;
        explain.reasons = [...(explain.reasons || []), 'no provider on this route could answer'];
        throw new AiError(503, 'provider.unavailable', 'no provider on this route could answer', { tried, explain });
    }

    return { adapter, health, resetHealth, execute, executeWithCredential, priceFor, costOf, rateCardsFor, providerStates, stats, statFor, candidates };
}

module.exports = { createProviderPool };
