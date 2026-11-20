'use strict';
// Wikipedia as a search engine (11-20): its own search over the English Wikipedia, free, with a named User-Agent; in
// search v2 it only fills a place no web engine is left for. With the shared engines of production (DeepSeek and a
// SearXNG) a standard search's third engine is Wikipedia and fast stays on the two web engines; with more web engines
// it is not asked.
const assert = require('node:assert/strict');
const wiki = require('../server/search/adapters/wikipedia');
const { createSearch } = require('../server/search');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const WIKI = { query: { search: [{ title: 'Doll Man', snippet: 'The third <span class="searchmatch">Doll</span> Man is Dane Maxwell' }, { title: 'AC/DC: Live', snippet: 'album' }] } };

(async () => {
    let seen = null;
    const rows = await wiki.search({ q: 'third Doll Man', limit: 5 }, { fetchImpl: async (url, init) => { seen = { url, ua: init.headers['user-agent'] }; return json(WIKI); } });
    const u = new URL(seen.url);
    assert.equal(u.hostname, 'en.wikipedia.org');
    assert.equal(u.searchParams.get('srsearch'), 'third Doll Man');
    assert.equal(u.searchParams.get('srlimit'), '5');
    assert.match(seen.ua, /OpenVibeSearch\/1\.0 \(https:\/\/openvibe\.exchange\/search/, 'a named User-Agent, as the API asks');
    assert.deepEqual(rows[0], { title: 'Doll Man - Wikipedia', url: 'https://en.wikipedia.org/wiki/Doll_Man', snippet: 'The third Doll Man is Dane Maxwell', published: null });
    assert.equal(rows[1].url, 'https://en.wikipedia.org/wiki/AC/DC:_Live', 'titles stay readable in the address');
    console.log('  ✓ the engine: its own search API, a named User-Agent, article links, snippets as text');

    // In v2, beside production's two shared web engines.
    const asked = [];
    const fetchImpl = async (url) => {
        const host = new URL(url).hostname;
        asked.push(host);
        if (host === 'en.wikipedia.org') return json(WIKI);
        if (host === 'api.deepseek.com') return json({ results: [{ title: 'Doll Man (comics)', url: 'https://example.org/dollman', snippet: 'Doll Man is a superhero' }] });
        if (host === 'api.search.brave.com') return json({ web: { results: [{ title: 'Doll Man', url: 'https://example.org/brave', description: 'b' }] } });
        if (host === 'searx.example') return json({ results: [{ title: 'Doll Man history', url: 'https://example.org/searx', content: 's' }] });
        return json({}, 503);
    };
    const shared = createSearch({ env: { SEARCH_DEEPSEEK_KEY: 'k', EXCHANGE_SEARXNG_URL: 'https://searx.example' }, fetchImpl, log: { warn() {}, log() {}, error() {} } });
    asked.length = 0;
    const fast = await shared.search('web', { q: 'third Doll Man', depth: 'fast' });
    assert.deepEqual([...fast.receipt.engines].sort(), ['deepseek', 'searxng'], 'fast stays on the two web engines');
    const std = await shared.search('web', { q: 'third Doll Man', depth: 'standard', excerpts: false });
    assert.ok(std.receipt.engines.includes('wikipedia'), `standard's third engine is Wikipedia (${std.receipt.engines})`);
    assert.ok(std.results.some((r) => r.url === 'https://en.wikipedia.org/wiki/Doll_Man'));
    const plain = await shared.search('web', { q: 'third Doll Man' });
    assert.notEqual(plain.receipt.engine, 'wikipedia', 'a plain search does not move to Wikipedia because it is free');
    const more = createSearch({ env: { SEARCH_DEEPSEEK_KEY: 'k', SEARCH_BRAVE_KEY: 'k', EXCHANGE_SEARXNG_URL: 'https://searx.example' }, fetchImpl, log: { warn() {}, log() {}, error() {} } });
    const full = await more.search('web', { q: 'third Doll Man', depth: 'standard', excerpts: false });
    assert.ok(!full.receipt.engines.includes('wikipedia'), `with three web engines it is not asked (${full.receipt.engines})`);
    console.log('  ✓ v2: Wikipedia fills a place no web engine is left for; fast and plain searches are unchanged');
    console.log('search-wikipedia: 2 checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
