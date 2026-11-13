'use strict';
/**
 * POST /api/v1/usage/calls (Contracts 0.421.0, ai-metrics.md): a product reports the AI calls it made without
 * OpenVibe.AI. AI validates ai.call-report@1, keeps a subject only for the person its token acts for, dedupes by
 * system + run_id/turn_id, prices an unpriced call from its own rate cards, publishes ai.call.recorded@1 and
 * refuses a token without ai.usage.report.
 */
const assert = require('assert');

process.env.EVENTS_URL = 'http://127.0.0.1:9';           // unreachable: the published events stay in the outbox
process.env.OV_OAUTH_CLIENT_SECRET = 'ai-secret-for-tests';
process.env.OV_NETWORK_INTERNAL_URL = 'http://127.0.0.1:9';

const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('usage-calls');
const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const actor = token('actor', ['ai.usage.report'], { extra: { on_behalf_of: USR } });
const plain = token('codes', ['ai.usage.report']);
const noReport = token('codes', ALL);
const admin = token('live', ALL);
let h;

const calls = async () => (await h.db.prepare("SELECT envelope FROM event_outbox WHERE envelope->>'event_type' = 'ai.call.recorded' ORDER BY id").all())
    .map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope).payload);
const at = () => new Date().toISOString();

t.test('boot with events on and a priced provider/model', async () => {
    h = await boot({ env: { AI_STUB_FALLBACK: 'true' } });
    const p = await request(h.base, 'POST', '/api/v1/providers', { tok: admin, body: {
        key: 'priced', kind: 'http', auth_mode: 'none', base_url: 'http://127.0.0.1:1', default_model: 'm1',
        capabilities: ['chat', 'generate', 'json'], timeout_ms: 5000 } });
    assert.strictEqual(p.status, 201, p.text);
    const m = await request(h.base, 'POST', '/api/v1/models', { tok: admin, body: {
        provider_key: 'priced', model_key: 'm1', type: 'chat',
        cost: { in_per_mtok: 1, out_per_mtok: 2, cached_per_mtok: 0.1, source: 'urn:openvibe:ai:test', verified_at: '2026-01-01' } } });
    assert.strictEqual(m.status, 201, m.text);
});

t.test('a valid report is accepted, keeps the subject its token acts for, and is priced from the rate card', async () => {
    const r = await request(h.base, 'POST', '/api/v1/usage/calls', { tok: actor, body: { calls: [{
        system: 'actor', provider: 'priced', model: 'm1', outcome: 'succeeded', at: at(), run_id: 'run_REPORT0000000000000000001',
        subject: USR, attribution: 'site:actor', surface: 'actor.turn', paid_by: 'openvibe_key',
        input: 1000000, output: 1000000, operation: 'chat', streamed: true, tps: 22.5, queue_ms: 7,
        task: 'actor.turn', task_id: 'actor_task_1', fallbacks: 1, place: 'provider',
    }] } });
    assert.strictEqual(r.status, 202, r.text);
    assert.deepStrictEqual(r.body, { accepted: 1, duplicates: 0, rejected: [] });
    const ev = (await calls()).find((p) => p.run_id === 'run_REPORT0000000000000000001');
    assert.ok(ev, 'the accepted call was published as ai.call.recorded@1');
    assert.strictEqual(ev.subject, USR, 'a service acting for the person keeps their subject');
    assert.strictEqual(ev.input, 1000000);
    assert.strictEqual(ev.list_cost_usd, 3, '1M in at $1/M and 1M out at $2/M');
    assert.strictEqual(ev.charged_usd, 3, 'the OpenVibe key pays the list cost');
    assert.strictEqual(ev.price_source, 'catalog', 'AI priced it from its own rate card');
    assert.strictEqual(ev.price_date, '2026-01-01');
    assert.strictEqual(ev.operation, 'chat');
    assert.strictEqual(ev.streamed, true);
    assert.strictEqual(ev.tps, 22.5);
    assert.strictEqual(ev.queue_ms, 7);
    assert.strictEqual(ev.task, 'actor.turn');
    assert.strictEqual(ev.task_id, 'actor_task_1');
    assert.strictEqual(ev.fallbacks, 1);
    assert.strictEqual(ev.place, 'provider');
    assert.strictEqual(ev.cache_hit, false);
});

