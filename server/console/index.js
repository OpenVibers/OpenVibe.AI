'use strict';

// AI keeps only the sign-in flow used by private run receipts. Operator pages live on Exchange.
const crypto = require('crypto');
const express = require('express');
const { resolveSecret } = require('../util');
const { createSessions, sameString } = require('./session');
const { createConsoleSso } = require('./sso');
const { pages } = require('./views');

/** A person can return only to one run receipt after signing in. */
function sanitizeRunNext(value) {
    if (typeof value === 'string' && /[\u0000-\u001f\u007f\\]/.test(value)) return '/';
    const next = String(value || '');
    return next.length <= 300 && /^\/runs\/run_[0-9A-HJKMNP-TV-Z]{26}$/.test(next) ? next : '/';
}

function consoleRouter({ config, db, registry, env = process.env, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, log = console, personSessions = null }) {
    const cc = config.console;
    let secret = resolveSecret(cc.sessionSecretRef, env);
    if (!secret || secret.length < 32) secret = crypto.randomBytes(32).toString('hex');
    const clientSecret = resolveSecret(cc.clientSecretRef, env);
    const sessions = createSessions({ db, config, clock, secret });
    const sso = createConsoleSso({ config, clientSecret, fetchImpl, log });
    const r = express.Router();
    const send = (res, status, body) => res.status(status).type('html').send(body);
    const audit = (subject, action, metadata, req) => registry.audit(subject || 'anonymous', action, 'run_page', 'sign_in', {
        trace: req.ov && req.ov.traceId || null, metadata,
    });

    r.get('/auth/person/login', (req, res) => {
        const flow = sso.start();
        sessions.setFlow(res, { s: flow.state, v: flow.verifier, n: sanitizeRunNext(req.query.next), kind: 'person' });
        return res.redirect(302, flow.url);
    });

    r.get('/auth/callback', async (req, res) => {
        const flow = sessions.takeFlow(req, res);
        if (!flow || flow.kind !== 'person' || !req.query.code || !sameString(req.query.state, flow.s)) {
            return send(res, 400, pages.message({ title: 'Sign-in not verified', text: 'The sign-in could not be verified (expired or mismatched state). Please try again.', back: '/', site: 'your runs' }));
        }
        let person;
        try { person = await sso.exchange({ code: req.query.code, verifier: flow.v, now: clock.now() }); }
        catch (error) {
            log.warn(`[run-page] sign-in failed (${error && error.status || 502})`);
            return send(res, 502, pages.message({ title: 'Sign-in failed', text: 'OpenVibe.Network did not confirm the sign-in. Please try again.', back: '/', site: 'your runs' }));
        }
        if (!personSessions) return send(res, 503, pages.message({ title: 'Sign-in unavailable', text: 'The run page sign-in is not configured on this host.', back: '/', site: 'your runs' }));
        if (person.error) {
            await audit('anonymous', 'run_page.sign_in.refused', { reason: person.error }, req);
            return send(res, 403, pages.message({ title: 'Not authorized', text: 'This page needs an OpenVibe.Network person account. Your sign-in was recorded.', back: '/', site: 'your runs' }));
        }
        await db.tx(async () => {
            await personSessions.create(res, { subject: person.subject, username: person.username });
            await audit(person.subject, 'run_page.sign_in', {}, req);
        });
        return res.redirect(303, flow.n || '/');
    });

    return r;
}

module.exports = { consoleRouter, sanitizeRunNext };
