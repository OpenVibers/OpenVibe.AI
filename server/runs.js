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
const { preferenceLines } = require('./user-modules');
const schemas = require('./schemas');
const events = require('./events');
const usageSamples = require('./usage-samples');

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

function createRuns({ db, registry, engine, cache, quotas, config, clock = { now: () => Date.now() }, log = console, userModules = null, credentials = null, tiers = null, projectSecrets = null, pool = null }) {
    const inflight = new Map();     // run id -> { controller, promise, release, caller }
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
    async function create(body, principal, { trace = null, requestId = null, retryOf = null, onDelta = null } = {}) {
        if (!body || typeof body !== 'object') throw new AiError(400, 'input.invalid', 'JSON body required');
        const wfKey = String(body.workflow || '');
        const wf = body.version ? await registry.getWorkflow(wfKey, Number(body.version)) : await registry.activeWorkflow(wfKey);
        if (!wf) throw new AiError(404, 'workflow.not_found', `no active workflow ${wfKey}${body.version ? ` v${body.version}` : ''}`);
        if (body.version && !['active', 'deprecated'].includes(wf.status)) throw new AiError(409, 'workflow.inactive', `${wfKey} v${wf.version} is ${wf.status}`);
        const pinned = routePinRequest(body.route, principal, wf);
        if (pinned && body.credential != null) throw new AiError(422, 'input.invalid', 'a pinned route cannot be combined with a person\'s credential; the pin is the provider');
        validateRefs(body);
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
        if (projectProvider) {
            if (!app) throw new AiError(403, 'capability.denied', 'only a developer app names its project\'s own provider');
            if (wf.key !== 'ai.complete') throw new AiError(422, 'input.invalid', 'a project provider is used for ai.complete only');
            if (!projectSecrets || !projectSecrets.available()) throw new AiError(503, 'project_secret.unavailable', 'project secrets are not configured on this service');
        }
        const ctx = {
            requesterType: requester.type, requesterId: requester.id,
            actorKey: subjectKey(body.on_behalf_of), targetKey: entityKey(body.target), attributionKey: entityKey(body.attribution), workflowKey: wf.key,
            ...(app ? { appRun: true, projectId: app.projectId, sandbox: app.sandbox } : {}),
            ...(pinned ? { routePin: pinned } : {}),
            // POST /v1/chat/completions with stream: true: the upstream's deltas, as they arrive (kept in memory only).
            ...(typeof onDelta === 'function' ? { onDelta } : {}),
        };
        const now = iso(clock.now());
        const id = newRunId();
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
            options: JSON.stringify({ cache: options.cache !== false && credentialSubject === null && !projectProvider && !pinned, debug: Boolean(options.debug), input_retained: kept.full,
                ...(credentialSubject !== null ? { credential_subject: credentialSubject } : {}), ...(credentialProvider !== null ? { credential_provider: credentialProvider } : {}),
                ...(projectProvider ? { project_provider: projectProvider } : {}), ...(pinned ? { pinned_offer: pinned } : {}) }), created_at: now,
        };
        base.input = stableStringify(kept.value);

        // Cache (scoped; never crosses requester/actor/target/attribution)
        // A pinned run is never served from (or written to) the shared cache: the caller asked for THIS model,
        // and another model's answer under the same prompt would silently break the pin.
        const scope = options.cache === false || credentialSubject !== null || projectProvider || pinned ? null : cache.scopeFor(wf.cache_mode, ctx);
        let cacheKey = null;
        if (scope) {
            cacheKey = cache.keyFor({ scope, workflowKey: wf.key, workflowVersion: wf.version, templateVersion: base.template_version, routeKey: base.route_key, routeVersion: base.route_version, inputHash });
            const hit = await cache.get(cacheKey, scope);
            if (hit) {
                await db.tx(async () => {
                    const cacheExplain = { objective: 'cache', reasons: ["the answer was already in this scope's cache; no provider was called"], selected: null, candidates: [] };
                    await db.prepare(`INSERT INTO runs (id, workflow_key, workflow_version, template_key, template_version, route_key, route_version, status, requester_type, requester_id, on_behalf_of, attribution,
                        source_service, target, target_key, input, input_hash, output, model_key, cache_key, cached_from, retry_of, idempotency_key, trace_id, request_id, options, explain, created_at, started_at, finished_at, citations_count)
                        VALUES (@id, @workflow_key, @workflow_version, @template_key, @template_version, @route_key, @route_version, 'cached', @requester_type, @requester_id, @on_behalf_of, @attribution,
                        @source_service, @target, @target_key, @input, @input_hash, @output, @model_key, @cache_key, @cached_from, @retry_of, @idempotency_key, @trace_id, @request_id, @options, @explain, @created_at, @created_at, @created_at, 0)`)
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
                await registry.audit(principal.sub, 'run.create', 'run', id, { trace, metadata: { workflow: wf.key, version: wf.version, status: 'cached', cached_from: hit.run_id } });
                return { run: await get(id), created: true, promise: null };
            }
        }

        // Queue caps, then quota: both before any provider call (a refused run is not counted).
        const caller = `${requester.type}:${requester.id}`;
        admit(caller);
        // A run with a person's own key spends their money, not the shared quotas (its own budget was checked above).
        // The tier budgets (server/govern.js, AI_GOVERN_TIERS) hold first, so a run they refuse is not counted by reserve().
        const hold = credentialSubject !== null || projectProvider || !tiers ? null : await tiers.admit(ctx, id);
        let reserved;
        try {
            reserved = credentialSubject !== null ? null : await quotas.reserve(ctx);
        } catch (err) { if (hold) await tiers.release(hold); throw err; }

        try {
            await db.tx(async () => {
                await db.prepare(`INSERT INTO runs (id, workflow_key, workflow_version, template_key, template_version, route_key, route_version, status, requester_type, requester_id, on_behalf_of, attribution,
                    source_service, target, target_key, input, input_hash, cache_key, retry_of, idempotency_key, trace_id, request_id, options, created_at)
                    VALUES (@id, @workflow_key, @workflow_version, @template_key, @template_version, @route_key, @route_version, 'queued', @requester_type, @requester_id, @on_behalf_of, @attribution,
                    @source_service, @target, @target_key, @input, @input_hash, @cache_key, @retry_of, @idempotency_key, @trace_id, @request_id, @options, @created_at)`)
                    .run({ ...base, cache_key: cacheKey });
                await events.runChanged(await getRow(id));
            });
        } catch (err) { if (hold) await tiers.release(hold); throw err; }
        await registry.audit(principal.sub, retryOf ? 'run.retry' : 'run.create', 'run', id, { trace, metadata: { workflow: wf.key, version: wf.version, target: ctx.targetKey, retry_of: retryOf, ...(pinned ? { pinned_offer: pinned } : {}) } });

        const controller = new AbortController();
        let release;
        const gate = new Promise((r) => { release = r; });
        // Whatever the run's end, a tier hold it did not settle (accounted) goes back.
        const promise = gate.then(async () => { try { await execute(id, { controller, reserved, scope, ctx, input, hold }); } finally { if (hold) await tiers.release(hold); } }).catch((err) => { log.error(`[runs] ${id}: ${err.stack || err}`); });
        inflight.set(id, { controller, promise, release, caller });
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
            const id = queue.shift();
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
            explain: { objective: null, reasons: [`the project's own provider at ${new URL(spec.base_url).origin} (project secret ${spec.secret}, ${environment})`], selected: `project:${ctx.projectId}`, candidates: [] },
        };
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
        try {
            // A run on a person's behalf follows their ai.preferences (Network user module): style, length and
            // perspective shape the prompt; history: false keeps neither their input nor a cache entry.
            const preferences = userModules && row.on_behalf_of ? await userModules.preferencesFor(row.on_behalf_of) : {};
            if (preferences.history === false) {
                await db.prepare("UPDATE runs SET input = 'null', cache_key = NULL, options = (COALESCE(options, '{}')::jsonb || jsonb_build_object('input_retained', false, 'history', false))::text WHERE id = ?").run(id);
            }
            const credential = opts.credential_subject ? await credentials.forRun(row.requester_id, opts.credential_subject, opts.credential_provider || null)
                : opts.project_provider ? await projectCredential(opts.project_provider, ctx) : null;
            const r = await engine.execute(wf, row, input, { signal: controller.signal, logRequest, debugRaw: Boolean(config.debugRawLog && opts.debug), inputHash: row.input_hash, preferences,
                // A developer app's run (ADR-014): the provider pool excludes a person's byok key, and the run is
                // limited to free and local capacity when it is a sandbox run or when no tier budget governs its
                // project (AI_GOVERN_TIERS off): metered capacity is only ever spent under a project budget.
                appRun: Boolean(ctx.appRun), freeOnly: Boolean(ctx.appRun && (ctx.sandbox || !(tiers && tiers.enabled))),
                // Who asked, for a step that must not call the caller back (research: Search's own web ladder).
                requesterType: ctx.requesterType, requesterId: ctx.requesterId,
                ...(ctx.routePin ? { routePin: ctx.routePin } : {}),
                ...(credential ? { credential, role: input && typeof input.role === 'string' ? input.role : null } : {}),
                ...(typeof ctx.onDelta === 'function' ? { onDelta: ctx.onDelta } : {}) });
            if (controller.signal.aborted) throw new AiError(409, 'run.cancelled', 'cancelled');
            // The status, its citations and the ai.run.succeeded event commit together.
            const done = await db.tx(async () => {
                const d = await db.prepare(`UPDATE runs SET status = 'succeeded', output = ?, grounding = ?, synthetic = ?, provider_key = ?, model_key = ?, fallback_used = ?, attempts = ?, tokens_in = ?, tokens_out = ?, cost_usd = ?,
                    route_key = COALESCE(?, route_key), route_version = COALESCE(?, route_version), explain = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
                    .run(JSON.stringify(r.output), JSON.stringify(r.grounding || null), r.synthetic ? 1 : 0, r.provider, r.model, r.fallbackUsed ? 1 : 0, attempts, r.usage.input, r.usage.output, r.cost,
                        r.route ? r.route.key : null, r.route ? r.route.version : null, r.explain ? JSON.stringify(r.explain) : null, iso(clock.now()), id);
                if (!d.changes) return d;
                if (r.citations.length) await addCitations(id, r.citations, 'workflow');
                await events.runChanged(await getRow(id));
                return d;
            });
            if (!done.changes) return;       // cancelled while finishing
            if (r.provider && reserved) await quotas.account(ctx, reserved, { provider: r.provider, model: r.model, tokensIn: r.usage.input, tokensOut: r.usage.output, tokensCached: r.usage.cached, cost: r.cost, attempts: logged, runId: id, traceId: row.trace_id, hold });
            if (r.fallbackUsed) await registry.audit('system', 'run.fallback', 'run', id, { trace: row.trace_id, metadata: { workflow: row.workflow_key, provider: r.provider, route: r.route && r.route.key } });
            // Output shaped by someone's preferences, or kept for nobody (history off), is never cached for reuse.
            if (scope && row.cache_key && !r.synthetic && wf.cache_mode !== 'none' && preferences.history !== false && !preferenceLines(preferences)) {
                await cache.put({ key: row.cache_key, scope, privacy: wf.cache_mode, workflowKey: wf.key, workflowVersion: wf.version, templateVersion: row.template_version, routeKey: row.route_key, routeVersion: row.route_version, model: r.model, inputHash: row.input_hash, output: r.output, runId: id, ttlSec: wf.cache_ttl_sec || config.runs.defaultCacheTtlSec });
            }
        } catch (err) {
            const interrupted = shuttingDown && controller.signal.aborted;
            const cancelled = !interrupted && (controller.signal.aborted || (err && err.code === 'run.cancelled'));
            const code = interrupted ? 'run.interrupted' : cancelled ? 'run.cancelled' : (err instanceof AiError ? err.code : 'run.internal');
            const detail = interrupted ? 'the service shut down while this run was in progress' : cancelled ? 'cancelled' : (err instanceof AiError ? err.detail : 'internal error');
            if (!(err instanceof AiError) && !cancelled) log.error(`[runs] ${id} crashed: ${err && err.stack || err}`);
            const extra = err instanceof AiError && err.extra ? JSON.stringify(err.extra).slice(0, 2000) : null;
            const explain = err instanceof AiError && err.extra && err.extra.explain ? JSON.stringify(err.extra.explain) : null;
            await db.tx(async () => {
                const f = await db.prepare(`UPDATE runs SET status = ?, error_code = ?, error_detail = ?, attempts = ?, explain = COALESCE(?, explain), finished_at = ? WHERE id = ? AND status IN ('queued', 'running')`)
                    .run(cancelled ? 'cancelled' : 'failed', code, extra ? `${detail} ${extra}` : detail, attempts, explain, iso(clock.now()), id);
                if (f.changes) await events.runChanged(await getRow(id));
            });
            const spent = await db.prepare("SELECT COALESCE(SUM(tokens_in),0)::bigint ti, COALESCE(SUM(tokens_out),0)::bigint tout, COALESCE(SUM(cost_usd),0) c FROM requests WHERE run_id = ? AND status = 'ok'").get(id);
            // Account the spent tokens/cost as before, but always roll up the finished attempts (the failed
            // ones included) into provider_stats_daily/placement_state: a run that answered nothing still
            // tells the router a provider was unhealthy.
            if (reserved && logged.some((e) => e.status !== 'skipped')) await quotas.account(ctx, reserved, { provider: 'mixed', model: '', tokensIn: spent.ti, tokensOut: spent.tout, cost: spent.c, attempts: logged, writeUsage: Boolean(spent.ti || spent.tout), runId: id, traceId: row.trace_id, hold });
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
            const r = await db.prepare("UPDATE runs SET status = 'failed', error_code = 'run.interrupted', error_detail = 'the service restarted while this run was in progress', finished_at = ? WHERE status IN ('queued', 'running')").run(iso(clock.now()));
            for (const { id } of open) await events.runChanged(await getRow(id));
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
        for (const h of inflight.values()) { h.controller.abort(); h.release(); }
        await Promise.allSettled([...inflight.values()].map(h => h.promise));
    }

    /** Queue depth for /metrics and /api/ready: runs waiting for a slot, and runs holding one. */
    function stats() { return { queued: queue.length, running: active, inflight: inflight.size, max_concurrent: config.runs.maxConcurrent, max_queued: config.runs.maxQueued }; }

    return { create, wait, get, getReceipt, list, listOnBehalfOf, cancel, retry, citations, addCitations, requestsFor, explained, recoverInterrupted, prune, drain, stats, inflight, TERMINAL, decode };
}

module.exports = { createRuns, entityKey, subjectKey };
