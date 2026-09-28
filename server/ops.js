'use strict';
/**
 * Operator actions shared by the admin API (server/api/admin.js) and the operator console
 * (server/console): one implementation of each, so both paths make the same change and write the
 * same audit row. `who` is { actor, trace }: a service principal (svc:…) through the API, a Network
 * person (usr_…) through the console.
 *
 * Changes that are already a single registry/quotas/runs call (versions, lifecycle status, models,
 * quotas, run cancel) are called directly by both; what lives here is the few that were inline in
 * the API routes.
 */
const { AiError } = require('./util');

function createOps({ db, registry, pool, quotas, cache, runs }) {
    /** A provider as every operator surface shows it: secret reference NAME + whether it resolves, health. */
    const providerView = async (p) => registry.publicProvider(p, await pool.health(p.key));

    /** GET /api/v1/status: providers, run counts, today's spend, definitions, queue, quota counters. */
    async function status() {
        const counts = Object.fromEntries((await db.prepare('SELECT status, COUNT(*) n FROM runs GROUP BY status').all()).map(x => [x.status, x.n]));
        const today = new Date().toISOString().slice(0, 10);
        const spend = await db.prepare('SELECT COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(requests),0)::bigint requests FROM usage_daily WHERE day = ?').get(today);
        return {
            providers: (await Promise.all((await registry.listProviders()).map(async p => ({ key: p.key, kind: p.kind, status: p.status, credentials: (await providerView(p)).credentials, health: (await pool.health(p.key)).state })))),
            runs: counts, today: { day: today, requests: spend.requests, cost_usd: spend.cost },
            workflows: (await registry.listWorkflows()).length, templates: (await registry.listTemplates()).length, routes: (await registry.listRoutes()).length,
            inflight: runs.inflight.size, quotas: await quotas.counters(),
        };
    }

    /** Enable or disable a provider (a registry upsert of its status; audited as provider.update). */
    async function setProviderStatus(key, status, { actor, trace = null }) {
        if (!await registry.getProvider(key)) throw new AiError(404, 'ai.not_found', 'no such provider');
        if (!['active', 'disabled'].includes(status)) throw new AiError(422, 'ai.invalid', 'provider status must be active or disabled');
        return await registry.upsertProvider({ key, status }, { actor, trace, origin: 'admin' });
    }

    /** Close a provider's circuit (breaker reset); audited as provider.circuit_reset. */
    async function resetCircuit(key, { actor, trace = null }) {
        await pool.resetHealth(key);
        await registry.audit(actor, 'provider.circuit_reset', 'provider', key, { trace });
        return await pool.health(key);
    }

    /** Remove cache entries: one workflow's, or every entry when `workflow` is empty; audited as cache.purge. */
    async function purgeCache(workflow, { actor, trace = null }) {
        const removed = await cache.purge({ workflow: workflow || undefined });
        await registry.audit(actor, 'cache.purge', 'cache', workflow || '*', { trace, metadata: { removed } });
        return removed;
    }

    return { providerView, status, setProviderStatus, resetCircuit, purgeCache };
}

module.exports = { createOps };
