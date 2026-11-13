'use strict';
/**
 * Video analyses (workflow video.analyze): start one for its price, follow its seven steps, read the
 * analysis back and read one of its keyframes.
 *
 *   GET    /api/v1/video-analyses/pricing      public: the three depths, their frame caps and their price
 *   POST   /api/v1/video-analyses              ai.run.create: { media_id | attachment_id | url, depth,
 *                                               ask?, language?, duration_s?, on_behalf_of? }; 202 with state
 *   GET    /api/v1/video-analyses              ai.run.read: the caller's analyses, newest first
 *   GET    /api/v1/video-analyses/:id          the whole state and, when it has ended, the ai.video-analysis@1
 *   GET    /api/v1/video-analyses/:id/state    just the live step progress (the page polls this)
 *   GET    /api/v1/video-analyses/:id/frames/:frame   one keyframe, as the owner (private, no-store)
 *
 * The video is a Media object, a Media attachment or a Media URL: OpenVibe.Media decides who may read it,
 * and a URL that is not Media's is refused. The price is computed here from the depth and the length the
 * caller names (never from a price in the body) and is held on the tier budgets; the real cost is on the
 * run's receipt.
 */
const express = require('express');
const fs = require('fs');
const { AiError, sendError } = require('../util');
const { CAPS, namespaceAllowed } = require('../auth');
const { INPUT_SCHEMA } = require('../video-analysis/schema');

