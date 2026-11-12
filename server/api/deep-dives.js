'use strict';
/**
 * Deep dives (workflow design.deep_dive): start one for its price, follow its seven steps, add or drop sites
 * before Capture, cancel it, read the report, and read a private screenshot back.
 *
 *   GET    /api/v1/deep-dives/depths       public: the three depths, their site counts, minutes and price
 *   POST   /api/v1/deep-dives              ai.run.create: { question, depth, sites?, on_behalf_of? }; 202 with state
 *   GET    /api/v1/deep-dives              ai.run.read: the caller's deep dives, newest first
 *   GET    /api/v1/deep-dives/:id          the whole state and, when it has ended, the ai.deep-dive@1 report
 *   GET    /api/v1/deep-dives/:id/state    just the live step progress, candidates and status (the page polls this)
 *   POST   /api/v1/deep-dives/:id/sites    { add: [https…], drop: [https…], start: true } while Choosing
 *   POST   /api/v1/deep-dives/:id/cancel   the runs cancel; no further capture or model call starts
 *   GET    /api/v1/deep-dives/:id/shots/:shot   one private screenshot/crop, as the owner (private, no-store)
 *
 * The price is computed here from the depth (never from the body) and passed to runs.create as the tier hold; the
 * output of the run is the report, so a caller that waits on the run's own receipt sees the same document.
 */
const express = require('express');
const { AiError, sendError } = require('../util');
const { CAPS, namespaceAllowed } = require('../auth');
const { INPUT_SCHEMA, DEPTHS } = require('../deep-dive/schema');

