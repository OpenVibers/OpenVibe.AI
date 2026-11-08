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
 * after that one half-open probe decides whether it closes again. A provider's own "insufficient balance"
 * answer opens it at once for the long exhausted cooldown, is never retried, and the router fails over.
 * When nothing can serve because offers are exhausted or paused, the route answers 503 ai.resting with a
 * human sentence and Retry-After. The host's local model is a last offer for short text only, one request at
 * a time, labelled local on the receipt.
 */
const placement = require('openvibe-sdk/placement');
const contracts = require('openvibe-contracts');
const { AiError, providerSecret, sha256 } = require('../util');
const { retryable, sleep, ProviderError, schemaInstruction, insufficientBalance } = require('./common');
const { sourcesOf, ceilingOf, allowsProvider, allowsCommunity } = require('../free-tier');
const { createStubProvider } = require('./stub');
const { createOpenAiProvider } = require('./openai');
const { createResponsesProvider } = require('./responses');
const { createAnthropicProvider } = require('./anthropic');
const { createGeminiProvider } = require('./gemini');
const { createHttpSeamProvider } = require('./http');
const { createWhisperProvider } = require('./whisper');
const rates = require('./rate-cards');
const tiers = require('./tiers');
const latency = require('../latency');
const { detectTask, capabilitiesOf, hardNeeds, rank, reasonFor, workKind, leadingText, preferredTarget, preferMatches } = require('./task');
const modelCatalog = require('./model-catalog');
const { createWarmCache } = require('./warm-cache');
const { createProviderMetrics } = require('./metrics');
const { createVariantEvidence } = require('./bench-variant');
const { createRoutingEvidence } = require('./evidence');
const exchangeConstraints = require('../exchange/constraints');
const exchangePrivacy = require('../exchange/privacy');
const floor = require('../policy/floor');
const tier = require('../policy/tier');

/** Is this offer allowed under the request's content policy? Standard never runs an uncensored offer; the adult tier runs nothing else. */
async function policyAllows(registry, provider, modelId, policy = 'standard') {
    if (!provider) return false;
    const row = modelId ? await registry.getModel(provider.key, modelId) : null;
    const offerUncensored = tier.offerIsUncensored(provider, row);
    return policy === 'uncensored' ? offerUncensored : !offerUncensored;
}

/** 4xx that the request itself caused (bad image, schema, max_tokens...), as opposed to auth, rate or availability. */
function callerFault(err) {
    const st = err && err.status;
    // 402 payment required is the provider's account, not the caller's request: it opens the circuit (exhausted).
    return Number.isInteger(st) && st >= 400 && st < 500 && ![401, 402, 403, 404, 408, 429].includes(st);
}

/** An upstream 429 is rate-limit capacity, not provider ill health: it shifts to the next candidate but must not open the circuit. */
function rateLimited(err) {
    return (err && err.status === 429) || (err && err.code === 'provider.rate_limited');
}

/**
 * The hard floor on a streamed answer (server/policy/floor.js). The text is checked as it grows, before each chunk
 * goes out: a chunk that makes the answer break the floor is never delivered, and the stream stops with
 * `policy.floor_refused`. (Text already delivered cannot be recalled; the check is per chunk and over the whole
 * answer so far, including tool-call arguments.)
 */
