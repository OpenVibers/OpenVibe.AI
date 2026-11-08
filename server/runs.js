'use strict';
/**
 * Runs: create (idempotent), cache, quota, execute (sync with wait, or queued), cancel, retry.
 *
 * Order of a create, which is what the guarantees rest on:
 *   1. the workflow's newest ACTIVE version is resolved and the input validated against its schema
 *   2. idempotency: the same (requester, idempotency_key) returns the existing run; a different
 *      input under the same key is a 409 idempotency.conflict
 *   3. cache: a hit in THIS request's scope becomes a run with status 'cached' (no provider call)
 *   4. quota: every applicable quota is checked and counted — a refusal is a 429 before any
 *      provider is touched
 *   5. queue caps: a run that would have to wait is refused (429 queue.full + Retry-After) when the
 *      queue already holds AI_MAX_QUEUED_RUNS runs, or AI_MAX_QUEUED_RUNS_PER_CALLER of this
 *      requester's, so one caller cannot fill the queue for everyone — also before any provider call
 *   6. the run is stored 'queued' and executed (inline up to ?wait=ms, else by the worker)
 * Every create, cancel and retry writes an audit row. Output is attributable to workflow + version
 * + template version + route version + provider/model + run id — never to a person.
 */
const { ids } = require('openvibe-contracts');
const { AiError, sha256, stableStringify, parseJson, iso } = require('./util');
const { parseCostUsd } = require('./credits');
const { CACHE_INPUT } = require('./workflows/hooks');
const { preferenceLines } = require('./user-modules');
const { preferredTarget } = require('./providers/task');
const latency = require('./latency');
const tier = require('./policy/tier');
const schemas = require('./schemas');
const events = require('./events');
const usageRecord = require('./usage-record');
const usageSamples = require('./usage-samples');
const { buildReceipt } = require('./exchange/receipts');
const privacy = require('./exchange/privacy');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'cached']);
const QUEUE_RETRY_AFTER_S = 5;
const newRunId = () => `run_${ids.ulid()}`;

function entityKey(ref) { return ref ? `${ref.service}:${ref.type}:${ref.id}` : null; }
function subjectKey(ref) { return ref ? `${ref.type}:${ref.id}` : null; }

/**
 * What a run record keeps of its input. Inline images are replaced by their hash and size (they
 * would bloat every row and are not needed after the call). A passthrough workflow's input IS the
 * caller's raw prompt, so it is not kept at all unless raw debug logging is on and the caller
 * opted in — only its hash (the run still has input_hash). Such runs cannot be retried.
 */
function retainedInput(input, wf, debugRaw) {
    const passthrough = wf.metadata && (wf.metadata.passthrough || wf.metadata.retain_input === false);
    if (passthrough && !debugRaw) return { value: { not_retained: 'passthrough prompt; see input_hash' }, full: false };
    let redacted = false;
    const walk = (v) => {
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') {
            const out = {};
            for (const [k, x] of Object.entries(v)) {
                if (k === 'data_url' && typeof x === 'string' && x.length > 256) {
                    redacted = true;
                    out.data_url_sha256 = sha256(x);
                    out.data_url_bytes = x.length;
                } else out[k] = walk(x);
            }
            return out;
        }
        return v;
    };
    const value = walk(input);
    return { value, full: !redacted };
}

// An app's own provider for ai.complete (POST /v1/chat/completions, x_openvibe.provider): an OpenAI-format API at an
// https base URL, its model, and the name of the project secret that holds its key (ADR-056 names).
const SECRET_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
function projectProviderOf(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new AiError(422, 'input.invalid', 'provider must be { base_url, model, secret }');
    let u;
    try { u = new URL(String(spec.base_url || '')); } catch { throw new AiError(422, 'input.invalid', 'provider.base_url must be a URL'); }
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new AiError(422, 'input.invalid', 'provider.base_url must be https, without credentials, query or fragment');
    if (!MODEL_RE.test(String(spec.model || ''))) throw new AiError(422, 'input.invalid', 'provider.model must name the model (letters, digits and . _ : / @ + -, at most 200)');
    if (!SECRET_NAME_RE.test(String(spec.secret || ''))) throw new AiError(422, 'input.invalid', 'provider.secret must be the name of a project secret (lower case, at most 64)');
    return { base_url: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, model: String(spec.model), secret: String(spec.secret) };
}

/**
 * A generate run's `route: { provider, model }`: one offer from GET /api/v1/routes. Only a first-party
 * service may ask for one, and only on the generate operation; the offer itself is checked against the
 * routing's own list later, once the run's route is resolved.
 */
const ROUTE_PIN_KEYS = new Set(['provider', 'model']);
function routePinRequest(value, principal, wf) {
    if (value == null) return null;
    if (principal.kind === 'app') throw new AiError(403, 'capability.denied', 'a developer app may not pin a route; use the routing pool');
    if (!principal.subject || principal.subject.type !== 'service') throw new AiError(403, 'capability.denied', 'only a first-party service may pin a route');
    if (!wf || wf.key !== 'ai.generate') throw new AiError(422, 'input.invalid', 'route pinning is available on the generate operation (ai.generate) only');
    if (typeof value !== 'object' || Array.isArray(value)) throw new AiError(422, 'input.invalid', 'route must be { provider, model }');
    for (const k of Object.keys(value)) if (!ROUTE_PIN_KEYS.has(k)) throw new AiError(422, 'input.invalid', `route has no field ${k}; send { provider, model }`);
    const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
    if (!provider || provider.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(provider)) {
        throw new AiError(422, 'input.invalid', 'route.provider must name a provider from GET /api/v1/routes');
    }
    let model = null;
    if (value.model != null) {
        if (typeof value.model !== 'string') throw new AiError(422, 'input.invalid', 'route.model must be a model name or null');
        model = value.model.trim();
        if (!model || model.length > 200) throw new AiError(422, 'input.invalid', 'route.model must be a model name or null');
    }
    return { provider, model };
}

