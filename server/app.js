'use strict';
/** Express app: request context, health/readiness, metrics, the v1 run API and the admin/registry API. */
const path = require('path');
const express = require('express');
const { http } = require('openvibe-contracts');
const { instrument } = require('openvibe-shared/metrics');
const { createRelease } = require('openvibe-shared/release');
const { createAiReadiness, registerAiGauges } = require('./observability');
const { runsRouter } = require('./api/runs');
const { sendError } = require('./util');
const { adminRouter } = require('./api/admin');
const { createOps } = require('./ops');
const { consoleRouter } = require('./console');
const views = require('./console/views');
const cachePolicy = require('openvibe-shared/cache-policy');
const pkg = require('../package.json');

function createApp({ config, db, registry, pool, quotas, cache, runs, auth, keys, env = process.env, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, log = console, credentials = null }) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback');
    const release = createRelease({ service: 'ai', root: path.join(__dirname, '..') });
    // HTTP golden signals by route template, process metrics, release_info and the AI gauges;
    // GET /metrics answers direct loopback callers only (Track O).
    const metrics = instrument(app, { service: 'ai', release: release.release });
    registerAiGauges(metrics.registry, { runs, registry, pool });
    app.use(http.middleware());
    // One W3C trace across services (openvibe-shared/trace): calls made while serving a request carry its traceparent.
    require('openvibe-shared/trace').install(app);
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

    // Readiness (openvibe-shared/ready): 503 when the database, the workflows or the Network key
    // fail; provider configuration is optional and degrades it (see observability.js).
    const readiness = createAiReadiness({ db, registry, pool, keys, runs, release: release.release });
    app.get('/api/ready', readiness.handler);
    // GET /release.json (ADR-016) and POST /release-metrics (open tabs' update reports into /metrics).
    release.mount(app, { registry: metrics.registry });

    // Operator actions shared by the admin API and the operator console (one implementation, one audit row).
    const ops = createOps({ db, registry, pool, quotas, cache, runs });
    app.use(runsRouter({ runs, registry, auth, config, log }));
    app.use(require('./api/attribution-quotas').attributionQuotasRouter({ db, quotas, auth, clock, sendError: (res, err, ctx) => sendError(res, err, ctx, log) }));
    if (credentials) app.use(require('./credentials').credentialsRouter({ credentials, auth, registry, sendError: (res, err, ctx) => sendError(res, err, ctx, log) }));
    app.use(adminRouter({ db, registry, pool, quotas, cache, runs, auth, ops, log }));
    // The operator console (/console, /auth/*): Network staff, server-rendered, no scripts (server/console).
    app.use(consoleRouter({ config, db, registry, pool, quotas, cache, runs, ops, env, clock, fetchImpl, log }));

    // Public price and latency (no sign-in, no scripts): provider_stats_daily totals and the rate cards,
    // nothing per caller. Only registered providers are listed: a person's own key records its runs as
    // byo:<owner>:<subject>, which must never reach a public page.
    const STATS_DAYS = 7;
    app.get('/stats', async (req, res, next) => {
        try {
            const now = clock.now();
            const rows = [];
            for (const s of await quotas.statsFor({ days: STATS_DAYS })) {
                const p = await registry.getProvider(s.provider);
                if (!p) continue;
                const m = s.model ? await registry.getModel(s.provider, s.model) : null;
                rows.push({
                    provider: s.provider, model: s.model, capability: (m && m.type) || p.capabilities.join(', '),
                    requests: Number(s.requests) || 0, ok: Number(s.ok) || 0, p50: s.latency_p50_ms, p95: s.latency_p95_ms,
                    cards: await pool.rateCardsFor(s.provider, s.model || null),
                });
            }
            res.setHeader('Cache-Control', cachePolicy.htmlHeaders());
            res.setHeader('Content-Security-Policy', views.CSP);
            res.type('html').send(views.pages.stats({
                days: STATS_DAYS, rows,
                from: new Date(now - STATS_DAYS * 86400000).toISOString().slice(0, 10), to: new Date(now).toISOString().slice(0, 10),
            }));
        } catch (e) { next(e); }
    });

    // Crawlers: nothing here is for search engines, the console and sign-in least of all (no sitemap either).
    app.get('/robots.txt', (_req, res) => {
        res.type('text/plain').send('User-agent: *\nDisallow: /console\nDisallow: /auth/\nDisallow: /api/\n');
    });

    app.get('/', (_req, res) => {
        res.type('text/plain').send([
            'OpenVibe.AI: providers, models, routing, versioned prompt templates and workflows, runs, citations, scoped cache, quotas and audit.',
            '',
            'POST /api/v1/runs {workflow, input, target?, idempotency_key}   run a workflow (?wait=ms)',
            'GET  /api/v1/runs/:id    POST /api/v1/runs/:id/cancel|retry',
            'POST /api/v1/{chat,generate,summarize,classify,extract,enrich,embed}',
            'GET  /api/v1/workflows | templates | routes | providers | models | quotas | usage | audit',
            'GET  /api/health, /api/ready, /release.json',
            'GET  /stats      price and latency per provider and model (public)',
            'GET  /console    the operator console (OpenVibe.Network staff sign-in)',
            '',
            'Callers authenticate with OpenVibe.Network service tokens (audience openvibe.ai).',
            'AI output is a draft/evidence package attributed to a workflow, model and run, never to a person.',
            '',
            'Source: https://github.com/OpenVibers/OpenVibe.AI',
            '',
        ].join('\n'));
    });

    app.use((req, res) => http.sendProblem(res, 404, 'ai.not_found', { detail: `no route ${req.method} ${req.path}`, ctx: req.ov }));

    // AI's own codes for a miss and a bad body (openvibe-sdk/service jsonErrors() would answer not_found and
    // request.invalid_json); everything else goes through sendError (openvibe-sdk/service): 500 ai.internal.
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        if (err.type === 'entity.parse.failed') return http.sendProblem(res, 400, 'input.bad_json', { detail: 'request body is not valid JSON', ctx: req.ov });
        if (err.type === 'entity.too.large') return http.sendProblem(res, 413, 'input.too_large', { detail: 'request body too large', ctx: req.ov });
        if (res.headersSent) { log.error(`[app] ${req.method} ${req.path}: ${err.stack || err}`); return res.end(); }
        return sendError(res, { stack: `${req.method} ${req.path}: ${err.stack || err}` }, req.ov, log);   // never the error's own status: a 500
    });

    app.locals.metrics = metrics;
    return app;
}

module.exports = { createApp };
