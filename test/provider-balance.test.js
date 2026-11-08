'use strict';
// The hourly balance probe: a provider with a balance API (DeepSeek) is asked what its account holds, the
// reading becomes ai_provider_balance_usd{provider}, and the key is only ever sent in Authorization — never
// logged or exposed. Off under a drill (AI_DRILL=1 / AI_BALANCE_PROBE=0).
const assert = require('assert');
const { createRegistry } = require('openvibe-shared/metrics');
const { createBalanceProbe, deepseekUsd } = require('../server/providers/balance');
const { centsToUsd, allocate, createCreditGrants } = require('../server/providers/credit-grants');
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
    assert.ok(/ai_provider_balance_usd\{provider="shared",kind="available"\} 0\.05\n/.test(text), text);
});

t.test('grant cost uses cents strings and spends promotional credit in expiry order', () => {
    assert.strictEqual(centsToUsd('41280.000000'), 412.8);
    assert.strictEqual(centsToUsd('0.05'), 0.0005);
    assert.strictEqual(centsToUsd(5), null);
    const left = allocate([
        { kind: 'purchased', amount_usd: '40', as_of: '2026-01-01' },
        { kind: 'promotional', amount_usd: '25', expires_at: '2026-12-01', as_of: '2026-01-01' },
        { kind: 'promotional', amount_usd: '10', expires_at: '2026-11-01', as_of: '2026-01-01' },
    ], 12, Date.parse('2026-10-01'));
    assert.deepStrictEqual(left, { promotional: 23, purchased: 40 });
    assert.deepStrictEqual(allocate([{ kind: 'promotional', amount_usd: 10, expires_at: '2026-01-01' }], 0, Date.parse('2026-02-01')), { promotional: 0, purchased: 0 });
});

t.test('OpenAI admin cost rows are summed in USD and paged', async () => {
    const urls = [];
    const db = { prepare(sql) { return { all: async () => [{ kind: 'promotional', amount_usd: '110', as_of: '2026-11-01', remaining_as_of_usd: '110', remaining_as_of: '2026-11-01' }], get: async () => ({ spent: 0 }) }; } };
    const credits = createCreditGrants({ db, env: { AI_OPENAI_ADMIN_KEY_REF: 'env:OPENAI_ADMIN', OPENAI_ADMIN: 'admin-secret' }, clock: { now: () => Date.parse('2026-11-08T01:00:00Z') }, fetchImpl: async (url) => {
        urls.push(String(url));
        return { ok: true, json: async () => urls.length === 1 ? { data: [{ results: [{ amount: { value: '1.43' } }] }], has_more: true, next_page: 'page2' } : { data: [{ results: [{ amount: { value: '0.00' } }, { amount: { value: '0.00' } }] }], has_more: false } };
    } });
    const result = await credits.poll();
    assert.strictEqual(urls.length, 2);
    assert.match(urls[0], /start_time=1793491200/);
    assert.strictEqual(result.find((r) => r.provider === 'openai').spent_usd, 1.43);
});

t.test('the optional Admin API key is sent only on its cost request and never returned', async () => {
    const calls = [];
    const db = { prepare(sql) { return { all: async () => [{ kind: 'promotional', amount_usd: '200', as_of: '2026-11-08T00:00:00Z', expires_at: null }], get: async () => ({ spent: 0 }) }; } };
    const credits = createCreditGrants({ db, env: { AI_ANTHROPIC_ADMIN_KEY_REF: 'env:ANTHROPIC_ADMIN', ANTHROPIC_ADMIN: 'admin-secret' }, clock: { now: () => Date.parse('2026-11-08T01:00:00Z') }, fetchImpl: async (url, options) => {
        calls.push({ url: String(url), key: options.headers['x-api-key'] });
        return { ok: true, json: async () => ({ data: [{ cost: { amount: '360.000000' } }] }) };
    } });
    const result = await credits.poll();
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.includes('starting_at='));
    assert.strictEqual(calls[0].key, 'admin-secret');
    assert.strictEqual(result[0].promotional, 196.4);
    assert.ok(!JSON.stringify(result).includes('admin-secret'));
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