function createRuns({ db, registry, engine, cache, quotas, config, clock = { now: () => Date.now() }, log = console, userModules = null, credentials = null, preferences: personPreferences = null, tiers = null, projectSecrets = null, pool = null, runBudgets = null, credits = null, community = null, presets = null, receipts = null, abuse = null, webhooks = null, batchWaiting = null }) {
    const inflight = new Map();     // run id -> { controller, promise, release, caller }
    // BA2: the runs that wait for a provider's own batch API: they are created at once and finish later.
    const deferred = new Map();     // run id -> { controller, scope, ctx, input, hold, resolveDone }
    const queue = [];               // run ids waiting for the worker
    let active = 0;
    let shuttingDown = false;

    function decode(r) {
        if (!r) return null;
        return {
            id: r.id, status: r.status,
            workflow: { key: r.workflow_key, version: r.workflow_version },
            template: r.template_key ? { key: r.template_key, version: r.template_version } : null,
            route: r.route_key ? { key: r.route_key, version: r.route_version } : null,
            requester: { type: r.requester_type, id: r.requester_id },
            on_behalf_of: parseJson(r.on_behalf_of, null),
            attribution: parseJson(r.attribution, null),
            source_service: r.source_service,
            target: parseJson(r.target, null),
            input: parseJson(r.input, null),
            output: parseJson(r.output, null),
            error: r.error_code ? { code: r.error_code, detail: r.error_detail } : null,
            synthetic: Boolean(r.synthetic),
            provenance: {
                origin: 'ai', workflow: r.workflow_key, workflow_version: r.workflow_version, template_version: r.template_version, route: r.route_key, route_version: r.route_version,
                provider: r.provider_key, model: r.model_key, fallback_used: Boolean(r.fallback_used), run_id: r.id, cached_from: r.cached_from, synthetic: Boolean(r.synthetic),
            },
            // BA1: how long the caller may wait, and the tier the run really ran on.
            latency_class: r.latency_class || latency.DEFAULT,
            service_tier: r.service_tier || null,
            // BA3: a caller that asked for a faster class than the workflow allows is told so (the class asked
            // for and the class the run really ran in); nothing else about the run changes.
            latency_clamped: (parseJson(r.options, {}) || {}).latency_clamped || null,
            usage: { tokens_in: r.tokens_in, tokens_out: r.tokens_out, cost_usd: r.cost_usd, attempts: r.attempts, usage_sample_ids: r.usage_sample_ids || (r.usage_sample_id ? [r.usage_sample_id] : null) },
            explain: parseJson(r.explain, null),
            citations_count: r.citations_count,
            grounding: parseJson(r.grounding, null),
            retry_of: r.retry_of,
            idempotency_key: r.idempotency_key,
            trace_id: r.trace_id,
            created_at: r.created_at, started_at: r.started_at, finished_at: r.finished_at,
        };
    }
    const getRow = async (id) => await db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    const get = async (id) => decode(await getRow(id));

    async function citations(runId) {
        return (await db.prepare('SELECT * FROM citations WHERE run_id = ? ORDER BY ordinal, id').all(runId))
            .map(c => ({ ...c, trust: parseJson(c.trust, {}), provenance: parseJson(c.provenance, {}) }));
    }
    async function addCitations(runId, list, attachedBy) {
        const ins = db.prepare(`INSERT INTO citations (run_id, ordinal, source_type, source_id, url, title, author, published_at, retrieved_at, snippet, content_hash, trust, provenance, attached_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const base = (await db.prepare('SELECT COUNT(*) AS n FROM citations WHERE run_id = ?').get(runId)).n;
        await db.tx(async () => {
            for (const [i, c] of list.entries()) await ins.run(runId, c.ordinal != null ? c.ordinal : base + i, c.source_type, c.source_id || null, c.url || null, c.title || null, c.author || null,
                c.published_at || null, c.retrieved_at || null, c.snippet || null, c.content_hash || null, JSON.stringify(c.trust || {}), JSON.stringify(c.provenance || {}), attachedBy, iso(clock.now()));
            await db.prepare('UPDATE runs SET citations_count = (SELECT COUNT(*) FROM citations WHERE run_id = ?) WHERE id = ?').run(runId, runId);
        });
    }

    const insReq = db.prepare(`INSERT INTO requests (run_id, seq, operation, provider_key, model_key, route_key, route_version, status, skip_reason, fallback, prompt_hash, input_hash, output_hash,
        tokens_in, tokens_out, tokens_cached, tokens_estimated, cost_usd, latency_ms, error, debug_prompt, debug_response, created_at)
        VALUES (@run_id, @seq, @operation, @provider_key, @model_key, @route_key, @route_version, @status, @skip_reason, @fallback, @prompt_hash, @input_hash, @output_hash,
        @tokens_in, @tokens_out, @tokens_cached, @tokens_estimated, @cost_usd, @latency_ms, @error, @debug_prompt, @debug_response, @created_at)`);

    // ── Create ─────────────────────────────────────────────
    function validateRefs(body) {
        const { validate } = require('openvibe-contracts');
        if (body.target != null) {
            const v = validate('common.entity-ref@1', body.target);
            if (!v.valid) throw new AiError(422, 'input.invalid', `target is not an EntityRef: ${v.errors.map(e => `${e.path} ${e.message}`).join('; ')}`);
        }
        if (body.attribution != null) {
            const v = validate('common.entity-ref@1', body.attribution);
            if (!v.valid) throw new AiError(422, 'input.invalid', `attribution is not an EntityRef: ${v.errors.map(e => `${e.path} ${e.message}`).join('; ')}`);
        }
        if (body.on_behalf_of != null) {
            const v = validate('identity.subject-ref@1', body.on_behalf_of);
            if (!v.valid) throw new AiError(422, 'input.invalid', 'on_behalf_of is not a SubjectRef');
        }
    }

    /**
     * body: { workflow, version?, input, target?, attribution?, on_behalf_of?, idempotency_key?, options?: { cache, debug } }
     * principal: { sub, subject: {type, id} }
     * Returns { run, created, promise? }.
     */
    async function create(body, principal, { trace = null, requestId = null, retryOf = null, onDelta = null, onRoute = null, abuse: requestAbuse = null, discount = null, exact = null, costCheck = null, communityOfferId = null, callerWaitMs = 0 } = {}) {
        if (!body || typeof body !== 'object') throw new AiError(400, 'input.invalid', 'JSON body required');
        const wfKey = String(body.workflow || '');
        const wf = body.version ? await registry.getWorkflow(wfKey, Number(body.version)) : await registry.activeWorkflow(wfKey);
        if (!wf) throw new AiError(404, 'workflow.not_found', `no active workflow ${wfKey}${body.version ? ` v${body.version}` : ''}`);
        if (body.version && !['active', 'deprecated'].includes(wf.status)) throw new AiError(409, 'workflow.inactive', `${wfKey} v${wf.version} is ${wf.status}`);
        const pinned = routePinRequest(body.route, principal, wf);
        if (pinned && body.credential != null) throw new AiError(422, 'input.invalid', 'a pinned route cannot be combined with a person\'s credential; the pin is the provider');
        // A run token names the person it acts for (Codes C3, `on_behalf_of` in the claims). The run records that
        // person exactly as a body field would, so they pay, the run is theirs and caches never cross persons. The
        // body may repeat the claim but never change it; an app's run is its project's (server/api/runs.js appBody),
        // so the claim is left alone there.
        if (principal.kind !== 'app' && principal.onBehalfOf != null) {
            const claimed = String(principal.onBehalfOf);
            const given = body.on_behalf_of && body.on_behalf_of.id != null ? String(body.on_behalf_of.id) : null;
            if (given != null && given !== claimed) throw new AiError(403, 'capability.denied', 'on_behalf_of does not match the token');
            if (body.on_behalf_of == null) body = { ...body, on_behalf_of: { type: 'user', id: claimed } };
        }
        validateRefs(body);
        // The Exchange remake's content policy. It is a control field, never part of the workflow's input; the pool
        // enforces the 18+ gate and the offer filter (server/providers/index.js), and the answer carries the label.
        const askedPolicy = tier.parsePolicy(body.policy != null ? body.policy : body.options && body.options.policy);
        if (askedPolicy.error) throw new AiError(422, askedPolicy.error, askedPolicy.detail);
        const contentPolicy = askedPolicy.policy;
        const input = body.input === undefined ? {} : body.input;
        const inputJson = stableStringify(input);
        if (Buffer.byteLength(inputJson) > config.runs.maxInputBytes) throw new AiError(413, 'input.too_large', `input is larger than ${config.runs.maxInputBytes} bytes`);
        const v = schemas.validate(wf.input_schema, input);
        if (!v.valid) throw new AiError(422, 'input.invalid', `input does not match ${wf.key} v${wf.version}`, { errors: v.errors });
        const inputHash = sha256(inputJson);
        const requester = principal.subject;
        // A developer app (ADR-014): the requester IS its project, the run is metered with the project's
        // id on every Billing reading, and a sandbox run may use free/local capacity only (server/providers).
        const app = principal.kind === 'app' ? { projectId: principal.projectId, sandbox: principal.env === 'sandbox' } : null;
        const idem = body.idempotency_key != null ? String(body.idempotency_key) : null;
        if (idem !== null && !/^[A-Za-z0-9._:-]{8,128}$/.test(idem)) throw new AiError(422, 'input.invalid', 'idempotency_key must be 8-128 of [A-Za-z0-9._:-]');

        if (idem) {
            const prev = await db.prepare('SELECT * FROM runs WHERE requester_type = ? AND requester_id = ? AND idempotency_key = ?').get(requester.type, requester.id, idem);
            if (prev) {
                const prevPin = parseJson(prev.options, {}).pinned_offer || null;
                if (prev.input_hash !== inputHash || prev.workflow_key !== wf.key || stableStringify(prevPin) !== stableStringify(pinned)) {
                    throw new AiError(409, 'idempotency.conflict', 'this idempotency_key was used with a different workflow, input or route');
                }
                return { run: decode(prev), created: false, promise: inflight.get(prev.id) ? inflight.get(prev.id).promise : null };
            }
        }

        const llmStep = wf.steps.find(s => s.kind === 'llm');
        const tpl = llmStep ? await registry.activeTemplate(llmStep.template) : null;
        const routeKey = (wf.steps[0] && wf.steps[0].route) || (tpl && tpl.default_route) || wf.default_route || null;
        const route = routeKey && !String(routeKey).includes('{') ? await registry.resolveRoute(routeKey) : null;
        if (pinned) {
            if (!route || route.disabled) throw new AiError(503, 'route.unavailable', `route ${routeKey || '(none)'} is not available, so its offers cannot be listed`);
            if (!pool) throw new AiError(503, 'route.unavailable', 'routing is not available on this service');
            const step = wf.steps.find((x) => x.kind === 'llm');
            const operation = (step && step.operation) || 'generate';
            const offers = await pool.offers(route, operation, { requesterType: requester.type, requesterId: requester.id });
            const offered = offers.some((o) => o.provider === pinned.provider && (pinned.model == null || o.model === pinned.model));
            if (!offered) {
                const shown = pinned.model ? `${pinned.provider}/${pinned.model}` : pinned.provider;
                throw new AiError(422, 'input.invalid', `route ${shown} is not offered for ${operation} to this caller; GET /api/v1/routes?operation=${operation} lists the offers`);
            }
        }
        const options = body.options && typeof body.options === 'object' ? body.options : {};
        // BA1: the latency class of this run. The workflow's own class is the route it uses
        // (constraints.latency_class); a caller may ask for a SLOWER class with options.latency and never a
        // faster one: a background workflow stays in the background whatever the caller asks for.
        const workflowClass = latency.ofRoute(route);
        const askedLatency = options.latency != null ? options.latency : null;
        const resolvedLatency = latency.resolve(workflowClass, askedLatency);
        if (resolvedLatency.error) throw new AiError(422, 'input.invalid', resolvedLatency.error, { latency_class: workflowClass });
        const latencyClass = resolvedLatency.class;
        // A faster class than the workflow allows was asked for: it runs in its own class, and the run's options say so.
        if (resolvedLatency.clamped) options.latency_clamped = resolvedLatency.clamped;
        // Community capacity is opt-in per request: a person's machine sees the prompt, so only a caller that says so
        // may be placed there. The OpenAI and Messages routes set body.community from x-openvibe-community.
        let communityOptIn = body.community === true || options.community === true;
        // A person's own key (WS-O task 2): only the service that stored it, within its daily budget; never cached.
        // A person's own key: the default one, or the provider the run names (Codes C3: one credential per provider).
        const credentialSubject = body.credential && typeof body.credential === 'object' ? String(body.credential.subject || '') : null;
        const credentialProvider = body.credential && typeof body.credential === 'object' && body.credential.provider != null ? String(body.credential.provider) : null;
        if (credentialSubject !== null) {
            if (!credentials) throw new AiError(503, 'credentials.unavailable', 'person credentials are not configured on this service');
            if (requester.type !== 'service') throw new AiError(403, 'capability.denied', 'only the service that stored a credential runs with it');
            await credentials.admit(requester.id, credentialSubject, credentialProvider);
        }
        // An app's own provider (ADR-056 project secret): only on ai.complete, only for an app; its key spends the
        // project's money at its provider, so no tier budget holds it (the app's quotas still count it).
        const projectProvider = body.project_provider == null ? null : projectProviderOf(body.project_provider);
        // L37: the soft preference (a provider, and a model if the caller wants one). It is a wish, not a pin.
        const prefer = preferredTarget(body.prefer);
        // The routing preset the request named (server/exchange/presets.js): its policy rides the run into the
        // router, which filters the offers with it and refuses a hard max_price no offer fits. The policy is
        // normalised here, so a caller cannot smuggle a rule the presets store would never have written. A preset
        // named without a policy is resolved by name (the built-in ones, or the caller's own), so the Exchange can
        // ask for "private" and get the one definition of it. It is named top-level (`preset`) or in the run's
        // options (`options.preset`, the shape the Exchange's chat sends).
        const preset = body.preset && typeof body.preset === 'object' && !Array.isArray(body.preset)
            ? body.preset
            : (body.options && body.options.preset && typeof body.options.preset === 'object' && !Array.isArray(body.options.preset) ? body.options.preset : null);
        let presetPolicy = null;
        let presetName = null;
        if (preset) {
            const name = String(preset.name || '').trim();
            if (!name) throw new AiError(422, 'input.invalid', 'a preset must name itself');
            presetName = name;
            const inline = preset.policy && typeof preset.policy === 'object' && Object.keys(preset.policy).length;
            if (inline) {
                presetPolicy = presets ? presets.normalizePolicy(preset.policy) : preset.policy;
            } else if (presets) {
                const resolved = await presets.resolve({ principal, name });
                presetPolicy = presets.normalizePolicy(resolved.policy);
            } else {
                presetPolicy = {};
            }
        }
        if (presetPolicy && typeof presetPolicy.community === 'boolean') communityOptIn = presetPolicy.community;
        if (projectProvider) {
            if (!app) throw new AiError(403, 'capability.denied', 'only a developer app names its project\'s own provider');
            if (wf.key !== 'ai.complete') throw new AiError(422, 'input.invalid', 'a project provider is used for ai.complete only');
            if (!projectSecrets || !projectSecrets.available()) throw new AiError(503, 'project_secret.unavailable', 'project secrets are not configured on this service');
        }
        // L36 Y1: a run on behalf of a person tries that person's OWN keys first (owner `self`). When they hold one,
        // the run is uncached and no network budget or tier holds it: their own key is free to them, and a $0 balance
        // must never block it. If it falls back to the network, the usage is still recorded after the fact.
        const personSubject = body.on_behalf_of && body.on_behalf_of.type === 'user' && typeof body.on_behalf_of.id === 'string' ? body.on_behalf_of.id : null;
        // A person running with their own token: the run is theirs. They may only name themselves, and their own
        // allowance or Balance pays. A service naming a person (body, x_openvibe, or a run token claim) draws only
        // that person's free allowance and cache scope, never their Balance, until the person authorises the charge
        // with a subject assertion (H1, openvibe-sdk #122; not accepted yet).
        const personOwnToken = principal.kind === 'user' && requester.type === 'user';
        if (personOwnToken && personSubject && personSubject !== requester.id) {
            throw new AiError(403, 'capability.denied', 'a person runs for themselves, never for someone else');
        }
        const runPerson = personOwnToken ? requester.id : personSubject;
        const personPays = Boolean(runPerson) && personOwnToken;
        // The calling service's own budget (a run token's registered budget): with it, a run for a named person may
        // use paid capacity, counted against that budget; without it, only free capacity serves the run.
        const tokenBudget = runBudgets && principal.jti ? await runBudgets.spent(principal.jti) : null;
        // BA2: a batch of the network's own is paid by the network: the batcher says so on the principal.
        const serviceBudgeted = Boolean(principal && principal.servicePaid) || Boolean(tokenBudget && (tokenBudget.budget_usd != null || tokenBudget.budget_tokens != null));
        // Spend safety (server/free-tier.js, server/providers/index.js): a run nobody pays for — the free
        // allowance (a service naming a person, without their own token) or the Exchange's anonymous Try it (its
        // service token, no person and no run-token budget, on ai.complete) — may use only offers from
        // AI_FREE_PROVIDERS and under the free-use output price ceiling. A person's own token (their Balance), a
        // project's run, a service's own run-token budget and a person's own key are paid by someone else, so
        // neither rule applies to them.
        const anonymousTryIt = principal.kind !== 'app' && requester.type === 'service' && requester.id === 'exchange';
        const freeUse = !personPays && !serviceBudgeted && !app && credentialSubject === null && !projectProvider
            && (Boolean(runPerson) || (anonymousTryIt && wf.key === 'ai.complete'));
        // The injected run record names the person a user runs for, so preferences and cache scope follow them.
        if (runPerson && !personSubject) body = { ...body, on_behalf_of: { type: 'user', id: runPerson } };
        const selfKeys = Boolean(credentials && runPerson && credentialSubject === null && !projectProvider && !pinned && await credentials.hasSelf(runPerson));
        // The budget a Codes run token carries (Codes C3): a run that is over its budget is refused before
        // any provider call. The budget lives here, not in the token, so the holder of the token cannot raise it.
        if (runBudgets && principal.jti) {
            const refusal = await runBudgets.refuse(principal.jti);
            if (refusal) throw refusal;
        }
        // AI Exchange F: the caller's optional liability cap on a Balance hold (`max_cost_usd`). It is a request
        // field on the OpenAI and Messages routes and an input/option field on the direct ones; parsed as an exact
        // decimal into integer nano-USD, never through a float (0.000000001 is one nano, 0.0000000011 rounds up).
        const rawMaxCost = body.max_cost_usd != null ? body.max_cost_usd : options.max_cost_usd != null ? options.max_cost_usd : input.max_cost_usd;
        const maxCostNano = rawMaxCost == null ? null : parseCostUsd(rawMaxCost);
        const ctx = {
            requesterType: requester.type, requesterId: requester.id,
            ...(principal.jti ? { runJti: principal.jti } : {}),
            actorKey: subjectKey(body.on_behalf_of), targetKey: entityKey(body.target), attributionKey: entityKey(body.attribution), workflowKey: wf.key,
            ...(app ? { appRun: true, projectId: app.projectId, sandbox: app.sandbox, appId: principal.appId } : {}),
            // Who pays a Balance hold (D12): the app and its project, else the person a token acts for, else the service.
            onBehalfOf: runPerson || principal.onBehalfOf || null,
            // Only the person's own token may hold their Balance; a service naming them draws free capacity only
            // (or its own run-token budget). The run still records the person, so preferences and cache follow them.
            personSubject: runPerson || null, personPays, serviceBudgeted, freeUse,
            ...(contentPolicy !== 'standard' ? { contentPolicy } : {}),
            // A credential or a project's own provider never reaches managed supply: no Balance hold for that run.
            ...(credentialSubject !== null || projectProvider ? { byok: true } : {}),
            ...(maxCostNano != null ? { maxCostNano: String(maxCostNano) } : {}),
            // The price this run is charged at: a batch's item is charged at half the retail rate.
            ...(discount ? { discount: String(discount) } : {}),
            // A batch's item runs on one chosen offer (the eligible route), and its settle is checked
            // against what that route really costs.
            ...(exact ? { exact } : {}),
            ...(costCheck ? { costCheck } : {}),
            ...(communityOfferId ? { communityOfferId, communityOptIn: true } : {}),
            ...(communityOptIn ? { communityOptIn: true } : {}),
            ...(pinned ? { routePin: pinned } : {}),
            // The preset's policy, and the name it was named by: the router filters the offers with the policy.
            ...(preset ? { presetPolicy, presetName } : {}),
            // BA1: the class this run may wait in. The router reads it to pick the tier.
            latencyClass,
            // BA1: a caller that waits (?wait=) gets its answer inside the wait: a Flex attempt may use the wait
            // minus the 25 s a standard retry needs (at least 10 s); a caller that polls gives the tier all its room.
            ...(latencyClass === 'background' && Number(callerWaitMs) > 0 ? { flexBudgetMs: Math.max(10000, Number(callerWaitMs) - 25000) } : {}),
            // POST /v1/chat/completions with stream: true: the upstream's deltas, as they arrive (kept in memory only).
            ...(typeof onDelta === 'function' ? { onDelta } : {}),
            // The offer the router picked, before the first token: the SSE disclosure's first comment (D3).
            ...(typeof onRoute === 'function' ? { onRoute } : {}),
        };
        const now = iso(clock.now());
        const id = newRunId();
        ctx.runId = id;
        // Plan E5: the free tier's allowance, device count, network signals and anomaly throttle. Paid runs only
        // teach the device table; a refusal here is a 402 (allowance spent) or a 429 (throttled) before any
        // provider or queue slot is touched.
        if (abuse && requestAbuse) {
            const admission = await abuse.admit({ principal, ctx, request: requestAbuse, inputHash, free: freeUse, anonymous: freeUse && anonymousTryIt, selfKeys });
            if (admission) ctx.abuse = admission;
        }
        const kept = retainedInput(input, wf, Boolean(config.debugRawLog && options.debug));
        const base = {
            id, workflow_key: wf.key, workflow_version: wf.version, template_key: tpl ? tpl.key : null, template_version: tpl ? tpl.version : null,
            route_key: route && !route.disabled ? route.key : routeKey, route_version: route && !route.disabled ? route.version : null,
            requester_type: requester.type, requester_id: requester.id,
            on_behalf_of: body.on_behalf_of ? JSON.stringify(body.on_behalf_of) : null,
            attribution: body.attribution ? JSON.stringify(body.attribution) : null,
            source_service: requester.type === 'service' ? requester.id : null,
            target: body.target ? JSON.stringify(body.target) : null, target_key: ctx.targetKey,
            input: null, input_hash: inputHash, idempotency_key: idem, trace_id: trace, request_id: requestId, retry_of: retryOf,
            latency_class: latencyClass,
            options: JSON.stringify({ cache: options.cache !== false && credentialSubject === null && !projectProvider && !pinned && !selfKeys && !communityOptIn, debug: Boolean(options.debug), input_retained: kept.full,
                ...(options.latency_clamped ? { latency_clamped: options.latency_clamped } : {}),
                ...(credentialSubject !== null ? { credential_subject: credentialSubject } : {}), ...(credentialProvider !== null ? { credential_provider: credentialProvider } : {}),
                ...(selfKeys ? { self_subject: runPerson } : {}),
                ...(runPerson ? { person_pays: personPays } : {}),
                ...(projectProvider ? { project_provider: projectProvider } : {}), ...(pinned ? { pinned_offer: pinned } : {}),
                ...(communityOptIn ? { community: true } : {}), ...(prefer ? { prefer } : {}),
                ...(contentPolicy !== 'standard' ? { policy: contentPolicy } : {}),
                ...(preset ? { preset: { name: String(preset.name).trim(), scope: preset.scope || 'owner', policy: presetPolicy } } : {}) }), created_at: now,
        };
        base.input = stableStringify(kept.value);

        // Cache (scoped; never crosses requester/actor/target/attribution)
        // A pinned run is never served from (or written to) the shared cache: the caller asked for THIS model,
        // and another model's answer under the same prompt would silently break the pin. A run that may use the
        // person's own key is never cached either: their key must be used, and the answer is theirs, not the scope's.
        // A community or adult-tier answer cannot be reused by a request without the same policy.
        const scope = options.cache === false || credentialSubject !== null || projectProvider || pinned || selfKeys || communityOptIn || contentPolicy !== 'standard' ? null : cache.scopeFor(wf.cache_mode, ctx);
        let cacheKey = null;
        if (scope) {
            // Some workflows key the cache on less than their whole input (hooks.js CACHE_INPUT: a signed URL's signature).
            const keyInput = CACHE_INPUT[wf.key] ? sha256(stableStringify(CACHE_INPUT[wf.key](input))) : inputHash;
            cacheKey = cache.keyFor({ scope, workflowKey: wf.key, workflowVersion: wf.version, templateVersion: base.template_version, routeKey: base.route_key, routeVersion: base.route_version, inputHash: keyInput });
            const hit = await cache.get(cacheKey, scope);
            if (hit) {
                const cacheExplain = { objective: 'cache', reasons: ["the answer was already in this scope's cache; no provider was called"], paid_by: 'cache', selected: null, candidates: [], attempts: [] };
                await db.tx(async () => {
                    await db.prepare(`INSERT INTO runs (id, workflow_key, workflow_version, template_key, template_version, route_key, route_version, status, requester_type, requester_id, on_behalf_of, attribution,
                        source_service, target, target_key, input, input_hash, output, model_key, cache_key, cached_from, retry_of, idempotency_key, trace_id, request_id, options, explain, latency_class, created_at, started_at, finished_at, citations_count)
                        VALUES (@id, @workflow_key, @workflow_version, @template_key, @template_version, @route_key, @route_version, 'cached', @requester_type, @requester_id, @on_behalf_of, @attribution,
                        @source_service, @target, @target_key, @input, @input_hash, @output, @model_key, @cache_key, @cached_from, @retry_of, @idempotency_key, @trace_id, @request_id, @options, @explain, @latency_class, @created_at, @created_at, @created_at, 0)`)
                        .run({ ...base, output: JSON.stringify(hit.output), model_key: hit.model_key, cache_key: cacheKey, cached_from: hit.run_id, explain: JSON.stringify(cacheExplain) });
                    const src = await citations(hit.run_id);
                    if (src.length) await addCitations(id, src.map(c => ({ ...c, provenance: { ...c.provenance, via_cache: hit.run_id } })), 'cache');
                    // The reused output carries the grounding it was produced with.
                    await db.prepare('UPDATE runs SET grounding = (SELECT grounding FROM runs WHERE id = ?) WHERE id = ?').run(hit.run_id, id);
                    // A cache hit is still a served run: its zero reading (no attempt, no tokens, no cost) goes to Billing with it.
                    await usageSamples.record(db, { runId: id, workflowKey: wf.key, requester: `${requester.type}:${requester.id}`, project: ctx.projectId || null, at: now, traceId: trace,
                        readings: [{ attempt: 0, kind: 'in', model: hit.model_key || null, quantity: 0, cost: 0, freeAllowanceUsed: 0 }] });
                    await events.runChanged(await getRow(id));
                });
                // A cache hit is still a run: its record says so (no tokens, no money).
                await publishUsage({ row: await getRow(id), outcome: 'cached' });
                // A reused answer carries a receipt too: the offer that produced it, and the fact that no
                // provider was called for this one.
                const cachedRow = await getRow(id);
                const source = hit.run_id ? await getRow(hit.run_id) : null;
                await writeReceipt({
                    row: cachedRow,
                    explain: { ...cacheExplain, reasons: [`the answer was reused from run ${hit.run_id}; no provider was called`] },
                    usage: {}, provider: (source && source.provider_key) || null, model: hit.model_key || (source && source.model_key) || null,
                    money: null, payer: { paid_by: 'cache', detail: `run ${hit.run_id}` },
                });
                await registry.audit(principal.sub, 'run.create', 'run', id, { trace, metadata: { workflow: wf.key, version: wf.version, status: 'cached', cached_from: hit.run_id } });
                return { run: await get(id), created: true, promise: null };
            }
        }

        // Queue caps, then quota: both before any provider call (a refused run is not counted).
        const caller = `${requester.type}:${requester.id}`;
        // Kudos bought with volunteer service start this run earlier in the queue (never cash, never a bypass of limits).
        const priority = community && typeof community.queuePriority === 'function' ? await community.queuePriority(ctx.onBehalfOf).catch(() => 0) : 0;
        admit(caller);
        // A run with a person's own key spends their money, not the shared quotas (its own budget was checked above).
        // The tier budgets (server/govern.js, AI_GOVERN_TIERS) hold first, so a run they refuse is not counted by reserve().
        // L36 Y1: a run that may use the person's own key holds neither — their key is free to them, and a $0 balance
        // anywhere must never block it. If it falls back to the network, the usage is recorded after the run.
        const hold = credentialSubject !== null || projectProvider || selfKeys || !tiers ? null : await tiers.admit(ctx, id);
        let reserved;
        try {
            // BA2: a batch run reserves its quota when the answer is here, not while it waits.
            reserved = credentialSubject !== null || selfKeys || (principal && principal.deferBatch) ? null : await quotas.reserve(ctx);
        } catch (err) { if (hold) await tiers.release(hold); throw err; }

        try {
            await db.tx(async () => {
                await db.prepare(`INSERT INTO runs (id, workflow_key, workflow_version, template_key, template_version, route_key, route_version, status, requester_type, requester_id, on_behalf_of, attribution,
                    source_service, target, target_key, input, input_hash, cache_key, retry_of, idempotency_key, trace_id, request_id, options, latency_class, created_at)
                    VALUES (@id, @workflow_key, @workflow_version, @template_key, @template_version, @route_key, @route_version, 'queued', @requester_type, @requester_id, @on_behalf_of, @attribution,
                    @source_service, @target, @target_key, @input, @input_hash, @cache_key, @retry_of, @idempotency_key, @trace_id, @request_id, @options, @latency_class, @created_at)`)
                    .run({ ...base, cache_key: cacheKey });
                await events.runChanged(await getRow(id));
            });
        } catch (err) { if (hold) await tiers.release(hold); throw err; }
        await registry.audit(principal.sub, retryOf ? 'run.retry' : 'run.create', 'run', id, { trace, metadata: { workflow: wf.key, version: wf.version, target: ctx.targetKey, retry_of: retryOf, ...(pinned ? { pinned_offer: pinned } : {}) } });
        // L55 C3: a service running on a person's own key (the person allowed it for that provider) is audited: who,
        // which service, which provider, which run. The key itself is never in the row.
        if (credentialSubject && requester.type === 'service' && credentials) {
            const consent = await credentials.consentUse(requester.id, credentialSubject, credentialProvider).catch(() => null);
            if (consent) {
                await registry.audit(principal.sub, 'credential.self.use', 'credential', `${consent.service}:${consent.subject}:${consent.provider}`, { trace, metadata: { service: consent.service, subject: consent.subject, provider: consent.provider, run_id: id } });
            }
        }

        // BA2: a batch run waits for the provider's own batch API. It is created now (the customer sees
        // it, and its latency class says 'batch'), but it takes no execution slot and no quota until the
        // answer is here; then it finishes on the ordinary path, with the ordinary settle and receipt.
        if (principal && principal.deferBatch) {
            const controller = new AbortController();
            let resolveDone;
            const done = new Promise((r) => { resolveDone = r; });
            deferred.set(id, { controller, scope, ctx, input, hold, resolveDone });
            inflight.set(id, { controller, promise: done, release: () => {}, caller, priority });
            return { run: await get(id), created: true, promise: done };
        }

        const controller = new AbortController();
        let release;
        const gate = new Promise((r) => { release = r; });
        // Whatever the run's end, a tier hold it did not settle (accounted) goes back.
        const promise = gate.then(async () => { try { await execute(id, { controller, reserved, scope, ctx, input, hold }); } finally { if (hold) await tiers.release(hold); } }).catch((err) => { log.error(`[runs] ${id}: ${err.stack || err}`); });
        inflight.set(id, { controller, promise, release, caller, priority });
        queue.push(id);
        pump();
        return { run: await get(id), created: true, promise };
    }

    /** Refuse a run that would wait in a full queue, globally or for this caller. */
    function admit(caller) {
        if (active < config.runs.maxConcurrent && !queue.length) return;      // starts at once
        const full = (detail, scope) => new AiError(429, 'queue.full', detail, { retry_after_seconds: QUEUE_RETRY_AFTER_S, queue: { scope, queued: queue.length } });
        if (queue.length >= config.runs.maxQueued) throw full(`the run queue is full (${config.runs.maxQueued} waiting); retry shortly`, 'global');
        let mine = 0;
        for (const qid of queue) { const h = inflight.get(qid); if (h && h.caller === caller) mine++; }
        if (mine >= config.runs.maxQueuedPerCaller) throw full(`${caller} already has ${mine} runs waiting (the per-caller limit); retry shortly`, 'caller');
    }

    function pump() {
        while (active < config.runs.maxConcurrent && queue.length) {
            // The highest kudos priority first; equal priorities keep their arrival order.
            let at = 0;
            for (let i = 1; i < queue.length; i++) {
                const have = inflight.get(queue[at]);
                const next = inflight.get(queue[i]);
                if (next && (!have || (next.priority || 0) > (have.priority || 0))) at = i;
            }
            const [id] = queue.splice(at, 1);
            const h = inflight.get(id);
            if (!h) continue;
            active++;
            h.promise.finally(() => { active--; pump(); });
            h.release();
        }
    }

    /**
     * The project's own provider as a run credential: the key is revealed by OpenVibe.Network for this one run, to the
     * provider's origin only (the project's grant of the secret to ai decides), and is never stored.
     */
    async function projectCredential(spec, ctx) {
        const environment = ctx.sandbox ? 'sandbox' : 'production';
        const { value } = await projectSecrets.reveal({ project_id: ctx.projectId, environment, name: spec.secret, origin: new URL(spec.base_url).origin });
        return {
            providerKey: `project:${ctx.projectId}`, provider: 'openai', base_url: spec.base_url, apiKey: value, models: { chat: spec.model },
            capabilities: ['chat', 'json', 'vision', 'tools'],
            explain: { objective: null, reasons: [`the project's own provider at ${new URL(spec.base_url).origin} (project secret ${spec.secret}, ${environment})`], paid_by: 'project', selected: `project:${ctx.projectId}`, candidates: [], attempts: [] },
        };
    }

    /**
     * The record of a run (plan L40): the tokens (the cache read and the cache write counted apart), the money and
     * who paid. It is published as one ai.call.recorded@1 event; OpenVibe.Report keeps the ledger. The record never
     * carries the prompt or the answer.
     *
     * It answers the money it computed, so the receipt of the same run (server/exchange/receipts.js) carries the
     * same numbers and never a second, different price.
     */
    async function publishUsage({ row, outcome, usage = {}, provider = null, model = null, attempts = 0, latencyMs = null, ttftMs = null }) {
        try {
            const opts = parseJson(row.options, {});
            const payer = await payerOf({ row, providerKey: provider, opts });
            const tokens = {
                input: Math.max(0, (usage.input || 0) - (usage.cached || 0) - (usage.cache_write || 0)),
                output: usage.output || 0, reasoning: usage.reasoning || 0,
                cache_read: usage.cached || 0, cache_write: usage.cache_write || 0,
            };
            const cards = provider ? await pool.rateCardsFor(provider, model) : null;
            const prices = usageRecord.pricesOf(cards);
            const money = usageRecord.moneyOf({ prices, tokens, paidBy: payer.paid_by, feeRate: (config.usage && config.usage.feeRate) || 0 });
            const rec = usageRecord.recordOf({
                system: 'ai', run_id: row.id, subject: subjectOf(row), attribution: attributionOf(row), surface: row.workflow_key || '',
                provider: payer.provider || provider || null, model: model || null, effort: opts.effort || null,
                paid_by: payer.paid_by, paid_by_detail: payer.detail,
                input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cache_read: tokens.cache_read,
                cache_write: tokens.cache_write, cache_write_ttl: usage.cache_write_ttl || null,
                images: usage.images || 0, audio_seconds: usage.audio_seconds || 0, video_seconds: usage.video_seconds || 0,
                list_cost_usd: money.list_cost_usd, charged_usd: money.charged_usd, fee_usd: money.fee_usd, cache_saved_usd: money.cache_saved_usd,
                price_source: prices.source, price_date: prices.date,
                latency_ms: latencyMs, ttft_ms: ttftMs, attempts, outcome,
                at: row.finished_at || new Date(clock.now()).toISOString(),
            });
            // The event (ai.call.recorded) is queued in its own transaction, like every other event here.
            await db.tx(async () => { await events.callRecorded(rec); });
            // Exchange webhooks (server/exchange/webhooks.js): the usage event, and the earnings event when a
            // community offer served the run. They are rows delivered after this write, never a reason to fail it.
            if (webhooks && typeof webhooks.usage === 'function') {
                try { await webhooks.usage({ row, record: rec, outcome }); }
                catch (err) { log.warn(`[runs] ${row.id}: the exchange webhook was not queued: ${err && err.message}`); }
            }
            return { payer, prices, money, tokens };
        } catch (err) {
            log.warn(`[runs] ${row.id}: the usage record was not written: ${err && err.message}`);
            return null;
        }
    }

    /**
     * The privacy label of an answer, from the offer that answered: the provider's declared policy, the person's
     * own machine, or the host's own deployment (server/exchange/privacy.js). The receipt and the run's explain
     * both carry it, so every surface that reads the run shows the same label.
     */
    async function privacyLabelFor({ provider = null, explain = null } = {}) {
        const byok = Boolean(provider && String(provider).startsWith('byo:'));
        const credentialProvider = byok && explain && Array.isArray(explain.attempts) && explain.attempts[0] && explain.attempts[0].provider
            ? explain.attempts[0].provider : null;
        const record = (provider ? await registry.getProvider(provider) : null)
            || (credentialProvider ? await registry.getProvider(credentialProvider) : null);
        // A community machine (`community:`) or a registered community endpoint (`community-endpoint:`) sees the prompt.
        const communityAnswer = Boolean(provider && /^community[:-]/.test(String(provider))) || Boolean(explain && explain.community);
        return communityAnswer
            ? privacy.labelFor({ record: { metadata: { data_policy: { trust: 'community' } } } })
            : privacy.labelFor({ record, credential: byok ? { provider: credentialProvider } : null });
    }

    /**
     * The receipt of a finished run (server/exchange/receipts.js): the offer, the price, the tokens, the cache,
     * the latency, why the router chose it, the fallbacks it would have used, who paid and the privacy label.
     * A receipt that cannot be written never fails the answer: it is written after it.
     */
    async function writeReceipt({ row, explain = null, usage = {}, provider = null, model = null, latencyMs = null, ttftMs = null, money = null, payer = null }) {
        if (!receipts) return null;
        try {
            const answerProvider = provider || row.provider_key || null;
            const answerModel = model || row.model_key || null;
            // A person's own key is metered under byo:<owner>:<subject>: the offer that answered is their key's
            // provider, and the price is that provider's list price (they pay it themselves, at no fee here).
            const byok = Boolean(answerProvider && String(answerProvider).startsWith('byo:'));
            const credentialProvider = byok && explain && Array.isArray(explain.attempts) && explain.attempts[0] && explain.attempts[0].provider
                ? explain.attempts[0].provider : null;
            let cards = answerProvider && pool ? await pool.rateCardsFor(answerProvider, answerModel) : null;
            if (!cards && byok && credentialProvider && pool) cards = await pool.rateCardsFor(credentialProvider, answerModel);
            const prices = cards ? {
                in: cards.in.unit_price_usd, out: cards.out.unit_price_usd, cached: cards.cached.unit_price_usd,
                source: cards.in.source,
            } : null;
            const label = await privacyLabelFor({ provider: answerProvider, explain });
            const paidBy = (payer && payer.paid_by) || 'openvibe_key';
            const feeRate = paidBy === 'openvibe_key' ? Number((config.usage && config.usage.feeRate) || 0) : 0;
            const opts = parseJson(row.options, {});
            const receipt = buildReceipt({
                run: {
                    id: row.id, workflow_key: row.workflow_key, route_key: row.route_key, route_version: row.route_version,
                    provider_key: answerProvider, model_key: answerModel, cost_usd: row.cost_usd,
                },
                explain, usage, price: prices, privacy: privacy.view(label),
                payer: { paid_by: paidBy, detail: (payer && payer.detail) || null, fee_rate: feeRate, fee_usd: money ? money.fee_usd : 0 },
                preset: opts.preset || null,
                latencyMs, ttftMs,
                provider: answerProvider, model: answerModel,
                createdAt: row.finished_at || new Date(clock.now()).toISOString(),
            });
            const person = subjectOf(row);
            await receipts.record(receipt, {
                requester: { type: row.requester_type, id: row.requester_id },
                owner: person ? { type: 'user', id: person } : null,
            });
            return receipt;
        } catch (err) {
            log.warn(`[runs] ${row.id}: the receipt was not written: ${err && err.message}`);
            return null;
        }
    }

    /** The person the run was for, when there is one (a run on behalf of a service has none). */
    const subjectOf = (row) => {
        const o = parseJson(row.on_behalf_of, null);
        return o && o.type === 'user' && o.id ? o.id : null;
    };

    /** The site or app the run came from, as '<type>:<id>' (empty when nothing is known). */
    const attributionOf = (row) => {
        const a = parseJson(row.attribution, null);
        if (!a) return '';
        if (typeof a === 'string') return a;
        const kind = a.service || a.type || '';
        return a.id ? `${kind}:${a.id}` : kind;
    };

    /**
     * Who paid for this run (L40): the person's own key, the OpenVibe key, their plan, their own machine, a free
     * tier, the network's allowance or an organisation's key. A person's own key is never charged here.
     */
    async function payerOf({ row, providerKey, opts }) {
        if (opts.credential_subject) {
            const cred = await credentials.get(row.requester_id, opts.credential_subject, opts.credential_provider || null).catch(() => null);
            if (cred && cred.provider === 'node') return { paid_by: 'own_machine', detail: cred.machine || 'node', provider: 'node' };
            const name = (cred && cred.provider) || 'own';
            const hint = cred && cred.key_hint ? String(cred.key_hint) : '';
            return { paid_by: 'own_key', detail: hint ? `${name} ...${hint}` : name, provider: name };
        }
        if (opts.project_provider) return { paid_by: 'org_key', detail: `project:${opts.project_provider.project_id || ''}`, provider: providerKey };
        const p = providerKey ? await registry.getProvider(providerKey) : null;
        const profile = (p && p.billing_profile) || 'metered';
        const name = providerKey || (p && p.key) || null;
        if (profile === 'subscription') return { paid_by: 'plan', detail: (p && (p.pool_key || p.key)) || name, provider: name };
        if (profile === 'free') return { paid_by: 'free_tier', detail: (p && (p.pool_key || p.key)) || name, provider: name };
        if (profile === 'byok') return { paid_by: 'own_key', detail: name, provider: name };
        if (p && p.metadata && p.metadata.allowance === 'network') return { paid_by: 'network_allowance', detail: name, provider: name };
        return { paid_by: 'openvibe_key', detail: name, provider: name };
    }
    /** The attempts a Balance settle reports, in billing.credit-hold-settle-request@1's exact attempt shape. */
    async function billingAttempts({ explain, logged, startedAt, endedAt }) {
        const source = explain && Array.isArray(explain.attempts) && explain.attempts.length ? explain.attempts : (logged || []);
        const out = [];
        for (const a of source) {
            if (!a) continue;
            const provider = a.provider || a.provider_key || null;
            if (!provider || a.status === 'skipped') continue;
            const model = a.model || a.model_key || null;
            let access = null;
            try { const p = await registry.getProvider(provider); access = p && credits ? credits.accessOf(p) : null; } catch { access = null; }
            const ok = a.status === 'ok' || a.status === 'succeeded';
            out.push({
                deployment_id: `${provider}:${model || ''}`,
                ...(access ? { provider_access: access } : {}),
                started_at: startedAt, ended_at: endedAt,
                error_code: ok ? null : String(a.error || a.error_code || a.status || 'error').slice(0, 120),
            });
        }
        return out;
    }

    /** Settle the request's Balance hold once; a failure is logged, never allowed to fail an answer already made. */
    async function settleCredits(credit, { usage, costUsd, explain, logged = [], startedAt, endedAt }) {
        if (!credit || !credit.holdId) return null;
        try {
            const attempts = await billingAttempts({ explain, logged, startedAt, endedAt });
            return await credit.settle({ usage, supplyCostUsd: costUsd, attempts });
        } catch (err) {
            log.warn(`[credits] settle ${credit.holdId} failed; queued for retry (a 409/422 needs review): ${err && err.message}`);
            return null;
        }
    }

    async function execute(id, { controller, reserved, scope, ctx, input, hold = null }) {
        const row = await getRow(id);
        if (!row || row.status !== 'queued') { inflight.delete(id); return; }
        await db.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(iso(clock.now()), id);
        const wf = await registry.getWorkflow(row.workflow_key, row.workflow_version);
        const opts = parseJson(row.options, {});
        let seq = 0;
        let attempts = 0;
        const logged = [];      // every attempt entry, for the provider rollup in quotas.account()
        const logRequest = async (e) => {
            if (e.status !== 'skipped') attempts++;
            logged.push(e);
            await insReq.run({
                run_id: id, seq: seq++, operation: e.operation, provider_key: e.provider_key, model_key: e.model_key || null, route_key: e.route_key || null, route_version: e.route_version || null,
                status: e.status, skip_reason: e.skip_reason || null, fallback: e.fallback || 0, prompt_hash: e.prompt_hash || null, input_hash: row.input_hash, output_hash: e.output_hash || null,
                tokens_in: e.tokens_in || 0, tokens_out: e.tokens_out || 0, tokens_cached: e.tokens_cached || 0, tokens_estimated: e.tokens_estimated || 0, cost_usd: e.cost_usd || 0,
                latency_ms: e.latency_ms == null ? null : e.latency_ms, error: e.error || null,
                debug_prompt: config.debugRawLog && opts.debug ? e.debug_prompt || null : null, debug_response: config.debugRawLog && opts.debug ? e.debug_response || null : null,
                created_at: iso(clock.now()),
            });
        };
        let credit = null;
        let billingDelta = null;
        let onRoute = null;
        try {
            // AI Exchange F: hold prepaid Balance before the first managed provider call (AI_CREDITS, off by
            // default). A run with no project to bill (a first-party service, a cache hit, BYOK) begins no session
            // and never touches Billing.
            if (credits && credits.enabled) {
                credit = credits.begin({ requestId: row.request_id || id, ctx, input, attribution: parseJson(row.attribution, null), onBehalfOf: ctx.onBehalfOf || null, personPayer: ctx.personPays !== false });
                // No payer (or no project) on a run that is not BYOK: the pool must not serve a paid managed offer
                // with a versioned card, because nobody could be charged for it. The exception is a calling service's
                // own run-token budget: it pays for the run, counted against that budget, and the person's Balance is
                // never touched.
                ctx.creditsRequired = !credit && !ctx.byok && !ctx.serviceBudgeted;
            }
            billingDelta = typeof ctx.onDelta === 'function'
                ? (credit ? (d) => { credit.observe(d); ctx.onDelta(d); } : ctx.onDelta)
                : null;
            // Balance holds first (a 402 must land before the provider), then the router's own disclosure hook.
            onRoute = (credit || typeof ctx.onRoute === 'function')
                ? async (facts, meta) => {
                    const routed = credit ? await credit.onRoute(facts, meta) : null;
                    if (typeof ctx.onRoute === 'function') await ctx.onRoute(facts, meta);
                    return routed;
                }
                : null;
            // A run on a person's behalf follows their ai.preferences (Network user module): style, length and
            // perspective shape the prompt; history: false keeps neither their input nor a cache entry.
            const preferences = userModules && row.on_behalf_of ? await userModules.preferencesFor(row.on_behalf_of) : {};
            if (preferences.history === false) {
                await db.prepare("UPDATE runs SET input = 'null', cache_key = NULL, options = (COALESCE(options, '{}')::jsonb || jsonb_build_object('input_retained', false, 'history', false))::text WHERE id = ?").run(id);
            }
            const credential = opts.credential_subject ? await credentials.forRun(row.requester_id, opts.credential_subject, opts.credential_provider || null)
                : opts.project_provider ? await projectCredential(opts.project_provider, ctx) : null;
            // L36 Y1/Y8: the person's own keys, and what their preferences say about the network fallback. A provider
            // refusing one (401/403) marks it failing and publishes ai.credential.failed, never the key.
            const selfSubject = opts.self_subject || null;
            const selfCredentials = selfSubject && credentials ? await credentials.selfForAllRuns(selfSubject) : null;
            const selfPreferences = selfSubject && personPreferences ? await personPreferences.get(selfSubject) : null;
            const onCredentialFailed = credentials ? async (failure) => {
                if (!failure || !failure.owner || !failure.subject || !failure.provider) return;
                const changed = await credentials.markFailed(failure.owner, failure.subject, failure.provider, failure.error);
                if (changed) await events.credentialFailed({ subject: failure.subject, provider: failure.provider, error: failure.error, owner: failure.owner });
            } : undefined;
            // With Credits off there is no Balance payer at all, so every run is the free tier for a new community machine;
            // with it on only a run that could not hold a paid offer is.
            const communityFree = !(credits && credits.enabled) || Boolean(ctx.creditsRequired);
            // BA2: a batch run's answer is the provider's own batch answer, not a provider call. The hold
            // for the customer's money is taken here, on the card the ordinary path would have used.
            const batchAnswer = ctx.batchAnswer ? await ctx.batchAnswer : null;
            if (batchAnswer && batchAnswer.ok === false) {
                throw new AiError(502, String((batchAnswer.error && batchAnswer.error.code) || 'batch.item_failed'), String((batchAnswer.error && batchAnswer.error.detail) || 'the provider did not answer this request'));
            }
            if (batchAnswer && batchAnswer.ok && credit && typeof credit.holdRoute === 'function') {
                await credit.holdRoute({ card: batchAnswer.holdRetail || null, provider: batchAnswer.provider || null, model: batchAnswer.model || null, access: batchAnswer.access || null, maxTokens: batchAnswer.maxTokens || 4096 });
            }
            let r = null;
            if (batchAnswer && batchAnswer.ok) {
                r = { output: batchAnswer.output || { text: '' }, usage: batchAnswer.usage || { input: 0, output: 0, cached: 0, cache_write: 0 }, cost: Number(batchAnswer.cost) || 0, provider: batchAnswer.provider || null, model: batchAnswer.model || null, citations: [], explain: batchAnswer.explain || null, grounding: null, synthetic: false, fallbackUsed: false };
            }
            if (!r) r = await engine.execute(wf, row, input, { signal: controller.signal, logRequest, debugRaw: Boolean(config.debugRawLog && opts.debug), inputHash: row.input_hash, preferences,
                // A developer app's run (ADR-014): the provider pool excludes a person's byok key, and the run is
                // limited to free and local capacity when it is a sandbox run or when no tier budget governs its
                // project (AI_GOVERN_TIERS off): metered capacity is only ever spent under a project budget.
                appRun: Boolean(ctx.appRun), freeOnly: Boolean(ctx.appRun && (ctx.sandbox || !(tiers && tiers.enabled))),
                // Who asked, for a step that must not call the caller back (research: Search's own web ladder).
                requesterType: ctx.requesterType, requesterId: ctx.requesterId,
                // AI Exchange F: no payer on this run (and not BYOK): the pool skips paid offers with a card.
                creditsRequired: Boolean(ctx.creditsRequired),
                // The free allowance / anonymous Try it: the router may use only offers under the output price ceiling.
                freeUse: Boolean(ctx.freeUse),
                // Opted in to community capacity: the pool may place this run on a person's machine.
                communityOptIn: Boolean(ctx.communityOptIn),
                communityFree,
                ...(ctx.routePin ? { routePin: ctx.routePin } : {}),
                // L37: the soft preference the caller made (provider, and a model if it named one).
                prefer: opts.prefer || null,
                // The routing preset's rules (server/exchange/constraints.js): the router filters the offers with
                // them, and a hard max_price no offer fits refuses the run before any provider is called.
                presetPolicy: opts.preset ? opts.preset.policy : null,
                presetName: opts.preset ? opts.preset.name : null,
                // The Exchange remake's content policy (standard, or uncensored for an 18+ account), and the person
                // the run is for: the pool asks Network whether that account confirmed it is 18+.
                ...(ctx.contentPolicy ? { contentPolicy: ctx.contentPolicy } : {}),
                ...(ctx.onBehalfOf ? { onBehalfOf: ctx.onBehalfOf } : {}),
                ...(onCredentialFailed ? { onCredentialFailed } : {}),
                ...(selfSubject ? { selfSubject, selfCredentials: selfCredentials || [], selfPreferences } : {}),
                ...(credential ? { credential, role: input && typeof input.role === 'string' ? input.role : null } : {}),
                ...(billingDelta ? { onDelta: billingDelta } : {}),
                ...(onRoute ? { onRoute } : {}),
                // BA1: the class this run may wait in: the router picks the tier from it.
                latencyClass: ctx.latencyClass || latency.DEFAULT,
                ...(ctx.flexBudgetMs ? { flexBudgetMs: ctx.flexBudgetMs } : {}) });
            // The Exchange remake: an uncensored answer is labelled in the run's own output, whatever its shape, so
            // every surface that reads it (the API routes, the console, a product) shows what produced it.
            if (r.output && r.label) {
                r.output = { ...r.output, policy: r.contentPolicy || 'uncensored', label: r.label };
            }
            // The privacy label of the answer, in the run's own explain: the API routes, the Exchange's chat and every
            // product that reads a run show the same label the receipt carries.
            r.explain = { ...(r.explain || {}), privacy: privacy.view(await privacyLabelFor({ provider: r.provider, explain: r.explain })) };
            if (controller.signal.aborted) throw new AiError(409, 'run.cancelled', 'cancelled');
            // The status, its citations and the ai.run.succeeded event commit together.
            const done = await db.tx(async () => {
                const d = await db.prepare(`UPDATE runs SET status = 'succeeded', output = ?, grounding = ?, synthetic = ?, provider_key = ?, model_key = ?, fallback_used = ?, attempts = ?, tokens_in = ?, tokens_out = ?, cost_usd = ?,
                    service_tier = ?, saved_usd = ?, route_key = COALESCE(?, route_key), route_version = COALESCE(?, route_version), explain = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
                    .run(JSON.stringify(r.output), JSON.stringify(r.grounding || null), r.synthetic ? 1 : 0, r.provider, r.model, r.fallbackUsed ? 1 : 0, attempts, r.usage.input, r.usage.output, r.cost,
                        r.serviceTier || null, Number(r.savedUsd) || 0,
                        r.route ? r.route.key : null, r.route ? r.route.version : null, r.explain ? JSON.stringify(r.explain) : null, iso(clock.now()), id);
                if (!d.changes) return d;
                if (r.citations.length) await addCitations(id, r.citations, 'workflow');
                await events.runChanged(await getRow(id));
                return d;
            });
            if (!done.changes) return;       // cancelled while finishing
            // One settle for the request, with the four token counts, the answering card, the supply cost and
            // every attempt. A failure never turns the answer into an error: Billing expires an unsettled hold.
            if (credit) await settleCredits(credit, { usage: r.usage, costUsd: r.cost, explain: r.explain, logged, startedAt: row.started_at || iso(clock.now()), endedAt: iso(clock.now()) });
            // A self-key run has no reservation and no tier hold; if it fell back to the network, its usage is still
            // recorded (the fallback is named in explain). A run that used the person's own key spends nothing here.
            const usedOwnKey = String(r.provider || '').startsWith('byo:self:');
            if (r.provider && (reserved || (opts.self_subject && !usedOwnKey))) await quotas.account(ctx, reserved, { provider: r.provider, model: r.model, tokensIn: r.usage.input, tokensOut: r.usage.output, tokensCached: r.usage.cached, cost: r.cost, attempts: logged, runId: id, traceId: row.trace_id, hold });
            // Plan E5: the free tokens this run spent go on its allowance (or its shared device counter) and on the
            // per-minute velocity buckets. A failure here is logged, never allowed to fail an answer already made.
            if (abuse && ctx.abuse && !usedOwnKey && !String(r.provider || '').startsWith('byo:')) {
                try { await abuse.record({ admission: ctx.abuse, tokens: (r.usage.input || 0) + (r.usage.output || 0), inputHash: row.input_hash }); }
                catch (err) { log.warn(`[runs] ${id}: the abuse counters were not written: ${err && err.message}`); }
            }
            // The record of the run (L40): the tokens with the cache apart, the money and who paid.
            const published = await publishUsage({ row: await getRow(id), outcome: 'succeeded', usage: r.usage, provider: r.provider, model: r.model, attempts, latencyMs: r.latencyMs, ttftMs: r.ttftMs });
            // The receipt of the answer (server/exchange/receipts.js): the offer, the price, the tokens, the cache,
            // the latency, why the router chose it, the fallbacks it would have used, the payer and the privacy label.
            await writeReceipt({
                row: await getRow(id), explain: r.explain, usage: r.usage, provider: r.provider, model: r.model,
                latencyMs: r.latencyMs, ttftMs: r.ttftMs, money: published && published.money, payer: published && published.payer,
            });
            // What the run spent goes on the budget of its run token (Codes C3): the same tokens and cost the
            // quota accounting counts, so the next request of a run over its budget is refused.
            if (runBudgets && ctx.runJti) await runBudgets.add(ctx.runJti, { tokens: r.usage.input + r.usage.output, cost: r.cost });
            if (r.fallbackUsed) await registry.audit('system', 'run.fallback', 'run', id, { trace: row.trace_id, metadata: { workflow: row.workflow_key, provider: r.provider, route: r.route && r.route.key } });
            // Output shaped by someone's preferences, or kept for nobody (history off), is never cached for reuse.
            if (scope && row.cache_key && !r.synthetic && wf.cache_mode !== 'none' && preferences.history !== false && !preferenceLines(preferences)) {
                await cache.put({ key: row.cache_key, scope, privacy: wf.cache_mode, workflowKey: wf.key, workflowVersion: wf.version, templateVersion: row.template_version, routeKey: row.route_key, routeVersion: row.route_version, model: r.model, inputHash: row.input_hash, output: r.output, runId: id, ttlSec: wf.cache_ttl_sec || config.runs.defaultCacheTtlSec });
            }
        } catch (err) {
            const interrupted = shuttingDown && controller.signal.aborted;
            const cancelled = !interrupted && (controller.signal.aborted || (err && err.code === 'run.cancelled'));
            let code = interrupted ? 'run.interrupted' : cancelled ? 'run.cancelled' : (err instanceof AiError ? err.code : 'run.internal');
            let detail = interrupted ? 'the service shut down while this run was in progress' : cancelled ? 'cancelled' : (err instanceof AiError ? err.detail : 'internal error');
            // A service naming a person may draw only their free allowance. When that is spent and the service has no
            // budget of its own, say so plainly (402) instead of "no provider could answer": the person's Balance is
            // never touched for a run they did not start themselves.
            const tried = err instanceof AiError && err.extra && Array.isArray(err.extra.tried) ? err.extra.tried : [];
            const payerSkipped = tried.some((t) => t && t.skipped === 'payer_required');
            if (ctx.personPays === false && ctx.personSubject && !ctx.serviceBudgeted
                && (code === 'billing.payer_required' || (code === 'provider.unavailable' && payerSkipped))) {
                code = 'ai.allowance_spent';
                detail = `The free AI allowance for ${ctx.personSubject} is spent, and the calling service has no budget to cover this run. Add a key for the person, or wait for the allowance to reset.`;
            }
            if (!(err instanceof AiError) && !cancelled) log.error(`[runs] ${id} crashed: ${err && err.stack || err}`);
            // ai.resting's detail is the one sentence products show; its tries and Retry-After live in the problem body
            // and the explain, never appended to that sentence.
            const extra = err instanceof AiError && err.extra && err.code !== 'ai.resting' ? JSON.stringify(err.extra).slice(0, 2000) : null;
            const explain = err instanceof AiError && err.extra && err.extra.explain ? JSON.stringify(err.extra.explain) : null;
            await db.tx(async () => {
                const f = await db.prepare(`UPDATE runs SET status = ?, error_code = ?, error_detail = ?, attempts = ?, explain = COALESCE(?, explain), finished_at = ? WHERE id = ? AND status IN ('queued', 'running')`)
                    .run(cancelled ? 'cancelled' : 'failed', code, extra ? `${detail} ${extra}` : detail, attempts, explain, iso(clock.now()), id);
                if (f.changes) await events.runChanged(await getRow(id));
            });
            const spent = await db.prepare("SELECT COALESCE(SUM(tokens_in),0)::bigint ti, COALESCE(SUM(tokens_out),0)::bigint tout, COALESCE(SUM(tokens_cached),0)::bigint tc, COALESCE(SUM(cost_usd),0) c FROM requests WHERE run_id = ? AND status = 'ok'").get(id);
            // Balance: nothing reached a provider (or it failed before the first token) releases the hold; an abort
            // or a failure after tokens streamed settles the partial usage it did produce.
            if (credit && credit.holdId) {
                try {
                    const streamedOut = Math.ceil(credit.streamedChars / 4);
                    const produced = Number(spent.ti) > 0 || Number(spent.tout) > 0 || streamedOut > 0 || logged.some((e) => e.status === 'ok');
                    if (produced) {
                        await settleCredits(credit, {
                            usage: { input: Math.max(Number(spent.ti) || 0, credit.inputTokens), output: Math.max(Number(spent.tout) || 0, streamedOut), cached: Number(spent.tc) || 0, cache_write: 0 },
                            costUsd: Number(spent.c) || 0,
                            explain: err instanceof AiError && err.extra && err.extra.explain ? err.extra.explain : null, logged,
                            startedAt: row.started_at || iso(clock.now()), endedAt: iso(clock.now()),
                        });
                    } else {
                        await credit.release();
                    }
                } catch (cers) {
                    log.warn(`[credits] ${id} ${cers && cers.code || 'release/settle'}: ${cers && cers.message}`);
                }
            }
            // A run that broke still spent: its record says what it cost and who paid (L40).
            await publishUsage({ row: await getRow(id), outcome: cancelled ? 'cancelled' : 'failed',
                usage: { input: Number(spent.ti) || 0, output: Number(spent.tout) || 0, cached: Number(spent.tc) || 0 },
                provider: logged.length ? logged[logged.length - 1].provider_key : null, model: null, attempts });
            // Account the spent tokens/cost as before, but always roll up the finished attempts (the failed
            // ones included) into provider_stats_daily/placement_state: a run that answered nothing still
            // tells the router a provider was unhealthy.
            if (reserved && logged.some((e) => e.status !== 'skipped')) await quotas.account(ctx, reserved, { provider: 'mixed', model: '', tokensIn: spent.ti, tokensOut: spent.tout, cost: spent.c, attempts: logged, writeUsage: Boolean(spent.ti || spent.tout), runId: id, traceId: row.trace_id, hold });
            // A run that broke still spent (a refused turn, a half-written answer): it goes on the budget too.
            if (runBudgets && ctx.runJti) await runBudgets.add(ctx.runJti, { tokens: Number(spent.ti) + Number(spent.tout), cost: Number(spent.c) });
        } finally {
            inflight.delete(id);
        }
    }

    /** Wait for a run to reach a terminal state, up to ms. */
    async function wait(created, ms) {
        if (!created.promise || ms <= 0) return await get(created.run.id);
        let timer;
        await Promise.race([created.promise, new Promise((r) => { timer = setTimeout(r, Math.min(ms, config.runs.maxWaitMs)); timer.unref?.(); })]);
        clearTimeout(timer);
        return await get(created.run.id);
    }

    function assertOwner(row, principal, adminCap, principalHas) {
        const s = principal.subject;
        if (row.requester_type === s.type && row.requester_id === s.id) return;
        if (adminCap && principalHas && principalHas(adminCap)) return;
        throw new AiError(404, 'run.not_found', 'no such run');   // do not reveal other callers' runs
    }

    async function cancel(id, principal, { trace = null, principalHas } = {}) {
        const row = await getRow(id);
        if (!row) throw new AiError(404, 'run.not_found', 'no such run');
        assertOwner(row, principal, 'ai.workflow.manage', principalHas);
        if (TERMINAL.has(row.status)) throw new AiError(409, 'run.terminal', `run is already ${row.status}`);
        const h = inflight.get(id);
        const r = await db.prepare("UPDATE runs SET status = 'cancelled', error_code = 'run.cancelled', error_detail = 'cancelled by caller', finished_at = ? WHERE id = ? AND status IN ('queued', 'running')").run(iso(clock.now()), id);
        if (h) {
            h.controller.abort();
            const i = queue.indexOf(id);
            if (i >= 0) { queue.splice(i, 1); h.release(); }
        }
        await registry.audit(principal.sub, 'run.cancel', 'run', id, { trace, metadata: { from: row.status, changed: r.changes } });
        return await get(id);
    }

    async function retry(id, principal, { trace = null, requestId = null, principalHas } = {}) {
        const row = await getRow(id);
        if (!row) throw new AiError(404, 'run.not_found', 'no such run');
        assertOwner(row, principal, 'ai.workflow.manage', principalHas);
        if (!['failed', 'cancelled'].includes(row.status)) throw new AiError(409, 'run.not_retryable', `only failed or cancelled runs can be retried (this one is ${row.status})`);
        const opts = parseJson(row.options, {});
        if (opts.input_retained === false) throw new AiError(409, 'run.input_not_retained', 'this run did not keep its input (inline media or a passthrough prompt); submit it again');
        return await create({
            workflow: row.workflow_key, input: parseJson(row.input, {}), target: parseJson(row.target, null) || undefined,
            attribution: parseJson(row.attribution, null) || undefined, on_behalf_of: parseJson(row.on_behalf_of, null) || undefined,
            route: opts.pinned_offer || undefined,
            options: { ...opts, cache: false },
        }, principal, { trace, requestId, retryOf: id });
    }

    async function list(principal, { status, workflow, target, limit = 50, before, all = false } = {}) {
        const where = [];
        const args = [];
        if (!all) { where.push('requester_type = ? AND requester_id = ?'); args.push(principal.subject.type, principal.subject.id); }
        if (status) { where.push('status = ?'); args.push(status); }
        if (workflow) { where.push('workflow_key = ?'); args.push(workflow); }
        if (target) { where.push('target_key = ?'); args.push(target); }
        if (before) { where.push('id < ?'); args.push(before); }
        return (await db.prepare(`SELECT * FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(200, Number(limit) || 50))).map(decode);
    }

    // The columns a person's Action Center item and run receipt need. Input, its hash, the trace and the
    // request/idempotency identifiers are deliberately absent: another person's input is never even read.
    const PERSON_COLUMNS = `id, workflow_key, workflow_version, status, on_behalf_of, output, error_code, error_detail,
        provider_key, model_key, cost_usd, tokens_in, tokens_out, attempts, created_at, started_at, finished_at,
        synthetic, cached_from, retry_of, citations_count`;

    /**
     * A person's runs for the Action Center: on_behalf_of is that user. Everything still queued/running, then the
     * terminal ones updated since `since`; newest updated first, at most limit (50 by the route).
     */
    async function listOnBehalfOf(subject, { since = null, limit = 50 } = {}) {
        const where = ["on_behalf_of IS NOT NULL", "on_behalf_of::jsonb->>'type' = 'user'", "on_behalf_of::jsonb->>'id' = ?"];
        const args = [subject];
        if (since != null) {
            where.push("(status IN ('queued', 'running', 'waiting') OR COALESCE(finished_at, started_at, created_at) >= ?)");
            args.push(iso(since));
        }
        const rows = await db.prepare(`SELECT ${PERSON_COLUMNS} FROM runs WHERE ${where.join(' AND ')}
            ORDER BY COALESCE(finished_at, started_at, created_at) DESC LIMIT ?`).all(...args, Math.min(50, Number(limit) || 50));
        return rows.map(decode);
    }

    /** One run for its person's receipt page, without its input. The caller checks on_behalf_of. */
    async function getReceipt(id) {
        return decode(await db.prepare(`SELECT ${PERSON_COLUMNS} FROM runs WHERE id = ?`).get(id));
    }

    /** The run with its Billing readings in explain.usage_readings (server/usage-samples.js readingsFor); unchanged when it has none. */
    async function explained(run) {
        const ids = run && run.usage ? run.usage.usage_sample_ids : null;
        const readings = ids && ids.length ? await usageSamples.readingsFor(db, ids) : [];
        return readings.length ? { ...run, explain: { ...(run.explain || {}), usage_readings: readings } } : run;
    }

    async function requestsFor(runId) {
        return await db.prepare('SELECT id, seq, operation, provider_key, model_key, route_key, route_version, status, skip_reason, fallback, prompt_hash, input_hash, output_hash, tokens_in, tokens_out, tokens_cached, tokens_estimated, cost_usd, latency_ms, error, created_at FROM requests WHERE run_id = ? ORDER BY seq').all(runId);
    }

    /** Boot: runs interrupted by a restart are failed explicitly (retry is one call away). */
    async function recoverInterrupted() {
        return await db.tx(async () => {
            const open = await db.prepare("SELECT id FROM runs WHERE status IN ('queued', 'running')").all();
            // BA2: a run that waits for a provider's batch answer is not interrupted. It waits in the queue
            // (the database, not this process), the provider is still working on it, and the batcher finishes
            // it when the answer is there - after this restart too. Failing it here would lose the answer
            // the provider is already going to charge us for.
            const waiting = new Set();
            if (batchWaiting) {
                for (const { id } of open) {
                    if (await batchWaiting(id)) waiting.add(id);
                }
            }
            const interrupted = open.filter(({ id }) => !waiting.has(id));
            if (!interrupted.length) return 0;
            const placeholders = interrupted.map(() => '?').join(',');
            const r = await db.prepare(`UPDATE runs SET status = 'failed', error_code = 'run.interrupted', error_detail = 'the service restarted while this run was in progress', finished_at = ? WHERE status IN ('queued', 'running') AND id IN (${placeholders})`)
                .run(iso(clock.now()), ...interrupted.map(({ id }) => id));
            for (const { id } of interrupted) await events.runChanged(await getRow(id));
            return r.changes;
        });
    }

    async function prune(days = config.runs.retentionDays) {
        const cutoff = iso(clock.now() - days * 86400000);
        const old = (await db.prepare('SELECT id FROM runs WHERE finished_at IS NOT NULL AND finished_at < ?').all(cutoff)).map(r => r.id);
        await db.tx(async () => {
            for (const id of old) {
                await db.prepare('DELETE FROM requests WHERE run_id = ?').run(id);
                await db.prepare('DELETE FROM citations WHERE run_id = ?').run(id);
                await db.prepare('DELETE FROM runs WHERE id = ?').run(id);
            }
        });
        return old.length;
    }

    /** Shutdown: in-flight runs end as failed/run.interrupted (retryable), never as a silent loss. */
    async function drain() {
        shuttingDown = true;
        // BA2: a run that waits for a provider's batch answer is not interrupted by the shutdown: it stays
        // queued, the provider keeps working on it, and the batcher finishes it after the restart. It is
        // released here (its promise resolves, so the shutdown is not held by it) and never aborted.
        for (const [id, d] of deferred) {
            d.resolveDone();
            inflight.delete(id);
        }
        deferred.clear();
        for (const h of inflight.values()) { h.controller.abort(); h.release(); }
        await Promise.allSettled([...inflight.values()].map(h => h.promise));
    }

    /**
     * BA2: finish a batch run. The answer is the provider's own batch answer; the run then finishes on the
     * ordinary path, so the settle, the receipt, the usage record and the events are the ordinary ones and
     * a customer watching the run sees nothing new.
     *
     * A run that is already finished (or was never a batch run) is left alone: two pollers can never
     * finish the same run twice.
     */
    async function completeBatch(id, answer, { plan = null, costCheck = null } = {}) {
        const key = String(id);
        const d = deferred.get(key);
        if (d) {
            deferred.delete(key);
            const ctx = { ...d.ctx, batchAnswer: Promise.resolve(answer), ...(costCheck ? { costCheck } : {}) };
            try {
                const reserved = await quotas.reserve(ctx).catch(() => null);
                await execute(key, { controller: d.controller, reserved, scope: d.scope, ctx, input: d.input, hold: d.hold });
            } finally {
                if (d.hold && tiers && tiers.release) await tiers.release(d.hold).catch(() => {});
                d.resolveDone();
            }
            return get(key);
        }
        // The service restarted while the run waited: everything execute() needs is rebuilt from the
        // database - the run row, the run's input and the plan the batcher stored with the item.
        const row = await getRow(key);
        if (!row) return null;
        if (TERMINAL.has(row.status)) return null;                 // it already finished, or it was cancelled
        const data = plan || {};
        // The answer is the provider's own batch answer, exactly as in the fast path.
        const ctx = { ...(await rebuildCtx(row, data, costCheck)), batchAnswer: Promise.resolve(answer) };
        const input = data.input && typeof data.input === 'object' ? data.input : parseJson(row.input, {});
        const controller = new AbortController();
        let hold = null;
        if (tiers) {
            try { hold = await tiers.admit(ctx, key); }
            catch (err) { log.warn(`[runs] ${key}: the tier budget refused the finished batch run: ${(err && err.message) || err}`); }
        }
        try {
            const reserved = await quotas.reserve(ctx).catch(() => null);
            await execute(key, { controller, reserved, scope: null, ctx, input, hold });
        } finally {
            if (hold && tiers && tiers.release) await tiers.release(hold).catch(() => {});
        }
        return get(key);
    }

    /**
     * BA2: the context a finished batch run needs, rebuilt from the run row and the plan the batcher
     * stored with the item. Only the fields the run's completion reads are here; the plan's principal
     * snapshot holds the fields create() reads, and never a token.
     */
    async function rebuildCtx(row, data, costCheck) {
        const opts = parseJson(row.options, {});
        const attribution = parseJson(row.attribution, null);
        const onBehalfOf = parseJson(row.on_behalf_of, null);
        const principal = data.principal || {};
        // The person the run was made for: the row names them, and the options say whether they pay.
        const personSubject = opts.person_pays !== undefined ? (onBehalfOf && onBehalfOf.id ? String(onBehalfOf.id) : null) : null;
        const tokenBudget = runBudgets && principal.jti ? await runBudgets.spent(principal.jti).catch(() => null) : null;
        const serviceBudgeted = Boolean(principal.servicePaid)
            || Boolean(tokenBudget && (tokenBudget.budget_usd != null || tokenBudget.budget_tokens != null));
        const isApp = principal.kind === 'app';
        return {
            requesterType: row.requester_type,
            requesterId: row.requester_id,
            ...(principal.jti ? { runJti: principal.jti } : {}),
            actorKey: subjectKey(onBehalfOf),
            targetKey: row.target_key,
            attributionKey: entityKey(attribution),
            workflowKey: row.workflow_key,
            ...(isApp ? { appRun: true, projectId: principal.projectId, sandbox: principal.env === 'sandbox', appId: principal.appId } : {}),
            onBehalfOf: personSubject || principal.onBehalfOf || null,
            personSubject,
            personPays: Boolean(opts.person_pays),
            serviceBudgeted,
            freeUse: false,                                        // a batch run is never the anonymous Try it
            ...(data.discount ? { discount: String(data.discount) } : {}),
            ...(data.maxCostNano != null ? { maxCostNano: String(data.maxCostNano) } : {}),
            ...(costCheck ? { costCheck } : {}),
            latencyClass: row.latency_class || 'batch',
            runId: row.id,
        };
    }

    /** Queue depth for /metrics and /api/ready: runs waiting for a slot, and runs holding one. */
    function stats() { return { queued: queue.length, running: active, inflight: inflight.size, max_concurrent: config.runs.maxConcurrent, max_queued: config.runs.maxQueued }; }

    return { create, wait, get, getReceipt, list, listOnBehalfOf, cancel, retry, citations, addCitations, requestsFor, explained, recoverInterrupted, prune, drain, stats, inflight, TERMINAL, decode, completeBatch, deferred };
}

module.exports = { createRuns, entityKey, subjectKey };
