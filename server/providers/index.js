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
const contracts = require('openvibe-contracts');
const { AiError, resolveSecret, sha256 } = require('../util');
const { retryable, sleep, ProviderError, schemaInstruction } = require('./common');
const { createStubProvider } = require('./stub');
const { createOpenAiProvider } = require('./openai');
const { createResponsesProvider } = require('./responses');
const { createAnthropicProvider } = require('./anthropic');
const { createHttpSeamProvider } = require('./http');
const { createWhisperProvider } = require('./whisper');
const rates = require('./rate-cards');
const { detectTask, capabilitiesOf, hardNeeds, rank, reasonFor, workKind, leadingText } = require('./task');
const { createWarmCache } = require('./warm-cache');

/** 4xx that the request itself caused (bad image, schema, max_tokens...), as opposed to auth, rate or availability. */
function callerFault(err) {
    const st = err && err.status;
    return Number.isInteger(st) && st >= 400 && st < 500 && ![401, 403, 404, 408, 429].includes(st);
}

/** An upstream 429 is rate-limit capacity, not provider ill health: it shifts to the next candidate but must not open the circuit. */
function rateLimited(err) {
    return (err && err.status === 429) || (err && err.code === 'provider.rate_limited');
}

/** The model a person's credential uses when they stored none, per provider (executeWithCredential). */
const { CREDENTIAL_PROVIDERS, PROVIDER_KIND, DEFAULT_MODEL } = require('../credentials');
const CREDENTIAL_DEFAULT_MODEL = { ...DEFAULT_MODEL, anthropic: 'claude-haiku-5-5', openai: 'gpt-4o-mini', deepseek: 'deepseek-chat', minimax: 'MiniMax-M2', openrouter: 'openrouter/auto' };

/** The key as explain names it, never the key itself (L36 Y1/Y7). */
const paidByOf = (cred) => `your ${cred.provider} key …${String(cred.hint || '').slice(-4) || '????'}`;
// The kind of work a run does (the person's ai.me-preferences.defaults has one default per kind)
// comes from the task detector: server/providers/task.js.
/** The default per-provider timeout when neither the catalogue nor the provider names one. */
const DEFAULT_PROVIDER_TIMEOUT_MS = 30000;
/** The fallback chain's budget when the config does not name one. */
const DEFAULT_MAX_ATTEMPTS = 3;
/**
 * Who the warm-cache memory belongs to: the person, else the app or service that asked, and the route it
 * asked on (the same prompt on another route is another job, and its cache is a different one).
 */
const warmSubject = (ctx = {}, route = null) =>
    (ctx.selfSubject || (ctx.requesterType ? ctx.requesterType + ':' + ctx.requesterId : null) || 'anonymous') + '|' + String((route && route.key) || '');
/** The person's own default model for this kind of work, when they named one (L36 Y3). */
function preferredModelFor(prefs, operation, req, ctx) {
    const kind = workKind(operation, req, ctx);
    const choice = prefs && prefs.defaults ? prefs.defaults[kind] : null;
    return choice && choice !== 'auto' ? choice : null;
}
/** Can one stored key serve this operation? (executeWithCredential's own rule, checked before it is called.) */
function credentialCanServe(provider, operation, req) {
    if (!CREDENTIAL_PROVIDERS.includes(provider)) return false;
    const text = ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich'];
    if (text.includes(operation)) return true;
    if (operation === 'messages') return PROVIDER_KIND[provider] === 'anthropic' || provider === 'custom';
    if (operation === 'complete') return PROVIDER_KIND[provider] === 'openai' || provider === 'custom';
    return false;
}
/** The model a self key should use for this run: the person's default for the kind, else their stored model. */
function selfModelFor(cred, operation, req, ctx, prefs) {
    const kind = workKind(operation, req, ctx);
    const choice = prefs && prefs.defaults ? prefs.defaults[kind] : 'auto';
    const stored = cred.models || {};
    const role = ctx.role || ((/^live\.(chat|vision|director|summary|legacy)$/.exec(ctx.routeKey || '') || [])[1]) || null;
    const model = (choice && choice !== 'auto') ? choice
        : (req.image && stored.vision) || (role && stored[role]) || stored[kind] || stored.chat
            || CREDENTIAL_DEFAULT_MODEL[cred.provider] || 'gpt-4o-mini';
    const why = choice && choice !== 'auto' ? `your default ${kind} model` : (stored[kind] || stored.chat ? 'the model you stored for this key' : "the provider's default");
    return { model, kind, why };
}

