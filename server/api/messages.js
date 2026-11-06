'use strict';
/**
 * The Anthropic-compatible endpoint: POST /v1/messages on ai.openvibe.services, so a client built for Anthropic's
 * Messages API (Claude Code, an SDK) points ANTHROPIC_BASE_URL at https://ai.openvibe.services and works (Codes C3).
 *
 *   Authorization: Bearer <a Network token>   an app's token (ai.app.run
 *                                              on; its project pays) or a first-party service's (ai.run.create)
 *   x-openvibe-credential: <provider>          the person's own key for that provider instead of the router: anthropic,
 *                                              deepseek or minimax (their Anthropic-compatible endpoints), or a custom
 *                                              endpoint. The person is `<provider>:<subject>`, or the token's
 *                                              on_behalf_of (an agent acting for them)
 *   body                                       Anthropic's Messages API: messages, system, tools, tool_choice,
 *                                              stop_sequences, temperature, top_p, top_k, max_tokens, metadata, stream
 *   model                                      with AI_MODEL_CATALOG off, ignored as before (an exact id is refused). On, an exact id
 *                                              `<org>/<model>[:<quant>]@<revision>` (runs only that artifact, never a
 *                                              substitute) or a dynamic alias (openvibe/auto|economy|balanced|fast|
 *                                              private; legacy openvibe = auto), with the `openvibe` disclosure: the
 *                                              first SSE comment when streaming and a field on the final message_stop.
 *                                              GET /v1/models[/{id}] lists them in Anthropic's shape; an OpenAI client
 *                                              (no anthropic-version) is served by server/api/openai.js.
 *
 * Each request is a run of workflow ai.messages, so it has the run's quota, free allowance, cost, audit and explain
 * (the run id rides X-OpenVibe-Run-Id) and the prompt is not kept. Without the header, AI's router picks an upstream that
 * speaks Anthropic's format (Anthropic's API, or DeepSeek's and MiniMax's Anthropic-compatible endpoints); an
 * OpenAI-format provider is never converted. stream: true answers Anthropic's own server-sent events as they arrive
 * (message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop, ping), and
 * the run still ends with the whole message. Errors are Anthropic's shape ({ type: 'error', error: { type, message } })
 * with the HTTP status the run's problem had.
 */
const express = require('express');
const { CAPS } = require('../auth');
const { appAttribution } = require('../apps');
const { credentialFor } = require('./credential');
const models = require('./models');
const modelCatalog = require('../providers/model-catalog');
const { EXACT_ID } = modelCatalog;
const { resolveRequest } = require('../exchange/presets');
const { compact, receiptId } = require('../exchange/receipts');

const FIELDS = ['system', 'tools', 'tool_choice', 'stop_sequences', 'temperature', 'top_p', 'top_k', 'metadata'];
const MAX_TOKENS = 64000;

// Anthropic's error types by HTTP status (docs.anthropic.com/en/api/errors).
function errorType(status) {
    if (status === 400 || status === 422) return 'invalid_request_error';
    if (status === 401) return 'authentication_error';
    if (status === 403) return 'permission_error';
    if (status === 404) return 'not_found_error';
    if (status === 413) return 'request_too_large';
    if (status === 429) return 'rate_limit_error';
    if (status === 503 || status === 529) return 'overloaded_error';
    return 'api_error';
}

function anthropicError(res, status, message, type, code = null) {
    res.status(status).json({ type: 'error', error: { type: type || errorType(status), message: String(message || 'error').slice(0, 1000), code: code || (status === 402 ? 'ai.run_budget_reached' : null) } });
}

/**
 * The event stream of one streamed message: each upstream event goes out as `event: <name>` + its JSON as it arrives (or
 * waits until open(run) has sent the headers). fail() sends Anthropic's error event; done() ends the stream.
 *
 * AI Exchange D3: once the router has picked the offer (route(info)), the stream's first line is the `x_openvibe`
 * disclosure as an SSE comment, before any event; the final message_stop event carries the whole x_openvibe object.
 */
