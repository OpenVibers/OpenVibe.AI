'use strict';
/**
 * Track O: truthful readiness for GET /api/ready and the AI gauges on GET /metrics
 * (openvibe-shared/ready and openvibe-shared/metrics).
 *
 *   db            required  a real query on AI's PostgreSQL database (the provider registry answers)
 *   workflows     required  at least one active workflow: without one there is nothing to run
 *   network_jwks  required  the Network signing key has loaded (openvibe-sdk/auth jwksStatus()). Every
 *                           endpoint but health/ready needs a verified service token, so without it AI
 *                           serves nothing; once loaded, the SDK keeps the last good keys through an outage
 *   providers     optional  provider configuration: every active non-stub provider has the
 *                           credentials it needs and a circuit that is not open. A missing key or an
 *                           open circuit sends runs to fallbacks (or to a 503 provider.unavailable),
 *                           so it degrades the service rather than taking it out. A catalogue offer
 *                           nobody bought (server/providers/pool-seed.js seeds the row so the owner
 *                           sees the key slot) is off by design and does not degrade anything
 *
 * Gauges: runs waiting for a slot and running (ai_runs), and each provider's circuit state
 * (ai_provider_circuit{provider,state} = 1 for the current state, 0 for the others).
 */
const { createReadiness } = require('openvibe-shared/ready');

const CIRCUIT_STATES = ['closed', 'half_open', 'open'];

/** Active providers with what they need to answer: credentials and circuit state. */
async function providerView(registry, pool) {
    return (await Promise.all((await registry.listProviders()).filter(p => p.status === 'active').map(async (p) => {
        const pub = registry.publicProvider(p);
        return {
            key: p.key, kind: p.kind, credentials: pub.credentials, circuit: (await pool.health(p.key)).state,
            // A catalogue offer (server/providers/pool-seed.js): the registry row exists so the owner sees the key
            // slot, and the offer answers once the owner puts its key in. It is off until then, by design.
            catalogue: Boolean(p.metadata && p.metadata.catalog === 'pool-providers'),
        };
    })));
}

function createAiReadiness({ db, registry, pool, keys, runs, release = null }) {
    return createReadiness({
        service: 'ai',
        release,
        checks: [
            {
                name: 'db', required: true,
                // A real round trip that names the store (postgresql / pglite), and the provider registry present.
                check: async () => {
                    const r = await db.ready();
                    if (!r.ok) return r.error;
                    return (await db.prepare('SELECT COUNT(*) AS n FROM providers').get()).n > 0 ? { ok: true, detail: r.detail } : 'the provider registry is empty';
                },
            },
            {
                name: 'workflows', required: true,
                check: async () => {
                    const n = (await db.prepare("SELECT COUNT(DISTINCT key) AS n FROM workflows WHERE status = 'active'").get()).n;
                    return n > 0 ? { ok: true, detail: { active: n } } : 'no active workflow';
                },
            },
            {
                name: 'network_jwks', required: true,
                // The SDK's JWKS clients: a pinned PEM reports ready on its own, otherwise the last good keys do
                // (they stay loaded through a Network outage). Public: counts and times only, never the internal
                // URL or the fetch error.
                check: () => {
                    const ready = keys.status().find(s => s.ready);
                    if (!ready) return 'Network signing key not loaded yet: no service token can be verified';
                    return { ok: true, detail: { keys: ready.keys, pinned: Boolean(ready.pinned), stale: Boolean(ready.stale), failures: ready.failures || 0 } };
                },
            },
            {
                name: 'providers', required: false,
                check: async () => {
                    const list = await providerView(registry, pool);
                    const real = list.filter(p => p.kind !== 'stub');
                    const detail = { active: list.length, usable: real.filter(p => p.credentials !== 'missing' && p.circuit !== 'open').length };
                    if (!real.length) return { ok: false, error: 'no real provider is active: only synthetic stub output is available', detail };
                    const problems = real.filter(p => p.circuit === 'open' || (p.credentials === 'missing' && !p.catalogue))
                        .map(p => `${p.key}: ${p.credentials === 'missing' ? 'credentials missing' : 'circuit open'}`);
                    return problems.length ? { ok: false, error: problems.join('; '), detail } : { ok: true, detail };
                },
            },
        ],
        details: async (body) => ({
            providers: body.checks.db.status === 'ok' ? await providerView(registry, pool) : null,
            runs: runs.stats(),
        }),
    });
}

