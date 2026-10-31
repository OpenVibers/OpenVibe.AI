'use strict';
/**
 * The person's own AI routes (L36 Y1/Y3): their provider keys and how their runs route. Contracts
 * ai.me.read / ai.me.manage, ai.me-credential(-put|-test|-list)@1 and ai.me-preferences@1.
 *
 *   GET    /api/v1/me/credentials
 *   PUT    /api/v1/me/credentials/:provider
 *   DELETE /api/v1/me/credentials/:provider
 *   POST   /api/v1/me/credentials/:provider/test
 *   GET    /api/v1/me/ai/preferences
 *   PUT    /api/v1/me/ai/preferences
 *
 * Only the person themselves reaches them: their Network user token, or the person session AI's own site already
 * issues for a run receipt, behind a same-origin check. A service token is refused — including any token carrying
 * `on_behalf_of`, whatever capabilities it holds (memory rule, AI #204/#205): a Codes run token holds ai.run.create,
 * so a capability check alone would admit an agent. `ai.me.*` are person capabilities, never a service's.
 *
 * The key is never returned (a four-character hint only), never logged and never put in an error.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { verifyUserToken } = require('openvibe-sdk/auth');
const { AiError } = require('./util');
const { bearer } = require('./auth');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const NON_PERSON = /^(svc|app|mod|node):/;

/** The same-origin check for the person-session cookie (the console's csrfOk rule, without a form token). */
function sameOrigin(req, config) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    if (origin) {
        try { return new URL(origin).origin === new URL(config.baseUrl).origin; } catch { return false; }
    }
    return true;
}

function meRouter({ credentials, preferences, auth, registry, config, clock = { now: () => Date.now() }, log = console, personSessions = null, sendError }) {
    const r = express.Router();

    /** Authenticate a person, never a principal. Sets req.principal = { kind: 'user', subject }. */
    function guard(req, res, next) {
        return Promise.resolve().then(async () => {
            const ctx = req.ov;
            const token = bearer(req);
            if (token) {
                // A service, app, module or node token is a principal whatever capabilities it holds. Checked first so
                // the answer is explicit, never "invalid token".
                let service = null;
                try { service = await auth.verify(token); } catch { service = { ok: false }; }
                if (service && service.ok) return http.sendProblem(res, 403, 'capability.denied', { detail: "a service token is not accepted on the person's own route", ctx });
                let claims;
                try {
                    claims = await verifyUserToken(token, {
                        ...(config.networkPublicKey ? { publicKey: config.networkPublicKey } : { jwks: config.networkJwksUrl }),
                        issuer: config.issuer, audience: ['openvibe.network', 'openvibe.ai'], now: clock.now(), log,
                    });
                } catch (err) {
                    return http.sendProblem(res, err.status || 401, err.code || 'token.invalid', { detail: err.detail || 'invalid token', ctx });
                }
                if (NON_PERSON.test(String(claims.sub || '')) || ['service', 'app', 'mod', 'node'].includes(claims.actor_type)) {
                    return http.sendProblem(res, 403, 'capability.denied', { detail: "a principal token is not accepted on the person's own route", ctx });
                }
                if (claims.on_behalf_of != null) return http.sendProblem(res, 403, 'capability.denied', { detail: 'a token acting on behalf of someone is not the person themselves', ctx });
                const subject = SUBJECT_RE.test(String(claims.subject_id || '')) ? claims.subject_id : (SUBJECT_RE.test(String(claims.sub || '')) ? claims.sub : '');
                if (!subject) return http.sendProblem(res, 401, 'token.invalid', { detail: 'the person token has no usr_ subject', ctx });
                req.principal = { kind: 'user', sub: claims.sub, subject: { type: 'user', id: subject }, claims };
                return next();
            }
            // The person session AI already issues for a run receipt. Cookie auth needs the same origin, so another
            // site cannot spend a person's keys with their cookie.
            if (!personSessions) return http.sendProblem(res, 401, 'token.missing', { detail: "the person's own token or session is required", ctx });
            if (!sameOrigin(req, config)) return http.sendProblem(res, 403, 'capability.denied', { detail: 'the person session is only used from ' + new URL(config.baseUrl).origin, ctx });
            const session = await personSessions.read(req);
            if (!session) return http.sendProblem(res, 401, 'token.missing', { detail: "the person's own token or session is required", ctx });
            if (!SUBJECT_RE.test(String(session.subject || ''))) return http.sendProblem(res, 401, 'token.invalid', { detail: 'the session has no usr_ subject', ctx });
            req.principal = { kind: 'user', subject: { type: 'user', id: session.subject }, username: session.username || null };
            return next();
        }).catch((err) => {
            log.error(`[me] ${req.method} ${req.path}: ${(err && err.stack) || err}`);
            if (!res.headersSent) http.sendProblem(res, 500, 'internal.error', { detail: 'internal error', ctx: req.ov });
        });
    }
    const personOf = (req) => req.principal.subject.id;
    const noStore = (res) => res.set('Cache-Control', 'no-store');
    const run = (fn) => async (req, res) => {
        try { noStore(res).json(await fn(req)); } catch (err) { sendError(res, err, req.ov); }
    };
    const audit = async (req, action, metadata) => {
        if (!registry) return;
        try { await registry.audit(personOf(req), action, 'credential', personOf(req), { trace: req.ov && req.ov.traceId, metadata }); } catch { /* audit never breaks the person's request */ }
    };

    r.get('/api/v1/me/credentials', guard, run(async (req) => ({ credentials: await credentials.listSelf(personOf(req)) })));
    r.put('/api/v1/me/credentials/:provider', guard, run(async (req) => {
        const out = await credentials.putSelf(personOf(req), req.params.provider, { ...(req.body || {}), ...(req.body && req.body.provider == null ? { provider: req.params.provider } : {}) });
        await audit(req, 'credential.self.put', { provider: out.provider, status: out.status, base_url: out.base_url });
        return out;
    }));
    r.delete('/api/v1/me/credentials/:provider', guard, async (req, res) => {
        try {
            const gone = await credentials.removeSelf(personOf(req), req.params.provider);
            if (gone) await audit(req, 'credential.self.delete', { provider: req.params.provider });
            res.status(gone ? 204 : 404).end();
        } catch (err) { sendError(res, err, req.ov); }
    });
    r.post('/api/v1/me/credentials/:provider/test', guard, run(async (req) => {
        const out = await credentials.testSelf(personOf(req), req.params.provider);
        await audit(req, 'credential.self.test', { provider: req.params.provider, ok: out.ok, models_count: out.models_count });
        return out;
    }));
    r.get('/api/v1/me/ai/preferences', guard, run(async (req) => await preferences.get(personOf(req))));
    r.put('/api/v1/me/ai/preferences', guard, run(async (req) => {
        const out = await preferences.put(personOf(req), req.body || {});
        await audit(req, 'ai.preferences.put', { only_my_keys: out.only_my_keys, free_first: out.free_first, price_ceiling_usd_per_mtok: out.price_ceiling_usd_per_mtok });
        return out;
    }));
    return r;
}

module.exports = { meRouter, sameOrigin };
