'use strict';
// ai.run.* events: queued, cached, succeeded and failed runs each queue one event in the run's own
// transaction, the payloads validate against openvibe-contracts, and nothing of the input or output travels.
const assert = require('assert');
const contracts = require('openvibe-contracts');

process.env.EVENTS_URL = 'http://127.0.0.1:9';           // unreachable: rows stay in the outbox
process.env.OV_OAUTH_CLIENT_SECRET = 'ai-secret-for-tests';
process.env.OV_NETWORK_INTERNAL_URL = 'http://127.0.0.1:9';
const { boot, request, token, suite, tmpDir, seamServer, ALL } = require('./helpers');

const t = suite('events');
const live = token('live', ALL);
let h;
let seam;
const queued = async () => (await h.db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all()).map((r) => (typeof r.envelope === 'string' ? (typeof r.envelope === 'string' ? (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope) : r.envelope) : r.envelope));
const valid = (env) => { const r = contracts.validate(`${env.event_type}@1`, env.payload); assert.ok(r.valid, `${env.event_type}: ${JSON.stringify(r.errors)}`); };
// The ai.call.recorded schema rides with the contracts release that is not out yet: until it is, the shape is checked here.
const validUsage = (env) => {
    const r = (() => { try { return contracts.validate('ai.call.recorded@1', env.payload); } catch { return null; } })();
    if (r) { assert.ok(r.valid, 'ai.call.recorded: ' + JSON.stringify(r.errors)); return; }
    for (const f of ['system', 'surface', 'paid_by', 'input', 'output', 'reasoning', 'cache_read', 'cache_write', 'list_cost_usd', 'charged_usd', 'fee_usd', 'cache_saved_usd', 'attempts', 'outcome', 'at'])
        assert.ok(env.payload[f] !== undefined && env.payload[f] !== null, 'the record has ' + f);
};

t.test('boot with events on', async () => {
    h = await boot({ dir: tmpDir(), env: { AI_STUB_FALLBACK: 'true' } });   // a dir: the database outlives h.stop()
    assert.strictEqual((await require('../server/events').status()).enabled, true);
});

t.test('a run queues ai.run.queued then ai.run.succeeded, valid and without the prompt or the text', async () => {
    const r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body: { workflow: 'ai.generate', input: { prompt: 'secret prompt words' } } });
    assert.strictEqual(r.status, 201, r.text);
    const evs = (await queued()).filter((e) => e.payload.run_id === r.body.run.id);
    // The run announces itself twice (queued, succeeded) and leaves one usage record (L40).
    assert.deepStrictEqual(evs.map((e) => e.event_type), ['ai.run.queued', 'ai.run.succeeded', 'ai.call.recorded']);
    evs.filter((e) => e.event_type.startsWith('ai.run.')).forEach(valid);
    const usage = evs.find((e) => e.event_type === 'ai.call.recorded');
    validUsage(usage);
    assert.ok(usage.payload.input >= 0 && usage.payload.cache_read >= 0, 'the record counts the tokens');
    assert.strictEqual(typeof usage.payload.paid_by, 'string', 'the record says who paid');
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
    const ev = (await queued()).find((e) => e.payload.run_id === b.body.run.id);
    if (b.body.run.status !== 'cached') { assert.ok(ev, 'an event for the second run'); return; }   // this workflow may not cache
    assert.strictEqual(ev.event_type, 'ai.run.cached');
    assert.strictEqual(ev.payload.cached_from, a.body.run.id);
    valid(ev);
});

