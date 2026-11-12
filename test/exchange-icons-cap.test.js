'use strict';
// The Exchange platform API's icon reference search takes a first-party service capability:
// exchange.search.icons (contracts 0.407.0), held by OpenVibe.Design. It opens POST /v1/search/icons
// only, has its own minute bucket (AI_EXCHANGE_ICONS_RPM) and still takes ai.run.create as before.
//
//   node test/exchange-icons-cap.test.js
const assert = require('node:assert/strict');
const { boot, request, token, suite } = require('./helpers');

const t = suite('exchange.search.icons');
let h;
const iconifyFetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/search') {
        return new Response(JSON.stringify({ icons: ['lucide:hot-tub'] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname === '/collections') {
        return new Response(JSON.stringify({ lucide: { name: 'Lucide', author: { name: 'Lucide' }, license: { spdx: 'ISC', url: 'https://example.test/license' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected ${url}`);
};

t.test('boot', async () => {
    h = await boot({ searchFetch: iconifyFetch, env: { AI_EXCHANGE_ICONS_RPM: '2' } });
});

t.test('a service with exchange.search.icons searches icons and nothing else', async () => {
    const design = token('design', ['exchange.search.icons'], { ns: [] });
    const icons = await request(h.base, 'POST', '/v1/search/icons', { tok: design, body: { q: 'hot tub', engine: 'iconify', limit: 1 } });
    assert.equal(icons.status, 200);
    assert.equal(icons.body.results[0].name, 'lucide:hot-tub');
    assert.equal(icons.body.results[0].engine, 'iconify');
    assert.equal(icons.body.receipt.engine, 'iconify');

    for (const [method, path] of [['POST', '/v1/search'], ['POST', '/v1/search/images'], ['POST', '/v1/fetch']]) {
        const r = await request(h.base, method, path, { tok: design, body: path === '/v1/fetch' ? { url: 'https://example.org/' } : { q: 'hot tub' } });
        assert.equal(r.status, 403, `${path} is not opened by exchange.search.icons`);
        assert.equal(r.body.code, 'capability.denied');
    }
});

t.test('its own minute limit answers 429, not the general search limit', async () => {
    const design = token('design', ['exchange.search.icons'], { ns: [] });
    const ok = await request(h.base, 'POST', '/v1/search/icons', { tok: design, body: { q: 'bell', engine: 'iconify' } });
    assert.equal(ok.status, 200);
    const limited = await request(h.base, 'POST', '/v1/search/icons', { tok: design, body: { q: 'bell', engine: 'iconify' } });
    assert.equal(limited.status, 429);
    assert.match(limited.body.error, /Icon search limit/);
});

t.test('ai.run.create still searches icons', async () => {
    const live = token('live', ['ai.run.create'], { ns: ['live.*'] });
    const r = await request(h.base, 'POST', '/v1/search/icons', { tok: live, body: { q: 'bell', engine: 'iconify' } });
    assert.equal(r.status, 200);
});

t.test('stop', async () => { await h.stop(); });

t.run();
