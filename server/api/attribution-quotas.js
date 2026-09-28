'use strict';
/**
 * Caps a service sets on its own attributions (roadmap WS-O task 2; Contracts 0.75.0 ai.quota.attribution.manage,
 * ai.attribution-quota-put@1, ai.attribution-quota@1): Live caps what a streamer's AI viewers may cost a day
 * (attribution live:user:<id>, workflow prefix live.viewers.), so the per-streamer budget is enforced here, before
 * any provider call (server/quota.js, scope attribution), instead of only in Live.
 *
 *   PUT    /api/v1/attribution-quotas/:attribution    set the cap for one window (hour or day) and optional prefix
 *   GET    /api/v1/attribution-quotas/:attribution    the caps with what each window has used ([] when none)
 *   DELETE /api/v1/attribution-quotas/:attribution    remove them all
 *
 * The attribution's service must be the calling service. Rows are quotas (origin service:<svc>), so the operator
 * console lists them with the rest; every change is audited by quotas.upsert.
 */
const express = require('express');
const { validate } = require('openvibe-contracts');
const { AiError, iso } = require('../util');

const ATTR_RE = /^([a-z][a-z0-9-]{1,31}):([a-z][a-z0-9_]{1,31}):([A-Za-z0-9_.-]{1,80})$/;
const WINDOW_S = { hour: 3600, day: 86400 };

function attributionQuotasRouter({ db, quotas, auth, clock = { now: () => Date.now() }, sendError }) {
    const r = express.Router();
    const guard = auth.requireCap('ai.quota.attribution.manage');

    function own(req) {
        const m = ATTR_RE.exec(String(req.params.attribution || ''));
        if (!m) throw new AiError(422, 'input.invalid', 'attribution must be <service>:<type>:<id>');
        const s = req.principal && req.principal.subject;
        if (!s || s.type !== 'service' || s.id !== m[1]) throw new AiError(403, 'capability.denied', 'a service caps only its own attributions');
        return m[0];
    }

    function view(row) {
        const now = Math.floor(clock.now() / 1000);
        const len = WINDOW_S[row.window];
        const start = Math.floor(now / len) * len;
        const c = db.prepare('SELECT requests, cost_usd FROM usage_counters WHERE scope_type = ? AND scope_id = ? AND window = ? AND window_start = ? AND workflow_prefix = ?')
            .get('attribution', row.scope_id, row.window, start, row.workflow_prefix || '') || { requests: 0, cost_usd: 0 };
        return {
            attribution: row.scope_id, window: row.window, workflow_prefix: row.workflow_prefix || null,
            max_cost_usd: row.max_cost_usd == null ? null : row.max_cost_usd, max_requests: row.max_requests == null ? null : row.max_requests,
            used: { requests: c.requests || 0, cost_usd: Math.round((c.cost_usd || 0) * 1e6) / 1e6 },
            window_resets_at: iso((start + len) * 1000), updated_at: row.updated_at,
        };
    }
    const rows = (attr) => db.prepare("SELECT * FROM quotas WHERE scope_type = 'attribution' AND scope_id = ? AND status = 'active' ORDER BY window, workflow_prefix").all(attr);

    r.put('/api/v1/attribution-quotas/:attribution', guard, (req, res) => {
        try {
            const attr = own(req);
            const body = req.body || {};
            const v = validate('ai.attribution-quota-put@1', body);
            if (!v.valid) throw new AiError(422, 'input.invalid', 'body does not match ai.attribution-quota-put@1', { errors: v.errors });
            const row = quotas.upsert({ scope_type: 'attribution', scope_id: attr, window: body.window, max_cost_usd: body.max_cost_usd, max_requests: body.max_requests, workflow_prefix: body.workflow_prefix || null, status: 'active' },
                { actor: req.principal.sub, origin: `service:${req.principal.subject.id}`, trace: req.ov && req.ov.traceId });
            res.set('Cache-Control', 'no-store').json(view(row));
        } catch (err) { sendError(res, err, req.ov); }
    });
    r.get('/api/v1/attribution-quotas/:attribution', guard, (req, res) => {
        try { res.set('Cache-Control', 'no-store').json({ quotas: rows(own(req)).map(view) }); } catch (err) { sendError(res, err, req.ov); }
    });
    r.delete('/api/v1/attribution-quotas/:attribution', guard, (req, res) => {
        try {
            const attr = own(req);
            const n = db.prepare("UPDATE quotas SET status = 'disabled', updated_at = ? WHERE scope_type = 'attribution' AND scope_id = ? AND status = 'active'").run(iso(clock.now()), attr).changes;
            res.status(n ? 204 : 404).end();
        } catch (err) { sendError(res, err, req.ov); }
    });
    return r;
}

module.exports = { attributionQuotasRouter };
