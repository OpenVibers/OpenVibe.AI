'use strict';
// The empty-answer breaker (plan §V.1 item 6a: "above 20% empty answers in 15 minutes a model leaves the route for an
// hour, and the operator is alerted"). An empty answer already fails over to the next offer (AI #525/#527) and three
// in a row open the circuit; a model empty on one call in three never tripped that. Against a local seam:
//   - model-a answers with nothing on every third call: each empty one is answered by model-b; at its 12th answer (4
//     empty, 33%) model-a leaves the route for an hour (circuit open, class 'empty', a plain reason), the owner hears
//     it once, and the next requests skip it; an hour later it is tried again;
//   - one empty answer in ten (10%) never takes a model off;
//   - empty answers older than 15 minutes no longer count.
const assert = require('assert');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');

const t = suite('empty-breaker');
const admin = token('live', ALL);
const MIN = 60000;

async function setup(h, seamUrl) {
    let r = await request(h.base, 'POST', '/api/v1/providers', { tok: admin, body: { key: 'seam', base_url: seamUrl, kind: 'http', auth_mode: 'none', timeout_ms: 5000, capabilities: ['chat', 'generate', 'json'] } });
    assert.strictEqual(r.status, 201, r.text);
    for (const m of ['model-a', 'model-b']) {
        r = await request(h.base, 'POST', '/api/v1/models', { tok: admin, body: { provider_key: 'seam', model_key: m, type: 'chat', cost: { in_per_mtok: 1, out_per_mtok: 1 } } });
        assert.strictEqual(r.status, 201, r.text);
    }
    r = await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: admin, body: { primary: { provider: 'seam', model: 'model-a' }, fallbacks: [{ provider: 'seam', model: 'model-b' }], timeout_ms: 5000 } });
    assert.strictEqual(r.status, 201, r.text);
    return r.body.route;
}
const ask = (h, r) => h.pool.execute(r, 'chat', { messages: [{ role: 'user', content: 'hello' }], maxTokens: 30, timeoutMs: 3000 }, { routeKey: r.key, routeVersion: r.version });
const ENV = { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_BREAKER_FAILURES: '50' };

t.test('a model empty on one call in three leaves the route for an hour; the owner hears once', async () => {
    let aCalls = 0;
    const seam = await seamServer((body) => {
        if (body.model === 'model-a') { aCalls++; return { text: aCalls % 3 === 0 ? '' : 'from a', model: 'model-a', usage: { input: 3, output: 2 } }; }
        return { text: 'from b', model: 'model-b', usage: { input: 3, output: 2 } };
    });
    let now = 1763600000000;
    const heard = [];
    const h = await boot({ clock: { now: () => now }, ownerNotify: async (n) => { heard.push(n); return true; }, env: ENV });
    try {
        const r = await setup(h, seam.url);
        const by = [];
        for (let i = 0; i < 12; i++) { now += 20000; by.push((await ask(h, r)).model); }
        assert.deepStrictEqual(by, ['model-a', 'model-a', 'model-b', 'model-a', 'model-a', 'model-b', 'model-a', 'model-a', 'model-b', 'model-a', 'model-a', 'model-b'], 'each empty answer is answered by the next offer');
        const a = await h.pool.health('seam', 'model-a');
        assert.deepStrictEqual([a.state, a.failure_class], ['open', 'empty']);
        assert.strictEqual(a.retry_at, now + 60 * MIN, 'off the route for an hour');
        assert.strictEqual(a.status_reason, 'too many empty answers in 15 minutes: off the routes for an hour');
        assert.strictEqual(a.last_error, 'empty on 4 of 12 answers in 15 minutes');
        assert.strictEqual(heard.length, 1);
        assert.strictEqual(heard[0].title, 'A model keeps answering with nothing');
        assert.match(heard[0].message, /^seam\/model-a answered with nothing on 4 of its last 12 answers in 15 minutes\. OpenVibe\.AI took it off every route for an hour/);

        const before = aCalls;
        for (let i = 0; i < 3; i++) { now += 20000; assert.strictEqual((await ask(h, r)).model, 'model-b'); }
        assert.strictEqual(aCalls, before, 'model-a is not asked while it is off');
        assert.strictEqual(heard.length, 1, 'one message, not one per request');

        now += 61 * MIN;
        await ask(h, r);
        assert.strictEqual(aCalls, before + 1, 'an hour later it is tried again');
    } finally { await h.stop(); await seam.close(); }
});

t.test('one empty answer in ten never takes a model off; old empty answers stop counting', async () => {
    let aCalls = 0, emptyEvery = 10;
    const seam = await seamServer((body) => {
        if (body.model === 'model-a') { aCalls++; return { text: aCalls % emptyEvery === 0 ? '' : 'from a', model: 'model-a', usage: { input: 3, output: 2 } }; }
        return { text: 'from b', model: 'model-b', usage: { input: 3, output: 2 } };
    });
    let now = 1763700000000;
    const heard = [];
    const h = await boot({ clock: { now: () => now }, ownerNotify: async (n) => { heard.push(n); return true; }, env: ENV });
    try {
        const r = await setup(h, seam.url);
        for (let i = 0; i < 30; i++) { now += 20000; await ask(h, r); }
        assert.strictEqual((await h.pool.health('seam', 'model-a')).state, 'closed', '10% empty: still on the route');

        // Two empty answers, then 20 minutes, then answers again: the old ones are out of the window.
        emptyEvery = 2; aCalls = 1;
        for (let i = 0; i < 4; i++) { now += 1000; await ask(h, r); }
        now += 20 * MIN;
        emptyEvery = 1000;
        for (let i = 0; i < 9; i++) { now += 1000; await ask(h, r); }
        emptyEvery = 1; aCalls = 0;
        now += 1000; await ask(h, r);   // one empty out of 10 in the window: 10%
        assert.strictEqual((await h.pool.health('seam', 'model-a')).state, 'closed', 'empty answers older than 15 minutes no longer count');
        assert.strictEqual(heard.length, 0);
    } finally { await h.stop(); await seam.close(); }
});

t.run();
