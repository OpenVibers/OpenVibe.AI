'use strict';
/** Express app: request context, health/readiness, metrics, the v1 run API and the admin/registry API. */
const path = require('path');
const express = require('express');
const { http } = require('openvibe-contracts');
const { instrument } = require('openvibe-shared/metrics');
const { createRelease } = require('openvibe-shared/release');
const { createAiReadiness, registerAiGauges } = require('./observability');
const { runsRouter } = require('./api/runs');
const { actionsRouter } = require('./api/actions');
const { sendError, providerSecret } = require('./util');
const openapi = require('./openapi');
const { adminRouter } = require('./api/admin');
const { CAPS } = require('./auth');
const { createOps } = require('./ops');
const { consoleRouter } = require('./console');
const { createPersonSessions } = require('./person-session');
const { runPageRouter } = require('./run-pages');
const ovServe = require('openvibe-shared/serve');
const pkg = require('../package.json');

const { adminRoutes } = require('openvibe-shared/config');
const ownerInputs = require('./owner-inputs');

function createApp({ choices = null, searchFetch = null, config, db, registry, pool, quotas, cache, runs, auth, keys, env = process.env, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, log = console, credentials = null, preferences = null, grants = null, vault = null, settings = null, benchEvents = null, runBudgets = null, memory = null, memoryImport = null, memoryServices = null, memorySharing = null, community = null, endpoints = null, webhooks = null, presets = null, receipts = null, balance = null, creditGrants = null, sessionCookies = null, gpus = null, gpuMarket = null, abuse = null, priceBook = null, ownEndpoints = null, refusal = null, willingness = null, abliterationTax = null, batches = null }) {
    const app = express();
    // /.well-known/agent.json (openvibe-shared/agent-layer, SEO-2): what this site serves, for agents.
    require('openvibe-shared/agent-layer').mount(app, { descriptor: require('./agent-descriptor') });
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback');
    const release = createRelease({ service: 'ai', root: path.join(__dirname, '..') });
    const releaseLastmod = release.full().released_at === release.full().booted_at ? undefined : release.full().released_at;
    // HTTP golden signals by route template, process metrics, release_info and the AI gauges;
    // GET /metrics answers direct loopback callers only (Track O).
    const metrics = instrument(app, { service: 'ai', release: release.release });
    app.use(require('openvibe-sdk/service').telemetryMiddleware);   // request telemetry: a no-op until server/index.js calls telemetry.init()
    registerAiGauges(metrics.registry, { runs, registry, pool, balance, creditGrants, gpus, abuse, db });
    app.use(http.middleware());
    // Plan E5: the signed HttpOnly device id and the request's trust metadata on the model and Exchange APIs.
    // The address/device stay in the request: only keyed hashes reach the database (server/abuse/).
    if (abuse) {
        app.use(['/v1', '/api/v1'], abuse.middleware());
        app.use(abuse.router());
    }
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
    // Terms, Privacy and DMCA moved with the human site: /terms, /privacy and /dmca answer 301 to
    // OpenVibe.Exchange's own legal pages (see the page map below).
    // Inline images arrive as data URLs; the per-run input cap is enforced again in runs.create.
    app.use(['/api', '/v1'], express.json({ limit: Math.ceil(config.runs.maxInputBytes * 1.5), type: ['application/json', 'application/*+json'] }));

    app.get('/api/health', (_req, res) => {
        res.json({ status: 'ok', service: 'openvibe-ai', version: pkg.version });
    });

    // Readiness (openvibe-shared/ready): 503 when the database, the workflows or the Network key
    // fail; provider configuration is optional and degrades it (see observability.js).
    const readiness = createAiReadiness({ db, registry, pool, keys, runs, release: release.release });
    app.get('/api/ready', readiness.handler);
    // GET /openapi.json: the public OpenAPI 3.1 document (server/openapi.js); /api/v1/openapi.json redirects here.
    openapi.mount(app);
    // Opaque Exchange keys are admitted only by the platform middleware; management keeps Network auth.
    const baseAppOrCap = auth.appOrCap.bind(auth);
    auth = { ...auth, appOrCap: (...caps) => {
        const guard = baseAppOrCap(...caps);
        return (req, res, next) => { if (req.exchangePrincipal) { req.principal = req.exchangePrincipal; return next(); } return guard(req, res, next); };
    } };
    const exchangePlatform = require('./platform/router').platform({ db, auth, clock, log, credentials, env, searchFetch });
    app.use(exchangePlatform.keyMiddleware);
    app.use(exchangePlatform.router);
    // OpenVibe.Exchange's read API (server/api/exchange.js): the public catalog and aggregate usage. Public on
    // purpose — the site and anyone comparing prices reads the same numbers the router ranks on.
    app.use(require('./api/exchange').exchangeRouter({ config, db, registry, pool, quotas, env, clock, presets, receipts, auth, log, ownEndpoints }));
    // The 18+ board's public read API (server/willing/): the measured willingness rates, the published
    // prompt set, and the abliteration tax. Read-only; plan=1 is the dry run and never calls a provider.
    app.use(require('./api/willing').createWillingRouter({ db, willingness, abliterationTax, log }));
    // A person's own endpoint (the Exchange remake, product line 6): the private rent's person API and its
    // OpenAI-compatible proxy. Only the owner's own Network user token reaches it; a service token never does.
    app.use((req,_res,next) => { if (/^\/api\/v1\/exchange\/deployments(?:\/|$)/.test(req.path)) req.url = req.url.replace('/api/v1/exchange/deployments','/api/v1/own-endpoints'); next(); });
    if (ownEndpoints) app.use(require('./api/own-endpoints').createOwnEndpointsRouter({ endpoints: ownEndpoints, auth, config, clock, log }));
    // The public seller API: a standalone OpenAI-compatible server registered by its own https address with the
    // seller's developer key (the design's SDK gap). Its offers join the community router's trust and ledger.
    if (endpoints) app.use(require('./api/seller').sellerRouter({ endpoints, community, webhooks, auth, log }));
    // Exchange webhooks (the plan's "For builders", item 7): a developer registers an https receiver and reads its
    // delivery log. The signature is the one openvibe-sdk/exchange verifies; the receiver URL goes through the guard.
    if (webhooks) app.use(require('./api/webhooks').webhooksRouter({ webhooks, auth, log }));
    // The half-price batches: many prompts submitted at once, answered later (server/batch/).
    if (batches) app.use(require('./api/batches').batchesRouter({ batches, auth, config, clock, log }));
    // GET /release.json (ADR-016) and POST /release-metrics (open tabs' update reports into /metrics).
    release.mount(app, { registry: metrics.registry });

    // Events → AI (BENCH-11): loopback only, like every service's /internal. Events posts the signed v2
    // delivery; nginx answers 404 for /internal, and a request carrying forwarding headers is not loopback.
    app.use('/internal', (req, res, next) => {
        if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']) {
            return http.sendProblem(res, 404, 'ai.not_found', { ctx: req.ov });
        }
        return next();
    });
    if (benchEvents) app.use(benchEvents.router);

    // D11 owner settings (openvibe-shared/config): Network's admin proxy, acting for the owner, reads and writes
    // ai.exchange, ai.provider_keys and ai.gpus (the GPU provisioner's marketplace keys and its monthly cap). Loopback only (the /internal guard above), guarded by ai.config.manage; the
    // actor is Network's X-OV-Subject (usr_…), and a secret or x-danger change needs X-OV-Fresh: 1.
    if (settings) {
        if (creditGrants) {
            const express = require('express');
            const creditsRouter = express.Router();
            creditsRouter.use(auth.requireCap(CAPS.configManage));
            creditsRouter.get('/', async (req, res) => {
                try { res.json({ providers: await Promise.all(['anthropic', 'openai'].map(async (provider) => ({ provider, grants: await creditGrants.list(provider), estimate: creditGrants.values().find((x) => x.provider === provider) || null, preference: await creditGrants.preference(provider) }))) }); }
                catch (err) { sendError(res, err, req.ov, log); }
            });
            creditsRouter.post('/', async (req, res) => {
                try {
                    const provider = ['anthropic', 'openai'].includes(String(req.body.provider)) ? String(req.body.provider) : 'anthropic';
                    const grant = await creditGrants.add({ ...req.body, provider_key: provider });
                    creditGrants.poll().catch((err) => log.warn(`[ai] credit estimate failed: ${String(err && err.message || err).slice(0, 180)}`));
                    res.status(201).json({ grant });
                } catch (err) { sendError(res, err, req.ov, log); }
            });
            creditsRouter.put('/preference', async (req, res) => {
                try { res.json({ preference: await creditGrants.setPreference({ enabled: req.body.enabled, floor_usd: req.body.floor_usd, provider_key: ['anthropic', 'openai'].includes(String(req.body.provider)) ? String(req.body.provider) : 'anthropic' }) }); }
                catch (err) { sendError(res, err, req.ov, log); }
            });
            app.use('/internal/provider-credits', creditsRouter);
        }
        if (sessionCookies) {
            const express = require('express'); const cookiesRouter = express.Router();
            cookiesRouter.use(auth.requireCap(CAPS.configManage));
            cookiesRouter.get('/', async (req, res) => { try { res.set('Cache-Control', 'no-store').json({ credentials: await sessionCookies.list('operator', 'owner') }); } catch (err) { sendError(res, err, req.ov, log); } });
            cookiesRouter.post('/', async (req, res) => { try { res.status(201).set('Cache-Control', 'no-store').json({ credential: await sessionCookies.add('operator', 'owner', req.body || {}) }); } catch (err) { sendError(res, err, req.ov, log); } });
            cookiesRouter.delete('/:id', async (req, res) => { try { const gone = await sessionCookies.remove('operator', 'owner', req.params.id); res.status(gone ? 204 : 404).end(); } catch (err) { sendError(res, err, req.ov, log); } });
            cookiesRouter.get('/:id/balance', async (req, res) => { try { res.set('Cache-Control', 'no-store').json({ balance: await sessionCookies.balance('operator', 'owner', req.params.id) }); } catch (err) { sendError(res, err, req.ov, log); } });
            app.use('/internal/provider-session-credentials', cookiesRouter);
        }
        const configRoutes = adminRoutes([settings.exchange, settings.providerKeys.proxy, settings.gpus.proxy], {
            basePath: '/internal/config',
            requireAdmin: auth.requireCap(CAPS.configManage),
            actor: (req) => {
                const id = String(req.get('x-ov-subject') || '').trim();
                return /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? { type: 'user', id } : null;
            },
            requireFresh: (req) => String(req.get('x-ov-fresh') || '') === '1',
            log,
        });
        // The Setup tab's Test button (owner-setup design): one cheap authenticated read with the stored key, an answer
        // in one line, never the key (server/owner-inputs.js). Before the config routes, so a Shared
        // release with its own test hook never shadows this one.
        app.use(ownerInputs.testRoute({
            guard: auth.requireCap(CAPS.configManage),
            log,
            now: clock.now,
            resolve: async (namespace, key) => {
                if (namespace === settings.providerKeys.namespace && key.endsWith('.key')) {
                    const provider = await registry.getProvider(key.slice(0, -4));
                    if (!provider || provider.kind === 'stub' || provider.kind === 'whisper' || provider.auth_mode === 'none') return null;
                    const own = require('./vault').get(provider.key);
                    if (own) return { value: own, source: 'vault', provider };
                    const ref = /^env:([A-Z][A-Z0-9_]{0,63})$/.exec(String(provider.secret_ref || ''));
                    const value = providerSecret(provider, env);
                    return { value, source: value ? (ref ? 'env' : 'vault') : null, env: ref ? ref[1] : null, provider };
                }
                if (namespace === settings.gpus.namespace && (key === 'vast.key' || key === 'runpod.key')) {
                    const v = settings.gpus.values();
                    const marketplace = key.slice(0, -4);
                    const value = marketplace === 'vast' ? v.vast_key : v.runpod_key;
                    return { value, source: value ? 'vault' : null, marketplace, origin: marketplace === 'vast' ? v.vast_origin : v.runpod_origin };
                }
                return null;
            },
            run: (namespace, key, value, found) => (found.provider
                ? ownerInputs.testProviderKey(found.provider, value, { fetchImpl })
                : ownerInputs.testGpuKey(found.marketplace, value, { fetchImpl, origin: found.origin })),
        }));
        app.use(configRoutes.handle);
    }

    // Operator actions shared by the admin API and the operator console (one implementation, one audit row).
    const ops = createOps({ db, registry, pool, quotas, cache, runs });
    app.use(runsRouter({ choices, runs, registry, auth, config, log }));
    app.use(actionsRouter({ runs, registry, auth, log }));
    // The OpenAI-compatible endpoint (POST /v1/chat/completions, GET /v1/models): runs of ai.complete.
    app.use(require('./api/routing-preview').routingPreview({ auth, registry, log }));
    app.use(require('./api/openai').openaiRouter({ runs, auth, config, registry, presets, receipts, log }));
    // The Anthropic-compatible endpoint (POST /v1/messages, GET /v1/models): runs of ai.messages (Codes C3).
    app.use(require('./api/messages').messagesRouter({ runs, auth, config, registry, presets, receipts, log }));
    app.use(require('./api/attribution-quotas').attributionQuotasRouter({ db, quotas, auth, clock, sendError: (res, err, ctx) => sendError(res, err, ctx, log) }));
    if (memory) app.use(require('./memory').memoryRouter({ memory, memoryImport, services: memoryServices, sharing: memorySharing, auth, config, clock, log, sendError: (res, err, ctx) => sendError(res, err, ctx, log) }));
    // Memory M5: the uniform share routes for kind memory-store (and /api/v1/share/people, /api/v1/shared-with-me).
    if (memorySharing) app.use(memorySharing.router());
    if (credentials) app.use(require('./credentials').credentialsRouter({ credentials, auth, registry, sendError: (res, err, ctx) => sendError(res, err, ctx, log) }));
    // The budget of a Codes run token (Codes C3): Codes registers it when it mints the token.
    if (runBudgets) app.use(require('./api/run-budgets').runBudgetsRouter({ runBudgets, auth, log, sendError: (res, err, ctx) => sendError(res, err, ctx, log) }));
    // Community capacity (design: "Offer to the network"): the public offers Exchange lists and the seller's /sell
    // dashboard, an API for Exchange. Nothing here writes an offer; the offer belongs to Network and the Link owner.
    if (community) app.use('/api/v1', require('./api/community').communityRouter({ community, auth, log }));
    app.use(adminRouter({ config, db, registry, pool, quotas, cache, runs, auth, settings, ops, log }));
    app.use(require('./api/console-data').consoleDataRouter({ db, registry, pool, quotas, cache, runs, ops, auth, clock, fetchImpl, gpus, gpuMarket, abuse, priceBook, creditGrants, sessionCookies, vault, settings, config, log }));
    // The operator console moved to OpenVibe.Exchange. Keep the legacy AI paths as permanent redirects;
    // run receipts still use the person-session routes below and the AI JSON admin APIs stay here.
    // Person sessions are separate, read-only and open one run receipt each (server/person-session.js).
    const personSessions = createPersonSessions({ db, config, clock });
    // The person's own AI settings (L36 Y1/Y3): their keys under owner `self`, and their routing preferences. Only
    // the person's Network token or their AI site session (same origin) reaches them; a service token is refused.
    if (credentials && preferences && grants) {
        app.use(require('./me').meRouter({ choices, credentials, preferences, grants, auth, registry, config, clock, log, personSessions, sessionCookies, sendError: (res, err, ctx) => sendError(res, err, ctx, log) }));
    }
    // The person's human settings moved to Exchange; keep the JSON API here for first-party clients.
    app.use('/you', (req, res) => res.redirect(301, `${config.exchangeUrl}/privacy/keys${req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''}`));
    app.use('/console', (req, res) => res.redirect(301, `${config.exchangeUrl}${req.originalUrl}`));
    app.get('/auth/login', (req, res) => res.redirect(301, `${config.exchangeUrl}/auth/login${req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''}`));
    // Person sign-in for /runs/:id shares the console SSO router, but the legacy operator pages are intercepted above.
    app.use(consoleRouter({ config, db, registry, env, clock, fetchImpl, log, personSessions }));
    app.use(runPageRouter({ runs, personSessions, log }));

    // ── The public pages moved to OpenVibe.Exchange (2026-11-07) ────
    // ai.openvibe.services keeps the API and a run's receipt. Every human page it used
    // to serve answers 301 to its Exchange home: the page map is exact, an unknown human path goes to the home,
    // and no API path is ever redirected. The site's page list, price page, update log, legal pages and
    // crawl artifacts moved with it.
    const EXCHANGE = config.exchangeUrl;
    const moved = (to) => (_req, res) => res.redirect(301, `${EXCHANGE}${to}`);
    app.get('/', (req, res) => {
        res.vary('Accept');
        const html = req.accepts(['text/plain', 'text/html']) === 'text/html';
        const markdown = req.query.format === 'markdown' || /text\/markdown/i.test(String(req.get('accept') || ''));
        if (html || markdown) {
            res.set('Cache-Control', 'public, max-age=300');
            return res.redirect(301, markdown ? `${EXCHANGE}/index.md` : `${EXCHANGE}/`);
        }
        res.type('text/plain').send([
            'OpenVibe.AI: providers, models, routing, versioned prompt templates and workflows, runs, citations, scoped cache, quotas and audit.',
            '',
            'The public pages (home, prices and latency, the changelog, the FAQ) are OpenVibe.Exchange now:',
            `${EXCHANGE}/`,
            '',
            'POST /api/v1/runs {workflow, input, target?, idempotency_key}   run a workflow (?wait=ms)',
            'GET  /api/v1/runs/:id    POST /api/v1/runs/:id/cancel|retry',
            'POST /api/v1/{chat,generate,summarize,classify,extract,enrich,embed}',
            'GET  /api/v1/workflows | templates | routes | providers | models | quotas | usage | audit',
            'GET  /api/health, /api/ready, /release.json',
            'GET  /runs/:id  your run receipt (OpenVibe.Network sign-in; your own runs only)',
            `GET  ${EXCHANGE}/privacy/keys   your own provider keys and session cookies`,
            `GET  ${EXCHANGE}/console        owner-only AI operator console`,
            '',
            'Callers authenticate with OpenVibe.Network tokens (audience openvibe.ai): first-party service tokens, or a',
            "developer app's token (ai.app.run) on the six direct operations and GET /api/v1/runs/:id.",
            'Developer apps: https://openvibe.services/projects',
            'AI output is a draft/evidence package attributed to a workflow, model and run, never to a person.',
            '',
            'Source: https://github.com/OpenVibers/OpenVibe.AI',
            '',
        ].join('\n'));
    });
    // The exact page map. A Markdown twin points at its Exchange twin, not at the HTML page.
    app.get('/stats', moved('/models'));
    app.get('/updates', moved('/status'));
    app.get('/index.md', moved('/index.md'));
    app.get('/stats.md', moved('/models.md'));
    app.get('/updates.md', moved('/status.md'));
    for (const p of ['/terms', '/privacy', '/dmca', '/sitemap.xml', '/llms.txt', '/llms-full.txt']) app.get(p, moved(p));

    // Discovery: the human site is Exchange, so this origin asks crawlers to leave it alone and names the map
    // that matters. Machine routes (the API, release.json, a run's receipt) are not crawled anyway.
    app.get('/robots.txt', (_req, res) => {
        res.type('text/plain').send(`User-agent: *\nDisallow: /\nDisallow: /runs\nDisallow: /console\nDisallow: /auth/\nDisallow: /api/\n\n# The human site is OpenVibe.Exchange; the API stays here.\nSitemap: ${EXCHANGE}/sitemap.xml\n`);
    });

    // A browser asking for a page that is not here goes to the Exchange home: the human site moved, and a
    // stale link should land on the product, not a 404. An API or session path still answers as it did.
    const MACHINE_PATH = /^\/(?:api|v1|internal|metrics|shared|release\.json|release-metrics|auth|console|runs|favicon\.ico|robots\.txt)(?:\/|$)/;
    app.use((req, res) => {
        if (req.method === 'GET' && !MACHINE_PATH.test(req.path) && req.accepts(['application/json', 'text/html']) === 'text/html') {
            return res.redirect(301, `${EXCHANGE}/`);
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
