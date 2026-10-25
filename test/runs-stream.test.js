'use strict';
// A run whose answer streams (server/api/runs.js, POST /api/v1/runs?stream=1): server-sent `delta` events carry the
// answer's text as the provider writes it, and `run` the finished run, whose output is the joined deltas; the same
// idempotency key again sends only its `run` (replayed); a refused run keeps its status and problem; without ?stream
// the answer is JSON as before.
const assert = require('assert');
const { boot, token, suite, ALL } = require('./helpers');

const t = suite('runs-stream');
const service = token('chat', ALL);
let h;
const events = async (res) => (await res.text()).split('\n\n').filter(Boolean).map((block) => {
    const ev = /^event: (\w+)$/m.exec(block);
    const data = /^data: (.*)$/m.exec(block);
    return { event: ev && ev[1], data: data ? JSON.parse(data[1]) : null };
});
const streamRun = (body, { tok = service, key = null } = {}) => fetch(`${h.base}/api/v1/runs?stream=1&wait=30000`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body),
});
const COMPLETE = { workflow: 'ai.complete', input: { messages: [{ role: 'user', content: 'Stream a few words please' }] } };

t.test('boot', async () => { h = await boot(); });

t.test('the deltas as they come, then the run; joined they are its answer', async () => {
    const res = await streamRun(COMPLETE, { key: 'stream-key-1' });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    assert.match(String(res.headers.get('x-openvibe-run-id')), /^run_/);
    const list = await events(res);
    const deltas = list.filter((e) => e.event === 'delta');
    const last = list[list.length - 1];
    assert.ok(deltas.length >= 1, 'text came before the end');
    assert.strictEqual(last.event, 'run');
    assert.strictEqual(last.data.run.status, 'succeeded');
    assert.strictEqual(deltas.map((e) => e.data.text).join(''), last.data.run.output.choices[0].message.content);
    assert.strictEqual(last.data.run.id, res.headers.get('x-openvibe-run-id'));
});

t.test('the same key again: only its run, replayed', async () => {
    const list = await events(await streamRun(COMPLETE, { key: 'stream-key-1' }));
    assert.deepStrictEqual(list.map((e) => e.event), ['run']);
    assert.strictEqual(list[0].data.replayed, true);
});

t.test('a refused run keeps its status and problem; without ?stream the answer is JSON', async () => {
    const res = await streamRun({ workflow: 'no.such.workflow', input: {} });
    assert.ok(res.status >= 400 && res.status < 500, String(res.status));
    assert.match(res.headers.get('content-type'), /json/);
    const plain = await fetch(`${h.base}/api/v1/runs?wait=30000`, { method: 'POST', headers: { Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' }, body: JSON.stringify(COMPLETE) });
    assert.match(plain.headers.get('content-type'), /json/);
    assert.strictEqual((await plain.json()).run.status, 'succeeded');
});

t.test('close', async () => { await h.stop(); });
t.run();
