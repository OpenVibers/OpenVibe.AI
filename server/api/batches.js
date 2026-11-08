'use strict';
/**
 * The batch API: many prompts in, the answers later.
 *
 *   POST /api/v1/batches          submit a batch (ai.run.create, or an app's ai.app.run)
 *   GET  /api/v1/batches          the caller's batches
 *   GET  /api/v1/batches/:id      one batch and its items
 *
 * A batch is billed at half the retail price, through Billing like every other request: the batch
 * table is the queue and the status, never a second ledger. The owner of the batch is the account
 * that pays for it — a person, or a developer app's project — and the cap (config.batches.maxItems)
 * is the number of prompts one batch may carry.
 *
 * The answers are not waited for: the batch is queued, and GET /batches/:id says where it stands.
 */
const express = require('express');
const { AiError, sendError } = require('../util');
const { CAPS } = require('../auth');

function batchesRouter({ batches, auth, config, clock = { now: () => Date.now() }, log = console }) {
    const r = express.Router();
    // The same guards the run routes use: a person's own token, a service token with ai.run.create, or
    // a developer app with ai.app.run.
    // BA2: a first-party service may also open a batch of the network's own when its token carries the
    // ai.batches.create grant. The grant is checked by the batch service (server/batch/service.js), which
    // knows it as a local rule: the contracts do not know that capability id yet (BA3 adds it).
    const create = auth.appOrCap(CAPS.appRun, CAPS.runCreate);
    const read = auth.appOrCap(CAPS.appRun, CAPS.runRead, CAPS.runCreate);
    const wrap = (fn) => async (req, res) => { try { const out = await fn(req, res); if (out !== undefined) res.json(out); } catch (err) { sendError(res, err, req.ov, log); } };
    const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

    r.post('/api/v1/batches', create, wrap(async (req, res) => {
        const b = body(req);
        const items = Array.isArray(b.items) ? b.items : (Array.isArray(b.prompts) ? b.prompts : null);
        if (!items) throw new AiError(422, 'input.invalid', 'a batch needs items: an array of prompts');
        const batch = await batches.submit({
            principal: req.principal,
            items,
            model: b.model ? String(b.model) : null,
            deadlineHours: b.deadline_hours != null ? b.deadline_hours : null,
        });
        res.status(201);
        return { batch };
    }));

    r.get('/api/v1/batches', read, wrap(async (req) => ({ batches: await batches.list(req.principal) })));

    r.get('/api/v1/batches/:id', read, wrap(async (req) => {
        const batch = await batches.get(req.params.id, req.principal);
        return { batch };
    }));

    return r;
}

module.exports = { batchesRouter };
