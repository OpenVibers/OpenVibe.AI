'use strict';
/**
 * The owner's rate cards for the search engines (plan §W.2 step 3, 11-13).
 *
 *   GET  /api/v1/admin/search/rate-cards                every card: active, draft and retired
 *   POST /api/v1/admin/search/rate-cards                a new version, as a draft
 *   POST /api/v1/admin/search/rate-cards/:id/activate   the owner activates a draft
 *
 * A card is never edited: a new price is a new version, a draft until the owner activates it, and activating
 * it retires the card it replaces for that (engine, unit). A draft is never used: the search reads the
 * active card only, so a price the owner has not activated changes nothing.
 *
 * Only the owner. The call comes through Exchange's admin proxy as the owner's own service principal with the
 * owner's role, the same boundary the GPU supply settings use (server/api/console-data.js). Every write
 * leaves an audit row: who changed which card, and what it says.
 */
const express = require('express');
const { CAPS } = require('../auth');
const { AiError, sendError } = require('../util');
const { createRateCards } = require('../search/rate-cards');

const OWNER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function searchRateCardsRouter({ db, registry, auth, clock = { now: () => Date.now() }, log = console } = {}) {
    const r = express.Router();
    const cards = createRateCards({ db, clock });
    const write = auth.requireCap(CAPS.providerManage);
    // The owner's own boundary: Exchange's admin proxy, acting for the owner, and nobody else.
    const owner = (req, res, next) => {
        if (req.principal?.sub !== 'svc:exchange' || req.get('x-ov-role') !== 'owner' || !OWNER_SUBJECT.test(String(req.get('x-ov-subject') || '')))
            return res.status(403).json({ code: 'search.owner_only', error: 'Only the owner may change the search rate cards.' });
        return next();
    };
    const wrap = (fn) => async (req, res) => {
        try { res.set('Cache-Control', 'no-store').json(await fn(req)); }
        catch (err) { sendError(res, err, req.ov, log); }
    };
    const actor = (req) => String(req.get('x-ov-subject') || req.principal?.sub || 'owner');
    const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

    r.get('/api/v1/admin/search/rate-cards', write, owner, wrap(async () => ({ rate_cards: await cards.list() })));

    r.post('/api/v1/admin/search/rate-cards', write, owner, express.json({ limit: '8kb' }), wrap(async (req) => {
        const draft = await cards.addDraft(body(req), { actor: actor(req) });
        if (registry && registry.audit)
            await registry.audit(actor(req), 'search.rate_card_draft', 'search_rate_card', draft.id,
                { trace: req.ov && req.ov.traceId, metadata: { engine: draft.engine, unit: draft.unit, version: draft.version, price: draft.price, ceiling: draft.ceiling } });
        return { rate_card: draft };
    }));

    r.post('/api/v1/admin/search/rate-cards/:id/activate', write, owner, wrap(async (req) => {
        const card = await cards.activate(req.params.id, { actor: actor(req) });
        if (registry && registry.audit)
            await registry.audit(actor(req), 'search.rate_card_activate', 'search_rate_card', card.id,
                { trace: req.ov && req.ov.traceId, metadata: { engine: card.engine, unit: card.unit, version: card.version, price: card.price, ceiling: card.ceiling } });
        return { rate_card: card };
    }));

    return r;
}

module.exports = { searchRateCardsRouter };
