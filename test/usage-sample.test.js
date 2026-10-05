'use strict';
// platform.usage-sample@1 readings: one per finished provider attempt per token metric, queued in the same
// transaction as the run's usage and posted to billing.usage.record by a retry-safe outbox (server/usage-samples.js).
// A reading carries ids, tokens and cost — never the prompt, the input or the output.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const rates = require('../server/providers/rate-cards');
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

// Billing's ops/rating.js unitFits(): the unit (case/spacing/plural-s aside) is the card metric or its leading word.
const unitKey = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/s$/, '');
const unitFits = (metric, unit) => { const u = unitKey(unit); const m = unitKey(metric); return !!u && (u === m || m.startsWith(`${u}-`)); };

function fakeBilling() {
    const b = { fail: false, refuse: false, got: [] };
    b.fetch = async (url, init = {}) => {
        if (String(url).endsWith('/oauth/token')) {
            return new Response(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300, scope: 'billing.usage.record' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (String(url).endsWith('/api/v1/usage')) {
            if (b.refuse) return new Response(JSON.stringify({ error: 'invalid' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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

t.test('a succeeded run queues one valid reading per attempt per token kind, each under its rate-card metric', async () => {
    const r = await request(h.base, 'POST', '/api/v1/generate', { tok: live, body: { prompt: 'secret prompt words', options: { cache: false } } });
    assert.strictEqual(r.status, 201, r.text);
    const runId = r.body.run.id;
    const rows = await readings();
    assert.deepStrictEqual(rows.map((x) => x.envelope.idempotency_key), ['in', 'cached', 'out'].map((k) => `ai:${runId}:0:${k}`), 'one per kind, in order');
    const qty = { in: 1000, cached: 0, out: 1000 };
    for (const x of rows) {
        const s = x.envelope;
        const kind = s.idempotency_key.split(':')[3];
        const v = contracts.validate('platform.usage-sample@1', s);
        assert.ok(v.valid, `platform.usage-sample@1: ${JSON.stringify(v.errors)}`);
        assert.strictEqual(x.event_id, s.idempotency_key);
        assert.strictEqual(s.id, s.idempotency_key);
        assert.strictEqual(s.service, 'ai');
        assert.strictEqual(s.operation, 'ai.generate');
        assert.strictEqual(s.provider, 'seam');
        assert.strictEqual(s.resource, rates.metricFor(kind, 'm1'), 'resource is the rate-card metric');
        assert.ok(unitFits(s.resource, s.unit), `unit ${s.unit} fits metric ${s.resource}`);
        assert.strictEqual(s.unit, usageSamples.UNIT[kind]);
        assert.strictEqual(s.quantity, qty[kind], `${kind} quantity`);
        assert.strictEqual(s.subject, 'service:live');
        if (kind === 'in' || kind === 'out') assert.ok(s.cost_estimate > 0, 'cost is carried'); else assert.strictEqual(s.cost_estimate, 0);
        assert.ok(!JSON.stringify(s).includes('secret prompt'), 'no prompt');
    }
    // A Billing card with that provider+metric picks the reading, and its unit fits it.
    const card = { id: 'seam:m1/input-tokens', provider: 'seam', metric: rates.metricFor('in', 'm1'), unit_size: 1e6, unit_price_usd: 1000 };
    const inp = rows.find((x) => x.envelope.unit === 'input').envelope;
    assert.deepStrictEqual([card.provider === inp.provider, card.metric === inp.resource, unitFits(card.metric, inp.unit)], [true, true, true], 'rateable');
    const got = await request(h.base, 'GET', `/api/v1/runs/${runId}`, { tok: live });
    assert.deepStrictEqual(got.body.run.usage.usage_sample_ids, rows.map((x) => x.envelope.idempotency_key));
    // explain carries the readings: their keys and delivery state (no relay here, so they wait queued).
    const us = got.body.run.explain.usage_readings;
    assert.deepStrictEqual(us.map((u) => u.idempotency_key), rows.map((x) => x.envelope.idempotency_key));
    assert.ok(us.every((u) => u.state === 'queued' && u.attempts === 0 && u.last_error === null));
    assert.ok(us.every((u) => !('free_allowance_used' in u)), 'nothing was free');
    assert.ok(Array.isArray(got.body.run.explain.candidates), 'the placement explain is kept');
});

t.test('a cache hit writes its own zero reading', async () => {
    const body = { prompt: 'cache me for a reading' };
    const a = await request(h.base, 'POST', '/api/v1/generate', { tok: live, body });
    const b = await request(h.base, 'POST', '/api/v1/generate', { tok: live, body });
    assert.strictEqual(b.status, 201, b.text);
    if (b.body.run.status !== 'cached') { assert.ok(a.body.run.id, 'this workflow may not cache'); return; }
    const key = `ai:${b.body.run.id}:0:in`;
    assert.deepStrictEqual(b.body.run.usage.usage_sample_ids, [key]);
    const s = (await readings()).find((r) => r.event_id === key).envelope;
    const v = contracts.validate('platform.usage-sample@1', s);
    assert.ok(v.valid, `platform.usage-sample@1: ${JSON.stringify(v.errors)}`);
    assert.strictEqual(s.quantity, 0);
    assert.strictEqual(s.cost_estimate, 0);
    assert.ok(unitFits(s.resource, s.unit));
});

t.test('recording the same run again leaves the rows, unchanged', async () => {
    const runId = (await h.db.prepare("SELECT id FROM runs WHERE status = 'succeeded' ORDER BY id LIMIT 1").get()).id;
    const before = (await readings()).filter((r) => r.event_id.startsWith(`ai:${runId}:`));
    await h.db.tx(async () => {
        await usageSamples.record(h.db, { runId, workflowKey: 'ai.generate', requester: 'service:live', at: Date.now(),
            readings: before.map((r) => ({ attempt: 0, kind: r.envelope.idempotency_key.split(':')[3], model: 'm1', quantity: r.envelope.quantity, cost: 0, freeAllowanceUsed: 0 })) });
    });
    const after = (await readings()).filter((r) => r.event_id.startsWith(`ai:${runId}:`));
    assert.strictEqual(after.length, before.length, 'no new rows');
    assert.strictEqual(after[0].envelope.quantity, before[0].envelope.quantity, 'the first reading is unchanged');
    assert.strictEqual(after[0].envelope.quantity, 1000);
});

t.test('a failed send stays queued and replays', async () => {
    usageSamples._reset();
    b = fakeBilling();
    b.fail = true;
    const relay = usageSamples.init(h.db, { billingUrl: 'http://billing.test', clientSecret: 's', networkUrl: 'http://network.test', fetchImpl: b.fetch, intervalMs: 60000 });
    await relay.flush();
    // batchSize is 1 and a failed pass stops there: flush until every row has been attempted once.
    for (let i = 0; i < 20 && (await readings()).some((r) => r.sent_at === null && r.attempts === 0); i++) await relay.flush();
    const pending = await readings();
    assert.ok(pending.length >= 1, 'rows exist');
    for (const r of pending) { assert.strictEqual(r.sent_at, null, 'every row is unsent'); assert.ok(r.attempts >= 1, 'the send was attempted'); }
    assert.strictEqual(b.got.length, 0, 'nothing accepted');
    const explainOf = async (key) => (await request(h.base, 'GET', `/api/v1/runs/${key.split(':')[1]}`, { tok: live })).body.run.explain.usage_readings.find((u) => u.idempotency_key === key);
    let u = await explainOf(pending[0].event_id);
    assert.strictEqual(u.state, 'queued', 'a transient failure is retried');
    assert.match(u.last_error, /billing\.usage\.record answered 503/);
    assert.ok(u.attempts >= 1 && u.next_attempt_at, JSON.stringify(u));
    b.fail = false;
    await h.db.prepare('UPDATE usage_sample_outbox SET next_attempt_at = 0').run();
    await relay.flush();
    for (let i = 0; i < 20 && (await readings()).some((r) => r.sent_at === null); i++) await relay.flush();
    const sent = await readings();
    for (const r of sent) assert.notStrictEqual(r.sent_at, null, 'every row is sent');
    const keys = b.got.map((s) => s.idempotency_key).sort();
    assert.deepStrictEqual(keys, sent.map((r) => r.event_id).sort());
    for (const s of b.got) assert.ok(contracts.validate('platform.usage-sample@1', s).valid, JSON.stringify(s));
    u = await explainOf(pending[0].event_id);
    assert.strictEqual(u.state, 'sent');
    assert.strictEqual(u.last_error, null);
    assert.ok(u.sent_at);
});

t.test('the outbox outlives a restart', async () => {
    b.fail = true;   // the still-running relay fails every send
    const r = await request(h.base, 'POST', '/api/v1/generate', { tok: live, body: { prompt: 'survive a restart', options: { cache: false } } });
    assert.strictEqual(r.status, 201, r.text);
    const key = `ai:${r.body.run.id}:0:in`;
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
    const base = { runId: 'run_x', attempt: 2, kind: 'out', workflowKey: 'ai.generate', requester: 'service:live', provider: 'seam', model: 'm1', quantity: 300, cost: 0.1, at: Date.UTC(2026, 9, 4) };
    const some = usageSamples.sampleOf({ ...base, freeAllowanceUsed: 150 });
    assert.strictEqual(some.free_allowance_used, 150);
    assert.strictEqual(some.idempotency_key, 'ai:run_x:2:out');
    assert.strictEqual(some.resource, rates.metricFor('out', 'm1'));
    assert.ok(unitFits(some.resource, some.unit));
    assert.ok(contracts.validate('platform.usage-sample@1', some).valid);
    assert.strictEqual(usageSamples.sampleOf({ ...base, freeAllowanceUsed: 9999 }).free_allowance_used, 300);
    assert.ok(!('free_allowance_used' in usageSamples.sampleOf({ ...base, freeAllowanceUsed: 0 })));
    assert.ok(!('free_allowance_used' in usageSamples.sampleOf(base)));
});

t.test('runs on default cards (free_allowance 0) carry no free_allowance_used', async () => {
    for (const r of await readings()) assert.ok(!('free_allowance_used' in r.envelope), JSON.stringify(r.envelope));
});

t.test('a reading Billing refuses is failed, with its error, in explain and on the console report', async () => {
    usageSamples._reset();
    b = fakeBilling();
    const relay = usageSamples.init(h.db, { billingUrl: 'http://billing.test', clientSecret: 's', networkUrl: 'http://network.test', fetchImpl: b.fetch, intervalMs: 60000 });
    b.refuse = true;
    const r = await request(h.base, 'POST', '/api/v1/generate', { tok: live, body: { prompt: 'refused reading', options: { cache: false } } });
    assert.strictEqual(r.status, 201, r.text);
    await relay.flush();
    const [u] = (await request(h.base, 'GET', `/api/v1/runs/${r.body.run.id}`, { tok: live })).body.run.explain.usage_readings;
    assert.strictEqual(u.idempotency_key, `ai:${r.body.run.id}:0:in`);
    assert.strictEqual(u.state, 'failed');
    assert.match(u.last_error, /answered 400/);
    assert.ok(u.rejected_at);
    const report = await usageSamples.deliveryReport(h.db);
    assert.ok(report.relay && report.counts.failed >= 1 && report.counts.sent >= 1, JSON.stringify(report.counts));
    const f = report.failures.find((x) => x.idempotency_key === u.idempotency_key);
    assert.deepStrictEqual([f.run_id, f.state], [r.body.run.id, 'failed']);
});

t.test('shutdown', async () => { usageSamples._reset(); await h.stop(); await seam.close(); });

t.run();
