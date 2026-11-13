'use strict';
// Auto's decision step (plan 16d): on openvibe/auto, one calibrated yes/no question decides whether the cheaper model
// answers. The threshold's edges, the skips (private, an exact id, the owner's own order, one candidate, the cheapest
// already first, no key, a failing decision), the cost guard (the decision under 5% of the stronger model's expected
// cost), retries within 10 minutes, a product's outcome (only the person it answered), receipts without the request's
// text, and the weekly fit on a synthetic outcome set.
const assert = require('assert');
const { suite } = require('./helpers');
const { createAutoDecision, fitThreshold, requestText, kindOf, DEFAULT_THRESHOLD } = require('../server/routing/auto-decision');

const t = suite('auto-decision');

const CHEAP = { provider: 'cheapco', model: 'small' };
const STRONG = { provider: 'bigco', model: 'frontier' };
const MID = { provider: 'midco', model: 'medium' };
const PRICES = { cheapco: { priceIn: 0.1, priceOut: 0.4 }, bigco: { priceIn: 5, priceOut: 25 }, midco: { priceIn: 1, priceOut: 4 } };
const describe = async (c) => PRICES[c.provider];
const ROUTE = { key: 'chat.general', constraints: {} };
const REQ = { messages: [{ role: 'user', content: 'What is the capital of France? Answer in one word.' }] };

function decider(p, { calls = [], fail = false, none = false, available = true } = {}) {
    return {
        calls,
        available: async () => available,
        privateOk: async () => available,
        ask: async (q) => {
            calls.push(q);
            if (fail) throw new Error('gemini decisions 503');
            if (none) return null;
            return { answers: { good_enough: { type: 'noul', noul: p, confidence: Math.max(p, 1 - p) } }, calibrated: true, receipt: { provider: 'gemini', model: 'gemini-decision-1', input_tokens: 40, cost_usd: 0.000004 } };
        },
    };
}

let testdb;
let clockMs = Date.parse('2026-11-13T12:00:00.000Z');
const clock = { now: () => clockMs };
const make = (d, extra = {}) => createAutoDecision({ db: testdb.db, decider: d, clock, log: { warn() {} }, random: () => 0.99, ...extra });
const run = (auto, { ctx = {}, req = REQ, route = ROUTE, list = [STRONG, MID, CHEAP], exact = false, explain = { reasons: [] } } = {}) =>
    auto.step({ list, ctx: { aliasPolicy: 'auto', requesterType: 'user', requesterId: 'usr_A', ...ctx }, req, route, operation: 'chat', explain, describe, exact }).then((out) => ({ out, explain }));

t.test('setup: a migrated database', async () => {
    testdb = await require('./db').testDb();
});

t.test('the request text: messages and prompt, never a picture; the kind: Bench category or the route', async () => {
    assert.match(requestText(REQ), /capital of France/);
    assert.strictEqual(requestText({ image: { data: 'x' }, messages: REQ.messages }), null);
    assert.strictEqual(requestText({ messages: [] }), null);
    assert.ok(requestText({ messages: [{ role: 'user', content: 'x'.repeat(50000) }] }).length <= 16000, 'about the first 4k tokens');
    assert.strictEqual(kindOf({ key: 'chat.general', constraints: { bench_category: 'coding' } }, 'chat'), 'coding');
    assert.strictEqual(kindOf({ key: 'chat.general', constraints: { bench_category: 'all' } }, 'chat'), 'chat.general');
    assert.strictEqual(kindOf(null, 'complete'), 'complete');
});

t.test('at or over the threshold the cheaper model goes first; under it the order stays', async () => {
    const at = await run(make(decider(DEFAULT_THRESHOLD)));
    assert.deepStrictEqual(at.out[0], CHEAP, 'p equal to the threshold takes the cheaper model');
    assert.deepStrictEqual(at.out.slice(1), [STRONG, MID], 'the rest keep their order');
    assert.strictEqual(at.explain.route_decision.picked, 'cheap');
    assert.strictEqual(at.explain.route_decision.threshold, 0.7);
    assert.strictEqual(at.explain.route_decision.kind, 'chat.general');
    assert.strictEqual(at.explain.route_decision.decision_cost_usd, 0.000004);
    assert.match(at.explain.reasons[0], /Auto took the cheaper model cheapco\/small/);
    const under = await run(make(decider(0.69)));
    assert.deepStrictEqual(under.out, [STRONG, MID, CHEAP]);
    assert.strictEqual(under.explain.route_decision.picked, 'strong');
    assert.match(under.explain.reasons[0], /Auto kept the stronger model bigco\/frontier/);
    // The receipt row keeps hashes, never the text.
    const row = await testdb.db.prepare('SELECT * FROM route_decisions WHERE id = ?').get(at.explain.route_decision.id);
    assert.strictEqual(row.picked, 'cheap');
    assert.ok(!JSON.stringify(row).includes('France'), 'no request text is stored');
    assert.match(row.prompt_hash, /^[0-9a-f]{32}$/);
});

