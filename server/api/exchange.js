'use strict';
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
const { http } = require('openvibe-contracts');
const { createCatalog } = require('../exchange/catalog');
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

function exchangeRouter({ db, registry, pool, clock = { now: () => Date.now() } }) {
    const catalog = createCatalog({ db, registry, pool, clock });
    const usage = createUsage({ db, clock });
    const all = memo(() => catalog.models({ days: 7 }), CATALOG_MS, clock);
    const usageByWindow = new Map();
    const r = express.Router();

    const publicCache = (seconds) => (req, res, next) => { res.set('Cache-Control', `public, max-age=${seconds}`); next(); };

    r.get('/api/v1/exchange/catalog', publicCache(30), async (req, res, next) => {
        try { res.json(await all()); } catch (err) { next(err); }
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
