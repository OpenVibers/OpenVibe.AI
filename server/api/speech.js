'use strict';
/**
 * The Exchange speech endpoint: POST /v1/audio/speech in the OpenAI shape, so Chat points its
 * TTS at https://ai.openvibe.services/v1/audio/speech and stops calling the providers directly.
 *
 *   Authorization: Bearer <a Network token>   an app's token (ai.app.run, its project pays) or a first-party
 *                                              service's (ai.run.create), exactly as POST /v1/chat/completions
 *   body                                       OpenAI audio/speech: model, input (the text, at most 4096
 *                                              characters), voice (a Chat voice id, one per provider voice —
 *                                              server/providers/speech.js), response_format (mp3|ogg_opus|wav,
 *                                              default mp3), speed (0.25–4, default 1)
 *
 * Each request is a run of workflow ai.speak, so it has the run's quota, free allowance, cost, audit and
 * explain (x_openvibe in the receipt); the text is not kept. The answer is the audio bytes (the voice's
 * MIME type), with the run and receipt ids in the headers, as on the chat route. Errors are OpenAI's
 * shape ({ error: { message, type, code } }) with the HTTP status the run's problem had.
 */
const express = require('express');
const { CAPS } = require('../auth');
const { appAttribution } = require('../apps');
const { VOICES, FORMATS } = require('../providers/speech');
const { compact, receiptId } = require('../exchange/receipts');

const gatewaySafe = (status) => (status === 502 || status === 504 ? 503 : status === 422 ? 400 : status);

function openaiError(res, status, message, code, type) {
    res.status(status).json({ error: { message: String(message || 'error').slice(0, 1000), type: type || (status === 401 || status === 403 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status === 402 ? 'insufficient_quota' : status >= 500 ? 'api_error' : 'invalid_request_error'), code: code || null, param: null } });
}

function speechRouter({ runs, auth, config, presets = null, receipts = null, db = null, log = console }) {
    const r = express.Router();
    // Developer apps call with ai.app.run, the public capability they already hold (ADR-014; AI Exchange D8').
    const allow = auth.appOrCap(CAPS.appRun, CAPS.runCreate);

    r.post('/v1/audio/speech', allow, async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        if (b.model == null || typeof b.model !== 'string' || !b.model.trim() || b.model.length > 256)
            return openaiError(res, 400, 'model must be a model id', 'input.invalid');
        const text = b.input;
        if (typeof text !== 'string' || !text.trim()) return openaiError(res, 400, 'input must be a non-empty string', 'input.invalid');
        if (text.length > 4096) return openaiError(res, 400, 'input is longer than 4096 characters', 'input.invalid');
        const voice = b.voice;
        if (typeof voice !== 'string' || !voice) return openaiError(res, 400, 'voice must be a voice id', 'input.invalid');
        const entry = VOICES[voice];
        // A voice nobody knows is refused, never silently spoken in another voice.
        if (!entry) return openaiError(res, 404, `unknown voice ${voice.slice(0, 80)}`, 'ai.model_not_found');
        const format = b.response_format == null ? 'mp3' : b.response_format;
        if (!FORMATS[format]) return openaiError(res, 400, 'response_format must be mp3, ogg_opus or wav', 'input.invalid');
        const speed = b.speed == null ? 1 : Number(b.speed);
        if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) return openaiError(res, 400, 'speed must be between 0.25 and 4', 'input.invalid');

        const input = { voice, text, response_format: format, speed };
        // AI Exchange F: the caller's liability cap for the Balance hold (an OpenVibe extension, like x_openvibe).
        if (b.max_cost_usd != null) input.max_cost_usd = b.max_cost_usd;
        let body = { workflow: 'ai.speak', input, idempotency_key: req.get('idempotency-key') || undefined };
        // A first-party service naming the person it acts for (the runs API's on_behalf_of). An app run is its
        // project's and never names a person, as on the runs API.
        if (b.on_behalf_of != null) body = { ...body, on_behalf_of: b.on_behalf_of };
        const obo = b.x_openvibe && typeof b.x_openvibe === 'object' ? b.x_openvibe.on_behalf_of : undefined;
        if (obo !== undefined) {
            if (req.principal.kind === 'app') return openaiError(res, 403, 'an app run is attributed to its project, never to a person', 'capability.denied');
            if (req.principal.kind === 'user' && (!obo || obo.id !== req.principal.subject.id)) return openaiError(res, 403, 'a person runs for themselves, never for someone else', 'capability.denied');
            body = { ...body, on_behalf_of: obo };
        }
        if (req.principal.kind === 'app') body = { ...body, attribution: appAttribution(req.principal) };
        // The voice pins its exact offer (provider + voice model): the run never lands on another voice.
        const exact = { id: `voice:${voice}`, offers: [{ provider: entry.provider, model: voice }] };
        let run;
        try {
            const created = await runs.create(body, req.principal, { trace: req.ov && req.ov.traceId, requestId: req.ov && req.ov.requestId, abuse: req.abuse, exact });
            res.locals.inferenceAdmitted = true;
            if (created.created === false) res.setHeader('x-openvibe-replayed', '1');
            run = await runs.explained(await runs.wait(created, Math.max(config.runs.maxWaitMs, 120000)));
        } catch (err) {
            const status = gatewaySafe((err && err.status) || 500);
            if (status === 429 && err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
            if (status >= 500) log.warn(`[ai] /v1/audio/speech: ${err && err.message}`);
            return openaiError(res, status, err && (err.detail || err.message), err && err.code);
        }
        if (['succeeded', 'cached'].includes(run.status) || (['failed', 'cancelled'].includes(run.status) && run.usage.attempts === 0)) res.locals.inferenceCharge = Number(run.usage.cost_usd || 0);
        if (run.status === 'failed' || run.status === 'cancelled') {
            const code = (run.error && run.error.code) || 'run.failed';
            const status = code === 'ai.run_budget_reached' || code === 'ai.allowance_spent' || code === 'billing.insufficient_funds' || code === 'billing.payer_required' ? 402 : /^(input|validation)\./.test(code) ? 400 : /quota|allowance|budget/.test(code) ? 429
                : code === 'ai.model_not_found' ? 404
                : code === 'ai.model_unavailable' ? 400 : 503;
            return openaiError(res, status, (run.error && run.error.detail) || code, code);
        }
        if (!['succeeded', 'cached'].includes(run.status) || !run.output || typeof run.output.audio !== 'string') {
            return openaiError(res, 504, `the synthesis is still running; GET /api/v1/runs/${run.id}`, 'run.timeout');
        }
        const receipt = receipts ? await receipts.forRun(run.id) : null;
        const receiptView = receipt ? compact(receipt) : null;
        const audio = Buffer.from(run.output.audio, 'base64');
        res.status(200);
        res.setHeader('Content-Type', run.output.mime_type || 'audio/mpeg');
        res.setHeader('Content-Length', audio.length);
        res.setHeader('X-OpenVibe-Run-Id', run.id);
        if (receipt && receiptView) {
            res.setHeader('x-openvibe-receipt-id', receipt.id);
            res.setHeader('x-openvibe-receipt', JSON.stringify(receiptView));
        } else {
            res.setHeader('x-openvibe-receipt-id', receiptId(run.id));
        }
        return res.send(audio);
    });

    return r;
}

module.exports = { speechRouter };