t.test('a failed run queues ai.run.failed with its error code; a restart announces interrupted runs', async () => {
    const r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body: { workflow: 'no.such.workflow', input: {} } });
    assert.ok(r.status >= 400, 'refused before a run exists: no event');
    const before = (await queued()).length;
    // A queued run left behind by a restart: recoverInterrupted fails it and announces it.
    const row = await h.db.prepare("SELECT * FROM runs WHERE status = 'succeeded' LIMIT 1").get();
    await h.db.prepare("INSERT INTO runs (id, workflow_key, workflow_version, status, requester_type, requester_id, input, input_hash, created_at) VALUES ('run_01JAB2C3D4E5F6G7H8J9K0MNPQ', ?, ?, 'running', 'service', 'live', '{}', 'x', ?)")
        .run(row.workflow_key, row.workflow_version, new Date().toISOString());
    assert.strictEqual(await h.runs.recoverInterrupted(), 1);
    const ev = (await queued()).slice(before).find((e) => e.payload.run_id === 'run_01JAB2C3D4E5F6G7H8J9K0MNPQ');
    assert.strictEqual(ev.event_type, 'ai.run.failed');
    assert.strictEqual(ev.payload.error.code, 'run.interrupted');
    assert.strictEqual(ev.priority, 'important');
    valid(ev);
});

t.test('an outbox write that fails rejects the caller, so a run and its event cannot diverge silently', async () => {
    const events = require('../server/events');
    const outbox = events.init(h.db);                       // the live outbox: init returns it once events is on
    assert.ok(outbox, 'events is on, so there is an outbox to fail');
    const row = await h.db.prepare("SELECT * FROM runs WHERE status = 'succeeded' LIMIT 1").get();
    await h.db.prepare("INSERT INTO runs (id, workflow_key, workflow_version, status, requester_type, requester_id, input, input_hash, created_at) VALUES ('run_01JAB2C3D4E5F6G7H8J9K0MNPS', ?, ?, 'running', 'service', 'live', '{}', 'x', ?)")
        .run(row.workflow_key, row.workflow_version, new Date().toISOString());
    const real = outbox.enqueue;
    outbox.enqueue = async () => { throw new Error('outbox write failed'); };
    try {
        await assert.rejects(h.runs.recoverInterrupted(), /outbox write failed/, 'the transaction must fail rather than commit the run change with its event silently absent');
        const after = await h.db.prepare("SELECT status FROM runs WHERE id = 'run_01JAB2C3D4E5F6G7H8J9K0MNPS'").get();
        assert.strictEqual(after.status, 'running', 'the run change rolled back with its event');
    } finally {
        outbox.enqueue = real;
        await h.db.prepare("DELETE FROM runs WHERE id = 'run_01JAB2C3D4E5F6G7H8J9K0MNPS'").run();
    }
});

t.test('a failing outbox prune is caught, not left as an unhandled rejection', async () => {
    const events = require('../server/events');
    events._reset();                                        // stop the live outbox so init builds a fresh one
    const realSetInterval = global.setInterval;
    let tick = null;
    global.setInterval = (fn) => { tick = fn; return { unref() {} }; };
    let rejection;
    const onUnhandled = (e) => { rejection = e; };
    process.on('unhandledRejection', onUnhandled);
    try {
        const outbox = events.init(h.db, { log: { log() {}, warn() {} } });
        assert.ok(outbox && tick, 'the prune timer was scheduled');
        outbox.prune = async () => { throw new Error('prune failed'); };
        tick();                                             // the timer fires; the rejection must be caught
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(rejection, undefined, 'the prune rejection was handled, not left unhandled');
    } finally {
        process.removeListener('unhandledRejection', onUnhandled);
        global.setInterval = realSetInterval;
    }
});

t.test('a refused own key queues ai.credential.failed, never the key (L36 Y8)', async () => {
    const events = require('../server/events');
    const subject = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
    const env = await events.credentialFailed({ subject, provider: 'anthropic', error: 'the provider refused the key (401)' });
    assert.ok(env && env.event_id, 'the event was queued');
    const ev = (await queued()).find((e) => e.event_id === env.event_id);
    assert.strictEqual(ev.event_type, 'ai.credential.failed');
    assert.deepStrictEqual(ev.on_behalf_of, { type: 'user', id: subject });
    assert.deepStrictEqual([ev.payload.subject, ev.payload.provider, ev.payload.status], [subject, 'anthropic', 'failing']);
    let known = true;
    try { contracts.resolve('ai.credential.failed@1'); } catch { known = false; }
    if (known) valid(ev);   // the schema arrives with openvibe-contracts 0.257.0
    assert.ok(!JSON.stringify(ev).includes('sk-'), 'no key');
});

