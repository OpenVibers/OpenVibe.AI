'use strict';
// platform.usage-sample@1 readings: one per accounted run, queued in the same transaction as the run's
// usage and posted to billing.usage.record by a retry-safe outbox (server/usage-samples.js). A reading
// carries ids, tokens and cost — never the prompt, the input or the output.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, request, token, suite, seamServer, tmpDir, ALL } = require('./helpers');

const t = suite('usage-sample');
const live = token('live', ALL);
const usageSamples = require('../server/usage-samples');
let h;
let seam;
let b;   // the Billing stub the live relay posts through
const env = { AI_STUB_FALLBACK: 'false' };

const readings = async () => (await h.db.prepare('SELECT event_id, envelope, sent_at, attempts FROM usage_sample_outbox ORDER BY id').all())
    .map((r) => ({ ...r, envelope: typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope }));

function fakeBilling() {
    const b = { fail: false, got: [] };
    b.fetch = async (url, init = {}) => {
        if (String(url).endsWith('/oauth/token')) {
            return new Response(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300, scope: 'billing.usage.record' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (String(url).endsWith('/api/v1/usage')) {
            if (b.fail) return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
            b.got.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ record: { id: 'use_1' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('not found', { status: 404 });
    };
    return b;
}

t.test('boot with a counting seam provider as the only route target', async () => {
    seam = await seamServer(() => ({ text: 'ok', usage: { input: 1000, output: 1000 } }));
    h = await boot({ dir: tmpDir(), env });   // a dir: the database outlives h.stop()
    await request(h.base, 'POST', '/api/v1/providers', { tok: live, body: { key: 'seam', kind: 'http', base_url: seam.url, auth_mode: 'none', capabilities: ['generate', 'chat'] } });
    await request(h.base, 'POST', '/api/v1/models', { tok: live, body: { provider_key: 'seam', model_key: 'm1', cost: { in_per_mtok: 1000, out_per_mtok: 1000 } } });
    const r = await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: live, body: { primary: { provider: 'seam', model: 'm1' }, fallbacks: [] } });
    assert.strictEqual(r.status, 201, r.text);
});

t.test('a succeeded run queues exactly one valid reading that keeps the prompt out', async () => {
    const r = await request(h.base, 'POST', '/api/v1/generate', { tok: live, body: { prompt: 'secret prompt words', options: { cache: false } } });
    assert.strictEqual(r.status, 201, r.text);
    const runId = r.body.run.id;
    const rows = await readings();
    assert.strictEqual(rows.length, 1, 'exactly one reading');
    const s = rows[0].envelope;
    const v = contracts.validate('platform.usage-sample@1', s);
    assert.ok(v.valid, `platform.usage-sample@1: ${JSON.stringify(v.errors)}`);
    assert.strictEqual(s.idempotency_key, `ai:${runId}:tokens`);
    assert.strictEqual(s.id, `ai:${runId}:tokens`);
    assert.strictEqual(rows[0].event_id, s.idempotency_key);
    assert.strictEqual(s.service, 'ai');
    assert.strictEqual(s.operation, 'ai.generate');
    assert.strictEqual(s.unit, 'tokens');
    assert.strictEqual(s.quantity, 2000);
    assert.ok(s.cost_estimate > 0, 'cost is carried');
    assert.strictEqual(s.subject, 'service:live');
    assert.ok(!JSON.stringify(s).includes('secret prompt'), 'no prompt');
    const got = await request(h.base, 'GET', `/api/v1/runs/${runId}`, { tok: live });
    assert.strictEqual(got.body.run.usage.usage_sample_id, `ai:${runId}:tokens`);
});

t.test('a cache hit writes its own zero reading', async () => {
    const body = { prompt: 'cache me for a reading' };
    const a = await request(h.base, 'POST', '/api/v1/generate', { tok: live, body });
    const b = await request(h.base, 'POST', '/api/v1/generate', { tok: live, body });
    assert.strictEqual(b.status, 201, b.text);
    if (b.body.run.status !== 'cached') { assert.ok(a.body.run.id, 'this workflow may not cache'); return; }
    const s = (await readings()).find((r) => r.event_id === `ai:${b.body.run.id}:tokens`).envelope;
    const v = contracts.validate('platform.usage-sample@1', s);
    assert.ok(v.valid, `platform.usage-sample@1: ${JSON.stringify(v.errors)}`);
    assert.strictEqual(s.quantity, 0);
    assert.strictEqual(s.cost_estimate, 0);
});

t.test('recording the same run again leaves one row, unchanged', async () => {
    const runId = (await h.db.prepare("SELECT id FROM runs WHERE status = 'succeeded' ORDER BY id LIMIT 1").get()).id;
    const key = `ai:${runId}:tokens`;
    await h.db.tx(async () => { await usageSamples.record(h.db, { runId, workflowKey: 'ai.generate', requester: 'service:live', tokensIn: 1, tokensOut: 0, cost: 0, at: Date.now() }); });
    const rows = (await readings()).filter((r) => r.event_id === key);
    assert.strictEqual(rows.length, 1, 'one row');
    assert.strictEqual(rows[0].envelope.quantity, 2000, 'the first reading is unchanged');
});

t.test('a failed send stays queued and replays', async () => {
    usageSamples._reset();
    b = fakeBilling();
    b.fail = true;
    const relay = usageSamples.init(h.db, { billingUrl: 'http://billing.test', clientSecret: 's', networkUrl: 'http://network.test', fetchImpl: b.fetch, intervalMs: 60000 });
    await relay.flush();
    // batchSize is 1 and a failed pass stops there: flush until every row has been attempted once.
    for (let i = 0; i < 10 && (await readings()).some((r) => r.sent_at === null && r.attempts === 0); i++) await relay.flush();
    const pending = await readings();
    assert.ok(pending.length >= 1, 'rows exist');
    for (const r of pending) { assert.strictEqual(r.sent_at, null, 'every row is unsent'); assert.ok(r.attempts >= 1, 'the send was attempted'); }
    assert.strictEqual(b.got.length, 0, 'nothing accepted');
    b.fail = false;
    await h.db.prepare('UPDATE usage_sample_outbox SET next_attempt_at = 0').run();
    await relay.flush();
    const sent = await readings();
    for (const r of sent) assert.notStrictEqual(r.sent_at, null, 'every row is sent');
    const keys = b.got.map((s) => s.idempotency_key).sort();
    assert.deepStrictEqual(keys, sent.map((r) => r.event_id).sort());
    for (const s of b.got) assert.ok(contracts.validate('platform.usage-sample@1', s).valid, JSON.stringify(s));
});

t.test('the outbox outlives a restart', async () => {
    b.fail = true;   // the still-running relay fails every send
    const r = await request(h.base, 'POST', '/api/v1/generate', { tok: live, body: { prompt: 'survive a restart', options: { cache: false } } });
    assert.strictEqual(r.status, 201, r.text);
    const key = `ai:${r.body.run.id}:tokens`;
    await h.stop();
    h = await boot({ dir: h.dir, env });
    const row = await h.db.prepare('SELECT sent_at FROM usage_sample_outbox WHERE event_id = ?').get(key);
    assert.ok(row, 'the reading is still there');
    assert.strictEqual(row.sent_at, null, 'and unsent');
    usageSamples._reset();
    b = fakeBilling();
    const relay = usageSamples.init(h.db, { billingUrl: 'http://billing.test', clientSecret: 's', networkUrl: 'http://network.test', fetchImpl: b.fetch, intervalMs: 60000 });
    await h.db.prepare('UPDATE usage_sample_outbox SET next_attempt_at = 0').run();
    await relay.flush();
    assert.strictEqual(b.got.filter((s) => s.idempotency_key === key).length, 1, 'sent exactly once');
});

t.test('free_allowance_used: the free share when some was free, never more than the quantity, absent at 0', () => {
    const base = { runId: 'run_x', workflowKey: 'ai.generate', requester: 'service:live', provider: 'seam', tokensIn: 300, tokensOut: 100, cost: 0.1, at: Date.UTC(2026, 9, 4) };
    const some = usageSamples.sampleOf({ ...base, freeAllowanceUsed: 150 });
    assert.strictEqual(some.free_allowance_used, 150);
    assert.ok(contracts.validate('platform.usage-sample@1', some).valid);
    assert.strictEqual(usageSamples.sampleOf({ ...base, freeAllowanceUsed: 9999 }).free_allowance_used, 400);
    assert.ok(!('free_allowance_used' in usageSamples.sampleOf({ ...base, freeAllowanceUsed: 0 })));
    assert.ok(!('free_allowance_used' in usageSamples.sampleOf(base)));
});

t.test('runs on default cards (free_allowance 0) carry no free_allowance_used', async () => {
    for (const r of await readings()) assert.ok(!('free_allowance_used' in r.envelope), JSON.stringify(r.envelope));
});

t.test('shutdown', async () => { usageSamples._reset(); await h.stop(); await seam.close(); });

t.run();
