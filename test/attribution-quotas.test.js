'use strict';
// Caps a service sets on its own attributions (roadmap WS-O task 2; Contracts 0.75.0 ai.quota.attribution.manage):
// Live caps a streamer's AI viewers (live:user:<id>, prefix live.viewers.); a run over the cap is refused 429 before
// any provider call; runs of other workflows or other streamers are not counted against it; another service cannot
// set, read or remove Live's caps; removing the cap lets runs through again.
const assert = require('assert');
const { validate } = require('openvibe-contracts');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('attribution-quotas');
const live = token('live', [...ALL, 'ai.quota.attribution.manage']);
const tools = token('tools', [...ALL, 'ai.quota.attribution.manage']);
const plain = token('live', ALL);
let h;
const run = (workflow, userId) => request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body: { workflow, input: { role: 'chat', user: 'hi' }, attribution: { service: 'live', type: 'user', id: String(userId) } } });

t.test('boot', async () => { h = await boot(); });

t.test('a service sets, reads and removes caps on its own attributions only', async () => {
    let r = await request(h.base, 'PUT', '/api/v1/attribution-quotas/live:user:42', { tok: plain, body: { window: 'day', max_requests: 1 } });
    assert.strictEqual(r.status, 403, 'needs the capability');
    r = await request(h.base, 'PUT', '/api/v1/attribution-quotas/live:user:42', { tok: tools, body: { window: 'day', max_requests: 1 } });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied'], "tools cannot cap Live's streamers");
    r = await request(h.base, 'PUT', '/api/v1/attribution-quotas/live:user:42', { tok: live, body: { window: 'day' } });
    assert.strictEqual(r.status, 422, 'a cap needs a limit');
    r = await request(h.base, 'PUT', '/api/v1/attribution-quotas/live:user:42', { tok: live, body: { window: 'day', max_requests: 1, workflow_prefix: 'live.viewers.' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(validate('ai.attribution-quota@1', r.body).valid, JSON.stringify(validate('ai.attribution-quota@1', r.body).errors));
    assert.deepStrictEqual([r.body.attribution, r.body.max_requests, r.body.used.requests], ['live:user:42', 1, 0]);
    r = await request(h.base, 'GET', '/api/v1/attribution-quotas/live:user:42', { tok: tools });
    assert.strictEqual(r.status, 403);
});

t.test('a run over the cap is refused; other workflows and streamers are not counted', async () => {
    let r = await run('live.viewers.line', 42);
    assert.ok([200, 201].includes(r.status), r.text);
    r = await run('live.viewers.line', 42);
    assert.deepStrictEqual([r.status, r.body.code], [429, 'quota.exceeded'], 'the second viewer run today is over the cap');
    r = await run('live.chat.insight', 42);
    assert.ok([200, 201].includes(r.status), 'another workflow of the same streamer runs');
    r = await run('live.viewers.line', 43);
    assert.ok([200, 201].includes(r.status), 'another streamer runs');
    r = await request(h.base, 'GET', '/api/v1/attribution-quotas/live:user:42', { tok: live });
    assert.deepStrictEqual(r.body.quotas.map((q) => [q.window, q.workflow_prefix, q.used.requests]), [['day', 'live.viewers.', 1]]);
    assert.strictEqual((await request(h.base, 'DELETE', '/api/v1/attribution-quotas/live:user:42', { tok: live })).status, 204);
    r = await run('live.viewers.line', 42);
    assert.ok([200, 201].includes(r.status), 'removed: runs again');
    await h.stop();
});

t.run();
