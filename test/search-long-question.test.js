'use strict';
// A long question (11-20, SimpleQA on production): DeepSeek takes at most 128 characters, and the planner left it out
// of any search whose question was longer, so a standard search ran on SearXNG alone and found nothing. An engine with
// a query limit is now asked a shortened question, and the other engines still get the whole one.
const assert = require('node:assert/strict');
const { createSearch, shortQuery } = require('../server/search');

const json = (body) => new Response(JSON.stringify(body));
const LONG = 'In which year did Julian Bradley, the first Black Republican to serve in the Wisconsin Senate and left the Democratic Party in 2009, move to La Crosse, Wisconsin, with his mother?';

(async () => {
    const short = shortQuery(LONG, 128);
    assert.ok(short.length <= 128 && /^year Julian Bradley/.test(short) && /La Crosse/.test(short), short);
    assert.equal(shortQuery('Who won?', 128), 'Who won', 'a short question is only trimmed');
    assert.equal(shortQuery('the of and a an', 4), null, 'nothing useful left');
    console.log('  ✓ the shortener keeps the names and drops the question words');

    const asked = [];
    const fetchImpl = async (url, init = {}) => {
        const host = new URL(url).hostname;
        let q = new URL(url).searchParams.get('q');
        try { const b = JSON.parse(init.body); q = b.q || b.query || b.keywords || q; } catch { /* a GET */ }
        asked.push([host, q]);
        if (host === 'api.deepseek.com') return json({ results: [{ title: 'Julian Bradley moved to La Crosse in 1992', url: 'https://example.org/bradley', snippet: 'In 1992 he moved to La Crosse with his mother.' }] });
        if (host === 'api.search.brave.com') return json({ web: { results: [{ title: 'Julian Bradley', url: 'https://example.org/jb', description: 'Wisconsin senator' }] } });
        return json({}, 503);
    };
    const s = createSearch({ env: { SEARCH_BRAVE_KEY: 'k', SEARCH_DEEPSEEK_KEY: 'k' }, fetchImpl, log: { warn() {}, log() {}, error() {} } });
    const out = await s.search('web', { q: LONG, depth: 'fast' });
    const ds = asked.find(([h]) => h === 'api.deepseek.com');
    assert.ok(ds, `DeepSeek is asked (${JSON.stringify(asked)})`);
    assert.ok(ds[1].length <= 128 && /Julian Bradley/.test(ds[1]), 'with the shortened question');
    const brave = asked.find(([h]) => h === 'api.search.brave.com');
    assert.equal(brave[1], LONG, 'the other engine still gets the whole question');
    assert.ok(out.results.some((r) => /1992/.test(r.snippet)), 'and what DeepSeek found is in the list');
    console.log('  ✓ an engine with a query limit is asked a shortened question, not left out');
    console.log('search-long-question: 2 checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
