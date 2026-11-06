'use strict';
/**
 * The Exchange's routing profiles and receipts.
 *
 *   GET    /api/v1/presets          the presets this caller may name: the five built-in ones and their own
 *   POST   /api/v1/presets          store (or replace) one of their own: { name, policy }
 *   DELETE /api/v1/presets/:name    delete one of their own
 *   GET    /v1/receipts/:id         the receipt of one answered request (the same one in the response headers)
 *   GET    /api/v1/receipts/:id     the same receipt, at the documented address
 *
 * A preset belongs to an account (the person a token acts for) or to a Network project (an app's project).
 * The built-in ones are code, not rows: they cannot be edited or deleted.
 *
 * A receipt is read by the caller that made the run, by the person the run was for, and by whoever may
 * read the usage (ai.usage.read). It never carries the prompt or the answer.
 */
const express = require('express');
const { CAPS } = require('../auth');
const { AiError, sendError } = require('../util');

function exchangeRouter({ presets, receipts, runs, auth, registry, log = console }) {
    const r = express.Router();
    // A caller that may run may read the presets; the same guard writes them (a preset is the caller's own).
    const read = auth.appOrCap(CAPS.appRun, CAPS.runCreate, CAPS.runRead);
    const write = auth.appOrCap(CAPS.appRun, CAPS.runCreate);
    const usageRead = auth.requireCap(CAPS.usageRead);
    const wrap = (fn) => async (req, res) => { try { const out = await fn(req, res); if (out !== undefined) res.json(out); } catch (err) { sendError(res, err, req.ov, log); } };
    const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

    /** The owner a preset belongs to: the app's project, else the person the token acts for, else the service. */
    const ownerOf = (req) => {
        const owners = presets.ownersOf(req.principal);
        return owners[0] || null;
    };

    if (presets) {
        r.get('/api/v1/presets', read, wrap(async (req) => ({ presets: await presets.visible(req.principal) })));
        r.post('/api/v1/presets', write, wrap(async (req, res) => {
            const b = body(req);
            const owner = ownerOf(req);
            if (!owner) throw new AiError(422, 'ai.invalid', 'a preset belongs to an account or a project');
            const preset = await presets.put({ owner, name: b.name, policy: b.policy });
            res.status(201);
            return { preset };
        }));
        r.delete('/api/v1/presets/:name', write, wrap(async (req) => {
            const owner = ownerOf(req);
            if (!owner) throw new AiError(422, 'ai.invalid', 'a preset belongs to an account or a project');
            return presets.remove({ owner, name: req.params.name });
        }));
    }

    if (receipts) {
        // The receipt is read at the address the plan names (/v1/receipts/:id, beside the OpenAI-compatible
        // routes) and at the documented one (/api/v1/receipts/:id): the same answer either way.
        const readReceipt = wrap(async (req) => {
            const receipt = await receipts.get(req.params.id);
            if (!receipt) throw new AiError(404, 'ai.receipt_not_found', `no receipt ${req.params.id}`);
            // The receipt belongs to the run that made it: its requester, the person it was for, or whoever
            // may read the usage.
            const p = req.principal;
            const subject = p.subject || {};
            const ob = p.onBehalfOf || (p.claims && p.claims.on_behalf_of);
            const obId = ob && typeof ob === 'object' ? ob.id : ob;
            const owner = receipt.owner || {};
            const allowed = auth.principalHas(req, CAPS.usageRead)
                || (receipt.requester_type === subject.type && receipt.requester_id === subject.id)
                || (owner.type === 'user' && obId && String(owner.id) === String(obId));
            if (!allowed) throw new AiError(404, 'ai.receipt_not_found', `no receipt ${req.params.id}`);
            return { receipt };
        });
        r.get('/v1/receipts/:id', read, readReceipt);
        r.get('/api/v1/receipts/:id', read, readReceipt);
    }

    return r;
}

module.exports = { exchangeRouter };
