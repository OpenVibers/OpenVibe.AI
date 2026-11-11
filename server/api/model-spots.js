'use strict';
const express = require('express');
const { CAPS } = require('../auth');
const { AiError, sendError } = require('../util');

function modelSpotsRouter({ discovery, auth, registry, log = console }) {
    const r = express.Router();
    const wrap = fn => async (req, res) => { try { res.set('Cache-Control', 'no-store').json(await fn(req)); }
        catch (error) { sendError(res, error, req.ov, log); } };
    r.get('/api/v1/exchange/spotted', wrap(async () => ({ models: await discovery.list() })));
    r.get('/api/v1/admin/console/model-spots', auth.requireCap(CAPS.usageRead), wrap(async () => ({ models: await discovery.list({ includeDismissed: true }) })));
    r.post('/api/v1/admin/console/model-spots/refresh', auth.requireCap(CAPS.providerManage), wrap(async () => discovery.run()));
    r.post('/api/v1/admin/console/model-spots/:id/status', express.json({ limit: '4kb' }), auth.requireCap(CAPS.providerManage), wrap(async req => {
        const status = req.body?.status;
        if (!['spotted', 'promoted', 'dismissed'].includes(status)) throw new AiError(422, 'ai.invalid', 'invalid spot status');
        if (!await discovery.setStatus(req.params.id, status)) throw new AiError(404, 'ai.not_found', 'no such spotted model');
        await registry.audit(req.principal.sub, `model.spot_${status}`, 'model_spot', req.params.id, { trace: req.ov?.traceId });
        return { ok: true, id: req.params.id, status };
    }));
    return r;
}
module.exports = { modelSpotsRouter };
