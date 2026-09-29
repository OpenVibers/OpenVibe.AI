'use strict';
// T6 provider router, phase 0 (data layer): every finished attempt rolls into provider_stats_daily
// (counts, tokens, cost, a fixed-bucket p50/p95) and per-route placement_state (EWMA latency/error rate,
// alpha 0.2) in the SAME transaction as usage_daily. A failing rollup write rolls the accounting back
// with it; statsFor reads provider_stats_daily only, never the requests table.
//
// Requires migrations/0002_provider_router_stats.sql. Until it is applied this file prints a skip line.
const assert = require('assert');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');

const t = suite('router-stats');
const tok = token('live', ALL);
let h;
let seam;

async function provider(body) {
    const r = await request(h.base, 'POST', '/api/v1/providers', { tok, body: { kind: 'http', auth_mode: 'none', capabilities: ['chat', 'generate', 'json'], timeout_ms: 5000, ...body } });
    assert.strictEqual(r.status, 201, r.text);
}
async function route(primary, fallbacks) {
    const r = await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok, body: { primary: { provider: primary }, fallbacks: fallbacks.map((p) => ({ provider: p })), timeout_ms: 5000 } });
    assert.strictEqual(r.status, 201, r.text);
}
const generate = (prompt) => request(h.base, 'POST', '/api/v1/generate', { tok, body: { prompt, options: { cache: false } } });
const statsRow = (p, m = '') => h.db.prepare('SELECT * FROM provider_stats_daily WHERE provider = ? AND model = ?').get(p, m);
const placementRow = (k) => h.db.prepare('SELECT * FROM placement_state WHERE route_key = ?').get(k);
const usageRows = async () => (await h.db.prepare("SELECT COUNT(*)::bigint AS n FROM usage_daily WHERE requester = 'service:live'").get()).n;

t.test('boot with a working seam provider, a dead one, and the route pinned', async () => {
    seam = await seamServer(() => ({ text: 'a real answer', model: 'seam-model', usage: { input: 12, output: 4 } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_BREAKER_FAILURES: '5' } });
    const table = await h.db.prepare("SELECT to_regclass('provider_stats_daily') AS t").get();
    if (!table.t) {
        process.stdout.write('router-stats: skipped (migrations/0002_provider_router_stats.sql is not applied)\n');
        process.exit(0);
    }
    await provider({ key: 'seam', base_url: seam.url });
    await provider({ key: 'dead', base_url: 'http://127.0.0.1:1/x' });
    await route('seam', []);
});

t.test('a successful run rolls up one ok attempt: counts, tokens, cost, a percentile estimate', async () => {
    const r = await generate('hello');
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.run.status, 'succeeded');
    assert.strictEqual(r.body.run.provenance.provider, 'seam');
    const row = await statsRow('seam', 'seam-model');
    assert.ok(row, 'a provider_stats_daily row for the answered model');
    assert.strictEqual(row.requests, 1);
    assert.strictEqual(row.ok, 1);
    assert.strictEqual(row.errors, 0);
    assert.strictEqual(row.tokens_in, 12);
    assert.strictEqual(row.tokens_out, 4);
    assert.ok(Number(row.cost_usd_total) > 0, 'the attempt cost accumulated');
    assert.ok(row.latency_p50_ms >= 0 && row.latency_p95_ms >= row.latency_p50_ms, 'p50/p95 from the histogram');
    assert.strictEqual(row.latency_hist.map(Number).reduce((a, b) => a + b, 0), 1, 'the histogram counted this one attempt');
    const p = await placementRow('default.chat');
    assert.ok(p, 'a placement_state row for the route');
    assert.strictEqual(p.current_provider, 'seam');
    assert.strictEqual(p.current_model, 'seam-model');
    assert.strictEqual(p.ewma_error_rate, 0);
    assert.ok(p.ewma_latency_ms > 0, 'the first sample initialises the EWMA');
    assert.strictEqual(p.quality, null);
});

t.test('a failed run counts an error and moves the route EWMA by alpha 0.2', async () => {
    const before = await placementRow('default.chat');
    await route('dead', []);
    const r = await generate('nobody home');
    assert.strictEqual(r.body.run.status, 'failed');
    assert.strictEqual(r.body.run.error.code, 'provider.unavailable');
    const row = await statsRow('dead', '');
    assert.ok(row, 'the dead provider has a rollup row');
    assert.strictEqual(row.requests, 1);
    assert.strictEqual(row.ok, 0);
    assert.strictEqual(row.errors, 1);
    const attempt = await h.db.prepare("SELECT latency_ms FROM requests WHERE provider_key = 'dead' AND status = 'error' ORDER BY id DESC LIMIT 1").get();
    assert.ok(attempt && attempt.latency_ms != null, 'the failed attempt recorded a latency');
    const p = await placementRow('default.chat');
    assert.strictEqual(p.current_provider, 'dead');
    assert.ok(Math.abs(p.ewma_error_rate - 0.2) < 1e-9, `first error after a clean sample: got ${p.ewma_error_rate}`);
    assert.ok(Math.abs(p.ewma_latency_ms - (0.2 * attempt.latency_ms + 0.8 * before.ewma_latency_ms)) < 1e-6, 'latency EWMA');
    assert.ok(Math.abs(p.ewma_latency_ms - before.ewma_latency_ms) > 1e-9, 'the latency EWMA moved');
});

t.test('a failing rollup write rolls the accounting back with it', async () => {
    await route('seam', []);
    const seamBefore = await statsRow('seam', 'seam-model');
    const usageBefore = await usageRows();
    // Mirror test/events.test.js: interpose on the write the rollup goes through and make it reject, then
    // assert the accounting in the same transaction rolled back with it. (No DDL: the pg runtime role may
    // not create a trigger.)
    const realQuery = h.db.query.bind(h.db);
    h.db.query = async (text, values) => {
        if (typeof text === 'string' && text.includes('provider_stats_daily')) throw new Error('rollup write failed');
        return await realQuery(text, values);
    };
    try {
        const r = await generate('rollback please');
        assert.strictEqual(r.body.run.status, 'succeeded', 'the provider still answered');
    } finally {
        h.db.query = realQuery;
    }
    const seamAfter = await statsRow('seam', 'seam-model');
    assert.strictEqual(await usageRows(), usageBefore, 'usage_daily rolled back with the failed rollup');
    assert.strictEqual(seamAfter.requests, seamBefore.requests, 'the rollup row did not move');
});

t.test('statsFor totals provider_stats_daily only, never the requests table', async () => {
    await h.db.query('DELETE FROM requests');
    assert.strictEqual((await h.db.prepare('SELECT COUNT(*)::bigint AS n FROM requests').get()).n, 0, 'requests is empty');
    const rows = await h.quotas.statsFor({ days: 7 });
    const seamRow = rows.find((r) => r.provider === 'seam' && r.model === 'seam-model');
    const deadRow = rows.find((r) => r.provider === 'dead');
    assert.ok(seamRow && seamRow.requests >= 1 && seamRow.ok >= 1 && seamRow.errors === 0, 'seam totals from the rollup');
    assert.ok(deadRow && deadRow.errors >= 1, 'dead totals from the rollup');
    assert.ok(Number(seamRow.cost_usd_total) > 0, 'cost totalled');
});

t.test('shutdown', async () => { await h.stop(); await seam.close(); });
t.run();
