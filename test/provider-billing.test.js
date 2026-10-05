'use strict';
// B25: provider billing profiles. A metered or payg provider keeps its platform.rate-card@1 offers; a
// subscription, free or byok provider is prepaid — offered as pricing { model: 'prepaid' } with no rate
// card, still a placement candidate, and never skipped as no_credentials (server/providers/index.js).
// The pool is built directly over a stubbed db/registry so the offers the planner receives are inspectable.
const assert = require('assert');
const placement = require('openvibe-sdk/placement');
const { suite, seamServer } = require('./helpers');
const { createProviderPool } = require('../server/providers');

const t = suite('provider-billing');
const noop = { get: async () => undefined, run: async () => ({}), all: async () => [] };
const iso = (n) => new Date(n).toISOString();

function provider(key, extra = {}) {
    return {
        key, kind: 'openai', status: 'active', auth_mode: 'none', secret_ref: null, default_model: `${key}-m`,
        capabilities: ['chat'], timeout_ms: 30000, priority: 10, updated_at: iso(0), metadata: {}, ...extra,
    };
}

/** A pool over a fixed provider map; models is keyed '<provider>/<model>' -> a models row. */
function poolFor(providers, models = {}) {
    const registry = {
        getProvider: async (k) => providers[k] || null,
        listProviders: async () => Object.values(providers),
        listModels: async () => [],
        getModel: async (pk, mk) => models[`${pk}/${mk}`] || null,
        audit: async () => {},
    };
    const config = {
        breaker: { failureThreshold: 3, cooldownMs: 1000 }, providerRetries: 0, retryDelayMs: 1, stubFallback: false,
        placement: { minGain: 0, costWeight: 1, latencyWeight: 1 }, pricing: { table: {}, inputPerMtok: 0.5, outputPerMtok: 1.5 },
    };
    return createProviderPool({ db: { prepare: () => noop }, registry, config, env: {} });
}

/** Capture the offers handed to openvibe-sdk/placement while really planning the route. */
async function offersFor(pool, route) {
    const original = placement.plan;
    let offers = null;
    placement.plan = (req, list, opts) => { offers = list; return original(req, list, opts); };
    let out;
    try { out = await pool.candidates(route, ['chat'], 'chat'); } finally { placement.plan = original; }
    return { out, offers };
}

t.test('a metered provider keeps its rate cards; a subscription one is prepaid with none', async () => {
    const providers = {
        meter: provider('meter', { metadata: { billing_profile: 'metered' } }),
        sub: provider('sub', { metadata: { billing_profile: 'subscription' } }),
    };
    const models = { 'meter/meter-m': { cost: { in_per_mtok: 2, out_per_mtok: 4, cached_per_mtok: 1 } } };
    const pool = poolFor(providers, models);
    const route = { key: 'test.pool-billing', capability: 'chat', constraints: { objective: 'cheapest' }, pinned: [], fallbacks: [] };

    const { out, offers } = await offersFor(pool, route);
    const byId = Object.fromEntries(offers.map((o) => [o.offer_id, o]));

    assert.deepStrictEqual(byId['sub:sub-m'].pricing, { model: 'prepaid' }, 'a subscription provider is offered prepaid');
    assert.strictEqual(byId['meter:meter-m'].pricing.model, 'per-operation', 'a metered provider is priced per operation');
    assert.strictEqual(byId['meter:meter-m'].pricing.rate_card, 'meter:meter-m/input-tokens');

    assert.deepStrictEqual(out.rateCards.map((c) => c.provider), ['meter', 'meter', 'meter'], 'only the metered provider hands the planner cards');
    assert.ok(out.rateCards.every((c) => c.metric.endsWith(':meter-m')), 'the cards are the metered provider\'s');

    // Both stay placement candidates.
    assert.ok(out.order.some((c) => c.provider === 'sub'), 'the prepaid provider stays in the pool');
    assert.ok(out.order.some((c) => c.provider === 'meter'), 'the metered provider stays in the pool');
});

t.test('a prepaid provider with no authority credential is not skipped as no_credentials', async () => {
    const seam = await seamServer(() => ({ text: 'a prepaid answer', model: 'm', usage: { input: 2, output: 1 } }));
    const providers = { byok: provider('byok', { kind: 'http', base_url: seam.url, auth_mode: 'bearer', secret_ref: 'env:BYOK_NOT_SET', timeout_ms: 3000, metadata: { billing_profile: 'byok' } }) };
    const pool = poolFor(providers);
    const route = { key: 'test.byok', primary: { provider: 'byok', model: null }, fallbacks: [], timeout_ms: 3000 };
    const logs = [];
    const exec = await pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'x' }], timeoutMs: 3000 }, { routeKey: route.key, logRequest: (e) => logs.push(e) });
    assert.strictEqual(exec.provider, 'byok', 'the prepaid provider answers without an authority credential');
    assert.strictEqual(exec.cost, 0, 'a prepaid answer is not metered');
    assert.ok(logs.every((e) => e.skip_reason !== 'no_credentials'), 'it was not skipped for a missing credential');
    await seam.close();
});

t.run();
