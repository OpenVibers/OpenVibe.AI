'use strict';
// GET /api/v1/exchange/{catalog,models,usage}: the public read OpenVibe.Exchange renders from. Prices,
// measured speed and uptime come from the rate cards and provider_stats_daily; usage is aggregate only
// (never a prompt, an answer, an attribution or a person); capacity the network may not resell is not
// an offer.
const assert = require('assert');
const { boot, request, suite } = require('./helpers');

const t = suite('exchange-read');
let h;

const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

t.test('boot', async () => {
    // The catalog lists only offers whose key is configured: give the test's providers keys and the shared
    // provider a real OpenAI upstream, as production has.
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER: 'openai', AI_API_KEY: 'test-openai-key', DEEPSEEK_KEY: 'test-deepseek-key', DEEPINFRA_KEY: 'test-deepinfra-key' } });
});

t.test('catalog groups the same model across providers, with prices, speed, uptime and data policy', async () => {
    await h.registry.upsertProvider({
        key: 'deepseek', display_name: 'DeepSeek', kind: 'openai', auth_mode: 'bearer', secret_ref: 'env:DEEPSEEK_KEY',
        base_url: 'https://api.deepseek.test', capabilities: ['chat', 'json', 'tools'], provider_access: 'OWN_DEPLOYMENT',
        metadata: { data_policy: { trains: false, retention_days: 0, region: 'cn' } },
    });
    await h.registry.upsertModel({ provider_key: 'deepseek', model_key: 'deepseek-chat', type: 'chat', context_window: 131072,
        cost: { in_per_mtok: 0.28, out_per_mtok: 0.42, cached_per_mtok: 0.028 } });
    await h.registry.upsertProvider({
        key: 'deepinfra', display_name: 'DeepInfra', kind: 'openai', auth_mode: 'bearer', secret_ref: 'env:DEEPINFRA_KEY',
        base_url: 'https://api.deepinfra.test', capabilities: ['chat'], provider_access: 'AUTHORIZED_WHOLESALE',
    });
    await h.registry.upsertModel({ provider_key: 'deepinfra', model_key: 'deepseek-chat', type: 'chat', context_window: 131072,
        cost: { in_per_mtok: 0.20, out_per_mtok: 0.30 } });
    await h.db.prepare(`INSERT INTO provider_stats_daily (day, provider, model, requests, ok, errors, latency_p50_ms, latency_p95_ms)
        VALUES (?, 'deepseek', 'deepseek-chat', 100, 99, 1, 400, 900), (?, 'deepinfra', 'deepseek-chat', 10, 8, 2, 700, 2000)`).run(day(1), day(1));

    const r = await request(h.base, 'GET', '/api/v1/exchange/catalog');
    assert.strictEqual(r.status, 200, r.text);
    assert.match(r.headers.get('cache-control'), /^public, max-age=30/);
    const m = r.body.models.find((x) => x.slug === 'deepseek/deepseek-chat');
    assert.ok(m, 'one model for both providers');
    assert.strictEqual(m.family, 'DeepSeek');
    assert.strictEqual(m.context, 131072);
    assert.strictEqual(m.offers.length, 2, 'both offers on the one model page');
    const [cheap, dear] = m.offers;
    assert.strictEqual(cheap.provider, 'deepinfra', 'sorted by price');
    assert.deepStrictEqual(cheap.price, { in: 0.2, out: 0.3, cached: 0.02, per: '1M tokens', currency: 'USD' });
    assert.strictEqual(dear.uptime, 0.99);
    assert.strictEqual(dear.requests_7d, 100);
    assert.deepStrictEqual(dear.data_policy, { trains: false, retention_days: 0, region: 'cn' });
    assert.strictEqual(cheap.data_policy, null, 'unknown stays unknown');
    assert.strictEqual(m.requests_7d, 110);
});

t.test('a person’s own-key capacity and a stub are never offers', async () => {
    await h.registry.upsertProvider({ key: 'byok', kind: 'openai', auth_mode: 'bearer', secret_ref: 'env:BYOK', capabilities: ['chat'], provider_access: 'CUSTOMER_BYOK' });
    await h.registry.upsertModel({ provider_key: 'byok', model_key: 'deepseek-chat', type: 'chat' });
    const r = await request(h.base, 'GET', '/api/v1/exchange/catalog');
    const m = r.body.models.find((x) => x.slug === 'deepseek/deepseek-chat');
    assert.ok(!m.offers.some((o) => o.provider === 'byok'));
    assert.ok(!r.body.models.some((x) => x.offers.some((o) => o.provider === 'stub')));
});

t.test('one model by slug, and a miss is a problem document', async () => {
    const ok = await request(h.base, 'GET', '/api/v1/exchange/models/deepseek/deepseek-chat');
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(ok.body.slug, 'deepseek/deepseek-chat');
    const miss = await request(h.base, 'GET', '/api/v1/exchange/models/nope/nope');
    assert.strictEqual(miss.status, 404);
    assert.strictEqual(miss.body.code, 'exchange.model_not_found');
});

t.test('usage: day, model and product aggregates, and never an attribution', async () => {
    const insert = h.db.prepare(`INSERT INTO usage_daily (day, requester, attribution, workflow_key, provider_key, model_key, requests, tokens_in, tokens_out, tokens_cached, cost_usd)
        VALUES (?, ?, ?, 'ai.complete', ?, ?, ?, ?, ?, 0, ?)`);
    await insert.run(day(0), 'service:live', 'live:user:usr_SECRETPERSON', 'deepseek', 'deepseek-chat', 5, 500, 100, 0.001);
    await insert.run(day(0), 'service:wiki', '', 'deepseek', 'deepseek-chat', 3, 300, 60, 0.0006);
    await insert.run(day(1), 'service:live', 'live:user:usr_SECRETPERSON', 'deepseek', 'deepseek-chat', 2, 200, 40, 0.0004);
    await insert.run(day(1), 'app:app_ABC', '', 'deepseek', 'deepseek-chat', 1, 100, 20, 0.0002);

    const r = await request(h.base, 'GET', '/api/v1/exchange/usage?days=7');
    assert.strictEqual(r.status, 200, r.text);
    assert.match(r.headers.get('cache-control'), /^public, max-age=60/);
    assert.strictEqual(r.body.totals.requests, 11);
    assert.strictEqual(r.body.today.requests, 8);
    assert.strictEqual(r.body.by_day.length, 2);
    const live = r.body.by_product.find((p) => p.product === 'live');
    assert.strictEqual(live.requests, 7);
    assert.strictEqual(live.models[0].model, 'deepseek-chat');
    assert.ok(!r.body.by_product.some((p) => p.product.includes('app_')), 'only services are products');
    assert.doesNotMatch(r.text, /SECRETPERSON|usr_/);
    assert.ok(r.body.by_model.some((m) => m.model === 'deepseek-chat' && m.requests === 11));
});
