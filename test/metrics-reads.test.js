'use strict';
const assert = require('assert');
const { suite } = require('./helpers');
const { aggregate } = require('../server/exchange/metrics-rollup');
const { healthCells, createObservations } = require('../server/exchange/metrics-observations');
const t = suite('metrics-reads');
const now = Date.parse('2026-11-10T12:30:00Z');
const clock = { now: () => now };
const offers = [{ key: 'openai', provider: 'openai', keyModel: 'gpt-test', model: 'openai/gpt-test' }];
const row = { provider: 'openai', model: 'gpt-test', workflow: 'ai.complete', status: 'succeeded', latency_ms: 1000, ttft_ms: 200, tokens_out: 80, cost_usd: 0.01, hour: '2026-11-10T11:00:00Z' };
let testdb, server, base;
async function get(path, opts = {}) { const res = await fetch(base + '/api/v1/exchange/metrics' + path, opts); const text = await res.text(); return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }; }
t.test('boot with published daily evidence for two models', async () => {
    testdb = await require('./db').testDb();
    const db = testdb.db;
    const metrics = aggregate(Array(20).fill(row), offers)[0].metrics;
    for (const [model, day, latency] of [['openai/gpt-test', '2026-11-09', 1000], ['openai/gpt-other', '2026-11-09', 2000], ['openai/gpt-test', '2026-09-10', 3000]]) {
        await db.prepare(`INSERT INTO exchange_metrics_daily (day, model, provider, task_kind, runs, metrics, computed_at)
            VALUES (?::date, ?, 'openai', 'chat', 20, ?::jsonb, ?::timestamptz)`).run(day, model, JSON.stringify({ ...metrics, latency_p50_ms: latency }), new Date(now).toISOString());
    }
    const app = require('express')();
    app.use(require('../server/api/measured-metrics').measuredMetricsRouter({ db, clock, log: { error() {} } }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
t.test('30/90-day series, six-model bound, selected measures, same-day ranking and CORS', async () => {
    assert.equal((await get('/models/openai%2Fgpt-test?days=30')).body.series.length, 1);
    assert.equal((await get('/models/openai%2Fgpt-test?days=90')).body.series.length, 2);
    const comparison = await get('/compare?models=openai/gpt-test,openai/gpt-other&kind=chat&measures=latency_p50_ms');
    assert.equal(comparison.status, 200);
    assert.equal(comparison.headers.get('access-control-allow-origin'), '*');
    assert.equal(comparison.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(comparison.body.day, '2026-11-09');
    assert.deepEqual(comparison.body.models.map((m) => m.cells[0].latency_p50_ms), [1000, 2000]);
    assert(!Object.hasOwn(comparison.body.models[0].cells[0], 'cost_per_run_usd'));
    assert.equal((await get('/leaderboard?kind=chat&measure=latency_p50_ms')).body.rows[0].model, 'openai/gpt-test');
    const preflight = await fetch(base + '/api/v1/exchange/metrics/compare', { method: 'OPTIONS', headers: { Origin: 'https://example.test', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'traceparent,x-openvibe-request-id,content-type' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    const allowed = preflight.headers.get('access-control-allow-headers').toLowerCase().split(/,\s*/);
    for (const header of ['traceparent', 'x-openvibe-request-id', 'content-type']) assert(allowed.includes(header), header);
    for (const path of ['/compare?models=a,b,c,d,e,f,g', '/compare?models=a&measures=made_up', '/models/a?days=365', '/leaderboard?kind=private-site', '/compare?models=a&day=2026-02-31']) {
        const invalid = await get(path);
        assert.equal(invalid.status, 422, path);
        assert.equal(invalid.headers.get('cache-control'), 'no-store');
    }
});
t.test('hourly health withholds sparse cohorts and sparse latency separately', () => {
    assert.deepEqual(healthCells(Array(19).fill(row), offers), []);
    const health = healthCells([...Array(19).fill(row), { ...row, status: 'failed' }], offers)[0];
    assert.equal(health.runs, 20);
    assert.equal(health.success_rate, 0.95);
    assert.equal(health.latency_p50_ms, null);
    assert.equal(health.latency_samples, null);
});
t.test('hour job records receipts and daily catalogue prices once across restarts', async () => {
    const db = testdb.db;
    for (let i = 0; i < 20; i++) {
        const id = `health_${i}`;
        await db.prepare(`INSERT INTO runs (id, workflow_key, workflow_version, status, requester_type, requester_id, input, input_hash, created_at, started_at, finished_at)
            VALUES (?, 'ai.complete', 1, 'succeeded', 'service', 'private', '{}', 'hash', ?, '2026-11-10T11:00:00Z', '2026-11-10T11:00:01Z')`)
            .run(id, row.hour);
        await db.prepare('INSERT INTO ai_receipts (id, run_id, body, created_at) VALUES (?, ?, ?::jsonb, ?::timestamptz)').run(id, id,
            JSON.stringify({ offer: { provider: row.provider, model: row.model }, latency_ms: null }), row.hour);
    }
    const registry = { listProviders: async () => [{ key: 'openai', kind: 'openai' }], listModels: async () => [{ provider_key: 'openai', model_key: 'gpt-test', metadata: { id: 'openai/gpt-test' } }] };
    const catalog = { models: async () => ({ models: [{ slug: 'openai/gpt-test', offers: [{ provider: 'openai', model: 'gpt-test', price: { in: 0.1, out: 0.5 }, price_source: 'https://example.test/prices' }] }] }) };
    assert.deepEqual(await createObservations({ db, registry, catalog, clock }).tick(), { hours: 1, prices: 1 });
    assert.equal((await createObservations({ db, registry, catalog, clock }).tick()).skipped, 'not_due');
    await db.prepare('UPDATE exchange_observations_job SET algorithm_version = 1 WHERE id = 1').run();
    assert.deepEqual(await createObservations({ db, registry, catalog, clock }).tick(), { hours: 1, prices: 0 });
    const prices = await get('/prices/openai%2Fgpt-test');
    assert.equal(prices.body.series[0].price_out, 0.5);
    const health = await get('/providers/openai');
    assert.equal(health.body.series.length, 1);
    assert.equal(health.body.series[0].latency_p50_ms, 1000);
    assert(!JSON.stringify(health.body).includes('private'));
});
t.test('close', async () => { if (server) await new Promise((r) => server.close(r)); if (testdb) await testdb.close(); });
t.run();
