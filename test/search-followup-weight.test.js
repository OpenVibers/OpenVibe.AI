'use strict';
// Deep's second-round searches count half in the fusion (11-28 accuracy run: deep had the answer among its sources less
// often than standard, 182 of 200 against 189). A list's weight scales its reciprocal-rank share; no weight is 1, so
// every other search fuses as before.
const assert = require('node:assert/strict');
const { fuse } = require('../server/search/fusion');
const { FOLLOW_UP_WEIGHT } = require('../server/search/multi');

const list = (engine, query, urls, weight) => ({ engine, query, results: urls.map((u) => ({ title: u, url: `https://${u}.example/`, snippet: u })), ...(weight ? { weight } : {}) });

// Without weights: the same as before (a page two lists rank second beats one ranked first once).
const plain = fuse([list('a', 'q', ['answer', 'x']), list('b', 'gap', ['gap1', 'gap2']), list('c', 'gap', ['gap1', 'answer'])], { limit: 5, perSite: 5 });
assert.equal(plain.results[0].url, 'https://gap1.example/', 'two gap lists put their page first');

// The gap searches as a second round, at half weight: the question's own first result leads again.
const weighted = fuse([list('a', 'q', ['answer', 'x']), list('b', 'gap', ['gap1', 'gap2'], FOLLOW_UP_WEIGHT), list('c', 'gap', ['gap1', 'answer'], FOLLOW_UP_WEIGHT)], { limit: 5, perSite: 5 });
assert.equal(weighted.results[0].url, 'https://answer.example/', 'the question\'s own page leads');
assert.ok(weighted.results.some((r) => r.url === 'https://gap1.example/'), 'the second round still adds its pages');
assert.equal(FOLLOW_UP_WEIGHT, 0.5);

// A list without a weight, or a nonsense one, counts 1.
const odd = fuse([list('a', 'q', ['p']), { ...list('b', 'q', ['p']), weight: -3 }], { limit: 5 });
const same = fuse([list('a', 'q', ['p']), list('b', 'q', ['p'])], { limit: 5 });
assert.equal(odd.results[0].score, same.results[0].score, 'a nonsense weight counts 1');
console.log('search-followup-weight: a second round counts half; every other list as before');