t.test('the same report twice is recorded once and counted as a duplicate', async () => {
    const body = { calls: [{
        system: 'actor', provider: 'priced', model: 'm1', outcome: 'succeeded', at: at(), run_id: 'run_REPORT0000000000000000002',
        input: 10, output: 10, paid_by: 'openvibe_key',
    }] };
    const first = await request(h.base, 'POST', '/api/v1/usage/calls', { tok: actor, body });
    assert.deepStrictEqual(first.body, { accepted: 1, duplicates: 0, rejected: [] }, first.text);
    const second = await request(h.base, 'POST', '/api/v1/usage/calls', { tok: actor, body });
    assert.strictEqual(second.status, 202, second.text);
    assert.deepStrictEqual(second.body, { accepted: 0, duplicates: 1, rejected: [] });
    assert.strictEqual((await calls()).filter((p) => p.run_id === 'run_REPORT0000000000000000002').length, 1, 'one event, not two');
    // Another service's report with the same ids is its own call: one product can never block another's.
    const other = await request(h.base, 'POST', '/api/v1/usage/calls', { tok: plain, body });
    assert.deepStrictEqual(other.body, { accepted: 1, duplicates: 0, rejected: [] }, other.text);
});

t.test('a token that does not act for the person keeps no subject; no rate card means unknown with zeros', async () => {
    const r = await request(h.base, 'POST', '/api/v1/usage/calls', { tok: plain, body: { calls: [{
        system: 'codes', provider: 'no-such-provider', model: 'no-such-model', outcome: 'succeeded', at: at(),
        turn_id: 'turn_REPORT0000000000000000003', subject: USR, input: 100, output: 100,
    }] } });
    assert.strictEqual(r.status, 202, r.text);
    assert.strictEqual(r.body.accepted, 1, r.text);
    const ev = (await calls()).find((p) => p.turn_id === 'turn_REPORT0000000000000000003');
    assert.ok(ev, 'the turn was published');
    assert.strictEqual(ev.subject, null, 'a service that does not act for the person may not name them');
    assert.strictEqual(ev.price_source, 'unknown');
    assert.deepStrictEqual([ev.list_cost_usd, ev.charged_usd, ev.fee_usd, ev.cache_saved_usd], [0, 0, 0, 0]);
});

t.test('an invalid call is rejected with its index; the valid ones are accepted', async () => {
    const r = await request(h.base, 'POST', '/api/v1/usage/calls', { tok: actor, body: { calls: [
        { system: 'actor', provider: 'priced', model: 'm1', outcome: 'succeeded', at: at(), run_id: 'run_REPORT0000000000000000004' },
        { system: 'actor', provider: 'priced', model: 'm1', outcome: 'made_up', at: at(), run_id: 'run_REPORT0000000000000000005' },
    ] } });
    assert.strictEqual(r.status, 202, r.text);
    assert.strictEqual(r.body.accepted, 1);
    assert.strictEqual(r.body.duplicates, 0);
    assert.strictEqual(r.body.rejected.length, 1);
    assert.strictEqual(r.body.rejected[0].index, 1, 'the rejected item names its index');
    assert.ok(/outcome|enum/i.test(r.body.rejected[0].error), r.body.rejected[0].error);
    assert.ok((await calls()).some((p) => p.run_id === 'run_REPORT0000000000000000004'));
    assert.ok(!(await calls()).some((p) => p.run_id === 'run_REPORT0000000000000000005'));
});

t.test('a token without ai.usage.report is refused', async () => {
    const r = await request(h.base, 'POST', '/api/v1/usage/calls', { tok: noReport, body: { calls: [{
        system: 'actor', provider: 'priced', model: 'm1', outcome: 'succeeded', at: at(), run_id: 'run_REPORT0000000000000000006',
    }] } });
    assert.strictEqual(r.status, 403, r.text);
    assert.strictEqual(r.body.code, 'capability.denied');
});

t.test('close', async () => { await h.stop(); });

t.run();
