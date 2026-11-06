'use strict';
// GET /api/v1/exchange/{catalog,models,usage}: the public read OpenVibe.Exchange renders from. Prices come
// from the rate cards, speed/uptime/requests from the real runs (cached answers counted apart), and usage is
// aggregate only (never a prompt, an answer, an attribution or a person); capacity the network may not
// resell is not an offer.
const assert = require('assert');
const { boot, request, suite } = require('./helpers');

const t = suite('exchange-read');
let h;

const at = (n) => new Date(Date.now() - n * 86400000).toISOString();

let seq = 0;
const uid = (p) => `${p}_${Date.now()}_${seq++}`;
async function insertRun({ id = uid('run'), status = 'succeeded', provider = null, model = null, type = 'service', requester = 'live',
    created = at(0), cachedFrom = null, tokensIn = 0, tokensOut = 0, cost = 0, synthetic = 0 }) {
    await h.db.prepare(`INSERT INTO runs (id, workflow_key, workflow_version, status, requester_type, requester_id, input, input_hash,
            provider_key, model_key, cached_from, tokens_in, tokens_out, cost_usd, synthetic, created_at, started_at, finished_at)
        VALUES (?, 'ai.complete', 1, ?, ?, ?, '{}', 'input-hash', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, status, type, requester, provider, model, cachedFrom, tokensIn, tokensOut, cost, synthetic, created, created, created);
    return id;
}
async function insertRequest({ runId, provider, model, status = 'ok', latency = 100, created = at(0), seqNo = 0 }) {
    await h.db.prepare(`INSERT INTO requests (run_id, seq, operation, provider_key, model_key, status, latency_ms, created_at)
        VALUES (?, ?, 'chat', ?, ?, ?, ?, ?)`).run(runId, seqNo, provider, model, status, latency, created);
}
async function insertReceipt({ runId, body }) {
    await h.db.prepare(`INSERT INTO ai_receipts (id, run_id, body) VALUES (?, ?, ?::jsonb)`)
        .run(`rcpt_${uid('r')}`, runId, JSON.stringify(body));
}

t.test('boot', async () => {
    // The catalog lists only offers whose key is configured: give the test's providers keys and the shared
    // provider a real OpenAI upstream, as production has.
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER: 'openai', AI_API_KEY: 'test-openai-key', DEEPSEEK_KEY: 'test-deepseek-key', DEEPINFRA_KEY: 'test-deepinfra-key' } });
});

t.test('a run id is its registry name plus a revision, never another model', async () => {
    const { modelMatches, percentile } = require('../server/exchange/observed');
    assert.ok(modelMatches('gpt-5-nano', 'gpt-5-nano-2025-08-07'));
    assert.ok(modelMatches('gpt-5', 'gpt-5-2025-08-07'));
    assert.ok(modelMatches('claude-sonnet', 'claude-sonnet-4-5-20251001'));
    assert.ok(!modelMatches('gpt-5', 'gpt-5-mini-2025-08-07'), 'mini is its own model');
    assert.ok(!modelMatches('deepseek-chat', 'deepseek-reasoner'));
    assert.strictEqual(percentile([10, 20, 30, 40], 0.5), 25);
    assert.strictEqual(percentile([], 0.5), null);
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
    // Real runs name the id the upstream resolved ("deepseek-chat-2026-01-01"); the registry row names the
    // model ("deepseek-chat"). 8 answers, 2 failures attributed through their last attempt, 3 cache hits
    // whose provider is the run they reused. One answer recorded a TTFT (streamed); the rest have only the
    // attempt's total latency.
    const answered = [];
    for (let i = 0; i < 8; i++) {
        const id = await insertRun({ provider: 'deepseek', model: 'deepseek-chat-2026-01-01' });
        answered.push(id);
        await insertRequest({ runId: id, provider: 'deepseek', model: 'deepseek-chat-2026-01-01', latency: (i + 1) * 100 });
    }
    await insertReceipt({ runId: answered[3], body: { latency_ms: 400, ttft_ms: 50 } });
    for (let i = 0; i < 2; i++) {
        const id = await insertRun({ status: 'failed' });   // a failed run keeps no provider of its own
        await insertRequest({ runId: id, provider: 'deepseek', model: 'deepseek-chat-2026-01-01', status: 'error', latency: 900 });
    }
    for (let i = 0; i < 3; i++) await insertRun({ status: 'cached', model: 'deepseek-chat-2026-01-01', cachedFrom: answered[0] });

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
    // The deepseek offer: p50/p95 over [100,200,300,400,500,600,700,800] with 400 replaced by the recorded TTFT 50.
    assert.strictEqual(dear.uptime, 0.8, '8 succeeded / (8 + 2 failed), from runs');
    assert.strictEqual(dear.requests_7d, 10, 'real runs only; the 3 cached answers are counted apart');
    assert.strictEqual(dear.cached_7d, 3);
    assert.deepStrictEqual(dear.speed, { p50_ms: 400, p95_ms: 765 }, 'TTFT where recorded, else total');
    assert.strictEqual(dear.requests_today, 10);
    assert.strictEqual(cheap.uptime, null, 'no data is unknown, not 0');
    assert.strictEqual(cheap.requests_7d, 0);
    assert.deepStrictEqual(cheap.speed, { p50_ms: null, p95_ms: null });
    assert.deepStrictEqual(dear.data_policy, { trains: false, retention_days: 0, region: 'cn' });
    assert.strictEqual(cheap.data_policy, null, 'unknown stays unknown');
    assert.strictEqual(m.requests_7d, 10);
    assert.strictEqual(m.cached_7d, 3);
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

t.test('usage: day, model and product aggregates from runs, and never an attribution', async () => {
    // Live's real traffic is gpt-5-nano even though its route names a DeepSeek model: the run keeps the
    // model that answered, and the product table must show that one.
    for (let i = 0; i < 5; i++) await insertRun({ requester: 'live', provider: 'shared', model: 'gpt-5-nano-2025-08-07', tokensIn: 100, tokensOut: 20, cost: 0.0002 });
    for (let i = 0; i < 2; i++) await insertRun({ requester: 'live', provider: 'deepseek', model: 'deepseek-chat', created: at(1), tokensIn: 100, tokensOut: 20, cost: 0.0002 });
    for (let i = 0; i < 3; i++) await insertRun({ requester: 'wiki', provider: 'deepseek', model: 'deepseek-chat', tokensIn: 100, tokensOut: 20, cost: 0.0002 });
    await insertRun({ type: 'app', requester: 'app_ABC', provider: 'deepseek', model: 'deepseek-chat', tokensIn: 100, tokensOut: 20, cost: 0.0002 });
    // Not usage: a cache hit called no provider, a failed run answered nothing, and a workflow that
    // finished without an AI call has no model to attribute.
    await insertRun({ status: 'cached', requester: 'live', model: 'gpt-5-nano-2025-08-07', cachedFrom: 'run_source', tokensIn: 9999, tokensOut: 9999, cost: 9 });
    await insertRun({ status: 'failed', requester: 'live', tokensIn: 9999, tokensOut: 9999, cost: 9 });
    await insertRun({ requester: 'live', tokensIn: 9999, tokensOut: 9999, cost: 9 });

    const r = await request(h.base, 'GET', '/api/v1/exchange/usage?days=7');
    assert.strictEqual(r.status, 200, r.text);
    assert.match(r.headers.get('cache-control'), /^public, max-age=60/);
    assert.strictEqual(r.body.totals.requests, 11);
    assert.strictEqual(r.body.totals.tokens_in, 1100);
    assert.strictEqual(r.body.totals.tokens_out, 220);
    assert.strictEqual(r.body.today.requests, 9, 'the two live runs from yesterday are not today');
    assert.strictEqual(r.body.by_day.length, 2);
    const live = r.body.by_product.find((p) => p.product === 'live');
    assert.strictEqual(live.requests, 7);
    assert.strictEqual(live.models.length, 2);
    assert.strictEqual(live.models[0].model, 'gpt-5-nano-2025-08-07', 'the model that actually answered');
    assert.strictEqual(live.models[0].requests, 5);
    assert.ok(live.models.every((m) => m.model), 'a product names only models that actually answered');
    assert.ok(!r.body.by_product.some((p) => p.product.includes('app_')), 'only services are products');
    assert.ok(!r.text.includes('SECRETPERSON') && !r.text.includes('usr_'), 'no person in the aggregate');
    assert.ok(r.body.by_model.some((m) => m.model === 'gpt-5-nano-2025-08-07' && m.requests === 5));
    assert.ok(r.body.by_model.some((m) => m.model === 'deepseek-chat' && m.requests === 6));
    assert.doesNotMatch(r.text, /9999|9\.000000/, 'cached and failed runs are not counted');
});
