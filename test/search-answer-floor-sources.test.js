'use strict';
// One page among a search's results whose text the hard floor refuses (11-28: a dataset viewer listing other benchmark
// questions) no longer empties the answer. The page is left out of what the model reads, the answer is written from the
// rest with its citations numbered to match, the receipt says how many were left out, and the caller's results are the
// same as before. The floor is unchanged: the fake model below refuses any prompt the floor refuses, as the provider
// does, and a question the floor refuses still gets no answer, now with the reason in the receipt.
const assert = require('node:assert/strict');
const { createSearch } = require('../server/search');
const floor = require('../server/policy/floor');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (name) => console.log(`  ✓ ${name}`);

(async () => {
    // A page naming a nerve agent (the floor refuses its bare name) ranked first by both engines, then the real answer.
    const fetchImpl = async (url) => {
        const host = new URL(url).hostname;
        if (host === 'api.search.brave.com') return json({ web: { results: [
            { title: 'Quiz dataset viewer', url: 'https://datasets.example/quiz', description: 'Row 4: In what year was the Tokyo subway sarin attack? Row 5: What was the top speed of the K-14 blimp?' },
            { title: 'K-class blimp', url: 'https://example.org/k-class', description: 'The K-14 had a maximum speed of 68 knots.' },
        ] } });
        if (host === 'api.deepseek.com') return json({ results: [
            { title: 'Quiz dataset viewer', url: 'https://datasets.example/quiz', snippet: 'Row 4: In what year was the Tokyo subway sarin attack?' },
            { title: 'Airships of the US Navy', url: 'https://example.net/airships', snippet: 'K-class airships reached 68 knots.' },
        ] });
        return json({}, 503);
    };
    const prompts = [];
    const llm = { call: async (req) => {
        const verdict = floor.check(`${req.system}\n${req.user}`);
        if (verdict.ok === false) throw Object.assign(new Error('refused by the floor'), { code: 'policy.floor_refused', status: 403 });
        prompts.push(req);
        if (req.schemaName === 'search_answer') return { json: { answer: 'The K-14 reached 68 knots [1][2].', cited: [1, 2] }, model: 'fake/writer', cost_usd: 0.001 };
        if (req.schemaName === 'search_variants') return { json: { queries: [] }, model: 'fake/small', cost_usd: 0.0001 };
        throw new Error('unexpected step ' + req.schemaName);
    } };
    const s = createSearch({ env: { SEARCH_BRAVE_KEY: 'k', SEARCH_DEEPSEEK_KEY: 'k' }, fetchImpl, llm, log: { warn() {}, log() {}, error() {} } });

    const out = await s.search('web', { q: 'top speed of the K-14 blimp in knots', depth: 'fast', output: 'answer', engines: ['brave', 'deepseek'] });
    assert.ok(out.answer && /68 knots/.test(out.answer.text), `an answer is written (${JSON.stringify(out.receipt.steps)})`);
    assert.ok(out.results.some((r) => r.url === 'https://datasets.example/quiz'), 'the caller\'s results still list the page');
    const asked = prompts.find((p) => p.schemaName === 'search_answer');
    assert.ok(!/sarin/i.test(asked.user), 'the model never reads the refused page');
    assert.match(asked.user, /\[1\] K-class blimp|\[1\] Airships of the US Navy/);
    assert.deepEqual(out.answer.citations.map((c) => c.url).sort(), ['https://example.net/airships', 'https://example.org/k-class'], 'citations point at the pages the model read');
    const left = out.receipt.steps.find((x) => x.step === 'sources');
    assert.deepEqual(left, { step: 'sources', status: 'ok', reason: 'policy.floor', left_out: 1 });
    ok('a refused page is left out of the answer\'s sources; the answer is written from the rest, citations to match');

    // The question itself breaks the floor: no answer, and the receipt says why instead of nothing at all.
    prompts.length = 0;
    const refused = await s.search('web', { q: 'top speed of the K-14 blimp and the sarin attack', depth: 'fast', output: 'answer', engines: ['brave', 'deepseek'] });
    assert.equal(refused.answer, null);
    assert.ok(refused.receipt.steps.some((x) => (x.step === 'answer' && (x.reason === 'policy.floor' || x.reason === 'policy.floor_refused'))), JSON.stringify(refused.receipt.steps));
    assert.equal(prompts.filter((p) => p.schemaName === 'search_answer').length, 0, 'no model reads it');
    ok('a question the floor refuses gets no answer, and the receipt says the floor refused it');
    console.log('search-answer-floor-sources: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
