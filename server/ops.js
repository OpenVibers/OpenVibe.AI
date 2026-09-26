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
    const providerView = (p) => registry.publicProvider(p, pool.health(p.key));

    /** GET /api/v1/status: providers, run counts, today's spend, definitions, queue, quota counters. */
    function status() {
        const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM runs GROUP BY status').all().map(x => [x.status, x.n]));
        const today = new Date().toISOString().slice(0, 10);
        const spend = db.prepare('SELECT COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(requests),0) requests FROM usage_daily WHERE day = ?').get(today);
        return {
            providers: registry.listProviders().map(p => ({ key: p.key, kind: p.kind, status: p.status, credentials: providerView(p).credentials, health: pool.health(p.key).state })),
            runs: counts, today: { day: today, requests: spend.requests, cost_usd: spend.cost },
            workflows: registry.listWorkflows().length, templates: registry.listTemplates().length, routes: registry.listRoutes().length,
            inflight: runs.inflight.size, quotas: quotas.counters(),
        };
    }

    /** Enable or disable a provider (a registry upsert of its status; audited as provider.update). */
    function setProviderStatus(key, status, { actor, trace = null }) {
        if (!registry.getProvider(key)) throw new AiError(404, 'ai.not_found', 'no such provider');
        if (!['active', 'disabled'].includes(status)) throw new AiError(422, 'ai.invalid', 'provider status must be active or disabled');
        return registry.upsertProvider({ key, status }, { actor, trace, origin: 'admin' });
    }

    /** Close a provider's circuit (breaker reset); audited as provider.circuit_reset. */
    function resetCircuit(key, { actor, trace = null }) {
        pool.resetHealth(key);
        registry.audit(actor, 'provider.circuit_reset', 'provider', key, { trace });
        return pool.health(key);
    }

    /** Remove cache entries: one workflow's, or every entry when `workflow` is empty; audited as cache.purge. */
    function purgeCache(workflow, { actor, trace = null }) {
        const removed = cache.purge({ workflow: workflow || undefined });
        registry.audit(actor, 'cache.purge', 'cache', workflow || '*', { trace, metadata: { removed } });
        return removed;
    }

    return { providerView, status, setProviderStatus, resetCircuit, purgeCache };
}

module.exports = { createOps };
