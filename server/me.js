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
 * Writes are stricter than reads. A user token must carry audience `openvibe.ai` explicitly, except Exchange may
 * forward the signed-in person's `openvibe.network` token from its configured same-origin server request. Service
 * tokens are always refused, including those with on_behalf_of; no caller can write another person's credentials.
 * AI's own person session must prove same-origin for a write: with neither Origin nor Sec-Fetch-Site the write is
 * refused, so a site cannot use the cookie with a bare request. Reads keep accepting that cookie as before.
 *
 * The key is never returned (a four-character hint only), never logged and never put in an error.
 */
const express = require('express');
const { http, services } = require('openvibe-contracts');
const { verifyUserToken } = require('openvibe-sdk/auth');
const { AiError } = require('./util');
const { bearer } = require('./auth');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const NON_PERSON = /^(svc|app|mod|node):/;

/** The audience a write needs: a token minted for AI itself, never a site's `openvibe.network` session. */
const WRITE_AUDIENCE = 'openvibe.ai';

function audiencesOf(claims) {
    const aud = claims && claims.aud;
    return (Array.isArray(aud) ? aud : aud == null ? [] : [aud]).map(String);
}

/**
 * Every first-party site's origin, from Contracts' service manifests. A person's saved choice is theirs on any of
 * our sites (Design's Draw it, Blog's editor, Chat), so a site's own session token may write it from its own origin.
 * A service outside the manifests is never trusted.
 */
const SITE_ORIGINS = new Set((services.manifests || []).map((m) => m.publicOrigin).filter(Boolean).map((u) => { try { return new URL(u).origin; } catch { return null; } }).filter(Boolean));

/**
 * The same-origin check for the person-session cookie (the console's csrfOk rule, without a form token).
 * A write with neither Origin nor Sec-Fetch-Site is refused: a site can make a bare request with the cookie, so the
 * absence of both is not proof of same-origin. A read may keep the old rule (it returns hints and settings only).
 */
function sameOrigin(req, config, { write = false } = {}) {
    const site = req.headers['sec-fetch-site'];
    const origin = req.headers.origin;
    if (!site && !origin) return !write;
    if (site && site !== 'same-origin' && site !== 'none') return false;
    if (origin) {
        try {
            const actual = new URL(origin).origin;
            if (req.path.startsWith('/api/v1/me/choices/') && SITE_ORIGINS.has(actual)) return true;
            return [config.baseUrl, config.exchangeUrl].some((base) => {
                try { return actual === new URL(base).origin; } catch { return false; }
            });
        } catch { return false; }
    }
    return true;
}