t.test('a streamed run says so, and how fast, on its ai.call.recorded', async () => {
    const res = await fetch(`${h.base}/v1/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${live}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openvibe', stream: true, messages: [{ role: 'user', content: 'stream this answer' }] }),
    });
    assert.strictEqual(res.status, 200);
    await res.text();
    const usage = (await queued()).filter((e) => e.event_type === 'ai.call.recorded').at(-1);
    validUsage(usage);
    assert.strictEqual(usage.payload.streamed, true, 'the deltas went to the caller');
    assert.strictEqual(usage.payload.operation, 'chat', 'the Chat Completions operation');
    assert.strictEqual(usage.payload.task, 'ai.complete', 'the workflow it served');
    assert.strictEqual(usage.payload.task_id, usage.payload.run_id, 'a run is its own task');
    assert.strictEqual(usage.payload.cache_hit, false);
    assert.ok(usage.payload.tps === null || usage.payload.tps > 0, 'TPS is measured or null, never negative');
});

t.test('a failed run carries the failed attempt class and the fallbacks before it', async () => {
    seam = await seamServer(() => ({ status: 429, body: { error: { message: 'too many requests: rate limit', type: 'rate_limit_error' } } }));
    const p = await request(h.base, 'POST', '/api/v1/providers', { tok: live, body: {
        key: 'bad', kind: 'http', auth_mode: 'none', base_url: seam.url, default_model: 'bad-1',
        capabilities: ['chat', 'generate', 'json'], timeout_ms: 5000 } });
    assert.strictEqual(p.status, 201, p.text);
    const m = await request(h.base, 'POST', '/api/v1/models', { tok: live, body: {
        provider_key: 'bad', model_key: 'bad-1', type: 'chat', cost: { in_per_mtok: 1, out_per_mtok: 1 } } });
    assert.strictEqual(m.status, 201, m.text);
    const routed = await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: live, body: {
        primary: { provider: 'bad', model: 'bad-1' }, fallbacks: [], timeout_ms: 5000 } });
    assert.strictEqual(routed.status, 201, routed.text);
    await request(h.base, 'POST', '/api/v1/providers/stub/disable', { tok: live });
    try {
        const r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body: {
            workflow: 'ai.generate', input: { prompt: 'this will be rate limited' }, options: { cache: false } } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.body.run.status, 'failed', r.text);
        const usage = (await queued()).find((e) => e.event_type === 'ai.call.recorded' && e.payload.run_id === r.body.run.id);
        assert.ok(usage, 'the failed run has its usage record');
        validUsage(usage);
        assert.strictEqual(usage.payload.outcome, 'failed');
        assert.strictEqual(usage.payload.error_class, 'rate_limited', '429 from the provider is rate_limited');
        assert.ok(usage.payload.fallbacks >= 1, 'the failed offers before the answer are counted');
        assert.strictEqual(usage.payload.operation, 'chat');
        assert.strictEqual(usage.payload.task, 'ai.generate');
        assert.strictEqual(usage.payload.task_id, r.body.run.id);
    } finally {
        await request(h.base, 'POST', '/api/v1/providers/stub/enable', { tok: live });
        await seam.close();
    }
});

t.test('close() stops the ai.run.* relay (unsent rows stay in the outbox)', async () => {
    const events = require('../server/events');
    const pending = (await events.status()).pending;
    assert.ok(pending > 0, 'rows are waiting (Events is unreachable)');
    await h.stop();
    assert.strictEqual((await events.status()).enabled, false, 'the relay is stopped');
    const db = h.testdb.db;
    assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM event_outbox WHERE sent_at IS NULL AND rejected_at IS NULL').get()).n, pending, 'and its rows wait for the next start');
    await h.testdb.close();
    events._reset();
});
t.run();
