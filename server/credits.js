'use strict';
/**
 * OpenVibe AI ↔ Billing Credits (AI Exchange F, P7; CHECKPOINT D2, D9, D10), behind `AI_CREDITS` (off).
 *
 * A request on a PAID MANAGED route (the catalog's `provider_access` is OWN_DEPLOYMENT or AUTHORIZED_WHOLESALE)
 * reserves its worst case before any provider is called:
 *
 *     hold = min( ceil(input estimate × retail input) + ceil(max_tokens × retail output) + per-request,
 *                 max_cost_usd when the caller set it )
 *
 * The hold is created with the request id as its idempotency key and a fingerprint of the resolved model, the
 * token caps, the retail rate version, the subject and the project. Billing answers 402
 * `billing.insufficient_funds` for a short balance; that becomes AI's own 402 before the provider runs, and any
 * other Billing failure fails closed (503 `billing.unavailable`) rather than serving unpaid capacity.
 *
 * While a stream runs, `observe()` estimates the output from the deltas and extends the hold in steps when the
 * projected charge nears it (capped by max_cost_usd; a refused extension never loses the usage — Billing settles
 * the overage as a recorded shortfall). At the end, one settle carries the four token counts, the answering
 * model's retail card (version included), the supply cost and the attempts the router made. One run settles
 * once: the settle key is the request id too, so a retried request replays Billing's answer instead of charging
 * twice. An error before the first token releases the hold; an abort settles what was streamed.
 *
 * BYOK is never charged and never held: a run on a person's own key, their machine or a project's own provider
 * only produces CUSTOMER_BYOK attempts, so no hold is ever created for it (there is no hold to settle `byok` on;
 * Billing's settle needs one). A run that falls back from BYOK to managed supply holds and settles the managed
 * part normally.
 *
 * Money is integer nano-USD in BigInt here, never a float (D1).
 */
const { AiError, sha256, iso } = require('./util');
const { approxTokens } = require('./providers/common');
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const MANAGED_ACCESS = new Set(['OWN_DEPLOYMENT', 'AUTHORIZED_WHOLESALE']);
const PER_MILLION = 1000000n;
const NANO_PER_USD = 1e9;
/** The four capabilities Credits names for AI (Contracts v0.284.0, one per operation). */
const CAPABILITIES = ['billing.credit.hold.create', 'billing.credit.hold.extend', 'billing.credit.hold.settle', 'billing.credit.hold.release'];
/** A prepaid answer has no retail charge; a settle still needs a card, and this says why the charge is zero. */
const ZERO_RETAIL = Object.freeze({ version: 'prepaid', nano_usd_per_m: Object.freeze({ input: '0', cached_read: '0', cache_write: '0', output: '0' }), per_request_nano_usd: '0' });

/** USD -> integer nano-USD, rounded up (a hold never under-reserves a fraction of a nano-USD). */
function nanoFromUsd(usd, field = 'max_cost_usd') {
    const n = Number(usd);
    if (!Number.isFinite(n) || n < 0) throw new AiError(422, 'input.invalid', `${field} must be a non-negative number`);
    const nano = Math.ceil(n * NANO_PER_USD);
    if (!Number.isSafeInteger(nano)) throw new AiError(422, 'input.invalid', `${field} is too large`);
    return BigInt(nano);
}

/** ceil(tokens × nano-per-million / 1e6), the D1 rule, per component. */
function chargeNano(tokens, nanoPerM) {
    const t = BigInt(Math.max(0, Math.trunc(Number(tokens) || 0)));
    const rate = BigInt(String(nanoPerM == null ? '0' : nanoPerM));
    if (t === 0n || rate === 0n) return 0n;
    const num = t * rate;
    const div = num / PER_MILLION;
    return num % PER_MILLION === 0n ? div : div + 1n;
}