function meRouter({ choices = null, credentials, preferences, grants, auth, registry, config, clock = { now: () => Date.now() }, log = console, personSessions = null, sessionCookies = null, sendError }) {
    const r = express.Router();

    /** Authenticate a person, never a principal. Sets req.principal = { kind: 'user', subject }. */
    function guard(req, res, next) {
        return Promise.resolve().then(async () => {
            const ctx = req.ov;
            const write = req.method !== 'GET' && req.method !== 'HEAD';
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
                // A token minted for openvibe.network is every OpenVibe site's session. It may write only when the
                // request came from Exchange (which holds the user's token in its httpOnly session),
                // or when the person minted an AI-audience token directly. No service token can enter this route.
                const audiences = audiencesOf(claims);
                // A person's saved choice is theirs across our sites, so a site session may write it from that site's
                // own origin; every other setting is Exchange's.
                const siteChoice = req.path.startsWith('/api/v1/me/choices/') && req.get('origin') && SITE_ORIGINS.has(new URL(req.get('origin')).origin);
                const exchangeWrite = audiences.includes('openvibe.network') && sameOrigin(req, config, { write: true })
                    && req.get('origin') && (new URL(req.get('origin')).origin === new URL(config.exchangeUrl).origin || siteChoice);
                if (write && !audiences.includes(WRITE_AUDIENCE) && !exchangeWrite) {
                    return http.sendProblem(res, 403, 'capability.denied', { detail: 'a write needs a user token for audience openvibe.ai; a site session token may only read these settings', ctx });
                }
                const subject = SUBJECT_RE.test(String(claims.subject_id || '')) ? claims.subject_id : (SUBJECT_RE.test(String(claims.sub || '')) ? claims.sub : '');
                if (!subject) return http.sendProblem(res, 401, 'token.invalid', { detail: 'the person token has no usr_ subject', ctx });
                req.principal = { kind: 'user', sub: claims.sub, subject: { type: 'user', id: subject }, claims };
                return next();
            }
            // The person session AI already issues for a run receipt. Cookie auth needs the same origin, so another
            // site cannot spend a person's keys with their cookie; a write also needs the origin signal to be present.
            if (!personSessions) return http.sendProblem(res, 401, 'token.missing', { detail: "the person's own token or session is required", ctx });
            if (!sameOrigin(req, config, { write })) return http.sendProblem(res, 403, 'capability.denied', { detail: 'the person session is only used from ' + new URL(config.baseUrl).origin + (write ? ', with an Origin or Sec-Fetch-Site header' : ''), ctx });
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

    if (choices) {
        const reply = fn => async (req, res) => { try { res.set('Cache-Control', 'private, no-store').json(await fn(req)); } catch (err) { sendError(res, err, req.ov); } };
        const optional = async (req, res, next) => { const token = bearer(req); if (!token) return next(); try { const service = await auth.verify(token); if (service?.ok) return next(); } catch {} return guard(req, res, next); };
        const admin = (req, res, next) => ['admin', 'owner'].includes(req.principal?.claims?.role) ? next() : res.status(403).json({ code: 'role.admin_required', detail: 'An admin role is required.' });
        r.get('/api/v1/tasks', reply(async () => ({ tasks: await choices.tasks() })));
        r.post('/api/v1/tasks', auth.requireCap('ai.workflow.manage'), reply(async req => {
            if (req.principal.subject.type !== 'service') throw new AiError(403, 'capability.denied', 'only services register tasks');
            return { task: await choices.register(req.body, req.principal.subject.id) };
        }));
        r.get('/api/v1/choices', optional, reply(req => choices.get(String(req.query.task || ''), { subject: req.principal?.subject?.id || null })));
        r.put('/api/v1/me/choices/:task', guard, reply(async req => ({ choice: await choices.save(personOf(req), req.params.task, req.body) })));
        r.get('/api/v1/admin/task-defaults', guard, admin, reply(async () => ({ tasks: await choices.tasks(), defaults: await choices.defaults() })));
        r.put('/api/v1/admin/task-defaults', guard, admin, reply(async req => ({ defaults: await choices.putDefaults(req.body, personOf(req)) })));
    }
    r.get('/api/v1/me/search-credentials', guard, run(async req => ({ engines: await credentials.listSearch(personOf(req)) })));
    r.put('/api/v1/me/search-credentials/:engine', guard, run(async req => {
        const out = await credentials.putSearch(personOf(req), req.params.engine, req.body);
        await audit(req, 'credential.search.put', { engine: out.engine });
        return out;
    }));
    r.delete('/api/v1/me/search-credentials/:engine', guard, run(async req => {
        const out = await credentials.removeSearch(personOf(req), req.params.engine);
        await audit(req, 'credential.search.delete', { engine: out.engine });
        return out;
    }));

    r.get('/api/v1/me/credentials', guard, run(async (req) => ({ credentials: [...(await credentials.listSelf(personOf(req))).map((c) => ({ ...c, id: c.provider, kind: 'api_key', label: c.provider, created: c.created_at, last_used: c.last_used_at || null })), ...(sessionCookies ? await sessionCookies.list('self', personOf(req)) : [])] })));
    if (sessionCookies) {
        r.post('/api/v1/me/credentials', guard, run(async (req) => {
            const body = req.body || {};
            if (body.kind === 'session_cookie' || body.cookie != null) return { credential: await sessionCookies.add('self', personOf(req), body) };
            const saved = await credentials.putSelf(personOf(req), body.provider, body);
            return { credential: { id: saved.provider, kind: 'api_key', provider: saved.provider, created: saved.created_at, label: body.label || saved.provider } };
        }));
        r.get('/api/v1/me/credentials/:id/balance', guard, run(async (req) => {
            const cookieBalance = await sessionCookies.balance('self', personOf(req), req.params.id);
            if (cookieBalance) return { balance: cookieBalance };
            return { balance: await credentials.balanceSelf(personOf(req), req.params.id) };
        }));
        r.delete('/api/v1/me/credentials/:id', guard, async (req, res) => { try { const gone = await sessionCookies.remove('self', personOf(req), req.params.id) || await credentials.removeSelf(personOf(req), req.params.id); res.status(gone ? 204 : 404).end(); } catch (err) { sendError(res, err, req.ov); } });
    }
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
    // L55 C3: the apps the person allows to use their own key. The person's own list: names only, no key material.
    r.get('/api/v1/me/key-apps', guard, run(async (req) => ({ apps: grants ? await grants.list(personOf(req)) : [] })));
    r.put('/api/v1/me/key-apps/:service', guard, run(async (req) => {
        const provider = req.body && req.body.provider != null ? String(req.body.provider) : '*';
        const out = grants ? await grants.allow(personOf(req), req.params.service, provider) : null;
        if (!out) throw new AiError(503, 'credentials.unavailable', 'key grants are not configured on this service');
        await audit(req, 'key_grant.allow', { service: out.service, provider: out.provider });
        return out;
    }));
    r.delete('/api/v1/me/key-apps/:service', guard, async (req, res) => {
        try {
            if (!grants) throw new AiError(503, 'credentials.unavailable', 'key grants are not configured on this service');
            const provider = req.query && req.query.provider ? String(req.query.provider) : null;
            const gone = await grants.remove(personOf(req), req.params.service, provider);
            if (gone) await audit(req, 'key_grant.remove', { service: String(req.params.service || '').toLowerCase(), provider: provider || '*' });
            res.status(gone ? 204 : 404).end();
        } catch (err) { sendError(res, err, req.ov); }
    });
    r.get('/api/v1/me/ai/preferences', guard, run(async (req) => await preferences.get(personOf(req))));
    r.put('/api/v1/me/ai/preferences', guard, run(async (req) => {
        const out = await preferences.put(personOf(req), req.body || {});
        await audit(req, 'ai.preferences.put', { only_my_keys: out.only_my_keys, free_first: out.free_first, price_ceiling_usd_per_mtok: out.price_ceiling_usd_per_mtok });
        return out;
    }));
    return r;
}

module.exports = { meRouter, sameOrigin };
