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
 *   model                                      "openvibe" (or anything else): AI's router picks the upstream for
 *                                              route default.chat by price, health and what the request needs
 *                                              (tools need a provider that declares them); the answer names the
 *                                              model that ran
 *
 *   x-openvibe-credential                      the person's own key for a provider instead of the router
 *                                              (Codes C3): <provider> or <provider>:<subject>
 *   x_openvibe.provider                        an app's own provider instead of the router: { base_url (https, an
 *                                              OpenAI-format API), model, secret (the name of a project secret granted
 *                                              to ai for reveal to that origin, ADR-056) }; the key is revealed for
 *                                              that one run, and the project pays its provider directly
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

const FIELDS = ['messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'stop', 'seed', 'top_p', 'presence_penalty', 'frequency_penalty', 'temperature'];

// Cloudflare answers a 502 or 504 from the origin with its own HTML page, so an OpenAI client would get no JSON error:
// an upstream that failed or could not be reached is 503 (OpenAI's own "unavailable, retry"), the body kept. An invalid
// request is OpenAI's 400, not 422.
const gatewaySafe = (status) => (status === 502 || status === 504 ? 503 : status === 422 ? 400 : status);

/**
 * The event stream of one streamed completion. delta(d) sends a chunk as it arrives (or keeps it until open(run) has
 * sent the headers, which happens once the run exists); write(o) sends any chunk; fail() sends OpenAI's error object as
 * an event; done() ends with [DONE]. A closed connection drops what is left, quietly.
 */
function createLiveStream(res) {
    let run = null;
    let opened = false;
    let any = false;
    const waiting = [];
    const finishedIdx = new Set();
    const created = Math.floor(Date.now() / 1000);
    const alive = () => !res.writableEnded && !res.destroyed;
    const write = (o) => { if (alive()) res.write(`data: ${JSON.stringify(o)}\n\n`); };
    const chunk = (d) => ({ id: `chatcmpl-${run.id}`, object: 'chat.completion.chunk', created, model: d.model || 'openvibe', system_fingerprint: null,
        choices: [{ index: d.index || 0, delta: d.delta || {}, finish_reason: d.finish_reason || null }] });
    const out = {
        get opened() { return opened; },
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
            const status = /^(input|validation)\./.test(code || '') ? 400 : /quota|allowance|budget/.test(code || '') ? 429 : 503;
            write({ error: { message: String(message || 'error').slice(0, 1000), type: status === 400 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'api_error', code: code || null, param: null } });
            return out.done();
        },
        done() { if (alive()) { res.write('data: [DONE]\n\n'); res.end(); } },
    };
    return out;
}

function openaiError(res, status, message, code, type) {
    res.status(status).json({ error: { message: String(message || 'error').slice(0, 1000), type: type || (status === 401 || status === 403 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error'), code: code || null, param: null } });
}

function openaiRouter({ runs, auth, config, log = console }) {
    const r = express.Router();
    const allow = auth.appOrCap(CAPS.appRun, CAPS.runCreate);

    // A problem from the auth layer arrives as problem+json; a client built for OpenAI reads { error }: convert it as
    // it is written, whichever way the layer writes it.
    const typeFor = (status) => (status === 401 || status === 403 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error');
    const asOpenAiErrors = (req, res, next) => {
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
        const maxTokens = b.max_completion_tokens != null ? b.max_completion_tokens : b.max_tokens;
        if (maxTokens != null) input.max_tokens = Math.max(1, Math.min(Number(maxTokens) || 1, 16000));
        let body = { workflow: 'ai.complete', input };
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
            const created = await runs.create(body, req.principal, { trace: req.ov && req.ov.traceId, requestId: req.ov && req.ov.requestId, ...(live ? { onDelta: live.delta } : {}) });
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
            const status = /^(input|validation)\./.test(code) ? 400 : /quota|allowance|budget/.test(code) ? 429
                : code === 'project_secret.refused' ? 403 : code === 'credential.endpoint_refused' ? 422 : 503;
            return openaiError(res, status, (run.error && run.error.detail) || code, code);
        }
        if (!['succeeded', 'cached'].includes(run.status) || !run.output || !Array.isArray(run.output.choices)) {
            return openaiError(res, 504, `the completion is still running; GET /api/v1/runs/${run.id}`, 'run.timeout');
        }
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
            send({ ...base, choices: [], x_openvibe: x });
            return live.done();
        }
        return res.status(200).json({ id, object: 'chat.completion', created, model, choices: run.output.choices, usage, system_fingerprint: run.output.system_fingerprint || null, x_openvibe: x });
    });

    // The model list a client asks for first: one router model, the upstreams are AI's choice.
    r.get('/v1/models', asOpenAiErrors, allow, (req, res) => {
        res.json({ object: 'list', data: [{ id: 'openvibe', object: 'model', created: 1760486400, owned_by: 'openvibe' }] });
    });

    return r;
}

module.exports = { openaiRouter };
