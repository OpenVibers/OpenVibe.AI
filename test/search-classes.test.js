'use strict';
// Engine classes (plan §W.2 step 4, 11-13):
//   - every adapter says what class of engine it is, and the registry refuses one that does not;
//   - the engine list shows the class of every engine;
//   - a request may name the classes it wants (one name or a list); an unknown class is 422;
//   - auto keeps the classes the request asked for, or the kind's default classes, and only then compares price,
//     health and terms: an answer engine is never ranked against a raw index by price alone;
//   - the receipt names the class of the engine that answered and the engines whose class kept them out.
const assert = require('node:assert/strict');
const { createSearch, adapters } = require('../server/search');
const classes = require('../server/search/classes');
const fixture = name => require('./fixtures/search/' + name + '.json').response;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

(async () => {
    // ── the classes themselves ──
    assert.deepEqual([...classes.CLASS_NAMES].sort(), ['answer_engine', 'first_party_index', 'icon_catalog',
        'independent_index', 'metasearch', 'open_asset_catalog', 'page_reader', 'product_visual_search',
        'provider_asset_catalog', 'reverse_image', 'semantic', 'serp_proxy', 'visual_web_detection',
        'web_image_discovery']);
    for (const a of adapters) {
        assert.ok(classes.isClass(a.class), a.id + ' names a class');
        assert.ok(a.kinds.length, a.id + ' serves a kind');
    }
    // The registry refuses an adapter without a known class: a nameless engine cannot be compared with another.
    assert.throws(() => classes.checkAdapters([{ id: 'nameless', kinds: ['web'] }]), /no known class/);

    // ── the engine list shows the class ──
    const listed = createSearch({ env: {} });
    const cards = await listed.engines();
    assert.equal(cards.length, adapters.length);
    for (const card of cards) assert.equal(card.class, adapters.find(a => a.id === card.id).class, card.id);
    assert.equal(cards.find(e => e.id === 'brave').class, 'independent_index');
    assert.equal(cards.find(e => e.id === 'perplexity').class, 'answer_engine');
    assert.equal(cards.find(e => e.id === 'openvibe').class, 'first_party_index');
    assert.equal(cards.find(e => e.id === 'serpapi').class, 'serp_proxy');
    assert.equal(cards.find(e => e.id === 'searxng').class, 'metasearch');
    assert.equal(cards.find(e => e.id === 'exa').class, 'semantic');
    assert.equal(cards.find(e => e.id === 'jina').class, 'page_reader');
    assert.equal(cards.find(e => e.id === 'iconify').class, 'icon_catalog');
    assert.equal(cards.find(e => e.id === 'tineye').class, 'reverse_image');
    assert.equal(cards.find(e => e.id === 'openverse').class, 'open_asset_catalog');
    assert.equal(cards.find(e => e.id === 'unsplash').class, 'provider_asset_catalog');
    assert.equal(cards.find(e => e.id === 'brave-images').class, 'web_image_discovery');

    // ── the default classes per kind ──
    assert.deepEqual([...classes.DEFAULT_CLASSES.web], ['independent_index', 'serp_proxy', 'first_party_index', 'metasearch']);
    assert.deepEqual([...classes.DEFAULT_CLASSES.images], ['open_asset_catalog', 'provider_asset_catalog', 'web_image_discovery']);
    assert.deepEqual([...classes.DEFAULT_CLASSES.icons], ['icon_catalog']);
    assert.deepEqual([...classes.DEFAULT_CLASSES.fetch], ['page_reader']);
    assert.deepEqual([...classes.DEFAULT_CLASSES.reverse_image], ['reverse_image']);

    // ── a request names the classes it wants ──
    const hosts = [];
    const search = createSearch({
        env: { SEARCH_SERPER_KEY: 'serper-key', SEARCH_BRAVE_KEY: 'brave-key', SEARCH_DEEPSEEK_KEY: 'deepseek-key',
            SEARCH_PERPLEXITY_KEY: 'perplexity-key', SEARCH_JINA_KEY: 'jina-key', SEARCH_UNSPLASH_KEY: 'unsplash-key' },
        fetchImpl: async (url) => {
            const host = new URL(url).hostname;
            hosts.push(host);
            if (host === 'google.serper.dev') return json(fixture('serper'));
            if (host === 'api.search.brave.com') return json(fixture('brave'));
            if (host === 'api.deepseek.com') return json(fixture('deepseek'));
            if (host === 'api.perplexity.ai') return json(fixture('perplexity'));
            if (host === 'api.unsplash.com') return json(fixture('unsplash'));
            return json({}, 503);
        },
    });
    const only = await search.search('web', { q: 'lantern', class: 'serp_proxy' });
    assert.equal(only.receipt.engine, 'serper', 'a named class is the only class used');
    assert.deepEqual([...new Set(hosts)], ['google.serper.dev']);
    assert.deepEqual(only.receipt.classes_allowed, ['serp_proxy']);
    assert.ok(only.receipt.not_considered.some(n => n.engine === 'brave' && n.class === 'independent_index' && n.reason === 'class_not_considered'),
        'the receipt says which class kept the others out');
    const two = await search.search('web', { q: 'lantern', class: ['independent_index', 'serp_proxy'] });
    assert.equal(two.receipt.engine, 'deepseek', 'the cheapest engine inside the named classes answers');
    assert.deepEqual(two.receipt.classes_allowed, ['independent_index', 'serp_proxy']);
    // An unknown class is refused before anything is called.
    const before = hosts.length;
    await assert.rejects(search.search('web', { q: 'lantern', class: 'imaginary_engine' }),
        e => e.status === 422 && /class must be one of/.test(e.message));
    await assert.rejects(search.search('web', { q: 'lantern', class: ['serp_proxy', 'imaginary_engine'] }), e => e.status === 422);
    await assert.rejects(search.search('web', { q: 'lantern', class: [] }), e => e.status === 422);
    assert.equal(hosts.length, before, 'a refused class never calls an engine');
    // A named engine outside the named classes is refused; a named engine on its own is the caller asking for it.
    await assert.rejects(search.search('web', { q: 'lantern', engine: 'brave', class: 'answer_engine' }),
        e => e.status === 422 && /not a answer_engine engine/.test(e.message));
    const asked = await search.search('web', { q: 'lantern', engine: 'perplexity' });
    assert.equal(asked.receipt.engine, 'perplexity', 'a named engine is the caller asking for that class');
    assert.equal(asked.receipt.class, 'answer_engine');

    // ── auto never ranks unlike engines by price alone ──
    // A cheap answer engine stands in for one: on a plain display it is never considered, and for an answer it is.
    const cheap = {
        id: 'cheap-answer', class: 'answer_engine', kinds: ['web'], byok: false, price_per_1000: 0,
        checked_on: '2026-11-13', source: 'https://example.org', freshness: [],
        search: async () => [{ title: 'Answer', url: 'https://example.org/answer', snippet: 'An answer', published: null }],
    };
    adapters.push(cheap);
    try {
        const mixed = createSearch({
            env: { SEARCH_DEEPSEEK_KEY: 'deepseek-key' },
            fetchImpl: async (url) => {
                const host = new URL(url).hostname;
                if (host === 'api.deepseek.com') return json(fixture('deepseek'));
                return json({}, 503);
            },
        });
        const display = await mixed.search('web', { q: 'lantern' });
        assert.equal(display.receipt.engine, 'deepseek', 'the answer engine is not the cheapest engine to use here');
        assert.ok(display.receipt.not_considered.some(n => n.engine === 'cheap-answer' && n.class === 'answer_engine'),
            'the receipt names the answer engine that was not considered');
        assert.equal(display.receipt.class, 'independent_index');
        const grounded = await mixed.search('web', { q: 'lantern', purpose: 'answer_grounding' });
        assert.equal(grounded.receipt.engine, 'cheap-answer', 'an answer or a research request may use an answer engine');
        assert.equal(grounded.receipt.class, 'answer_engine');
        assert.ok(grounded.receipt.classes_allowed.includes('answer_engine'));
        assert.ok(grounded.receipt.classes_allowed.includes('semantic'));
        // The semantic class is asked for the same way; a class with no engine behind it is refused.
        const named = await mixed.search('web', { q: 'lantern', class: 'answer_engine' });
        assert.equal(named.receipt.engine, 'cheap-answer', 'only the named class is used');
        assert.deepEqual(named.receipt.classes_allowed, ['answer_engine']);
        await assert.rejects(mixed.search('web', { q: 'lantern', class: 'semantic' }),
            e => e.status === 422 && /No semantic engine/.test(e.message), 'a class with no engine behind it is refused');
    } finally { adapters.pop(); }

    // ── the receipt names the class ──
    const answered = await search.search('web', { q: 'lantern' });
    assert.equal(answered.receipt.class, adapters.find(a => a.id === answered.receipt.engine).class);
    assert.ok(Array.isArray(answered.receipt.classes_allowed) && answered.receipt.classes_allowed.length);
    for (const n of answered.receipt.not_considered) {
        assert.equal(n.class, adapters.find(a => a.id === n.engine).class, n.engine);
        assert.equal(n.reason, 'class_not_considered');
    }
    // An image request keeps to the image classes; an icon request keeps to the icon catalog.
    const images = await search.search('images', { q: 'cat', class: 'provider_asset_catalog' });
    assert.equal(images.receipt.engine, 'unsplash');
    assert.equal(images.receipt.class, 'provider_asset_catalog');

    console.log('search classes: every adapter names its class, a request may name classes, auto never ranks unlike engines, the receipt says so');
})().catch(e => { console.error(e); process.exitCode = 1; });