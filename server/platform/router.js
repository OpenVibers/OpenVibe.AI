'use strict';
const express = require('express');
const { CAPS } = require('../auth');
const { AiError, sendError } = require('../util');
const { createKeys } = require('./keys');
const { claimRequest } = require('./idempotency');
const { createSearch } = require('../search');
function platform({ db, auth, clock, log, searchFetch }) {
    const keys = createKeys({ db, clock });
    const search = createSearch({
        ...(searchFetch ? { fetchImpl: searchFetch } : {}),
        now: () => clock.now(),
    });
    const r = express.Router();
    const wrap = (fn) => async (req, res) => {
        try {
            res.set('Cache-Control', 'no-store');
            const out = await fn(req, res);
            if (out !== undefined) res.json(out);
        } catch (e) {
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
    r.get('/api/v1/exchange/search/engines', (_req, res) =>
        res.json({ engines: search.engines() }),
    );
    const allow = auth.appOrCap(CAPS.appRun, CAPS.runCreate);
    const searchWindows = new Map();
    const searchLimit = (req, res, next) => {
        const id = req.principal?.subject?.id || req.principal?.sub;
        const now = clock.now();
        for (const [key, value] of searchWindows)
            if (value.until <= now) searchWindows.delete(key);
        const entry = searchWindows.get(id) || { until: now + 60000, count: 0 };
        if (entry.count >= 60)
            return res
                .status(429)
                .json({ error: 'Search limit reached; try again in a minute' });
        entry.count++;
        searchWindows.set(id, entry);
        next();
    };
    for (const kind of ['web', 'images', 'icons'])
        r.post(
            '/v1/search' + (kind === 'web' ? '' : '/' + kind),
            allow,
            searchLimit,
            wrap(async (req) => search.search(kind, req.body || {})),
        );
    r.post(
        '/v1/fetch',
        allow,
        searchLimit,
        wrap((req) => search.read(req.body?.url)),
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
                    '/v1/fetch',
                ].includes(req.path);
            const inference =
                req.method === 'POST' && req.path === '/v1/chat/completions';
            const models = req.method === 'GET' && req.path === '/v1/models';
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
            const allowed = JSON.parse(key.allowed_models);
            if (inference && allowed.length && !allowed.includes(req.body?.model))
                throw new AiError(403, 'exchange.model_denied', 'This model is not allowed by this key');
            if (inference && req.get('idempotency-key'))
                claim = await claimRequest(db, key.owner, req.get('idempotency-key'), req.body);
            const hold = models || claim?.replay
                ? null
                : await keys.reserve(
                      key,
                      isSearch
                          ? 'search:' + req.path
                          : String(req.body?.model || ''),
                      isSearch,
                      Number.isFinite(req.body?.max_cost_usd) ? req.body.max_cost_usd : null,
                  );
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
                        (isSearch || res.getHeader('x-openvibe-replayed') === '1') && res.statusCode < 400
                            ? 0
                            : result?.x_openvibe?.cost_usd;
                    // An early disconnect can precede run insertion. Keep its claim
                    // until a response finishes so a retry cannot take another hold.
                    hold.settle({
                        cost_usd: cost,
                        tokens_in: usage.prompt_tokens || 0,
                        tokens_out: usage.completion_tokens || 0,
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
