'use strict';
// SEO-1 moved with the public pages: ai.openvibe.services serves no Markdown twins any more. Each old twin path
// answers 301 to its Exchange twin, and an Accept: text/markdown request for the home does the same. The API,
// the console and the run receipt are not answered as Markdown.
const assert = require('assert');
const { boot, request, suite } = require('./helpers');

const t = suite('agent-twins-moved');
let h;
const EXCHANGE = 'https://openvibe.exchange';
const location = (r) => String(r.headers.get('location') || '');

t.test('boot', async () => {
    h = await boot({ env: { AI_STUB_FALLBACK: 'false' } });
});

t.test('every old twin path is a 301 to its Exchange twin', async () => {
    for (const [p, to] of [['/index.md', '/index.md'], ['/stats.md', '/models.md'], ['/updates.md', '/status.md']]) {
        const r = await request(h.base, 'GET', p, { redirect: 'manual' });
        assert.strictEqual(r.status, 301, p);
        assert.strictEqual(location(r), `${EXCHANGE}${to}`, p);
        assert.ok(!/^text\/markdown/.test(String(r.headers.get('content-type') || '')), p);
    }
});

t.test('the home with Accept: text/markdown goes to the Exchange twin', async () => {
    const r = await request(h.base, 'GET', '/', { headers: { accept: 'text/markdown' }, redirect: 'manual' });
    assert.strictEqual(r.status, 301);
    assert.strictEqual(location(r), `${EXCHANGE}/index.md`);
});

t.test('nothing else is a twin now: the console, the API and the curl index are as they were', async () => {
    const console_ = await request(h.base, 'GET', '/console.md', { redirect: 'manual' });
    assert.notStrictEqual(location(console_), `${EXCHANGE}/console.md`, 'the console is not moved as a twin');
    const api = await request(h.base, 'GET', '/api/v1/workflows', { headers: { accept: 'text/markdown' }, redirect: 'manual' });
    assert.ok(!/^text\/markdown/.test(String(api.headers.get('content-type') || '')), 'the API is not answered as a twin');
    assert.ok(!location(api).startsWith(EXCHANGE), 'an API path is never redirected');
    const index = await request(h.base, 'GET', '/');
    assert.match(String(index.headers.get('content-type')), /^text\/plain/, 'curl still gets the API index');
});

t.test('stop', async () => { await h.stop(); });

t.run();
