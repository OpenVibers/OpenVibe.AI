'use strict';
/**
 * The OpenAI-compatible endpoint: POST /v1/chat/completions on ai.openvibe.services, so a client built for OpenAI's API
 * (the SDKs, coding agents, Codes' harnesses) points its base URL at https://ai.openvibe.services/v1 and works.
 *
 *   Authorization: Bearer <a Network token>   an app's token (ai.app.run, its project pays) or a first-party service's
 *                                              (ai.run.create), exactly as POST /api/v1/chat takes them
 *   body                                       OpenAI Chat Completions: messages (with tool calls and tool results),
 *                                              tools, tool_choice, parallel_tool_calls, response_format, stop, seed,
 *                                              temperature, top_p, max_tokens / max_completion_tokens, stream; the
 *                                              OpenVibe extensions `policy` ("standard" | "uncensored", the adult tier:
 *                                              see docs/provider-adapters.md) and `on_behalf_of` (the person it is for)
 *   model                                      with AI_MODEL_CATALOG off, ignored (an exact id is refused): AI's router picks the upstream
 *                                              for route default.chat. On, an exact id
 *                                              `<org>/<model>[:<quant>]@<revision>` (runs only that artifact, never a
 *                                              substitute) or a dynamic alias (`openvibe/auto|economy|balanced|fast|
 *                                              private`, legacy `openvibe` = auto); the answer names the model that ran
 *                                              and carries the `openvibe` disclosure (an SSE comment first when
 *                                              streaming, and a field on the final chunk)
 *
 *   x-openvibe-credential                      the person's own key for a provider instead of the router
 *                                              (Codes C3): <provider> or <provider>:<subject>
 *   x_openvibe.provider                        an app's own provider instead of the router: { base_url (https, an
 *                                              OpenAI-format API), model, secret (the name of a project secret granted
 *                                              to ai for reveal to that origin, ADR-056) }; the key is revealed for
 *                                              that one run, and the project pays its provider directly
 *   x_openvibe.on_behalf_of                    a first-party service naming the person it acts for (a SubjectRef
 *                                              { type: 'user', id: 'usr_…' }, or the run token's own claim): their free
 *                                              allowance and cache scope, never their Balance. A person's own token
 *                                              runs for themselves and may hold it.
 *
 * GET /v1/models lists the registry's real models in ai.model@1 shape plus the dynamic aliases (behind
 * AI_MODEL_CATALOG; off, the legacy single `openvibe` model); GET /v1/models/{id} answers one. Both protocols share
 * the path: an Anthropic client (anthropic-version, or ?format=anthropic) is served by server/api/messages.js.
 *
 * Each request is a run of workflow ai.complete, so it has the run's quota, free allowance, cost, audit and explain
 * (x_openvibe in the answer); the prompt is not kept. stream: true answers server-sent events in the Chat Completions
 * chunk format as the upstream streams them (an OpenAI-format upstream, the router's or the project's own): each delta
 * goes out when it arrives, then usage (stream_options.include_usage), x_openvibe and [DONE]. The run still ends with
 * the whole answer, its usage and cost. An answer that came back in one piece (a replayed idempotent run, an upstream
 * that cannot stream) is sent as one delta. A failure after the stream began is an `error` event, then [DONE]. Errors are OpenAI's
 * shape ({ error: { message, type, code } }) with the HTTP status the run's problem had.
 */
const express = require('express');
const { controls } = require('../effort/defaults');
const { CAPS } = require('../auth');
const { appAttribution } = require('../apps');
const { credentialFor } = require('./credential');
const models = require('./models');
const modelCatalog = require('../providers/model-catalog');
const { EXACT_ID } = modelCatalog;
const { resolveRequest } = require('../exchange/presets');
const { compact, receiptId } = require('../exchange/receipts');

