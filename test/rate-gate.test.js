'use strict';
// A provider's published request limits (2026-11-12, Altare Inference's free plan: 60 a minute, 30 a minute for each
// flagship model): the router counts its own requests per minute and skips the provider, or the one model, whose
// minute is used up; the next minute opens again; a provider without limits is never held.
const assert = require('assert');
const { createRateGate } = require('../server/providers/rate-gate');
const { PROVIDERS } = require('../server/providers/pool-providers');
const { suite } = require('./helpers');

const t = suite('rate-gate');

t.test('Altare is catalogued with its published limits and prices', async () => {
    const a = PROVIDERS.find((p) => p.key === 'altare');
    assert.ok(a, 'Altare Inference is a catalogued provider');
    assert.strictEqual(a.base_url, 'https://inference.altare.global/v1');
    assert.deepStrictEqual([a.rate_limits.rpm, a.rate_limits.model_rpm['glm-5.3'], a.rate_limits.model_rpm['deepseek-v4.1-flash']], [60, 30, 30]);
    assert.strictEqual(a.provider_access, 'UNVERIFIED', 'out of paid managed routes until the owner reads its terms');
    const flash = a.models.find((m) => m.model_key === 'deepseek-v4.1-flash');
    assert.deepStrictEqual(flash.cost, { in_per_mtok: 0.3, cached_per_mtok: 0.006, out_per_mtok: 1.2 });
});

t.test('a minute fills, per provider and per flagship model, and the next minute opens', async () => {
    let now = Date.parse('2026-11-12T20:00:05Z');
    const gate = createRateGate({ now: () => now });
    const p = { key: 'altare', metadata: { rate_limits: { rpm: 60, model_rpm: { 'deepseek-v4.1-flash': 30 } } } };
    for (let i = 0; i < 30; i++) { assert.strictEqual(gate.full(p, 'deepseek-v4.1-flash'), false); gate.take(p, 'deepseek-v4.1-flash'); }
    assert.strictEqual(gate.full(p, 'deepseek-v4.1-flash'), true, 'the flagship model\'s 30 are used');
    assert.strictEqual(gate.full(p, 'gemma-4-26b'), false, 'another model still has the provider\'s minute');
    for (let i = 0; i < 30; i++) gate.take(p, 'gemma-4-26b');
    assert.strictEqual(gate.full(p, 'gemma-4-26b'), true, 'the provider\'s 60 are used');
    assert.deepStrictEqual(gate.view(p), { rpm: 60, used: 60, models: { 'deepseek-v4.1-flash': { limit: 30, used: 30 } } });
    now += 60000;
    assert.strictEqual(gate.full(p, 'deepseek-v4.1-flash'), false, 'a new minute');
    assert.strictEqual(gate.full({ key: 'deepseek', metadata: {} }, 'deepseek-chat'), false, 'no limits, never held');
    assert.strictEqual(gate.full({ key: 'altare', metadata: {} }, 'glm-5.3'), false, 'the catalogue\'s limits apply when the row has none');
});

t.run();
