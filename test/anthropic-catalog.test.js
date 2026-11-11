'use strict';
const assert = require('node:assert/strict');
const { boot, request, suite } = require('./helpers');
const { byKey } = require('../server/providers/pool-providers');
const { recordOf, modelOf } = require('../server/providers/pool-seed');

const t = suite('anthropic-catalog');
const anthropic = byKey.get('anthropic');
const opus = anthropic.models.find((model) => model.model_key === 'claude-opus-5-5');
let h;

t.test('the Design model has an owner key slot and a sourced rate, but starts off', () => {
    assert.equal(anthropic.default_model, opus.model_key);
    assert.equal(recordOf(anthropic).status, 'disabled');
    assert.equal(recordOf(anthropic).secret_ref, 'vault:anthropic');
    assert.equal(recordOf(anthropic).provider_access, 'UNVERIFIED');
    assert.deepEqual([modelOf(anthropic, opus).cost.in_per_mtok, modelOf(anthropic, opus).cost.out_per_mtok], [4, 20]);
    assert.match(opus.source, /^https:\/\/platform\.claude\.com\/docs\/en\/models\/opus-5-5\//);
});

t.test('the model is seeded for owner configuration but a disabled provider is absent from public offers', async () => {
    h = await boot();
    assert.equal((await h.registry.getProvider('anthropic')).status, 'disabled');
    assert.ok(await h.registry.getModel('anthropic', opus.model_key));
    const r = await request(h.base, 'GET', '/api/v1/exchange/catalog');
    assert.equal(r.status, 200);
    assert.ok(!r.body.models.some((model) => model.canonical === 'anthropic/claude-opus-5-5'));
});

t.test('stop', async () => { if (h) await h.stop(); });
t.run();
