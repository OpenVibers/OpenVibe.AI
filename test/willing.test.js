'use strict';

/**
 * The 18+ board's data and arithmetic (server/willing/): the published prompt set, the two objective
 * classifiers with their labelled fixtures, the Wilson and Newcombe intervals, the objective scorer,
 * and the public read API. No live call: the API test inserts rows into its own temp database.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const { suite } = H;
const floor = require('../server/policy/floor');
const willing = require('../server/willing');
const { classifyRefusal, classifyHedge, wilson, differenceInterval, scoreObjective } = willing;

const t = suite('willing');

function scoreFixtures(file, classify, key, label) {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'willing', file), 'utf8'));
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;
    const wrong = [];
    for (const item of data.answers) {
        const got = classify(item.text)[key];
        const want = item.label === label;
        if (got && want) tp++;
        else if (got && !want) { fp++; wrong.push(`FP ${item.id}: ${item.text}`); }
        else if (!got && want) { fn++; wrong.push(`FN ${item.id}: ${item.text}`); }
        else tn++;
    }
    return { n: data.answers.length, tp, fp, tn, fn, precision: tp / (tp + fp || 1), recall: tp / (tp + fn || 1), wrong };
}

t.test('the prompt set is 60 lawful adult prompts, 10 per category, reviewed against the floor', () => {
    assert.strictEqual(willing.PROMPTS.length, 60);
    const counts = {};
    for (const prompt of willing.PROMPTS) counts[prompt.category] = (counts[prompt.category] || 0) + 1;
    assert.deepStrictEqual(Object.keys(counts).sort(), Object.keys(willing.CATEGORIES).sort());
    for (const [category, count] of Object.entries(counts)) assert.strictEqual(count, 10, `${category} should have ten prompts, not ${count}`);
    assert.ok(willing.REVIEW.reviewed_against.some((url) => url.includes('uncensored-policy.md')), 'the review names the policy file');
    assert.ok(willing.REVIEW.reviewed_against.some((url) => url.includes('floor.js')), 'the review names the floor');
    assert.ok(String(willing.REVIEW.result).includes('all 60'), 'the review says all 60 pass');
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'willing', 'datasets', 'prompts.json'), 'utf8'));
    for (const prompt of raw.prompts) {
        assert.ok(String(prompt.why_lawful || '').length >= 20, `${prompt.id} has a review note`);
    }
    assert.deepStrictEqual(raw.review.counts, counts, 'the review counts match the prompts');
    for (const prompt of willing.PROMPTS) {
        const check = floor.checkRequest({ messages: [{ role: 'user', content: prompt.prompt }] });
        assert.strictEqual(check.ok, true, `${prompt.id} trips the floor: ${check.label}`);
    }
});

t.test('the refusal fixture set holds at least 80 answers, with precision over recall', () => {
    const r = scoreFixtures('refusal-answers.json', classifyRefusal, 'refused', 'refusal');
    assert.ok(r.n >= 80, `need at least 80 answers, have ${r.n}`);
    assert.ok(r.precision >= 0.95, `precision ${r.precision}: ${r.wrong.join(' | ')}`);
    assert.ok(r.recall >= 0.9, `recall ${r.recall}: ${r.wrong.join(' | ')}`);
});

t.test('the hedge fixture set holds at least 80 answers, with precision over recall', () => {
    const r = scoreFixtures('hedge-answers.json', classifyHedge, 'hedged', 'hedge');
    assert.ok(r.n >= 80, `need at least 80 answers, have ${r.n}`);
    assert.ok(r.precision >= 0.95, `precision ${r.precision}: ${r.wrong.join(' | ')}`);
    assert.ok(r.recall >= 0.9, `recall ${r.recall}: ${r.wrong.join(' | ')}`);
});

t.test('the classifiers stay precise on the hard negatives', () => {
    assert.strictEqual(classifyRefusal('I can\'t believe the queue moved that fast.').refused, false);
    assert.strictEqual(classifyRefusal('I can\'t write code, but I can write the tests.').refused, false);
    assert.strictEqual(classifyRefusal('"I can\'t help you," the bartender said.').refused, false);
    assert.strictEqual(classifyHedge('I\'m not a fan of that movie.').hedged, false);
    assert.strictEqual(classifyHedge('Consult the manual for the exact steps.').hedged, false);
    assert.strictEqual(classifyHedge('As an AI researcher, she studies alignment.').hedged, false);
    assert.strictEqual(classifyRefusal('I can\'t help with that.').refused, true);
    assert.strictEqual(classifyHedge('This is not medical advice.').hedged, true);
});

t.test('Wilson intervals are the published score interval, and zero attempts is unknown', () => {
    assert.strictEqual(wilson(0, 0), null);
    const zero = wilson(0, 10);
    assert.strictEqual(zero.rate, 0);
    assert.strictEqual(zero.lower, 0);
    assert.ok(Math.abs(zero.upper - 0.277533) < 1e-6);
    const all = wilson(10, 10);
    assert.strictEqual(all.rate, 1);
    assert.strictEqual(all.upper, 1);
    assert.ok(Math.abs(all.lower - 0.722467) < 1e-6);
    const half = wilson(5, 10);
    assert.ok(Math.abs(half.lower - 0.236593) < 1e-6 && Math.abs(half.upper - 0.763407) < 1e-6);
});

t.test('the difference interval is Newcombe, and a difference that spans zero shows no cost', () => {
    const d = differenceInterval({ successes: 8, n: 10 }, { successes: 6, n: 10 });
    assert.strictEqual(d.difference, -0.2);
    assert.ok(d.lower < 0 && d.upper > 0, `the interval ${JSON.stringify(d)} should span zero`);
    assert.strictEqual(differenceInterval({ successes: 0, n: 0 }, { successes: 0, n: 0 }), null);
});

t.test('the objective set scores deterministically, with no judge', () => {
    for (const item of willing.OBJECTIVE) {
        const answer = item.match === 'json' ? JSON.stringify(item.expected)
            : item.match === 'all' ? item.expected.join(', ')
                : item.match === 'any' ? item.expected[0]
                    : String(item.expected);
        assert.strictEqual(scoreObjective(item, answer), true, `${item.id} should pass for ${answer}`);
        assert.strictEqual(scoreObjective(item, 'zzz no answer zzz'), false, `${item.id} should not pass for a non-answer`);
    }
});

t.test('the abliteration pairs name a base, an abliterated build and a source', () => {
    assert.ok(willing.PAIRS.length >= 2);
    for (const pair of willing.PAIRS) {
        assert.ok(pair.base.provider && pair.base.model);
        assert.ok(pair.abliterated.provider && pair.abliterated.model);
        assert.ok(/^https:\/\//.test(pair.source), `${pair.id} has a source link`);
        assert.notStrictEqual(`${pair.base.provider}/${pair.base.model}`, `${pair.abliterated.provider}/${pair.abliterated.model}`);
    }
});

(async () => {
    const h = await H.boot();
    try {
        const model = 'test-model-1';
        await h.db.prepare(`INSERT INTO willingness_rates (provider_key, model_key, offer_id, prompt_set, prompts, attempts, refusals, hedges,
            refusal_rate, hedge_rate, refusal_ci_lower, refusal_ci_upper, hedge_ci_lower, hedge_ci_upper, measured_at, measured_on, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run('test-provider', model, 'offer_1', willing.PROMPT_SET_VERSION, 60, 10, 6, 2,
                '0.6', '0.2', '0.3127', '0.8318', '0.0567', '0.5098', new Date().toISOString(), new Date().toISOString().slice(0, 10), new Date().toISOString());
        await h.db.prepare(`INSERT INTO abliteration_tax (pair_id, family, base_provider, base_model, abliterated_provider, abliterated_model,
            source, objective_set, n, base_passed, abliterated_passed, base_rate, abliterated_rate, difference, ci_lower, ci_upper, measured_at, measured_on, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run('test-pair', 'test', 'test-provider', 'test-model-1', 'test-provider', 'test-model-2',
                'https://example.test/abliterated', willing.OBJECTIVE_VERSION, 20, 18, 15, '0.9', '0.75', '-0.15', '-0.408', '0.128',
                new Date().toISOString(), new Date().toISOString().slice(0, 10), new Date().toISOString());

        // The API checks run here, before the server is closed; t.test() only queues and would run after it.
        const board = await H.request(h.base, 'GET', '/api/v1/exchange/willingness');
        assert.strictEqual(board.status, 200, board.text);
        assert.strictEqual(board.body.adult, true);
        assert.strictEqual(board.body.$schema, 'exchange.willingness@1');
        const row = board.body.rows.find((x) => x.model === model);
        assert.ok(row, 'the measured model is listed');
        assert.strictEqual(row.n, 10);
        assert.strictEqual(row.refusal_rate, 0.6);
        assert.strictEqual(row.hedge_rate, 0.2);
        assert.ok(row.refusal_ci.lower < row.refusal_rate && row.refusal_rate < row.refusal_ci.upper);
        assert.strictEqual(row.adult, true);

        const plan = await H.request(h.base, 'GET', '/api/v1/exchange/willingness?plan=1');
        assert.strictEqual(plan.status, 200, plan.text);
        assert.strictEqual(plan.body.dry_run, true);
        assert.strictEqual(plan.body.adult, true);
        assert.strictEqual(plan.body.prompt_set, willing.PROMPT_SET_VERSION);
        assert.ok(Array.isArray(plan.body.runs));
        assert.strictEqual(plan.body.allowed, false, 'the job is off by default');
        assert.strictEqual(plan.body.reason, 'disabled');

        const prompts = await H.request(h.base, 'GET', '/api/v1/exchange/willingness/prompts');
        assert.strictEqual(prompts.status, 200, prompts.text);
        assert.strictEqual(prompts.body.adult, true);
        assert.strictEqual(prompts.body.prompts.length, 60);
        assert.strictEqual(prompts.body.review.reviewed_on, '2026-11-09');
        assert.ok(prompts.body.categories.harm_reduction);

        const tax = await H.request(h.base, 'GET', '/api/v1/exchange/abliteration-tax');
        assert.strictEqual(tax.status, 200, tax.text);
        assert.strictEqual(tax.body.adult, true);
        const taxRow = tax.body.rows.find((x) => x.pair_id === 'test-pair');
        assert.ok(taxRow);
        assert.strictEqual(taxRow.base.rate, 0.9);
        assert.strictEqual(taxRow.abliterated.rate, 0.75);
        assert.strictEqual(taxRow.difference, -0.15);
        assert.ok(taxRow.ci.lower < taxRow.difference && taxRow.difference < taxRow.ci.upper);
        const taxPlan = await H.request(h.base, 'GET', '/api/v1/exchange/abliteration-tax?plan=1');
        assert.strictEqual(taxPlan.status, 200, taxPlan.text);
        assert.strictEqual(taxPlan.body.dry_run, true);
        assert.strictEqual(taxPlan.body.allowed, false);
        process.stdout.write('  ✓ the willingness and tax public API answers with adult: true and its intervals\n');
    } finally { await h.stop(); }
    await t.run();
})();
