'use strict';
// The search caches follow each provider's own terms (plan §W.2 step 6, 11-14):
//   - every reviewed provider says what may be kept: Brave the same person's for five minutes, Pixabay shared
//     for a day (its API docs require the cache), Mojeek shared for an hour on the Startup plan, Exa and
//     Perplexity the same person's for ten minutes, Parallel nothing at all, and a provider nobody read the
//     same person's for ten minutes;
//   - a private request is never kept and never answered from a cache;
//   - a same-person cache never answers another person; a shared one does;
//   - a kept answer is at most 256 KB and lives for exactly the provider's own TTL;
//   - a hit costs nothing and says so in the receipt, with the age of the answer;
//   - the copy lives in Valkey (every process shares it) and never in PostgreSQL.
const assert = require('node:assert/strict');
const { createSearch, CHARGE } = require('../server/search');
const terms = require('../server/search/terms');
const cache = require('../server/search/cache');
const { MAX_VALUE_BYTES } = cache;
const fixture = (name) => require('./fixtures/search/' + name + '.json');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const alice = 'usr_alice_cache';
const bob = 'usr_bob_cache';
// A person's own subject id, the shape the service's tokens carry.
const person = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPX';

/** A Valkey that keeps what it is given, so the test can read the keys and the TTLs. */
function fakeValkey() {
    const store = new Map();
    const written = [];
    return {
        store,
        written,
        key: (...parts) => 'test:' + parts.join(':'),
        client: {
            async get(k) { return store.has(k) ? store.get(k) : null; },
            async set(k, v, mode, seconds) { store.set(k, v); written.push({ k, v, mode, seconds }); return 'OK'; },
            async del(k) { store.delete(k); return 1; },
        },
    };
}
const cacheKeys = (valkey) => [...valkey.store.keys()].filter(k => k.includes('search:cache'));

