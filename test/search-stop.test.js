'use strict';
// Search v2 that stops early and spends less (the owner, 11-21: "make it so searches can be cancelled or stopped to save
// on cost so that for instance if an AI found what it needed it can end the search early … find other efficiencies and
// also scrape our own data sources for free … more configurable"):
//   a caller that stops (signal) or runs out of time (max_time_ms) gets what was found so far, charged only what ran;
//   OpenVibe's own index is searched alongside every auto search, free; free_only uses only what costs nothing;
//   steps changes a depth's steps; model picks the answer's model; identical searches are answered from memory, free.
const assert = require('node:assert/strict');
const { createSearch, CHARGE } = require('../server/search');
const { inputOf } = require('../server/search/multi');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    let pass = 0;
    const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };

    const asked = [];
    let ownDelay = 0;
    const qOf = (url, init) => {
        const u = new URL(url);
        if (u.searchParams.get('q')) return u.searchParams.get('q');
        if (u.searchParams.get('srsearch')) return u.searchParams.get('srsearch');
        try { const b = JSON.parse(init.body); return b.q || b.query || ''; } catch { return ''; }
    };
    const fetchImpl = async (url, init = {}) => {
        const host = new URL(url).hostname;
        const q = qOf(url, init);
        asked.push([host, q]);
        if (host === 'api.search.brave.com') return json({ web: { results: [
            { title: 'Lantern makers in Lisbon', url: 'https://example.org/lisbon', description: 'Five lantern makers in Lisbon open their workshops to visitors this winter' },
            { title: 'Brave only lantern makers Lisbon', url: 'https://brave-only.com/1', description: 'More lantern makers in Lisbon' },
        ] } });
        if (host === 'google.serper.dev') return json({ organic: [
            { title: 'Lantern makers in Lisbon', link: 'https://www.example.org/lisbon/', snippet: 'Five lantern makers in Lisbon open their workshops to visitors this winter' },
        ] });
        if (host === 'en.wikipedia.org') return json({ query: { search: [{ title: 'Lanterns of Lisbon', snippet: 'Lantern makers in Lisbon have worked since the 1930s' }] } });
        if (host === 'search.openvibe.network') {
            if (ownDelay) await wait(ownDelay);
            return json({ results: [
                { title: 'Lantern makers tour in Lisbon', canonical_url: 'https://openvibe.tours/lisbon-lantern-makers', summary: 'A walking tour of the lantern makers in Lisbon, from 12 EUR' },
                { title: 'Running shoes sale', canonical_url: 'https://openvibe.deals/shoes', summary: 'Half price trainers' },
            ] });
        }
        if (host === 'r.jina.ai') return json({ code: 200, data: { title: 'Lantern', url: 'https://example.org/lisbon', content: 'Five lantern makers in Lisbon open their workshops to visitors this winter; the oldest has worked since 1932.', usage: { tokens: 1000 } } });
        return json({}, 503);
    };
    const llmCalls = [];
    let answerDelay = 0;
    const llm = { call: async (req) => {
        llmCalls.push({ step: req.schemaName, prefer: req.prefer, signal: req.signal });
        if (req.schemaName === 'search_variants') return { json: { queries: ['Lisbon lantern workshops'] }, model: 'fake/small', cost_usd: 0.0004 };
        if (req.schemaName === 'search_answer') {
            if (answerDelay) {
                // A model call that honours its signal, as the router's does.
                await new Promise((resolve, reject) => {
                    const t = setTimeout(resolve, answerDelay);
                    if (req.signal) req.signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { code: 'aborted' })); }, { once: true });
                });
            }
            return { json: { answer: 'Five lantern makers open their workshops [1].', cited: [1] }, model: 'fake/writer', cost_usd: 0.002 };
        }
        throw new Error('unexpected step ' + req.schemaName);
    } };
    const env = { SEARCH_BRAVE_KEY: 'k', SEARCH_SERPER_KEY: 'k', SEARCH_JINA_KEY: 'k' };
    const s = createSearch({ env, fetchImpl, llm, log: { warn() {}, log() {}, error() {} } });
    const hosts = () => [...new Set(asked.map(([h]) => h))].sort();

    // ── The request ──
    assert.throws(() => inputOf({ q: 'x', steps: { rewrites: 9 } }), /steps.rewrites must be 0–5/);
    assert.throws(() => inputOf({ q: 'x', steps: { magic: 1 } }), /"magic" is not a step/);
    assert.throws(() => inputOf({ q: 'x', max_time_ms: 50 }), /max_time_ms must be a whole number of milliseconds, 300–120000/);
    assert.throws(() => inputOf({ q: 'x', search_id: 'no spaces allowed' }), /search_id must be 8–64/);
    assert.throws(() => inputOf({ q: 'x', model: 'fake/writer' }), /model is for output answer or structured/);
    assert.throws(() => inputOf({ q: 'x', free_only: 'yes' }), /free_only must be true or false/);
    const custom = inputOf({ q: 'x', depth: 'standard', steps: { rewrites: 0, pages_read: 1, rerank: false } });
    assert.deepEqual([custom.d.variants, custom.reads, custom.d.rerank], [0, 1, false]);
    assert.equal(require('../server/search/multi').DEPTHS.standard.variants, 2, 'the shared depth is never changed');
    ok('steps, max_time_ms, search_id, model, free_only are checked in words; steps change one search only');

    // ── OpenVibe's own index, free, alongside every auto search ──
    asked.length = 0;
    const fast = await s.search('web', { q: 'lantern makers Lisbon', depth: 'fast', cache: false });
    assert.ok(hosts().includes('search.openvibe.network'), 'the own index was asked');
    const own = fast.receipt.calls.find((c) => c.engine === 'openvibe');
    assert.equal(own.status, 'ok'); assert.equal(own.cost_usd, 0);
    assert.ok(fast.results.some((r) => r.url === 'https://openvibe.tours/lisbon-lantern-makers'), 'its result on the question is kept');
    assert.ok(!fast.results.slice(0, 3).some((r) => r.url === 'https://openvibe.deals/shoes'), 'its result off the question is not up top');
    assert.equal(fast.receipt.calls.filter((c) => c.engine !== 'openvibe').length, 2, 'it took no engine\'s place');
    asked.length = 0;
    await s.search('web', { q: 'lantern makers Lisbon', depth: 'fast', own_index: false, cache: false });
    assert.ok(!hosts().includes('search.openvibe.network'), 'own_index: false leaves it out');
    ownDelay = 4000;
    const t0 = Date.now();
    const slowOwn = await s.search('web', { q: 'lantern makers Lisbon', depth: 'fast', cache: false });
    assert.ok(Date.now() - t0 < 3500, `a slow own index never holds the search back (${Date.now() - t0} ms)`);
    assert.equal(slowOwn.receipt.calls.find((c) => c.engine === 'openvibe').status, 'error');
    ownDelay = 0;
    ok("OpenVibe's own index joins every auto search for free, without taking an engine's place or holding it back");

    // ── free_only ──
    asked.length = 0;
    const free = await s.search('web', { q: 'lantern makers Lisbon', depth: 'fast', free_only: true, cache: false });
    assert.ok(!hosts().some((h) => h === 'api.search.brave.com' || h === 'google.serper.dev'), `no paid engine (${hosts().join(', ')})`);
    assert.equal(free[CHARGE], 0);
    assert.ok(free.results.length >= 1);
    ok('free_only: only engines that cost nothing, charged nothing');

    // ── steps and model ──
    asked.length = 0; llmCalls.length = 0;
    const tuned = await s.search('web', { q: 'lantern makers Lisbon', depth: 'standard', output: 'answer', steps: { rewrites: 0, pages_read: 0 }, model: 'fake/better', cache: false });
    assert.deepEqual(llmCalls.map((c) => c.step), ['search_answer'], 'no rewrites asked');
    assert.equal(llmCalls[0].prefer, 'fake/better', 'the answer prefers the asked model');
    assert.ok(!hosts().includes('r.jina.ai'), 'no page read');
    assert.ok(tuned.answer && /\[1\]/.test(tuned.answer.text));
    ok('steps turn a depth\'s rewrites and reads down; model picks the answer\'s model');

    // ── Stopping: the caller found what it needed ──
    asked.length = 0; llmCalls.length = 0;
    const ac = new AbortController();
    const events = [];
    const stopped = await s.search('web', { q: 'lantern makers Lisbon', depth: 'standard', output: 'answer', cache: false }, {
        signal: ac.signal,
        onEvent: (event, data) => { events.push(event); if (event === 'results' && data.results.some((r) => /1932|workshops/.test(r.snippet || ''))) ac.abort('stopped'); },
    });
    assert.equal(stopped.receipt.stopped, 'stopped');
    assert.ok(stopped.results.length > 0, 'what was found so far comes back');
    assert.ok(!('text' in (stopped.answer || {})), 'no answer was written');
    assert.ok(!llmCalls.some((c) => c.step === 'search_answer'), 'the answer step never started');
    assert.ok(!hosts().includes('r.jina.ai'), 'no page was read');
    const full = await s.search('web', { q: 'lantern makers Lisbon', depth: 'standard', output: 'answer', cache: false });
    assert.ok(stopped[CHARGE] < full[CHARGE], `stopped early, charged less (${stopped[CHARGE]} < ${full[CHARGE]})`);
    ok('a caller that stops the search gets what was found so far, and pays only for what ran');

    // ── max_time_ms: a slow answer is cut, the sources still come back ──
    answerDelay = 5000;
    const t1 = Date.now();
    const timed = await s.search('web', { q: 'lantern makers Lisbon', depth: 'fast', output: 'answer', max_time_ms: 600, cache: false });
    assert.ok(Date.now() - t1 < 2000, `answered by the time limit (${Date.now() - t1} ms)`);
    assert.equal(timed.receipt.stopped, 'time');
    assert.ok(timed.results.length > 0);
    assert.equal(timed.receipt.steps.find((x) => x.step === 'answer').status, 'error', 'the model step was aborted');
    answerDelay = 0;
    ok('max_time_ms: no new work after the limit, the model step aborted, the sources answered');

    // ── The cache: the same search again costs nothing ──
    asked.length = 0;
    const first = await s.search('web', { q: 'lantern makers in Lisbon today', depth: 'fast' });
    const n = asked.length;
    const again = await s.search('web', { q: 'lantern makers in Lisbon today', depth: 'fast' });
    assert.equal(asked.length, n, 'no engine asked again');
    assert.equal(again.receipt.cache, true); assert.equal(again[CHARGE], 0); assert.equal(again.receipt.cost_usd, 0);
    assert.deepEqual(again.results.map((r) => r.url), first.results.map((r) => r.url));
    await s.search('web', { q: 'lantern makers in Lisbon today', depth: 'fast', cache: false });
    assert.ok(asked.length > n, 'cache: false searches again');
    ok('an identical search within minutes is answered from memory, free; cache: false searches again');

    console.log(`search-stop: ${pass} checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
