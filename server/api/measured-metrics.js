'use strict';
const express = require('express');
const { sendError, AiError } = require('../util');
function measuredMetricsRouter({ db, clock = { now: () => Date.now() }, log = console }) {
    const r = express.Router();
    const reads = require('../exchange/metrics-read').createMetricsRead({ db, clock });
    const cache = new Map();
    r.use('/api/v1/exchange/metrics', (req, res, next) => {
        if (!['GET', 'OPTIONS'].includes(req.method)) return next();
        res.set('Access-Control-Allow-Origin', '*');
        if (req.method === 'OPTIONS') return res.set({ 'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Accept, Content-Type, Authorization', 'Access-Control-Max-Age': '600' }).sendStatus(204);
        next();
    });
    const read = (fn) => async (req, res) => {
        try {
            const key = req.originalUrl;
            if (key.length > 2400) throw new AiError(422, 'metrics.invalid', 'query is too long');
            let value = cache.get(key);
            if (!value || value.until <= clock.now()) {
                value = { until: clock.now() + 60000, body: await fn(req) };
                cache.set(key, value);
                if (cache.size > 256) cache.delete(cache.keys().next().value);
            }
            res.set('Cache-Control', 'public, max-age=60').json(value.body);
        } catch (err) { res.set('Cache-Control', 'no-store'); sendError(res, err, req.ov, log); }
    };
    r.get('/api/v1/exchange/metrics/models/:model', read((req) => reads.series(req.params.model, req.query)));
    r.get('/api/v1/exchange/metrics/compare', read((req) => reads.compare(req.query)));
    r.get('/api/v1/exchange/metrics/leaderboard', read((req) => reads.leaderboard(req.query)));
    r.get('/api/v1/exchange/metrics/prices/:model', read((req) => reads.prices(req.params.model, req.query)));
    r.get('/api/v1/exchange/metrics/providers/:provider', read((req) => reads.health(req.params.provider)));
    let hit = null;
    r.get('/api/v1/exchange/metrics/status', async (req, res) => {
        try {
            if (!hit || hit.until <= clock.now()) {
                const state = await db.prepare('SELECT completed_through, completed_at FROM exchange_metrics_job WHERE id = 1').get();
                const cells = await db.prepare('SELECT COUNT(*)::integer AS published_cells, MIN(day) AS first_day, MAX(day) AS last_day FROM exchange_metrics_daily WHERE runs >= 20').get();
                hit = { until: clock.now() + 60000, body: { schema: 'exchange.metrics@1', minimum_samples: 20, ...state, ...cells } };
            }
            res.set('Cache-Control', 'public, max-age=60').json(hit.body);
        } catch (err) { sendError(res, err, req.ov, log); }
    });
    return r;
}
module.exports = { measuredMetricsRouter };