function videoAnalysesRouter({ config, runs, auth, videoAnalysis, store, mediaStore = null, log = console }) {
    if (!videoAnalysis || !store) return express.Router();
    const r = express.Router();
    const create = auth.requireCap(CAPS.runCreate);
    const read = auth.requireCap(CAPS.runRead, CAPS.runCreate);
    const has = (req, id) => auth.principalHas(req, id);

    function stateOf(va, run = null) {
        if (!va) return null;
        return {
            id: va.id, run_id: va.run_id,
            status: run && ['failed', 'cancelled', 'succeeded'].includes(run.status) && va.status === 'running' ? run.status : va.status,
            step: va.step, progress: va.progress, steps: va.steps, depth: va.depth, media_id: va.media_id,
            input: va.input, frames: va.frames, report: va.report, gaps: va.gaps, error: va.error || (run && run.error) || null,
            owner: va.owner, created_at: va.created_at, updated_at: va.updated_at, finished_at: va.finished_at,
        };
    }

    async function owned(req, id) {
        const va = await store.get(id);
        if (!va) throw new AiError(404, 'video_analysis.not_found', 'no such video analysis');
        const run = await runs.get(id).catch(() => null);
        const s = req.principal.subject;
        const requester = run && run.requester;
        const mine = [va.owner, requester].some((x) => x && x.type === s.type && x.id === s.id);
        if (!mine && !has(req, CAPS.usageRead)) throw new AiError(404, 'video_analysis.not_found', 'no such video analysis');
        return { va, run };
    }

    // Public: what a depth costs, before anyone signs in.
    r.get('/api/v1/video-analyses/pricing', (req, res) => {
        res.json({ workflow: 'video.analyze', schema: 'ai.video-analysis@1', depths: videoAnalysis.depths(), currency: 'USD' });
    });

    r.post('/api/v1/video-analyses', create, async (req, res) => {
        try {
            if (config.videoAnalysis && config.videoAnalysis.enabled === false) throw new AiError(503, 'video_analysis.unavailable', 'video analyses are off on this service');
            const who = req.principal;
            // The same namespace rule every run has. Exchange's grant names ai.complete and design.deep_dive;
            // a token that may run video.analyze runs it.
            const owned = who.subject && who.subject.type === 'service' && who.subject.id === 'exchange';
            if (!owned && !namespaceAllowed(who, 'video.analyze')) throw new AiError(403, 'capability.namespace_denied', 'this token may not run video.analyze');
            const body = req.body || {};
            const { idempotency_key: idem, target, attribution, on_behalf_of: obo, duration_s, ...raw } = body;
            const input = {
                ...(raw.media_id ? { media_id: String(raw.media_id) } : {}),
                ...(raw.attachment_id ? { attachment_id: String(raw.attachment_id) } : {}),
                ...(raw.url ? { url: String(raw.url) } : {}),
                depth: raw.depth,
                ...(raw.ask ? { ask: String(raw.ask) } : {}),
                ...(raw.language ? { language: String(raw.language) } : {}),
            };
            if (obo != null && !(obo.type === 'user' && /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(obo.id || '')))) throw new AiError(422, 'input.invalid', 'on_behalf_of must be a user subject');
            const checked = require('../schemas').validate(INPUT_SCHEMA, input);
            if (!checked.valid) throw new AiError(422, 'input.invalid', 'a video analysis needs ' + checked.errors.map((e) => e.path + ' ' + e.message).join('; '));
            // A URL that is not Media's is refused here, before a run is made and before anything is fetched.
            if (input.url && !videoAnalysis.source.isMediaUrl(input.url)) throw new AiError(422, 'input.invalid', 'a video must be a Media object, a Media attachment or a Media URL; this one is not Media\'s');
            // The price is computed here, from the depth and the length the caller names; the body never carries it.
            const minutes = Number(duration_s) > 0 ? Number(duration_s) / 60 : 0;
            const price = videoAnalysis.priceOf(input.depth, minutes);
            const created = await runs.create({
                workflow: 'video.analyze', input,
                ...(idem ? { idempotency_key: idem } : {}),
                ...(target ? { target } : {}), ...(attribution ? { attribution } : {}), ...(obo ? { on_behalf_of: obo } : {}),
                options: { cache: 'none', hold: { usd: price, tokens: Math.round(price * 250000) } },
            }, req.principal, { trace: req.ov.traceId, requestId: req.ov.requestId });
            await store.ensure({ runId: created.run.id, input, depth: input.depth, mediaId: input.media_id || null, owner: obo || (req.principal.kind === 'user' ? req.principal.subject : null) });
            const va = await store.get(created.run.id);
            res.setHeader('Location', '/api/v1/video-analyses/' + created.run.id);
            res.status(202).json({ video_analysis: stateOf(va, created.run), price_usd: price, held_usd: price });
        } catch (err) { sendError(res, err, req.ov, log); }
    });

    r.get('/api/v1/video-analyses', read, async (req, res) => {
        const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
        const all = [];
        for (const run of await runs.list(req.principal, { workflow: 'video.analyze', limit })) {
            const va = await store.get(run.id);
            if (va) all.push(stateOf(va, run));
        }
        res.json({ video_analyses: all.slice(0, limit) });
    });

    r.get('/api/v1/video-analyses/:id', read, async (req, res) => {
        try {
            const { va, run } = await owned(req, req.params.id);
            res.json({ video_analysis: stateOf(va, run) });
        } catch (err) { sendError(res, err, req.ov, log); }
    });

    r.get('/api/v1/video-analyses/:id/state', read, async (req, res) => {
        try {
            const { va, run } = await owned(req, req.params.id);
            const s = stateOf(va, run);
            res.set('Cache-Control', 'no-store');
            res.json({ video_analysis: { id: s.id, run_id: s.run_id, status: s.status, step: s.step, progress: s.progress, steps: s.steps, frames: s.frames, gaps: s.gaps, error: s.error, updated_at: s.updated_at, finished_at: s.finished_at } });
        } catch (err) { sendError(res, err, req.ov, log); }
    });

    r.get('/api/v1/video-analyses/:id/frames/:frame', read, async (req, res) => {
        try {
            const { va } = await owned(req, req.params.id);
            const index = Number(req.params.frame);
            const frame = (va.frames || [])[index];
            if (!frame) throw new AiError(404, 'video_analysis.frame_not_found', 'no such frame');
            // The frame is a private Media object when Media holds one; else the copy on this host.
            if (frame.media_id && mediaStore && typeof mediaStore.bytes === 'function') {
                let got;
                try { got = await mediaStore.bytes(frame.media_id, { owner: va.owner && va.owner.id }); }
                catch (err) { throw new AiError(err.status === 404 ? 404 : 503, err.code || 'media.unavailable', err.message || 'Media could not read the frame'); }
                res.set({ 'Content-Type': got.mime || 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' });
                res.send(got.buffer);
                return;
            }
            const path = videoAnalysis.framePath(va.id, index);
            if (!fs.existsSync(path)) throw new AiError(404, 'video_analysis.frame_not_kept', 'this frame was not kept');
            res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' });
            res.send(fs.readFileSync(path));
        } catch (err) { sendError(res, err, req.ov, log); }
    });

    return r;
}

module.exports = { videoAnalysesRouter };
