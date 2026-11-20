'use strict';
// Auto's receipt (server/receipt-why.js; plan §V.1 routing item 4: "its receipt says what it chose and why"): one
// plain sentence from the run's explain, with the shapes production writes (11-20, network.guest_answer on
// gpt-5-nano: objective cheapest, "no marginal cost (already-paid capacity or a free allowance)").
//   node test/receipt-why.test.js
const assert = require('assert');
const { receiptOf, shortModel } = require('../server/receipt-why');
const run = (explain, prov = {}, extra = {}) => ({ status: 'succeeded', explain, provenance: { model: 'gpt-5-nano-2025-08-07', ...prov }, ...extra });

assert.deepStrictEqual(receiptOf(run({ objective: 'cheapest', reasons: ['no marginal cost (already-paid capacity or a free allowance)', 'objective cheapest'] })),
    { chose: 'gpt-5-nano', why: 'the cheapest model that fits this task; it cost nothing extra' });
assert.deepStrictEqual(receiptOf(run({ objective: 'balanced', reasons: ['objective balanced'] }, { fallback_used: true })),
    { chose: 'gpt-5-nano', why: 'the best balance of quality, speed and price for this task; the first choice did not answer, so the next one did' });
assert.deepStrictEqual(receiptOf(run({ objective: null, reasons: ['pinned route: the primary, then its fallbacks'] })),
    { chose: 'gpt-5-nano', why: 'the model set for this task' });
assert.strictEqual(receiptOf(run({ objective: 'own-machine', reasons: [] }, { model: 'llama-3.3-70b' })).why, 'your own computer answered');
assert.strictEqual(receiptOf(run({ reasons: ['the answer was reused from run run_X; no provider was called'] }, { cached_from: 'run_X' })).why,
    'the same question was answered a moment ago; that answer was reused and no model was called');
assert.strictEqual(receiptOf(run({ objective: 'weird', reasons: [] }, {}, { choice: { model: 'deepseek/deepseek-flash' } })).why, 'the model you chose');
assert.strictEqual(receiptOf(run({ objective: 'weird', reasons: [] })).why, 'the router\'s pick for this task');
assert.strictEqual(receiptOf(run({}, { model: null })), null, 'nothing answered: no receipt');
assert.strictEqual(receiptOf(null), null);
assert.strictEqual(shortModel('deepseek/deepseek-flash'), 'deepseek-flash');
console.log('receipt-why: one plain sentence per run, from the reasons production writes');
