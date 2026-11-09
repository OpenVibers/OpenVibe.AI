'use strict';
const assert = require('node:assert/strict');
const { validate } = require('openvibe-contracts');
const { createSearch, adapters, CHARGE } = require('../server/search');
const { requestFor, publicTarget } = require('../server/search/transport');
const fixture = name => require('./fixtures/search/' + name + '.json');
const KEY = 'fixture-search-key';
const json = value => new Response(JSON.stringify(value), { status: 200 });
(async () => {
    for (const a of adapters.filter(a => a.id !== 'openvibe-egress')) {
        const sample = fixture(a.id), calls = [];
        const env = { [a.key_env]: KEY, EXCHANGE_SEARXNG_URL: 'https://search.example.org', SEARCH_GOOGLE_CX: 'fixture-engine' };
        const fetchImpl = async (input, init) => {
            const u = new URL(input);
            calls.push({ u, init });
            assert.equal(u.hostname, sample.request.host, a.id);
            assert.equal(init.redirect, 'error');
            assert.ok(init.signal);
            if (u.pathname === '/collections') return json(fixture('iconify-collections'));
            assert.equal(u.pathname, sample.request.path, a.id);
            assert.equal(init.method || 'GET', sample.request.method, a.id);
            if (a.byok) assert.ok(JSON.stringify(init).includes(KEY) || u.search.includes(KEY), a.id + ' authenticates');
            return json(sample.response);
        };
        const search = createSearch({ fetchImpl, env });
        const kind = a.kinds[0];
        const out = await search.search(kind, { q: 'lantern', engine: a.id });
        assert.equal(out.results.length, 1, a.id);
        assert.equal(out.results[0].title, sample.expected.title, a.id);
        assert.equal(out.receipt.cost_usd, sample.expected.cost, a.id);
        assert.equal(out[CHARGE], sample.expected.cost);
        assert.equal(out.receipt.engine, a.id);
        assert.equal(validate(kind === 'web' ? 'exchange.search-result@1' : 'exchange.image-result@1', out).valid, true, a.id);
        assert.ok(!JSON.stringify(out).includes(KEY));
        if (kind === 'web') {
            assert.equal(out.results[0].url, 'https://example.org/article');
            assert.equal(out.results[0].snippet, 'A new lantern', a.id);
            assert.equal(out.results[0].published, a.id === 'google' ? null : '2026-11-08T12:00:00Z');
        } else if (kind === 'images') {
            const row = out.results[0];
            assert.equal(row.url, 'https://images.example.org/cat.jpg');
            assert.equal(row.thumbnail, 'https://images.example.org/thumb.jpg');
            assert.deepEqual([row.width, row.height], [2400, 1600]);
            assert.equal(row.source_page, 'https://example.org/article');
            assert.equal(row.author, a.id === 'brave-images' ? null : 'Alex');
            if (a.id === 'brave-images') assert.deepEqual([row.license, row.attribution], [null, null]);
            else assert.ok(row.license && row.attribution.includes('Alex'));
        }
        const card = search.engines().find(e => e.id === a.id);
        assert.equal(card.price_per_1000, a.price_per_1000);
        assert.equal(card.source, a.source);
        assert.equal(card.checked_on, '2026-11-09');
        if (a.byok) {
            assert.equal(createSearch({ env: {} }).engines().find(e => e.id === a.id).available, false);
            await assert.rejects(createSearch({ env: {}, fetchImpl: () => assert.fail('unconfigured engine called') }).search(kind, { q: 'x', engine: a.id }));
        }
        if (a.freshness.length) {
            await search.search(kind, { q: 'lantern', engine: a.id, freshness: 'day' });
            const last = calls.at(-1), sent = last.u.href + (last.init.body || '');
            assert.match(sent, /after|freshness|PublishedDate|time_range|tbs|dateRestrict/);
        }
    }
    for (const id of ['deepseek', 'jina']) {
        let guarded = false;
        const s = createSearch({ env: { ['SEARCH_' + id.toUpperCase() + '_KEY']: KEY }, targetGuard: async url => { assert.equal(url, 'https://example.org/article'); guarded = true; }, fetchImpl: async (url, init) => {
            assert.ok(guarded, 'target checked before any remote read');
            assert.equal(JSON.parse(init.body).url, 'https://example.org/article');
            return json(fixture(id + '-fetch'));
        } });
        const out = await s.read({ engine: id, url: 'https://example.org/article' });
        assert.equal(out.text, '# Lantern\nA new lantern');
        assert.equal(out.receipt.cost_usd, id === 'deepseek' ? .00075 : .0001);
    }
    // Explicit SSRF targets are rejected before a network connection, including remote readers.
    for (const url of ['http://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://user:pass@example.org']) {
        await assert.rejects(createSearch({ env: { SEARCH_JINA_KEY: KEY }, fetchImpl: () => assert.fail('unsafe call') }).read({ engine: 'jina', url }));
    }
    await assert.rejects(publicTarget('https://127.0.0.1'), /IP-literal/);
    await assert.rejects(requestFor(['api.exa.ai'], () => assert.fail('wrong host called'))('https://evil.example/search'));
    await assert.rejects(requestFor(['api.exa.ai'], () => assert.fail('wrong protocol called'))('http://api.exa.ai/search'));
    // Private DNS answers and HTTP redirects never become a second outbound call.
    const dns = require('node:dns'), originalLookup = dns.lookup;
    dns.lookup = (_host, _opts, cb) => cb(null, [{ address: '10.0.0.1', family: 4 }]);
    try { await assert.rejects(publicTarget('https://private.example'), /non-public/); }
    finally { dns.lookup = originalLookup; }
    let redirects = 0;
    await assert.rejects(requestFor(['api.exa.ai'], async () => { redirects++; return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } }); })('https://api.exa.ai/search'));
    assert.equal(redirects, 1);
    const empty = await createSearch({ env: { SEARCH_DEEPSEEK_KEY: KEY }, fetchImpl: async () => json({ results: [] }) }).search('web', { engine: 'deepseek', q: 'x' });
    assert.equal(empty.receipt.cost_usd, 0);
    console.log('search adapters: saved responses, authentication, tariffs, contracts, metadata, freshness and guarded fetch passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
