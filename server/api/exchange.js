'use strict';
/**
 * Public Exchange catalog and usage, saved routing presets, and per-run receipts.
 * Presets and receipt reads use authenticated routes below.
 */
/**
 * OpenVibe.Exchange's read API: the public catalog, one model, and aggregate usage.
 *
 *   GET /api/v1/exchange/catalog                 every model, its offers, prices, speed and uptime
 *   GET /api/v1/exchange/models/:slug            one model ("deepseek/deepseek-chat", or org + model)
 *   GET /api/v1/exchange/usage?days=30           requests, tokens and spend by day, model and product
 *
 * No token: everything here is public on openvibe.exchange (the site, and anyone comparing prices).
 * Nothing is per person, and no provider secret, base URL or metadata leaves the catalog shape in
 * server/exchange/catalog.js. The answers are cached in this process for half a minute, so a busy
 * Exchange does not scan the stats table per page view.
 */
const express = require('express');
const { CAPS } = require('../auth');
const { AiError, sendError } = require('../util');
const { http } = require('openvibe-contracts');
const { createCatalog, KINDS: catalogKinds } = require('../exchange/catalog');
const { createUsage } = require('../exchange/usage');

const CATALOG_MS = 30_000;

function memo(fn, ttlMs, clock) {
    let hit = { at: 0, value: null };
    return async () => {
        if (hit.value && clock.now() - hit.at < ttlMs) return hit.value;
        const value = await fn();
        hit = { at: clock.now(), value };
        return value;
    };
}

function exchangeRouter({ db, registry, pool, env = process.env, clock = { now: () => Date.now() }, config = null, presets, receipts, auth, log = console }) {
    const catalog = createCatalog({ db, registry, pool, env, clock, config });
    const usage = createUsage({ db, clock });
    // One cached read per kind (?kind=chat, screenshot, …); the unfiltered read is the full catalog.
    const hits = new Map();
    const allFor = (kind) => {
        const key = kind || '';
        if (!hits.has(key)) hits.set(key, memo(() => catalog.models({ days: 7, kind: kind || null }), CATALOG_MS, clock));
        return hits.get(key)();
    };
    const all = () => allFor(null);
    const usageByWindow = new Map();
    const r = express.Router();

    const publicCache = (seconds) => (req, res, next) => { res.set('Cache-Control', `public, max-age=${seconds}`); next(); };

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

    r.get('/api/v1/exchange/catalog', publicCache(30), async (req, res, next) => {
        try {
            const kind = req.query.kind == null || req.query.kind === '' ? null : String(req.query.kind).toLowerCase();
            if (kind && !catalogKinds.includes(kind)) {
                return http.sendProblem(res, 422, 'exchange.kind_invalid', { detail: `kind must be one of ${catalogKinds.join(', ')}`, ctx: req.ov });
            }
            res.json(await allFor(kind));
        } catch (err) { next(err); }
    });

    r.get('/api/v1/exchange/models/:slug', publicCache(30), async (req, res, next) => {
        try {
            const out = await all();
            const slug = String(req.params.slug || '').toLowerCase();
            const found = out.models.find((m) => m.slug === slug);
            if (!found) return http.sendProblem(res, 404, 'exchange.model_not_found', { detail: `no model ${slug}`, ctx: req.ov });
            return res.json(found);
        } catch (err) { return next(err); }
    });

    r.get('/api/v1/exchange/models/:org/:model', publicCache(30), async (req, res, next) => {
        try {
            const out = await all();
            const slug = `${String(req.params.org || '').toLowerCase()}/${String(req.params.model || '').toLowerCase()}`;
            const found = out.models.find((m) => m.slug === slug);
            if (!found) return http.sendProblem(res, 404, 'exchange.model_not_found', { detail: `no model ${slug}`, ctx: req.ov });
            return res.json(found);
        } catch (err) { return next(err); }
    });

    r.get('/api/v1/exchange/usage', publicCache(60), async (req, res, next) => {
        try {
            const days = Math.max(1, Math.min(366, Number.parseInt(req.query.days, 10) || 30));
            const key = String(days);
            const cached = usageByWindow.get(key);
            if (cached && clock.now() - cached.at < 60_000) return res.json(cached.value);
            const value = await usage.read({ days });
            usageByWindow.set(key, { at: clock.now(), value });
            if (usageByWindow.size > 16) usageByWindow.delete(usageByWindow.keys().next().value);
            return res.json(value);
        } catch (err) { return next(err); }
    });

    return r;
}

module.exports = { exchangeRouter, CATALOG_MS };
