'use strict';
/**
 * Public Exchange catalog and usage, saved routing presets, and per-run receipts.
 * Presets and receipt reads use authenticated routes below.
 */
/**
 * OpenVibe.Exchange's read API: the public catalog, one model, and aggregate usage.
 *
 *   GET /api/v1/exchange/catalog                 every model, its offers, prices, speed and uptime
 *   GET /api/v1/exchange/price-changes           the price changelog: what a price was and what it became
 *   GET /api/v1/exchange/models/:slug            one model ("deepseek/deepseek-chat", or org + model)
 *   GET /api/v1/exchange/usage?days=30           requests, tokens and spend by day, model and product
 *
 * No token: everything here is public on openvibe.exchange (the site, and anyone comparing prices).
 * Nothing is per person, and no provider secret, base URL or metadata leaves the catalog shape in
 * server/exchange/catalog.js. The answers are cached in this process for half a minute, so a busy
 * Exchange does not scan the stats table per page view.
 */
const express = require('express');
const { CAPS } = require('../auth');
const { AiError, sendError } = require('../util');
const { http } = require('openvibe-contracts');
const { createCatalog, KINDS: catalogKinds } = require('../exchange/catalog');
const { createUsage } = require('../exchange/usage');

const CATALOG_MS = 30_000;

function memo(fn, ttlMs, clock) {
    let hit = { at: 0, value: null };
    return async () => {
        if (hit.value && clock.now() - hit.at < ttlMs) return hit.value;
        const value = await fn();
        hit = { at: clock.now(), value };
        return value;
    };
}