function deepDivesRouter({ config, runs, auth, deepDive, store, capture = null, mediaStore = null, log = console }) {
    if (!deepDive || !store) return express.Router();
    const r = express.Router();
    const create = auth.requireCap(CAPS.runCreate);
    const read = auth.requireCap(CAPS.runRead, CAPS.runCreate);
    const has = (req, id) => auth.principalHas(req, id);

    function stateOf(dd, run = null) {
        if (!dd) return null;
        const report = dd.report || null;
        return {
            id: dd.id, run_id: dd.run_id, status: run && ['failed', 'cancelled', 'succeeded'].includes(run.status) && dd.status === 'running' ? run.status : dd.status,
            step: dd.step, progress: dd.progress, steps: dd.steps, question: dd.question, depth: dd.depth, site_limit: dd.site_limit,
            price_usd: dd.price_usd, candidates: dd.candidates, captures: dd.captures.map((c) => ({ id: c.id, source_id: c.source_id, url: c.url, viewport: c.viewport, theme: c.theme, captured_at: c.captured_at, skip: c.skip, cached: c.cached, crops: c.crops.map((x) => ({ id: x.id, y: x.y, height: x.height })) })),
            report, gaps: dd.gaps, error: dd.error || (run && run.error) || null,
            owner: dd.owner, created_at: dd.created_at, updated_at: dd.updated_at, finished_at: dd.finished_at,
            holding: dd.price_usd,
        };
    }

    async function owned(req, id) {
        const dd = await store.get(id);
        if (!dd) throw new AiError(404, 'deep_dive.not_found', 'no such deep dive');
        const run = await runs.get(id).catch(() => null);
        const s = req.principal.subject;
        const requester = run && run.requester;
        const mine = [dd.owner, requester].some((x) => x && x.type === s.type && x.id === s.id);
        if (!mine && !has(req, CAPS.usageRead)) throw new AiError(404, 'deep_dive.not_found', 'no such deep dive');
        return { dd, run };
    }

    // Public: what a depth costs, before anyone signs in.
    r.get('/api/v1/deep-dives/depths', (req, res) => {
        res.json({ depths: deepDive.depths(), capture: capture ? { enabled: capture.available ? capture.available() : true } : null });
    });

    r.post('/api/v1/deep-dives', create, async (req, res) => {
        try {
            if (!config.deepDive || config.deepDive.enabled === false) throw new AiError(503, 'deep_dive.unavailable', 'deep dives are off on this service');
            // The same namespace rule every run has, with the one owner allowance: Exchange's long-standing
            // ai.run.create grant names ai.complete, and design.deep_dive is the workflow its /deep-dive page starts.
            const who = req.principal;
            const owned = who.subject && who.subject.type === 'service' && who.subject.id === 'exchange';
            if (!owned && !namespaceAllowed(who, 'design.deep_dive')) throw new AiError(403, 'capability.namespace_denied', 'this token may not run design.deep_dive');
            const body = req.body || {};
            const { idempotency_key: idem, target, attribution, on_behalf_of: obo, ...raw } = body;
            const input = { question: String(raw.question == null ? '' : raw.question).replace(/\s+/g, ' ').trim(), depth: raw.depth, ...(Array.isArray(raw.sites) && raw.sites.length ? { sites: raw.sites.slice(0, 30) } : {}) };
            if (obo != null && !(obo.type === 'user' && /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(obo.id || '')))) throw new AiError(422, 'input.invalid', 'on_behalf_of must be a user subject');
            const schema = require('../schemas').validate(INPUT_SCHEMA, input);
            if (!schema.valid) throw new AiError(422, 'input.invalid', `a deep dive needs ${schema.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
            const price = deepDive.priceOf(input.depth);
            const created = await runs.create({
                workflow: 'design.deep_dive', input,
                ...(idem ? { idempotency_key: idem } : {}),
                ...(target ? { target } : {}), ...(attribution ? { attribution } : {}), ...(obo ? { on_behalf_of: obo } : {}),
                options: { cache: 'none', hold: { usd: price, tokens: Math.round(price * 250000) } },
            }, req.principal, { trace: req.ov.traceId, requestId: req.ov.requestId });
            // The row exists before the first status is returned, so the page has something to read even while
            // the worker is still starting; the run's own step ensures the same row (ON CONFLICT DO NOTHING).
            await store.ensure({ runId: created.run.id, question: input.question, depth: input.depth, siteLimit: deepDive.limitOf(input.depth), priceUsd: price, owner: obo || (req.principal.kind === 'user' ? req.principal.subject : null) });
            const dd = await store.get(created.run.id);
            res.setHeader('Location', `/api/v1/deep-dives/${created.run.id}`);
            res.status(202).json({ deep_dive: stateOf(dd, created.run), price_usd: price, held_usd: price });
        } catch (err) { sendError(res, err, req.ov, log); }
    });

    r.get('/api/v1/deep-dives', read, async (req, res) => {
        const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
        const all = [];
        for (const run of await runs.list(req.principal, { workflow: 'design.deep_dive', limit })) {
            const dd = await store.get(run.id);
            if (dd) all.push(stateOf(dd, run));
        }
        res.json({ deep_dives: all.slice(0, limit) });
    });

    r.get('/api/v1/deep-dives/:id', read, async (req, res) => {
        try {
            const { dd, run } = await owned(req, req.params.id);
            res.json({ deep_dive: stateOf(dd, run) });
        } catch (err) { sendError(res, err, req.ov, log); }
    });

    r.get('/api/v1/deep-dives/:id/state', read, async (req, res) => {
        try {
            const { dd, run } = await owned(req, req.params.id);
            const s = stateOf(dd, run);
            res.set('Cache-Control', 'no-store');
            res.json({ deep_dive: { id: s.id, run_id: s.run_id, status: s.status, step: s.step, progress: s.progress, steps: s.steps, candidates: s.candidates, captures: s.captures, gaps: s.gaps, error: s.error, updated_at: s.updated_at, finished_at: s.finished_at } });
        } catch (err) { sendError(res, err, req.ov, log); }
    });

    r.post('/api/v1/deep-dives/:id/sites', create, async (req, res) => {
        try {
            const { dd, run } = await owned(req, req.params.id);
            if (dd.decision_at || dd.status !== 'choosing') throw new AiError(409, 'deep_dive.not_choosing', `sites can be changed while the deep dive is choosing sites (this one is ${dd.status})`);
            const body = req.body || {};
            const add = (Array.isArray(body.add) ? body.add : []).map((u) => String(u).trim()).filter(Boolean).slice(0, 30);
            const drop = new Set((Array.isArray(body.drop) ? body.drop : []).map((u) => String(u).trim()).filter(Boolean));
            if (add.some((u) => !/^https?:\/\/[^\s]+$/i.test(u) || u.length > 2048)) throw new AiError(422, 'input.invalid', 'add must be http(s) URLs');
            const { cleanUrl } = require('../capture');
            let list = dd.candidates.slice(0, dd.site_limit);
            if (drop.size) list = list.filter((c) => !drop.has(c.url) && !drop.has(c.id));
            for (const raw of add) {
                const url = cleanUrl(raw);
                if (!url || list.some((c) => c.url === url)) continue;
                list.push({ id: `site_x${list.length + 1}`, url, title: new URL(url).hostname, reason: 'added by the person', source_id: null, chosen: true });
            }
            if (!list.length) throw new AiError(422, 'input.invalid', 'a deep dive needs at least one site to capture');
            const updated = await store.patch(dd.id, { candidates: list.slice(0, dd.site_limit), decision_at: new Date().toISOString() });
            await require('../events').deepDiveUpdated({ runId: dd.run_id, deepDiveId: dd.id, status: updated.status, step: updated.step, progress: updated.progress, steps: updated.steps, depth: updated.depth, requester: run && run.requester, on_behalf_of: updated.owner, url: `https://openvibe.exchange/deep-dive/${updated.id}` });
            res.json({ deep_dive: stateOf(updated) });
        } catch (err) { sendError(res, err, req.ov, log); }
    });

    r.post('/api/v1/deep-dives/:id/cancel', create, async (req, res) => {
        try {
            const { dd } = await owned(req, req.params.id);
            const run = await runs.cancel(dd.run_id, req.principal, { trace: req.ov.traceId, principalHas: has });
            const fresh = await store.get(dd.id);
            res.json({ deep_dive: stateOf(fresh, run) });
        } catch (err) { sendError(res, err, req.ov, log); }
    });

    r.get('/api/v1/deep-dives/:id/shots/:shot', read, async (req, res) => {
        try {
            const { dd } = await owned(req, req.params.id);
            const cap = (dd.captures || []).find((c) => c.id === req.params.shot || (c.crops || []).some((x) => x.id === req.params.shot));
            const id = cap && cap.id === req.params.shot ? cap.media_id : cap && cap.crops.find((x) => x.id === req.params.shot).media_id;
            if (!id) throw new AiError(404, 'deep_dive.shot_not_found', 'no such screenshot');
            if (!mediaStore || typeof mediaStore.bytes !== 'function') throw new AiError(503, 'media.unavailable', 'Media is not configured on this service');
            let got;
            try { got = await mediaStore.bytes(id, { owner: dd.owner && dd.owner.id }); }
            catch (err) { throw new AiError(err.status === 404 ? 404 : err.status === 413 ? 413 : 503, err.code || 'media.unavailable', err.message || 'Media could not read the screenshot'); }
            res.set({ 'Content-Type': got.mime || 'image/png', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' });
            res.send(got.buffer);
        } catch (err) { sendError(res, err, req.ov, log); }
    });

    return r;
}

module.exports = { deepDivesRouter };
