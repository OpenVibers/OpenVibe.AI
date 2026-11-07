'use strict';
/**
 * Your own endpoint's person API (the Exchange remake, build order 7).
 *
 *   GET  /api/v1/own-endpoints                 the caller's endpoints
 *   POST /api/v1/own-endpoints                 { model } or { weights: { repo, file, lora_repo?, lora_file? }, idle_minutes? }
 *   GET  /api/v1/own-endpoints/:id             one endpoint
 *   POST /api/v1/own-endpoints/:id/stop        give it back
 *   *    /api/v1/own-endpoints/:id/v1/*        the OpenAI-compatible proxy to the rented GPU
 *
 * Only the person themselves: a Network user token (audience openvibe.network or openvibe.ai) whose
 * subject is a usr_…; a service, app, module or node token is refused whatever capabilities it holds.
 * The endpoint is private: the rented GPU is never registered as an offer, so the router and the
 * catalogue never see it, and the proxy is the only way in.
 */
const express = require('express');
const { Readable } = require('node:stream');
const { http } = require('openvibe-contracts');
const { verifyUserToken } = require('openvibe-sdk/auth');
const { AiError, sendError } = require('../util');
const { bearer } = require('../auth');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function createOwnEndpointsRouter({ endpoints, auth, config, clock = { now: () => Date.now() }, log = console }) {
    const r = express.Router();

    /** A person, never a service. Sets req.ownPerson = { subject, token }. */
    async function guard(req, res, next) {
        try {
            const token = bearer(req);
            if (!token) return http.sendProblem(res, 401, 'token.missing', { detail: 'sign in to manage your endpoint', ctx: req.ov });
            let service = null;
            try { service = await auth.verify(token); } catch { service = { ok: false }; }
            if (service && service.ok) return http.sendProblem(res, 403, 'capability.denied', { detail: "a service token cannot manage a person's endpoint", ctx: req.ov });
            let claims;
            try {
                claims = await verifyUserToken(token, {
                    ...(config.networkPublicKey ? { publicKey: config.networkPublicKey } : { jwks: config.networkJwksUrl }),
                    issuer: config.issuer, audience: ['openvibe.network', 'openvibe.ai'], now: clock.now(), log,
                });
            } catch (err) {
                log.warn && log.warn('[own-endpoint] person token refused: ' + String((err && (err.code || err.message)) || err));
                return http.sendProblem(res, 401, 'token.invalid', { detail: 'your sign-in could not be verified', ctx: req.ov });
            }
            const subject = claims && (claims.subject_id || claims.sub);
            if (!SUBJECT_RE.test(String(subject || ''))) return http.sendProblem(res, 403, 'capability.denied', { detail: 'only a person may manage an endpoint', ctx: req.ov });
            req.ownPerson = { subject: String(subject), token };
            return next();
        } catch (err) {
            return sendError(res, err, req.ov, log);
        }
    }

    const wrap = (fn) => async (req, res) => {
        try { const out = await fn(req, res); if (out !== undefined) res.json(out); } catch (err) { sendError(res, err, req.ov, log); }
    };

    r.use('/api/v1/own-endpoints', guard);

    r.get('/api/v1/own-endpoints', wrap(async (req) => ({ endpoints: await endpoints.list(req.ownPerson.subject), status: endpoints.status() })));

    r.post('/api/v1/own-endpoints', wrap(async (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const out = await endpoints.create({ subject: req.ownPerson.subject, body });
        res.status(201).json({ endpoint: out });
    }));

    r.get('/api/v1/own-endpoints/:id', wrap(async (req) => ({ endpoint: await endpoints.get(req.ownPerson.subject, req.params.id) })));

    r.post('/api/v1/own-endpoints/:id/stop', wrap(async (req) => ({ endpoint: await endpoints.stop(req.ownPerson.subject, req.params.id) })));

    // The OpenAI-compatible proxy: /v1/models and /v1/chat/completions (streaming included). The person's
    // token decides who may come in; the rented GPU only ever sees the body.
    r.all('/api/v1/own-endpoints/:id/v1/*', async (req, res) => {
        try {
            const id = req.params.id;
            const rest = req.params[0] || '';
            if (!id) throw new AiError(404, 'own_endpoint.not_found', 'no such endpoint');
            const path = '/v1/' + rest;
            const out = await endpoints.forward({ subject: req.ownPerson.subject, id, method: req.method, path, body: req.body });
            res.status(out.status);
            res.set('Content-Type', out.contentType);
            res.set('Cache-Control', 'no-store');
            if (out.body && typeof out.body.pipe === 'function') return out.body.pipe(res);
            if (out.body && typeof out.body.getReader === 'function') return Readable.fromWeb(out.body).pipe(res);
            return res.end();
        } catch (err) {
            return sendError(res, err, req.ov, log);
        }
    });

    return r;
}

module.exports = { createOwnEndpointsRouter };
