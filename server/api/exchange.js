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

function exchangeRouter({ db, registry, pool, env = process.env, clock = { now: () => Date.now() }, config = null, presets, receipts, auth, log = console }) {
    const catalog = createCatalog({ db, registry, pool, env, clock, config });
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
    const usageByWindow = new Map();
    const r = express.Router();

    const publicCache = (seconds) => (req, res, next) => { res.set('Cache-Control', `public, max-age=${seconds}`); next(); };

    // A caller that may run may read the presets; the same guard writes them (a preset is the caller's own).
    const read = auth.appOrCap(CAPS.appRun, CAPS.runCreate, CAPS.runRead);
    const write = auth.appOrCap(CAPS.appRun, CAPS.runCreate);
    const usageRead = auth.requireCap(CAPS.usageRead);
    const wrap = (fn) => async (req, res) => { try { const out = await fn(req, res); if (out !== undefined) res.json(out); } catch (err) { sendError(res, err, req.ov, log); } };
    const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

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
            const allowed = auth.principalHas(req, CAPS.usageRead)
                || (receipt.requester_type === subject.type && receipt.requester_id === subject.id)
                || (owner.type === 'user' && obId && String(owner.id) === String(obId));
            if (!allowed) throw new AiError(404, 'ai.receipt_not_found', `no receipt ${req.params.id}`);
            return { receipt };
        });
        r.get('/v1/receipts/:id', read, readReceipt);
        r.get('/api/v1/receipts/:id', read, readReceipt);
    }

    r.get('/api/v1/exchange/catalog', publicCache(30), async (req, res, next) => {
        try {
            const kind = req.query.kind == null || req.query.kind === '' ? null : String(req.query.kind).toLowerCase();
            if (kind && !catalogKinds.includes(kind)) {
                return http.sendProblem(res, 422, 'exchange.kind_invalid', { detail: `kind must be one of ${catalogKinds.join(', ')}`, ctx: req.ov });
            }
            res.json(await allFor(kind));
        } catch (err) { next(err); }
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

    return r;
}

module.exports = { exchangeRouter, CATALOG_MS };
