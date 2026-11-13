'use strict';
// A provider's own terms are routing rules (plan §W.2 step 2, 11-13):
//   - Brave's terms forbid AI use of results (evaluation, benchmarks, training) and anything but transient storage;
//   - Exa keeps queries (a perpetual licence to use them), so a private request never goes there;
//   - an unreviewed provider serves a person's searches as before, never an AI-use purpose and never a private request;
//   - named explicitly, a refused engine answers 422 with the reason and the terms page; on auto it is skipped with the
//     reason in the receipt, and when every engine is refused the call says so;
//   - purpose and private are validated; the engine list shows each engine's reviewed terms.
const assert = require('node:assert/strict');
const { createSearch } = require('../server/search');
const terms = require('../server/search/terms');
const fixture = (name) => require('./fixtures/search/' + name + '.json');
const json = (value) => new Response(JSON.stringify(value), { status: 200 });

(async () => {
    // ── the rules ──
    assert.equal(terms.denial('brave', {}), null, 'a person\'s own search: allowed');
    assert.equal(terms.denial('brave', { purpose: 'answer_grounding' }), null);
    assert.equal(terms.denial('brave', { purpose: 'model_evaluation' }), 'terms_disallow_purpose');
    assert.equal(terms.denial('brave-images', { purpose: 'public_benchmark' }), 'terms_disallow_purpose');
    assert.equal(terms.denial('brave', { purpose: 'monitoring' }), 'retention_incompatible', 'monitoring keeps results; Brave allows transient only');
    assert.equal(terms.denial('exa', { private: true }), 'privacy_incompatible', 'Exa keeps queries');
    assert.equal(terms.denial('perplexity', { private: true }), 'privacy_incompatible', 'Perplexity keeps Search Data (§2.2)');
    assert.equal(terms.termsOf('perplexity').personal_data, 'written_authorization_required');
    assert.equal(terms.denial('tavily', { purpose: 'model_training' }), 'terms_unreviewed');
    assert.equal(terms.denial('tavily', { private: true }), 'privacy_incompatible', 'unknown retention is not private');
    assert.equal(terms.denial('tavily', { purpose: 'agent_research' }), null);
    assert.ok(terms.termsOf('brave').source.startsWith('https://api-dashboard.search.brave.com/'));
    assert.equal(terms.termsOf('brave').reviewed_on, '2026-11-13');

    // ── through the search ──
    let calls = 0;
    const search = createSearch({
        env: { SEARCH_BRAVE_KEY: 'fixture-key' },
        fetchImpl: async (url) => { calls += 1; assert.equal(new URL(url).hostname, 'api.search.brave.com'); return json(fixture('brave').response); },
    });
    const ok = await search.search('web', { engine: 'brave', q: 'cats', limit: 3 });
    assert.ok(ok.results.length > 0, 'an ordinary search still answers');
    const before = calls;
    await assert.rejects(search.search('web', { engine: 'brave', q: 'cats', purpose: 'model_evaluation' }),
        (e) => e.status === 422 && /terms disallow purpose/.test(e.message) && /brave\.com/.test(e.message));
    await assert.rejects(search.search('web', { engine: 'brave', q: 'cats', private: true }),
        (e) => e.status === 422 && /privacy incompatible/.test(e.message));
    await assert.rejects(search.search('web', { q: 'cats', purpose: 'public_benchmark' }),
        (e) => e.status === 422 && /terms allow this request/.test(e.message), 'auto with no permitted engine says so');
    assert.equal(calls, before, 'a refused engine is never called: the key is never sent');

    // Validation.
    await assert.rejects(search.search('web', { q: 'cats', purpose: 'resell_everything' }), (e) => e.status === 400 || e.status === 422);
    await assert.rejects(search.search('web', { q: 'cats', private: 'yes' }), (e) => e.status === 400 || e.status === 422);

    // The catalog shows the reviewed terms.
    const list = await search.engines();
    const brave = list.find((e) => e.id === 'brave');
    assert.equal(brave.terms.storage, 'transient');
    assert.equal(brave.terms.ai_use, false);
    assert.equal(list.find((e) => e.id === 'tavily').terms, null, 'unreviewed is null, never a guess');

    console.log('search-terms: purposes, privacy and storage follow each provider\'s own terms');
})().catch((e) => { console.error(e); process.exit(1); });
