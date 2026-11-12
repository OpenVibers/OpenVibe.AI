'use strict';
/**
 * Monthly credits from a plan (2026-11-12, the owner: "make it aware of granted API credits for both anthropic and
 * openai"): a plan is one promotional grant per billing cycle that expires when the cycle ends, prorated when it starts
 * mid-cycle; it only pays for its own cycle's spend; the router prefers its provider while it lasts; a plan turned off
 * ends this cycle's grant today. Any provider key works (Altare's $100 a month from December 1).
 */
const assert = require('assert');
const { createCreditGrants, cycleOf } = require('../server/providers/credit-grants');
const { testDb } = require('./db');
const { suite } = require('./helpers');

const t = suite('credit-plans');
const DAY = 86400000;

t.test('a cycle renews on its day, and the 31st on a short month\'s last day', async () => {
    const c = cycleOf(5, Date.parse('2026-11-12T10:00:00Z'));
    assert.deepStrictEqual([new Date(c.start).toISOString(), new Date(c.end).toISOString()], ['2026-11-05T00:00:00.000Z', '2026-12-05T00:00:00.000Z']);
    const early = cycleOf(20, Date.parse('2026-11-12T10:00:00Z'));
    assert.deepStrictEqual([new Date(early.start).toISOString(), new Date(early.end).toISOString()], ['2026-10-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z']);
    const short = cycleOf(31, Date.parse('2026-02-15T00:00:00Z'));
    assert.deepStrictEqual([new Date(short.start).toISOString(), new Date(short.end).toISOString()], ['2026-01-31T00:00:00.000Z', '2026-02-28T00:00:00.000Z']);
});

t.test('a plan grants once per cycle, prorated at first, spends only its own cycle, and is preferred while it lasts', async () => {
    const tdb = await testDb();
    try {
        const db = tdb.db;
        let now = Date.parse('2026-11-20T00:00:00Z');
        const credits = createCreditGrants({ db, env: {}, clock: { now: () => now } });
        // ChatGPT Pro's $200 a month, renewing on the 5th, started on the 20th: the first grant is the 15 days left of 30.
        await credits.addPlan({ provider_key: 'openai', label: 'ChatGPT Pro API credits', monthly_usd: 200, renews_day: 5, starts_on: '2026-11-20' });
        let grants = await credits.list('openai');
        assert.strictEqual(grants.length, 1);
        assert.strictEqual(Number(grants[0].amount_usd), 100, 'prorated: 15 of 30 days');
        assert.strictEqual(grants[0].expires_at, '2026-12-05T00:00:00.000Z', 'unused credit expires when the cycle ends');
        await credits.materialize();
        assert.strictEqual((await credits.list('openai')).length, 1, 'once per cycle');

        // Spend before the plan began is not its business; spend inside its cycle is.
        const spend = (at, usd) => db.prepare("INSERT INTO requests (operation, provider_key, status, cost_usd, created_at) VALUES ('chat', 'openai', 'ok', ?, ?)").run(usd, new Date(at).toISOString());
        await spend(Date.parse('2026-11-10T00:00:00Z'), 40);
        await spend(Date.parse('2026-11-21T00:00:00Z'), 30);
        now = Date.parse('2026-11-22T00:00:00Z');
        let out = (await credits.poll()).find((x) => x.provider === 'openai');
        assert.strictEqual(out.plans.length, 1);
        assert.strictEqual(out.plans[0].remaining_usd, 70, 'its own cycle\'s 30 only, not the 40 from before');
        assert.strictEqual(out.promotional, 70);
        assert.strictEqual(credits.shouldPrefer('openai'), true, 'the router spends granted credit first');

        // The next cycle: a full $200, the old grant expired and gone from the balance.
        now = Date.parse('2026-12-06T00:00:00Z');
        out = (await credits.poll()).find((x) => x.provider === 'openai');
        grants = await credits.list('openai');
        assert.strictEqual(grants.length, 2);
        assert.strictEqual(out.plans.length, 1);
        assert.strictEqual(out.plans[0].amount_usd, 200);
        assert.strictEqual(out.promotional, 200, 'last cycle\'s leftover does not carry over');

        // Off: this cycle's grant ends today and no new one comes.
        const plan = (await credits.listPlans('openai'))[0];
        await credits.setPlanActive(plan.id, false);
        now += DAY;
        out = (await credits.poll()).find((x) => x.provider === 'openai');
        assert.strictEqual(out.promotional, 0);
        assert.strictEqual(credits.shouldPrefer('openai'), false);

        // Any provider: Altare's $100 a month from December 1, on the 1st.
        await credits.addPlan({ provider_key: 'altare', label: 'Altare Always Free', monthly_usd: 100, renews_day: 1, starts_on: '2026-12-01' });
        out = (await credits.poll()).find((x) => x.provider === 'altare');
        assert.ok(out && out.plans[0].amount_usd === 100, JSON.stringify(out && out.plans));
        await assert.rejects(credits.addPlan({ provider_key: 'openai', label: '', monthly_usd: 10, renews_day: 1, starts_on: '2026-12-01' }), /label/);
        await assert.rejects(credits.addPlan({ provider_key: 'openai', label: 'x', monthly_usd: 10, renews_day: 40, starts_on: '2026-12-01' }), /renews_day/);
    } finally { await tdb.close(); }
});

t.run();
