'use strict';
const express = require('express');
const { sendError } = require('../util');
function measuredMetricsRouter({ db, clock = { now: () => Date.now() }, log = console }) {
    const r = express.Router();
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
