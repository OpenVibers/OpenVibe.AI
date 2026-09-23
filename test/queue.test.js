'use strict';
// Run queue caps: a run that would have to wait is refused 429 queue.full (problem+json with
// Retry-After) once the caller already has AI_MAX_QUEUED_RUNS_PER_CALLER runs waiting, or the queue
// holds AI_MAX_QUEUED_RUNS; one caller cannot fill the queue for everyone. A refused run leaves no
// row and spends no quota; a slot freed by cancel or completion admits the next run.

const assert = require('assert');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('queue');
const admin = token('ops', ALL);
const a = token('live', ['ai.run.create', 'ai.run.read']);
const b = token('tools', ['ai.run.create', 'ai.run.read']);
let h;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const create = (tok, i) => request(h.base, 'POST', '/api/v1/runs', { tok, body: { workflow: 'ai.generate', input: { prompt: `queued ${i}` }, options: { cache: false } } });
const count = (who) => h.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE requester_id = ?').get(who).n;

function assertFull(r, scope) {
    assert.strictEqual(r.status, 429, r.text);
    assert.strictEqual(r.body.code, 'queue.full');
    assert.match(r.headers.get('content-type'), /application\/problem\+json/);
    assert.ok(Number(r.headers.get('retry-after')) >= 1, 'Retry-After');
    assert.strictEqual(r.body.queue.scope, scope);
}

t.test('boot with one slot, a slow provider and small queue caps', async () => {
    h = await boot({ env: { AI_MAX_CONCURRENT_RUNS: '1', AI_MAX_QUEUED_RUNS: '5', AI_MAX_QUEUED_RUNS_PER_CALLER: '3', AI_STUB_FALLBACK: 'false' } });
    const p = await request(h.base, 'POST', '/api/v1/providers', { tok: admin, body: { key: 'slowstub', kind: 'stub', auth_mode: 'none', capabilities: ['chat', 'generate', 'summarize', 'json'], metadata: { delay_ms: 1500 } } });
    assert.strictEqual(p.status, 201, p.text);
    await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: admin, body: { primary: { provider: 'slowstub' }, fallbacks: [] } });
});

t.test('one caller is held to its per-caller cap; others still get in', async () => {
    const mine = [];
    for (let i = 0; i < 4; i++) {                       // 1 running + 3 waiting
        const r = await create(a, i);
        assert.strictEqual(r.status, 202, r.text);
        mine.push(r.body.run.id);
    }
    const before = count('live');
    assertFull(await create(a, 'over'), 'caller');
    assert.strictEqual(count('live'), before, 'a refused run leaves no row');
    const other = await create(b, 0);
    assert.strictEqual(other.status, 202, 'another caller still queues');
    h.mine = mine;
});

t.test('the global cap holds across callers', async () => {
    assert.strictEqual((await create(b, 1)).status, 202);          // 5 waiting now
    assertFull(await create(b, 2), 'global');
    assertFull(await create(token('games', ['ai.run.create']), 0), 'global');
});

t.test('a freed slot admits the next run', async () => {
    const waiting = h.mine[3];
    const c = await request(h.base, 'POST', `/api/v1/runs/${waiting}/cancel`, { tok: a });
    assert.strictEqual(c.body.run.status, 'cancelled');
    assert.strictEqual((await create(a, 'again')).status, 202, 'room again after a cancel');
    assertFull(await create(a, 'again 2'), 'global');
});

t.test('shutdown', async () => { await h.stop(); await sleep(10); });

t.run();