function exchangeRouter({ db, registry, pool, quotas = null, env = process.env, clock = { now: () => Date.now() }, config = null, presets, receipts, auth, log = console, ownEndpoints = null, fetchImpl = globalThis.fetch, fidelity = null, share = null }) {
    // Bench's provider-fidelity read (stage B5): optional and fail-soft. Off in tests, where no Bench runs.
    const fidelitySource = fidelity || require('../exchange/fidelity').createFidelitySource({
        url: config && config.bench ? config.bench.url : null, fetchImpl, clock, log,
        timeoutMs: 2500, enabled: !config || config.nodeEnv !== 'test',
    });
    const catalog = createCatalog({ db, registry, pool, env, clock, config, fidelity: fidelitySource });
    const trafficShare = share || require('../exchange/share').createShare({
        db, clock, log, k: config && config.trafficShare ? config.trafficShare.k : 20,
    });
    const usage = createUsage({ db, clock });
    // The price book's log: what a price was, what it became and when it was read.
    const priceStore = require('../pricebook/store').createPriceStore({ db, clock });
    // One cached read per kind (?kind=chat, screenshot, …); the unfiltered read is the full catalog.
    const hits = new Map();
    const allFor = (kind) => {
        const key = kind || '';
        if (!hits.has(key)) hits.set(key, memo(() => catalog.models({ days: 7, kind: kind || null }), CATALOG_MS, clock));
        return hits.get(key)();
    };
    const all = () => allFor(null);
    const market = require('../exchange/market').createMarket({ db, registry, catalog: all, config, clock, fidelity: fidelitySource });
    const usageByWindow = new Map();
    const r = express.Router();
    r.use(require('./measured-metrics').measuredMetricsRouter({ db, clock, log }));

    const publicCache = (seconds) => (req, res, next) => { res.set('Cache-Control', `public, max-age=${seconds}`); next(); };

    // A caller that may run may read the presets; the same guard writes them (a preset is the caller's own).
    const read = auth.appOrCap(CAPS.appRun, CAPS.runCreate, CAPS.runRead);
    const write = auth.appOrCap(CAPS.appRun, CAPS.runCreate);
    const usageRead = auth.requireCap(CAPS.usageRead);
    const wrap = (fn) => async (req, res) => { try { const out = await fn(req, res); if (out !== undefined) res.json(out); } catch (err) { sendError(res, err, req.ov, log); } };
    const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
    const effortAnalytics = require('../effort/analytics').createAnalytics({ db, catalog, registry, pool, clock });
    r.get('/api/v1/exchange/estimate', publicCache(30), wrap(req => effortAnalytics.estimate(req.query)));
    r.get('/api/v1/me/ladders/:id', read, wrap(req => effortAnalytics.ladder(req.params.id, req.principal)));

    /** The owner a preset belongs to: the app's project, else the person the token acts for, else the service. */
    const ownerOf = (req) => {
        const owners = presets.ownersOf(req.principal);
        return owners[0] || null;
    };
    /**
     * A service acting for a person or a project (the Exchange's own switch on a person's keys): `on_behalf_of`
     * names them in the body or the query, as `{ type, id }` or as a bare id. A person's own token never names
     * someone else.
     */
    const ownerOfRequest = (req, b) => {
        const raw = (b && b.on_behalf_of) || req.query.on_behalf_of;
        if (!raw) return null;
        const id = typeof raw === 'object' ? raw.id : raw;
        const type = typeof raw === 'object' && raw.type ? String(raw.type) : (/^prj_/.test(String(id || '')) ? 'project' : 'user');
        if (!id) throw new AiError(422, 'ai.invalid', 'on_behalf_of must name a person (usr_…) or a project (prj_…)');
        if (type === 'project') {
            if (!/^prj_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id))) throw new AiError(422, 'ai.invalid', 'on_behalf_of must name a project (prj_…)');
            return mayActFor(req, { type: 'project', id: String(id) });
        }
        if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id))) throw new AiError(422, 'ai.invalid', 'on_behalf_of must name a person (usr_…)');
        return mayActFor(req, { type: 'user', id: String(id) });
    };

    /**
     * Only a first-party service token (requireCap's principal has no kind) names whom it acts for. A person, an
     * app or a developer key may name only an owner it already is (presets.ownersOf): never another person, and
     * never a project it merely knows the id of.
     */
    const mayActFor = (req, target) => {
        const p = req.principal || {};
        if (!p.kind) return target;
        const mine = presets.ownersOf(p);
        if (mine.some((o) => o.type === target.type && o.id === target.id)) return target;
        throw new AiError(403, 'capability.denied', 'a preset belongs to its own person or project; this token may not name that one');
    };

    /** Every preset a target may name: its own rows first, then the built-in ones it does not shadow. */
    const presetsForOwner = async (owner) => {
        const own = await presets.list(owner);
        const seen = new Set(own.map((p) => p.name));
        return [...own, ...presets.builtins().filter((x) => !seen.has(x.name))];
    };

    if (presets) {
        r.get('/api/v1/presets', read, wrap(async (req) => {
            const owner = ownerOfRequest(req);
            if (owner) return { presets: await presetsForOwner(owner) };
            return { presets: await presets.visible(req.principal) };
        }));
        r.post('/api/v1/presets', write, wrap(async (req, res) => {
            const b = body(req);
            const owner = ownerOfRequest(req, b) || ownerOf(req);
            if (!owner) throw new AiError(422, 'ai.invalid', 'a preset belongs to an account or a project');
            const preset = await presets.put({ owner, name: b.name, policy: b.policy });
            res.status(201);
            return { preset };
        }));
        r.delete('/api/v1/presets/:name', write, wrap(async (req) => {
            const owner = ownerOfRequest(req, body(req)) || ownerOf(req);
            if (!owner) throw new AiError(422, 'ai.invalid', 'a preset belongs to an account or a project');
            return presets.remove({ owner, name: req.params.name });
        }));
    }

    if (receipts) {
        // The receipt is read at the address the plan names (/v1/receipts/:id, beside the OpenAI-compatible
        // routes) and at the documented one (/api/v1/receipts/:id): the same answer either way.
        const readReceipt = wrap(async (req) => {
            const receipt = await receipts.get(req.params.id);
            if (!receipt) throw new AiError(404, 'ai.receipt_not_found', `no receipt ${req.params.id}`);
            // The receipt belongs to the run that made it: its requester, the person it was for, or whoever
            // may read the usage.
            const p = req.principal;
            const subject = p.subject || {};
            const ob = p.onBehalfOf || (p.claims && p.claims.on_behalf_of);
            const obId = ob && typeof ob === 'object' ? ob.id : ob;
            const owner = receipt.owner || {};
            const requester = receipt.requester || {};
            const allowed = auth.principalHas(req, CAPS.usageRead)
                || (requester.type === subject.type && requester.id === subject.id)
                || (receipt.requester_type === subject.type && receipt.requester_id === subject.id)
                || (owner.type === 'user' && obId && String(owner.id) === String(obId));
            if (!allowed) throw new AiError(404, 'ai.receipt_not_found', `no receipt ${req.params.id}`);
            return { receipt };
        });
        r.get('/v1/receipts/:id', read, readReceipt);
        r.get('/api/v1/receipts/:id', read, readReceipt);
    }

    r.get('/api/v1/exchange/market', publicCache(60), async (req, res, next) => {
        try {
            // Validate before fetching or caching upstream data.
            require('../exchange/market').pageMarket({ offers: [] }, req.query);
        } catch (error) {
            return http.sendProblem(res, 422, 'exchange.market_filter_invalid', { detail: error.message, ctx: req.ov });
        }
        try { res.json(await market.read(req.query)); } catch (error) { next(error); }
    });

    r.get('/api/v1/exchange/catalog', publicCache(30), async (req, res, next) => {
        try {
            const kind = req.query.kind == null || req.query.kind === '' ? null : String(req.query.kind).toLowerCase();
            if (kind && !catalogKinds.includes(kind)) {
                return http.sendProblem(res, 422, 'exchange.kind_invalid', { detail: `kind must be one of ${catalogKinds.join(', ')}`, ctx: req.ov });
            }
            res.json(await allFor(kind));
        } catch (err) { next(err); }
    });

    r.get('/api/v1/exchange/directory', publicCache(60), wrap(async () =>
        require('../exchange/directory').directoryModels(registry)));

    // Your own endpoint: whether it is on and, when it is off, the plain reason. Public: the Exchange page
    // reads it before anyone signs in, and nothing here is per person.
    // Public, non-personal, read-only previews. Cache each model/strategy for one minute to avoid
    // turning this public page into unlimited provider searches. Never expose account keys or ids.
    const gpuQuotes = new Map();
    r.get('/api/v1/exchange/gpu-quotes/:model', publicCache(30), async (req, res, next) => {
        try {
            if (!ownEndpoints) return res.status(503).json({ error: 'GPU quotes unavailable' });
            const model = String(req.params.model);
            const strategy = String(req.query.strategy || 'cheapest');
            if (!ownEndpoints.status().models.some(m => m.key === model) || !['automatic','cheapest','fastest','private','own'].includes(strategy)) return res.status(422).json({ error: 'unknown model or strategy' });
            const key = model + ':' + strategy;
            let entry = gpuQuotes.get(key);
            if (!entry || entry.until < clock.now()) {
                entry = { until: clock.now() + 60000, promise: ownEndpoints.preview(model, { strategy }) };
                gpuQuotes.set(key, entry);
            }
            res.json(await entry.promise);
        } catch (err) { next(err); }
    });

    r.get('/api/v1/exchange/endpoints', publicCache(30), (req, res) => {
        res.json(ownEndpoints ? ownEndpoints.status() : {
            enabled: false, reason: 'The GPU provider is not set up yet, so no endpoint can start.', reasons: ['The GPU provider is not set up yet, so no endpoint can start.'],
            billing: false, models: [],
        });
    });

    r.get('/api/v1/exchange/models/:slug', publicCache(30), async (req, res, next) => {
        try {
            const out = await all();
            const slug = String(req.params.slug || '').toLowerCase();
            const found = out.models.find((m) => m.slug === slug);
            if (!found) return http.sendProblem(res, 404, 'exchange.model_not_found', { detail: `no model ${slug}`, ctx: req.ov });
            return res.json(found);
        } catch (err) { return next(err); }
    });

    r.get('/api/v1/exchange/models/:org/:model', publicCache(30), async (req, res, next) => {
        try {
            const out = await all();
            const slug = `${String(req.params.org || '').toLowerCase()}/${String(req.params.model || '').toLowerCase()}`;
            const found = out.models.find((m) => m.slug === slug);
            if (!found) return http.sendProblem(res, 404, 'exchange.model_not_found', { detail: `no model ${slug}`, ctx: req.ov });
            return res.json(found);
        } catch (err) { return next(err); }
    });

    // The changelog of the price book (plan E1): what a price was, what it became and the provider's own
    // listing it was read from. Only the changes that are live are here: a change waiting for the owner is not
    // a price yet, and a guess never reaches a catalog.
    r.get('/api/v1/exchange/price-changes', publicCache(60), async (req, res, next) => {
        try {
            const limit = Math.max(1, Math.min(200, Number.parseInt(req.query.limit, 10) || 50));
            const provider = req.query.provider ? String(req.query.provider) : null;
            const rows = await priceStore.live({ limit, provider });
            return res.json({
                generated_at: new Date(clock.now()).toISOString(),
                count: rows.length,
                changes: rows.map((c) => ({
                    id: c.id,
                    provider: c.provider_key,
                    model: c.model_key,
                    field: c.field,
                    old_price: c.old_price == null ? null : Number(c.old_price),
                    new_price: Number(c.new_price),
                    change_pct: c.change_pct == null ? null : Number(c.change_pct),
                    source: c.source,
                    checked_at: String(c.checked_at).slice(0, 10),
                    changed_at: c.created_at,
                })),
            });
        } catch (err) { return next(err); }
    });

    // Stage B8: the share of requests and tokens each model and each app category carried in a completed
    // week. Aggregated only: cells below k requests are withheld, opt-outs are excluded, and no person, app
    // or prompt is ever named.
    r.get('/api/v1/exchange/share', publicCache(300), async (req, res, next) => {
        try {
            const week = req.query.week == null || req.query.week === '' ? null : String(req.query.week);
            const out = await trafficShare.read({ week });
            return res.json(out);
        } catch (err) {
            if (err && err.name === 'ShareError') return http.sendProblem(res, err.status, err.code, { detail: err.detail, ctx: req.ov });
            return next(err);
        }
    });

    r.get('/api/v1/exchange/usage', publicCache(60), async (req, res, next) => {
        try {
            const days = Math.max(1, Math.min(366, Number.parseInt(req.query.days, 10) || 30));
            const key = String(days);
            const cached = usageByWindow.get(key);
            if (cached && clock.now() - cached.at < 60_000) return res.json(cached.value);
            const value = await usage.read({ days });
            usageByWindow.set(key, { at: clock.now(), value });
            if (usageByWindow.size > 16) usageByWindow.delete(usageByWindow.keys().next().value);
            return res.json(value);
        } catch (err) { return next(err); }
    });

    // The caller's own usage (the MCP server and the Exchange's developer page read it): a person sees their
    // subject, a developer app its project. The public aggregate above is never per person; this one is never
    // anyone else's.
    r.get('/api/v1/exchange/me/usage', read, wrap(async (req) => {
        const p = req.principal || {};
        if (!p.kind) throw new AiError(403, 'capability.denied', 'a person or a developer app reads its own usage');
        if (!quotas) throw new AiError(503, 'exchange.unavailable', 'usage is not configured here');
        const who = p.kind === 'app' ? `project:${p.projectId}` : `user:${p.subject && p.subject.id}`;
        const day = (v, field) => {
            if (v == null || v === '') return undefined;
            const s = String(v).slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new AiError(422, 'ai.invalid', `${field} must be YYYY-MM-DD`);
            return s;
        };
        const from = day(req.query.from, 'from');
        const to = day(req.query.to, 'to');
        return { requester: who, usage: await quotas.usage({ from, to, requester: who }) };
    }));

    return r;
}

module.exports = { exchangeRouter, CATALOG_MS };
