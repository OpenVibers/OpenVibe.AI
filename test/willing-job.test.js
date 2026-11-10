'use strict';

/**
 * The two owner-budget jobs (server/willing/job.js and abliteration.js): the dry run lists the cost
 * from the rate cards, the run is default off and refuses without a budget, and a run stores the
 * refusal/hedge rates or the base/abliterated difference with its interval. No live call: the measure
 * and ask functions are injected.
 */
const assert = require('assert');
const H = require('./helpers');
const { createWillingnessJob } = require('../server/willing/job');
const { createAbliterationTax, scorePair } = require('../server/willing/abliteration');
const { PROMPTS, OBJECTIVE } = require('../server/willing');

const { suite } = H;
const t = suite('willing-jobs');
const ADULT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const PRICE = { in: { unit_price_usd: 1, source: 'https://example.test/prices' }, out: { unit_price_usd: 2, source: 'https://example.test/prices' } };
const pool = { rateCardsFor: async () => PRICE };

function answer(item) {
    if (item.match === 'json') return JSON.stringify(item.expected);
    if (item.match === 'all') return item.expected.join(', ');
    if (item.match === 'any') return item.expected[0];
    return String(item.expected);
}

(async () => {
    const h = await H.boot();
    const service = H.token('test', H.ALL);
        await H.request(h.base, 'POST', '/api/v1/providers', { tok: service, body: {
            key: 'up', kind: 'openai', base_url: 'http://127.0.0.1:9/v1', auth_mode: 'none', default_model: 'base-1',
            capabilities: ['chat'], provider_access: 'UNVERIFIED', billing_profile: 'metered',
        } });
        for (const [model, uncensored] of [['base-1', false], ['abliterated-1', true]]) {
            await H.request(h.base, 'POST', '/api/v1/models', { tok: service, body: {
                provider_key: 'up', model_key: model, type: 'chat', cost: { in_per_mtok: 1, out_per_mtok: 2 },
                ...(uncensored ? { metadata: { uncensored: true } } : {}),
            } });
        }

        t.test('the willingness dry run lists every offer and its estimated cost, and is off by default', async () => {
            const job = createWillingnessJob({ db: h.db, registry: h.registry, pool, config: { willingness: { enabled: true, budgetUsd: 10, adultSubject: ADULT, outputTokens: 64 } }, adultFor: async () => true, measure: async () => { throw new Error('must not run'); } });
            const plan = await job.plan();
            assert.strictEqual(plan.adult, true);
            assert.strictEqual(plan.dry_run, true);
            assert.ok(plan.offers >= 2, `the probe offers and the seeded offer: ${plan.offers}`);
            assert.strictEqual(plan.prompts, 60);
            assert.strictEqual(plan.allowed, true, JSON.stringify({ reason: plan.reason, unpriced: plan.unpriced_offers, total: plan.estimated_cost_usd, budget: plan.budget_usd }));
            assert.ok(plan.estimated_cost_usd > 0);
            assert.strictEqual(plan.runs.filter((r) => r.provider === 'up').length, 2);
            assert.ok(plan.runs.every((r) => r.prompts === 60 && r.price_source === 'https://example.test/prices'));

            const off = createWillingnessJob({ db: h.db, registry: h.registry, pool, config: { willingness: {} }, measure: async () => { throw new Error('must not run'); } });
            const offPlan = await off.plan();
            assert.strictEqual(offPlan.allowed, false);
            assert.strictEqual(offPlan.reason, 'disabled');
            const skipped = await off.runOnce({ force: true });
            assert.strictEqual(skipped.skipped, 'disabled');
        });

        t.test('the willingness run needs a budget and an adult account for an uncensored offer', async () => {
            let called = 0;
            const broke = createWillingnessJob({ db: h.db, registry: h.registry, pool, config: { willingness: { enabled: true, budgetUsd: 0, adultSubject: ADULT } }, adultFor: async () => true, measure: async () => { called++; return { attempts: 1, refusals: 0, hedges: 0 }; } });
            const r = await broke.runOnce({ force: true });
            assert.strictEqual(r.skipped, 'no_owner_budget');
            assert.strictEqual(called, 0);

            const noAdult = createWillingnessJob({ db: h.db, registry: h.registry, pool, config: { willingness: { enabled: true, budgetUsd: 10 } }, measure: async () => { called++; return { attempts: 1, refusals: 0, hedges: 0 }; } });
            const p = await noAdult.plan();
            assert.strictEqual(p.allowed, false);
            assert.strictEqual(p.reason, 'adult_measurement_subject_required');
            assert.strictEqual(called, 0);
        });

        t.test('the willingness run stores n, the refusal rate, the hedge rate and both intervals', async () => {
            const job = createWillingnessJob({ db: h.db, registry: h.registry, pool, config: { willingness: { enabled: true, budgetUsd: 100, adultSubject: ADULT } }, adultFor: async () => true, measure: async ({ probes }) => ({ attempts: probes.length, refusals: 6, hedges: 2 }) });
            const report = await job.runOnce({ force: true });
            assert.ok(report.measured >= 2, JSON.stringify(report));
            const row = await h.db.prepare('SELECT * FROM willingness_rates WHERE provider_key = ? AND model_key = ?').get('up', 'base-1');
            assert.ok(row, 'the row was stored');
            assert.strictEqual(Number(row.attempts), 60);
            assert.strictEqual(Number(row.refusals), 6);
            assert.strictEqual(Number(row.hedges), 2);
            assert.strictEqual(Number(row.refusal_rate), 0.1);
            assert.ok(Number(row.hedge_rate) > 0.03 && Number(row.hedge_rate) < 0.04);
            assert.ok(Number(row.refusal_ci_lower) < 0.1 && Number(row.refusal_ci_upper) > 0.1);
            assert.ok(Number(row.hedge_ci_lower) < Number(row.hedge_rate) && Number(row.hedge_ci_upper) > Number(row.hedge_rate));
        });

        t.test('the tax dry run lists both sides of every pair, and the run stores the difference', async () => {
            const tax = createAbliterationTax({ db: h.db, pool, config: { abliterationTax: { enabled: true, budgetUsd: 100, adultSubject: ADULT, outputTokens: 64 } }, adultFor: async () => true, ask: async ({ side, item }) => (side === 'abliterated' && OBJECTIVE.indexOf(item) < 5 ? 'not the answer' : answer(item)) });
            const plan = await tax.plan();
            assert.strictEqual(plan.adult, true);
            assert.strictEqual(plan.pairs, 3);
            assert.strictEqual(plan.runs.length, 6);
            assert.strictEqual(plan.allowed, true, JSON.stringify({ reason: plan.reason, total: plan.estimated_cost_usd }));
            assert.ok(plan.estimated_cost_usd > 0);

            const report = await tax.runOnce({ force: true });
            assert.strictEqual(report.measured, 3, JSON.stringify(report));
            const row = await h.db.prepare('SELECT * FROM abliteration_tax WHERE pair_id = ?').get('llama-3.1-8b-instruct');
            assert.ok(row);
            assert.strictEqual(Number(row.n), 20);
            assert.strictEqual(Number(row.base_passed), 20);
            assert.strictEqual(Number(row.abliterated_passed), 15);
            assert.strictEqual(Number(row.difference), -0.25);
            assert.ok(Number(row.ci_lower) < -0.25 && Number(row.ci_upper) > -0.25);
        });

        t.test('scorePair compares only the items both sides answered', () => {
            const items = OBJECTIVE.slice(0, 4);
            const base = [answer(items[0]), answer(items[1]), null, answer(items[3])];
            const abl = [answer(items[0]), 'wrong', answer(items[2]), answer(items[3])];
            const s = scorePair(base, abl, items);
            assert.strictEqual(s.n, 3, 'the unanswered item is left out of both sides');
            assert.strictEqual(s.base_passed, 3);
            assert.strictEqual(s.abliterated_passed, 2);
            assert.ok(s.difference < 0);
            assert.ok(s.ci_lower <= s.difference && s.difference <= s.ci_upper);
        });
    await t.run();
})();