const FIELDS = ['messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'stop', 'seed', 'top_p', 'presence_penalty', 'frequency_penalty', 'temperature'];

// Cloudflare answers a 502 or 504 from the origin with its own HTML page, so an OpenAI client would get no JSON error:
// an upstream that failed or could not be reached is 503 (OpenAI's own "unavailable, retry"), the body kept. An invalid
// request is OpenAI's 400, not 422.
const gatewaySafe = (status) => (status === 502 || status === 504 ? 503 : status === 422 ? 400 : status);

/**
 * The event stream of one streamed completion. delta(d) sends a chunk as it arrives (or keeps it until open(run) has
 * sent the headers, which happens once the run exists); write(o) sends any chunk; fail() sends OpenAI's error object as
 * an event; done() ends with [DONE]. A closed connection drops what is left, quietly.
 *
 * AI Exchange D3: once the router has picked the offer (route(info)), the stream's first line is the `openvibe`
 * disclosure as an SSE comment, before any data event. The final chunk carries the same object as `openvibe`.
 */
function createLiveStream(res) {
    let run = null;
    let opened = false;
    let any = false;
    let routeInfo = null;
    let commented = false;
    const waiting = [];
    const finishedIdx = new Set();
    const created = Math.floor(Date.now() / 1000);
    const alive = () => !res.writableEnded && !res.destroyed;
    const comment = () => {
        if (commented || !routeInfo || !alive()) return;
        res.write(`: x_openvibe ${JSON.stringify(routeInfo)}\n\n`);
        commented = true;
    };
    const write = (o) => { if (alive()) { comment(); res.write(`data: ${JSON.stringify(o)}\n\n`); } };
    const chunk = (d) => ({ id: `chatcmpl-${run.id}`, object: 'chat.completion.chunk', created, model: d.model || 'openvibe', system_fingerprint: null,
        choices: [{ index: d.index || 0, delta: d.delta || {}, finish_reason: d.finish_reason || null }] });
    const out = {
        get opened() { return opened; },
        route(info) { if (info) routeInfo = info; },
        delta(d) {
            any = true;
            if (d.finish_reason) finishedIdx.add(d.index || 0);
            if (!opened) { waiting.push(d); return; }
            write(chunk(d));
        },
        open(r) {
            run = r;
            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Accel-Buffering', 'no');
            res.setHeader('X-OpenVibe-Run-Id', r.id);
            // A stream's headers go out before the answer is known: the receipt's id is known from the run id
            // (it is the same receipt), and the receipt itself travels in the last chunk.
            res.setHeader('x-openvibe-receipt-id', receiptId(r.id));
            if (typeof res.flushHeaders === 'function') res.flushHeaders();
            opened = true;
            for (const d of waiting.splice(0)) write(chunk(d));
        },
        write,
        sentAny: () => any,
        finished: (i) => finishedIdx.has(i),
        fail(message, code) {
            const status = code === 'ai.run_budget_reached' || code === 'ai.allowance_spent' || code === 'billing.insufficient_funds' || code === 'billing.payer_required' ? 402 : /^(input|validation)\./.test(code || '') ? 400 : /quota|allowance|budget/.test(code || '') ? 429 : 503;
            write({ error: { message: String(message || 'error').slice(0, 1000), type: status === 400 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : status === 402 ? 'insufficient_quota' : 'api_error', code: code || null, param: null } });
            return out.done();
        },
        done() { if (alive()) { res.write('data: [DONE]\n\n'); res.end(); } },
    };
    return out;
}

function openaiError(res, status, message, code, type) {
    res.status(status).json({ error: { message: String(message || 'error').slice(0, 1000), type: type || (status === 401 || status === 403 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status === 402 ? 'insufficient_quota' : status >= 500 ? 'api_error' : 'invalid_request_error'), code: code || null, param: null } });
}

function openaiRouter({ runs, auth, config, registry, presets = null, receipts = null, log = console }) {
    const r = express.Router();
    // Developer apps call with ai.app.run, the public capability they already hold (ADR-014; AI Exchange D8').
    const allow = auth.appOrCap(CAPS.appRun, CAPS.runCreate);

    // A problem from the auth layer arrives as problem+json; a client built for OpenAI reads { error }: convert it as
    // it is written, whichever way the layer writes it.
    const typeFor = (status) => (status === 401 || status === 403 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error');
    const asOpenAiErrors = (req, res, next) => {
        // An Anthropic models request is handled by the Messages router (which has Anthropic's error shape); step
        // out of the way here before that router's auth guard writes anything.
        if (req.method === 'GET' && /^\/v1\/models(\/|$)/.test(req.path) && models.wantsAnthropic(req)) return next();
        const end = res.end.bind(res);
        res.end = (chunk, ...rest) => {
            const ct = String(res.getHeader('Content-Type') || '');
            if (res.statusCode >= 400 && /problem\+json/.test(ct) && chunk) {
                let p = null;
                try { p = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)); } catch { p = null; }
                if (p && (p.error == null || typeof p.error !== 'object')) {
                    const body = JSON.stringify({ error: { message: String(p.detail || p.title || p.code || 'error'), type: typeFor(res.statusCode), code: p.code || null, param: null } });
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    res.setHeader('Content-Length', Buffer.byteLength(body));
                    return end(body);
                }
            }
            return end(chunk, ...rest);
        };
        next();
    };

    r.post('/v1/chat/completions', asOpenAiErrors, allow, async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        if (!Array.isArray(b.messages) || !b.messages.length) return openaiError(res, 400, 'messages must be a non-empty array', 'input.invalid');
        if (b.n != null && Number(b.n) !== 1) return openaiError(res, 400, 'n must be 1', 'input.invalid');
        const input = {};
        for (const k of FIELDS) if (b[k] !== undefined && b[k] !== null) input[k] = b[k];
        // The routing preset (server/exchange/presets.js): `model: "@preset/cheapest"` or `preset: "cheapest"`,
        // and a request's own `max_price` (USD per million tokens). A preset nobody has is a refusal, never a
        // silent default.
        let preset = null;
        try {
            preset = await resolveRequest({ presets, principal: req.principal, body: b });
        } catch (err) {
            if (err && err.status) return openaiError(res, err.status, err.detail || err.message, err.code);
            throw err;
        }
        // AI Exchange D3 (AI_MODEL_CATALOG): the `model` the caller names is exact, or one of the dynamic aliases.
        // With the flag off it is ignored exactly as before (the router picks), except an exact id: that is a pin, and a
        // pin is never silently run on another model (a rollback of the flag included), so it is refused.
        const catalogOn = Boolean(config.modelCatalog && config.modelCatalog.enabled);
        const rawModel = b.model == null ? '' : String(b.model).trim();
        // A preset named as the model is the router's own choice with the preset's rules: the model is the alias.
        const presetModel = rawModel.toLowerCase().startsWith('@preset/');
        if (!catalogOn && typeof b.model === 'string' && EXACT_ID.test(b.model.trim())) {
            return openaiError(res, 400, 'an exact model id needs the model catalog, which is off: name a dynamic model (openvibe) instead', 'ai.model_unavailable');
        }
        if (catalogOn) {
            if (b.model !== undefined && b.model !== null && typeof b.model !== 'string') return openaiError(res, 400, 'model must be a string', 'input.invalid');
            const requested = (b.model == null || presetModel) ? 'openvibe/auto' : rawModel;
            if (!requested || requested.length > 256) return openaiError(res, 400, 'model must name an exact id or a dynamic alias', 'input.invalid');
            input.model = requested;
            // An exact id is a pin: an unknown or inactive artifact is refused here, before the run (and its stream)
            // exists, so a streaming client gets the 404/400 it expects rather than a 200 SSE error. The engine selects
            // the same artifact again when the run executes.
            if (EXACT_ID.test(requested)) {
                try {
                    await modelCatalog.select({ registry, model: requested, route: null });
                } catch (err) {
                    if (err && err.status) return openaiError(res, err.status, err.detail || err.message, err.code);
                    throw err;
                }
            }
        }
        const maxTokens = b.max_completion_tokens != null ? b.max_completion_tokens : b.max_tokens;
        if (maxTokens != null) input.max_tokens = Math.max(1, Math.min(Number(maxTokens) || 1, 16000));
        // AI Exchange F: the caller's liability cap for the Balance hold (an OpenVibe extension, like x_openvibe).
        if (b.max_cost_usd != null) input.max_cost_usd = b.max_cost_usd;
        let body = { ...controls(b), workflow: 'ai.complete', input, idempotency_key: req.get('idempotency-key') || undefined };
        // The preset's rules ride the run into the router.
        if (preset) body = { ...body, preset: { name: preset.name, scope: preset.scope, policy: preset.policy } };
        if (preset && preset.policy.adult && b.policy == null) body = { ...body, policy: 'uncensored' };
        // A caller must opt in before a person's machine sees the prompt.
        if (req.get('x-openvibe-community') === '1' || (b.x_openvibe && b.x_openvibe.community === true)) body.community = true;
        // L37: the soft preference (provider, and a model if the caller wants one). A wish, not a pin.
        if (b.prefer) body = { ...body, prefer: b.prefer };
        // The Exchange remake's content policy (`policy: "uncensored"`): an OpenVibe extension, enforced by the router
        // (18+ account, uncensored offers only, the floor, the label). on_behalf_of names the person it is for.
        if (b.policy != null) body = { ...body, policy: b.policy };
        if (b.on_behalf_of != null) body = { ...body, on_behalf_of: b.on_behalf_of };
        if (req.principal.kind === 'app') body = { ...body, attribution: appAttribution(req.principal) };
        // A first-party service naming the person it acts for (the runs API's on_behalf_of). Their free allowance
        // and cache scope are theirs; their Balance pays only when they run with their own token. An app run is its
        // project's and never names a person, as on the runs API. A run token carries the claim, which the auth layer
        // reads into the principal.
        const obo = b.x_openvibe && typeof b.x_openvibe === 'object' ? b.x_openvibe.on_behalf_of : undefined;
        if (obo !== undefined) {
            if (req.principal.kind === 'app') return openaiError(res, 403, 'an app run is attributed to its project, never to a person', 'capability.denied');
            if (req.principal.kind === 'user' && (!obo || obo.id !== req.principal.subject.id)) return openaiError(res, 403, 'a person runs for themselves, never for someone else', 'capability.denied');
            body = { ...body, on_behalf_of: obo };
        }
        // The person's own key (Codes C3): x-openvibe-credential names the provider whose key this request uses.
        const personKey = credentialFor(req);
        if (personKey.error) return openaiError(res, personKey.status, personKey.error, 'invalid_request_error');
        if (personKey.credential) body = { ...body, credential: personKey.credential };
        const own = b.x_openvibe && typeof b.x_openvibe === 'object' ? b.x_openvibe.provider : undefined;
        if (own !== undefined) body = { ...body, project_provider: own };
        let run;
        // stream: true. The run is made first (a refused one keeps its status code); then the event stream opens and every
        // delta the upstream sends goes out as it arrives. A delta that came before the stream opened waits for it.
        const live = b.stream === true ? createLiveStream(res) : null;
        try {
            const created = await runs.create(body, req.principal, { trace: req.ov && req.ov.traceId, requestId: req.ov && req.ov.requestId, abuse: req.abuse,
                ...(live ? { onDelta: live.delta } : {}),
                ...(live && config.modelCatalog && config.modelCatalog.enabled ? { onRoute: (info) => live.route(info) } : {}) });
            if (created.created === false) res.setHeader('x-openvibe-replayed', '1');
            if (live) live.open(created.run);
            run = await runs.explained(await runs.wait(created, Math.max(config.runs.maxWaitMs, 120000)));
        } catch (err) {
            if (live && live.opened) return live.fail(err && (err.detail || err.message), err && err.code);
            const status = gatewaySafe((err && err.status) || 500);
            if (status === 429 && err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
            if (status >= 500) log.warn(`[ai] /v1/chat/completions: ${err && err.message}`);
            return openaiError(res, status, err && (err.detail || err.message), err && err.code);
        }
        if (live && (run.status === 'failed' || run.status === 'cancelled' || !run.output || !Array.isArray(run.output.choices))) {
            const code = (run.error && run.error.code) || (['failed', 'cancelled'].includes(run.status) ? 'run.failed' : 'run.timeout');
            return live.fail((run.error && run.error.detail) || (code === 'run.timeout' ? `the completion is still running; GET /api/v1/runs/${run.id}` : code), code);
        }
        if (run.status === 'failed' || run.status === 'cancelled') {
            const code = (run.error && run.error.code) || 'run.failed';
            const status = code === 'ai.run_budget_reached' || code === 'ai.allowance_spent' || code === 'billing.insufficient_funds' || code === 'billing.payer_required' ? 402 : /^(input|validation)\./.test(code) ? 400 : /quota|allowance|budget/.test(code) ? 429
                : code === 'project_secret.refused' ? 403 : code === 'credential.endpoint_refused' ? 422
                : code === 'policy.adult_required' || code === 'policy.uncensored_refused' || code === 'policy.floor_refused' ? 403
                : code === 'policy.uncensored_needs_person' ? 400
                : code === 'ai.model_unavailable' ? 400 : code === 'ai.model_not_found' ? 404
                : code === 'ai.max_price_exceeded' ? 400 : 503;
            return openaiError(res, status, (run.error && run.error.detail) || code, code);
        }
        if (!['succeeded', 'cached'].includes(run.status) || !run.output || !Array.isArray(run.output.choices)) {
            return openaiError(res, 504, `the completion is still running; GET /api/v1/runs/${run.id}`, 'run.timeout');
        }
        const disclosure = await models.disclosureOf({ registry, config, run });
        const community = (disclosure && disclosure.community) || (run.explain && run.explain.community) || null;
        if (community && !live) res.setHeader('X-OpenVibe-Community', '1');
        if (live) live.route(disclosure || (community ? { community } : null));
        const receipt = receipts ? await receipts.forRun(run.id) : null;
        const receiptView = receipt ? compact(receipt) : null;
        const created = Math.floor(Date.parse(run.created_at || new Date().toISOString()) / 1000) || Math.floor(Date.now() / 1000);
        const id = `chatcmpl-${run.id}`;
        const model = run.output.model || (run.provenance && run.provenance.model) || 'openvibe';
        const usage = { prompt_tokens: run.usage.tokens_in || 0, completion_tokens: run.usage.tokens_out || 0, total_tokens: (run.usage.tokens_in || 0) + (run.usage.tokens_out || 0) };
        const x = {
            run_id: run.id, provider: run.provenance && run.provenance.provider,
            fallback_used: Boolean(run.provenance && run.provenance.fallback_used), cost_usd: run.usage.cost_usd,
            synthetic: Boolean(run.synthetic),
            ...(community ? { community } : {}),
            ...(run.output.label ? { policy: run.output.policy || 'uncensored', label: run.output.label } : {}),
            privacy: receipt && receipt.privacy ? receipt.privacy.label : null,
            receipt_id: receipt ? receipt.id : null,
        };
        if (run.output.label) res.setHeader('X-OpenVibe-Content-Policy', run.output.policy || 'uncensored');
        if (!live) res.setHeader('X-OpenVibe-Run-Id', run.id);   // a stream sent it with its headers
        if (receipt && !live) {
            // The receipt travels in the headers: the compact JSON, and its id.
            res.setHeader('x-openvibe-receipt-id', receipt.id);
            res.setHeader('x-openvibe-receipt', JSON.stringify(receiptView));
        }
        if (live) {
            const send = (o) => live.write(o);
            const base = { id, object: 'chat.completion.chunk', created, model, system_fingerprint: run.output.system_fingerprint || null };
            // The deltas already went out as they arrived; close any choice whose finish the upstream did not stream.
            if (live.sentAny()) {
                for (const c of run.output.choices) if (!live.finished(c.index || 0)) send({ ...base, choices: [{ index: c.index || 0, delta: {}, finish_reason: c.finish_reason || 'stop' }] });
            } else for (const c of run.output.choices) {
                const m = c.message || {};
                const delta = { role: 'assistant', content: m.content == null ? null : m.content };
                if (Array.isArray(m.tool_calls) && m.tool_calls.length) delta.tool_calls = m.tool_calls.map((t, i) => ({ index: i, ...t }));
                send({ ...base, choices: [{ index: c.index || 0, delta, finish_reason: null }] });
                send({ ...base, choices: [{ index: c.index || 0, delta: {}, finish_reason: c.finish_reason || 'stop' }] });
            }
            if (b.stream_options && b.stream_options.include_usage) send({ ...base, choices: [], usage });
            // A stream's headers went out before the answer was known, so the receipt travels in the last chunk
            // (its id was in the headers, and the full receipt is one GET away).
            send({ ...base, choices: [], x_openvibe: disclosure ? { ...x, ...disclosure } : x, receipt: receiptView });
            return live.done();
        }
        return res.status(200).json({ id, object: 'chat.completion', created, model, choices: run.output.choices, usage, system_fingerprint: run.output.system_fingerprint || null, x_openvibe: disclosure ? { ...x, ...disclosure } : x });
    });

    // The model list a client asks for first. With AI_MODEL_CATALOG on it is the registry's real models plus the
    // dynamic aliases (ai.model@1 shape); with it off, the legacy single `openvibe` model. An Anthropic client (one
    // that sends anthropic-version) is served by the Messages router with that protocol's shape and error object.
    const notAnthropic = (req, res, next) => (models.wantsAnthropic(req) ? next('router') : next());
    const modelRoute = (fn) => async (req, res) => {
        try { await fn(req, res); } catch (err) {
            log.error(`[ai] ${req.method} ${req.path}: ${(err && err.stack) || err}`);
            if (!res.headersSent) models.sendError(res, 'openai', 500, 'internal error');
        }
    };
    r.get('/v1/models', asOpenAiErrors, notAnthropic, allow, modelRoute(async (req, res) => {
        await models.sendList(req, res, { registry, config, protocol: 'openai' });
    }));
    r.get('/v1/models/*', asOpenAiErrors, notAnthropic, allow, modelRoute(async (req, res) => {
        await models.sendOne(req, res, { registry, config, protocol: 'openai' });
    }));

    return r;
}

module.exports = { openaiRouter };