/** A model row's `retail_rate` (catalog) in the Billing settle shape; null when there is no versioned card. */
function retailOf(rate) {
    if (!rate || typeof rate !== 'object') return null;
    const version = rate.version == null ? '' : String(rate.version).trim();
    if (!version) return null;
    const perM = {
        input: String(rate.input_nano_usd_per_m == null ? '0' : rate.input_nano_usd_per_m),
        cached_read: String(rate.cached_read_nano_usd_per_m == null ? '0' : rate.cached_read_nano_usd_per_m),
        cache_write: String(rate.cache_write_nano_usd_per_m == null ? '0' : rate.cache_write_nano_usd_per_m),
        output: String(rate.output_nano_usd_per_m == null ? '0' : rate.output_nano_usd_per_m),
    };
    return { version, nano_usd_per_m: perM, per_request_nano_usd: String(rate.per_request_nano_usd == null ? '0' : rate.per_request_nano_usd) };
}

/** The retail charge for some usage, the same arithmetic Billing applies (used for the hold and the extension). */
function retailChargeNano(retail, { input = 0, cached = 0, cacheWrite = 0, output = 0 } = {}) {
    const perM = (retail && retail.nano_usd_per_m) || {};
    return BigInt(retail && retail.per_request_nano_usd ? retail.per_request_nano_usd : '0')
        + chargeNano(input, perM.input) + chargeNano(cached, perM.cached_read)
        + chargeNano(cacheWrite, perM.cache_write) + chargeNano(output, perM.output);
}

/** The text a streamed delta carries, for the output estimate (OpenAI and Anthropic event shapes). */
function deltaText(d) {
    if (!d) return '';
    const delta = d.delta || (d.data && d.data.delta) || null;
    if (!delta) return '';
    if (typeof delta.content === 'string') return delta.content;
    if (typeof delta.text === 'string') return delta.text;
    if (typeof delta.partial_json === 'string') return delta.partial_json;
    if (Array.isArray(delta.tool_calls)) return delta.tool_calls.map((t) => (t && t.function && t.function.arguments) || '').join('');
    return '';
}

/** The payer's subject (Contracts identity.subject-ref@1): the person when a request names one, else the app/service. */
function subjectOf({ onBehalfOf = null, appId = null, requesterType = null, requesterId = null } = {}) {
    if (onBehalfOf) return { type: 'user', id: String(onBehalfOf) };
    if (appId) return { type: 'app', id: String(appId) };
    if (requesterType === 'service' && requesterId) return { type: 'service', id: String(requesterId) };
    return null;
}

/** The project a request is billed to: an app's own project, or a project attribution on a first-party run. */
function projectOf({ projectId = null, attribution = null } = {}) {
    if (projectId && /^prj_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(projectId))) return String(projectId);
    const id = attribution && attribution.type === 'project' ? String(attribution.id || '') : '';
    return /^prj_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? id : null;
}

/** A Billing error -> the API's own error: 402 keeps its code, everything else fails closed as unavailable. */
function billingError(status, body, what) {
    const detail = (body && (body.detail || body.title || body.message)) || `Billing ${what} failed`;
    if (status === 402) return new AiError(402, 'billing.insufficient_funds', String(detail).slice(0, 500));
    if (status === 409) return new AiError(409, 'billing.conflict', String(detail).slice(0, 500));
    if (status === 422) return new AiError(422, 'billing.invalid_request', String(detail).slice(0, 500));
    return new AiError(503, 'billing.unavailable', `Billing ${what} is unavailable (${status})`);
}

function createBillingClient({ billingUrl, audience, tokens, fetchImpl = globalThis.fetch, timeoutMs = 5000 }) {
    const base = String(billingUrl || '').replace(/\/+$/, '');
    async function call(method, path, body, requestId) {
        const token = await tokens.getToken({ audience });
        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (requestId) headers['X-OpenVibe-Request-Id'] = requestId;
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
            throw new AiError(503, 'billing.unavailable', `Billing is unreachable: ${(err && err.name === 'TimeoutError') ? 'timeout' : 'network error'}`);
        }
        const json = await res.json().catch(() => null);
        if (!res.ok) throw billingError(res.status, json, path);
        return json || {};
    }
    return {
        hold: (body, requestId) => call('POST', '/internal/credits/holds', body, requestId),
        extend: (id, body, requestId) => call('POST', `/internal/credits/holds/${encodeURIComponent(id)}/extend`, body, requestId),
        settle: (id, body, requestId) => call('POST', `/internal/credits/holds/${encodeURIComponent(id)}/settle`, body, requestId),
        release: (id, requestId) => call('POST', `/internal/credits/holds/${encodeURIComponent(id)}/release`, {}, requestId),
    };
}

