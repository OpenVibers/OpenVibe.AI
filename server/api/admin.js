'use strict';
/**
 * Registry and admin API. Provider responses never include secret values — only the secret
 * reference name and whether it resolves.
 *
 *   GET   /api/v1/status                                   summary (ai.usage.read)
 *   GET   /api/v1/providers | /providers/:key              (ai.provider.manage | ai.usage.read)
 *   POST  /api/v1/providers                                create/replace (ai.provider.manage)
 *   PATCH /api/v1/providers/:key                           update (ai.provider.manage)
 *   POST  /api/v1/providers/:key/{disable,enable,reset}    status / circuit reset (ai.provider.manage)
 *   GET   /api/v1/models            POST /api/v1/models    PATCH /api/v1/models/:provider/:model
 *   GET   /api/v1/routes[/:key]     POST /api/v1/routes/:key/versions     POST /routes/:key/versions/:v/status
 *   GET   /api/v1/templates[/:key]  POST /api/v1/templates/:key/versions  POST /templates/:key/versions/:v/status
 *   GET   /api/v1/workflows[/:key]  POST /api/v1/workflows/:key/versions  POST /workflows/:key/versions/:v/status
 *         (routes/templates/workflows: read with ai.workflow.manage, ai.run.create or ai.usage.read; write with ai.workflow.manage)
 *   GET   /api/v1/quotas            POST /api/v1/quotas (ai.provider.manage)
 *   GET   /api/v1/usage, /api/v1/requests, /api/v1/audit, /api/v1/cache (ai.usage.read)
 *   DELETE /api/v1/cache[?workflow=]                        purge (ai.provider.manage)
 *
 * Provider status, circuit reset, cache purge and the status summary are server/ops.js, shared with
 * the operator console (server/console) so both make the same change and write the same audit row.
 */
const express = require('express');
const { CAPS } = require('../auth');
const { AiError, sendError } = require('../util');
const { createOps } = require('../ops');

