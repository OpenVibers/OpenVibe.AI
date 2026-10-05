"use strict";
// B25: provider billing profiles. A metered or payg provider keeps its platform.rate-card@1 offers; a
// subscription, free or byok provider is prepaid - offered as pricing { model: 'prepaid' } with no rate
// card, still a placement candidate. No authority credential is needed by a free server or a pooled
// subscription; a byok pool record without a resolvable secret_ref is skipped no_credentials
// (server/providers/index.js). The providers.billing_profile column is the profile authority: it is seeded
// from metadata on create and validated (server/registry.js). The pool is built directly over a stubbed
// db/registry so the offers the planner receives are inspectable; registry persistence is tested on a real
// migrated database.
const assert = require('assert');
const placement = require('openvibe-sdk/placement');
const { suite, seamServer, boot, request, token, ALL } = require('./helpers');
const { createProviderPool } = require('../server/providers');
const { createRegistry } = require('../server/registry');
const { testDb } = require('./db');

const t = suite('provider-billing');
const noop = { get: async () => undefined, run: async () => ({}), all: async () => [] };
const iso = (n) => new Date(n).toISOString();

function provider(key, extra = {}) {
    return {
        key, kind: 'openai', status: 'active', auth_mode: 'none', secret_ref: null, default_model: `${key}-m`,
        capabilities: ['chat'], timeout_ms: 30000, priority: 10, updated_at: iso(0), billing_profile: 'metered', metadata: {}, ...extra,
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

const CHAT = { messages: [{ role: 'user', content: 'x' }], timeoutMs: 3000 };

t.test('the billing_profile column prices the offer; metadata is inert', async () => {
    const providers = {
        // The column says metered although metadata says subscription: the metered offer wins.
        meter: provider('meter', { billing_profile: 'metered', metadata: { billing_profile: 'subscription' } }),
        // The column says subscription although metadata says metered: the prepaid offer wins.
        sub: provider('sub', { billing_profile: 'subscription', metadata: { billing_profile: 'metered' } }),
    };
    const models = { 'meter/meter-m': { cost: { in_per_mtok: 2, out_per_mtok: 4, cached_per_mtok: 1 } } };
    const pool = poolFor(providers, models);
    const route = { key: 'test.pool-billing', capability: 'chat', constraints: { objective: 'cheapest' }, pinned: [], fallbacks: [] };

    const { out, offers } = await offersFor(pool, route);
    const byId = Object.fromEntries(offers.map((o) => [o.offer_id, o]));

    assert.deepStrictEqual(byId['sub:sub-m'].pricing, { model: 'prepaid' }, 'the column profile is prepaid');
    assert.strictEqual(byId['meter:meter-m'].pricing.model, 'per-operation', 'the column profile is metered');
    assert.strictEqual(byId['meter:meter-m'].pricing.rate_card, 'meter:meter-m/input-tokens');

    assert.deepStrictEqual(out.rateCards.map((c) => c.provider), ['meter', 'meter', 'meter'], 'only the metered provider hands the planner cards');
    assert.ok(out.rateCards.every((c) => c.metric.endsWith(':meter-m')), 'the cards are the metered provider\'s');

    // Both stay placement candidates.
    assert.ok(out.order.some((c) => c.provider === 'sub'), 'the prepaid provider stays in the pool');
    assert.ok(out.order.some((c) => c.provider === 'meter'), 'the metered provider stays in the pool');
});

t.test('a byok provider with no resolvable credential is skipped no_credentials', async () => {
    const providers = { byok: provider('byok', { kind: 'http', base_url: 'http://127.0.0.1:1/x', auth_mode: 'bearer', secret_ref: 'env:BYOK_NOT_SET', billing_profile: 'byok' }) };
    const pool = poolFor(providers);
    const route = { key: 'test.byok', primary: { provider: 'byok', model: null }, fallbacks: [], timeout_ms: 3000 };
    const logs = [];
    await assert.rejects(
        pool.execute(route, 'chat', CHAT, { routeKey: route.key, logRequest: (e) => logs.push(e) }),
        (err) => err.status === 503 && err.code === 'provider.unavailable' && JSON.stringify(err.extra.tried).includes('no_credentials'),
        'a keyless byok provider cannot answer',
    );
    assert.ok(logs.some((e) => e.status === 'skipped' && e.skip_reason === 'no_credentials'), 'the attempt is logged as a credential skip');
});

t.test('free and pooled-subscription capacity needs no authority credential', async () => {
    const seam = await seamServer(() => ({ text: 'a prepaid answer', model: 'm', usage: { input: 2, output: 1 } }));
    const providers = {
        free: provider('free', { kind: 'http', base_url: seam.url, auth_mode: 'bearer', secret_ref: 'env:FREE_NOT_SET', billing_profile: 'free' }),
        sub: provider('sub', { kind: 'http', base_url: seam.url, auth_mode: 'bearer', secret_ref: null, billing_profile: 'subscription' }),
    };
    const pool = poolFor(providers);
    for (const key of ['free', 'sub']) {
        const route = { key: `test.${key}`, primary: { provider: key, model: null }, fallbacks: [], timeout_ms: 3000 };
        const logs = [];
        const exec = await pool.execute(route, 'chat', CHAT, { routeKey: route.key, logRequest: (e) => logs.push(e) });
        assert.strictEqual(exec.provider, key, `${key} answers without an authority credential`);
        assert.strictEqual(exec.cost, 0, `${key} is prepaid, not metered`);
        assert.ok(logs.every((e) => e.skip_reason !== 'no_credentials'), `${key} was not skipped for a missing credential`);
    }
    await seam.close();
});

// -- The column is the authority: registry persistence on a real migrated database --
let rdb = null; let registry = null;
async function registryFixture() {
    if (!registry) { rdb = await testDb(); registry = createRegistry(rdb.db, { env: {} }); }
    return registry;
}

t.test('metadata seeds the billing_profile column on create; the column then wins', async () => {
    const r = await registryFixture();
    const created = await r.upsertProvider({ key: 'seeded', kind: 'stub', auth_mode: 'none', capabilities: ['chat'], metadata: { billing_profile: 'subscription' } });
    assert.strictEqual(created.billing_profile, 'subscription', 'metadata seeded the column');
    const edited = await r.upsertProvider({ key: 'seeded', metadata: { billing_profile: 'free' } });
    assert.strictEqual(edited.billing_profile, 'subscription', 'a later metadata edit does not re-route an existing provider');
    const direct = await r.upsertProvider({ key: 'seeded', billing_profile: 'byok' });
    assert.strictEqual(direct.billing_profile, 'byok', 'the column is set directly');
});

t.test('an unknown billing profile is refused in the column and in metadata', async () => {
    const r = await registryFixture();
    await assert.rejects(r.upsertProvider({ key: 'bad-col', kind: 'stub', auth_mode: 'none', capabilities: ['chat'], billing_profile: 'gold' }), /billing_profile/);
    await assert.rejects(r.upsertProvider({ key: 'bad-meta', kind: 'stub', auth_mode: 'none', capabilities: ['chat'], metadata: { billing_profile: 'gold' } }), /billing_profile/);
});

t.test('a keyless byok provider is reported missing by the registry view (agrees with the router)', async () => {
    const r = await registryFixture();
    const p = await r.upsertProvider({ key: 'byo', kind: 'stub', auth_mode: 'bearer', secret_ref: 'env:BYOK_UNSET', capabilities: ['chat'], billing_profile: 'byok' });
    assert.strictEqual(r.publicProvider(p).credentials, 'missing');
});

t.test('pool_key is validated against the key pattern', async () => {
    const r = await registryFixture();
    await assert.rejects(r.upsertProvider({ key: 'pooled', kind: 'stub', auth_mode: 'none', capabilities: ['chat'], pool_key: 'sk-liveOrSecretValue' }), /pool_key/);
    const ok = await r.upsertProvider({ key: 'pooled', kind: 'stub', auth_mode: 'none', capabilities: ['chat'], pool_key: 'live.pool-1' });
    assert.strictEqual(ok.pool_key, 'live.pool-1');
});

// A prepaid provider never gets a rate card (cost 0), but its attempt still carries the tokens each kind
// used, and account() writes one reading per attempt per kind with cost 0 (server/quota.js).
t.test('a prepaid provider\'s attempt still emits its per-kind readings with cost 0', async () => {
    const seam = await seamServer(() => ({ text: 'free answer', model: 'fm', usage: { input: 7, output: 3 } }));
    const tok = token('live', ALL);
    const h = await boot({ env: { AI_STUB_FALLBACK: 'false' } });
    try {
        assert.strictEqual((await request(h.base, 'POST', '/api/v1/providers', { tok, body: { key: 'freeby', kind: 'http', base_url: seam.url, auth_mode: 'none', capabilities: ['generate', 'chat'], billing_profile: 'free' } })).status, 201);
        assert.strictEqual((await request(h.base, 'POST', '/api/v1/models', { tok, body: { provider_key: 'freeby', model_key: 'fm', type: 'chat' } })).status, 201);
        const rte = await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok, body: { primary: { provider: 'freeby', model: 'fm' }, fallbacks: [], response_format: 'text' } });
        assert.strictEqual(rte.status, 201, rte.text);
        const r = await request(h.base, 'POST', '/api/v1/generate', { tok, body: { prompt: 'prepaid', options: { cache: false } } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.body.run.provenance.provider, 'freeby');
        assert.strictEqual(r.body.run.usage.cost_usd, 0, 'prepaid capacity is not metered');
        const rows = (await h.db.prepare('SELECT event_id, envelope FROM usage_sample_outbox ORDER BY id').all()).map((x) => ({ event_id: x.event_id, envelope: typeof x.envelope === 'string' ? JSON.parse(x.envelope) : x.envelope }));
        const mine = rows.filter((x) => x.event_id.startsWith(`ai:${r.body.run.id}:`));
        assert.deepStrictEqual(mine.map((x) => x.envelope.idempotency_key), ['in', 'cached', 'out'].map((k) => `ai:${r.body.run.id}:0:${k}`), 'one reading per attempt per kind');
        assert.ok(mine.every((x) => x.envelope.cost_estimate === 0), 'every prepaid reading costs 0');
        assert.deepStrictEqual(Object.fromEntries(mine.map((x) => [x.envelope.idempotency_key.split(':')[3], x.envelope.quantity])), { in: 7, cached: 0, out: 3 }, 'the quantities are kept');
    } finally {
        await h.stop(); await seam.close();
    }
});

t.test('shutdown', async () => { if (rdb) await rdb.close(); });
t.run();
