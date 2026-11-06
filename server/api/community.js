'use strict';
/**
 * The community AI API (design: "Offer to the network"; plan E4), what OpenVibe.Exchange's /sell page shows and what
 * the public "Run on people's machines" row lists:
 *
 *   GET /api/v1/community/offers        public: the live community offers (models, price, hours, health, audience);
 *                                       never an owner subject or a machine id
 *   GET /api/v1/community/sell          ai.run.read or ai.usage.read, acting for the owner in X-OV-Subject:
 *                                       tokens served, earnings in credits, uptime, verification and reputation
 *
 * The seller's ledger is OpenVibe.AI's (server/community): tokens × the owner's credits-per-million price, recorded
 * in integer micro-credits; nothing here moves money.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { CAPS } = require('../auth');

const OWNER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function communityRouter({ community, auth, log = console }) {
    const r = express.Router();
    const send = (res, status, body) => res.status(status).set('Cache-Control', 'no-store').json(body);

    r.get('/community/offers', async (req, res) => {
        try {
            res.set('Cache-Control', 'public, max-age=30').json({ offers: await community.publicOffers(), generated_at: new Date().toISOString() });
        } catch (err) {
            log.warn(`[ai] community offers: ${err.message}`);
            http.sendProblem(res, 503, 'community.unavailable', { detail: 'community offers are not available right now' });
        }
    });

    r.get('/community/sell', auth.requireCap(CAPS.runRead, CAPS.usageRead), async (req, res) => {
        const owner = String(req.get('x-ov-subject') || req.query.owner || '');
        if (!OWNER.test(owner)) return http.sendProblem(res, 422, 'input.invalid', { detail: 'a community seller is named by X-OV-Subject (a usr_ subject)' });
        // A service acts for the owner it names; a person's own token is not accepted on this route (auth.requireCap).
        try {
            res.json(await community.sell(owner));
        } catch (err) {
            if (err && err.status) return http.sendProblem(res, err.status, err.code || 'input.invalid', { detail: err.detail || err.message });
            log.warn(`[ai] community sell ${owner}: ${err.message}`);
            http.sendProblem(res, 503, 'community.unavailable', { detail: 'the seller dashboard is not available right now' });
        }
    });

    return r;
}

module.exports = { communityRouter };