/**
 * One request's Credits session. Created by `begin()`; the run drives it:
 *
 *   onRoute(facts, meta)   before each provider attempt (the pool's hook); the first managed attempt holds
 *   observe(delta)         each streamed delta; extends the hold when the output nears it
 *   settle({...})          once, after the answer (or after the partial usage of an abort/failure)
 *   release()              once, when no token was produced at all
 */
function createSession({ manager, requestId, subject, projectId, credentialId = null, inputTokens, maxCostNano = null, startedAt }) {
    const s = {
        requestId: String(requestId),
        subject, projectId, credentialId,
        inputTokens: Math.max(0, Math.trunc(inputTokens)),
        maxCostNano,
        holdId: null,
        heldNano: 0n,
        retail: null,
        streamedChars: 0,
        settled: false,
        released: false,
        extensionRefused: false,
        pending: null,
        startedAt,
    };
    const holdKey = `ai-hold:${s.requestId}`;
    const settleKey = `ai-settle:${s.requestId}`;

    /**
     * The pool calls this before every provider attempt. The first MANAGED attempt reserves the credit; a later
     * managed fallback keeps the first hold (a pricier fallback settles its overage as Billing's shortfall) and
     * remembers its card for the settle.
     */
    async function onRoute(facts, meta) {
        if (s.settled || s.released) return;
        if (!meta) return;                                                   // a person's own key or machine
        const card = retailOf(meta.retail);
        // A prepaid offer (free, subscription, BYOK, the stub) never spends Credits. After an earlier managed
        // attempt it may still answer (a free fallback): the settle then uses its card, or zero.
        if (meta.paid === false) { if (s.holdId) s.retail = card || ZERO_RETAIL; return; }
        if (!MANAGED_ACCESS.has(facts && facts.provider_access)) return;     // BYOK/unverified: no managed offer
        if (s.holdId) { s.retail = card || s.retail; return; }
        const retail = card;
        if (!retail) throw new AiError(503, 'billing.rate_unavailable', 'this route has no versioned retail rate card, so its credit cannot be held');
        const outputTokens = Math.max(1, Math.trunc(Number(meta.maxTokens) || 1024));
        let amount = retailChargeNano(retail, { input: s.inputTokens, output: outputTokens });
        if (s.maxCostNano != null) {
            // The input alone is already owed, so a cap below it cannot be honoured: refuse before the provider.
            const floor = retailChargeNano(retail, { input: s.inputTokens });
            if (s.maxCostNano < floor) throw new AiError(402, 'billing.insufficient_funds', 'max_cost_usd is below this request\'s minimum cost');
            if (amount > s.maxCostNano) amount = s.maxCostNano;
        }
        s.retail = retail;
        s.heldNano = amount;
        const fingerprint = sha256({
            resolved_model: (facts && facts.resolved_model) || null, revision: (facts && facts.revision) || null,
            input_tokens: s.inputTokens, output_tokens: outputTokens, max_cost_usd: s.maxCostNano == null ? null : String(s.maxCostNano),
            rate_version: retail.version, subject: s.subject, project_id: s.projectId,
        });
        const created = await manager.hold({
            idempotency_key: holdKey, subject: s.subject, project_id: s.projectId, ...(s.credentialId ? { credential_id: s.credentialId } : {}),
            max_nano_usd: String(amount), rate_version: retail.version, request_fingerprint: fingerprint, service: 'ai',
        }, s.requestId);
        s.holdId = created.hold_id;
        s.heldNano = BigInt(String(created.held_nano_usd == null ? amount : created.held_nano_usd));
    }

    /** The projected output charge of what has streamed so far. */
    function projectedNano() {
        const output = Math.ceil(s.streamedChars / 4);
        return { output, charge: s.retail ? retailChargeNano(s.retail, { output }) : 0n };
    }

    /** Extend once when the stream nears the hold; the step is another hold's worth, capped by max_cost_usd. */
    function maybeExtend() {
        if (!s.holdId || s.extensionRefused || s.settled || s.released || s.pending) return;
        const { charge } = projectedNano();
        const near = s.heldNano > 0n ? (charge * 5n >= s.heldNano * 4n) : charge > 0n;
        if (!near) return;
        let step = s.heldNano > 0n ? s.heldNano : charge;
        if (step <= 0n) step = 1n;
        if (s.maxCostNano != null) {
            const room = s.maxCostNano - s.heldNano;
            if (room <= 0n) { s.extensionRefused = true; return; }
            if (step > room) step = room;
        }
        s.heldNano += step;
        s.pending = manager.extend(s.holdId, { add_nano_usd: String(step) }, s.requestId).catch((err) => {
            s.heldNano -= step;
            // A short balance mid-stream stops the growth; settle records the overage as Billing's shortfall.
            if (err && (err.code === 'billing.insufficient_funds' || err.code === 'billing.conflict')) s.extensionRefused = true;
            else manager.log.warn(`[credits] extend ${s.holdId} failed: ${err && err.message}`);
        }).finally(() => { s.pending = null; });
    }

    function observe(delta) {
        if (!s.holdId || s.settled || s.released || s.extensionRefused) return;
        const text = deltaText(delta);
        if (!text) return;
        s.streamedChars += text.length;
        maybeExtend();
    }

    function usageOf(usage = {}) {
        const cached = Math.max(0, Math.trunc(Number(usage.cached) || 0));
        const cacheWrite = Math.max(0, Math.trunc(Number(usage.cache_write) || 0));
        const whole = Math.max(0, Math.trunc(Number(usage.input) || 0));
        return { input_tokens: Math.max(0, whole - cached - cacheWrite), cached_read_tokens: cached, cache_write_tokens: cacheWrite, output_tokens: Math.max(0, Math.trunc(Number(usage.output) || 0)) };
    }

    /** One settle, with the four token counts, the answering card, the supply cost and the attempts. */
    async function settle({ usage = {}, supplyCostUsd = 0, attempts = [] } = {}) {
        if (!s.holdId || s.settled || s.released) return null;
        if (s.pending) await s.pending;
        const supply = Math.ceil(Math.max(0, Number(supplyCostUsd) || 0) * NANO_PER_USD);
        const body = {
            idempotency_key: settleKey,
            usage: usageOf(usage),
            retail: s.retail,
            supply_cost_nano_usd: String(Number.isSafeInteger(supply) ? supply : 0),
            byok: false,
            attempts: Array.isArray(attempts) ? attempts : [],
        };
        s.settled = true;
        try {
            return await manager.settle(s.holdId, body, s.requestId);
        } catch (err) {
            s.settled = false;
            throw err;
        }
    }

    /** Release a hold whose request never produced a token; harmless when no hold was ever made. */
    async function release() {
        if (!s.holdId || s.settled || s.released) return null;
        s.released = true;
        try {
            return await manager.release(s.holdId, s.requestId);
        } catch (err) {
            s.released = false;
            throw err;
        }
    }

    return {
        onRoute, observe, settle, release, projectedNano, usageOf, requestId: s.requestId,
        get holdId() { return s.holdId; }, get heldNano() { return s.heldNano; }, get retail() { return s.retail; },
        get streamedChars() { return s.streamedChars; }, get settled() { return s.settled; }, get released() { return s.released; },
        get inputTokens() { return s.inputTokens; },
    };
}