function adminRouter({ db, registry, pool, quotas, cache, runs, auth, ops = createOps({ db, registry, pool, quotas, cache, runs }), log = console }) {
    const r = express.Router();
    const provRead = auth.requireCap(CAPS.providerManage, CAPS.usageRead);
    const provWrite = auth.requireCap(CAPS.providerManage);
    const defRead = auth.requireCap(CAPS.workflowManage, CAPS.runCreate, CAPS.usageRead);
    const defWrite = auth.requireCap(CAPS.workflowManage);
    const usageRead = auth.requireCap(CAPS.usageRead);
    const wrap = (fn) => async (req, res) => { try { const out = await fn(req, res); if (out !== undefined) res.json(out); } catch (err) { sendError(res, err, req.ov, log); } };
    const actor = (req) => ({ actor: req.principal.sub, trace: req.ov.traceId });
    const view = ops.providerView;
    const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

    r.get('/api/v1/status', usageRead, wrap(async () => await ops.status()));

    // Providers
    r.get('/api/v1/providers', provRead, wrap(async () => ({ providers: (await Promise.all((await registry.listProviders()).map(view))) })));
    r.get('/api/v1/providers/:key', provRead, wrap(async (req) => {
        const p = await registry.getProvider(req.params.key);
        if (!p) throw new AiError(404, 'ai.not_found', 'no such provider');
        return { provider: await view(p), models: await registry.listModels({ provider: p.key }), stats: pool.stats[p.key] || null };
    }));
    r.post('/api/v1/providers', provWrite, wrap(async (req, res) => {
        const b = body(req);
        if ('api_key' in b || 'secret' in b) throw new AiError(422, 'ai.invalid', 'send secret_ref (env:NAME), never a secret value');
        res.status(201);
        return { provider: await view(await registry.upsertProvider(b, { ...actor(req), origin: 'admin' })) };
    }));
    r.patch('/api/v1/providers/:key', provWrite, wrap(async (req) => {
        const b = body(req);
        if ('api_key' in b || 'secret' in b) throw new AiError(422, 'ai.invalid', 'send secret_ref (env:NAME), never a secret value');
        if (!await registry.getProvider(req.params.key)) throw new AiError(404, 'ai.not_found', 'no such provider');
        return { provider: await view(await registry.upsertProvider({ ...b, key: req.params.key }, { ...actor(req), origin: 'admin' })) };
    }));
    for (const [action, status] of [['disable', 'disabled'], ['enable', 'active']]) {
        r.post(`/api/v1/providers/:key/${action}`, provWrite, wrap(async (req) => ({ provider: await view(await ops.setProviderStatus(req.params.key, status, actor(req))) })));
    }
    r.post('/api/v1/providers/:key/reset', provWrite, wrap(async (req) => ({ health: await ops.resetCircuit(req.params.key, actor(req)) })));

    // Models
    r.get('/api/v1/models', provRead, wrap(async (req) => ({ models: await registry.listModels({ provider: req.query.provider }) })));
    r.post('/api/v1/models', provWrite, wrap(async (req, res) => { res.status(201); return { model: await registry.upsertModel(body(req), actor(req)) }; }));
    r.patch('/api/v1/models/:provider/:model', provWrite, wrap(async (req) => {
        if (!await registry.getModel(req.params.provider, req.params.model)) throw new AiError(404, 'ai.not_found', 'no such model');
        return { model: await registry.upsertModel({ ...body(req), provider_key: req.params.provider, model_key: req.params.model }, actor(req)) };
    }));

    // Versioned definitions
    const kinds = {
        routes: { list: registry.listRoutes, get: registry.getRoute, create: registry.createRouteVersion, one: 'route' },
        templates: { list: registry.listTemplates, get: registry.getTemplate, create: registry.createTemplateVersion, one: 'template' },
        workflows: { list: registry.listWorkflows, get: registry.getWorkflow, create: registry.createWorkflowVersion, one: 'workflow' },
    };
    for (const [plural, k] of Object.entries(kinds)) {
        r.get(`/api/v1/${plural}`, defRead, wrap(async (req) => ({ [plural]: await k.list({ history: req.query.history === '1', namespace: req.query.namespace }) })));
        r.get(`/api/v1/${plural}/:key`, defRead, wrap(async (req) => {
            const latest = await k.get(req.params.key, req.query.version ? Number(req.query.version) : undefined);
            if (!latest) throw new AiError(404, 'ai.not_found', `no ${k.one} ${req.params.key}`);
            const versions = (await k.list({ history: true })).filter(x => x.key === req.params.key).map(x => ({ version: x.version, status: x.status, created_by: x.created_by, created_at: x.created_at }));
            return { [k.one]: latest, versions };
        }));
        // An edit is always a new version; the previous one stays readable.
        r.post(`/api/v1/${plural}/:key/versions`, defWrite, wrap(async (req, res) => {
            try {
                const created = await k.create(req.params.key, body(req), actor(req));
                res.status(201);
                return { [k.one]: created };
            } catch (err) {
                if (err instanceof AiError) throw err;
                throw new AiError(422, 'ai.invalid', err.message);
            }
        }));
        r.post(`/api/v1/${plural}/:key/versions/:version/status`, defWrite, wrap(async (req) => ({
            [k.one]: await registry.setStatus(k.one, req.params.key, Number(req.params.version), body(req).status, actor(req)),
        })));
    }

    // Quotas, usage, logs, audit, cache
    r.get('/api/v1/quotas', usageRead, wrap(async () => ({ quotas: await quotas.list(), current: await quotas.counters() })));
    r.post('/api/v1/quotas', provWrite, wrap(async (req, res) => { res.status(201); return { quota: await quotas.upsert(body(req), { ...actor(req), origin: 'admin' }) }; }));
    r.get('/api/v1/usage', usageRead, wrap(async (req) => ({ usage: await quotas.usage({ from: req.query.from, to: req.query.to, requester: req.query.requester }) })));
    r.get('/api/v1/requests', usageRead, wrap(async (req) => {
        const where = [];
        const args = [];
        if (req.query.provider) { where.push('provider_key = ?'); args.push(req.query.provider); }
        if (req.query.status) { where.push('status = ?'); args.push(req.query.status); }
        if (req.query.run) { where.push('run_id = ?'); args.push(req.query.run); }
        if (req.query.fallback === '1') where.push('fallback = 1');
        // Raw debug fields only for provider managers who ask for them (and only exist when opted in).
        const debug = req.query.debug === '1' && auth.principalHas(req, CAPS.providerManage);
        const cols = debug ? '*' : 'id, run_id, seq, operation, provider_key, model_key, route_key, route_version, status, skip_reason, fallback, prompt_hash, input_hash, output_hash, tokens_in, tokens_out, tokens_cached, tokens_estimated, cost_usd, latency_ms, error, created_at';
        return { requests: await db.prepare(`SELECT ${cols} FROM requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(500, Number(req.query.limit) || 100)) };
    }));
    r.get('/api/v1/audit', usageRead, wrap(async (req) => ({ audit: await registry.listAudit({ action: req.query.action, targetType: req.query.target_type, targetId: req.query.target_id, limit: Number(req.query.limit) || 100, before: req.query.before }) })));
    r.get('/api/v1/cache', usageRead, wrap(async () => ({ cache: await cache.stats() })));
    r.delete('/api/v1/cache', provWrite, wrap(async (req) => ({ removed: await ops.purgeCache(req.query.workflow, actor(req)) })));

    return r;
}

module.exports = { adminRouter };
