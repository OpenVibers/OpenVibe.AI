'use strict';
const assert = require('node:assert/strict');
const { boot, request, token, ALL } = require('./helpers');

const alice = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPX';
const location = 'https://api.unsplash.com/photos/cat/download?ixid=fixture';

(async () => {
    let events = 0;
    const h = await boot({
        env: { SEARCH_UNSPLASH_KEY: 'shared-unsplash-key', SEARCH_TINEYE_KEY: 'shared-tineye-key' },
        searchFetch: async (url) => {
            const parsed = new URL(url);
            if (parsed.hostname === 'api.tineye.com') {
                return new Response(JSON.stringify(require('./fixtures/search/tineye.json').response), {
                    status: 200, headers: { 'content-type': 'application/json' },
                });
            }
            events++;
            assert.equal(parsed.pathname, '/photos/cat/download');
            return new Response(JSON.stringify({ url: 'https://images.example.org/cat.jpg' }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        },
    });
    try {
        const catalogue = await request(h.base, 'GET', '/api/v1/exchange/search/engines');
        assert.equal(catalogue.status, 200);
        const cards = catalogue.body.engines;
        assert.ok(cards.find((e) => e.id === 'serpapi-images').filters.license === 'unsupported');
        assert.deepEqual(cards.find((e) => e.id === 'searchapi-images').upstreams, ['google', 'bing', 'yandex']);
        assert.equal(cards.find((e) => e.id === 'pexels').onboarding, 'paused');
        assert.ok(cards.find((e) => e.id === 'tineye').kinds.includes('reverse_image'));
        const person = token('alice', ALL, { sub: alice, actorType: 'user' });
        const first = await request(h.base, 'POST', '/v1/search/images/unsplash/download', { tok: person, body: { download_location: location } });
        assert.equal(first.status, 200);
        assert.deepEqual(first.body, { tracked: true, already: false });
        const again = await request(h.base, 'POST', '/v1/search/images/unsplash/download', { tok: person, body: { download_location: location } });
        assert.deepEqual(again.body, { tracked: true, already: true });
        assert.equal(events, 1, 'the upstream event is sent once');
        const row = await h.db.prepare('SELECT scope, provider, event_key FROM search_asset_events').get();
        assert.equal(row.provider, 'unsplash');
        assert.equal(row.scope, alice);
        const bad = await request(h.base, 'POST', '/v1/search/images/unsplash/download', { tok: person, body: { download_location: 'https://evil.example/photos/cat/download' } });
        assert.equal(bad.status, 422);
        assert.equal(events, 1, 'a rejected location never reaches Unsplash');

        // The reverse-image operation is its own route, marked reverse_image and never a keyword search.
        const reverse = await request(h.base, 'POST', '/v1/search/reverse-image', { tok: person, body: { engine: 'tineye', image_url: 'https://example.org/cat.jpg' } });
        assert.equal(reverse.status, 200);
        assert.equal(reverse.body.results[0].reverse_image, true);
        assert.equal(reverse.body.results[0].upstream, 'tineye');
        assert.equal(reverse.body.receipt.engine, 'tineye');
        const implicit = await request(h.base, 'POST', '/v1/search/reverse-image', { tok: person, body: { image_url: 'https://example.org/cat.jpg' } });
        assert.equal(implicit.status, 422);
        console.log('search download event: one server-side Unsplash event per person and photo, and reverse_image routing passed');
    } finally { await h.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