t.test('a borderline request may explore the cheaper model, and says so', async () => {
    const tried = await run(make(decider(0.65), { random: () => 0.01 }));
    assert.deepStrictEqual(tried.out[0], CHEAP);
    assert.strictEqual(tried.explain.route_decision.explore, true);
    assert.match(tried.explain.reasons[0], /a measured try/);
    const far = await run(make(decider(0.4), { random: () => 0.01 }));
    assert.strictEqual(far.explain.route_decision.picked, 'strong', 'only within 0.1 under the threshold');
});

t.test('skips: private, exact, a pin, the owner order, one candidate, cheapest first, not auto, not text, no key, a failure', async () => {
    const calls = [];
    const auto = make(decider(0.99, { calls }));
    const same = (r) => assert.deepStrictEqual(r.out, [STRONG, MID, CHEAP]);
    same(await run(auto, { route: { key: 'chat.general', constraints: { objective: 'private' } } }));
    same(await run(auto, { exact: true }));
    same(await run(auto, { ctx: { routePin: { provider: 'bigco' } } }));
    same(await run(auto, { ctx: { aliasPolicy: 'balanced' } }));
    same(await run(auto, { ctx: { aliasPolicy: 'private' } }));
    same(await run(auto, { explain: { reasons: [], owner_routing: 'fixed' } }));
    same(await run(auto, { req: { image: { data: 'x' }, messages: REQ.messages } }));
    assert.deepStrictEqual((await run(auto, { list: [STRONG] })).out, [STRONG]);
    assert.deepStrictEqual((await run(auto, { list: [CHEAP, STRONG] })).out, [CHEAP, STRONG]);
    assert.strictEqual(calls.length, 0, 'none of those asked Decisions');
    same(await run(make(decider(0.99, { available: false }))));
    // A decider that cannot say it keeps people's words out of training is never asked.
    const unsure = decider(0.99, { calls: [] });
    delete unsure.privateOk;
    same(await run(make(unsure)));
    assert.strictEqual(unsure.calls.length, 0, 'a key alone is not enough');
    same(await run(make(decider(0.99, { fail: true }))));
    same(await run(make(decider(0.99, { none: true }))));
    const quiet = await run(make(decider(0.99, { fail: true })));
    assert.strictEqual(quiet.explain.route_decision, undefined, 'a failed decision leaves no receipt');
});

t.test('the cost guard: the decision must cost under 5% of the stronger model\'s expected answer', async () => {
    const calls = [];
    const cheapStrong = { cheapco: { priceIn: 0.001, priceOut: 0.002 }, bigco: { priceIn: 0.01, priceOut: 0.02 } };
    const auto = make(decider(0.99, { calls }));
    const out = await auto.step({ list: [STRONG, CHEAP], ctx: { aliasPolicy: 'auto' }, req: REQ, route: ROUTE, operation: 'chat', explain: { reasons: [] }, describe: async (c) => cheapStrong[c.provider] });
    assert.deepStrictEqual(out, [STRONG, CHEAP]);
    assert.strictEqual(calls.length, 0, 'not asked: the question would cost more than 5% of the answer');
});

t.test('the same person asking the same thing within 10 minutes marks the earlier answer retried', async () => {
    const auto = make(decider(0.9));
    const ask = { messages: [{ role: 'user', content: 'Write a haiku about rain.' }] };
    const first = await run(auto, { req: ask, ctx: { requesterId: 'usr_R' } });
    clockMs += 5 * 60 * 1000;
    await run(auto, { req: ask, ctx: { requesterId: 'usr_OTHER' } });
    let row = await testdb.db.prepare('SELECT outcome FROM route_decisions WHERE id = ?').get(first.explain.route_decision.id);
    assert.strictEqual(row.outcome, null, 'someone else asking the same is not a retry');
    await run(auto, { req: ask, ctx: { requesterId: 'usr_R' } });
    row = await testdb.db.prepare('SELECT outcome FROM route_decisions WHERE id = ?').get(first.explain.route_decision.id);
    assert.strictEqual(row.outcome, 'retried');
    const late = await run(auto, { req: { messages: [{ role: 'user', content: 'A limerick about snow.' }] }, ctx: { requesterId: 'usr_R' } });
    clockMs += 11 * 60 * 1000;
    await run(auto, { req: { messages: [{ role: 'user', content: 'A limerick about snow.' }] }, ctx: { requesterId: 'usr_R' } });
    row = await testdb.db.prepare('SELECT outcome FROM route_decisions WHERE id = ?').get(late.explain.route_decision.id);
    assert.strictEqual(row.outcome, null, 'after 10 minutes it is a new question');
});

