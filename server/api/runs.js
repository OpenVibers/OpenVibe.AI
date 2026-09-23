'use strict';
/**
 * Run API.
 *
 *   POST /api/v1/runs                       create (ai.run.create); ?wait=ms waits for the result
 *   GET  /api/v1/runs                       the caller's runs (ai.run.read)
 *   GET  /api/v1/runs/:id                   one run (+ citations, request log metadata)
 *   POST /api/v1/runs/:id/cancel            (ai.run.create, owner)
 *   POST /api/v1/runs/:id/retry             (ai.run.create, owner) -> a new run with retry_of
 *   GET  /api/v1/runs/:id/citations         (ai.run.read)
 *   POST /api/v1/runs/:id/citations         attach sources/citations to a finished run (ai.run.create, owner)
 *   POST /api/v1/{chat,generate,summarize,classify,extract,enrich,embed}
 *                                           direct operations: a run of workflow ai.<op>, waited for
 *
 * Responses: 201 when a new run finished (or was served from cache) within the wait, 202 while it
 * is still queued/running (poll GET /runs/:id), 200 for an idempotent replay. Errors are
 * problem+json; a quota refusal is 429 with Retry-After.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { AiError } = require('../util');
const { CAPS, namespaceAllowed } = require('../auth');

function sendError(res, err, ctx, log = console) {
    if (err instanceof AiError) {
        const extra = err.extra && typeof err.extra === 'object' ? { ...err.extra } : undefined;
        const errors = extra && Array.isArray(extra.errors) ? extra.errors : undefined;
        if (extra) delete extra.errors;
        if (err.status === 429 && extra && extra.retry_after_seconds) res.setHeader('Retry-After', String(extra.retry_after_seconds));
        return http.sendProblem(res, err.status, err.code, { detail: err.detail, ctx, errors, extra });
    }
    log.error(`[api] ${err && err.stack || err}`);
    return http.sendProblem(res, 500, 'ai.internal', { detail: 'internal error', ctx });
}

function runsRouter({ runs, registry, auth, config, log = console }) {
    const r = express.Router();
    const create = auth.requireCap(CAPS.runCreate);
    const read = auth.requireCap(CAPS.runRead, CAPS.runCreate, CAPS.usageRead);
    const has = (req) => (id) => auth.principalHas(req, id);

    function checkNamespace(req, workflowKey) {
        if (!namespaceAllowed(req.principal, workflowKey)) throw new AiError(403, 'capability.namespace_denied', `this token may not run ${workflowKey}`);
    }

    async function createAndRespond(req, res, body, waitMs) {
        checkNamespace(req, String(body.workflow || ''));
        const idem = body.idempotency_key || req.ov.idempotencyKey || undefined;
        const created = runs.create({ ...body, idempotency_key: idem }, req.principal, { trace: req.ov.traceId, requestId: req.ov.requestId });
        const run = await runs.wait(created, waitMs);
        const status = !created.created ? 200 : (runs.TERMINAL.has(run.status) ? 201 : 202);
        if (status === 202) res.setHeader('Location', `/api/v1/runs/${run.id}`);
        return res.status(status).json({ run, replayed: !created.created || undefined });
    }

    r.post('/api/v1/runs', create, async (req, res) => {
        try {
            const wait = Math.max(0, Math.min(Number(req.query.wait) || 0, config.runs.maxWaitMs));
            await createAndRespond(req, res, req.body || {}, wait);
        } catch (err) { sendError(res, err, req.ov, log); }
    });

    r.get('/api/v1/runs', read, (req, res) => {
        const all = req.query.all === '1' && auth.principalHas(req, CAPS.usageRead);
        res.json({ runs: runs.list(req.principal, { status: req.query.status, workflow: req.query.workflow, target: req.query.target, limit: req.query.limit, before: req.query.before, all }) });
    });

    function owned(req) {
        const run = runs.get(req.params.id);
        if (!run) throw new AiError(404, 'run.not_found', 'no such run');
        const s = req.principal.subject;
        const mine = run.requester.type === s.type && run.requester.id === s.id;
        if (!mine && !auth.principalHas(req, CAPS.usageRead)) throw new AiError(404, 'run.not_found', 'no such run');
        return run;
    }

    r.get('/api/v1/runs/:id', read, (req, res) => {
        try {
            const run = owned(req);
            res.json({ run, citations: runs.citations(run.id), requests: runs.requestsFor(run.id) });
        } catch (err) { sendError(res, err, req.ov, log); }
    });

    r.post('/api/v1/runs/:id/cancel', create, (req, res) => {
        try { res.json({ run: runs.cancel(req.params.id, req.principal, { trace: req.ov.traceId, principalHas: has(req) }) }); } catch (err) { sendError(res, err, req.ov, log); }
    });

    r.post('/api/v1/runs/:id/retry', create, async (req, res) => {
        try {
            const created = runs.retry(req.params.id, req.principal, { trace: req.ov.traceId, requestId: req.ov.requestId, principalHas: has(req) });
            const wait = Math.max(0, Math.min(Number(req.query.wait) || 0, config.runs.maxWaitMs));
            const run = await runs.wait(created, wait);
            res.status(runs.TERMINAL.has(run.status) ? 201 : 202).json({ run });
        } catch (err) { sendError(res, err, req.ov, log); }
    });

    r.get('/api/v1/runs/:id/citations', read, (req, res) => {
        try { const run = owned(req); res.json({ citations: runs.citations(run.id) }); } catch (err) { sendError(res, err, req.ov, log); }
    });

    r.post('/api/v1/runs/:id/citations', create, (req, res) => {
        try {
            const run = owned(req);
            const s = req.principal.subject;
            if (run.requester.type !== s.type || run.requester.id !== s.id) throw new AiError(403, 'capability.denied', 'only the requester may attach citations');
            const list = Array.isArray(req.body && req.body.citations) ? req.body.citations : null;
            if (!list || !list.length || list.length > 50) throw new AiError(422, 'input.invalid', 'citations: 1-50 items');
            for (const c of list) {
                if (!c || typeof c.source_type !== 'string' || !/^[a-z][a-z0-9_.-]{1,63}$/.test(c.source_type)) throw new AiError(422, 'input.invalid', 'every citation needs a source_type');
                for (const k of ['url', 'title', 'author', 'snippet', 'source_id']) if (c[k] != null && String(c[k]).length > 4000) throw new AiError(422, 'input.invalid', `${k} too long`);
            }
            runs.addCitations(run.id, list.map(c => ({ ...c, ordinal: null, provenance: { ...(c.provenance || {}), attached: true } })), req.principal.sub);
            registry.audit(req.principal.sub, 'run.citations.attach', 'run', run.id, { trace: req.ov.traceId, metadata: { count: list.length } });
            res.status(201).json({ citations: runs.citations(run.id) });
        } catch (err) { sendError(res, err, req.ov, log); }
    });

    // Direct operations — each is a run of workflow ai.<op>, waited for (default: the max wait).
    for (const op of ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'embed']) {
        r.post(`/api/v1/${op}`, create, async (req, res) => {
            try {
                const body = req.body || {};
                const { idempotency_key: idem, target, attribution, on_behalf_of: obo, options, ...input } = body;
                const wait = req.query.wait != null ? Math.max(0, Math.min(Number(req.query.wait) || 0, config.runs.maxWaitMs)) : config.runs.maxWaitMs;
                await createAndRespond(req, res, { workflow: `ai.${op}`, input, idempotency_key: idem, target, attribution, on_behalf_of: obo, options }, wait);
            } catch (err) { sendError(res, err, req.ov, log); }
        });
    }

    return r;
}

module.exports = { runsRouter, sendError };
