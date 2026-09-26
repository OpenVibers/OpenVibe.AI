'use strict';
// The cache never crosses actor or resource scope: a private entry written for actor A (or target
// X) is never served to actor B (or target Y), nor to another service; a service-scoped workflow
// shares within one service only; a new workflow/template version misses; synthetic stub output is
// never cached; options.cache=false bypasses it.

const assert = require('assert');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');

const t = suite('cache');
const live = token('live', ALL);
const other = token('community', ['ai.run.create', 'ai.run.read']);
const A = { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA' };
const B = { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB' };
let h;
let seam;

const summarize = (tok, extra = {}) => request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok, body: { workflow: 'ai.summarize', input: { text: 'The same private text for everyone.' }, ...extra } });

t.test('boot with a real (non-synthetic) seam provider', async () => {
    seam = await seamServer((b) => ({ text: `summary #${seam.calls}`, usage: { input: 5, output: 2 } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false' } });
    await request(h.base, 'POST', '/api/v1/providers', { tok: live, body: { key: 'seam', kind: 'http', base_url: seam.url, auth_mode: 'none', capabilities: ['summarize', 'generate', 'chat', 'json'] } });
    await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: live, body: { primary: { provider: 'seam' }, fallbacks: [] } });
    await request(h.base, 'POST', '/api/v1/routes/live.chat/versions', { tok: live, body: { primary: { provider: 'seam' }, fallbacks: [] } });
});

t.test("actor A's repeat is served from A's cache without a provider call", async () => {
    const first = await summarize(live, { on_behalf_of: A });
    assert.strictEqual(first.body.run.status, 'succeeded');
    const calls = seam.calls;
    const again = await summarize(live, { on_behalf_of: A });
    assert.strictEqual(again.body.run.status, 'cached');
    assert.strictEqual(again.body.run.provenance.cached_from, first.body.run.id);
    assert.deepStrictEqual(again.body.run.output, first.body.run.output);
    assert.strictEqual(seam.calls, calls);
    assert.ok(first.body.run.grounding && first.body.run.grounding.gaps.length, 'the first run says what backs it (WS-O task 3)');
    assert.deepStrictEqual(again.body.run.grounding, first.body.run.grounding, 'a cached run carries the grounding of the run it reuses');
});

t.test("actor B never receives actor A's private cache entry", async () => {
    const calls = seam.calls;
    const b = await summarize(live, { on_behalf_of: B });
    assert.strictEqual(b.body.run.status, 'succeeded', 'B is computed fresh, not served A\'s entry');
    assert.strictEqual(seam.calls, calls + 1);
    assert.notDeepStrictEqual(b.body.run.output, (await summarize(live, { on_behalf_of: A })).body.run.output);
    const none = await summarize(live);
    assert.strictEqual(none.body.run.status, 'succeeded', 'no actor is its own scope too');
});

t.test('resource scope: the same input for a different target misses', async () => {
    const x = { service: 'live', type: 'vod', id: '1' };
    const y = { service: 'live', type: 'vod', id: '2' };
    await summarize(live, { target: x });
    assert.strictEqual((await summarize(live, { target: x })).body.run.status, 'cached');
    assert.strictEqual((await summarize(live, { target: y })).body.run.status, 'succeeded');
});

t.test('another service never reads this service\'s entries', async () => {
    const r = await summarize(other);
    assert.strictEqual(r.body.run.status, 'succeeded');
});

t.test('service-scoped workflows (translation) share within the service only', async () => {
    const tr = (tok, obo) => request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok, body: { workflow: 'live.translate', input: { text: 'こんにちは、みなさん', from: 'ja', to: 'en' }, on_behalf_of: obo } });
    assert.strictEqual((await tr(live, A)).body.run.status, 'succeeded');
    assert.strictEqual((await tr(live, B)).body.run.status, 'cached', 'public text translation is shared inside Live');
    assert.strictEqual((await tr(other, A)).body.run.status, 'succeeded', 'but not with another service');
});

t.test('a new template version misses the old entries', async () => {
    await summarize(live, { on_behalf_of: A });
    const v = await request(h.base, 'POST', '/api/v1/templates/ai.summarize/versions', { tok: live, body: { system_prompt: 'Summarize faithfully, in plain words.' } });
    assert.strictEqual(v.status, 201);
    assert.strictEqual((await summarize(live, { on_behalf_of: A })).body.run.status, 'succeeded');
});

t.test('options.cache=false bypasses the cache', async () => {
    await summarize(live, { on_behalf_of: A });
    const r = await summarize(live, { on_behalf_of: A, options: { cache: false } });
    assert.strictEqual(r.body.run.status, 'succeeded');
});

t.test('synthetic stub output is never cached', async () => {
    await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: live, body: { primary: { provider: 'stub' }, fallbacks: [] } });
    const a = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body: { workflow: 'ai.generate', input: { prompt: 'x' } } });
    const b = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body: { workflow: 'ai.generate', input: { prompt: 'x' } } });
    assert.strictEqual(a.body.run.synthetic, true);
    assert.strictEqual(b.body.run.status, 'succeeded');
});

t.test('cache stats and purge are admin operations', async () => {
    const s = await request(h.base, 'GET', '/api/v1/cache', { tok: live });
    assert.ok(s.body.cache.some(c => c.workflow_key === 'ai.summarize' && c.privacy === 'private'));
    assert.strictEqual((await request(h.base, 'DELETE', '/api/v1/cache', { tok: other })).status, 403);
    const p = await request(h.base, 'DELETE', '/api/v1/cache?workflow=ai.summarize', { tok: live });
    assert.ok(p.body.removed > 0);
});

t.test('shutdown', async () => { await h.stop(); await seam.close(); });

t.run();