function createFloorGuard(emit, { hold = 0 } = {}) {
    let all = '';           // the whole answer so far: the floor checks this, never only the held tail
    let held = '';          // the text not yet delivered (hold characters, or nothing)
    let args = '';
    const queued = [];       // { d, text } in arrival order; text is the content the delta carries
    const refuse = (r) => Object.assign(new Error(r.detail), { code: 'policy.floor_refused', status: 403, detail: r.detail, rule: r.rule });
    const checkNow = () => {
        const r = floor.checkAnswer([all, args].filter(Boolean));
        if (!r.ok) throw refuse(r);
    };
    function flush(final) {
        while (queued.length && (final || held.length > hold)) {
            const head = queued[0];
            const over = held.length - hold;
            if (head.text.length && !final && head.text.length > over) {
                // Split the delta: deliver only what is outside the held tail.
                const cut = head.text.length - over;
                emit({ ...head.d, delta: { ...head.d.delta, content: head.text.slice(0, cut) } });
                head.text = head.text.slice(cut);
                held = held.slice(cut);
                return;
            }
            queued.shift();
            held = held.slice(head.text.length);
            emit(head.text && head.d && head.d.delta ? { ...head.d, delta: { ...head.d.delta, content: head.text } } : head.d);
        }
    }
    return {
        push(d) {
            if (!d || typeof d !== 'object') return;
            const content = d.delta && typeof d.delta.content === 'string' ? d.delta.content : '';
            if (content) { all += content; held += content; }
            for (const t of (d.delta && d.delta.tool_calls) || []) {
                if (t && t.function && t.function.arguments) args += String(t.function.arguments);
            }
            checkNow();
            queued.push({ d, text: content });
            flush(false);
        },
        finish() {
            checkNow();
            flush(true);
        },
        get text() { return all; },
    };
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
/**
 * A Chat Completions conversation in the shape bot.command@1's ai command takes (contracts 0.277.0): roles system, user,
 * assistant and tool; text only (a picture part is left out); an assistant's tool calls and a tool message's call id
 * kept. At most 200 messages: the first two (the instructions and the task) and the newest, never starting the newest
 * part on a tool result whose call was left out.
 */
const MACHINE_MAX_MESSAGES = 200;
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
function machineMessages(list) {
    const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p && p.type === 'text').map((p) => String(p.text || '')).join('\n') : '').slice(0, 65536);
    let out = (Array.isArray(list) ? list : []).filter((m) => m && typeof m === 'object').map((m) => {
        const role = ['system', 'user', 'assistant', 'tool'].includes(m.role) ? m.role : m.role === 'developer' ? 'system' : 'user';
        const one = { role, content: text(m.content) };
        if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            one.tool_calls = m.tool_calls.slice(0, 32).map((c, i) => {
                const fn = (c && c.function) || {};
                return { id: String((c && c.id) || `call_${i + 1}`).slice(0, 200), type: 'function', function: { name: String(fn.name || ''), arguments: typeof fn.arguments === 'string' ? fn.arguments.slice(0, 65536) : JSON.stringify(fn.arguments || {}) } };
            });
        }
        if (role === 'tool') one.tool_call_id = String(m.tool_call_id || 'call_1').slice(0, 200);
        return one;
    });
    if (out.length > MACHINE_MAX_MESSAGES) {
        let tail = out.slice(-(MACHINE_MAX_MESSAGES - 2));
        while (tail.length && tail[0].role === 'tool') tail = tail.slice(1);
        out = [...out.slice(0, 2), ...tail];
    }
    return out;
}
/** The tools as the machine takes them: function tools with a plain name, at most 64; null when there are none. */
function machineTools(tools) {
    const out = (Array.isArray(tools) ? tools : [])
        .filter((t) => t && t.type === 'function' && t.function && TOOL_NAME_RE.test(String(t.function.name || '')))
        .slice(0, 64)
        .map((t) => ({ type: 'function', function: { name: t.function.name, ...(typeof t.function.description === 'string' ? { description: t.function.description.slice(0, 4096) } : {}), ...(t.function.parameters && typeof t.function.parameters === 'object' ? { parameters: t.function.parameters } : {}) } }));
    return out.length ? out : null;
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
/**
 * The Live role a route names, so a person's own key answers with the model they stored for that role.
 *
 * The background routes (BA1) carry the role too: the AI viewers director plan runs in the background, but a
 * person who gave their key a director model still wants that model to write it.
 */
const ROLE_ROUTE = /^(?:live|background)\.(chat|vision|director|summary|legacy)$/;
const roleOfRoute = (routeKey) => (ROLE_ROUTE.exec(String(routeKey || '')) || [])[1] || null;

function selfModelFor(cred, operation, req, ctx, prefs) {
    const kind = workKind(operation, req, ctx);
    const choice = prefs && prefs.defaults ? prefs.defaults[kind] : 'auto';
    const stored = cred.models || {};
    const role = ctx.role || roleOfRoute(ctx.routeKey);
    const model = (choice && choice !== 'auto') ? choice
        : (req.image && stored.vision) || (role && stored[role]) || stored[kind] || stored.chat
            || CREDENTIAL_DEFAULT_MODEL[cred.provider] || 'gpt-4o-mini';
    const why = choice && choice !== 'auto' ? `your default ${kind} model` : (stored[kind] || stored.chat ? 'the model you stored for this key' : "the provider's default");
    return { model, kind, why };
}

function createProviderPool({ db, registry, config, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, env = process.env, log = console, credentialFetch = null, machineModels = null, community = null, bench = null, variantEvidence = null, adultStatus = null, offPeak = null }) {
    // A person's own machine as their model (credential provider node, server/machines.js).
    const machines = machineModels || require('../machines').createMachineModels({ config, env, fetchImpl });
    const cache = new Map();          // key -> { stamp, adapter }
    const stats = {};                 // key -> { calls, failures, ... } (in memory; tests + /api/ready)
    // One local generation at a time (AI_LOCAL_LLM_CONCURRENCY, default 1): the host's model shares its CPU
    // with live streams, so a paid outage must not turn into a local-model stampede.
    const localLimit = Math.max(1, (config.localLlm && config.localLlm.concurrency) || 1);
    let localActive = 0;
    const exhaustedCooldownMs = () => Math.max(60000, Number(config.breaker.exhaustedCooldownMs) || 10 * 60000);
    // L36 Y7: the provider that last answered this prompt, for five minutes (server/providers/warm-cache.js).
    const warm = createWarmCache({ now: () => clock.now() });
    // AI Exchange P7: measured per-deployment evidence for alias routing. The feature flag is read live (D11
    // owner settings), so turning routing_evidence on or off in the config store needs no restart; while it is off
    // no metrics are written and no order changes.
    const routingEvidence = createRoutingEvidence({
        db, config, clock, log,
        metrics: createProviderMetrics({ db, clock, alpha: () => (config.routingEvidence && config.routingEvidence.alpha) }),
        bench: variantEvidence || createVariantEvidence({ config, fetchImpl, clock, log }),
        resolveOffer: async (c) => {
            const entry = await adapter(c.provider);
            const p = entry && entry.record;
            if (!p) return null;
            const model = c.model || p.default_model || null;
            const row = model ? await registry.getModel(p.key, model) : null;
            const artifact = row ? modelCatalog.artifactOf(row, p) : null;
            return {
                id: offerId(p.key, model), provider: p.key, model,
                exactId: artifact ? artifact.id : null,
                access: modelCatalog.accessOf(p),
                free: isFreeProvider(p),
                retail: row ? modelCatalog.retailRate(row) : null,
                cards: isFreeProvider(p) ? null : await rateCardsFor(p.key, model),
            };
        },
    });
    /** Evidence writes must never fail a run: a metrics problem is logged and routing continues. */
    async function recordEvidence(attempt) {
        if (!routingEvidence || !routingEvidence.enabled()) return;
        try { await routingEvidence.record(attempt); } catch (err) { log.warn(`[routing-evidence] ${String(err && err.message || err).slice(0, 200)}`); }
    }

    function statFor(key) { return stats[key] || (stats[key] = { calls: 0, ok: 0, failures: 0, skipped: 0 }); }

    function build(p) {
        const apiKey = providerSecret(p, env);
        switch (p.kind) {
            case 'stub': return createStubProvider(p, { stats: statFor(p.key) });
            case 'openai': return createOpenAiProvider(p, { apiKey, fetchImpl });
            case 'responses': return createResponsesProvider(p, { apiKey, fetchImpl });
            case 'anthropic': return createAnthropicProvider(p, { apiKey, fetchImpl });
            case 'gemini': return createGeminiProvider(p, { apiKey, fetchImpl });
            case 'http': return createHttpSeamProvider(p, { apiKey, fetchImpl });
            case 'whisper': return createWhisperProvider(p, { config });
            default: throw new Error(`unknown provider kind ${p.kind}`);
        }
    }

    async function adapter(key) {
        const p = await registry.getProvider(key);
        if (!p) return null;
        const stamp = `${p.updated_at}|${p.secret_ref}|${providerSecret(p, env) ? 1 : 0}`;
        const hit = await cache.get(key);
        if (hit && hit.stamp === stamp) return { record: p, adapter: hit.adapter };
        const a = build(p);
        cache.set(key, { stamp, adapter: a });
        return { record: p, adapter: a };
    }

    // ── Circuit breaker ────────────────────────────────────
    const getHealth = db.prepare('SELECT * FROM provider_health WHERE provider_key = ?');
    const putHealth = db.prepare(`INSERT INTO provider_health (provider_key, state, consecutive_failures, opened_at, exhausted_at, last_error, last_success_at, last_failure_at)
        VALUES (@provider_key, @state, @consecutive_failures, @opened_at, @exhausted_at, @last_error, @last_success_at, @last_failure_at)
        ON CONFLICT(provider_key) DO UPDATE SET state = excluded.state, consecutive_failures = excluded.consecutive_failures, opened_at = excluded.opened_at,
          exhausted_at = excluded.exhausted_at, last_error = excluded.last_error, last_success_at = excluded.last_success_at, last_failure_at = excluded.last_failure_at`);
    async function health(key) {
        const h = await getHealth.get(key) || { provider_key: key, state: 'closed', consecutive_failures: 0, opened_at: null, exhausted_at: null, last_error: null, last_success_at: null, last_failure_at: null };
        if (h.state === 'open') {
            // Out of balance: a long cooldown (10 minutes), so every request shares the same pause instead of each
            // one retrying a provider that cannot answer until someone tops it up.
            const cooldown = h.exhausted_at ? exhaustedCooldownMs() : config.breaker.cooldownMs;
            if (clock.now() - (h.opened_at || 0) >= cooldown) return { ...h, state: 'half_open' };
        }
        return h;
    }
    async function recordSuccess(key) {
        const h = await health(key);
        if (h.state !== 'closed') await registry.audit('system', 'provider.circuit_closed', 'provider', key, { metadata: { after_failures: h.consecutive_failures } });
        await putHealth.run({ ...h, provider_key: key, state: 'closed', consecutive_failures: 0, opened_at: null, exhausted_at: null, last_success_at: clock.now() });
    }
    async function recordFailure(key, err) {
        const h = await health(key);
        const failures = (h.consecutive_failures || 0) + 1;
        const exhausted = insufficientBalance(err);
        // A balance answer opens the circuit at once (it will not recover on its own), not after failureThreshold.
        const open = exhausted || h.state === 'half_open' || failures >= config.breaker.failureThreshold;
        if (open && h.state !== 'open') await registry.audit('system', 'provider.circuit_opened', 'provider', key, { metadata: { failures, exhausted, error: String(err && err.message || err).slice(0, 200) } });
        await putHealth.run({ ...h, provider_key: key, state: open ? 'open' : 'closed', consecutive_failures: failures,
            opened_at: open ? clock.now() : h.opened_at, exhausted_at: exhausted ? clock.now() : (h.exhausted_at || null),
            last_error: String(err && err.message || err).slice(0, 500), last_failure_at: clock.now() });
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

    // ── The tier a run is priced on (BA1) ────────────────────────────
    /**
     * The order a run that may wait tries its candidates in: the host's own model first, when it is idle
     * and the route's quality allows it.
     *
     * The quality gate: a route that names its model (constraints.model) keeps that model — a small local
     * model never answers work whose route says which model it wants (The Rundown is written by the creative
     * model, never by the host's llama.cpp). The authority is the network's choice of provider, not a demand
     * for a model: the host's own model may still answer first, because it costs the network nothing. The
     * local model serves short text only (localCanServe), and the attempt loop skips it when the host's one
     * local slot is busy, so a paid outage never turns into a stampede and a busy host never waits for it.
     */
    async function orderForWaiting(list, { route, operation, req }) {
        const c = (route && route.constraints) || {};
        if (c.model) return list;
        // Opt-in per route (Opus, 11-07): the host's small model writes only where a route says its output may come
        // from one. Without the flag the router's own order stands, so no visible text changes quality.
        if (c.allow_local !== true) return list;
        if (!localCanServe(route, operation, req)) return list;
        const local = [];
        const rest = [];
        for (const candidate of list) {
            const p = await registry.getProvider(candidate.provider);
            if (p && isLocalModel(p)) local.push(candidate);
            else rest.push(candidate);
        }
        return local.length ? [...local, ...rest] : list;
    }

    /**
     * The tier one candidate may run on, for a run that may wait:
     *
     *   local     the host's own model: capacity the network already pays for;
     *   flex      a provider that publishes a Flex tier (OpenAI, DeepInfra): slower, cheaper;
     *   offpeak   a provider whose own price is lower right now (DeepSeek's off-peak hours);
     *   standard  everything else.
     *
     * The tier is what the run is priced on, so it is only ever a tier the provider actually sells: a
     * provider with no Flex multiplier and no off-peak price is a standard run.
     */
    async function tierFor({ p, model, operation, at }) {
        if (!p) return 'standard';
        if (isLocalModel(p)) return 'local';
        if (tiers.TIERED_OPS.has(operation) && tiers.multiplierOf(p, 'flex') != null) return 'flex';
        if (offPeak && model) {
            const off = await offPeak.priceAt(p.key, model, at);
            if (off && (off.input != null || off.output != null)) return 'offpeak';
        }
        return 'standard';
    }

    /**
     * The cost of one call on the tier it really ran on, and what the wait earned: the standard price
     * minus the real one.
     *
     * A tier nobody priced is priced at the standard rate. The network never claims a saving it cannot
     * see: a provider that does not say which tier it served is priced at the list price.
     */
    async function costOnTier({ providerKey, model, usage, tier, p }) {
        const cards = await rateCardsFor(providerKey, model);
        if (!cards) return { cost: 0, standard: 0, saved: 0 };
        const standard = rates.costOfUsage(cards, usage);
        if (tier === 'standard' || tier === 'local') return { cost: standard, standard, saved: 0 };
        if (tier === 'offpeak') {
            const off = offPeak ? await offPeak.priceAt(providerKey, model, clock.now()) : null;
            if (!off) return { cost: standard, standard, saved: 0 };
            // The provider's own off-peak price, and only where it is lower than the card's price.
            const cheaper = (card, price) => (price == null || price > card.unit_price_usd ? card : { ...card, unit_price_usd: price });
            const offCards = { in: cheaper(cards.in, off.input), cached: cheaper(cards.cached, off.cached_read), out: cheaper(cards.out, off.output), cache_write: cards.cache_write };
            const cost = rates.costOfUsage(offCards, usage);
            return { cost, standard, saved: Math.max(0, standard - cost) };
        }
        const multiplier = tiers.multiplierOf(p, tier);
        if (multiplier == null) return { cost: standard, standard, saved: 0 };
        const tierCards = rates.cardsForTier(cards, { multiplier, tier });
        const cost = rates.costOfUsage(tierCards, usage);
        return { cost, standard, saved: Math.max(0, standard - cost) };
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
    /** The host's text model (local / local2), not its local speech-to-text: the caps below are for text generation. */
    function isLocalModel(p) {
        return Boolean(p.metadata && p.metadata.local);
    }
    /**
     * What the host's local model is offered: short text only (summaries, titles, moderation hints, a chat line),
     * never code or long reasoning. Routes that write whole apps or wiki pages (max_output_tokens well over a chat
     * answer, or outlast_provider_timeout), and an OpenAI completion carrying tools (an agent's loop), are not for
     * it; embeddings are small and stay welcome, and speech-to-text is a different local provider.
     */
    function localCanServe(route, operation, req = null) {
        if (operation === 'embed' || operation === 'transcribe') return true;
        if (!['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'complete', 'messages'].includes(operation)) return false;
        // A request carrying tools is an agent's loop, not a short chat answer.
        if (operation === 'complete' && req && req.openai && Array.isArray(req.openai.tools) && req.openai.tools.length) return false;
        if (operation === 'messages' && req && Array.isArray(req.tools) && req.tools.length) return false;
        if (route && route.options && route.options.outlast_provider_timeout) return false;
        // The answer this request actually asked for decides (engine.js puts input.max_tokens on req); a route's own
        // cap is the fallback. Over 800 tokens is long reasoning, not a short text answer.
        const wanted = Number(req && req.maxTokens);
        if (Number.isFinite(wanted)) return wanted <= 800;
        const max = Number(route && route.max_output_tokens);
        return !Number.isFinite(max) || max <= 800;
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
    /**
     * AI Exchange D3: may the network route paid, managed work to this offer? With the catalog flag on, only an
     * owned deployment or an authorized wholesale agreement may be resold; UNVERIFIED (the default), RESTRICTED and
     * CUSTOMER_BYOK offers stay out of the pool. A person's own key and their own machine never pass through here.
     */
    function accessOffered(p) {
        if (!(config.modelCatalog && config.modelCatalog.enabled)) return true;
        return Boolean(p) && modelCatalog.managedAccessAllowed(p);
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
        const accessExcluded = [];
        // A dynamic policy alias (D3) looks at every active chat/vision model the provider registered, not only its
        // default; the placement and the task router then choose among them. Auto keeps today's one-offer-per-provider.
        const expandModels = Boolean(ctx.aliasPolicy && ctx.aliasPolicy !== 'auto') && !(route.constraints && route.constraints.model);
        const addOffer = async (p, model, caps) => {
            const id = offerId(p.key, model);
            if (seen.has(id)) return;
            // The private objective means first-party capacity only; operator-paid public APIs never receive it.
            if ((ctx.aliasPolicy === 'private' || (route.constraints && route.constraints.objective === 'private')) && p.kind === 'anthropic') {
                accessExcluded.push({ provider: p.key, model, eligible: false, excluded_reason: 'private requests use first-party capacity only', cost: null, latency: null });
                return;
            }
            // The content policy narrows the pool before placement: an uncensored offer never answers a standard
            // request, and the adult tier has no other offer to run on.
            if (!(await policyAllows(registry, p, model, ctx.contentPolicy || 'standard'))) return;
            seen.add(id);
            const creds = p.auth_mode === 'none' || credentialNotRequired(p) || Boolean(providerSecret(p, env));
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
            if (!accessOffered(p)) {
                accessExcluded.push({ provider: p.key, model: (route.constraints && route.constraints.model) || p.default_model || null, eligible: false,
                    excluded_reason: `provider_access ${modelCatalog.accessOf(p)}`, cost: null, latency: null });
                continue;
            }
            if (MODEL_TYPE[operation]) {
                // A chat model advertised by an OpenAI-shaped provider is not an embedding, STT or image model.
                const type = MODEL_TYPE[operation];
                for (const m of await registry.listModels({ provider: p.key })) {
                    if (m.type === type && m.status === 'active') await addOffer(p, m.model_key, caps);
                }
            } else if (expandModels) {
                const models = (await registry.listModels({ provider: p.key })).filter((m) => m.status === 'active' && (m.type === 'chat' || m.type === 'vision'));
                if (models.length) for (const m of models) await addOffer(p, m.model_key, caps);
                else await addOffer(p, p.default_model || null, caps);
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
            if (!accessOffered(p)) {
                accessExcluded.push({ provider: p.key, model: pin.model || p.default_model || null, eligible: false,
                    excluded_reason: `provider_access ${modelCatalog.accessOf(p)}`, cost: null, latency: null });
                continue;
            }
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
        // An offer the commercial gate kept out is named with its reason, never silently missing from the explain.
        for (const x of accessExcluded) if (!explain.candidates.some((c) => c.provider === x.provider && c.model === x.model)) explain.candidates.push(x);
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
            const modelId = c.model || (p && p.default_model) || null;
            const why = await skipReason(p, entry && entry.adapter, features);
            const offered = appOffered(ctx, p);
            const access = accessOffered(p);
            const policyOk = p ? await policyAllows(registry, p, modelId, ctx.contentPolicy || 'standard') : false;
            const excluded = !policyOk ? 'content_policy'
                : !offered ? (p && billingProfile(p) === 'byok' ? 'byok' : 'free_only')
                : !access ? `provider_access ${modelCatalog.accessOf(p)}` : why;
            explain.candidates.push({
                provider: c.provider, model: modelId, eligible: offered && access && policyOk && !why,
                excluded_reason: excluded, cost: null, latency: null,
            });
            if (offered && access && policyOk) order.push({ provider: c.provider, model: c.model || null });
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
        if (config.stubFallback && (ctx.contentPolicy || 'standard') !== 'uncensored'
            && (!(route.constraints && route.constraints.provider_scope) || operation === 'image')
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

    /**
     * What a routing preset's rules need to know about one offer (server/exchange/constraints.js): its price, the
     * catalogue's tier, its quantization, the region it runs in and its privacy class. Everything is read from the
     * catalogue, the rate cards and the provider's own record: nothing is guessed.
     */
    async function constraintFacts(c) {
        const d = await describeCandidate(c);
        const meta = (d.row && d.row.metadata) || {};
        const artifact = d.row ? modelCatalog.artifactOf(d.row, d.record) : null;
        const declared = exchangePrivacy.dataPolicyOf(d.record);
        const region = (declared && declared.region)
            || (d.record && d.record.metadata && d.record.metadata.region) || null;
        return {
            priceIn: d.priceIn, priceOut: d.priceOut,
            tier: d.caps.tier || 'balanced',
            quant: (artifact && artifact.quant) || meta.quant || null,
            region,
            privacy: exchangePrivacy.labelFor({ record: d.record }),
        };
    }

    /**
     * What the catalogue knows about the model a caller asked for (L37): the provider, and what the model can do.
     * A model the catalogue never described is not refused: the provider decides.
     */
    async function preferredModel(provider, model, task) {
        const entry = provider ? await adapter(provider) : null;
        const p = entry && entry.record;
        const row = model ? await registry.getModel(provider, model) : null;
        const caps = capabilitiesOf(row, p);
        return { known: Boolean(entry), provider, model, caps, missing: hardNeeds(caps, task) };
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
    async function rankCandidates({ list, explain, task, route = null, warmProvider = null, preferred = null, ceiling = null, tierFirst = null, keepOrder = false, policy = null }) {
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
            : rank(entries, { task, warm: warmProvider, preferred, authority, tierFirst, policy });
        const order = keepOrder ? ranked.order : [...ranked.order.map((e) => ({ provider: e.provider, model: e.model })), ...rest];
        if (stub) order.push(stub);
        const view = ranked.ranked.map((e) => ({ provider: e.provider, model: e.model, why: reasonFor(e, task), cost: Number.isFinite(e.price) ? e.price : null, tier: e.tier }));
        const reasons = new Map(ranked.order.map((e) => [e.provider + ':' + (e.model || ''), reasonFor(e, task)]));
        return { order, ranked: view, reasons, keepOrder };
    }

    async function skipReason(p, a, features) {
        if (!p || !a) return 'unknown_provider';
        if (p.status !== 'active') return 'disabled';
        if (p.auth_mode !== 'none' && !credentialNotRequired(p) && !providerSecret(p, env)) return 'no_credentials';
        if (features.some(f => !a.supports(f))) return 'unsupported';
        const h = await health(p.key);
        if (h.state === 'open') return h.exhausted_at ? 'exhausted' : 'circuit_open';
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
     * The OpenAI-compatible endpoint (operation complete, plan L55 C3) passes its tools and the calls already made, so an
     * agent's loop (Actor) runs on the person's own model; the machine's answer becomes the completion's one choice.
     */
    async function executeOnMachine(cred, operation, req, ctx = {}) {
        const completing = operation === 'complete';
        if (!completing && !['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich'].includes(operation)) throw new AiError(422, 'credential.unsupported', `a person's own machine answers text only, not ${operation}`);
        if (req.image) throw new AiError(422, 'credential.unsupported', 'a person\'s own machine reads no pictures yet');
        const wanted = ctx.role || roleOfRoute(ctx.routeKey);
        const model = (wanted && cred.models[wanted]) || cred.models.chat;
        if (!model) throw new AiError(422, 'credential.no_model', 'the person\'s own machine credential names no model (models.chat)');
        const sysText = [...(req.system || []).map((x) => x.text), req.json ? schemaInstruction(req.json) : ''].filter(Boolean).join('\n\n');
        const o = completing ? (req.openai || {}) : null;
        const messages = completing ? machineMessages(o.messages) : [
            ...(sysText ? [{ role: 'system', content: sysText }] : []),
            ...(req.messages || []).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user', content: Array.isArray(m.content) ? m.content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n') : String(m.content || '') })),
        ];
        const tools = completing ? machineTools(o.tools) : null;
        const base = { operation, provider_key: cred.providerKey, model_key: model, route_key: ctx.routeKey || null, route_version: ctx.routeVersion || null, fallback: 0, prompt_hash: ctx.promptHash || null };
        // A person's own machine is their own capacity: CUSTOMER_BYOK, never a managed resale.
        const ownFacts = { resolved_model: `${cred.provider}/${model}`, revision: null, deployment: cred.providerKey, provider_access: 'CUSTOMER_BYOK', rate_version: null, policy: 'byok', fallback_reason: null };
        if (typeof ctx.onRoute === 'function') await ctx.onRoute(ownFacts);
        const t0 = Date.now();
        try {
            const result = await machines.chat({ machine: cred.machine, subject: cred.subject, model, messages, maxTokens: req.maxTokens, temperature: req.temperature, signal: ctx.signal, timeoutMs: Math.max(5000, Math.min(req.timeoutMs || 120000, 300000)),
                ...(tools ? { tools, toolChoice: o.tool_choice === 'none' ? 'none' : 'auto' } : {}) });
            const usage = result.usage;
            const latency = Date.now() - t0;
            if (ctx.logRequest) ctx.logRequest({ ...base, model_key: result.model, status: 'ok', output_hash: sha256(result.text || ''), tokens_in: usage.input, tokens_out: usage.output, tokens_cached: 0, tokens_estimated: 0, cost_usd: 0, latency_ms: latency });
            const message = result.message || { role: 'assistant', content: result.text };
            const out = completing
                ? { completion: { choices: [{ index: 0, message, finish_reason: result.finish || (message.tool_calls ? 'tool_calls' : 'stop') }], system_fingerprint: null }, text: result.text, json: null, model: result.model, usage }
                : { text: result.text, json: null, model: result.model, usage };
            return { result: out, provider: cred.providerKey, providerKind: 'node', model: result.model, fallbackUsed: false, usage, cost: 0, latencyMs: latency, synthetic: false, tried: [], startedAt: t0,
                explain: { objective: 'own-machine', reasons: [cred.machine === 'any' ? 'the fastest of the person\'s own machines that answered, by their choice' : 'the person\'s own machine, by their choice'],
                    paid_by: 'your machine',
                    selected: { provider: 'node', machine: result.machine || cred.machine, model: result.model },
                    candidates: (result.tried || []).map((x) => ({ provider: 'node', machine: x.machine, skipped: x.error })),
                    attempts: [{ key: 'your machine', provider: 'node', model: result.model, why: 'your own machine', status: 'ok', error: null }],
                    openvibe: ownFacts } };
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
        const wanted = ctx.role || roleOfRoute(ctx.routeKey);
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
        // The person's own key (BYOK) is never a managed resale offer: the disclosure says CUSTOMER_BYOK.
        const ownFacts = { resolved_model: `${cred.provider}/${model}`, revision: null, deployment: cred.providerKey, provider_access: 'CUSTOMER_BYOK', rate_version: null, policy: 'byok', fallback_reason: null };
        const call = messaging ? a.messages : completing ? a.complete : a.chat;
        let streamed = false;
        const onDelta = (completing || messaging) && typeof req.onDelta === 'function' ? (d) => { streamed = true; req.onDelta(d); } : null;
        let lastErr = null;
        for (let attempt = 0; attempt <= config.providerRetries; attempt++) {
            if (ctx.signal && ctx.signal.aborted) throw new AiError(409, 'run.cancelled', 'run was cancelled');
            if (typeof ctx.onRoute === 'function') await ctx.onRoute(ownFacts);
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
                    startedAt: t0, explain: { ...explain, selected: `${cred.provider}/${result.model || model}`, openvibe: ownFacts } };
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
        const contentPolicy = ctx.contentPolicy || 'standard';
        const refuseFloor = (r) => new AiError(403, 'policy.floor_refused', r.detail, { rule: r.rule, policy: contentPolicy });
        if (ctx.credential) {
            // A person's own key is not an offer marked uncensored, and the adult tier is network supply only. The
            // hard floor still holds: it is about the request and the answer, not about who pays.
            if (contentPolicy === 'uncensored') throw new AiError(403, 'policy.uncensored_refused', 'the adult tier is served by network offers only; a personal key cannot answer it');
            const asked = floor.checkRequest(req);
            if (!asked.ok) throw refuseFloor(asked);
            const out = await executeWithCredential(ctx.credential, operation, req, ctx);
            const answer = floor.checkResult(out.result);
            if (!answer.ok) throw refuseFloor(answer);
            return out;
        }
        const features = [operation];
        if (req.image) features.push('vision');
        if (req.json) features.push('json');
        if (req.openai && Array.isArray(req.openai.tools) && req.openai.tools.length) features.push('tools');
        // The Exchange remake's content policy: standard (every request) or uncensored (18+ accounts only, uncensored
        // offers only). The 18+ answer comes from Network (server/policy/adult-status.js), never from the caller.
        const admission = await tier.admit({
            policy: contentPolicy,
            appRun: Boolean(ctx.appRun),
            subject: ctx.onBehalfOf ? { type: 'user', id: String(ctx.onBehalfOf) } : null,
            adultFor: adultStatus ? (id) => adultStatus.adultFor(id) : null,
        });
        if (!admission.ok) throw new AiError(admission.status, admission.code, admission.detail, { policy: contentPolicy });
        const uncensored = admission.uncensored;
        if (uncensored && !['chat', 'complete', 'messages'].includes(operation)) {
            throw new AiError(422, 'input.invalid', `the uncensored policy is for chat answers, not ${operation}`);
        }
        // The hard floor holds on every offer, uncensored or not: the request is refused before a provider is called.
        const floorIn = floor.checkRequest(req);
        if (!floorIn.ok) throw refuseFloor(floorIn);
        // L36 Y7: the task, read off the request itself: what it needs, what it wants out, how heavy it is.
        const task = detectTask({ operation, req, ctx, route });
        // L37: a soft preference. The caller names a provider (and a model if it wants one). It never disables the
        // person's own keys, never overrides only_my_keys, never beats the price ceiling, and never forces a model
        // that fails a hard need. An unknown id is ignored, never an error.
        const prefer = preferredTarget(req.prefer);
        const preferState = prefer ? { provider: prefer.provider, model: prefer.model, honoured: false, why: '' } : null;
        const tried = [];
        let unreadable = null;   // a candidate could not read the caller's media (whisper's ffmpeg): no other will either
        let resting = false;     // a paid provider is out of balance, or every remaining offer is paused: answer ai.resting

        // A streamed answer (/v1/chat/completions, stream: true) is the caller's once a delta has gone out: a failure
        // after that is final, never retried or handed to a fallback whose words would follow the first one's.
        let streamed = false;
        // L40: the time to the first token, when the answer streams.
        let attemptStart = 0;
        let ttftMs = null;
        const floorGuard = typeof req.onDelta === 'function' ? createFloorGuard(req.onDelta) : null;
        const onDelta = floorGuard ? (d) => { streamed = true; if (ttftMs === null && attemptStart) ttftMs = Date.now() - attemptStart; floorGuard.push(d); } : null;
        // L36 Y1: a run on behalf of a person tries the person's OWN keys first, for the providers that can serve the
        // request. With only_my_keys it never falls back; otherwise the network is the fallback and the explain says so.
        const prefs = ctx.selfPreferences || {};
        // Spend safety: the free allowance and the anonymous Try it (ctx.freeUse, server/runs.js) may use only
        // offers from AI_FREE_PROVIDERS (server/free-tier.js) and at or below this output price. A person's own
        // token (their Balance) or their own key is not capped this way. A person's own price ceiling still
        // applies to the network fallback as before.
        const freeCeiling = ctx.freeUse ? ceilingOf(config.freeUse) : null;
        const freeSources = ctx.freeUse ? sourcesOf(config.freeUse) : null;
        const ceiling = freeCeiling != null ? freeCeiling : prefs.price_ceiling_usd_per_mtok;
        let freeCeilingSkipped = false;   // every capable offer was dearer than the free ceiling
        let freeProviderSkipped = false;  // every capable offer came from a source the free tier may not use
        const selfAttempts = [];
        // The adult tier is network supply only: a person's own provider key is not an offer marked uncensored, and
        // only such an offer may answer an uncensored request. Their key is still used for every standard request.
        const selfList = uncensored ? [] : (Array.isArray(ctx.selfCredentials) ? ctx.selfCredentials : []);
        if (!uncensored && (selfList.length || (ctx.selfSubject && prefs.only_my_keys))) {
            const order = [...selfList].sort((a, b) => {
                const rank = (x) => (x.status === 'failing' ? 2 : x.status === 'untested' ? 1 : 0);
                // L37: the person's own key for the provider they asked for answers first, at no fee.
                const want = (x) => (prefer && prefer.provider && String(x.provider) === prefer.provider) ? 0 : 1;
                return want(a) - want(b) || rank(a) - rank(b) || String(a.provider).localeCompare(String(b.provider));
            });
            for (const cred of order) {
                if (!credentialCanServe(cred.provider, operation, req)) {
                    selfAttempts.push({ key: paidByOf(cred), provider: cred.provider, model: null, why: 'your own key', status: 'skipped', error: `this key cannot serve ${operation}` });
                    continue;
                }
                let pick = selfModelFor(cred, operation, req, ctx, prefs);
                // L37: the model they named, when it can do this job. A model that cannot is never forced.
                if (prefer && prefer.model && (!prefer.provider || String(cred.provider) === prefer.provider)) {
                    const check = await preferredModel(prefer.provider || cred.provider, prefer.model, task);
                    if (check.missing.length) {
                        if (preferState && !preferState.why) preferState.why = check.missing.includes('no_vision') ? 'the model you named cannot see' : 'the model you named cannot do this job';
                    } else {
                        pick = { model: prefer.model, why: 'your own ' + cred.provider + ' key, with the model you asked for' };
                    }
                }
                const key = paidByOf(cred);
                try {
                    const out = await executeWithCredential(cred, operation, req, { ...ctx, defaultModel: pick.model });
                    const answer = floor.checkResult(out.result);
                    if (!answer.ok) throw refuseFloor(answer);
                    const attempts = [...selfAttempts, { key, provider: cred.provider, model: pick.model, why: pick.why, status: 'ok', error: null }];
                    // L37: the preference was honoured when their own key for that provider answered.
                    if (preferState && prefer.provider && String(cred.provider) === prefer.provider) {
                        preferState.honoured = true;
                        preferState.why = 'your own ' + cred.provider + ' key answered, as you asked';
                    } else if (preferState && !preferState.honoured && !preferState.why) {
                        preferState.why = 'your ' + cred.provider + ' key answered instead: you have no key for the one you asked for';
                    }
                    return {
                        ...out, fallbackUsed: false,
                        explain: {
                            objective: 'own-keys', reasons: ['your own keys are tried before the network\'s providers'],
                            paid_by: key, selected: `${cred.provider}/${pick.model}`, candidates: [], attempts,
                            prefer: preferState ? { ...preferState } : null,
                        },
                    };
                } catch (err) {
                    // A breach is the request's, not the key's: never fall back to another provider to get it answered.
                    if (err && err.code === 'policy.floor_refused') throw err;
                    const detail = String(err && (err.detail || err.message) || err).slice(0, 300);
                    selfAttempts.push({ key, provider: cred.provider, model: pick.model, why: pick.why, status: 'failed', error: detail });
                }
            }
            if (prefs.only_my_keys) {
                const providers = await servingProviders(route, features, operation, req, selfList);
                const names = providers.length ? providers.join(', ') : 'any provider that can serve this request';
                throw new AiError(422, 'ai.needs_key',
                    `only_my_keys is on and none of your keys could serve this request; add a key for ${names} under Your AI`,
                    { providers, paid_by: null, attempts: selfAttempts, explain: { objective: 'own-keys', reasons: ['only_my_keys: no network fallback'], paid_by: null, selected: null, candidates: [], attempts: selfAttempts, prefer: preferState ? { ...preferState, why: preferState.why || 'you have no key for it, and only_my_keys never falls back to the network' } : null } });
            }
        }

        // Community placement runs before the catalog pool. A preset with price, privacy, region, or quality
        // rules must use the catalog path so those rules are checked before any offer is called.
        const communityPresetSafe = !ctx.presetPolicy || Object.keys(ctx.presetPolicy).every((key) => key === 'community');
        if (community && ctx.communityOptIn && communityPresetSafe && !ctx.credential && !ctx.byok && !ctx.exact) {
            // Community capacity is a free-tier source only when the allowlist names it: without that, the
            // ordinary network answers and the skip is named in the explain, never silently used.
            if (freeSources && !allowsCommunity(freeSources)) {
                tried.push({ provider: 'community', skipped: 'free_provider_not_allowed' });
                freeProviderSkipped = true;
            } else {
                try {
                    const out = await community.execute({ route, operation, req, ctx });
                    if (out) return out;
                } catch (err) {
                    const why = String((err && (err.detail || err.message)) || err).slice(0, 300);
                    tried.push({ provider: 'community', error: why });
                    log.warn(`[ai] community ${operation} failed, falling back to the network: ${why}`);
                }
            }
        }
        // CHECKPOINT D3: an exact id runs only its own artifact. The candidates are the catalog's deployments of
        // that id, filtered first by commercial access and what the request needs; no other model is ever added.
        const exact = ctx.exact || null;
        // A routing preset's objective is the more specific request: it decides what the router optimises
        // (cheapest, fastest, balanced, private). An exact id stays exact: a pin is never re-ranked.
        const presetObjective = ctx.presetPolicy && ctx.presetPolicy.objective ? ctx.presetPolicy.objective : null;
        const policy = (exact || ctx.policy === 'exact') ? 'exact' : (presetObjective || ctx.policy || null);
        let list;
        let explain;
        if (exact) {
            const candidatesView = [];
            const usable = [];
            let payerSkipped = false;
            for (const offer of exact.offers || []) {
                const p = await registry.getProvider(offer.provider);
                const entry = p ? await adapter(offer.provider) : null;
                const row = offer.model ? await registry.getModel(offer.provider, offer.model) : null;
                const missing = hardNeeds(capabilitiesOf(row, p), task);
                const why = [];
                const card = row ? modelCatalog.retailRate(row) : null;
                const policyOk = p ? await policyAllows(registry, p, offer.model, ctx.contentPolicy || 'standard') : false;
                if (!p) why.push('unknown_provider');
                else if (!policyOk) why.push('content_policy');
                else if (ctx.creditsRequired && !isFreeProvider(p) && card && card.version) { why.push('payer_required'); payerSkipped = true; }
                else if (freeSources && !allowsProvider(p.key, p, freeSources)) {
                    // The free allowance / anonymous Try it may pin only a model from one of its sources...
                    why.push('free_provider_not_allowed');
                    freeProviderSkipped = true;
                } else {
                    // ...and never one above the output price ceiling.
                    const price = freeCeiling != null && !isFreeProvider(p) ? await priceFor(offer.provider, offer.model) : null;
                    if (price && Number(price.out) > freeCeiling) { why.push('over_price_ceiling'); freeCeilingSkipped = true; }
                    else {
                        if (!accessOffered(p)) why.push(`provider_access ${modelCatalog.accessOf(p)}`);
                        const skip = await skipReason(p, entry && entry.adapter, features);
                        if (skip) why.push(skip);
                    }
                }
                if (missing.length) why.push(...missing);
                const reason = why.length ? [...new Set(why)].join(',') : null;
                candidatesView.push({ provider: offer.provider, model: offer.model, eligible: !reason, excluded_reason: reason, cost: null, latency: null });
                if (!reason) usable.push({ provider: offer.provider, model: offer.model });
            }
            explain = { objective: 'exact', policy: 'exact', reasons: [`exact model ${exact.id}: only its own deployment may answer`], selected: null, candidates: candidatesView,
                ...(freeCeiling != null ? { free_ceiling_usd_per_mtok: freeCeiling } : {}),
                ...(freeSources ? { free_providers: [...freeSources] } : {}) };
            if (!usable.length) {
                if (payerSkipped) throw new AiError(402, 'billing.payer_required', `the exact model ${exact.id} needs a Balance payer (a person, or an app with its project); it was not run`, { explain });
                if (freeProviderSkipped) throw new AiError(402, 'billing.payer_required', `the exact model ${exact.id} comes from a provider the free allowance may not use (${[...freeSources].join(', ')}); use your own key, or run with your own token so your Balance pays`, { explain });
                if (freeCeilingSkipped) throw new AiError(402, 'billing.payer_required', `the exact model ${exact.id} is above the free-use ceiling of $${freeCeiling} per 1M output tokens; use your own key, or run with your own token so your Balance pays`, { explain });
                throw new AiError(400, 'ai.model_unavailable', `the artifact ${exact.id} cannot run this request`, { explain });
            }
            list = usable;
        } else {
            ({ order: list, explain } = await candidates(route, features, operation, ctx));
            if (policy) explain.policy = policy;
        }
        // The adult tier only runs offers explicitly marked uncensored; when none is live (no key, no agreement, the
        // circuit open) the answer is the reason, never a standard model quietly standing in.
        if (uncensored && list.length === 0) {
            throw new AiError(503, 'policy.uncensored_unavailable', 'no uncensored offer can answer this request right now', { explain });
        }
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
        const warmDeployment = warm.getDeployment(warmSubject(ctx, route), leadingText(req));
        const warmProvider = warmDeployment ? warmDeployment.provider : null;
        // L36 Y3: with free_first on, the free tiers lead (the price decides); with it off, the strength tier
        // leads and the free tiers are the failover, not the first choice.
        const freeFirst = ctx.selfSubject ? prefs.free_first !== false : true;
        const ranked = exact
            // The exact id's own deployment order is already the only order there is: never re-rank in another model.
            ? { order: list, ranked: [], reasons: new Map(), keepOrder: true }
            : await rankCandidates({
                list, explain, task, route, warmProvider,
                preferred: preferredModelFor(prefs, operation, req, ctx),
                ceiling,
                tierFirst: task.weight === 'heavy' || !freeFirst,
                policy,
                // A pinned route keeps its own order: the pin is the admin's decision, not the router's.
                keepOrder: !(route.capability && operation),
            });
        list = ranked.order;
        explain.task = task;
        explain.ranked = ranked.ranked;
        // L37: the soft preference. The provider (and model) the caller asked for goes first, when it can do the
        // job; a pinned route keeps its own order (the pin is the admin's decision).
        if (preferState) {
            if (prefer.provider && !(await registry.getProvider(prefer.provider))) preferState.why = 'no provider by that name';
            else if (prefer.model) {
                // L37: the model they named cannot do this job: it is never forced.
                const check = await preferredModel(prefer.provider, prefer.model, task);
                if (check.missing.length) preferState.why = check.missing.includes('no_vision') ? 'the model you named cannot see' : 'the model you named cannot do this job';
            }
            if (ranked.keepOrder) {
                preferState.why = exact ? 'the exact model is the pin; nothing else may answer' : 'this route is pinned; the pin decides';
            } else {
                const at = list.findIndex((c) => preferMatches(c.provider, c.model, prefer));
                if (at > 0) {
                    const [chosen] = list.splice(at, 1);
                    list.unshift(chosen);
                } else if (at < 0 && !preferState.why) {
                    preferState.why = 'no ' + (prefer.provider || 'provider') + (prefer.model ? '/' + prefer.model : '') + ' offer could serve this request';
                }
            }
            explain.prefer = preferState;
        }
        // The routing preset's rules (server/exchange/constraints.js): the floor, the ceiling, the hard max_price,
        // the quantization, the region, the data policy and the community switch. An offer a rule removes leaves
        // the order with its reason; a hard max_price that no offer fits refuses the request here, before any
        // provider is called, with the prices that were refused.
        if (ctx.presetPolicy && Object.keys(ctx.presetPolicy).length) {
            const { order: allowed, excluded } = await exchangeConstraints.applyConstraints({
                list, policy: ctx.presetPolicy, facts: constraintFacts,
            });
            if (ctx.presetPolicy.max_price != null && !allowed.length) {
                const refusal = exchangeConstraints.refusal({ policy: ctx.presetPolicy, excluded });
                throw new AiError(400, refusal.code, refusal.detail, {
                    max_price: refusal.max_price,
                    lowest_price: refusal.lowest_price,
                    excluded: refusal.excluded,
                    explain: { ...explain, preset: { name: ctx.presetName || null, policy: ctx.presetPolicy } },
                });
            }
            // Strict privacy: a preset that asks for a data policy no offer meets refuses the request here, with a
            // plain message. It never falls back to an offer that keeps or trains on the prompt.
            if (ctx.presetPolicy.data_policy && !allowed.length) {
                const refusal = exchangeConstraints.privacyRefusal({ policy: ctx.presetPolicy, excluded });
                throw new AiError(503, refusal.code, refusal.detail, {
                    data_policy: refusal.data_policy,
                    excluded: refusal.excluded,
                    explain: { ...explain, preset: { name: ctx.presetName || null, policy: ctx.presetPolicy } },
                });
            }
            list = allowed;
            for (const x of excluded) {
                explain.candidates.push({ provider: x.provider, model: x.model, eligible: false, excluded_reason: x.reason, cost: null, latency: null });
            }
            explain.preset = { name: ctx.presetName || null, policy: ctx.presetPolicy };
        }
        // AI Exchange P7: an alias route (economy/fast/balanced/auto) is ranked by measured evidence when
        // AI_ROUTING_EVIDENCE is on. planAi (openvibe-sdk/placement) is the planner: this only prepares its
        // inputs, keeps the incumbent for N decisions and explains the answer. Private never leaves local
        // capacity, and an exact id never reaches here.
        if (routingEvidence && routingEvidence.enabled() && ctx.aliasPolicy && ctx.aliasPolicy !== 'private' && !exact) {
            const picked = await routingEvidence.choose({ routeKey: route.key, policy: ctx.aliasPolicy, list, req, ctx, warmDeployment, preferred: prefer });
            if (picked && picked.view) {
                list = picked.order;
                explain.evidence = picked.view;
                explain.policy = ctx.aliasPolicy;
                explain.reasons = [picked.view.reason, ...(explain.reasons || [])];
            }
        }
        const evidenceReason = explain.evidence ? explain.evidence.reason : null;
        explain.content_policy = contentPolicy;
        if (uncensored) explain.label = tier.LABEL;
        const attempts = [...selfAttempts];
        explain.paid_by = 'openvibe';
        explain.attempts = attempts;
        explain.reasons = [...(explain.reasons || []), ...(selfAttempts.length ? ['your own keys did not answer; the network is the fallback'] : [])];
        // A first-party service's generate run may name one offer from GET /api/v1/routes. The run then
        // tries that offer alone: no fallback to another model, so the caller gets the model it asked for
        // or an explicit failure. server/runs.js validates the pin against this same offer list first.
        if (ctx.routePin && operation === 'generate' && !exact) {
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
        // BA1: a run that may wait (the 'background' class) looks for capacity that is cheap because it may
        // take minutes: the host's own idle model first, when the route's quality allows it. The provider
        // order stays the router's own (the authority keeps critical work); what changes is the tier each
        // candidate runs on, and that is decided per candidate below.
        const latencyClass = latency.isClass(ctx.latencyClass) ? ctx.latencyClass : latency.DEFAULT;
        if (latencyClass !== latency.DEFAULT && !exact) {
            list = await orderForWaiting(list, { route, operation, req });
            explain.latency_class = latencyClass;
        }
        candidate:
        for (let i = 0; i < list.length; i++) {
            const c = list[i];
            const entry = await adapter(c.provider);
            const p = entry && entry.record;
            const a = entry && entry.adapter;
            const model = c.model || (p && p.default_model) || null;
            const chosen = ranked.reasons.get(c.provider + ':' + (model || '')) || null;
            const fallback = i > 0;
            const base = { operation, provider_key: c.provider, model_key: model, route_key: ctx.routeKey || null, route_version: ctx.routeVersion || null, fallback: fallback ? 1 : 0, prompt_hash: ctx.promptHash || null, input_hash: ctx.inputHash || null };
            // Spend safety: the free allowance / anonymous Try it runs only from its named sources
            // (server/free-tier.js). A provider outside them is skipped even when it is cheaper: who pays
            // matters, not only the price. The person's own keys (above) are always tried first and are never
            // gated here.
            if (freeSources && !allowsProvider(c.provider, p, freeSources)) {
                if (preferState && preferMatches(c.provider, model, prefer)) { preferState.honoured = false; preferState.why = 'it is not a provider the free tier may use'; }
                statFor(c.provider).skipped++;
                tried.push({ provider: c.provider, skipped: 'free_provider_not_allowed' });
                attempts.push({ key: 'openvibe', provider: c.provider, model, why: chosen || 'the router chose it', status: 'skipped', error: 'free_provider_not_allowed' });
                if (ctx.logRequest) ctx.logRequest({ ...base, status: 'skipped', skip_reason: 'free_provider_not_allowed' });
                freeProviderSkipped = true;
                continue;
            }
            // L36 Y3 / spend safety: a price ceiling caps the network's fallback; the person's own keys are never
            // capped (above). The free allowance's ceiling is the network's, so an over-ceiling offer is skipped.
            if (ceiling != null) {
                const cards = await rateCardsFor(c.provider, model);
                const outputPrice = cards ? Number(rates.pricesOf(cards).out) || 0 : 0;
                if (outputPrice > Number(ceiling)) {
                    const whyPrice = `over_price_ceiling (${outputPrice} > ${ceiling} USD/Mtok)`;
                    if (freeCeiling != null) freeCeilingSkipped = true;
                    if (preferState && preferMatches(c.provider, model, prefer)) { preferState.honoured = false; preferState.why = 'it is over your price ceiling'; }
                    statFor(c.provider).skipped++;
                    tried.push({ provider: c.provider, skipped: 'over_price_ceiling' });
                    attempts.push({ key: 'openvibe', provider: c.provider, model, why: chosen || 'the router chose it', status: 'skipped', error: whyPrice });
                    if (ctx.logRequest) ctx.logRequest({ ...base, status: 'skipped', skip_reason: 'over_price_ceiling' });
                    continue;
                }
            }
            // AI Exchange F: a run with no payer (no person and no app project) must not be served a paid managed
            // offer that carries a versioned retail card: nobody could be charged for it. Offers without a card keep
            // today's behaviour, as do free and prepaid ones.
            if (ctx.creditsRequired && p && !isFreeProvider(p)) {
                const row = model ? await registry.getModel(p.key, model) : null;
                const card = row ? modelCatalog.retailRate(row) : null;
                if (card && card.version) {
                    statFor(c.provider).skipped++;
                    tried.push({ provider: c.provider, skipped: 'payer_required' });
                    attempts.push({ key: 'openvibe', provider: c.provider, model, why: chosen || 'the router chose it', status: 'skipped', error: 'payer_required' });
                    if (ctx.logRequest) ctx.logRequest({ ...base, status: 'skipped', skip_reason: 'payer_required' });
                    continue;
                }
            }
            const why = await skipReason(p, a, features);
            if (why) {
                if (why === 'exhausted' || why === 'circuit_open') resting = true;
                statFor(c.provider).skipped++;
                tried.push({ provider: c.provider, skipped: why });
                attempts.push({ key: 'openvibe', provider: c.provider, model, why: chosen || 'the router chose it', status: 'skipped', error: why });
                if (ctx.logRequest) ctx.logRequest({ ...base, status: 'skipped', skip_reason: why });
                continue;
            }
            // The host's local model is the last offer, and only for short text: never code or long reasoning, and
            // one request at a time (AI_LOCAL_LLM_CONCURRENCY) so a paid outage cannot starve the streams it shares
            // the machine with. Its answer is labelled local on the run's receipt (provider_key = local / local2).
            const local = isLocalModel(p);
            if (local && !localCanServe(route, operation, req)) {
                statFor(c.provider).skipped++;
                tried.push({ provider: c.provider, skipped: 'unsupported' });
                attempts.push({ key: 'openvibe', provider: c.provider, model, why: chosen || 'the router chose it', status: 'skipped', error: 'the local model is not offered this job' });
                if (ctx.logRequest) ctx.logRequest({ ...base, status: 'skipped', skip_reason: 'unsupported' });
                continue;
            }
            if (local && localActive >= localLimit) {
                resting = true;
                statFor(c.provider).skipped++;
                tried.push({ provider: c.provider, skipped: 'busy' });
                attempts.push({ key: 'openvibe', provider: c.provider, model, why: chosen || 'the router chose it', status: 'skipped', error: 'the local model is busy with another answer' });
                if (ctx.logRequest) ctx.logRequest({ ...base, status: 'skipped', skip_reason: 'busy' });
                continue;
            }
            // L36 Y7: the fallback chain stops after three providers.
            if (attemptsMade >= maxAttempts) break;
            attemptsMade += 1;
            // Claim the local slot synchronously, before any await, so two requests cannot both pass the check.
            if (local) localActive++;
            let lastErr = null;
            try {
            // An image generation outlasts the shared provider's chat timeout (AI_PROVIDER_TIMEOUT_MS): the route's wins. So does a
            // route that says so (options.outlast_provider_timeout: space.build writes a whole app, a minute or two). Otherwise
            // the provider's timeout stays strict, so a slow provider fails over quickly.
            // BA1: a run that may wait gets the room its class allows (a Flex tier answers in minutes, not
            // seconds), so the provider's own chat timeout does not cut it short.
            const waiting = latencyClass !== latency.DEFAULT;
            const outlast = operation === 'image' || Boolean(route.options && route.options.outlast_provider_timeout);
            const own = await providerTimeout(p, model);
            const room = waiting ? Math.max(latency.timeoutMs(latencyClass), Number(route.timeout_ms) || 0) : 0;
            const cap = (outlast || waiting) ? Math.max(own, Number(route.timeout_ms) || 0, room, operation === 'image' ? 600000 : 0) : (own || 600000);
            const timeoutMs = Math.max(1000, Math.min(req.timeoutMs || route.timeout_ms || own || DEFAULT_PROVIDER_TIMEOUT_MS, cap));
            const retries = config.providerRetries;
            // BA1: the tier this candidate runs on. A background run asks for the cheaper tier the
            // provider sells. A refusal of that tier (a Flex tier with no capacity, or a model that does
            // not serve it) sends the same run once more on the standard tier: the refusal is counted and
            // logged, and it produced no tokens, so nothing is billed for it. The batch class has no tier
            // yet: its own API is BA2, so a batch run is priced at the standard rate until then.
            const wantedTier = latencyClass === 'background' ? await tierFor({ p, model, operation, at: clock.now() }) : 'standard';
            let askedTier = wantedTier;
            let attempt = 0;
            while (attempt <= retries) {
                if (ctx.signal && ctx.signal.aborted) throw new AiError(409, 'run.cancelled', 'run was cancelled');
                const started = clock.now();
                const t0 = Date.now();
                attemptStart = t0;
                // The disclosure is known before the call starts, so a streamed answer can carry it as its first
                // SSE comment without waiting for the run to finish (server/api/{openai,messages}.js).
                const attemptFacts = await modelCatalog.facts({
                    registry, providerRecord: p, model,
                    policy: policy || (exact ? 'exact' : null),
                    policyReason: evidenceReason,
                    fallbackReason: fallback ? `the first eligible offer did not answer; a later offer on this same route answered${evidenceReason ? ` (${evidenceReason})` : ''}` : null,
                });
                // The label is known before the call, so a streamed answer can carry it in its first SSE comment.
                if (uncensored) { attemptFacts.content_policy = 'uncensored'; attemptFacts.label = tier.LABEL; }
                // The hold needs the offer's retail card, whether it is prepaid, and the real output cap.
                const attemptRow = p && model ? await registry.getModel(p.key, model) : null;
                // A reasoning model spends the same max_tokens allowance thinking before it writes: a caller's
                // 300-token cap can be all reasoning, leaving content empty (finish_reason 'length', output 0).
                // The registry says how much room this model needs on top of the answer the caller asked for.
                const reserve = Number(attemptRow && attemptRow.metadata && attemptRow.metadata.reasoning_reserve_tokens) || 0;
                const requestedMax = Number(req.maxTokens);
                const modelMax = reserve > 0 && Number.isSafeInteger(requestedMax) && requestedMax >= 1
                    && ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'complete', 'messages'].includes(operation)
                    ? requestedMax + reserve
                    : req.maxTokens;
                const attemptMeta = { provider: p ? p.key : null, model, maxTokens: modelMax, paid: !isFreeProvider(p), retail: modelCatalog.retailRate(attemptRow) };
                const routed = typeof ctx.onRoute === 'function' ? await ctx.onRoute(attemptFacts, attemptMeta) : null;
                if (routed && routed.skip) {
                    statFor(c.provider).skipped++;
                    tried.push({ provider: c.provider, skipped: routed.skip });
                    attempts.push({ key: 'openvibe', provider: c.provider, model, why: chosen || 'the router chose it', status: 'skipped', error: routed.skip });
                    if (ctx.logRequest) ctx.logRequest({ ...base, status: 'skipped', skip_reason: routed.skip });
                    continue candidate;
                }
                // max_cost_usd, when it binds, comes back as the affordable output cap for this attempt.
                const callMax = routed && Number.isSafeInteger(routed.maxTokens) && routed.maxTokens >= 1 && routed.maxTokens !== modelMax ? routed.maxTokens : null;
                let callReq = modelMax !== req.maxTokens ? { ...req, maxTokens: modelMax } : req;
                if (callMax != null) callReq = { ...callReq, maxTokens: callMax };
                // The host's model writes a short answer: its own cap, never more, whatever the route asked for.
                if (local && operation !== 'embed') {
                    const localMax = Math.max(1, (config.localLlm && config.localLlm.maxTokens) || 512);
                    callReq = { ...callReq, maxTokens: Math.min(Number(callReq.maxTokens) || localMax, localMax) };
                }
                // The service tier travels with the request (BA1): a Flex tier is slower and cheaper.
                if (askedTier === 'flex') callReq = { ...callReq, serviceTier: 'flex' };
                try {
                    const fn = a[operation];
                    if (typeof fn !== 'function') throw new ProviderError(`${operation} not implemented`, { code: 'provider.unsupported' });
                    statFor(c.provider).calls += p.kind === 'stub' ? 0 : 1;   // stub counts its own calls
                    // BA1: a Flex attempt for a caller that waits gets only the part of the wait it may use, so a
                    // too-slow tier gives way to the standard one in time (ctx.flexBudgetMs, server/runs.js).
                    const flexCapped = askedTier === 'flex' && Number(ctx.flexBudgetMs) > 0;
                    const attemptTimeout = flexCapped ? Math.max(1000, Math.min(timeoutMs, Number(ctx.flexBudgetMs))) : timeoutMs;
                    const result = await fn({ ...callReq, ...(onDelta ? { onDelta } : {}), model, signal: ctx.signal, timeoutMs: attemptTimeout });
                    if (operation === 'embed' && (!Array.isArray(result.vectors) || result.vectors.length !== req.input.length
                        || result.vectors.some(v => !Array.isArray(v) || !v.length || v.some(n => typeof n !== 'number' || !Number.isFinite(n)))))
                        throw new ProviderError('embedding response has invalid vectors', { code: 'provider.output' });
                    // The floor on the way out, over the answer's own shape (chat text, completion choices, tool
                    // arguments, a message's blocks): an answer that carries a breach never leaves this function.
                    if (floorGuard) floorGuard.finish();
                    const floorOut = floor.checkResult(result);
                    if (!floorOut.ok) throw new AiError(403, 'policy.floor_refused', floorOut.detail, { rule: floorOut.rule, policy: contentPolicy });
                    if (uncensored) { result.policy = 'uncensored'; result.label = tier.LABEL; }
                    const latency = Date.now() - t0;
                    const usage = result.usage || { input: 0, output: 0, cached: 0 };
                    await recordEvidence({ provider: c.provider, model, ok: true, timeout: false, ttftMs, latencyMs: latency,
                        outputTokens: usage.output || 0, inputTokens: usage.input || 0, cachedTokens: usage.cached || 0 });
                    // An image is metered per image (usage.output = images), and no rate card prices one yet (an owner/T5
                    // item): its cost is 0 rather than the image count read as output tokens on the token cards.
                    // BA1: the cost is the tier the answer really ran on, and the wait's saving is the
                    // standard price minus that one. A provider that does not say which tier it served is
                    // priced at the list price: a saving nobody confirmed is not a saving.
                    const ranOn = tiers.tierOfAnswer(result, askedTier);
                    const priced = operation === 'image'
                        ? { cost: 0, standard: 0, saved: 0 }
                        : await costOnTier({ providerKey: c.provider, model: result.model || model, usage, tier: ranOn, p });
                    const cost = priced.cost;
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
                    // L37: the preference was honoured when the offer it named answered.
                    if (preferState && preferMatches(c.provider, model, prefer)) {
                        preferState.honoured = true;
                        preferState.why = 'the ' + c.provider + ' offer answered, as you asked';
                    }
                    attempts.push({ key: 'openvibe', provider: c.provider, model: result.model || model, why: chosen || (fallback ? 'the next network provider after an earlier attempt failed' : 'the first network offer for this route'), status: 'ok', error: null });
                    warm.remember(warmSubject(ctx, route), leadingText(req), c.provider, model);
                    explain.attempts = attempts;
                    explain.openvibe = attemptFacts;
                    if (local) explain.provider_local = true;   // the Exchange receipt labels the offer local (server/exchange/receipts.js)
                    // BA1: the tier the run really ran on, and what waiting earned.
                    explain.service_tier = ranOn;
                    if (wantedTier !== 'standard') explain.requested_tier = wantedTier;
                    if (priced.saved > 0) explain.saved_usd = priced.saved;
                    return { result, provider: c.provider, providerKind: p.kind, local, model: result.model || model, fallbackUsed: fallback || selfAttempts.some(a => a.status !== 'skipped'), usage, cost, latencyMs: latency, ttftMs, synthetic: Boolean(result.synthetic || a.synthetic), tried, startedAt: started, serviceTier: ranOn, savedUsd: priced.saved, standardCostUsd: priced.standard, explain };
                } catch (err) {
                    lastErr = err;
                    if (ctx.signal && ctx.signal.aborted) {
                        if (ctx.logRequest) ctx.logRequest({ ...base, status: 'cancelled', latency_ms: Date.now() - t0, error: 'cancelled' });
                        throw new AiError(409, 'run.cancelled', 'run was cancelled');
                    }
                    await recordEvidence({ provider: c.provider, model, ok: false, timeout: Boolean(err && err.code === 'provider.timeout'), latencyMs: Date.now() - t0 });
                    statFor(c.provider).failures++;
                    if (ctx.logRequest) ctx.logRequest({ ...base, status: err && err.code === 'provider.timeout' ? 'timeout' : 'error', latency_ms: Date.now() - t0, error: String(err && err.message || err).slice(0, 500) });
                    // A stream that broke off still delivers what the upstream had already said (the guard's held tail
                    // included), unless that tail itself breaks the floor.
                    if (streamed && floorGuard) {
                        try { floorGuard.finish(); }
                        catch (guardErr) {
                            if (guardErr && guardErr.code === 'policy.floor_refused') throw new AiError(403, 'policy.floor_refused', guardErr.detail || guardErr.message, { rule: guardErr.rule, policy: contentPolicy });
                            throw guardErr;
                        }
                    }
                    if (streamed && err && err.code === 'policy.floor_refused') throw new AiError(403, 'policy.floor_refused', err.detail || err.message, { rule: err.rule, policy: contentPolicy });
                    if (streamed) throw new AiError(502, 'provider.stream_broken', `the answer broke off after it began streaming: ${String(err && err.message || err).slice(0, 200)}`, { tried: [...tried, { provider: c.provider, error: String(err && err.message || err).slice(0, 200) }], explain });
                    // A timed-out image may still be generated and billed upstream: never pay for it twice.
                    // An insufficient-balance answer is never retried: the same provider cannot answer until it is topped up.
                    if (insufficientBalance(err)) resting = true;
                    // BA1: the provider refused the tier we asked for (a Flex tier with no capacity, or a
                    // model that does not serve it). The same run goes once more on the standard tier: the
                    // refusal is counted and logged above, and it produced no tokens, so nothing is billed
                    // for it. The retry does not spend one of the provider's own retries.
                    const flexTooSlow = askedTier === 'flex' && Number(ctx.flexBudgetMs) > 0 && err && err.code === 'provider.timeout' && !(ctx.signal && ctx.signal.aborted);
                    if (askedTier === 'flex' && (tiers.isTierRefusal(err, 'flex') || flexTooSlow)) {
                        askedTier = 'standard';
                        const why = flexTooSlow ? 'the flex tier was slower than the caller waits' : 'the provider refused the flex tier';
                        attempts.push({ key: 'openvibe', provider: c.provider, model, why: chosen || 'the router chose it', status: 'failed', error: why });
                        log.warn(`[ai] ${c.provider}: ${why}; the same run goes again on the standard tier`);
                        continue;
                    }
                    if (attempt < retries && !insufficientBalance(err) && retryable(err) && !(operation === 'image' && err.code === 'provider.timeout')) { attempt += 1; await sleep(config.retryDelayMs + Math.floor(Math.random() * Math.min(700, config.retryDelayMs)), ctx.signal).catch(() => {}); continue; }
                    break;
                }
            }
            } finally {
                if (local) localActive--;
            }
            // A request the provider rejected as malformed is the caller's fault, not a sign the
            // provider is unhealthy; a 429 is capacity, not health either, and moves on without
            // opening the circuit. Neither must take a shared provider away from other callers.
            if (lastErr && lastErr.code === 'media.unreadable') unreadable = lastErr;
            // An insufficient-balance 429 is not ordinary capacity: it must open the long exhausted circuit.
            if (insufficientBalance(lastErr) || (!callerFault(lastErr) && !rateLimited(lastErr))) await recordFailure(c.provider, lastErr);
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
        if (resting) {
            explain.reasons = [...(explain.reasons || []), 'a provider is out of balance or paused; AI is resting'];
            throw new AiError(503, 'ai.resting', 'AI is resting for a moment', { retry_after_seconds: Math.ceil(exhaustedCooldownMs() / 1000), tried, explain });
        }
        // The free allowance / anonymous Try it had capable offers, but every one was outside its sources or
        // above its ceiling. That is not an outage: the caller needs their own key, or their own token so
        // their Balance can pay.
        if (attemptsMade === 0 && (freeCeilingSkipped || freeProviderSkipped)) {
            const allowed = [...freeSources].join(', ');
            const cap = freeCeiling == null ? '' : ` at up to $${freeCeiling} per 1M output tokens`;
            explain.free_providers = [...freeSources];
            if (freeCeiling != null) explain.free_ceiling_usd_per_mtok = freeCeiling;
            explain.reasons = [...(explain.reasons || []),
                ...(freeProviderSkipped ? [`every capable offer comes from a provider outside the free tier (${allowed})`] : []),
                ...(freeCeilingSkipped ? [`every capable offer costs more than the free-use ceiling of $${freeCeiling} per 1M output tokens`] : [])];
            const detail = freeProviderSkipped
                ? `this run has no payer, so its free allowance may use only ${allowed}${cap}; the model it needs is outside that. Use your own key, or run with your own token so your Balance pays.`
                : `this run has no payer, so its free allowance may use models up to $${freeCeiling} per 1M output tokens; the model it needs is dearer. Use your own key, or run with your own token so your Balance pays.`;
            throw new AiError(402, 'billing.payer_required', detail, { tried, explain });
        }
        explain.reasons = [...(explain.reasons || []), 'no provider on this route could answer'];
        throw new AiError(503, 'provider.unavailable', 'no provider on this route could answer', { tried, explain });
    }

    return { adapter, health, resetHealth, execute, executeWithCredential, offers, benchView, priceFor, costOf, rateCardsFor, providerStates, stats, statFor, candidates, machines, routingEvidence };
}

module.exports = { createProviderPool, createFloorGuard, policyAllows, machineMessages, machineTools };
