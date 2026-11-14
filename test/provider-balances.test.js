'use strict';
// What is left on each provider account, read live (plan §AB.21: "the gift credits on all the providers need to be
// detectable"): DeepSeek's gift and topped-up balance, OpenRouter's credits less usage, Moonshot's vouchers; a provider
// without a key, a refused key and a provider that does not answer each say so in words (never a zero it did not read);
// answers are kept ten minutes; the key goes only to the provider's own address; the route is the owner's.
const assert = require('node:assert/strict');
const { boot, request, token, suite } = require('./helpers');
const { createProviderBalances, KEEP_MS } = require('../server/providers/balances');
const t = suite('provider-balances');
const owner = token('network', ['ai.config.manage']);
const denied = token('chat', ['ai.usage.read']);

t.test('balances: gift and paid where the provider says, words where it does not', async () => {
    let now = Date.parse('2026-11-14T15:00:00Z');
    const asked = [];
    const providers = { deepseek: { key: null, secret_ref: 'env:DS_KEY' }, openrouter: { key: null, secret_ref: 'env:OR_KEY' } };
    const registry = { getProvider: async (k) => providers[k] || null };
    let orStatus = 200;
    const fetchImpl = async (url, opts) => {
        asked.push([url, opts.headers.Authorization]);
        const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
        if (url === 'https://api.deepseek.com/user/balance') return json({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.50', granted_balance: '10.00', topped_up_balance: '2.50' }] });
        if (url === 'https://openrouter.ai/api/v1/credits') return json({ data: { total_credits: 20, total_usage: 7.255 } }, orStatus);
        throw new Error('unexpected ' + url);
    };
    const b = createProviderBalances({ registry, fetchImpl, clock: { now: () => now }, env: { DS_KEY: 'sk-ds', OR_KEY: 'sk-or' }, log: { warn() {} } });
    let rows = await b.list();
    const by = (k) => rows.find((r) => r.provider === k);
    assert.deepEqual([by('deepseek').balance, by('deepseek').gift, by('deepseek').paid, by('deepseek').state], [12.5, 10, 2.5, 'read'], 'DeepSeek: the gift credits apart');
    assert.deepEqual([by('openrouter').balance, by('openrouter').paid, by('openrouter').state], [12.75, 20, 'read'], 'OpenRouter: credits less usage');
    assert.deepEqual([by('kimi').state, by('kimi').balance, by('kimi').note], ['not_set_up', null, 'Not set up here'], 'a provider not set up says so, with no zero');
    assert.deepEqual(asked.map(([u, a]) => [new URL(u).host, a]), [['api.deepseek.com', 'Bearer sk-ds'], ['openrouter.ai', 'Bearer sk-or']], 'each key only to its own provider');
    asked.length = 0;
    rows = await b.list();
    assert.equal(asked.length, 0, 'kept ten minutes');
    now += KEEP_MS + 1; orStatus = 401;
    rows = await b.list();
    assert.deepEqual([by('openrouter').state, by('openrouter').balance, by('openrouter').note], ['key_refused', null, 'The provider refused the key']);
    const noKey = createProviderBalances({ registry, fetchImpl, clock: { now: () => now }, env: {}, log: { warn() {} } });
    assert.equal((await noKey.list()).find((r) => r.provider === 'deepseek').state, 'no_key', 'no key yet: says so');
});

t.test('the route is the owner\'s (ai.config.manage)', async () => {
    const h = await boot({ env: { AI_USER_MODULES: 'off' } });
    try {
        assert.equal((await request(h.base, 'GET', '/api/v1/admin/console/provider-balances', { tok: denied })).status, 403);
        const r = await request(h.base, 'GET', '/api/v1/admin/console/provider-balances', { tok: owner });
        assert.equal(r.status, 200, r.text);
        assert.ok(Array.isArray(r.body.providers) && r.body.providers.some((p) => p.provider === 'deepseek'), 'every provider with a balance read is listed');
        assert.ok(!JSON.stringify(r.body).includes('sk-'), 'never a key');
    } finally { await h.close(); }
});

t.run();
