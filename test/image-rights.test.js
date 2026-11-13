'use strict';
// Image rights (plan §W.2 step 1, 11-13): every image result says what reuse its source allows, apart from what it is.
//   - web-image discovery (Brave, Serper, SerpApi, SearchAPI images, reverse image) grants nothing: unknown, third party;
//   - a provider's content licence (Unsplash, Pexels, Pixabay) allows commercial use but is not an open licence: no
//     standalone redistribution, the provider's display rules;
//   - an open catalog's licence is what the catalog claims: CC0/PDM public domain, CC BY variants by their clauses,
//     software licences open, anything else an unknown family;
//   - commercial, require_known_rights and allow_provider_license filter on those fields, and are validated.
const assert = require('node:assert/strict');
const { createSearch, rightsOf } = require('../server/search');
const fixture = (name) => require('./fixtures/search/' + name + '.json');
const json = (value) => new Response(JSON.stringify(value), { status: 200 });

(async () => {
    // ── the model ──
    const discovery = rightsOf('brave-images', 'cc0');
    assert.equal(discovery.status, 'unknown', 'a discovery engine grants nothing, whatever the page says');
    assert.equal(discovery.family, 'third_party');
    assert.equal(discovery.commercial_use, null);
    assert.equal(discovery.license_id, null);
    ['serper-images', 'serpapi-images', 'searchapi-images', 'serpapi-reverse', 'tineye'].forEach((e) => assert.equal(rightsOf(e, 'by').status, 'unknown', e));

    const unsplash = rightsOf('unsplash', null, { download_location: 'https://api.unsplash.com/photos/x/download' });
    assert.deepEqual([unsplash.status, unsplash.family, unsplash.commercial_use, unsplash.standalone_redistribution, unsplash.hotlink_required, unsplash.attribution_required],
        ['provider_claimed', 'provider_content_license', true, false, true, true]);
    assert.equal(unsplash.download_tracking_url, 'https://api.unsplash.com/photos/x/download');
    assert.equal(rightsOf('pexels').standalone_redistribution, false);
    assert.equal(rightsOf('pixabay').family, 'provider_content_license');

    assert.equal(rightsOf('openverse', 'cc0').family, 'public_domain');
    assert.equal(rightsOf('commons', 'pdm').commercial_use, true);
    const by = rightsOf('openverse', 'CC BY 4.0');
    assert.deepEqual([by.family, by.commercial_use, by.modifications, by.attribution_required], ['open_license', true, true, true]);
    assert.equal(rightsOf('openverse', 'by-nc').commercial_use, false, 'NC is not commercial');
    assert.equal(rightsOf('openverse', 'cc-by-nc-sa 3.0').commercial_use, false);
    assert.equal(rightsOf('openverse', 'by-nd').modifications, false, 'ND allows no modifications');
    assert.equal(rightsOf('openverse', 'by-nc-nd').modifications, false);
    assert.equal(rightsOf('iconify', 'MIT').family, 'open_license');
    assert.equal(rightsOf('iconify', 'Apache 2.0').commercial_use, true);
    const odd = rightsOf('openverse', 'all rights reserved?');
    assert.deepEqual([odd.status, odd.family, odd.commercial_use], ['provider_claimed', 'unknown', null]);

    // ── through the search ──
    const search = createSearch({
        env: {},
        fetchImpl: async (url) => {
            assert.equal(new URL(url).hostname, 'api.openverse.org');
            return json(fixture('openverse').response);
        },
    });
    const plain = await search.search('images', { engine: 'openverse', q: 'cat', limit: 5 });
    assert.ok(plain.results.length > 0);
    assert.ok(plain.results.every((r) => r.rights && r.rights.status === 'provider_claimed'), 'every result carries its rights');
    const known = await search.search('images', { engine: 'openverse', q: 'cat', limit: 5, require_known_rights: true });
    assert.ok(known.results.every((r) => r.rights.family !== 'unknown'));
    const commercial = await search.search('images', { engine: 'openverse', q: 'cat', limit: 5, commercial: true });
    assert.ok(commercial.results.every((r) => r.rights.commercial_use === true));
    const openOnly = await search.search('images', { engine: 'openverse', q: 'cat', limit: 5, allow_provider_license: false });
    assert.ok(openOnly.results.every((r) => r.rights.family !== 'provider_content_license'));

    // Unsplash's licence passes commercial use, and is dropped when only open licences are allowed.
    const stock = createSearch({
        env: { SEARCH_UNSPLASH_KEY: 'fixture-key' },
        fetchImpl: async (url) => {
            assert.equal(new URL(url).hostname, 'api.unsplash.com');
            return json(fixture('unsplash').response);
        },
    });
    const stockCommercial = await stock.search('images', { engine: 'unsplash', q: 'cat', limit: 5, commercial: true });
    assert.ok(stockCommercial.results.length > 0, 'a provider licence allows commercial use');
    assert.ok(stockCommercial.results.every((r) => r.rights.family === 'provider_content_license' && r.rights.hotlink_required));
    const stockOpen = await stock.search('images', { engine: 'unsplash', q: 'cat', limit: 5, allow_provider_license: false });
    assert.equal(stockOpen.results.length, 0, 'open licences only: no Unsplash licence');

    // The new options are booleans.
    await assert.rejects(search.search('images', { engine: 'openverse', q: 'cat', require_known_rights: 'yes' }), (e) => e.status === 400 || e.status === 422);
    await assert.rejects(search.search('images', { engine: 'openverse', q: 'cat', allow_provider_license: 1 }), (e) => e.status === 400 || e.status === 422);

    console.log('image-rights: discovery unknown, provider licences apart, open licences by clause, and the filters');
})().catch((e) => { console.error(e); process.exit(1); });
