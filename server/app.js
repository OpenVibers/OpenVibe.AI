'use strict';
/** Express app: request context, health/readiness, the v1 run API and the admin/registry API. */
const express = require('express');
const { http } = require('openvibe-contracts');
const { runsRouter } = require('./api/runs');
const { adminRouter } = require('./api/admin');
const pkg = require('../package.json');

function createApp({ config, db, registry, pool, quotas, cache, runs, auth, keys, log = console }) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback');
    app.use(http.middleware());
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        next();
    });
    // Inline images arrive as data URLs; the per-run input cap is enforced again in runs.create.
    app.use('/api', express.json({ limit: Math.ceil(config.runs.maxInputBytes * 1.5), type: ['application/json', 'application/*+json'] }));

    app.get('/api/health', (_req, res) => {
        res.json({ status: 'ok', service: 'openvibe-ai', version: pkg.version });
    });

    app.get('/api/ready', (_req, res) => {
        let dbOk = false;
        try { dbOk = db.prepare('SELECT 1 AS x').get().x === 1; } catch { dbOk = false; }
        const checks = { db: dbOk, key: keys.loaded(), workflows: dbOk && registry.listWorkflows().length > 0 };
        const ready = Object.values(checks).every(Boolean);
        const providers = dbOk ? registry.listProviders().map(p => ({ key: p.key, kind: p.kind, status: p.status, health: pool.health(p.key).state })) : [];
        res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks, providers, inflight: runs.inflight.size });
    });

    app.use(runsRouter({ runs, registry, auth, config, log }));
    app.use(adminRouter({ db, registry, pool, quotas, cache, runs, auth, log }));

    app.get('/', (_req, res) => {
        res.type('text/plain').send([
            'OpenVibe.AI: providers, models, routing, versioned prompt templates and workflows, runs, citations, scoped cache, quotas and audit.',
            '',
            'POST /api/v1/runs {workflow, input, target?, idempotency_key}   run a workflow (?wait=ms)',
            'GET  /api/v1/runs/:id    POST /api/v1/runs/:id/cancel|retry',
            'POST /api/v1/{chat,generate,summarize,classify,extract,enrich,embed}',
            'GET  /api/v1/workflows | templates | routes | providers | models | quotas | usage | audit',
            'GET  /api/health, /api/ready',
            '',
            'Callers authenticate with OpenVibe.Network service tokens (audience openvibe.ai).',
            'AI output is a draft/evidence package attributed to a workflow, model and run, never to a person.',
            '',
            'Source: https://github.com/OpenVibers/OpenVibe.AI',
            '',
        ].join('\n'));
    });

    app.use((req, res) => http.sendProblem(res, 404, 'ai.not_found', { detail: `no route ${req.method} ${req.path}`, ctx: req.ov }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        if (err.type === 'entity.parse.failed') return http.sendProblem(res, 400, 'input.bad_json', { detail: 'request body is not valid JSON', ctx: req.ov });
        if (err.type === 'entity.too.large') return http.sendProblem(res, 413, 'input.too_large', { detail: 'request body too large', ctx: req.ov });
        log.error(`[app] ${req.method} ${req.path}: ${err.stack || err}`);
        if (res.headersSent) return res.end();
        return http.sendProblem(res, 500, 'ai.internal', { detail: 'internal error', ctx: req.ov });
    });

    return app;
}

module.exports = { createApp };
