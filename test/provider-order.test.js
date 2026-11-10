'use strict';
const assert = require('node:assert/strict');
const { boot, request, token, suite } = require('./helpers');
const { createProviderOrder } = require('../server/providers/order');
const t = suite('provider-order');
const owner = token('exchange', ['ai.provider.manage', 'ai.usage.read']);
const denied = token('chat', ['ai.run.read']);
let h, orders;
const choices = ['order-second', 'order-first'].map(provider => ({ provider, model: 'm' }));
const route = { key: 'order-test', primary: { provider: 'order-first', model: 'm' }, fallbacks: [] };
const run = () => h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'hello' }], maxTokens: 20 });
t.test('orders start off and use the existing versioned route store', async () => {
    h = await boot(); orders = createProviderOrder({ registry: h.registry });
    assert.ok((await orders.list()).every(r => !r.enabled));
    for (const choice of choices) {
        await h.registry.upsertProvider({ key: choice.provider, kind: 'stub', status: 'active', auth_mode: 'none', capabilities: ['chat'], default_model: 'm' });
        await h.registry.upsertModel({ provider_key: choice.provider, model_key: 'm', status: 'active' });
    }
    assert.equal((await run()).provider, 'order-first');
    const saved = await orders.save('chat', { enabled: true, choices });
    assert.equal(saved.version, 1);
    assert.deepEqual((await h.registry.getRoute('provider-order.chat')).pinned, choices);
    assert.equal((await run()).provider, 'order-second');
});
t.test('provider off takes effect on the next run and retains the fallback reason', async () => {
    await h.registry.upsertProvider({ key: 'order-second', status: 'disabled' });
    const result = await run();
    assert.equal(result.provider, 'order-first');
    assert.ok(result.explain.attempts.some(a => a.provider === 'order-second' && a.status === 'skipped' && a.error === 'disabled'));
    await h.registry.upsertProvider({ key: 'order-second', status: 'active' });
    assert.equal((await run()).provider, 'order-second');
});
t.test('a provider failure reaches the next configured choice', async () => {
    const entry = await h.pool.adapter('order-second');
    const original = entry.adapter.chat;
    entry.adapter.chat = async () => { throw Object.assign(new Error('test timeout'), { code: 'provider.timeout' }); };
    try {
        const result = await run();
        assert.equal(result.provider, 'order-first');
        assert.ok(result.explain.attempts.some(a => a.provider === 'order-second' && a.status === 'timeout'));
    } finally { entry.adapter.chat = original; await h.pool.resetHealth('order-second'); }
});
t.test('empty enabled arrays fail closed, while disabling the override restores ordinary routing', async () => {
    await orders.save('chat', { enabled: true, choices: [] });
    await assert.rejects(run);
    await orders.save('chat', { enabled: false, choices });
    assert.equal((await run()).provider, 'order-first');
});
t.test('owner capability gate and invalid references cannot change an order', async () => {
    const path = '/api/v1/admin/console/orders/chat';
    assert.equal((await request(h.base, 'POST', path, { tok: denied, body: { enabled: true, choices } })).status, 403);
    for (const invalid of [{ enabled: true, choices: [{ provider: 'missing', model: 'm' }] }, { enabled: true, choices: [choices[0], choices[0]] }, { enabled: 'true', choices }]) {
        assert.equal((await request(h.base, 'POST', path, { tok: owner, body: invalid })).status, 422);
    }
    const saved = await request(h.base, 'POST', path, { tok: owner, body: { enabled: true, choices } });
    assert.equal(saved.status, 200);
    assert.equal((await orders.read('chat')).enabled, true);
});
t.run(() => h && h.stop());
