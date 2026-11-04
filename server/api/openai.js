'use strict';
/**
 * The OpenAI-compatible endpoint: POST /v1/chat/completions on ai.openvibe.services, so a client built for OpenAI's API
 * (the SDKs, coding agents, Codes' harnesses) points its base URL at https://ai.openvibe.services/v1 and works.
 *
 *   Authorization: Bearer <a Network token>   an app's token (ai.app.run, its project pays) or a first-party service's
 *                                              (ai.run.create), exactly as POST /api/v1/chat takes them
 *   body                                       OpenAI Chat Completions: messages (with tool calls and tool results),
 *                                              tools, tool_choice, parallel_tool_calls, response_format, stop, seed,
 *                                              temperature, top_p, max_tokens / max_completion_tokens, stream
 *   model                                      with AI_MODEL_CATALOG off, ignored: AI's router picks the upstream
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
const { CAPS } = require('../auth');
const { appAttribution } = require('../apps');
const { credentialFor } = require('./credential');
const models = require('./models');

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
            if (typeof res.flushHeaders === 'function') res.flushHeaders();
            opened = true;
            for (const d of waiting.splice(0)) write(chunk(d));
        },
        write,
        sentAny: () => any,
        finished: (i) => finishedIdx.has(i),
        fail(message, code) {
            const status = code === 'ai.run_budget_reached' || code === 'billing.insufficient_funds' ? 402 : /^(input|validation)\./.test(code || '') ? 400 : /quota|allowance|budget/.test(code || '') ? 429 : 503;
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

function openaiRouter({ runs, auth, config, registry, log = console }) {
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
        // AI Exchange D3 (AI_MODEL_CATALOG): the `model` the caller names is exact, or one of the dynamic aliases.
        // With the flag off it is ignored exactly as before (the router picks).
        if (config.modelCatalog && config.modelCatalog.enabled) {
            if (b.model !== undefined && b.model !== null && typeof b.model !== 'string') return openaiError(res, 400, 'model must be a string', 'input.invalid');
            const requested = b.model == null ? 'openvibe/auto' : String(b.model).trim();
            if (!requested || requested.length > 256) return openaiError(res, 400, 'model must name an exact id or a dynamic alias', 'input.invalid');
            input.model = requested;
        }
        const maxTokens = b.max_completion_tokens != null ? b.max_completion_tokens : b.max_tokens;
        if (maxTokens != null) input.max_tokens = Math.max(1, Math.min(Number(maxTokens) || 1, 16000));
        // AI Exchange F: the caller's liability cap for the Credits hold (an OpenVibe extension, like x_openvibe).
        if (b.max_cost_usd != null) input.max_cost_usd = b.max_cost_usd;
        let body = { workflow: 'ai.complete', input };
        // L37: the soft preference (provider, and a model if the caller wants one). A wish, not a pin.
        if (b.prefer) body = { ...body, prefer: b.prefer };
        if (req.principal.kind === 'app') body = { ...body, attribution: appAttribution(req.principal) };
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
            const created = await runs.create(body, req.principal, { trace: req.ov && req.ov.traceId, requestId: req.ov && req.ov.requestId,
                ...(live ? { onDelta: live.delta } : {}),
                ...(live && config.modelCatalog && config.modelCatalog.enabled ? { onRoute: (info) => live.route(info) } : {}) });
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
            const status = code === 'ai.run_budget_reached' || code === 'billing.insufficient_funds' ? 402 : /^(input|validation)\./.test(code) ? 400 : /quota|allowance|budget/.test(code) ? 429
                : code === 'project_secret.refused' ? 403 : code === 'credential.endpoint_refused' ? 422
                : code === 'ai.model_unavailable' ? 400 : code === 'ai.model_not_found' ? 404 : 503;
            return openaiError(res, status, (run.error && run.error.detail) || code, code);
        }
        if (!['succeeded', 'cached'].includes(run.status) || !run.output || !Array.isArray(run.output.choices)) {
            return openaiError(res, 504, `the completion is still running; GET /api/v1/runs/${run.id}`, 'run.timeout');
        }
        const disclosure = await models.disclosureOf({ registry, config, run });
        if (live) live.route(disclosure);
        const created = Math.floor(Date.parse(run.created_at || new Date().toISOString()) / 1000) || Math.floor(Date.now() / 1000);
        const id = `chatcmpl-${run.id}`;
        const model = run.output.model || (run.provenance && run.provenance.model) || 'openvibe';
        const usage = { prompt_tokens: run.usage.tokens_in || 0, completion_tokens: run.usage.tokens_out || 0, total_tokens: (run.usage.tokens_in || 0) + (run.usage.tokens_out || 0) };
        const x = { run_id: run.id, provider: run.provenance && run.provenance.provider, fallback_used: Boolean(run.provenance && run.provenance.fallback_used), cost_usd: run.usage.cost_usd, synthetic: Boolean(run.synthetic) };
        if (!live) res.setHeader('X-OpenVibe-Run-Id', run.id);   // a stream sent it with its headers
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
            send({ ...base, choices: [], x_openvibe: disclosure ? { ...x, ...disclosure } : x });
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
