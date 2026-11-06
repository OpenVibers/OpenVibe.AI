'use strict';
// The hourly balance probe: a provider with a balance API (DeepSeek) is asked what its account holds, the
// reading becomes ai_provider_balance_usd{provider}, and the key is only ever sent in Authorization — never
// logged or exposed. Off under a drill (AI_DRILL=1 / AI_BALANCE_PROBE=0).
const assert = require('assert');
const { createRegistry } = require('openvibe-shared/metrics');
const { createBalanceProbe, deepseekUsd } = require('../server/providers/balance');
const { registerAiGauges } = require('../server/observability');
const { load } = require('../server/config');
const { suite } = require('./helpers');

const t = suite('provider-balance');

const record = (key, base_url, secret_ref = 'env:DEEPSEEK_API_KEY') => ({ key, status: 'active', base_url, secret_ref, kind: 'openai', metadata: {} });

t.test('DeepSeek balance: USD total read, gauge exposed, key never logged', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
        calls.push({ url, auth: opts.headers.Authorization });
        return { ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '0.05', granted_balance: '0.00', topped_up_balance: '0.05' }] }) };
    };
    const warned = [];
    const config = load({ NODE_ENV: 'test', AI_BALANCE_PROBE: '1' });
    const probe = createBalanceProbe({
        registry: { listProviders: async () => [record('shared', 'https://api.deepseek.com/v1'), record('other', 'https://api.openai.com/v1')] },
        config, env: { DEEPSEEK_API_KEY: 'sk-deepseek-secret' }, fetchImpl,
        clock: { now: () => 1762400000000 }, log: { warn: (m) => warned.push(m), log() {} },
    });
    const values = await probe.poll();
    assert.deepStrictEqual(values, [{ provider: 'shared', usd: 0.05, at: 1762400000000 }]);
    assert.strictEqual(calls.length, 1, 'only the provider whose host has a balance API is asked');
    assert.strictEqual(calls[0].url, 'https://api.deepseek.com/user/balance');
    assert.strictEqual(calls[0].auth, 'Bearer sk-deepseek-secret');
    assert.ok(!JSON.stringify(warned).includes('sk-deepseek-secret'), 'the key is never in a log line');
    assert.deepStrictEqual(deepseekUsd({ balance_infos: [{ currency: 'CNY', total_balance: '10' }] }), null, 'a non-USD balance is not read as dollars');

    const metrics = createRegistry();
    registerAiGauges(metrics, {
        runs: { stats: () => ({ queued: 0, running: 0, max_concurrent: 1, max_queued: 10 }) },
        registry: { listProviders: async () => [], publicProvider: (p) => p }, pool: { health: async () => ({ state: 'closed' }) },
        balance: probe,
    });
    const text = await metrics.metricsAsync();
    assert.ok(/ai_provider_balance_usd\{provider="shared"\} 0\.05\n/.test(text), text);
});

t.test('a failed probe keeps the last reading and does not fail the caller', async () => {
    let status = 200;
    const fetchImpl = async () => ({ ok: status === 200, status, json: async () => ({ balance_infos: [{ currency: 'USD', total_balance: '7.25' }] }) });
    const probe = createBalanceProbe({
        registry: { listProviders: async () => [record('shared', 'https://api.deepseek.com/v1')] },
        config: load({ NODE_ENV: 'test' }), env: { DEEPSEEK_API_KEY: 'k' }, fetchImpl,
        clock: { now: () => 1 }, log: { warn() {}, log() {} },
    });
    assert.strictEqual((await probe.poll())[0].usd, 7.25);
    status = 503;
    assert.strictEqual((await probe.poll())[0].usd, 7.25, 'the last good balance stays');
});

t.test('off under a drill or when AI_BALANCE_PROBE=0', () => {
    assert.strictEqual(load({ NODE_ENV: 'test', AI_DRILL: '1' }).balance.enabled, false);
    assert.strictEqual(load({ NODE_ENV: 'test', AI_BALANCE_PROBE: '0' }).balance.enabled, false);
    assert.strictEqual(load({ NODE_ENV: 'test' }).balance.enabled, true);
});

t.run();
