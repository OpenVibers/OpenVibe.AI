'use strict';
// SEO-1: the public pages' Markdown twins. A twin is the page's own render (the same for everyone: nothing on these
// pages is per person), and the page names it in its head and in the Link: header.
const assert = require('assert');
const { boot, request, suite } = require('./helpers');

const t = suite('agent-twins');
let h;
const HTML = { accept: 'text/html' };

t.test('boot', async () => {
    h = await boot({ env: { AI_STUB_FALLBACK: 'false' } });
});

t.test('each public page names its twin in the head and the Link header, and the twin is the page', async () => {
    for (const [p, twinPath, words] of [['/', '/index.md', 'OpenVibe.AI'], ['/stats', '/stats.md', 'no provider calls in the last 7 days'], ['/updates', '/updates.md', 'OpenVibe.AI']]) {
        const page = await request(h.base, 'GET', p, { headers: HTML });
        assert.strictEqual(page.status, 200, p);
        const head = page.text.match(/<link rel="alternate" type="text\/markdown" href="([^"]+)">/);
        assert.ok(head && head[1].endsWith(twinPath), `${p} names ${twinPath} in the head`);
        assert.ok(page.text.includes('<link rel="describedby" href="/llms.txt">'), `${p} names llms.txt`);
        const link = String(page.headers.get('link') || '');
        assert.ok(link.includes(`<${head[1]}>; rel="alternate"; type="text/markdown"`) && link.includes('</llms.txt>; rel="describedby"'), `${p}: the Link header says what the head says (${link})`);
        const twin = await request(h.base, 'GET', twinPath);
        assert.strictEqual(twin.status, 200, twinPath);
        assert.match(String(twin.headers.get('content-type')), /^text\/markdown/, `${twinPath} is Markdown`);
        assert.ok(twin.text.startsWith('---\ntitle:') && twin.text.includes(words), `${twinPath} is the page's words`);
        assert.ok(!/<(?:script|style)\b/i.test(twin.text.replace(/~~~~[\s\S]*?~~~~/g, '')), `${twinPath} carries no markup`);
        const asked = await request(h.base, 'GET', p, { headers: { accept: 'text/markdown' } });
        assert.match(String(asked.headers.get('content-type')), /^text\/markdown/, `${p} with Accept: text/markdown is the twin`);
    }
});

t.test('nothing else is a twin: the console, the API, and the API index for curl are as they were', async () => {
    const console_ = await request(h.base, 'GET', '/console.md');
    assert.ok(!/^text\/markdown/.test(String(console_.headers.get('content-type'))), 'the console has no twin');
    const api = await request(h.base, 'GET', '/api/v1/workflows', { headers: { accept: 'text/markdown' } });
    assert.ok(!/^text\/markdown/.test(String(api.headers.get('content-type'))), 'the API is not answered as a twin');
    const index = await request(h.base, 'GET', '/');
    assert.match(String(index.headers.get('content-type')), /^text\/plain/, 'curl still gets the API index');
});

t.test('stop', async () => { await h.stop(); });

t.run();
