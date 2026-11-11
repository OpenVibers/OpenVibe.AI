'use strict';
const assert = require('assert');
const { PROVIDERS, isRoutingExcludedModel } = require('../server/providers/pool-providers');
const seed = require('../server/providers/pool-seed');
const { describe } = require('../server/providers/catalog');
const { checkProvider } = require('../server/providers/check');
const { boot, suite, seamServer } = require('./helpers');
const t = suite('provider-muse');

const meta = PROVIDERS.find((p) => p.key === 'meta');
const model = (key) => meta.models.find((m) => m.model_key === key);

t.test('Meta Muse records are dated, standard mode, priced, capable, and seeded off', () => {
    assert.ok(meta);
    const p = seed.recordOf(meta);
    assert.strictEqual(p.status, 'disabled');
    assert.strictEqual(p.default_model, 'muse-spark-1.3');
    assert.strictEqual(p.metadata.data_policy.trains, false);
    assert.deepStrictEqual(meta.models.map((m) => m.model_key), ['muse-ember-1.0', 'muse-spark-1.3']);
    const ember = model('muse-ember-1.0');
    assert.deepStrictEqual(ember.cost, { in_per_mtok: 0.10, cached_per_mtok: 0.004, out_per_mtok: 0.50 });
    assert.match(ember.note, /above 200K input tokens bill the entire request at 3x/);
    assert.strictEqual(ember.checked, '2026-11-10');
    assert.strictEqual(ember.context_window, 1048576);
    assert.strictEqual(ember.max_output, 524288);
    assert.deepStrictEqual(ember.supports, { json: true, tools: true, streaming: true, vision: true });
    assert.deepStrictEqual(model('muse-spark-1.3').cost, { in_per_mtok: 1.25, cached_per_mtok: 0.15, out_per_mtok: 4.25 });
    assert.strictEqual(model('muse-spark-1.3').checked, '2026-11-10');
    assert.strictEqual(describe('muse-ember-1.0').tier, 'fast');
    assert.strictEqual(describe('muse-ember-1.0').reasoning, true);
    assert.strictEqual(describe('muse-spark-1.3').tier, 'strong');
    assert.strictEqual(describe('muse-spark-1.3').tools, true);
    assert.ok(!meta.models.some((m) => /wonder-full|contributor/i.test(m.model_key)));
});

t.test('Contributor model variants are excluded even if manually activated', () => {
    assert.strictEqual(isRoutingExcludedModel('muse-spark-1.3-contributor'), true);
    assert.strictEqual(isRoutingExcludedModel('muse-spark-1.3', { metadata: { routing_excluded: true } }), true);
    assert.strictEqual(isRoutingExcludedModel('muse-spark-1.3'), false);
});

t.test('Exchange catalog carries Muse prices and an explicit off state before owner enablement', async () => {
    const { boot } = require('./helpers');
    const host = await boot({ env: { AI_STUB_FALLBACK: 'false' } });
    try {
        await host.registry.upsertProvider({ ...seed.recordOf(meta), auth_mode: 'bearer', status: 'disabled', secret_ref: 'env:META_CATALOG_KEY' });
        for (const m of meta.models) await host.registry.upsertModel(seed.modelOf(meta, m));
        const env = { META_CATALOG_KEY: 'synthetic-meta-catalog-key' };
        const catalog = require('../server/exchange/catalog').createCatalog({ db: host.db, registry: host.registry, pool: host.pool, env, config: host.config });
        const out = await catalog.models();
        for (const [id, expected] of [['muse-ember-1.0', 0.10], ['muse-spark-1.3', 1.25]]) {
            const entry = out.models.find((m) => m.slug === `meta/${id}`);
            assert.ok(entry, `${id} is listed`);
            assert.strictEqual(entry.offers[0].price.in, expected);
            assert.strictEqual(entry.offers[0].status, 'down');
            assert.strictEqual(entry.offers[0].status_reason, 'off until the owner turns it on');
        }
        await host.registry.upsertProvider({ key: 'meta', status: 'active' });
        const choices = require('../server/choices').createChoices({ db: host.db, registry: host.registry, catalog, ratings: async () => [] });
        await choices.seed();
        const chip = await choices.get('chat.reply');
        const ember = chip.options.openvibe.filter((row) => row.model === 'meta/muse-ember-1.0');
        const spark = chip.options.openvibe.filter((row) => row.model === 'meta/muse-spark-1.3');
        assert.strictEqual(ember.length, 1, 'the shared chip receives Ember once through its live options feed');
        assert.strictEqual(spark.length, 1, 'the shared chip receives Spark once through its live options feed');
    } finally { await host.stop(); }
});

let h;
let seam;
t.test('router skips a manually activated Contributor model and uses the eligible fallback', async () => {
    seam = await seamServer(() => ({ text: 'eligible answer', model: 'fallback-model', usage: { input: 2, output: 2 } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false' } });
    const addProvider = (key) => h.registry.upsertProvider({ key, kind: 'http', auth_mode: 'none', status: 'active', base_url: seam.url, capabilities: ['chat'], priority: 50 });
    const addModel = (provider_key, model_key, metadata = {}) => h.registry.upsertModel({ provider_key, model_key, status: 'active', cost: { in_per_mtok: 0.01, out_per_mtok: 0.01 }, metadata, supports: { streaming: true } });
    await addProvider('meta');
    await addModel('meta', 'muse-spark-1.3-contributor');
    await addProvider('fallback-open');
    await addModel('fallback-open', 'fallback-model');
    const route = { key: 'muse-contributor', primary: { provider: 'meta', model: 'muse-spark-1.3-contributor' }, fallbacks: [{ provider: 'fallback-open', model: 'fallback-model' }] };
    const result = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'hello' }], maxTokens: 4 });
    assert.strictEqual(result.provider, 'fallback-open');
    assert.ok(result.explain.candidates.some((c) => c.provider === 'meta' && /excluded from routing/.test(c.excluded_reason || '')));
});

t.test('the owner check path sends one tiny model-list read and never exposes credentials', async () => {
    let count = 0;
    const result = await checkProvider({ key: 'meta', auth_mode: 'bearer', secret_ref: 'env:META_TEST_KEY', base_url: 'https://api.meta.ai/v1', kind: 'openai' }, {
        env: { META_TEST_KEY: 'synthetic-meta-key-not-a-real-secret' },
        fetchImpl: async (url, init) => {
            count++;
            assert.strictEqual(String(url), 'https://api.meta.ai/v1/models');
            assert.strictEqual(init.method, 'GET');
            assert.strictEqual(init.headers.Authorization, 'Bearer synthetic-meta-key-not-a-real-secret');
            return new Response(JSON.stringify({ data: [{ id: 'muse-ember-1.0' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
    });
    assert.strictEqual(count, 1);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.requests, 1);
    assert.ok(!JSON.stringify(result).includes('synthetic-meta-key'));
});

t.run();
