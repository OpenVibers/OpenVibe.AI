'use strict';
const assert = require('assert');
const { suite } = require('./helpers');
const { aggregate, createMetricsRollup, publicOffers } = require('../server/exchange/metrics-rollup');
const t = suite('measured-metrics');
const providers = [{ key: 'openai', kind: 'openai', status: 'active', provider_access: 'OWN_DEPLOYMENT' }];
const models = [{ provider_key: 'openai', model_key: 'gpt-test', metadata: { id: 'openai/gpt-test' } }];
const offers = [{ key: 'openai', provider: 'openai', keyModel: 'gpt-test', model: 'openai/gpt-test' }];
const row = { provider: 'openai', model: 'gpt-test-2026-11-01', workflow: 'ai.complete', status: 'succeeded', latency_ms: 1000, ttft_ms: 200, tokens_out: 80, cost_usd: 0.01 };
let testdb;
t.test('each measure requires twenty valid observations; no caller data is copied', () => {
    assert.deepStrictEqual(aggregate(Array(19).fill(row), offers), []);
    const rows = Array.from({ length: 20 }, (_, i) => ({ ...row, latency_ms: 1000 + i * 100, owner_id: 'private', prompt: 'private' }));
    const cell = aggregate(rows, offers)[0];
    assert.equal(cell.model, 'openai/gpt-test');
    assert.equal(cell.metrics.latency_p50_ms, 1950);
    assert.equal(cell.metrics.latency_p95_ms, 2805);
    assert.equal(cell.metrics.cost_per_1k_output_tokens_usd.toFixed(3), '0.125');
    assert(!JSON.stringify(cell).includes('private'));
    rows[0].ttft_ms = null;
    rows.push({ ...row, status: 'failed', latency_ms: 99999 });
    const metrics = aggregate(rows, offers)[0].metrics;
    assert.equal(metrics.success_rate, 20 / 21);
    assert.equal(metrics.latency_p50_ms, 1950);
    assert.equal(metrics.ttft_p50_ms, null);
    assert.equal(metrics.tokens_per_second_p50, null);
    assert.equal(metrics.samples.ttft, null);
});
t.test('private and synthetic providers cannot form published cells', () => {
    const privateProviders = [
        { ...providers[0], metadata: { hidden: true } },
        { ...providers[0], provider_access: 'CUSTOMER_BYOK' },
        { ...providers[0], kind: 'stub' },
    ];
    for (const provider of privateProviders) assert.deepStrictEqual(publicOffers([provider], models), []);
    assert.deepStrictEqual(publicOffers(providers, [{ ...models[0], metadata: { variant: 'abliterated' } }]), []);
    assert.deepStrictEqual(publicOffers(providers, [{ ...models[0], metadata: { id: 'acme/uncensored' } }]), []);
    assert.equal(aggregate([{ ...row, provider: 'byo:private' }, ...Array(19).fill(row)], offers).length, 0);
});
t.test('durable due job backfills and survives restarts without losing older days', async () => {
    testdb = await require('./db').testDb();
    const db = testdb.db;
    let now = Date.parse('2026-11-10T01:00:00Z');
    const registry = { listProviders: async () => providers, listModels: async () => models };
    const options = { db, registry, clock: { now: () => now }, retentionDays: 3 };
    const at = '2026-11-09T12:00:00Z';
    for (let i = 0; i < 21; i++) {
        const id = `metric_run_${i}`;
        await db.prepare(`INSERT INTO runs (id, workflow_key, workflow_version, status, requester_type, requester_id, input, input_hash, synthetic, created_at)
            VALUES (?, 'ai.complete', 1, 'succeeded', 'service', 'private-site', '{}', 'hash', ?, ?)`)
            .run(id, i === 20 ? 1 : 0, at);
        await db.prepare('INSERT INTO ai_receipts (id, run_id, body, created_at) VALUES (?, ?, ?::jsonb, ?::timestamptz)').run(`rcpt_${i}`, id, JSON.stringify({
            offer: { provider: 'openai', model: 'gpt-test' }, workflow: 'ai.complete', latency_ms: 1000, ttft_ms: 200, usage: { tokens_out: 80 }, cost_usd: 0.01,
        }), at);
    }
    const first = await createMetricsRollup(options).tick();
    assert.equal(first.cells, 1);
    const cells = await db.prepare('SELECT * FROM exchange_metrics_daily').all();
    assert.equal(cells[0].runs, 20);
    assert.equal(cells[0].metrics.tokens_per_second_p50, 100);
    const app = require('express')();
    app.use(require('../server/api/measured-metrics').measuredMetricsRouter({ db }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/exchange/metrics/status`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
        const body = await res.json();
        assert.equal(body.published_cells, 1);
        assert.equal(body.minimum_samples, 20);
        assert(!JSON.stringify(body).includes('private'));
    } finally { await new Promise((resolve) => server.close(resolve)); }
    assert.equal((await createMetricsRollup(options).tick()).skipped, 'not_due');
    await db.prepare('DELETE FROM ai_receipts').run();
    now += 5 * 86400000;
    await createMetricsRollup(options).tick();
    assert.equal((await db.prepare('SELECT * FROM exchange_metrics_daily').all()).length, 1, 'expired receipts never erase published history');
});
t.test('close', async () => { if (testdb) await testdb.close(); });
t.run();