function createProviderPool({ db, registry, config, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, env = process.env, log = console, credentialFetch = null, machineModels = null, bench = null }) {
    // A person's own machine as their model (credential provider node, server/machines.js).
    const machines = machineModels || require('../machines').createMachineModels({ config, env, fetchImpl });
    const cache = new Map();          // key -> { stamp, adapter }
    const stats = {};                 // key -> { calls, failures, ... } (in memory; tests + /api/ready)
    // L36 Y7: the provider that last answered this prompt, for five minutes (server/providers/warm-cache.js).
    const warm = createWarmCache({ now: () => clock.now() });

    function statFor(key) { return stats[key] || (stats[key] = { calls: 0, ok: 0, failures: 0, skipped: 0 }); }

    function build(p) {
        const apiKey = resolveSecret(p.secret_ref, env);
        switch (p.kind) {
            case 'stub': return createStubProvider(p, { stats: statFor(p.key) });
            case 'openai': return createOpenAiProvider(p, { apiKey, fetchImpl });
            case 'responses': return createResponsesProvider(p, { apiKey, fetchImpl });
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
    /** The { in, cached, out } rate cards for a provider + model, or null for a provider that is never billed. */
    async function rateCardsFor(providerKey, model) {
        const p = await registry.getProvider(providerKey);
        if (!p || isFreeProvider(p)) return null;
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
    /** Local execution never enters the media paid pool, even if a record has no explicit price flag. */
    function isLocalProvider(p) {
        return p.kind === 'whisper' || Boolean(p.metadata && p.metadata.local);
    }
    /**
     * Billing profiles whose capacity is already paid for: a subscription, a free server or a person's own key.
     * They carry no per-token rate card and are offered as prepaid. The profile is the providers.billing_profile
     * column (migrations/0008): registry.upsertProvider seeds it from metadata on create, the column is the
     * authority afterwards, and the router never reads metadata.
     */
    const PREPAID_PROFILES = ['subscription', 'free', 'byok'];
    function billingProfile(p) { return (p && p.billing_profile) || 'metered'; }
    function isPrepaidProvider(p) { return PREPAID_PROFILES.includes(billingProfile(p)); }
    /**
     * Prepaid capacity that runs with no authority credential in secret_ref: a free server, or a pooled
     * subscription whose credential is held outside the provider record. A byok key is the caller's own
     * (executeWithCredential), so a pool record for it still needs a resolvable secret_ref or is skipped.
     */
    function credentialNotRequired(p) {
        const profile = billingProfile(p);
        if (profile === 'free') return true;
        return profile === 'subscription' && (p.secret_ref == null || p.secret_ref === '');
    }
    /** A provider that is never metered: the deterministic stub, free or local servers, and every prepaid profile. */
    function isFreeProvider(p) {
        return p.kind === 'stub' || isLocalProvider(p) || Boolean(p.metadata && p.metadata.paid === false) || isPrepaidProvider(p);
    }
    /**
     * May a developer app's run (ADR-014) use this provider? Never a person's byok key, and a free-only run
     * (ctx.freeOnly: a sandbox run, or any app run no tier budget governs) is limited to free and local
     * capacity: the stub, the local model, a free server or a pooled subscription. A provider that fails
     * this is not offered to the planner at all.
     */
    function appOffered(ctx, p) {
        if (!p) return true;   // an unknown provider keeps its place; skipReason reports it, as before
        if (ctx.appRun && billingProfile(p) === 'byok') return false;
        if (ctx.freeOnly && !isFreeProvider(p)) return false;
        return true;
    }
    /** Operations served only by registered models of one type (never a provider's default chat model). */
    const MODEL_TYPE = { embed: 'embedding', transcribe: 'stt', image: 'image' };
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
    async function poolCandidates(route, features, operation, ctx = {}) {
        const stats = await statsByProvider();
        const offers = [];
        const rateCards = [];
        const cardsByProvider = {};
        const seen = new Set();
        const addOffer = async (p, model, caps) => {
            const id = offerId(p.key, model);
            if (seen.has(id)) return;
            seen.add(id);
            const creds = p.auth_mode === 'none' || credentialNotRequired(p) || Boolean(resolveSecret(p.secret_ref, env));
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
                capabilities: caps.map(f => typeof f === 'string' ? `ai:${f}` : f),
                latency_ms: st.p95 ? { p95: st.p95 } : {}, health: { status },
                pricing: cards ? { model: 'per-operation', rate_card: cards.in.id } : { model: 'prepaid' },
                updated_at: p.updated_at,
            });
            if (cards) {
                rateCards.push(cards.in, cards.cached, cards.out);
                (cardsByProvider[p.key] || (cardsByProvider[p.key] = [])).push(cards.in, cards.cached, cards.out);
            }
        };
        const scope = route.constraints && route.constraints.provider_scope;
        for (const p of await registry.listProviders()) {
            const caps = await offeredCapabilities(p);
            if (p.key === 'stub' || !caps.some(f => features.includes(f))) continue;
            if (!appOffered(ctx, p)) continue;
            if (scope === 'local' && !isLocalProvider(p)) continue;
            if (scope === 'paid' && isFreeProvider(p)) continue;
            if (MODEL_TYPE[operation]) {
                // A chat model advertised by an OpenAI-shaped provider is not an embedding, STT or image model.
                const type = MODEL_TYPE[operation];
                for (const m of await registry.listModels({ provider: p.key })) {
                    if (m.type === type && m.status === 'active') await addOffer(p, m.model_key, caps);
                }
            } else {
                await addOffer(p, (route.constraints && route.constraints.model) || p.default_model || null, caps);
            }
        }
        // A pinned candidate stays in the pool even when the provider's capability list is incomplete (migration):
        // the pin is an explicit admin assertion that it can serve the route's capability.
        for (const pin of route.pinned || []) {
            if (!pin || !pin.provider || pin.provider === 'stub') continue;
            const p = await registry.getProvider(pin.provider);
            if (!p) continue;
            if (!appOffered(ctx, p)) continue;
            if (scope === 'local' && !isLocalProvider(p)) continue;
            if (scope === 'paid' && isFreeProvider(p)) continue;
            const declared = await offeredCapabilities(p);
            const caps = route.capability && !declared.includes(route.capability) ? [...declared, route.capability] : declared;
            await addOffer(p, pin.model || p.default_model || null, caps);
        }
        const c = route.constraints || {};
        const requirements = {
            kind: 'ai', mobility: 'request', latency_class: c.latency_class || 'interactive', objective: c.objective || 'balanced',
            capabilities: features.map(f => typeof f === 'string' ? `ai:${f}` : f), units: Number(c.units) || 1, latency_op: operation,
            ...(c.max_latency_ms != null ? { max_latency_ms: Number(c.max_latency_ms) } : {}),
            ...(c.max_cost_usd != null ? { max_cost_usd: Number(c.max_cost_usd) } : {}),
            ...(c.trust ? { trust: c.trust } : {}),
            ...(c.authority ? { authority: c.authority } : {}),
        };
        for (const offer of offers) {
            const validation = contracts.validate('platform.resource-offer@1', offer);
            if (!validation.valid) throw new Error(`invalid platform.resource-offer@1 ${offer.offer_id}: ${JSON.stringify(validation.errors)}`);
        }
        // These are SDK planner options, not fields in the workload contract.
        const { units, latency_op, authority, ...contractRequirements } = requirements;
        const validation = contracts.validate('platform.workload-requirements@1', contractRequirements);
        if (!validation.valid) throw new Error(`invalid platform.workload-requirements@1: ${JSON.stringify(validation.errors)}`);
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

    /**
     * A pinned route: [primary, ...fallbacks], exactly as before. A provider an app run may not use
     * (a byok key, or anything metered for a free-only run) leaves the order with its
     * reason in explain.candidates; every other candidate keeps its place, as before.
     */
    async function pinnedCandidates(route, features, ctx = {}) {
        const list = [route.primary, ...(route.fallbacks || [])].filter(c => c && c.provider);
        const explain = { objective: null, reasons: ['pinned route: the primary, then its fallbacks'], selected: null, candidates: [] };
        const order = [];
        for (const c of list) {
            const entry = await adapter(c.provider);
            const p = entry && entry.record;
            const why = await skipReason(p, entry && entry.adapter, features);
            const offered = appOffered(ctx, p);
            explain.candidates.push({
                provider: c.provider, model: c.model || (p && p.default_model) || null, eligible: offered && !why,
                excluded_reason: offered ? why : (p && billingProfile(p) === 'byok' ? 'byok' : 'free_only'), cost: null, latency: null,
            });
            if (offered) order.push({ provider: c.provider, model: c.model || null });
        }
        return { order, explain };
    }

    /**
     * What a provider offers the pool: its declared capabilities, plus `complete` (a Chat Completions request passed
     * through, ai.complete) when it declares chat and its adapter passes one through (the OpenAI format). No provider
     * declares `complete`, so without this the pool had no offer for /v1/chat/completions (2026-10-15).
     */
    async function offeredCapabilities(p) {
        if (!p.capabilities.includes('chat')) return p.capabilities;
        const extra = ['complete', 'messages'].filter(f => !p.capabilities.includes(f));
        if (!extra.length) return p.capabilities;
        const entry = await adapter(p.key);
        const serves = extra.filter(f => entry && entry.adapter && entry.adapter.supports(f));
        return serves.length ? [...p.capabilities, ...serves] : p.capabilities;
    }

    async function candidates(route, features, operation, ctx = {}) {
        let { order, explain, placement: result = null, ...rest } = route.capability && operation
            ? await poolCandidates(route, features, operation, ctx)
            : await pinnedCandidates(route, features, ctx);
        // BENCH-11: an opted-in route may put the cheapest offer statistically tied with Bench's leader first.
        // A route without the opt-in (or without evidence) keeps the order placement just produced.
        if (bench) {
            const picked = await bench.select({ route, order, operation });
            order = picked.order;
            explain.bench = picked.view;
            if (picked.view.status === 'selected' && picked.view.selected) {
                explain.selected = offerId(picked.view.selected.provider, picked.view.selected.model);
                explain.reasons = [picked.view.reason, ...(explain.reasons || [])];
            }
        }
        // A scoped route never ends on synthetic text (media.paid falls back to its extractive overview); an image
        // has no such fallback, so the dev/test stub PNG (AI_STUB_FALLBACK, off in production) still closes it.
        if (config.stubFallback && (!(route.constraints && route.constraints.provider_scope) || operation === 'image')
            && !order.some(c => c.provider === 'stub') && await registry.getProvider('stub')) {
            order.push({ provider: 'stub', model: null });
            explain.candidates.push({ provider: 'stub', model: null, eligible: true, excluded_reason: null, cost: 0, latency: null });
        }
        return { order, explain, placement: result, rateCards: rest.rateCards || [], states: rest.states || [] };   // placement: the platform.placement-result@1 explain is built from (pool routes)
    }

    /**
     * What the catalogue knows about one candidate (L36 Y7): its capabilities, its prices, its strength tier.
     */
    async function describeCandidate(c) {
        const entry = await adapter(c.provider);
        const p = entry && entry.record;
        const model = c.model || (p && p.default_model) || null;
        const row = model ? await registry.getModel(c.provider, model) : null;
        const caps = capabilitiesOf(row, p);
        const prices = await priceFor(c.provider, model);
        return { provider: c.provider, model, caps, row, record: p, priceIn: Number(prices.in) || 0, priceOut: Number(prices.out) || 0 };
    }

    /**
     * The provider's own timeout for one model (L36 Y7): the catalogue's model row first, then the
     * provider's preset. It is the ceiling: a person can never set a longer one.
     */
    async function providerTimeout(p, model) {
        const row = model ? await registry.getModel(p.key, model) : null;
        const meta = row && row.metadata ? row.metadata : {};
        return Number(meta.timeout_ms) || Number(p.timeout_ms) || 0;
    }

    /** The health the pool left a candidate with: 0 up, 1 degraded, 2 down. */
    function healthRank(excluded) {
        const why = String(excluded || '');
        if (/health down/.test(why)) return 2;
        if (/health degraded/.test(why)) return 1;
        return 0;
    }

    /**
     * L36 Y7: pick for the task. The hard needs come first (a model that cannot do the job is never tried),
     * then fit and cost: a light job takes the cheapest capable model, a heavy one the catalogue's strength
     * tier first. The explain says what the task was and why every candidate is there.
     */
    async function rankCandidates({ list, explain, task, route = null, warmProvider = null, preferred = null, ceiling = null, tierFirst = null, keepOrder = false }) {
        const byKey = new Map((explain.candidates || []).map((c) => [c.provider + ':' + (c.model || ''), c]));
        const authority = route && route.constraints ? (route.constraints.authority || null) : null;
        const entries = [];
        const rest = [];
        let stub = null;
        for (const c of list) {
            if (c.provider === 'stub') { stub = c; continue; }        // synthetic output is never a candidate
            const seen = byKey.get(c.provider + ':' + (c.model || ''));
            const d = await describeCandidate(c);
            const missing = hardNeeds(d.caps, task);
            if (missing.length) {
                // A model that cannot do this job is never tried: it leaves the order with its reason.
                if (seen) { seen.eligible = false; seen.excluded_reason = missing.join(','); }
                continue;
            }
            const over = ceiling != null && d.priceOut > Number(ceiling);
            const entry = {
                provider: c.provider, model: d.model, price: over ? Infinity : d.priceIn,
                tier: d.caps.tier || 'balanced', health: healthRank(seen && seen.excluded_reason),
                latency: seen ? seen.latency : null, candidate: c, eligible: !(seen && seen.eligible === false),
            };
            // A pinned route keeps its own order (and its skipped candidates where the pin put them).
            if (keepOrder) { entries.push(entry); continue; }
            if (!entry.eligible) { rest.push(c); continue; }             // the pool excluded it (health, cost)
            entries.push(entry);
        }
        const ranked = keepOrder
            ? { order: entries.map((e) => e.candidate), ranked: entries.slice(0, 5) }
            : rank(entries, { task, warm: warmProvider, preferred, authority, tierFirst });
        const order = keepOrder ? ranked.order : [...ranked.order.map((e) => ({ provider: e.provider, model: e.model })), ...rest];
        if (stub) order.push(stub);
        const view = ranked.ranked.map((e) => ({ provider: e.provider, model: e.model, why: reasonFor(e, task), cost: Number.isFinite(e.price) ? e.price : null, tier: e.tier }));
        const reasons = new Map(ranked.order.map((e) => [e.provider + ':' + (e.model || ''), reasonFor(e, task)]));
        return { order, ranked: view, reasons };
    }

    async function skipReason(p, a, features) {
        if (!p || !a) return 'unknown_provider';
        if (p.status !== 'active') return 'disabled';
        if (p.auth_mode !== 'none' && !credentialNotRequired(p) && !resolveSecret(p.secret_ref, env)) return 'no_credentials';
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
    /**
     * A run on the person's own machine (credential provider node): one chat completion through OpenVibe.Bot to their
     * model server. Text only, no fallback, nothing spent; one request-log row under byo:<owner>:<subject>.
     */
    async function executeOnMachine(cred, operation, req, ctx = {}) {
        if (!['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich'].includes(operation)) throw new AiError(422, 'credential.unsupported', `a person's own machine answers text only, not ${operation}`);
        if (req.image) throw new AiError(422, 'credential.unsupported', 'a person\'s own machine reads no pictures yet');
        const wanted = ctx.role || ((/^live\.(chat|vision|director|summary|legacy)$/.exec(ctx.routeKey || '') || [])[1]) || null;
        const model = (wanted && cred.models[wanted]) || cred.models.chat;
        if (!model) throw new AiError(422, 'credential.no_model', 'the person\'s own machine credential names no model (models.chat)');
        const sysText = [...(req.system || []).map((x) => x.text), req.json ? schemaInstruction(req.json) : ''].filter(Boolean).join('\n\n');
        const messages = [
            ...(sysText ? [{ role: 'system', content: sysText }] : []),
            ...(req.messages || []).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user', content: Array.isArray(m.content) ? m.content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n') : String(m.content || '') })),
        ];
        const base = { operation, provider_key: cred.providerKey, model_key: model, route_key: ctx.routeKey || null, route_version: ctx.routeVersion || null, fallback: 0, prompt_hash: ctx.promptHash || null };
        const t0 = Date.now();
        try {
            const result = await machines.chat({ machine: cred.machine, subject: cred.subject, model, messages, maxTokens: req.maxTokens, temperature: req.temperature, signal: ctx.signal, timeoutMs: Math.max(5000, Math.min(req.timeoutMs || 120000, 300000)) });
            const usage = result.usage;
            const latency = Date.now() - t0;
            if (ctx.logRequest) ctx.logRequest({ ...base, model_key: result.model, status: 'ok', output_hash: sha256(result.text || ''), tokens_in: usage.input, tokens_out: usage.output, tokens_cached: 0, tokens_estimated: 0, cost_usd: 0, latency_ms: latency });
            return { result: { text: result.text, json: null, model: result.model, usage }, provider: cred.providerKey, providerKind: 'node', model: result.model, fallbackUsed: false, usage, cost: 0, latencyMs: latency, synthetic: false, tried: [], startedAt: t0,
                explain: { objective: 'own-machine', reasons: [cred.machine === 'any' ? 'the fastest of the person\'s own machines that answered, by their choice' : 'the person\'s own machine, by their choice'],
                    paid_by: 'your machine',
                    selected: { provider: 'node', machine: result.machine || cred.machine, model: result.model },
                    candidates: (result.tried || []).map((x) => ({ provider: 'node', machine: x.machine, skipped: x.error })),
                    attempts: [{ key: 'your machine', provider: 'node', model: result.model, why: 'your own machine', status: 'ok', error: null }] } };
        } catch (err) {
            if (ctx.logRequest) ctx.logRequest({ ...base, status: 'error', latency_ms: Date.now() - t0, error: String(err && err.message || err).slice(0, 500) });
            if (ctx.signal && ctx.signal.aborted) throw new AiError(409, 'run.cancelled', 'run was cancelled');
            throw err;
        }
    }

    async function executeWithCredential(cred, operation, req, ctx = {}) {
        if (cred.provider === 'node') return await executeOnMachine(cred, operation, req, ctx);
        // Text operations are all chat completions on the person's provider (templated workflows use generate).
        // A project's own provider (ADR-056 secret, ai.complete) passes a Chat Completions request through as written.
        // The OpenAI-format providers: a Chat Completions request is passed through as written (Codes C3: OpenRouter
        // speaks that format too, so a person's OpenRouter key answers it as well).
        const completing = operation === 'complete' && (PROVIDER_KIND[cred.provider] === 'openai' || cred.provider === 'custom');
        // Codes C3: POST /v1/messages on the person's own key. Only a provider that speaks Anthropic's Messages API serves
        // it — Anthropic itself, DeepSeek and MiniMax (their own Anthropic-compatible endpoints) and a custom endpoint.
        const messaging = operation === 'messages';
        const anthropicFormat = PROVIDER_KIND[cred.provider] === 'anthropic' || cred.provider === 'anthropic' || cred.provider === 'custom';
        if (messaging && !anthropicFormat) throw new AiError(422, 'credential.unsupported', `the ${cred.provider} credential does not speak the Messages API`);
        if (!messaging && !completing && !['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich'].includes(operation)) throw new AiError(422, 'credential.unsupported', `a person's own key is used for text only, not ${operation}`);
        const guardedFetch = credentialFetch || require('./guarded-fetch').guardedFetch;
        // The person's model for this role: the run's input.role, else the Live role its route names (live.director).
        const wanted = ctx.role || ((/^live\.(chat|vision|director|summary|legacy)$/.exec(ctx.routeKey || '') || [])[1]) || null;
        const role = wanted && cred.models[wanted] ? wanted : null;
        // On the person's Anthropic key the model the caller asked for is theirs to choose; elsewhere the model they stored
        // is the one their provider serves (a Claude Code model name does not exist at DeepSeek).
        const model = ctx.defaultModel || (messaging
            ? ((cred.provider === 'anthropic' || cred.provider === 'custom') && req.model) || cred.models.chat || CREDENTIAL_DEFAULT_MODEL[cred.provider] || 'claude-haiku-4-5-20251001'
            : (req.image && cred.models.vision) || (role && cred.models[role]) || cred.models.chat || CREDENTIAL_DEFAULT_MODEL[cred.provider] || 'gpt-4o-mini');
        const record = { key: cred.providerKey, kind: cred.provider, base_url: cred.base_url, capabilities: cred.capabilities || ['chat', 'json', 'vision'], timeout_ms: 60000 };
        const a = anthropicFormat ? createAnthropicProvider(record, { apiKey: cred.apiKey, fetchImpl: guardedFetch }) : createOpenAiProvider(record, { apiKey: cred.apiKey, fetchImpl: guardedFetch });
        const base = { operation, provider_key: cred.providerKey, model_key: model, route_key: ctx.routeKey || null, route_version: ctx.routeVersion || null, fallback: 0, prompt_hash: ctx.promptHash || null };
        // An upstream's error text is kept in the request log and the run's error; a provider that echoes the key (in a
        // 401 body, a URL) must not put it there, or in a log line, or in an answer.
        const scrub = (text) => {
            const t = String(text == null ? '' : text);
            return cred.apiKey ? t.split(String(cred.apiKey)).join('[redacted]') : t;
        };
        const paidBy = paidByOf(cred);
        const explain = cred.explain || {
            objective: 'own-key', reasons: ['your own key: no shared provider is called'],
            paid_by: paidBy, selected: `${cred.provider}/${model}`, candidates: [],
            attempts: [{ key: paidBy, provider: cred.provider, model, why: 'your own key', status: 'ok', error: null }],
        };
        const timeoutMs = Math.max(1000, Math.min(req.timeoutMs || 60000, 120000));
        const call = messaging ? a.messages : completing ? a.complete : a.chat;
        let streamed = false;
        const onDelta = (completing || messaging) && typeof req.onDelta === 'function' ? (d) => { streamed = true; req.onDelta(d); } : null;
        let lastErr = null;
        for (let attempt = 0; attempt <= config.providerRetries; attempt++) {
            if (ctx.signal && ctx.signal.aborted) throw new AiError(409, 'run.cancelled', 'run was cancelled');
            const t0 = Date.now();
            try {
                const result = await call({ ...req, ...(onDelta ? { onDelta } : {}), model, signal: ctx.signal, timeoutMs });
                const usage = result.usage || { input: 0, output: 0, cached: 0 };
                const cost = rates.costOfUsage(rates.buildCards({ providerKey: cred.providerKey, model: result.model || model, pricing: config.pricing, flat: false }), usage);
                const latency = Date.now() - t0;
                if (ctx.logRequest) {
                    ctx.logRequest({ ...base, model_key: result.model || model, status: 'ok', output_hash: sha256(result.json || result.text || ''), tokens_in: usage.input || 0, tokens_out: usage.output || 0,
                        tokens_cached: usage.cached || 0, tokens_estimated: usage.estimated ? 1 : 0, cost_usd: cost, latency_ms: latency });
                }
                return { result, provider: cred.providerKey, providerKind: cred.provider, model: result.model || model, fallbackUsed: false, usage, cost, latencyMs: latency, synthetic: false, tried: [],
                    startedAt: t0, explain: { ...explain, selected: `${cred.provider}/${result.model || model}` } };
            } catch (err) {
                lastErr = err;
                if (ctx.signal && ctx.signal.aborted) throw new AiError(409, 'run.cancelled', 'run was cancelled');
                if (ctx.logRequest) ctx.logRequest({ ...base, status: err && err.code === 'provider.timeout' ? 'timeout' : 'error', latency_ms: Date.now() - t0, error: scrub(err && err.message || err).slice(0, 500) });
                // L36 Y8: the provider refused the key (401/403). The key becomes failing and the event says so.
                if (err && (err.status === 401 || err.status === 403) && typeof ctx.onCredentialFailed === 'function') {
                    await ctx.onCredentialFailed({ owner: cred.owner || null, subject: cred.subject || null, provider: cred.provider, providerKey: cred.providerKey, error: scrub(err.message) });
                }
                if (err && err.code === 'EADDRNOTPUBLIC') throw new AiError(422, 'credential.endpoint_refused', scrub(err.message));
                if (streamed) throw new AiError(502, 'provider.stream_broken', `the answer broke off after it began streaming: ${scrub(err && err.message || err).slice(0, 200)}`);
                if (attempt < config.providerRetries && retryable(err)) { await sleep(config.retryDelayMs, ctx.signal).catch(() => {}); continue; }
                break;
            }
        }
        throw new AiError(502, 'credential.provider_failed', `the person's own provider did not answer: ${scrub(lastErr && lastErr.message || lastErr).slice(0, 200)}`);
    }

    /**
     * The offers the routing lists for one operation of one route: the eligible candidates in the
     * order placement would try them, as { provider, model }. GET /api/v1/routes publishes these and
     * a pinned run is accepted only when it names one of them.
     */
    async function offers(route, operation, ctx = {}) {
        const { order, explain } = await candidates(route, [operation], operation, ctx);
        const rank = new Map((order || []).map((c, i) => [offerId(c.provider, c.model || null), i]));
        const out = [];
        const seen = new Set();
        // The order placement would try, including a Bench-tie winner when an opted-in route has evidence.
        for (const c of [...explain.candidates].sort((a, b) => (rank.get(offerId(a.provider, a.model || null)) ?? Infinity) - (rank.get(offerId(b.provider, b.model || null)) ?? Infinity))) {
            if (!c || !c.eligible || !c.provider) continue;
            const id = offerId(c.provider, c.model || null);
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ provider: c.provider, model: c.model || null });
        }
        return out;
    }

    /** The Bench evidence a route used and why, for GET /api/v1/routes/:key and the operator console. */
    async function benchView(route, operation, ctx = {}) {
        if (!bench) return null;
        const { explain } = await candidates(route, [operation], operation, ctx);
        return explain.bench || null;
    }

    /** The providers that could serve this request, for the ai.needs_key answer (L36 Y1). */
    async function servingProviders(route, features, operation, req, selfList = []) {
        const out = new Set();
        const add = (key) => { if (CREDENTIAL_PROVIDERS.includes(key)) out.add(key); };
        const scope = route.constraints && route.constraints.provider_scope;
        if (route.primary && route.primary.provider) {
            for (const c of [route.primary, ...(route.fallbacks || [])]) if (c && c.provider) add(c.provider);
        } else {
            for (const p of await registry.listProviders()) {
                if (p.key === 'stub' || !appOffered({}, p)) continue;
                if (scope === 'local' && !isLocalProvider(p)) continue;
                if (scope === 'paid' && isFreeProvider(p)) continue;
                const caps = await offeredCapabilities(p);
                if (features.some(f => !caps.includes(f))) continue;
                add(p.key);
            }
        }
        for (const c of selfList) if (credentialCanServe(c.provider, operation, req)) add(c.provider);
        // A route whose network providers are all unknown to the credential table still names the console's providers:
        // that is what the person can add under Your AI.
        if (!out.size) for (const id of CREDENTIAL_PROVIDERS) if (credentialCanServe(id, operation, req)) out.add(id);
        return [...out].sort();
    }

    async function execute(route, operation, req, ctx = {}) {
        if (ctx.credential) return await executeWithCredential(ctx.credential, operation, req, ctx);
        const features = [operation];
        if (req.image) features.push('vision');
        if (req.json) features.push('json');
        if (req.openai && Array.isArray(req.openai.tools) && req.openai.tools.length) features.push('tools');
        // L36 Y7: the task, read off the request itself: what it needs, what it wants out, how heavy it is.
        const task = detectTask({ operation, req, ctx, route });
        const tried = [];
        let unreadable = null;   // a candidate could not read the caller's media (whisper's ffmpeg): no other will either
        // A streamed answer (/v1/chat/completions, stream: true) is the caller's once a delta has gone out: a failure
        // after that is final, never retried or handed to a fallback whose words would follow the first one's.
        let streamed = false;
        const onDelta = typeof req.onDelta === 'function' ? (d) => { streamed = true; req.onDelta(d); } : null;
        // L36 Y1: a run on behalf of a person tries the person's OWN keys first, for the providers that can serve the
        // request. With only_my_keys it never falls back; otherwise the network is the fallback and the explain says so.
        const prefs = ctx.selfPreferences || {};
        const selfAttempts = [];
        const selfList = Array.isArray(ctx.selfCredentials) ? ctx.selfCredentials : [];
        if (selfList.length || (ctx.selfSubject && prefs.only_my_keys)) {
            const order = [...selfList].sort((a, b) => {
                const rank = (x) => (x.status === 'failing' ? 2 : x.status === 'untested' ? 1 : 0);
                return rank(a) - rank(b) || String(a.provider).localeCompare(String(b.provider));
            });
            for (const cred of order) {
                if (!credentialCanServe(cred.provider, operation, req)) {
                    selfAttempts.push({ key: paidByOf(cred), provider: cred.provider, model: null, why: 'your own key', status: 'skipped', error: `this key cannot serve ${operation}` });
                    continue;
                }
                const pick = selfModelFor(cred, operation, req, ctx, prefs);
                const key = paidByOf(cred);
                try {
                    const out = await executeWithCredential(cred, operation, req, { ...ctx, defaultModel: pick.model });
                    const attempts = [...selfAttempts, { key, provider: cred.provider, model: pick.model, why: pick.why, status: 'ok', error: null }];
                    return {
                        ...out, fallbackUsed: false,
                        explain: {
                            objective: 'own-keys', reasons: ['your own keys are tried before the network\'s providers'],
                            paid_by: key, selected: `${cred.provider}/${pick.model}`, candidates: [], attempts,
                        },
                    };
                } catch (err) {
                    const detail = String(err && (err.detail || err.message) || err).slice(0, 300);
                    selfAttempts.push({ key, provider: cred.provider, model: pick.model, why: pick.why, status: 'failed', error: detail });
                }
            }
            if (prefs.only_my_keys) {
                const providers = await servingProviders(route, features, operation, req, selfList);
                const names = providers.length ? providers.join(', ') : 'any provider that can serve this request';
                throw new AiError(422, 'ai.needs_key',
                    `only_my_keys is on and none of your keys could serve this request; add a key for ${names} under Your AI`,
                    { providers, paid_by: null, attempts: selfAttempts, explain: { objective: 'own-keys', reasons: ['only_my_keys: no network fallback'], paid_by: null, selected: null, candidates: [], attempts: selfAttempts } });
            }
        }
        let { order: list, explain } = await candidates(route, features, operation, ctx);
        // L36 Y3: free_first puts the free tiers ahead of metered ones for this person's fallback. Own-key attempts above
        // are already free to them, so this only reorders the network.
        if (prefs.free_first && ctx.selfSubject) {
            const free = new Map();
            for (const c of list) {
                if (c.provider === 'stub') { free.set(c.provider, true); continue; }
                const p = await registry.getProvider(c.provider);
                free.set(c.provider, !p || isFreeProvider(p));
            }
            list = [...list].sort((a, b) => Number(free.get(b.provider)) - Number(free.get(a.provider)));
        }
        // L36 Y7: pick for the task. The hard needs first (a model that cannot do the job is never tried), then
        // fit and cost: a light job takes the cheapest capable model, a heavy one the catalogue's strength tier.
        const warmProvider = warm.get(warmSubject(ctx, route), leadingText(req));
        // L36 Y3: with free_first on, the free tiers lead (the price decides); with it off, the strength tier
        // leads and the free tiers are the failover, not the first choice.
        const freeFirst = ctx.selfSubject ? prefs.free_first !== false : true;
        const ranked = await rankCandidates({
            list, explain, task, route, warmProvider,
            preferred: preferredModelFor(prefs, operation, req, ctx),
            ceiling: prefs.price_ceiling_usd_per_mtok,
            tierFirst: task.weight === 'heavy' || !freeFirst,
            // A pinned route keeps its own order: the pin is the admin's decision, not the router's.
            keepOrder: !(route.capability && operation),
        });
        list = ranked.order;
        explain.task = task;
        explain.ranked = ranked.ranked;
        const attempts = [...selfAttempts];
        explain.paid_by = 'openvibe';
        explain.attempts = attempts;
        explain.reasons = [...(explain.reasons || []), ...(selfAttempts.length ? ['your own keys did not answer; the network is the fallback'] : [])];
        // A first-party service's generate run may name one offer from GET /api/v1/routes. The run then
        // tries that offer alone: no fallback to another model, so the caller gets the model it asked for
        // or an explicit failure. server/runs.js validates the pin against this same offer list first.
        if (ctx.routePin && operation === 'generate') {
            const pin = ctx.routePin;
            const chosen = list.find((c) => c.provider === pin.provider && (pin.model == null || c.model === pin.model));
            if (!chosen) {
                throw new AiError(422, 'route.not_offered', `route ${pin.model ? `${pin.provider}/${pin.model}` : pin.provider} is not offered for generate; GET /api/v1/routes?operation=generate lists the offers`);
            }
            list = [chosen];
            explain.reasons = [`pinned to ${chosen.model ? `${chosen.provider}/${chosen.model}` : chosen.provider} for this run`, ...(explain.reasons || [])];
        }
        // L36 Y7: the fallback chain stops after three providers.
        const maxAttempts = (config.routing && config.routing.maxAttempts) || DEFAULT_MAX_ATTEMPTS;
        let attemptsMade = 0;
        for (let i = 0; i < list.length; i++) {
            const c = list[i];
            const entry = await adapter(c.provider);
            const p = entry && entry.record;
            const a = entry && entry.adapter;
            const model = c.model || (p && p.default_model) || null;
            const chosen = ranked.reasons.get(c.provider + ':' + (model || '')) || null;
            const fallback = i > 0;
            const base = { operation, provider_key: c.provider, model_key: model, route_key: ctx.routeKey || null, route_version: ctx.routeVersion || null, fallback: fallback ? 1 : 0, prompt_hash: ctx.promptHash || null, input_hash: ctx.inputHash || null };
            // L36 Y3: a price ceiling caps the network's fallback; the person's own keys are never capped (above).
            if (prefs.price_ceiling_usd_per_mtok != null) {
                const cards = await rateCardsFor(c.provider, model);
                const outputPrice = cards ? Number(rates.pricesOf(cards).out) || 0 : 0;
                if (outputPrice > Number(prefs.price_ceiling_usd_per_mtok)) {
                    const whyPrice = `over_price_ceiling (${outputPrice} > ${prefs.price_ceiling_usd_per_mtok} USD/Mtok)`;
                    statFor(c.provider).skipped++;
                    tried.push({ provider: c.provider, skipped: 'over_price_ceiling' });
                    attempts.push({ key: 'openvibe', provider: c.provider, model, why: chosen || 'the router chose it', status: 'skipped', error: whyPrice });
                    if (ctx.logRequest) ctx.logRequest({ ...base, status: 'skipped', skip_reason: 'over_price_ceiling' });
                    continue;
                }
            }
            const why = await skipReason(p, a, features);
            if (why) {
                statFor(c.provider).skipped++;
                tried.push({ provider: c.provider, skipped: why });
                attempts.push({ key: 'openvibe', provider: c.provider, model, why: chosen || 'the router chose it', status: 'skipped', error: why });
                if (ctx.logRequest) ctx.logRequest({ ...base, status: 'skipped', skip_reason: why });
                continue;
            }
            // L36 Y7: the fallback chain stops after three providers.
            if (attemptsMade >= maxAttempts) break;
            attemptsMade += 1;
            // An image generation outlasts the shared provider's chat timeout (AI_PROVIDER_TIMEOUT_MS): the route's wins. So does a
            // route that says so (options.outlast_provider_timeout: space.build writes a whole app, a minute or two). Otherwise
            // the provider's timeout stays strict, so a slow provider fails over quickly.
            const outlast = operation === 'image' || Boolean(route.options && route.options.outlast_provider_timeout);
            const own = await providerTimeout(p, model);
            const cap = outlast ? Math.max(own, Number(route.timeout_ms) || 0, operation === 'image' ? 600000 : 0) : (own || 600000);
            const timeoutMs = Math.max(1000, Math.min(req.timeoutMs || route.timeout_ms || own || DEFAULT_PROVIDER_TIMEOUT_MS, cap));
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
                    const result = await fn({ ...req, ...(onDelta ? { onDelta } : {}), model, signal: ctx.signal, timeoutMs });
                    if (operation === 'embed' && (!Array.isArray(result.vectors) || result.vectors.length !== req.input.length
                        || result.vectors.some(v => !Array.isArray(v) || !v.length || v.some(n => typeof n !== 'number' || !Number.isFinite(n)))))
                        throw new ProviderError('embedding response has invalid vectors', { code: 'provider.output' });
                    const latency = Date.now() - t0;
                    const usage = result.usage || { input: 0, output: 0, cached: 0 };
                    // An image is metered per image (usage.output = images), and no rate card prices one yet (an owner/T5
                    // item): its cost is 0 rather than the image count read as output tokens on the token cards.
                    const cost = operation === 'image' ? 0 : await costOf(c.provider, result.model || model, usage);
                    statFor(c.provider).ok++;
                    await recordSuccess(c.provider);
                    if (ctx.logRequest) {
                        ctx.logRequest({
                            ...base, model_key: result.model || model, status: 'ok', output_hash: sha256(result.json || result.text || result.vectors || result.segments || result.images || ''),
                            tokens_in: usage.input || 0, tokens_out: usage.output || 0, tokens_cached: usage.cached || 0, tokens_estimated: usage.estimated ? 1 : 0,
                            cost_usd: cost, latency_ms: latency,
                            debug_prompt: ctx.debugRaw ? JSON.stringify({ system: req.system, messages: req.messages }).slice(0, 200000) : null,
                            debug_response: ctx.debugRaw ? String(result.text || '').slice(0, 200000) : null,
                        });
                    }
                    explain.selected = c.provider;
                    explain.paid_by = 'openvibe';
                    attempts.push({ key: 'openvibe', provider: c.provider, model: result.model || model, why: chosen || (fallback ? 'the next network provider after an earlier attempt failed' : 'the first network offer for this route'), status: 'ok', error: null });
                    warm.remember(warmSubject(ctx, route), leadingText(req), c.provider);
                    explain.attempts = attempts;
                    return { result, provider: c.provider, providerKind: p.kind, model: result.model || model, fallbackUsed: fallback || selfAttempts.some(a => a.status !== 'skipped'), usage, cost, latencyMs: latency, synthetic: Boolean(result.synthetic || a.synthetic), tried, startedAt: started, explain };
                } catch (err) {
                    lastErr = err;
                    if (ctx.signal && ctx.signal.aborted) {
                        if (ctx.logRequest) ctx.logRequest({ ...base, status: 'cancelled', latency_ms: Date.now() - t0, error: 'cancelled' });
                        throw new AiError(409, 'run.cancelled', 'run was cancelled');
                    }
                    statFor(c.provider).failures++;
                    if (ctx.logRequest) ctx.logRequest({ ...base, status: err && err.code === 'provider.timeout' ? 'timeout' : 'error', latency_ms: Date.now() - t0, error: String(err && err.message || err).slice(0, 500) });
                    if (streamed) throw new AiError(502, 'provider.stream_broken', `the answer broke off after it began streaming: ${String(err && err.message || err).slice(0, 200)}`, { tried: [...tried, { provider: c.provider, error: String(err && err.message || err).slice(0, 200) }], explain });
                    // A timed-out image may still be generated and billed upstream: never pay for it twice.
                    if (attempt < retries && retryable(err) && !(operation === 'image' && err.code === 'provider.timeout')) { await sleep(config.retryDelayMs + Math.floor(Math.random() * Math.min(700, config.retryDelayMs)), ctx.signal).catch(() => {}); continue; }
                    break;
                }
            }
            // A request the provider rejected as malformed is the caller's fault, not a sign the
            // provider is unhealthy; a 429 is capacity, not health either, and moves on without
            // opening the circuit. Neither must take a shared provider away from other callers.
            if (lastErr && lastErr.code === 'media.unreadable') unreadable = lastErr;
            if (!callerFault(lastErr) && !rateLimited(lastErr)) await recordFailure(c.provider, lastErr);
            tried.push({ provider: c.provider, error: String(lastErr && lastErr.message || lastErr).slice(0, 200) });
            attempts.push({ key: 'openvibe', provider: c.provider, model: lastErr && lastErr.model || model, why: chosen || (fallback ? 'the next network provider after an earlier attempt failed' : 'the first network offer for this route'), status: lastErr && lastErr.code === 'provider.timeout' ? 'timeout' : 'failed', error: String(lastErr && lastErr.message || lastErr).slice(0, 300) });
            log.warn(`[ai] ${operation} via ${c.provider}/${model || '-'} failed: ${lastErr && lastErr.message}`);
        }
        explain.selected = null;
        explain.paid_by = 'openvibe';
        explain.attempts = attempts;
        // The media itself could not be read: no provider will do better, and the caller should hear why (and not
        // retry as if a provider were down).
        if (unreadable) {
            explain.reasons = [...(explain.reasons || []), 'the media could not be read'];
            throw new AiError(422, 'media.unreadable', String(unreadable.message || 'the media could not be read').slice(0, 300), { tried, explain });
        }
        explain.reasons = [...(explain.reasons || []), 'no provider on this route could answer'];
        throw new AiError(503, 'provider.unavailable', 'no provider on this route could answer', { tried, explain });
    }

    return { adapter, health, resetHealth, execute, executeWithCredential, offers, benchView, priceFor, costOf, rateCardsFor, providerStates, stats, statFor, candidates };
}

module.exports = { createProviderPool };
