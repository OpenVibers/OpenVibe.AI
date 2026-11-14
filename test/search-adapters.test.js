'use strict';
const assert = require('node:assert/strict');
const { createSearch, adapters, CHARGE } = require('../server/search');
const searchContract = require('../server/search/contract');
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
            assert.equal(init.redirect, 'error');
            assert.ok(init.signal);
            if (u.pathname === '/collections') return json(fixture('iconify-collections'));
            // NASA's assets live in their own host: the item's collection.json is a second read.
            if (a.id === 'nasa' && u.pathname.endsWith('/collection.json')) return json(fixture('nasa-assets'));
            assert.equal(u.hostname, sample.request.host, a.id);
            assert.equal(u.pathname, sample.request.path, a.id);
            assert.equal(init.method || 'GET', sample.request.method, a.id);
            if (a.byok) {
                if (a.id === 'dataforseo' || a.id === 'dataforseo-images') {
                    // DataForSEO authenticates with HTTP Basic: the key is the login and the password.
                    const auth = String((init.headers || {}).authorization || '');
                    assert.ok(Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString('utf8').includes(KEY), a.id + ' authenticates');
                } else assert.ok(JSON.stringify(init).includes(KEY) || u.search.includes(KEY), a.id + ' authenticates');
            }
            return json(sample.response);
        };
        const search = createSearch({ fetchImpl, env });
        const kind = a.kinds[0];
        const input = kind === 'reverse_image'
            ? { image_url: 'https://example.org/cat.jpg', engine: a.id }
            : { q: 'lantern', engine: a.id };
        const out = await search.search(kind, input);
        assert.equal(out.results.length, 1, a.id);
        assert.equal(out.results[0].title, sample.expected.title, a.id);
        assert.equal(out.receipt.cost_usd, sample.expected.cost, a.id);
        assert.equal(out[CHARGE], sample.expected.cost);
        assert.equal(out.receipt.engine, a.id);
        assert.equal(searchContract.check(kind === 'web' ? 'web' : 'images', out).valid, true, a.id);
        assert.ok(!JSON.stringify(out).includes(KEY));
        if (kind === 'web') {
            assert.equal(out.results[0].url, 'https://example.org/article');
            assert.equal(out.results[0].snippet, 'A new lantern', a.id);
            assert.equal(out.results[0].published, ['google', 'meta', 'dataforseo'].includes(a.id) ? null : '2026-11-08T12:00:00Z');
        } else if (kind === 'images' || kind === 'reverse_image') {
            const row = out.results[0];
            if (kind === 'reverse_image') {
                assert.equal(row.reverse_image, true, a.id);
                assert.equal(row.upstream, a.id === 'tineye' ? 'tineye' : 'google', a.id);
                assert.equal(row.source_page, 'https://example.org/article', a.id);
                assert.equal(row.license, null, a.id);
            } else {
                if (a.id === 'pixabay') {
                    // Its terms forbid permanent hotlinking: the result points at the short-lived proxy.
                    assert.match(row.url, /^https:\/\/ai\.openvibe\.services\/v1\/search\/images\/pixabay\/12345$/);
                    assert.equal(row.thumbnail, row.url);
                } else if (a.id === 'nasa') {
                    // The assets come from the item's own collection.json, in NASA's own file names.
                    assert.equal(row.url, 'https://images.example.org/PIA23403~orig.jpg');
                    assert.equal(row.thumbnail, 'https://images.example.org/PIA23403~thumb.jpg');
                } else if (a.id === 'smithsonian') {
                    // The picture comes from the Smithsonian Image Delivery Service.
                    assert.equal(row.url, 'https://ids.si.edu/ids/deliveryService?id=fixture-image-1&max=1000');
                    assert.equal(row.thumbnail, 'https://ids.si.edu/ids/deliveryService?id=fixture-image-1&max=400');
                } else {
                    assert.equal(row.url, 'https://images.example.org/cat.jpg');
                    assert.equal(row.thumbnail, 'https://images.example.org/thumb.jpg');
                }
                // The open catalogs and the SERP proxies say nothing about the size of a picture.
                if (['europeana', 'nasa', 'dataforseo-images', 'smithsonian'].includes(a.id)) assert.deepEqual([row.width, row.height], [null, null]);
                else assert.deepEqual([row.width, row.height], [2400, 1600]);
                assert.equal(row.source_page, a.id === 'nasa' ? 'https://images.nasa.gov/details/PIA23403'
                    : a.id === 'smithsonian' ? 'https://www.si.edu/object/edanmdm:nmah_687529' : 'https://example.org/article');
                const discovery = ['brave-images', 'serper-images', 'serpapi-images', 'searchapi-images', 'dataforseo-images'];
                if (a.id === 'nasa') {
                    // A NASA-created picture is public domain and says who made it.
                    assert.equal(row.author, 'NASA/JPL-Caltech');
                    assert.equal(row.license, 'public_domain');
                    assert.ok(row.attribution.includes('NASA'));
                } else if (a.id === 'smithsonian') {
                    // A record with a media file is an object whose work is in the public domain.
                    assert.equal(row.author, 'Smithsonian Institution, National Museum of American History');
                    assert.equal(row.license, 'cc0');
                    assert.ok(row.attribution.includes('Smithsonian'));
                } else {
                    assert.equal(row.author, discovery.includes(a.id) ? null : 'Alex');
                    if (discovery.includes(a.id)) assert.deepEqual([row.license, row.attribution], [null, null]);
                    else assert.ok(row.license && row.attribution.includes('Alex'));
                }
                assert.ok(row.upstream, a.id + ' names its upstream');
            }
            assert.equal(row.upstream_rank, 1, a.id);
            assert.equal(row.rank, 1, a.id);
        }
        const card = (await search.engines()).find(e => e.id === a.id);
        assert.equal(card.price_per_1000, a.price_per_1000);
        assert.equal(card.source, a.source);
        assert.equal(card.checked_on, ['serpapi-images', 'searchapi-images', 'serpapi-reverse', 'tineye', 'pixabay', 'unsplash',
            'mojeek', 'parallel', 'you', 'dataforseo', 'europeana', 'nasa', 'dataforseo-images', 'smithsonian'].includes(a.id)
            ? '2026-11-13' : a.id === 'openvibe' ? '2026-11-12' : ['meta', 'serper-images'].includes(a.id) ? '2026-11-10' : '2026-11-09');
        if (a.byok) {
            assert.equal((await createSearch({ env: {} }).engines()).find(e => e.id === a.id).available, false);
            await assert.rejects(createSearch({ env: {}, fetchImpl: () => assert.fail('unconfigured engine called') }).search(kind, { q: 'x', engine: a.id }));
        }
        if (a.freshness.length) {
            await search.search(kind, { q: 'lantern', engine: a.id, freshness: 'day' });
            const last = calls.at(-1), sent = last.u.href + (last.init.body || '');
            assert.match(sent, /after|freshness|PublishedDate|time_range|tbs|dateRestrict|since/);
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
    let openverseUrl;
    const openverse = createSearch({ env: {}, fetchImpl: async (url) => { openverseUrl = new URL(url); return json(fixture('openverse').response); } });
    const photos = await openverse.search('images', { q: 'cat', engine: 'openverse', type: 'photo', after: '2026-11-01' });
    assert.equal(photos.results.length, 1);
    assert.equal(photos.results[0].indexed_on, '2026-11-08T12:00:00Z');
    assert.equal(openverseUrl.searchParams.get('category'), 'photograph');
    assert.equal((await openverse.search('images', { q: 'cat', engine: 'openverse', type: 'photo', after: '2026-12-01' })).results.length, 0);
    assert.equal((await openverse.search('images', { q: 'cat', engine: 'openverse', type: 'illustration' })).results.length, 0);
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
