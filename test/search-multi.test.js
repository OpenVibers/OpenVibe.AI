'use strict';
// Exchange search v2 (plan §W.7; the owner, 11-20: compete with Linkup: depth you can set, several searches at once,
// deduplicated, sourced answers, powerful and still one minimal call). The merging rules alone, then the whole
// pipeline over three fake engines, a fake page reader and a fake model: what is called, merged, read, answered and
// charged, and that the v1 call is unchanged.
const assert = require('node:assert/strict');
const { createSearch, CHARGE } = require('../server/search');
const { canonicalUrl, siteOf, fuse, excerpt } = require('../server/search/fusion');
const { isMulti, inputOf, createMulti } = require('../server/search/multi');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

(async () => {
    let pass = 0;
    const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };

    // ── The merging rules ──
    assert.equal(canonicalUrl('https://www.Example.com/a/b/?utm_source=x&b=2&a=1&fbclid=z#top'), 'example.com/a/b?a=1&b=2');
    assert.equal(canonicalUrl('http://m.example.com/news/story/amp'), canonicalUrl('https://example.com/news/story'));
    assert.equal(canonicalUrl('https://amp.example.com/'), 'example.com');
    assert.equal(canonicalUrl('ftp://example.com/x'), null);
    assert.equal(siteOf('https://news.bbc.co.uk/x'), 'bbc.co.uk');
    assert.equal(siteOf('https://docs.github.com/x'), 'github.com');
    ok('one key per page: no tracking, no www/m/amp, sorted parameters, no fragment or trailing slash; sites by registrable domain');

    // 11-20 on production: an engine's internal redirect ("http://go/v1/…") and a CDN mirror of the museum's own site.
    for (const bad of ['http://go/v1/AQS8suVF', 'https://localhost/x', 'https://127.0.0.1/x', 'https://user:pw@example.com/']) assert.equal(canonicalUrl(bad), null, bad);
    const mirrored = fuse([{ engine: 'a', query: 'q', results: [
        { title: 'Hours and admission', url: 'https://www.louvre.fr/en/visit/hours-admission', snippet: 'Open 9:00 to 18:00' },
        { title: 'Visit the Louvre', url: 'https://www.louvre.fr.a.global.clara.net/en/visit', snippet: 'Plan your visit' },
        { title: 'Go', url: 'http://go/v1/AQS8suVF', snippet: 'redirect' },
        { title: 'Louvre tickets', url: 'https://paristickets.com/louvre', snippet: 'Tickets' },
    ] }]);
    assert.deepEqual(mirrored.results.map((r) => r.url), ['https://www.louvre.fr/en/visit/hours-admission', 'https://paristickets.com/louvre']);
    assert.deepEqual(mirrored.results[0].also, ['https://www.louvre.fr.a.global.clara.net/en/visit']);
    ok('no page without a public host; a mirror host (site.cdn.example) folds into the site it copies');

    const A = { engine: 'a', query: 'q', results: [
        { title: 'Lantern makers in Lisbon', url: 'https://example.org/lisbon?utm_source=a', snippet: 'Five lantern makers in Lisbon open their workshops to visitors this winter' },
        { title: 'Only on A', url: 'https://only-a.com/', snippet: 'x' },
        { title: 'Same site 1', url: 'https://big.com/1', snippet: 's1' },
        { title: 'Same site 2', url: 'https://big.com/2', snippet: 's2' },
        { title: 'Same site 3', url: 'https://big.com/3', snippet: 's3' },
    ] };
    const B = { engine: 'b', query: 'q', results: [
        { title: 'Lantern makers in Lisbon', url: 'https://www.example.org/lisbon/', snippet: 'Five lantern makers in Lisbon open their workshops to visitors this winter, with prices' },
        { title: 'Lantern makers in Lisbon open their workshops', url: 'https://syndicated.net/lisbon-lanterns', snippet: 'Five lantern makers in Lisbon open their workshops to visitors this winter' },
    ] };
    const f = fuse([A, B], { limit: 10 });
    assert.equal(f.results[0].url, 'https://example.org/lisbon?utm_source=a', 'the page both engines found leads');
    assert.deepEqual(f.results[0].engines, ['a', 'b']);
    assert.match(f.results[0].snippet, /with prices/, 'the longer snippet is kept');
    assert.ok(!f.results.some((r) => r.url.includes('syndicated.net')), 'the syndicated copy is folded into the original');
    assert.deepEqual(f.results[0].also, ['https://syndicated.net/lisbon-lanterns']);
    assert.equal(f.duplicates, 2, 'the same page twice, and its copy');
    const bigs = f.results.map((r) => r.url).filter((u) => u.includes('big.com'));
    assert.equal(f.results.findIndex((r) => r.url === 'https://big.com/3'), f.results.length - 1, 'a third result of one site waits behind the others');
    assert.equal(bigs.length, 3);
    ok('Reciprocal Rank Fusion: agreement leads, the same page merges, a syndicated copy folds in, one site at most twice up top');

    const page = 'Lisbon\n\nThe city has many shops.\n\nFive lantern makers in Lisbon open their workshops to visitors this winter; the oldest has made lanterns since 1932 in Alfama.\n\nContact us.';
    assert.match(excerpt(page, 'lantern makers Lisbon'), /since 1932/);
    assert.equal(excerpt(page, 'quantum chromodynamics'), '');
    // 11-20 on production: a page's navigation came back as the passage, with &amp; in it.
    const chrome = 'Player Turismo de Lisboa Logo Search Profile EN PT ES FR DE IT Visit Lisboa Convention Bureau About Us Traveller Information Photo Gallery Turismo de Lisboa Logo Culture &amp; Outdoors See &amp; Do Stay &amp; Plan Museums &amp; Monuments National Tile Museum\n\nThe National Tile Museum is set in the Madre de Deus Convent, founded in 1509. It is closed for renovation works until further notice.\n\nContact';
    const passage = excerpt(chrome, 'National Tile Museum opening hours');
    assert.match(passage, /^The National Tile Museum is set in the Madre de Deus Convent/, `sentences, not the menu (${passage})`);
    assert.ok(!/&amp;|Logo Search/.test(passage));
    const { onTopic } = require('../server/search/fusion');
    assert.equal(onTopic({ title: 'Embroidered Tile Amelia Dress', snippet: '$139.23 at zappos.com', url: 'https://openvibe.deals/x' }, 'Lisbon tile museum opening hours'), false, 'one shared word is not the question');
    assert.equal(onTopic({ title: 'National Tile Museum | Visit Lisboa', snippet: 'The museum is set in Madre de Deus', url: 'https://visitlisboa.com/x' }, 'Lisbon tile museum opening hours'), true);
    assert.equal(onTopic({ title: 'Anything', snippet: '', url: 'https://x.com' }, 'tiles'), true, 'a one-word question is not judged');
    ok('a read page gives back the sentences that answer the query, never its menus; a result sharing one word is off the question');

    // ── The request ──
    assert.equal(isMulti({ q: 'x' }), false, 'the v1 call is untouched');
    assert.equal(isMulti({ q: 'x', depth: 'fast' }), true);
    assert.throws(() => inputOf({ q: 'x', depth: 'bottomless' }), /depth must be one of instant, fast, standard, deep/);
    assert.throws(() => inputOf({ q: 'x', output: 'structured' }), /needs a JSON schema/);
    assert.throws(() => inputOf({ q: 'x', include_domains: ['not a site'] }), /is not a web site/);
    assert.throws(() => inputOf({ queries: ['a', 'b', 'c', 'd', 'e', 'f'] }), /at most 5 queries/);
    assert.deepEqual(inputOf({ queries: ['a', 'b'], include_domains: ['https://www.Example.com/path'] }).include, ['example.com']);
    ok('the v2 fields are checked in words; q may be left out when queries are given');

    // OpenVibe's own index joins auto only for a question about OpenVibe (11-20: it took a place in a Louvre search).
    const { chooseEngines } = createMulti({ prepare: async () => ({}), execute: async () => ({}), CHARGE: Symbol('c'), usdOf: () => 0n });
    const cand = (id, cls) => ({ a: { id, class: cls }, ceilingNano: 1n });
    const pool = [cand('openvibe', 'first_party_index'), cand('searxng', 'metasearch'), cand('deepseek', 'answer_engine')];
    assert.deepEqual(chooseEngines(pool, ['auto'], 3, ['louvre museum opening hours']).map((c) => c.a.id), ['searxng', 'deepseek']);
    assert.deepEqual(chooseEngines(pool, ['auto'], 3, ['how do OpenVibe agents learn a task']).map((c) => c.a.id), ['searxng', 'deepseek', 'openvibe']);
    assert.deepEqual(chooseEngines(pool, ['auto'], 3, ['pricing on openvibe.exchange']).map((c) => c.a.id), ['searxng', 'deepseek', 'openvibe']);
    assert.deepEqual(chooseEngines(pool, ['openvibe'], 1, ['louvre']).map((c) => c.a.id), ['openvibe'], 'named, it is always asked');
    ok("auto asks OpenVibe's own index only for a question about OpenVibe; named, always");

    // ── The pipeline, over three fake engines ──
    const asked = [];
    const results = {
        brave: (q) => ({ web: { results: [
            { title: 'Lantern makers in Lisbon', url: 'https://example.org/lisbon', description: 'Five lantern makers in Lisbon open their workshops to visitors this winter', page_age: '2026-11-08T12:00:00Z' },
            { title: `Brave only for ${q}`, url: `https://brave-only.com/${encodeURIComponent(q)}`, description: 'b' },
            { title: 'Old story', url: 'https://old.com/1', description: 'old', page_age: '2019-01-01T00:00:00Z' },
        ] } }),
        serper: (q) => ({ organic: [
            { title: 'Lantern makers in Lisbon', link: 'https://www.example.org/lisbon/?utm_campaign=z', snippet: 'Five lantern makers in Lisbon open their workshops to visitors this winter' },
            { title: `Serper only for ${q}`, link: `https://serper-only.com/${encodeURIComponent(q)}`, snippet: 's' },
            { title: 'Spam', link: 'https://spam.example/1', snippet: 'spam' },
        ] }),
        deepseek: (q) => ({ results: [
            { title: 'Lantern makers in Lisbon', url: 'https://example.org/lisbon#top', snippet: 'Five lantern makers in Lisbon open their workshops to visitors this winter', date: '2026-11-08T12:00:00Z' },
            { title: `DeepSeek only for ${q}`, url: `https://deepseek-only.com/${encodeURIComponent(q)}`, snippet: 'd' },
        ] }),
    };
    const qOf = (url, init) => {
        const u = new URL(url);
        if (u.searchParams.get('q')) return u.searchParams.get('q');
        try { const b = JSON.parse(init.body); return b.q || b.query || b.keywords || ''; } catch { return ''; }
    };
    const fetchImpl = async (url, init = {}) => {
        const host = new URL(url).hostname;
        const q = qOf(url, init);
        if (host === 'api.search.brave.com') { asked.push(['brave', q]); return json(results.brave(q)); }
        if (host === 'google.serper.dev') { asked.push(['serper', q]); return json(results.serper(q)); }
        if (host === 'api.deepseek.com') { asked.push(['deepseek', q]); return json(results.deepseek(q)); }
        if (host === 'r.jina.ai') { asked.push(['jina', url]); return json({ code: 200, data: { title: 'Lantern', url: 'https://example.org/lisbon', content: 'Lisbon\n\nFive lantern makers in Lisbon open their workshops to visitors this winter; the oldest has worked since 1932.\n\nContact.', usage: { tokens: 2000 } } }); }
        return json({}, 503);
    };
    const llmCalls = [];
    const llm = { call: async (req) => {
        llmCalls.push(req.schemaName);
        if (req.schemaName === 'search_variants') return { json: { queries: ['Lisbon lantern workshops', 'lanternas Lisboa artesãos'] }, model: 'fake/small', cost_usd: 0.0004 };
        if (req.schemaName === 'search_follow_ups') return { json: { queries: ['oldest lantern maker Alfama'] }, model: 'fake/small', cost_usd: 0.0005 };
        if (req.schemaName === 'search_answer') {
            assert.match(req.user, /\[1\] Lantern makers in Lisbon/);
            assert.match(req.user, /since 1932/, 'the answer reads the passage the page gave');
            return { json: { answer: 'Five lantern makers in Lisbon open their workshops this winter [1]; the oldest has worked since 1932 [1].', cited: [1] }, model: 'fake/writer', cost_usd: 0.002 };
        }
        if (req.schemaName === 'search_structured') return { json: { makers: 5, since: 1932 }, model: 'fake/writer', cost_usd: 0.002 };
        throw new Error('unexpected step ' + req.schemaName);
    } };
    const env = { SEARCH_BRAVE_KEY: 'k', SEARCH_DEEPSEEK_KEY: 'k', SEARCH_SERPER_KEY: 'k', SEARCH_JINA_KEY: 'k' };
    const s = createSearch({ env, fetchImpl, llm, log: { warn() {}, log() {}, error() {} } });

    const v1 = await s.search('web', { q: 'lanterns' });
    assert.equal(v1.receipt.engine === 'multi', false, 'a plain q is still one engine, as before');
    assert.ok(!('answer' in v1));
    ok('POST /v1/search { q } is exactly v1: one engine, its receipt');

    asked.length = 0;
    const fast = await s.search('web', { q: 'lantern makers Lisbon', depth: 'fast' });
    assert.equal(fast.receipt.engine, 'multi');
    assert.equal(fast.receipt.engines.length, 2, 'fast: two engines side by side');
    assert.equal(asked.length, 2);
    assert.equal(fast.results.filter((r) => r.url.includes('example.org')).length, 1, 'the page both found is one result');
    assert.equal(fast.results[0].engines.length, 2);
    assert.ok(fast.receipt.duplicates_removed >= 1);
    assert.equal(fast[CHARGE], fast.receipt.cost_usd);
    assert.ok(fast[CHARGE] > 0, 'the charge is what the two calls cost');
    assert.equal(llmCalls.length, 0, 'fast asks no model');
    ok('depth fast: two engines of different kinds at once, merged and deduplicated, charged what they cost');

    asked.length = 0; llmCalls.length = 0;
    const std = await s.search('web', { q: 'lantern makers Lisbon', depth: 'standard', output: 'answer' });
    assert.equal(std.receipt.engines.length, 3, 'standard: three engines');
    assert.deepEqual(std.queries.variants, ['Lisbon lantern workshops', 'lanternas Lisboa artesãos']);
    assert.equal(asked.filter(([e]) => e !== 'jina').length, 3 + 2 * 2, 'the question on three engines, two rewrites on the two cheapest');
    assert.ok(std.results.some((r) => r.excerpt && /1932/.test(r.excerpt)), 'the top pages were read for their answering passage');
    assert.match(std.answer.text, /\[1\]/);
    assert.deepEqual(std.answer.citations.map((c) => c.url), [std.results[0].url]);
    assert.deepEqual(llmCalls, ['search_variants', 'search_answer']);
    assert.ok(std.receipt.steps.every((x) => x.status === 'ok'));
    assert.ok(std.receipt.reads.length >= 1);
    ok('depth standard: three engines, two rewrites, the top pages read, a sourced answer with numbered citations');

    // stream: sources first. Round one's merged list goes out before the rewrites are searched, the read passages
    // after, then the answer; the returned answer is the same as without stream.
    asked.length = 0; llmCalls.length = 0;
    const events = [];
    const fresh = createSearch({ env, fetchImpl, llm, log: { warn() {}, log() {}, error() {} } });
    const streamed = await fresh.search('web', { q: 'lantern makers Lisbon', depth: 'standard', output: 'answer', stream: true }, { onEvent: (event, data) => events.push([event, data, asked.length]) });
    assert.deepEqual(events.map(([e, d]) => d.stage ? `${e}:${d.stage}` : e), ['results:first', 'results:merged', 'results:read', 'answer']);
    assert.equal(events[0][2], 3, 'the first list goes out when the three engines answered, before any rewrite is searched');
    assert.ok(events[0][1].results.length >= 1 && events[0][1].results.every((r) => r.url && r.engine), 'each result names an engine');
    assert.ok(events[2][1].results.some((r) => r.excerpt && /1932/.test(r.excerpt)), 'the read stage carries the passages');
    assert.equal(events[3][1].answer.text, streamed.answer.text);
    assert.equal(streamed.answer.text, std.answer.text);
    assert.throws(() => inputOf({ q: 'x', stream: 'yes' }), /stream must be true or false/);
    assert.equal(isMulti({ q: 'x', stream: true }), true, 'stream alone is a v2 search');
    ok('stream: the first merged list before the rewrites, then the merged list, the passages and the answer');

    // Rerank (standard, deep): the merged top results by meaning. Here the embeddings say a lower-placed result is the
    // one closest to the question, so it rises; the step is on the receipt with its cost; fast is never reranked.
    const embedded = [];
    const ranking = { ...llm, embed: async (texts) => { embedded.push(texts); return { vectors: texts.map((t, i) => (i === 0 || /Brave only/.test(t) ? [1, 0] : [0, 1])), cost_usd: 0.00002, model: 'fake/embed' }; } };
    const ranked = await createSearch({ env, fetchImpl, llm: ranking, log: { warn() {}, log() {}, error() {} } }).search('web', { q: 'lantern makers Lisbon', depth: 'standard', excerpts: false });
    assert.match(ranked.results[0].title, /^Brave only/, `the closest in meaning rises (${ranked.results.map((r) => r.title).join(' | ')})`);
    assert.equal(ranked.results[0].relevance, 1);
    assert.equal(embedded[0][0], 'lantern makers Lisbon', 'the question is embedded first');
    assert.ok(embedded[0].length <= 31, 'at most the top 30 results');
    const rr = ranked.receipt.steps.find((x) => x.step === 'rerank');
    assert.deepEqual([rr.status, rr.model, rr.cost_usd], ['ok', 'fake/embed', 0.00002]);
    embedded.length = 0;
    await createSearch({ env, fetchImpl, llm: ranking, log: { warn() {}, log() {}, error() {} } }).search('web', { q: 'lantern makers Lisbon', depth: 'fast' });
    assert.equal(embedded.length, 0, 'fast is not reranked');
    const broken = { ...llm, embed: async () => { throw Object.assign(new Error('down'), { code: 'provider.down' }); } };
    const kept = await createSearch({ env, fetchImpl, llm: broken, log: { warn() {}, log() {}, error() {} } }).search('web', { q: 'lantern makers Lisbon', depth: 'standard', excerpts: false });
    assert.ok(kept.results.length > 0 && kept.receipt.steps.find((x) => x.step === 'rerank').status === 'error', 'a failed ranking keeps the merged order');
    ok('rerank: standard and deep order the top results by meaning; the step is on the receipt; a failure keeps the merged order');

    asked.length = 0; llmCalls.length = 0;
    const deep = await s.search('web', { q: 'lantern makers Lisbon', depth: 'deep', output: 'structured', schema: { type: 'object', properties: { makers: { type: 'integer' }, since: { type: 'integer' } } } });
    assert.deepEqual(deep.queries.follow_ups, ['oldest lantern maker Alfama'], 'deep: a second round for what was missing');
    assert.ok(asked.some(([, q]) => q === 'oldest lantern maker Alfama'));
    assert.deepEqual(deep.structured, { makers: 5, since: 1932 });
    ok('depth deep: a second round planned from the first, and the output shaped by the caller\'s schema');

    asked.length = 0;
    const multi = await s.search('web', { queries: ['lantern makers Lisbon', 'azulejo workshops Porto'], depth: 'instant', exclude_domains: ['spam.example'], from: '2026-01-01' });
    assert.deepEqual(multi.queries.asked, ['lantern makers Lisbon', 'azulejo workshops Porto']);
    assert.equal(asked.length, 2, 'two queries, one engine each at instant');
    assert.ok(!multi.results.some((r) => r.url.includes('spam.example')), 'an excluded site never comes back');
    const oldAt = multi.results.findIndex((r) => r.url.includes('old.com'));
    assert.ok(oldAt === -1, 'a result dated before from is left out');
    const sites = await s.search('web', { q: 'lantern makers', depth: 'fast', include_domains: ['example.org'] });
    assert.ok(sites.results.length >= 1 && sites.results.every((r) => /example\.org/.test(r.url)), 'include_domains keeps those sites only');
    assert.deepEqual(sites.queries.sites, ['lantern makers site:example.org'], 'and searches aimed at them');
    ok('several queries in one call, sites in or out, nothing older than from');

    // Money: the plan holds the sum of what every step may cost, max_cost_usd caps it, and a call it cannot cover is
    // skipped with the reason, never made.
    const plan = await s.prepare('web', { q: 'lantern makers Lisbon', depth: 'standard', output: 'answer' });
    assert.equal(plan.multi, true);
    assert.ok(plan.ceiling > std.receipt.cost_usd, 'the hold covers the whole search');
    const capped = await s.search('web', { q: 'lantern makers Lisbon', depth: 'standard', max_cost_usd: 0.004 });
    assert.ok(capped.receipt.cost_usd <= 0.004 + 1e-9, `never past the cap (${capped.receipt.cost_usd})`);
    assert.ok(capped.receipt.calls.some((c) => c.status === 'skipped' && c.reason === 'budget') || capped.receipt.steps?.some((x) => x.reason === 'budget'), 'what the cap cannot cover is skipped, and the receipt says so');
    ok('the hold is the sum of every step; max_cost_usd caps it, and nothing past it is called');

    // A model that names its sources but leaves the marks out of the text (production, 11-20): the marks are added.
    const bare = createSearch({ env, fetchImpl, log: { warn() {}, log() {}, error() {} }, llm: { call: async (req) => (req.schemaName === 'search_variants' ? { json: { queries: [] }, cost_usd: 0 } : { json: { answer: 'Five makers open this winter.', cited: [1] }, model: 'fake', cost_usd: 0.001 }) } });
    const marked = await bare.search('web', { q: 'lantern makers Lisbon', depth: 'standard', output: 'answer', excerpts: false });
    assert.equal(marked.answer.text, 'Five makers open this winter. [1]');
    assert.equal(marked.answer.citations[0].n, 1);
    ok('an answer always carries its marks: added after it when the model listed sources without them');

    const down = createSearch({ env, llm, fetchImpl: async () => json({}, 503), log: { warn() {}, log() {}, error() {} } });
    await assert.rejects(down.search('web', { q: 'x', depth: 'fast' }), (err) => err.status === 503 && /No engine answered/.test(err.message));
    const noModel = createSearch({ env, fetchImpl });
    await assert.rejects(noModel.search('web', { q: 'x', output: 'answer' }), /answers need a model/);
    ok('no engine answering is a 503 with every call in it; an answer with no model here says so');

    console.log(`search-multi: ${pass} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
