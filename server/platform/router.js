'use strict';
const express = require('express');
const { CAPS } = require('../auth');
const { AiError, sendError } = require('../util');
const { createKeys } = require('./keys');
const { claimRequest } = require('./idempotency');
const { createSearch, CHARGE } = require('../search');
const { usdOf } = require('../search/rate-cards');
const { createAssetEvents } = require('../search/events');
function platform({ db, auth, clock, log, searchFetch, credentials, registry, env = process.env, publicBase }) {
    const keys = createKeys({ db, clock });
    const presets = require('../exchange/compat-presets').createCompatPresets(db);
    const search = createSearch({
        ...(searchFetch ? { fetchImpl: searchFetch } : {}),
        now: () => clock.now(), credentials, registry, env,
        events: createAssetEvents({ db, clock }),
        ...(publicBase ? { publicBase } : {}),
        // The versioned rate cards live in the database (plan §W.2 step 3).
        db,
    });
    const r = express.Router();
    const wrap = (fn) => async (req, res) => {
        try {
            res.set('Cache-Control', 'no-store');
            const out = await fn(req, res);
            if (out !== undefined) res.json(out);
        } catch (e) {
            if (e[CHARGE] != null) res.locals.searchCharge = e[CHARGE];
            sendError(res, e, req.ov, log);
        }
    };
    const person = auth.personOrCap(CAPS.runCreate);
    const owner = (req) => {
        if (req.principal?.kind !== 'user')
            throw new AiError(
                403,
                'ai.denied',
                'A person must manage their own keys',
            );
        return req.principal.subject.id;
    };
    r.get(
        '/api/v1/exchange/keys',
        person,
        wrap((req) => keys.list(owner(req)).then((keys) => ({ keys }))),
    );
    r.post(
        '/api/v1/exchange/keys',
        person,
        wrap((req, res) => {
            res.status(201);
            return keys.create(owner(req), req.body || {});
        }),
    );
    r.delete(
        '/api/v1/exchange/keys/:id',
        person,
        wrap((req) => keys.revoke(owner(req), req.params.id)),
    );
    r.get(
        '/api/v1/exchange/key-usage',
        person,
        wrap((req) => keys.usage(owner(req))),
    );
    r.get('/api/v1/exchange/presets', person, wrap(async req => ({ data: await presets.list(owner(req)) })));
    r.post('/api/v1/exchange/presets', person, wrap(req => presets.put(owner(req), req.body)));
    r.post('/v1/presets/import', person, wrap(req => presets.put(owner(req), req.body)));
    r.delete('/api/v1/exchange/presets/:name', person, wrap(req => presets.remove(owner(req), req.params.name)));
    const searchContext = req => ({
        subject: req.principal?.kind === 'user' ? req.principal.subject.id : null,
        plan: req.searchPlan, budget: req.searchBudget,
    });
    r.get('/api/v1/exchange/search/engines', wrap(async () =>
        ({ engines: await search.engines() })),
    );
    const allow = auth.appOrCap(CAPS.appRun, CAPS.runCreate);
    // The icon reference search takes one more first-party service capability: exchange.search.icons,
    // held by OpenVibe.Design. It opens only this route and never web, image or fetch search.
    const allowIcons = auth.appOrCap(CAPS.appRun, CAPS.runCreate, CAPS.exchangeSearchIcons);
    const searchWindows = new Map();
    const searchLimit = (req, res, next) => {
        const id = req.principal?.subject?.id || req.principal?.sub;
        const now = clock.now();
        for (const [key, value] of searchWindows)
            if (value.until <= now) searchWindows.delete(key);
        const entry = searchWindows.get(id) || { until: now + 60000, count: 0 };
        if (entry.count >= 60) {
            res.locals.searchCharge = 0;
            return res
                .status(429)
                .json({ error: 'Search limit reached; try again in a minute' });
        }
        entry.count++;
        searchWindows.set(id, entry);
        next();
    };
    // A service calling with exchange.search.icons alone (Design) gets its own minute bucket and its own
    // limit, separate from people and from services that hold ai.run.create.
    const iconService = (req) =>
        Array.isArray(req.principal?.cap) &&
        req.principal.cap.includes(CAPS.exchangeSearchIcons) &&
        !req.principal.cap.includes(CAPS.appRun) &&
        !req.principal.cap.includes(CAPS.runCreate);
    const iconWindows = new Map();
    const iconRpm = Math.max(1, Number(env.AI_EXCHANGE_ICONS_RPM) || 60);
    const iconLimit = (req, res, next) => {
        if (!iconService(req)) return searchLimit(req, res, next);
        const id = req.principal?.sub || 'unknown';
        const now = clock.now();
        for (const [key, value] of iconWindows)
            if (value.until <= now) iconWindows.delete(key);
        const entry = iconWindows.get(id) || { until: now + 60000, count: 0 };
        if (entry.count >= iconRpm) {
            res.locals.searchCharge = 0;
            return res
                .status(429)
                .json({ error: 'Icon search limit reached; try again in a minute' });
        }
        entry.count++;
        iconWindows.set(id, entry);
        next();
    };
    for (const kind of ['web', 'images'])
        r.post(
            '/v1/search' + (kind === 'web' ? '' : '/' + kind),
            allow,
            searchLimit,
            wrap(async (req) => search.search(kind, req.body || {}, searchContext(req))),
        );
    r.post(
        '/v1/search/reverse-image',
        allow,
        searchLimit,
        wrap(async (req) => search.search('reverse_image', req.body || {}, searchContext(req))),
    );
    // Unsplash's required download event, once per person and photo (the claim is the idempotency key).
    r.post(
        '/v1/search/images/unsplash/download',
        allow,
        searchLimit,
        wrap(async (req) => search.trackDownload(req.body || {}, { subject: req.principal?.kind === 'user' ? req.principal.subject.id : null })),
    );
    // Pixabay's terms forbid permanent hotlinking: a short-lived cache proxy, not its CDN, is what results use.
    r.get(
        '/v1/search/images/pixabay/:id',
        wrap(async (req, res) => {
            const image = await search.pixabayImage(req.params.id);
            res.set('Cache-Control', 'private, max-age=3600');
            res.set('Content-Type', image.type);
            res.send(image.body);
        }),
    );
    r.post(
        '/v1/search/icons',
        allowIcons,
        iconLimit,
        wrap(async (req) => search.search('icons', req.body || {}, searchContext(req))),
    );
    r.post(
        '/v1/fetch',
        allow,
        searchLimit,
        wrap((req) => search.read(req.body || {}, searchContext(req))),
    );
    // Exchange keys only enter inference and the search surface. They never authorize management routes.
    async function keyMiddleware(req, res, next) {
        const token = String(req.headers.authorization || '').replace(
            /^Bearer /,
            '',
        );
        if (!token.startsWith('ovx_')) return next();
        let claim = null;
        try {
            const isSearch =
                req.method === 'POST' &&
                [
                    '/v1/search',
                    '/v1/search/images',
                    '/v1/search/icons',
                    '/v1/search/reverse-image',
                    '/v1/search/images/unsplash/download',
                    '/v1/fetch',
                ].includes(req.path);
            const inference =
                req.method === 'POST' && ['/v1/chat/completions', '/v1/messages', '/v1/completions', '/v1/embeddings', '/v1/images/generations'].includes(req.path);
            const models = req.method === 'GET' && ['/v1/models', '/v1/generation'].includes(req.path);
            if (!isSearch && !inference && !models)
                throw new AiError(
                    403,
                    'exchange.key_scope',
                    'This key only authorizes model and search calls',
                );
            const key = await keys.resolve(token);
            if (!key)
                throw new AiError(
                    401,
                    'token.invalid',
                    'Invalid, expired or revoked Exchange key',
                );
            if (inference) req.body = await presets.expand(key.owner, req.body || {}, req.path === '/v1/messages' ? 'messages' : 'openai');
            if (inference) require('../exchange/compat-routing').request(req.body || {});
            const allowed = JSON.parse(key.allowed_models);
            if (inference && allowed.length && [req.body?.model || req.body?.models?.[0] || 'openvibe/auto', ...(req.body?.models || [])].some(model => !allowed.includes(require('../exchange/compat-routing').modelName(model).model)))
                throw new AiError(403, 'exchange.model_denied', 'This model is not allowed by this key');
            if (inference && req.get('idempotency-key'))
                claim = await claimRequest(db, key.owner, req.get('idempotency-key'), req.path === '/v1/chat/completions' ? req.body : { path: req.path, body: req.body });
            // The Unsplash download event is an allowed search-key action but has no engine plan or ceiling.
            const planned = isSearch && req.path !== '/v1/search/images/unsplash/download';
            if (planned) {
                const kind = req.path === '/v1/fetch' ? 'fetch'
                    : req.path === '/v1/search/reverse-image' ? 'reverse_image'
                    : req.path.split('/')[3] || 'web';
                req.searchPlan = await search.prepare(kind, req.body || {}, { subject: key.owner });
            }
            const searchCeiling = req.searchPlan?.ceiling || 0;
            const hold = models || claim?.replay ? null : await keys.reserve(
                key, isSearch ? 'search:' + req.path : require('../exchange/compat-routing').modelName(req.body?.model || req.body?.models?.[0] || 'openvibe/auto').model,
                isSearch ? (planned ? searchCeiling === 0 : true) : false,
                planned ? searchCeiling : isSearch ? 0 : Number.isFinite(req.body?.max_cost_usd) ? req.body.max_cost_usd : null,
                isSearch,
            );
            if (planned) {
                req.searchBudget = hold.amount;
                // The reserve each engine holds is its rate card's ceiling, in exact nano-USD.
                const minimum = Math.min(...req.searchPlan.candidates.map(c => c.own ? 0 : usdOf(c.ceilingNano)));
                if (hold.amount + 1e-12 < minimum) {
                    await hold.settle({ cost_usd: 0 });
                    throw new AiError(429, 'exchange.key_cap', 'The remaining key cap cannot cover this search');
                }
            }
            if (inference && !(claim?.replay && claim.maxCost === null)) {
                req.body.max_cost_usd = claim?.replay ? claim.maxCost : Math.min(
                    hold.amount,
                    Number.isFinite(req.body.max_cost_usd)
                        ? req.body.max_cost_usd
                        : hold.amount,
                );
                if (claim && !claim.replay) {
                    try { await claim.admitted(req.body.max_cost_usd); }
                    catch (err) { await hold.settle({ cost_usd: 0 }); throw err; }
                }
            }
            req.exchangePrincipal = {
                kind: 'user',
                sub: key.owner,
                subject: { type: 'user', id: key.owner },
                ns: ['ai.*'],
                claims: {},
                exchangeKeyId: key.id,
            };
            if (hold) {
                let completed = false;
                let result = null,
                    tail = '';
                const json = res.json.bind(res);
                res.json = (v) => {
                    result = v;
                    return json(v);
                };
                const write = res.write.bind(res);
                res.write = (chunk, ...args) => {
                    tail = (tail + String(chunk)).slice(-65536);
                    return write(chunk, ...args);
                };
                // 'close' without 'finish' is a client that hung up: the hold still settles (at the hold, when
                // the cost is unknown), or the key would keep it until the month ends.
                const done = () => {
                    if (completed) return;
                    completed = true;
                    if (!result && tail)
                        for (const line of tail
                            .split('\n')
                            .filter((l) => l.startsWith('data: '))) {
                            try {
                                const v = JSON.parse(line.slice(6));
                                if (v.usage)
                                    result = { ...result, usage: v.usage };
                                if (v.x_openvibe) result = { ...result, ...v };
                            } catch {}
                        }
                    const usage = result?.usage || {};
                    const cost =
                        isSearch ? result?.[CHARGE] ?? res.locals.searchCharge
                            : res.getHeader('x-openvibe-replayed') === '1' && res.statusCode < 400
                                ? 0 : result?.x_openvibe?.cost_usd ?? res.locals.inferenceCharge ?? (!res.locals.inferenceAdmitted && res.writableFinished && res.statusCode < 500 && res.statusCode >= 400 ? 0 : undefined);
                    // Search uses only its own charge, never inference metadata.
                    // An early disconnect can precede run insertion. Keep its claim
                    // until a response finishes so a retry cannot take another hold.
                    hold.settle({
                        cost_usd: cost,
                        tokens_in: usage.prompt_tokens || usage.input_tokens || 0,
                        tokens_out: usage.completion_tokens || usage.output_tokens || 0,
                    }).then(() => res.writableFinished ? claim?.abandon?.() : undefined).catch(() =>
                        log.error('Exchange usage settlement failed'),
                    );
                };
                res.once('finish', done);
                res.once('close', done);
            }
            next();
        } catch (e) {
            if (claim && !claim.replay) await claim.abandon().catch(() => log.error('Exchange request cleanup failed'));
            sendError(res, e, req.ov, log);
        }
    }
    return { router: r, keyMiddleware };
}
module.exports = { platform };
