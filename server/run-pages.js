'use strict';
/**
 * A person's run receipt (plan 2026-10-28 §3.10): GET /runs/:id.
 *
 * The Action Center's AI item links here. A person signs in with OpenVibe.Network (GET
 * /auth/person/login, the same OAuth client and callback as the console), and the page shows one run
 * only when the run's on_behalf_of is that person. It never renders the input, the request log, the
 * trace or anyone else's run, and it is read-only: no script, no form, no external resource.
 */
const express = require('express');
const q = require('./console/queries');
const { CSP, pages } = require('./console/views');

const RUN_ID = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;

function runPageRouter({ runs, personSessions, log = console }) {
    const r = express.Router();

    function headers(res) {
        res.setHeader('Content-Security-Policy', CSP);
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader('Cache-Control', 'no-store');
    }
    function send(res, status, text) {
        headers(res);
        return res.status(status).type('html').send(text);
    }
    const missing = (res) => send(res, 404, pages.message({ title: 'Run not found', text: 'There is no run here that belongs to you.', back: '/', site: 'your runs' }));
    const unavailable = (res) => send(res, 503, pages.message({ title: 'Run page unavailable', text: 'The run page sign-in is not configured on this host.', back: '/', site: 'your runs' }));

    r.get('/runs/:id', async (req, res) => {
        try {
            const id = String(req.params.id);
            if (!RUN_ID.test(id)) return missing(res);
            if (!personSessions) return unavailable(res);
            const viewer = await personSessions.read(req);
            if (!viewer) return res.redirect(302, `/auth/person/login?next=${encodeURIComponent(`/runs/${id}`)}`);
            const run = await runs.getReceipt(id);
            const person = run && run.on_behalf_of;
            if (!run || !person || person.type !== 'user' || person.id !== viewer.subject) return missing(res);
            const output = q.preview(run.output, { string: 4000, bytes: 20000 });
            return send(res, 200, pages.runReceipt({ viewer, r: run, output: output.text, outputCut: output.cut }));
        } catch (err) {
            log.error(`[run-page] ${req.method} ${req.path}: ${(err && err.stack) || err}`);
            if (res.headersSent) return res.end();
            return send(res, 500, pages.message({ title: 'Run page error', text: 'The run could not be read. Try again in a moment.', back: '/', site: 'your runs' }));
        }
    });

    return r;
}

module.exports = { runPageRouter, RUN_ID };