function createEventStream(res) {
    let opened = false;
    let any = false;
    let routeInfo = null;
    let commented = false;
    let finalEvent = null;
    const waiting = [];
    const alive = () => !res.writableEnded && !res.destroyed;
    const comment = () => {
        if (commented || !routeInfo || !alive()) return;
        res.write(`: x_openvibe ${JSON.stringify(routeInfo)}\n\n`);
        commented = true;
    };
    const write = (event, data) => { if (alive()) { comment(); res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } };
    const emit = (event, data) => {
        if (!data) return;
        // message_stop is held until the run has settled: the final chunk carries the whole x_openvibe object (run_id,
        // provider, cost_usd and the route disclosure), and the cost is only known once the provider's usage is recorded.
        if (event === 'message_stop') { finalEvent = data; return; }
        write(event, data);
    };
    const out = {
        get opened() { return opened; },
        route(info) { if (info) routeInfo = info; },
        event(e) {
            if (!e || !e.event || !e.data) return;
            any = true;
            if (!opened) { waiting.push(e); return; }
            emit(e.event, e.data);
        },
        open(r) {
            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Accel-Buffering', 'no');
            res.setHeader('X-OpenVibe-Run-Id', r.id);
            // A stream's headers go out before the answer is known: the receipt's id is known from the run id
            // (it is the same receipt), and the receipt itself travels in the last event.
            res.setHeader('x-openvibe-receipt-id', receiptId(r.id));
            if (typeof res.flushHeaders === 'function') res.flushHeaders();
            opened = true;
            for (const e of waiting.splice(0)) emit(e.event, e.data);
        },
        emit,
        sentAny: () => any,
        /** The held message_stop with the final x_openvibe object (and the receipt), then end the stream. */
        finish(xOpenVibe, receipt) {
            const data = finalEvent || { type: 'message_stop' };
            finalEvent = null;
            write('message_stop', xOpenVibe ? { ...data, x_openvibe: xOpenVibe, ...(receipt ? { receipt } : {}) } : data);
            return out.done();
        },
        fail(message, code) {
            const status = code === 'ai.run_budget_reached' ? 402 : /^(input|validation)\./.test(code || '') ? 400 : /quota|allowance|budget/.test(code || '') ? 429 : 529;
            emit('error', { type: 'error', error: { type: errorType(status), message: String(message || 'error').slice(0, 1000), code: code || null } });
            return out.done();
        },
        done() { if (alive()) res.end(); },
    };
    return out;
}

/** The message as a sequence of Messages API events, for an answer that came back in one piece. */
function replay(res, message, run) {
    const u = message.usage || {};
    const usage = { input_tokens: u.input_tokens != null ? u.input_tokens : (run.usage && run.usage.tokens_in) || 0, output_tokens: 0,
        ...(u.cache_read_input_tokens != null ? { cache_read_input_tokens: u.cache_read_input_tokens } : {}),
        ...(u.cache_creation_input_tokens != null ? { cache_creation_input_tokens: u.cache_creation_input_tokens } : {}) };
    res.emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage } });
    (message.content || []).forEach((block, index) => {
        res.emit('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' } });
        if (block.type === 'text' && block.text) res.emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
        else if (block.type === 'tool_use') res.emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } });
        res.emit('content_block_stop', { type: 'content_block_stop', index });
    });
    res.emit('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason || 'end_turn', stop_sequence: message.stop_sequence || null }, usage: { output_tokens: u.output_tokens != null ? u.output_tokens : (run.usage && run.usage.tokens_out) || 0 } });
    res.emit('message_stop', { type: 'message_stop' });
}

