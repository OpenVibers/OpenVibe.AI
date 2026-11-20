'use strict';
// SearXNG with every one of its own engines refusing (11-20 on production: Brave and Google CSE rate-limited, DuckDuckGo
// a CAPTCHA) answers an empty list. That is a failure of the engine, not an empty web: the adapter says so, so the search
// falls back to another engine. An empty list with no refusals is still an honest empty answer.
const assert = require('node:assert/strict');
const sx = require('../server/search/adapters/searxng');

const reply = (body) => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const env = { EXCHANGE_SEARXNG_URL: 'https://searx.example' };

(async () => {
    await assert.rejects(
        sx.search({ q: 'louvre' }, { fetchImpl: reply({ results: [], unresponsive_engines: [['brave', 'Suspended: too many requests'], ['duckduckgo', 'CAPTCHA']] }), env }),
        (err) => /did not answer \(brave, duckduckgo\)/.test(err.message) && err.unbilled === true,
    );
    assert.deepEqual(await sx.search({ q: 'zzqx' }, { fetchImpl: reply({ results: [], unresponsive_engines: [] }), env }), [], 'nothing found, nobody refused: an empty answer');
    const rows = await sx.search({ q: 'louvre' }, { fetchImpl: reply({ results: [{ title: 'Louvre', url: 'https://www.louvre.fr/', content: 'Hours' }], unresponsive_engines: [['google', 'access denied']] }), env });
    assert.equal(rows.length, 1, 'some engines refused, others answered: the answers count');
    console.log('search-searxng-refused: 1 check passed');
})().catch((e) => { console.error(e); process.exit(1); });