t.test('a product reports an outcome; only the person it answered may', async () => {
    const auto = make(decider(0.9));
    const r = await run(auto, { ctx: { requesterType: 'service', requesterId: 'codes', onBehalfOf: 'usr_P' } });
    const id = r.explain.route_decision.id;
    assert.strictEqual((await auto.outcome(id, true, { type: 'user', id: 'usr_Q' })).status, 404);
    assert.strictEqual((await auto.outcome('rdc_nope', true, { onBehalfOf: 'usr_P' })).status, 404);
    assert.deepStrictEqual(await auto.outcome(id, false, { onBehalfOf: 'usr_P' }), { status: 200, outcome: 'bad' });
    assert.strictEqual((await testdb.db.prepare('SELECT outcome FROM route_decisions WHERE id = ?').get(id)).outcome, 'bad');
});

t.test('the fit: the lowest threshold within 2 points of the stronger model, or none without evidence', async () => {
    const rows = [];
    for (let i = 0; i < 100; i++) rows.push({ p: 0.3, picked: 'strong', bad: i < 5 });              // strong: 5% bad
    for (let i = 0; i < 40; i++) rows.push({ p: 0.62, picked: 'cheap', bad: i < 8 });               // 20% bad at 0.6–0.65
    for (let i = 0; i < 60; i++) rows.push({ p: 0.82, picked: 'cheap', bad: i < 3 });               // 5% bad at 0.8+
    const fit = fitThreshold(rows, { current: 0.7 });
    assert.strictEqual(fit.threshold, 0.65, 'at 0.65 only the good 0.82 answers count: within 2 points');
    const looser = fitThreshold(rows.map((r) => (r.p === 0.62 ? { ...r, bad: false } : r)), { current: 0.7 });
    assert.strictEqual(looser.threshold, 0.5, 'good borderline answers let it go down');
    assert.strictEqual(fitThreshold(rows.slice(0, 10), { current: 0.7 }), null, 'too few answers: it does not move');
    const awful = rows.map((r) => (r.picked === 'cheap' ? { ...r, bad: true } : r));
    assert.strictEqual(fitThreshold(awful, { current: 0.7 }).threshold, 0.95, 'nothing keeps quality: the strictest');
});

t.test('the weekly fit is due once a week, writes each kind, and the step reads it', async () => {
    const auto = make(decider(0.6));
    await testdb.db.prepare('DELETE FROM route_decisions').run();
    const at = (ms) => new Date(ms).toISOString();
    for (let i = 0; i < 40; i++) {
        await testdb.db.prepare(`INSERT INTO route_decisions (id, kind, p, threshold, picked, cheap_offer, strong_offer, prompt_hash, outcome, created_at)
            VALUES (?, 'chat.general', ?, 0.7, ?, 'cheapco/small', 'bigco/frontier', 'h', NULL, ?)`).run(`rdc_s${i}`, 0.3, 'strong', at(clockMs - 3600e3));
        await testdb.db.prepare(`INSERT INTO route_decisions (id, kind, p, threshold, picked, cheap_offer, strong_offer, prompt_hash, outcome, created_at)
            VALUES (?, 'chat.general', ?, 0.7, ?, 'cheapco/small', 'bigco/frontier', 'h', NULL, ?)`).run(`rdc_c${i}`, 0.56, 'cheap', at(clockMs - 3600e3));
    }
    const fit = await auto.fitIfDue();
    assert.strictEqual(fit.due, true);
    assert.deepStrictEqual(fit.fitted.map((f) => [f.kind, f.threshold]), [['chat.general', 0.5]], 'the lowest threshold with 30 good answers');
    assert.strictEqual(await auto.thresholdOf('chat.general'), 0.5);
    assert.strictEqual((await auto.fitIfDue()).due, false, 'not again within the week');
    const r = await run(auto);
    assert.strictEqual(r.explain.route_decision.threshold, 0.5);
    assert.strictEqual(r.explain.route_decision.picked, 'cheap', 'p 0.6 now passes');
    clockMs += 8 * 24 * 3600e3;
    assert.strictEqual((await auto.fitIfDue()).due, true, 'due again after a week');
});

t.test('teardown', async () => { await testdb.close(); });
t.run();