function messagesRouter({ runs, auth, config, registry, presets = null, receipts = null, log = console }) {
    const r = express.Router();
    // Developer apps call with ai.app.run, the public capability they already hold (ADR-014; AI Exchange D8').
    const allow = auth.appOrCap(CAPS.appRun, CAPS.runCreate);

    // The auth layer writes problem+json; a client built for Anthropic reads { type: 'error', error: { … } }. Convert it
    // as it is written, whichever way the layer writes it.
    const asAnthropicErrors = (req, res, next) => {
        const end = res.end.bind(res);
        res.end = (chunk, ...rest) => {
            const ct = String(res.getHeader('Content-Type') || '');
            if (res.statusCode >= 400 && /problem\+json/.test(ct) && chunk) {
                let p = null;
                try { p = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)); } catch { p = null; }
                if (p && (p.type !== 'error')) {
                    const body = JSON.stringify({ type: 'error', error: { type: errorType(res.statusCode), message: String(p.detail || p.title || p.code || 'error') } });
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    res.setHeader('Content-Length', Buffer.byteLength(body));
                    return end(body);
                }
            }
            return end(chunk, ...rest);
        };
        next();
    };

    r.post('/v1/messages', asAnthropicErrors, allow, async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        if (!Array.isArray(b.messages) || !b.messages.length) return anthropicError(res, 400, 'messages: must be a non-empty array');
        if (!Number.isInteger(b.max_tokens) || b.max_tokens < 1) return anthropicError(res, 400, 'max_tokens: must be a positive integer');
        const input = { messages: b.messages, max_tokens: Math.min(b.max_tokens, MAX_TOKENS) };
        for (const k of FIELDS) if (b[k] !== undefined && b[k] !== null) input[k] = b[k];
        // AI Exchange F: the caller's liability cap for the Balance hold (an OpenVibe extension).
        if (b.max_cost_usd != null) input.max_cost_usd = b.max_cost_usd;
        // The routing preset (server/exchange/presets.js): `model: "@preset/cheapest"` or `preset: "cheapest"`,
        // and a request's own `max_price` (USD per million tokens). A preset nobody has is a refusal.
        let preset = null;
        try {
            preset = await resolveRequest({ presets, principal: req.principal, body: b });
        } catch (err) {
            if (err && err.status) return anthropicError(res, err.status, err.detail || err.message, null, err.code);
            throw err;
        }
        // AI Exchange D3 (AI_MODEL_CATALOG): an exact id or a dynamic alias. With the flag off the field is ignored
        // exactly as before, and the router picks, except an exact id: a pin is never silently run on another model (a
        // rollback of the flag included), so it is refused.
        const catalogOn = Boolean(config.modelCatalog && config.modelCatalog.enabled);
        const rawModel = b.model == null ? '' : String(b.model).trim();
        // A preset named as the model is the router's own choice with the preset's rules: the model is the alias.
        const presetModel = rawModel.toLowerCase().startsWith('@preset/');
        if (!catalogOn && typeof b.model === 'string' && EXACT_ID.test(b.model.trim())) {
            return anthropicError(res, 400, 'model: an exact model id needs the model catalog, which is off: name a dynamic model (openvibe) instead (ai.model_unavailable)');
        }
        if (catalogOn) {
            if (b.model !== undefined && b.model !== null && typeof b.model !== 'string') return anthropicError(res, 400, 'model: must be a string');
            const requested = (b.model == null || presetModel) ? 'openvibe/auto' : rawModel;
            if (!requested || requested.length > 256) return anthropicError(res, 400, 'model: must name an exact id or a dynamic alias');
            input.model = requested;
            // An exact id is a pin: an unknown or inactive artifact is refused here, before the run (and its stream)
            // exists, so a streaming client gets the 404/400 it expects rather than a 200 SSE error. The engine selects
            // the same artifact again when the run executes.
            if (EXACT_ID.test(requested)) {
                try {
                    await modelCatalog.select({ registry, model: requested, route: null });
                } catch (err) {
                    if (err && err.status) return anthropicError(res, err.status, err.detail || err.message, null, err.code);
                    throw err;
                }
            }
        }
        let body = { workflow: 'ai.messages', input };
        // The preset's rules ride the run into the router (server/exchange/constraints.js).
        if (preset) body = { ...body, preset: { name: preset.name, scope: preset.scope, policy: preset.policy } };
        // The uncensored preset asks for the adult tier. The gate (18+, the floor, the label) is the pool's own
        // policy, never the preset's: the preset only names the tier the request asks for.
        if (preset && preset.policy.adult && b.policy == null) body = { ...body, policy: 'uncensored' };
        // L37: the soft preference (provider, and a model if the caller wants one). A wish, not a pin.
        if (b.prefer) body = { ...body, prefer: b.prefer };
        // The Exchange remake's content policy (`policy: "uncensored"`), enforced by the router.
        if (b.policy != null) body = { ...body, policy: b.policy };
        if (b.on_behalf_of != null) body = { ...body, on_behalf_of: b.on_behalf_of };
        if (req.principal.kind === 'app') body = { ...body, attribution: appAttribution(req.principal) };
        const own = credentialFor(req);
        if (own.error) return anthropicError(res, own.status, own.error);
        if (own.credential) body = { ...body, credential: own.credential };
        // stream: true. The run is made first (a refused one keeps its status code); then the event stream opens and every
        // event the upstream sends goes out as it arrives. One that came before the stream opened waits for it.
        const live = b.stream === true ? createEventStream(res) : null;
        let run;
        try {
            const created = await runs.create(body, req.principal, { trace: req.ov && req.ov.traceId, requestId: req.ov && req.ov.requestId,
                ...(live ? { onDelta: live.event } : {}),
                ...(live && config.modelCatalog && config.modelCatalog.enabled ? { onRoute: (info) => live.route(info) } : {}) });
            if (live) live.open(created.run);
            run = await runs.explained(await runs.wait(created, Math.max(config.runs.maxWaitMs, 120000)));
        } catch (err) {
            if (live && live.opened) return live.fail(err && (err.detail || err.message), err && err.code);
            if ((err && err.status) >= 500) log.warn(`[ai] /v1/messages: ${err && err.message}`);
            return anthropicError(res, (err && err.status) || 500, err && (err.detail || err.message), err && err.code === 'credential.unsupported' ? 'invalid_request_error' : null);
        }
        if (live && (run.status === 'failed' || run.status === 'cancelled' || !run.output || !Array.isArray(run.output.content))) {
            const code = (run.error && run.error.code) || (['failed', 'cancelled'].includes(run.status) ? 'run.failed' : 'run.timeout');
            return live.fail((run.error && run.error.detail) || (code === 'run.timeout' ? `the message is still running; GET /api/v1/runs/${run.id}` : code), code);
        }
        if (run.status === 'failed' || run.status === 'cancelled') {
            const code = (run.error && run.error.code) || 'run.failed';
            const status = code === 'ai.run_budget_reached' || code === 'billing.insufficient_funds' || code === 'billing.payer_required' ? 402 : /^(input|validation)\./.test(code) ? 400 : /quota|allowance|budget/.test(code) ? 429
                : code === 'credential.unsupported' ? 422 : code === 'credential.not_found' ? 404
                : code === 'policy.adult_required' || code === 'policy.uncensored_refused' || code === 'policy.floor_refused' ? 403
                : code === 'policy.uncensored_needs_person' ? 400
                : code === 'ai.model_unavailable' ? 400 : code === 'ai.model_not_found' ? 404
                : code === 'ai.max_price_exceeded' ? 400 : 529;
            return anthropicError(res, status, (run.error && run.error.detail) || code, null, code);
        }
        if (!['succeeded', 'cached'].includes(run.status) || !run.output || !Array.isArray(run.output.content)) {
            return anthropicError(res, 529, `the message is still running; GET /api/v1/runs/${run.id}`, 'overloaded_error');
        }
        const out = run.output;
        const message = {
            id: out.id || `msg_${run.id}`, type: 'message', role: 'assistant',
            model: out.model || (run.provenance && run.provenance.model) || 'openvibe',
            content: out.content, stop_reason: out.stop_reason || 'end_turn', stop_sequence: out.stop_sequence || null,
            usage: {
                input_tokens: out.usage && out.usage.input_tokens != null ? out.usage.input_tokens : (run.usage.tokens_in || 0),
                output_tokens: out.usage && out.usage.output_tokens != null ? out.usage.output_tokens : (run.usage.tokens_out || 0),
                ...(out.usage && out.usage.cache_read_input_tokens != null ? { cache_read_input_tokens: out.usage.cache_read_input_tokens } : {}),
                ...(out.usage && out.usage.cache_creation_input_tokens != null ? { cache_creation_input_tokens: out.usage.cache_creation_input_tokens } : {}),
            },
        };
        const disclosure = await models.disclosureOf({ registry, config, run });
        if (live) live.route(disclosure);
        // The receipt of this answer (server/exchange/receipts.js): the offer, the price, the tokens, the cache,
        // the latency, why the router chose it, the fallbacks it would have used, the payer and the privacy label.
        const receipt = receipts ? await receipts.forRun(run.id) : null;
        const receiptView = receipt ? compact(receipt) : null;
        // D8': the route disclosure joins the existing x_openvibe object (run, provider, fallback, cost), never a second object.
        const x = { run_id: run.id, provider: run.provenance && run.provenance.provider, fallback_used: Boolean(run.provenance && run.provenance.fallback_used),
            cost_usd: run.usage.cost_usd, synthetic: Boolean(run.synthetic),
            ...(run.output.label ? { policy: run.output.policy || 'uncensored', label: run.output.label } : {}),
            privacy: receipt && receipt.privacy ? receipt.privacy.label : null, receipt_id: receipt ? receipt.id : null };
        if (run.output.label) {
            message.label = run.output.label;
            message.policy = run.output.policy || 'uncensored';
            res.setHeader('X-OpenVibe-Content-Policy', message.policy);
        }
        const xOpenVibe = disclosure ? { ...x, ...disclosure } : (run.output.label || receipt ? x : null);
        if (live) {
            // The events already went out as they arrived; an answer that came in one piece (an upstream that cannot
            // stream, a replayed run) is sent as the events it is. finish() sends the held message_stop with the whole
            // x_openvibe object, then ends the stream.
            if (!live.sentAny()) replay(live, message, run);
            return live.finish(xOpenVibe, receiptView);
        }
        res.setHeader('X-OpenVibe-Run-Id', run.id);
        if (receipt) {
            res.setHeader('x-openvibe-receipt-id', receipt.id);
            res.setHeader('x-openvibe-receipt', JSON.stringify(receiptView));
        }
        return res.status(200).json(xOpenVibe ? { ...message, x_openvibe: xOpenVibe } : message);
    });

    // The model list a client asks for. An Anthropic client identifies itself with `anthropic-version`; the OpenAI
    // router steps aside for it, so the response, the access check and the error object are Anthropic's. With
    // AI_MODEL_CATALOG off this is exactly the legacy single virtual model.
    const onlyAnthropic = (req, res, next) => (models.wantsAnthropic(req) ? next() : next('router'));
    const modelRoute = (fn) => async (req, res) => {
        try { await fn(req, res); } catch (err) {
            log.error(`[ai] ${req.method} ${req.path}: ${(err && err.stack) || err}`);
            if (!res.headersSent) models.sendError(res, 'anthropic', 500, 'internal error');
        }
    };
    r.get('/v1/models', asAnthropicErrors, onlyAnthropic, allow, modelRoute(async (req, res) => {
        await models.sendList(req, res, { registry, config, protocol: 'anthropic' });
    }));
    r.get('/v1/models/*', asAnthropicErrors, onlyAnthropic, allow, modelRoute(async (req, res) => {
        await models.sendOne(req, res, { registry, config, protocol: 'anthropic' });
    }));

    return r;
}

module.exports = { messagesRouter, errorType };