(async () => {
    // ── The scope and the TTL each provider's own terms decided ──────────────────────────────────────
    assert.deepEqual(terms.cacheOf('brave'), { scope: 'same_user', ttl_s: 300 }, 'Brave: transient, the same person, five minutes');
    assert.deepEqual(terms.cacheOf('brave-images'), { scope: 'same_user', ttl_s: 300 });
    assert.deepEqual(terms.cacheOf('pixabay'), { scope: 'shared', ttl_s: 86400 }, 'Pixabay: its API docs require a 24-hour cache');
    assert.deepEqual(terms.cacheOf('mojeek'), { scope: 'same_user', ttl_s: 3600 }, 'Mojeek: without storage rights the cache serves the same user for an hour');
    assert.deepEqual(terms.cacheOf('exa'), { scope: 'same_user', ttl_s: 600 }, 'Exa: it keeps the queries anyway, the cache only spares the price');
    assert.deepEqual(terms.cacheOf('perplexity'), { scope: 'same_user', ttl_s: 600 }, 'Perplexity: it keeps the Search Data anyway');
    assert.deepEqual(terms.cacheOf('parallel'), { scope: 'none', ttl_s: 0 }, 'Parallel: its terms forbid caching the output');
    assert.deepEqual(terms.cacheOf('you'), { scope: 'same_user', ttl_s: 600 });
    assert.deepEqual(terms.cacheOf('dataforseo'), { scope: 'same_user', ttl_s: 600 });
    assert.deepEqual(terms.cacheOf('tavily'), { scope: 'same_user', ttl_s: 600 }, 'a provider nobody read: the same person, ten minutes');
    assert.deepEqual(terms.cacheOf('nothing-like-this'), terms.DEFAULT_CACHE);
    assert.ok(terms.CACHE_SCOPES.includes(terms.cacheOf('brave').scope));

    // ── A hit costs nothing, and the receipt says how old the answer is ──────────────────────────────
    const valkey = fakeValkey();
    let calls = 0;
    const search = createSearch({
        env: { SEARCH_BRAVE_KEY: 'shared-brave' }, valkey,
        fetchImpl: async () => { calls += 1; return json(fixture('brave').response); },
    });
    const first = await search.search('web', { q: 'cats', engine: 'brave' }, { subject: alice });
    assert.equal(calls, 1, 'the first answer comes from the provider');
    assert.deepEqual(first.receipt.cache, { hit: false }, 'a miss says it was not kept');
    assert.equal(first.receipt.cost_usd, .005, 'the provider was paid');
    // The key layout: search:cache:<scope>:<engine>:<sha256>.
    const keys = cacheKeys(valkey);
    assert.equal(keys.length, 1, 'one kept answer');
    assert.match(keys[0], /^test:search:cache:same_user:brave:[0-9a-f]{64}$/, 'the key names the scope, the engine and the digest');
    assert.equal(valkey.written.at(-1).mode, 'EX', 'the copy expires on its own');
    assert.equal(valkey.written.at(-1).seconds, 300, "Brave's own limit: five minutes");
    const second = await search.search('web', { q: 'cats', engine: 'brave' }, { subject: alice });
    assert.equal(calls, 1, 'the second search is answered from the cache: the provider is not called');
    assert.equal(second.receipt.cache.hit, true);
    assert.equal(second.receipt.cache.age_s, 0);
    assert.equal(second.receipt.cost_usd, 0, 'a hit costs nothing');
    assert.equal(second[CHARGE], 0, 'and nothing is charged');
    assert.deepEqual(second.results, first.results, 'the kept answer is the normalized result');
    // A different filter is a different answer.
    await search.search('web', { q: 'cats', engine: 'brave', limit: 5 }, { subject: alice });
    assert.equal(calls, 2, 'another limit is another answer');
    assert.equal(cacheKeys(valkey).length, 2);
    // A different freshness is a different answer too (Mojeek's own since parameter).
    let mojeekFresh = 0;
    const fresh = createSearch({
        env: { SEARCH_MOJEEK_KEY: 'shared-mojeek' }, valkey: fakeValkey(),
        fetchImpl: async () => { mojeekFresh += 1; return json(fixture('mojeek').response); },
    });
    await fresh.search('web', { q: 'lantern', engine: 'mojeek' }, { subject: alice });
    await fresh.search('web', { q: 'lantern', engine: 'mojeek', freshness: 'day' }, { subject: alice });
    assert.equal(mojeekFresh, 2, 'another freshness is another answer');

    // ── A same-person cache never answers another person ─────────────────────────────────────────────
    const forBob = await search.search('web', { q: 'cats', engine: 'brave' }, { subject: bob });
    assert.equal(calls, 3, "another person's search is not answered from the first person's cache");
    assert.equal(forBob.receipt.cache.hit, false);
    assert.ok(cacheKeys(valkey).every(k => /same_user/.test(k)), 'the copies are named after their person');

    // ── Mojeek: without storage rights the cache serves the same user for an hour ─────────────────────
    const mojeekValkey = fakeValkey();
    let mojeekCalls = 0;
    const mojeek = createSearch({
        env: { SEARCH_MOJEEK_KEY: 'shared-mojeek' }, valkey: mojeekValkey,
        fetchImpl: async () => { mojeekCalls += 1; return json(fixture('mojeek').response); },
    });
    await mojeek.search('web', { q: 'lantern', engine: 'mojeek' }, { subject: alice });
    assert.match(cacheKeys(mojeekValkey)[0], /^test:search:cache:same_user:mojeek:[0-9a-f]{64}$/);
    assert.equal(mojeekValkey.written.at(-1).seconds, 3600, "Mojeek's own limit: one hour");
    await mojeek.search('web', { q: 'lantern', engine: 'mojeek' }, { subject: bob });
    assert.equal(mojeekCalls, 2, "without storage rights Mojeek's cache serves one user, not the next");

    // ── A shared cache answers anyone, for the provider's own day (Pixabay) ────────────────────────────
    const pixabayValkey = fakeValkey();
    let pixabayCalls = 0;
    const pixabay = createSearch({
        env: { SEARCH_PIXABAY_KEY: 'shared-pixabay' }, valkey: pixabayValkey,
        fetchImpl: async () => { pixabayCalls += 1; return json(fixture('pixabay').response); },
    });
    await pixabay.search('images', { q: 'cat', engine: 'pixabay' }, { subject: alice });
    const pixabayForBob = await pixabay.search('images', { q: 'cat', engine: 'pixabay' }, { subject: bob });
    assert.equal(pixabayCalls, 1, 'the shared cache answers anyone: Pixabay requires the cache');
    assert.equal(pixabayForBob.receipt.cache.hit, true);
    assert.match(cacheKeys(pixabayValkey)[0], /^test:search:cache:shared:pixabay:[0-9a-f]{64}$/);
    assert.equal(pixabayValkey.written.at(-1).seconds, 86400, "Pixabay's API docs: the answers are cached for 24 hours");

    // ── A private request is never kept and never answered from a cache ───────────────────────────────
    // The rule itself: a private request has no cache at all, for any provider.
    assert.equal(cache.policyFor('brave', { private: true, subject: alice }), null, 'a private request is never cached');
    assert.equal(cache.policyFor('pixabay', { private: true, subject: alice }), null);
    assert.equal(cache.policyFor('brave', { subject: alice }).scope, 'same_user');
    assert.equal(cache.policyFor('brave', { subject: null }), null, 'a same-person cache needs a person to name it after');
    assert.equal(cache.policyFor('parallel', { subject: alice }), null, "Parallel's terms forbid caching");
    assert.equal(cache.policyFor('brave', { kind: 'fetch', subject: alice }), null, 'a page read is not a search result');
    // And through the search: Brave's own terms refuse a private request today (it does not publish what it
    // keeps), so the request never reaches a provider and nothing is kept.
    const privateValkey = fakeValkey();
    let privateCalls = 0;
    const priv = createSearch({
        env: { SEARCH_BRAVE_KEY: 'shared-brave' }, valkey: privateValkey,
        fetchImpl: async () => { privateCalls += 1; return json(fixture('brave').response); },
    });
    await assert.rejects(priv.search('web', { q: 'secret', engine: 'brave', private: true }, { subject: alice }),
        (e) => e.status === 422 && /privacy incompatible/.test(e.message));
    assert.equal(privateCalls, 0, 'the provider is never called for a private request it may not serve');
    assert.equal(cacheKeys(privateValkey).length, 0, 'a private request is never kept');

    // ── A provider whose terms forbid caching keeps nothing ───────────────────────────────────────────
    const noCacheValkey = fakeValkey();
    let parallelCalls = 0;
    const noCache = createSearch({
        env: { SEARCH_PARALLEL_KEY: 'shared-parallel' }, valkey: noCacheValkey,
        fetchImpl: async () => { parallelCalls += 1; return json(fixture('parallel').response); },
    });
    const n1 = await noCache.search('web', { q: 'lantern', engine: 'parallel' }, { subject: alice });
    const n2 = await noCache.search('web', { q: 'lantern', engine: 'parallel' }, { subject: alice });
    assert.equal(parallelCalls, 2, "Parallel's terms forbid caching the output");
    assert.equal(cacheKeys(noCacheValkey).length, 0);
    assert.equal(n1.receipt.cache, undefined);
    assert.equal(n2.receipt.cache, undefined);

    // ── A kept answer is at most 256 KB: a bigger one is not kept at all ─────────────────────────────
    const bigValkey = fakeValkey();
    const big = JSON.parse(JSON.stringify(fixture('brave').response));
    big.web.results[0].title = 'x'.repeat(MAX_VALUE_BYTES + 1024);
    let bigCalls = 0;
    const bigSearch = createSearch({
        env: { SEARCH_BRAVE_KEY: 'shared-brave' }, valkey: bigValkey,
        fetchImpl: async () => { bigCalls += 1; return json(big); },
    });
    await bigSearch.search('web', { q: 'huge', engine: 'brave' }, { subject: alice });
    assert.equal(cacheKeys(bigValkey).length, 0, 'a result over the cap is not kept');
    await bigSearch.search('web', { q: 'huge', engine: 'brave' }, { subject: alice });
    assert.equal(bigCalls, 2, 'so the provider is asked again');

    // ── Without Valkey the copy is a Map in this process, and it expires on the provider's own TTL ─────
    let time = 1000000;
    let aloneCalls = 0;
    const alone = createSearch({
        env: { SEARCH_BRAVE_KEY: 'shared-brave' }, now: () => time,
        fetchImpl: async () => { aloneCalls += 1; return json(fixture('brave').response); },
    });
    await alone.search('web', { q: 'cats', engine: 'brave' }, { subject: alice });
    const inProcess = await alone.search('web', { q: 'cats', engine: 'brave' }, { subject: alice });
    assert.equal(aloneCalls, 1, 'without Valkey the copy is a Map in this process');
    assert.equal(inProcess.receipt.cache.hit, true);
    time += 300001;
    await alone.search('web', { q: 'cats', engine: 'brave' }, { subject: alice });
    assert.equal(aloneCalls, 2, "after Brave's five minutes the answer is gone");

    // ── Two services, one Valkey: the copy is shared between the processes ────────────────────────────
    const sharedValkey2 = fakeValkey();
    const one = createSearch({ env: { SEARCH_BRAVE_KEY: 'shared-brave' }, valkey: sharedValkey2, fetchImpl: async () => json(fixture('brave').response) });
    const secondService = createSearch({ env: { SEARCH_BRAVE_KEY: 'shared-brave' }, valkey: sharedValkey2, fetchImpl: async () => { throw new Error('the provider must not be called'); } });
    await one.search('web', { q: 'cats', engine: 'brave' }, { subject: alice });
    const across = await secondService.search('web', { q: 'cats', engine: 'brave' }, { subject: alice });
    assert.equal(across.receipt.cache.hit, true, 'the other process answers from the same copy');
    assert.equal(across.receipt.cost_usd, 0);

    // ── A kept answer is served even when the engine itself is in cooldown ────────────────────────────
    {
        const coolValkey = fakeValkey();
        let braveCalls = 0;
        const fetchFor = (fail) => async (url) => {
            const host = new URL(url).hostname;
            if (host === 'search.openvibe.network') throw new Error('the first-party index is down');
            if (host === 'api.search.brave.com') {
                if (fail) throw new Error('upstream is down');
                braveCalls += 1;
                return json(fixture('brave').response);
            }
            return json({}, 503);
        };
        const cold = createSearch({ env: { SEARCH_BRAVE_KEY: 'shared-brave' }, valkey: coolValkey, fetchImpl: fetchFor(true) });
        await assert.rejects(cold.search('web', { q: 'cats', engine: 'brave' }, { subject: alice }), (e) => e.status === 503);
        // An explicit engine is retried during the cooldown: it answers now, and its answer is kept.
        const warm = createSearch({ env: { SEARCH_BRAVE_KEY: 'shared-brave' }, valkey: coolValkey, fetchImpl: fetchFor(false) });
        const answered = await warm.search('web', { q: 'cats', engine: 'brave' }, { subject: alice });
        assert.equal(answered.receipt.cache.hit, false);
        assert.equal(braveCalls, 1);
        // Now the automatic search finds the engine in cooldown, and the kept answer is served for free.
        const secondOut = await warm.search('web', { q: 'cats' }, { subject: alice });
        assert.equal(secondOut.receipt.cache.hit, true, 'the kept answer is served while the engine cools down');
        assert.equal(secondOut.receipt.cost_usd, 0, 'and it costs nothing');
        assert.equal(braveCalls, 1, 'the provider is not called again');
    }

    // ── The Exchange API keeps its copies in the service's Valkey, not in the process ───────────────────
    {
        const { boot, request, token, ALL } = require('./helpers');
        const apiValkey = fakeValkey();
        let apiCalls = 0;
        const h = await boot({
            env: { SEARCH_BRAVE_KEY: 'shared-brave' }, valkey: apiValkey,
            searchFetch: async () => { apiCalls += 1; return json(fixture('brave').response); },
        });
        try {
            const tok = token('alice', ALL, { sub: person, actorType: 'user' });
            const first = await request(h.base, 'POST', '/v1/search', { tok, body: { q: 'cats', engine: 'brave' } });
            assert.equal(first.status, 200, JSON.stringify(first.body));
            assert.equal(first.body.receipt.cache.hit, false, 'the first answer comes from the provider');
            assert.equal(apiCalls, 1);
            const second = await request(h.base, 'POST', '/v1/search', { tok, body: { q: 'cats', engine: 'brave' } });
            assert.equal(second.status, 200, JSON.stringify(second.body));
            assert.equal(second.body.receipt.cache.hit, true, 'the second answer comes from the service cache');
            assert.equal(second.body.receipt.cost_usd, 0, 'a hit costs nothing');
            assert.equal(apiCalls, 1, 'the provider is called once');
            assert.ok(cacheKeys(apiValkey).length >= 1, 'the copy is in the service Valkey');
        } finally { await h.stop(); }
    }

    console.log('search cache: the scopes and TTLs of each provider, private never kept, same_user never crosses people, the 256 KB cap, the receipt and the shared Valkey passed');
})().catch((e) => { console.error(e); process.exit(1); });