/**
 * The manager the service builds at boot (null when AI_CREDITS is off, so `runs` never touches Billing).
 * `tokens` is injectable for tests; production mints a service token for openvibe.billing with the four caps.
 */
function createCredits({ config, registry = null, env = process.env, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, log = console, tokens = null, networkUrl = '' }) {
    const cfg = (config && config.credits) || {};
    if (!cfg.enabled) return null;
    const billingUrl = String(cfg.billingUrl || '').replace(/\/+$/, '');
    const clientSecret = env.OV_OAUTH_CLIENT_SECRET;
    const network = String(networkUrl || cfg.networkUrl || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    let tokenClient = tokens;
    if (!tokenClient && clientSecret) {
        tokenClient = createServiceTokenClient({
            tokenUrl: `${network}/oauth/token`, clientId: (config.console && config.console.clientId) || env.OV_OAUTH_CLIENT_ID || 'ai',
            clientSecret, scope: { [cfg.audience || 'openvibe.billing']: CAPABILITIES }, fetch: fetchImpl,
        });
    }
    const available = Boolean(billingUrl && tokenClient);
    if (!available) log.warn('[credits] AI_CREDITS is on but Billing is not configured (OV_BILLING_INTERNAL_URL / OV_OAUTH_CLIENT_SECRET); paid managed requests will be refused');
    const billing = available ? createBillingClient({ billingUrl, audience: cfg.audience || 'openvibe.billing', tokens: tokenClient, fetchImpl, timeoutMs: cfg.timeoutMs || 5000 }) : null;

    const manager = {
        enabled: true,
        log,
        accessOf: accessOfProvider,
        async hold(body, requestId) {
            if (!billing) throw new AiError(503, 'billing.unavailable', 'Billing Credits is not configured on this service');
            return billing.hold(body, requestId);
        },
        async extend(holdId, body, requestId) {
            if (!billing) throw new AiError(503, 'billing.unavailable', 'Billing Credits is not configured on this service');
            return billing.extend(holdId, body, requestId);
        },
        async settle(holdId, body, requestId) {
            if (!billing) throw new AiError(503, 'billing.unavailable', 'Billing Credits is not configured on this service');
            return billing.settle(holdId, body, requestId);
        },
        async release(holdId, requestId) {
            if (!billing) throw new AiError(503, 'billing.unavailable', 'Billing Credits is not configured on this service');
            return billing.release(holdId, requestId);
        },
        /**
         * Begin a request's Credits session, or null when nothing can be billed (no project, a cache hit, or a run
         * whose payer is not known). `requestId` is the API's request id: the hold and settle keys.
         */
        begin({ requestId, ctx = {}, input = {}, attribution = null, onBehalfOf = null, credentialId = null } = {}) {
            const projectId = projectOf({ projectId: ctx.projectId, attribution });
            const subject = subjectOf({ onBehalfOf, appId: ctx.appId, requesterType: ctx.requesterType, requesterId: ctx.requesterId });
            if (!subject || !projectId) return null;
            if (ctx.byok) return null;                           // a credential/project provider: no managed route in this run
            const requestKey = String(requestId || `${ctx.runId || ''}:${clock.now()}`);
            const inputTokens = approxTokens(JSON.stringify(input || {})) + 16;
            const maxCostNano = ctx.maxCostUsd != null ? nanoFromUsd(ctx.maxCostUsd) : null;
            return createSession({ manager, requestId: requestKey, subject, projectId, credentialId, inputTokens, maxCostNano, startedAt: iso(clock.now()) });
        },
    };
    return manager;
}

/** A provider record's commercial access (the catalog's rule), for the attempts a settle reports. */
function accessOfProvider(provider) {
    try { return require('./providers/model-catalog').accessOf(provider); } catch { return null; }
}

module.exports = { createCredits, createBillingClient, createSession, retailOf, retailChargeNano, nanoFromUsd, deltaText, subjectOf, projectOf, accessOfProvider, CAPABILITIES, MANAGED_ACCESS };
