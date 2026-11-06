'use strict';
/**
 * The public seller API (design EXCHANGE-REMAKE-2026-11-06, "Gap found while building the SDK"): a standalone
 * OpenAI-compatible server can sell to the Exchange with the seller's own Network developer key, not only an
 * OpenVibe Node machine. Served on the Exchange's public API host (api.openvibe.exchange) and documented in
 * /openapi.json.
 *
 *   POST   /api/v1/exchange/seller/offers          ai.app.run (a developer key), or a person's own token
 *                                                  body: base_url, models, price, hours, concurrency, audience, group
 *                                                  → 201 { offer }
 *   GET    /api/v1/exchange/seller/offers          the caller's own offers, with their verification
 *   DELETE /api/v1/exchange/seller/offers/:id      remove one (its verification and earnings stay as history)
 *
 * The owner is the person the key acts for: a person's own subject, or a developer app's project owner (read from
 * Network with network.project.read). A first-party service token is refused. The key is never a buyer credential:
 * AI reaches the endpoint only through server/community/endpoints.js's egress guard.
 */
const express = require('express');
const { CAPS } = require('../auth');
const { sendError } = require('../util');

function sellerRouter({ endpoints, community = null, auth, log = console }) {
    const r = express.Router();
    const allow = auth.appOrCap(CAPS.appRun, CAPS.runCreate);
    const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
    const wrap = (fn) => async (req, res) => {
        try {
            const out = await fn(req, res);
            if (out !== undefined) res.json(out);
        } catch (err) { sendError(res, err, req.ov, log); }
    };

    r.post('/api/v1/exchange/seller/offers', allow, wrap(async (req, res) => {
        const who = await endpoints.ownerFor(req.principal);
        const offer = await endpoints.create({ owner: who.owner, projectId: who.projectId, appId: who.appId, createdBy: req.principal.sub, input: body(req) });
        res.status(201).set('Cache-Control', 'no-store');
        return { offer };
    }));

    r.get('/api/v1/exchange/seller/offers', allow, wrap(async (req, res) => {
        const who = await endpoints.ownerFor(req.principal);
        res.set('Cache-Control', 'no-store');
        const offers = await endpoints.list(who.owner);
        // The verification is the same the /sell dashboard shows: canaries, spot re-runs, reputation and free-only.
        let dashboard = null;
        if (community && typeof community.sell === 'function') {
            try { dashboard = await community.sell(who.owner); } catch (err) { log.warn(`[ai] seller dashboard ${who.owner}: ${err.message}`); }
        }
        const byOffer = new Map(((dashboard && dashboard.offers) || []).map((o) => [o.offer_id, o]));
        return {
            owner: who.owner,
            offers: offers.map((o) => {
                const state = byOffer.get(o.offer_id);
                return { ...o, verification: state ? state.verification : null, reputation: state ? state.reputation : 0,
                    free_only: state ? state.free_only !== false : true, verified: state ? state.verified === true : false };
            }),
        };
    }));

    r.delete('/api/v1/exchange/seller/offers/:id', allow, wrap(async (req, res) => {
        const who = await endpoints.ownerFor(req.principal);
        res.set('Cache-Control', 'no-store');
        return await endpoints.remove({ id: req.params.id, owner: who.owner });
    }));

    return r;
}

module.exports = { sellerRouter };
