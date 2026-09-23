'use strict';
/**
 * Track O: truthful readiness for GET /api/ready and the AI gauges on GET /metrics
 * (openvibe-shared/ready and openvibe-shared/metrics).
 *
 *   db            required  a real query on AI's SQLite (the provider registry answers)
 *   workflows     required  at least one active workflow: without one there is nothing to run
 *   network_jwks  required  the Network signing key has loaded. Every endpoint but health/ready
 *                           needs a verified service token, so without it AI serves nothing
 *   providers     optional  provider configuration: every active non-stub provider has the
 *                           credentials it needs and a circuit that is not open. A missing key or an
 *                           open circuit sends runs to fallbacks (or to a 503 provider.unavailable),
 *                           so it degrades the service rather than taking it out
 *
 * Gauges: runs waiting for a slot and running (ai_runs), and each provider's circuit state
 * (ai_provider_circuit{provider,state} = 1 for the current state, 0 for the others).
 */
const { createReadiness } = require('openvibe-shared/ready');

const CIRCUIT_STATES = ['closed', 'half_open', 'open'];

/** Active providers with what they need to answer: credentials and circuit state. */
function providerView(registry, pool) {
    return registry.listProviders().filter(p => p.status === 'active').map((p) => {
        const pub = registry.publicProvider(p);
        return { key: p.key, kind: p.kind, credentials: pub.credentials, circuit: pool.health(p.key).state };
    });
}

function createAiReadiness({ db, registry, pool, keys, runs, release = null }) {
    return createReadiness({
        service: 'ai',
        release,
        checks: [
            { name: 'db', required: true, check: () => (db.prepare('SELECT COUNT(*) AS n FROM providers').get().n > 0 ? true : 'the provider registry is empty') },
            {
                name: 'workflows', required: true,
                check: () => {
                    const n = db.prepare("SELECT COUNT(DISTINCT key) AS n FROM workflows WHERE status = 'active'").get().n;
                    return n > 0 ? { ok: true, detail: { active: n } } : 'no active workflow';
                },
            },
            { name: 'network_jwks', required: true, check: () => keys.loaded() || 'Network signing key not loaded yet: no service token can be verified' },
            {
                name: 'providers', required: false,
                check: () => {
                    const list = providerView(registry, pool);
                    const real = list.filter(p => p.kind !== 'stub');
                    const detail = { active: list.length, usable: real.filter(p => p.credentials !== 'missing' && p.circuit !== 'open').length };
                    if (!real.length) return { ok: false, error: 'no real provider is active: only synthetic stub output is available', detail };
                    const problems = real.filter(p => p.credentials === 'missing' || p.circuit === 'open')
                        .map(p => `${p.key}: ${p.credentials === 'missing' ? 'credentials missing' : 'circuit open'}`);
                    return problems.length ? { ok: false, error: problems.join('; '), detail } : { ok: true, detail };
                },
            },
        ],
        details: (body) => ({
            providers: body.checks.db.status === 'ok' ? providerView(registry, pool) : null,
            runs: runs.stats(),
        }),
    });
}

/** AI gauges on the openvibe-shared/metrics registry. */
function registerAiGauges(registry, { runs, registry: ai, pool }) {
    registry.gauge({
        name: 'ai_runs', help: 'Runs waiting for a slot (queued) and holding one (running)', labelNames: ['state'],
        collect: () => {
            const s = runs.stats();
            return [{ labels: { state: 'queued' }, value: s.queued }, { labels: { state: 'running' }, value: s.running }];
        },
    });
    registry.gauge({ name: 'ai_runs_max_concurrent', help: 'Runs allowed to execute at once (AI_MAX_CONCURRENT_RUNS)', collect: () => runs.stats().max_concurrent });
    registry.gauge({ name: 'ai_runs_max_queued', help: 'Runs allowed to wait for a slot (AI_MAX_QUEUED_RUNS)', collect: () => runs.stats().max_queued });
    registry.gauge({
        name: 'ai_provider_circuit', help: 'Circuit-breaker state of each active provider (1 = the current state)', labelNames: ['provider', 'state'],
        collect: () => providerView(ai, pool).flatMap(p => CIRCUIT_STATES.map(state => ({ labels: { provider: p.key, state }, value: p.circuit === state ? 1 : 0 }))),
    });
    registry.gauge({
        name: 'ai_provider_credentials_missing', help: 'Active providers whose secret reference does not resolve (1 = missing)', labelNames: ['provider'],
        collect: () => providerView(ai, pool).filter(p => p.credentials !== 'not_required').map(p => ({ labels: { provider: p.key }, value: p.credentials === 'missing' ? 1 : 0 })),
    });
}

module.exports = { createAiReadiness, registerAiGauges };
