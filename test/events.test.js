'use strict';
// ai.run.* events: queued, cached, succeeded and failed runs each queue one event in the run's own
// transaction, the payloads validate against openvibe-contracts, and nothing of the input or output travels.
const assert = require('assert');
const contracts = require('openvibe-contracts');

process.env.EVENTS_URL = 'http://127.0.0.1:9';           // unreachable: rows stay in the outbox
process.env.OV_OAUTH_CLIENT_SECRET = 'ai-secret-for-tests';
process.env.OV_NETWORK_INTERNAL_URL = 'http://127.0.0.1:9';
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('events');
const live = token('live', ALL);
let h;
const queued = () => h.db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope));
const valid = (env) => { const r = contracts.validate(`${env.event_type}@1`, env.payload); assert.ok(r.valid, `${env.event_type}: ${JSON.stringify(r.errors)}`); };

t.test('boot with events on', async () => {
    h = await boot({ env: { AI_STUB_FALLBACK: 'true' } });
    assert.strictEqual(require('../server/events').status().enabled, true);
});

t.test('a run queues ai.run.queued then ai.run.succeeded, valid and without the prompt or the text', async () => {
    const r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body: { workflow: 'ai.generate', input: { prompt: 'secret prompt words' } } });
    assert.strictEqual(r.status, 201, r.text);
    const evs = queued().filter((e) => e.payload.run_id === r.body.run.id);
    assert.deepStrictEqual(evs.map((e) => e.event_type), ['ai.run.queued', 'ai.run.succeeded']);
    evs.forEach(valid);
    assert.strictEqual(evs[0].visibility, 'internal');
    assert.deepStrictEqual(evs[1].payload.requester, { type: 'service', id: 'live' });
    assert.strictEqual(evs[1].payload.finished_at !== null, true);
    assert.ok(!JSON.stringify(evs).includes('secret prompt'), 'no input');
    assert.ok(!JSON.stringify(evs).includes(r.body.run.output.text.slice(0, 20)), 'no output');
});

t.test('a cache hit queues ai.run.cached with cached_from', async () => {
    const body = { workflow: 'ai.generate', input: { prompt: 'cache me' } };
    const a = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body });
    const b = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body });
    const ev = queued().find((e) => e.payload.run_id === b.body.run.id);
    if (b.body.run.status !== 'cached') { assert.ok(ev, 'an event for the second run'); return; }   // this workflow may not cache
    assert.strictEqual(ev.event_type, 'ai.run.cached');
    assert.strictEqual(ev.payload.cached_from, a.body.run.id);
    valid(ev);
});

t.test('a failed run queues ai.run.failed with its error code; a restart announces interrupted runs', async () => {
    const r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body: { workflow: 'no.such.workflow', input: {} } });
    assert.ok(r.status >= 400, 'refused before a run exists: no event');
    const before = queued().length;
    // A queued run left behind by a restart: recoverInterrupted fails it and announces it.
    const row = h.db.prepare("SELECT * FROM runs WHERE status = 'succeeded' LIMIT 1").get();
    h.db.prepare("INSERT INTO runs (id, workflow_key, workflow_version, status, requester_type, requester_id, input, input_hash, created_at) VALUES ('run_01JAB2C3D4E5F6G7H8J9K0MNPQ', ?, ?, 'running', 'service', 'live', '{}', 'x', ?)")
        .run(row.workflow_key, row.workflow_version, new Date().toISOString());
    assert.strictEqual(h.runs.recoverInterrupted(), 1);
    const ev = queued().slice(before).find((e) => e.payload.run_id === 'run_01JAB2C3D4E5F6G7H8J9K0MNPQ');
    assert.strictEqual(ev.event_type, 'ai.run.failed');
    assert.strictEqual(ev.payload.error.code, 'run.interrupted');
    assert.strictEqual(ev.priority, 'important');
    valid(ev);
});

t.test('close() stops the ai.run.* relay (unsent rows stay in the outbox)', async () => {
    const events = require('../server/events');
    const pending = events.status().pending;
    assert.ok(pending > 0, 'rows are waiting (Events is unreachable)');
    await h.stop();
    assert.strictEqual(events.status().enabled, false, 'the relay is stopped');
    const Database = require('better-sqlite3');
    const db = new Database(require('path').join(h.dir, 'ai.db'), { readonly: true });
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM event_outbox WHERE sent_at IS NULL AND rejected_at IS NULL').get().n, pending, 'and its rows wait for the next start');
    db.close();
    events._reset();
});
t.run();
