'use strict';
/**
 * OpenVibe AI ↔ Billing Balance (AI Exchange F, P7; CHECKPOINT D2, D9, D10, D12), behind `AI_CREDITS` (off).
 *
 * A request on a PAID MANAGED route (the catalog's `provider_access` is OWN_DEPLOYMENT or AUTHORIZED_WHOLESALE)
 * reserves its worst case before any provider is called:
 *
 *     hold = ceil(input estimate × retail input) + ceil(max_tokens × retail output) + per-request
 *
 * capped by the caller's optional `max_cost_usd` (parsed as an exact decimal, at most 9 fractional digits, finer
 * digits rounded up to the next nano-USD; never a float). The hold is keyed by the request id and fingerprinted
 * with the resolved model, the token caps, the retail rate version, the payer and the project. Billing's 402
 * `billing.insufficient_funds` becomes AI's own 402 before the provider runs; any other Billing failure fails
 * closed (503 `billing.unavailable`) rather than serving unpaid capacity.
 *
 * Who pays (D12). An app's run holds against its PROJECT's Balance: the hold carries the app subject
 * ({ type: 'app', id }) and its project_id, and Billing needs no owner lookup. A person's own run holds against
 * their PERSONAL Balance: the user subject ({ type: 'user', id }) and no project_id. A first-party run with no
 * payer (no person and no app) has no account: the pool skips paid offers that carry a versioned retail card
 * (`payer_required`) rather than serve them free. A sandbox app is free-only (D10), so it never holds.
 *
 * When `max_cost_usd` binds, the affordable output is computed in BigInt from nano-USD per million tokens
 * (floor((cap - input charge - per-request) × 1e6 / output rate)); the provider receives that clamped
 * `max_tokens`. Fewer than one affordable token is a 402 before the provider. A later managed fallback whose
 * own worst case exceeds the hold extends the hold by the difference (capped by max_cost_usd, clamping its
 * output the same way); if Billing refuses the extension the attempt is skipped as `hold_not_extended`.
 *
 * While a stream runs, `observe()` estimates the output from the deltas and extends the hold in steps when the
 * projected charge nears it (capped by max_cost_usd; a refused extension never loses the usage — Billing settles
 * the overage as a recorded shortfall). At the end, one settle carries the four token counts, the answering
 * model's retail card (version included), the supply cost and the attempts the router made, in the contract's
 * exact attempt shape. The settle key is the request id too, so a retried request replays Billing's answer
 * instead of charging twice. A settle Billing cannot take is queued (`credit_settle_queue`) and retried with
 * backoff; a 409 or 422 marks the row for review. An error before the first token releases the hold; an abort
 * settles what was streamed.
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
const NANO_PER_USD = 1000000000n;
const USR_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
/** The four capabilities Billing names for AI (Contracts v0.289.1, one per operation). */
const CAPABILITIES = ['billing.credit.hold.create', 'billing.credit.hold.extend', 'billing.credit.hold.settle', 'billing.credit.hold.release'];
/** A prepaid answer has no retail charge; a settle still needs a card, and this says why the charge is zero. */
const ZERO_RETAIL = Object.freeze({ version: 'prepaid', nano_usd_per_m: Object.freeze({ input: '0', cached_read: '0', cache_write: '0', output: '0' }), per_request_nano_usd: '0' });

/**
 * `max_cost_usd` as an exact decimal amount: a JSON number is stringified first, exponent forms are refused
 * (422), up to 9 fractional digits are exact and any finer non-zero digit rounds up to the next nano-USD.
 * Returns BigInt nano-USD, or null when absent.
 */
