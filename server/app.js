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
const ovServe = require('openvibe-shared/serve');
const home = require('./home');
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
    // Browser reads of the two public GETs (/stats, /release.json) only: an exact origin from
    // AI_CORS_ORIGINS is echoed back, never credentials, and OPTIONS answers their preflight.
    // Token (/api/v1/*) and console (/console, /auth/*) routes never reach this branch.
    const publicCorsPaths = new Set(['/stats', '/release.json']);
    const corsOrigins = new Set((config.cors && config.cors.origins) || []);
    app.use((req, res, next) => {
        if (!publicCorsPaths.has(req.path) || (req.method !== 'GET' && req.method !== 'OPTIONS')) return next();
        const origin = req.get('Origin');
        const allowed = Boolean(origin) && corsOrigins.has(origin);
        res.vary('Origin');
        // openvibe-shared/release sends a wildcard ACAO itself: keep the exact-origin decision ours,
        // and let nothing (a rejected origin included) send Access-Control-Allow-Origin.
        const rawSetHeader = res.setHeader.bind(res);
        res.setHeader = (name, value) => {
            if (String(name).toLowerCase() !== 'access-control-allow-origin') return rawSetHeader(name, value);
            return allowed ? rawSetHeader(name, value === '*' ? origin : value) : res;
        };
        if (req.method === 'OPTIONS') {
            res.vary('Access-Control-Request-Method');
            const method = req.get('Access-Control-Request-Method');
            if (allowed && (!method || method === 'GET')) {
                rawSetHeader('Access-Control-Allow-Origin', origin);
                rawSetHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
                rawSetHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
                rawSetHeader('Access-Control-Max-Age', '600');
            }
            return res.sendStatus(204);
        }
        if (allowed) rawSetHeader('Access-Control-Allow-Origin', origin);
        return next();
    });
    // One W3C trace across services (openvibe-shared/trace): calls made while serving a request carry its traceparent.
    require('openvibe-shared/trace').install(app);
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        next();
    });
    // The product home's browser files (the OpenVibe Frame, openvibe-shared/serve) under content-addressed
    // /shared/* URLs from this repo's pinned openvibe-shared; each answer sets its own asset cache policy.
    app.use('/shared', ovServe.handler());
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

    // Discovery for the public home (ai.openvibe.services): the home and the price page are for search engines
    // and assistants; the console, its sign-in and the API are not.
    app.get('/robots.txt', (_req, res) => {
        res.type('text/plain').send(`User-agent: *\nAllow: /$\nAllow: /stats\nDisallow: /console\nDisallow: /auth/\nDisallow: /api/\n\nSitemap: ${config.baseUrl}/sitemap.xml\n`);
    });
    app.get('/sitemap.xml', (_req, res) => {
        res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${['/', '/stats'].map((p) => `  <url><loc>${config.baseUrl}${p}</loc></url>`).join('\n')}\n</urlset>\n`);
    });
    app.get('/llms.txt', (_req, res) => {
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.type('text/plain').send(home.llmsTxt({ siteUrl: config.baseUrl }));
    });

    // GET /: the home page for a browser (server/home.js), the API index for curl and API clients (`*/*`, no
    // Accept, or any non-HTML Accept). Vary: Accept so a shared cache never serves one to the other; the home is
    // private because Cloudflare caches by URL and ignores Vary: Accept. The home carries its own CSP.
    app.get('/', (req, res) => {
        res.vary('Accept');
        if (req.accepts(['text/plain', 'text/html']) === 'text/html') {
            return res.type('html')
                .set('Content-Security-Policy', home.HOME_CSP)
                .set('Cache-Control', 'private, max-age=300')
                .send(home.renderHome({ siteUrl: config.baseUrl }));
        }
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
            'Callers authenticate with OpenVibe.Network tokens (audience openvibe.ai): first-party service tokens, or a',
            'developer app\'s token (ai.app.run) on the six direct operations and GET /api/v1/runs/:id.',
            'Developer apps: https://openvibe.services/projects',
            'AI output is a draft/evidence package attributed to a workflow, model and run, never to a person.',
            '',
            'Source: https://github.com/OpenVibers/OpenVibe.AI',
            '',
        ].join('\n'));
    });

    // Browsers ask for /favicon.ico on their own: the app icon, as SVG.
    app.get('/favicon.ico', (req, res) => res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(require('openvibe-shared/app-icon').favicon({ site: 'ai' })));

    // A browser asking for a page that is not here gets a page; an API client the problem document.
    app.use((req, res) => {
        if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/v1/') && req.accepts(['application/json', 'text/html']) === 'text/html') {
            return res.status(404).type('html').set('Content-Security-Policy', home.HOME_CSP).set('Cache-Control', 'no-store').send(home.renderNotFound());
        }
        return http.sendProblem(res, 404, 'ai.not_found', { detail: `no route ${req.method} ${req.path}`, ctx: req.ov });
    });

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
