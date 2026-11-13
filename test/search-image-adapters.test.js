'use strict';
const assert = require('node:assert/strict');
const { createSearch } = require('../server/search');
const fixture = name => require('./fixtures/search/' + name + '.json');
const KEY = 'fixture-search-key';
const json = value => new Response(JSON.stringify(value), { status: 200 });
const sample = (id, changes = {}) => ({ ...fixture(id).response, ...changes });
const PNG = 'data:image/png;base64,' + Buffer.alloc(200, 1).toString('base64');

(async () => {
    // Their rank survives our rerank: the large image at provider position 7 ranks first for us, and both
    // numbers stay on the row.
    let called = 0;
    const ranked = createSearch({
        env: { SEARCH_SERPAPI_KEY: KEY },
        fetchImpl: async (url) => {
            called++;
            assert.equal(new URL(url).hostname, 'serpapi.com');
            return json(sample('serpapi-images', { images_results: [
                { ...fixture('serpapi-images').response.images_results[0], position: 7, title: 'Large cat', original_width: 2400, original_height: 1600 },
                { ...fixture('serpapi-images').response.images_results[0], position: 2, title: 'Small cat', original: 'https://images.example.org/small.jpg', thumbnail: 'https://images.example.org/small-thumb.jpg', original_width: 100, original_height: 100 },
            ] }));
        },
    });
    const reranked = await ranked.search('images', { engine: 'serpapi-images', q: 'cat', limit: 2 });
    assert.equal(called, 1);
    assert.deepEqual(reranked.results.map(r => [r.title, r.upstream_rank, r.rank]), [['Large cat', 7, 1], ['Small cat', 2, 2]]);
    assert.equal(reranked.results[0].upstream, 'google');

    const card = (await ranked.engines()).find(e => e.id === 'serpapi-images');
    assert.equal(card.filters.license, 'unsupported');
    assert.equal(card.filters.size, 'local');
    assert.deepEqual(card.upstreams, ['google']);
    assert.equal(card.included_allowance, '250 searches a month');
    await assert.rejects(ranked.search('images', { engine: 'serpapi-images', q: 'cat', license: 'cc0' }),
        e => e.status === 422 && /license/.test(e.message));
    // On auto, an engine that cannot honour the licence is skipped; an engine that can still answers.
    const autoFiltered = createSearch({
        env: { SEARCH_SERPAPI_KEY: KEY },
        fetchImpl: async (url) => {
            const host = new URL(url).hostname;
            if (host === 'serpapi.com') assert.fail('an engine that cannot honour licence was called');
            assert.equal(host, 'api.openverse.org');
            return json(fixture('openverse').response);
        },
    });
    const filtered = await autoFiltered.search('images', { q: 'cat', license: 'by', limit: 1 });
    assert.equal(filtered.receipt.engine, 'openverse');
    assert.equal(filtered.results[0].license, 'by');

    // SearchAPI is one supplier with three upstreams; the choice is sent and named on every row.
    let searchapiUrl;
    const multi = createSearch({ env: { SEARCH_SEARCHAPI_KEY: KEY }, fetchImpl: async (url) => {
        searchapiUrl = new URL(url);
        return json(fixture('searchapi-images').response);
    } });
    const bing = await multi.search('images', { engine: 'searchapi-images', q: 'cat', upstream: 'bing' });
    assert.equal(searchapiUrl.searchParams.get('engine'), 'bing_images');
    assert.equal(bing.results[0].upstream, 'bing');
    assert.equal((await multi.engines()).find(e => e.id === 'searchapi-images').upstreams.length, 3);

    // TinEye uploads a multipart image; SerpApi reverse refuses an upload because it only takes a URL.
    let multipart = null, multipartHeaders = null;
    const tineye = createSearch({ env: { SEARCH_TINEYE_KEY: KEY }, fetchImpl: async (url, init) => {
        assert.equal(new URL(url).pathname, '/rest/search/');
        multipart = init.body;
        multipartHeaders = init.headers;
        return json(fixture('tineye').response);
    } });
    const uploaded = await tineye.search('reverse_image', { engine: 'tineye', image: PNG });
    assert.ok(Buffer.isBuffer(multipart));
    assert.match(multipart.toString('latin1'), /name="image_upload"/);
    assert.equal(multipartHeaders['x-api-key'], KEY);
    assert.equal(uploaded.results[0].reverse_image, true);
    assert.equal(uploaded.results[0].rank, 1);
    await assert.rejects(ranked.search('reverse_image', { engine: 'serpapi-reverse', image: PNG }),
        e => e.status === 422 && /upload/.test(e.message));

    // Unsplash's download event is server-side, once per person and download_location.
    let events = 0;
    const unsplash = createSearch({ env: { SEARCH_UNSPLASH_KEY: KEY }, fetchImpl: async (url) => {
        events++;
        assert.equal(new URL(url).pathname, '/photos/cat/download');
        assert.equal(new URL(url).searchParams.get('ixid'), 'fixture');
        return json({ url: 'https://images.example.org/cat.jpg' });
    } });
    const location = 'https://api.unsplash.com/photos/cat/download?ixid=fixture';
    assert.deepEqual(await unsplash.trackDownload({ download_location: location }), { tracked: true, already: false });
    assert.deepEqual(await unsplash.trackDownload({ download_location: location }), { tracked: true, already: true });
    assert.equal(events, 1);
    await assert.rejects(unsplash.trackDownload({ download_location: 'https://evil.example/photos/cat/download' }),
        e => e.status === 422);

    // Pixabay is cached for 24 hours and results point at the short-lived proxy, never its CDN.
    let pixabayCalls = 0, time = 1_800_000_000_000;
    const pixabay = createSearch({
        env: { SEARCH_PIXABAY_KEY: KEY }, now: () => time, publicBase: 'https://ai.example',
        fetchImpl: async () => { pixabayCalls++; return json(fixture('pixabay').response); },
    });
    const first = await pixabay.search('images', { engine: 'pixabay', q: 'cat', limit: 3 });
    assert.equal(first.results[0].url, 'https://ai.example/v1/search/images/pixabay/12345');
    assert.equal(first.results[0].source_page, 'https://example.org/article');
    assert.ok(!JSON.stringify(first).includes('pixabay.com/get/'));
    time += 60 * 60 * 1000;
    const cached = await pixabay.search('images', { engine: 'pixabay', q: 'cat', limit: 3 });
    assert.equal(pixabayCalls, 1);
    assert.equal(cached.results[0].url, first.results[0].url);
    time += 24 * 60 * 60 * 1000;
    await pixabay.search('images', { engine: 'pixabay', q: 'cat', limit: 3 });
    assert.equal(pixabayCalls, 2);
    // A saved proxy lookup fetches only Pixabay's hosts.
    let proxied = 0;
    const proxiedSearch = createSearch({
        env: { SEARCH_PIXABAY_KEY: KEY }, publicBase: 'https://ai.example',
        fetchImpl: async (url) => {
            proxied++;
            const host = new URL(url).hostname;
            if (host === 'pixabay.com') return json(fixture('pixabay').response);
            assert.equal(host, 'cdn.pixabay.com');
            return new Response(Buffer.from([0xff, 0xd8, 0xff]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
        },
    });
    await proxiedSearch.search('images', { engine: 'pixabay', q: 'cat-proxy-test', limit: 3 });
    const image = await proxiedSearch.pixabayImage('12345');
    assert.equal(proxied, 2, 'one API call and one image byte fetch');
    assert.equal(image.type, 'image/jpeg');

    console.log('search image adapters: upstream rank, filter refusal, upstreams, upload, one Unsplash event and Pixabay cache passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
