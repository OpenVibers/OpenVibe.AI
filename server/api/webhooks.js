'use strict';
/**
 * Exchange webhooks, the developer's side (design EXCHANGE-REMAKE-2026-11-06, "For builders", item 7).
 *
 *   POST   /api/v1/exchange/webhooks                 register an https receiver; the signing secret is in this answer only
 *   GET    /api/v1/exchange/webhooks                 the caller's receivers (never a secret)
 *   DELETE /api/v1/exchange/webhooks/:id             remove one (its delivery history goes with it)
 *   GET    /api/v1/exchange/webhooks/:id/deliveries  the delivery log: event, attempts, status and the payload sent
 *
 * The owner is the caller: a person's own subject, or an app's project. A first-party service token is refused. The
 * secret is a signing key for this subscription, never a person's token, and it is never logged or read back.
 */
const express = require('express');
const { CAPS } = require('../auth');
const { AiError, sendError } = require('../util');

function webhooksRouter({ webhooks, auth, log = console }) {
    const r = express.Router();
    const allow = auth.appOrCap(CAPS.appRun, CAPS.runCreate, CAPS.runRead);
    const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
    const wrap = (fn) => async (req, res) => {
        try {
            const out = await fn(req, res);
            if (out !== undefined) res.json(out);
        } catch (err) { sendError(res, err, req.ov, log); }
    };
    const ownerOf = (req) => {
        const p = req.principal || {};
        if (p.kind === 'user' && p.subject && p.subject.id) return p.subject.id;
        if (p.kind === 'app' && p.projectId) return p.projectId;
        throw new AiError(403, 'exchange.webhook_owner', 'a webhook belongs to a person or a developer app, not a service');
    };

    r.post('/api/v1/exchange/webhooks', allow, wrap(async (req, res) => {
        const webhook = await webhooks.create({ owner: ownerOf(req), input: body(req) });
        res.status(201).set('Cache-Control', 'no-store');
        return { webhook };
    }));

    r.get('/api/v1/exchange/webhooks', allow, wrap(async (req, res) => {
        res.set('Cache-Control', 'no-store');
        return { owner: ownerOf(req), webhooks: await webhooks.list(ownerOf(req)) };
    }));

    r.delete('/api/v1/exchange/webhooks/:id', allow, wrap(async (req, res) => {
        res.set('Cache-Control', 'no-store');
        return await webhooks.remove({ id: req.params.id, owner: ownerOf(req) });
    }));

    r.get('/api/v1/exchange/webhooks/:id/deliveries', allow, wrap(async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const deliveries = await webhooks.deliveries({ id: req.params.id, owner: ownerOf(req), limit: req.query.limit });
        return { id: req.params.id, deliveries };
    }));

    return r;
}

module.exports = { webhooksRouter };