/** AI gauges on the openvibe-shared/metrics registry. */
function registerAiGauges(registry, { runs, registry: ai, pool, balance = null, creditGrants = null, gpus = null, abuse = null, db = null }) {
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
        collect: async () => (await providerView(ai, pool)).flatMap(p => CIRCUIT_STATES.map(state => ({ labels: { provider: p.key, state }, value: p.circuit === state ? 1 : 0 }))),
    });
    // The measured per-offer breaker (migrations/0060): 1 while the offer's circuit is open, 0 while it serves
    // or waits for a half-open probe. The class is why it opened: balance, auth or transient.
    registry.gauge({
        name: 'ai_provider_circuit_open', help: 'Open circuit per provider and model (1 = open)', labelNames: ['provider', 'model', 'class'],
        collect: async () => {
            if (!db) return [];
            const rows = await db.prepare('SELECT provider_key, model_key, state, failure_class FROM provider_circuits').all().catch(() => []);
            const seen = new Set(rows.map((r) => `${r.provider_key}/${r.model_key || ''}`));
            const legacy = await db.prepare('SELECT provider_key, state, exhausted_at FROM provider_health').all().catch(() => []);
            return [
                ...rows.map((r) => ({ labels: { provider: r.provider_key, model: r.model_key || '', class: r.failure_class || '' }, value: r.state === 'open' ? 1 : 0 })),
                ...(legacy || []).filter((h) => !seen.has(`${h.provider_key}/`)).map((h) => ({
                    labels: { provider: h.provider_key, model: '', class: h.state === 'closed' ? '' : (h.exhausted_at ? 'balance' : 'transient') },
                    value: h.state === 'open' ? 1 : 0,
                })),
            ];
        },
    });
    // Why attempts failed, by provider and class, counted in the database so a restart keeps the total.
    registry.gauge({
        name: 'ai_provider_failures_total', help: 'Failed provider attempts by provider and failure class (balance, auth, rate_limit, transient, request)', labelNames: ['provider', 'class'],
        collect: async () => {
            if (!db) return [];
            const rows = await db.prepare('SELECT provider_key, failure_class, count FROM provider_failure_counts').all().catch(() => []);
            return (rows || []).map((r) => ({ labels: { provider: r.provider_key, class: r.failure_class }, value: Number(r.count) || 0 }));
        },
    });
    registry.gauge({
        name: 'ai_provider_credentials_missing', help: 'Active providers whose secret reference does not resolve (1 = missing)', labelNames: ['provider'],
        collect: async () => (await providerView(ai, pool)).filter(p => p.credentials !== 'not_required').map(p => ({ labels: { provider: p.key }, value: p.credentials === 'missing' ? 1 : 0 })),
    });
    // The hourly balance probe's last reading (server/providers/balance.js), never a live call on scrape.
    registry.gauge({
        name: 'ai_provider_balance_usd', help: 'Provider balance in USD; grant balances are estimates', labelNames: ['provider', 'kind'],
        collect: () => [
            ...(balance ? balance.values().map(r => ({ labels: { provider: r.provider, kind: 'available' }, value: r.usd })) : []),
            ...(creditGrants ? creditGrants.values().flatMap((r) => ['promotional', 'purchased'].map((kind) => ({ labels: { provider: r.provider, kind }, value: r[kind] }))) : []),
        ],
    });
    // Plan E5: free-tier requests throttled in the last 15 minutes, by reason (velocity, rate, hosting, network).
    // OpenVibe.Host's prometheus rule alerts when the sum stays high: the automatic throttle is working, and an
    // operator should look at /console/abuse.
    registry.gauge({
        name: 'ai_abuse_throttles', help: 'Free-tier requests throttled in the last 15 minutes, by reason', labelNames: ['reason'],
        collect: () => (abuse ? abuse.gaugeValues() : []),
    });
    // The GPU provisioner (server/gpu/): a marketplace instance that could not be given back is still running
    // and still being paid for. The operator alert fires at three tries in a row (OpenVibe.Host's prometheus
    // rules), so the gauge counts the tries that are still open.
    registry.gauge({
        name: 'ai_gpu_destroy_failures', help: 'Marketplace GPU instances OpenVibe.AI could not give back, in a row (the operator alert fires at 3)', labelNames: ['marketplace'],
        collect: async () => (gpus ? await gpus.destroyFailures() : []),
    });
    registry.gauge({
        name: 'ai_gpu_orphan_instances', help: 'Marketplace GPU instances with our label that no live row owns and that are still waiting to be given back', labelNames: ['marketplace'],
        collect: async () => (gpus ? await gpus.orphanCount() : []),
    });
    // BA1: the tier every run really ran on, and what waiting earned. A run's tier is the tier the provider
    // answered on ('standard', 'flex', 'offpeak', 'local'), never the tier we hoped for.
    registry.gauge({
        name: 'ai_runs_by_tier', help: 'Runs by the tier they really ran on', labelNames: ['tier', 'provider'],
        collect: async () => {
            if (!db) return [];
            const rows = await db.prepare(`SELECT service_tier AS tier, provider_key AS provider, COUNT(*)::bigint AS n
                FROM runs WHERE service_tier IS NOT NULL GROUP BY service_tier, provider_key`).all();
            return (rows || []).map((r) => ({ labels: { tier: r.tier, provider: r.provider || '' }, value: Number(r.n) || 0 }));
        },
    });
    // What waiting earned: the standard price minus the price the run really paid.
    registry.gauge({
        name: 'ai_saved_usd', help: 'What waiting earned: the standard price minus the price the run really paid',
        collect: async () => {
            if (!db) return 0;
            const row = await db.prepare('SELECT COALESCE(SUM(saved_usd), 0) AS saved FROM runs').get();
            return Number(row && row.saved) || 0;
        },
    });
}

module.exports = { createAiReadiness, registerAiGauges };