function parseCostUsd(value, field = 'max_cost_usd') {
    if (value == null) return null;
    const raw = (typeof value === 'number' ? String(value) : String(value)).trim();
    if (!/^[0-9]+(?:\.[0-9]+)?$/.test(raw)) throw new AiError(422, 'input.invalid', `${field} must be a plain decimal amount with no exponent (for example 0.000000001)`);
    const [whole, frac = ''] = raw.split('.');
    let nano;
    try { nano = BigInt(whole) * NANO_PER_USD; } catch { throw new AiError(422, 'input.invalid', `${field} is too large`); }
    nano += BigInt((frac + '000000000').slice(0, 9));
    if (/[1-9]/.test(frac.slice(9))) nano += 1n;
    // Billing's money fields are 1-19 digits; a bigger amount is refused here rather than by Billing later.
    if (nano >= 10000000000000000000n) throw new AiError(422, 'input.invalid', `${field} is too large`);
    return nano;
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

/**
 * The discounts a request may be charged at. A batch is charged at half the retail rate: every
 * component of the card is halved, and the card says so in its version.
 */
const DISCOUNTS = {
    half: { name: 'batch-half', num: 1n, den: 2n },
};

/**
 * The card a discount is charged on: the retail card with every rate halved (rounded down to the nano,
 * so the customer is never charged more than half), under a version that names the discount. Billing is
 * given this card at the hold and at the settle, so the ledger records the price actually charged.
 */
function applyDiscount(retail, discount) {
    if (!retail) return null;
    const d = DISCOUNTS[String(discount || '').toLowerCase()];
    if (!d) return retail;
    const half = (v) => {
        const n = BigInt(String(v == null ? '0' : v));
        return ((n * d.num) / d.den).toString();
    };
    const perM = retail.nano_usd_per_m || {};
    return {
        version: `${retail.version}:${d.name}`.slice(0, 200),
        nano_usd_per_m: {
            input: half(perM.input),
            cached_read: half(perM.cached_read),
            cache_write: half(perM.cache_write),
            output: half(perM.output),
        },
        per_request_nano_usd: half(retail.per_request_nano_usd),
    };
}

/** The retail charge for some usage, the same arithmetic Billing applies (used for the hold and the extension). */
function retailChargeNano(retail, { input = 0, cached = 0, cacheWrite = 0, output = 0 } = {}) {
    const perM = (retail && retail.nano_usd_per_m) || {};
    return BigInt(retail && retail.per_request_nano_usd ? retail.per_request_nano_usd : '0')
        + chargeNano(input, perM.input) + chargeNano(cached, perM.cached_read)
        + chargeNano(cacheWrite, perM.cache_write) + chargeNano(output, perM.output);
}

/**
 * The hold a request can afford: its own card, the input estimate and the requested output cap, clamped by
 * max_cost_usd. Returns { maxTokens, amount }; throws 402 when the cap cannot buy even one output token.
 */
function affordable(retail, { inputTokens, maxTokens, maxCostNano = null }) {
    const perM = retail.nano_usd_per_m || {};
    const base = BigInt(retail.per_request_nano_usd || '0') + chargeNano(inputTokens, perM.input);
    const requested = Math.max(1, Math.trunc(Number(maxTokens) || 1024));
    let tokens = requested;
    if (maxCostNano != null) {
        if (maxCostNano < base) throw new AiError(402, 'billing.insufficient_funds', 'max_cost_usd is below this request\'s minimum cost');
        const rate = BigInt(String(perM.output == null ? '0' : perM.output));
        if (rate > 0n) {
            // floor((cap - base) × 1e6 / rate-per-million), in BigInt: the review's D1 arithmetic.
            const can = ((maxCostNano - base) * PER_MILLION) / rate;
            if (can < 1n) throw new AiError(402, 'billing.insufficient_funds', 'max_cost_usd leaves no room for any output token');
            if (can < BigInt(tokens)) tokens = Number(can);
        }
    }
    const amount = base + chargeNano(tokens, perM.output);
    return { maxTokens: tokens, amount };
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

/**
 * Who pays (D12): an app (subject { type: 'app', id }) holds against its project's Balance; otherwise a person
 * (the request's `on_behalf_of`, subject { type: 'user', id }) holds against their personal Balance. An app is
 * always the app, whatever claim a service set on its token. A first-party service with neither has no payer and
 * gets no session (the pool refuses it paid offers).
 */
function payerOf({ onBehalfOf = null, appId = null } = {}) {
    if (appId) return { type: 'app', id: String(appId) };
    if (onBehalfOf && USR_RE.test(String(onBehalfOf))) return { type: 'user', id: String(onBehalfOf) };
    return null;
}

/** The project whose Balance an app's hold spends: its own project, never a person's attribution. */
function projectOf({ projectId = null, attribution = null } = {}) {
    if (projectId && PROJECT_RE.test(String(projectId))) return String(projectId);
    const id = attribution && attribution.type === 'project' ? String(attribution.id || '') : '';
    return PROJECT_RE.test(id) ? id : null;
}

/** A Billing error -> the API's own error: 402 keeps its code, everything else fails closed as unavailable. */
function billingError(status, body, what) {
    const detail = (body && (body.detail || body.title || body.message)) || `Billing ${what} failed`;
    // The public word is Balance, never Credits: 402 keeps its code and says what is short.
    if (status === 402) return new AiError(402, 'billing.insufficient_funds', 'Not enough Balance');
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
 * One request's Balance session. Created by `begin()`; the run drives it:
 *
 *   onRoute(facts, meta)   before each provider attempt; returns { maxTokens } to clamp the attempt,
 *                          { skip: 'hold_not_extended' } to pass on that offer, or null (not a Balance offer)
 *   observe(delta)         each streamed delta; extends the hold when the output nears it
 *   settle({...})          once, after the answer (or after the partial usage of an abort/failure)
 *   release()              once, when no token was produced at all
 */
function createSession({ manager, requestId, payer, projectId, credentialId = null, inputTokens, maxCostNano = null, startedAt, discount = null, costCheck = null }) {
    const s = {
        requestId: String(requestId),
        payer, projectId, credentialId,
        // A batch's settle is refused when the route really cost more than the customer was charged.
        costCheck: typeof costCheck === 'function' ? costCheck : null,
        subject: payer,
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
     * The first managed paid attempt holds its worst case. A later managed fallback with a bigger worst case
     * extends the hold by the difference (never above max_cost_usd); a refused extension skips that offer.
     */
    async function onRoute(facts, meta) {
        if (s.settled || s.released) return null;
        if (!meta) return null;                                                   // a person's own key or machine
        // The card this request is charged on: the retail card, halved when the request is a batch.
        const base = retailOf(meta.retail);
        const card = applyDiscount(base, discount);
        // The answering offer's own price before the batch discount, and which offer answered: a batch's
        // settle check needs both to know what the route really cost.
        s.retailBase = base;
        s.answeredProvider = meta && meta.provider;
        s.answeredModel = meta && meta.model;
        // A prepaid offer (free, subscription, BYOK, the stub) never spends Balance. After an earlier managed
        // attempt it may still answer (a free fallback): the settle then uses its card, or zero.
        if (meta.paid === false) { if (s.holdId) s.retail = card || ZERO_RETAIL; return null; }
        if (!MANAGED_ACCESS.has(facts && facts.provider_access)) return null;     // BYOK/unverified: no managed offer
        const retail = card;
        if (!retail) throw new AiError(503, 'billing.rate_unavailable', 'this route has no versioned retail rate card, so its credit cannot be held');
        const requested = Math.max(1, Math.trunc(Number(meta.maxTokens) || 1024));
        let plan;
        try {
            plan = affordable(retail, { inputTokens: s.inputTokens, maxTokens: requested, maxCostNano: s.maxCostNano });
        } catch (err) {
            // The first offer cannot be bought at this cap: 402 before the provider. A fallback simply cannot be
            // covered, so it is skipped and a cheaper offer (or a later failure) decides the run.
            if (s.holdId) return { skip: 'hold_not_extended' };
            throw err;
        }
        s.retail = retail;
        if (!s.holdId) {
            s.heldNano = plan.amount;
            const fingerprint = sha256({
                resolved_model: (facts && facts.resolved_model) || null, revision: (facts && facts.revision) || null,
                input_tokens: s.inputTokens, output_tokens: plan.maxTokens, max_cost_usd: s.maxCostNano == null ? null : String(s.maxCostNano),
                rate_version: retail.version, subject: s.subject, project_id: s.projectId,
            });
            // D12: an app names its project's Balance; a person's hold is personal and carries no project_id.
            const created = await manager.hold({
                idempotency_key: holdKey, subject: s.subject, ...(s.projectId ? { project_id: s.projectId } : {}), ...(s.credentialId ? { credential_id: s.credentialId } : {}),
                max_nano_usd: String(plan.amount), rate_version: retail.version, request_fingerprint: fingerprint, service: 'ai',
            }, s.requestId);
            s.holdId = created.hold_id;
            s.heldNano = BigInt(String(created.held_nano_usd == null ? plan.amount : created.held_nano_usd));
            return { maxTokens: plan.maxTokens };
        }
        if (plan.amount > s.heldNano) {
            const add = plan.amount - s.heldNano;
            try {
                await manager.extend(s.holdId, { add_nano_usd: String(add) }, s.requestId);
                s.heldNano = plan.amount;
            } catch (err) {
                if (err && (err.code === 'billing.insufficient_funds' || err.code === 'billing.conflict')) return { skip: 'hold_not_extended' };
                throw err;
            }
        }
        return { maxTokens: plan.maxTokens };
    }

    /**
     * BA2: the hold of a batch run. The provider's batch API answers later, so no provider attempt
     * happens before the answer and there is nothing for onRoute to hold on. The hold is taken here
     * instead, on the same card the ordinary path would have used: the retail card, halved when the
     * request is a batch. A provider the network has no managed access to is not held for (fail closed:
     * nobody is charged and the network carries the cost).
     */
    async function holdRoute({ card = null, provider = null, model = null, access = null, maxTokens = 4096 } = {}) {
        if (s.settled || s.released) return null;
        if (!card || !card.nano_usd_per_m) return null;
        const base = card;
        const retail = applyDiscount(base, discount);
        s.retailBase = base;
        s.answeredProvider = provider;
        s.answeredModel = model;
        if (!MANAGED_ACCESS.has(String(access || ''))) return null;    // not a managed paid offer: nobody is charged
        if (!retail) return null;
        const plan = affordable(retail, { inputTokens: s.inputTokens, maxTokens });
        s.retail = retail;
        if (!s.holdId) {
            s.heldNano = plan.amount;
            const fingerprint = sha256({
                resolved_model: model || null, revision: null,
                input_tokens: s.inputTokens, output_tokens: plan.maxTokens, max_cost_usd: s.maxCostNano == null ? null : String(s.maxCostNano),
                rate_version: retail.version, subject: s.subject, project_id: s.projectId,
            });
            const created = await manager.hold({
                idempotency_key: holdKey, subject: s.subject, ...(s.projectId ? { project_id: s.projectId } : {}), ...(s.credentialId ? { credential_id: s.credentialId } : {}),
                max_nano_usd: String(plan.amount), rate_version: retail.version, request_fingerprint: fingerprint, service: 'ai',
            }, s.requestId);
            s.holdId = created.hold_id;
            s.heldNano = BigInt(String(created.held_nano_usd == null ? plan.amount : created.held_nano_usd));
        }
        return { maxTokens: plan.maxTokens };
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
        // A batch settles only when the route it really used costs at most what the customer was charged.
        // When it does not, the hold is released, nothing is charged, and the caller keeps waiting.
        if (s.costCheck) {
            const check = await s.costCheck({ usage: usageOf(usage), retail: s.retail, retailBase: s.retailBase, provider: s.answeredProvider, model: s.answeredModel, supplyCostUsd });
            if (check && check.ok === false) {
                await release();
                const err = new Error(check.reason || 'the route cost more than the customer was charged');
                err.code = 'batch.cost_exceeded';
                err.status = 409;
                throw err;
            }
        }
        // The provider's own cost comes as a float from the rate cards; turn it into integer nano-USD through a
        // decimal string (never a nano conversion by float multiplication).
        let supply = 0n;
        if (Number.isFinite(supplyCostUsd) && supplyCostUsd > 0) {
            try { supply = parseCostUsd(Number(supplyCostUsd).toFixed(9)) || 0n; } catch { supply = 0n; }
        }
        const body = {
            idempotency_key: settleKey,
            usage: usageOf(usage),
            retail: s.retail,
            supply_cost_nano_usd: String(supply),
            byok: false,
            attempts: Array.isArray(attempts) ? attempts : [],
        };
        s.settled = true;
        try {
            return await manager.settle(s.holdId, body, s.requestId);
        } catch (err) {
            s.settled = false;
            // Durable: Billing may be down or slow now; the same body and key are retried by the outbox.
            if (manager.enqueueSettle) {
                try { await manager.enqueueSettle({ holdId: s.holdId, requestId: s.requestId, body, error: err }); }
                catch (qerr) { manager.log.warn(`[credits] queue settle ${settleKey} failed: ${qerr && qerr.message}`); }
            }
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
        onRoute, holdRoute, observe, settle, release, projectedNano, usageOf, requestId: s.requestId,
        get holdId() { return s.holdId; }, get heldNano() { return s.heldNano; }, get retail() { return s.retail; },
        get streamedChars() { return s.streamedChars; }, get settled() { return s.settled; }, get released() { return s.released; },
        get inputTokens() { return s.inputTokens; }, get payer() { return s.payer; },
    };
}

/**
 * The manager the service builds at boot (null when AI_CREDITS is off, so `runs` never touches Billing).
 * `tokens` is injectable for tests; production mints a service token for openvibe.billing (the four hold
 * capabilities). Network is reached only for the OAuth token, never to resolve a project's owner (D12).
 */
function createCredits({ config, db = null, registry = null, env = process.env, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, log = console, tokens = null, networkUrl = '' }) {
    const cfg = (config && config.credits) || {};
    if (!cfg.enabled) return null;
    const billingUrl = String(cfg.billingUrl || '').replace(/\/+$/, '');
    const clientSecret = env.OV_OAUTH_CLIENT_SECRET;
    const network = String(networkUrl || cfg.networkUrl || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    const clientId = (config.console && config.console.clientId) || env.OV_OAUTH_CLIENT_ID || 'ai';
    let tokenClient = tokens;
    if (!tokenClient && clientSecret) {
        tokenClient = createServiceTokenClient({
            tokenUrl: `${network}/oauth/token`, clientId, clientSecret,
            scope: { [cfg.audience || 'openvibe.billing']: CAPABILITIES }, fetch: fetchImpl,
        });
    }
    const available = Boolean(billingUrl && tokenClient);
    if (!available) log.warn('[credits] AI_CREDITS is on but Billing is not configured (OV_BILLING_INTERNAL_URL / OV_OAUTH_CLIENT_SECRET); paid managed requests will be refused');
    const billing = available ? createBillingClient({ billingUrl, audience: cfg.audience || 'openvibe.billing', tokens: tokenClient, fetchImpl, timeoutMs: cfg.timeoutMs || 5000 }) : null;

    const settlements = db && billing
        ? require('./credit-settlements').createCreditSettlements({
            db, clock, log, registry,
            send: (row) => billing.settle(row.hold_id, row.body, row.request_id),
            retryMs: cfg.settleRetryMs, maxRetryMs: cfg.settleMaxRetryMs,
        })
        : null;

    const manager = {
        enabled: true,
        log,
        accessOf: accessOfProvider,
        async hold(body, requestId) {
            if (!billing) throw new AiError(503, 'billing.unavailable', 'Billing is not configured on this service, so Balance cannot be held');
            return billing.hold(body, requestId);
        },
        async extend(holdId, body, requestId) {
            if (!billing) throw new AiError(503, 'billing.unavailable', 'Billing is not configured on this service, so Balance cannot be held');
            return billing.extend(holdId, body, requestId);
        },
        async settle(holdId, body, requestId) {
            if (!billing) throw new AiError(503, 'billing.unavailable', 'Billing is not configured on this service, so Balance cannot be held');
            return billing.settle(holdId, body, requestId);
        },
        async release(holdId, requestId) {
            if (!billing) throw new AiError(503, 'billing.unavailable', 'Billing is not configured on this service, so Balance cannot be held');
            return billing.release(holdId, requestId);
        },
        enqueueSettle: settlements ? (row) => settlements.enqueue(row) : null,
        drainSettlements: settlements ? (opts) => settlements.runOnce(opts) : async () => ({ skipped: 'disabled' }),
        pendingSettlements: settlements ? () => settlements.pending() : async () => [],
        startSettlements: settlements ? () => settlements.start() : () => null,
        stopSettlements: settlements ? () => settlements.stop() : () => {},
        /**
         * Begin a request's Balance session, or null when there is no payer (the pool then refuses paid offers
         * that carry a versioned card), when an app names no project, or for a BYOK run (no managed route).
         */
        begin({ requestId, ctx = {}, input = {}, attribution = null, onBehalfOf = null, credentialId = null, personPayer = true } = {}) {
            // personPayer false: a service named the person, and only their own session token (or a subject
            // assertion they authorised) may spend their Balance. The run gets no hold of theirs.
            const payer = payerOf({ onBehalfOf: personPayer ? (onBehalfOf || ctx.onBehalfOf || null) : null, appId: ctx.appId });
            if (!payer) return null;
            // D12: an app spends its project's Balance; a person's own run is personal, so an attribution is
            // never turned into a project_id on a user's hold.
            const projectId = payer.type === 'app' ? projectOf({ projectId: ctx.projectId, attribution }) : null;
            if (payer.type === 'app' && !projectId) return null;
            if (ctx.byok) return null;                           // a credential/project provider: no managed route in this run
            const requestKey = String(requestId || ctx.runId || '');
            if (!requestKey) return null;                        // no stable key: never invent one from the clock
            const inputTokens = approxTokens(JSON.stringify(input || {})) + 16;
            let maxCostNano = null;
            if (ctx.maxCostNano != null) {
                try { maxCostNano = BigInt(String(ctx.maxCostNano)); } catch { throw new AiError(422, 'input.invalid', 'max_cost_usd is invalid'); }
            } else if (ctx.maxCostUsd != null) maxCostNano = parseCostUsd(ctx.maxCostUsd);
            return createSession({ manager, requestId: requestKey, payer, projectId, credentialId, inputTokens, maxCostNano, startedAt: iso(clock.now()), discount: ctx.discount || null, costCheck: ctx.costCheck || null });
        },
    };
    return manager;
}

/** A provider record's commercial access (the catalog's rule), for the attempts a settle reports. */
function accessOfProvider(provider) {
    try { return require('./providers/model-catalog').accessOf(provider); } catch { return null; }
}

module.exports = {
    createCredits, createBillingClient, createSession, retailOf, applyDiscount, retailChargeNano, affordable, parseCostUsd,
    deltaText, payerOf, projectOf, accessOfProvider, CAPABILITIES, MANAGED_ACCESS,
};
