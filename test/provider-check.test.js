'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { checkProvider } = require('../server/providers/check');
const { boot, request, token, suite } = require('./helpers');
const { providerSecret } = require('../server/util');
const t = suite('provider-check');
const key = 'test-owner-key-never-in-response-1234';
const replacement = 'test-replacement-key-never-in-response-5678';
const env = { CHECK_KEY: key };
const provider = { key: 'check', kind: 'openai', auth_mode: 'bearer', base_url: 'https://check.example/v1', secret_ref: 'env:CHECK_KEY' };
const response = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const manage = token('exchange', ['ai.provider.manage', 'ai.usage.read']);
const unprivileged = token('chat', ['ai.run.read']);

t.test('a model-list check is one free read at the registered endpoint with latency', async () => {
    const calls = [];
    let ticks = 1000;
    const result = await checkProvider({ ...provider, metadata: { models_endpoint: 'https://check.example/catalog/models' } }, {
        env, now: () => (ticks += 25), fetchImpl: async (url, init) => {
            calls.push(url);
            assert.strictEqual(init.headers.Authorization, `Bearer ${key}`);
            assert.strictEqual(init.method, 'GET');
            assert.strictEqual(init.redirect, 'error');
            return response(200, { data: [{ id: 'test' }] });
        },
    });
    assert.deepStrictEqual(calls, ['https://check.example/catalog/models']);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.requests, 1);
    assert.strictEqual(result.latency_ms, 25);
});

t.test('upstream refusals and thrown errors cannot echo the key; no retries', async () => {
    for (const failure of [401, 429, 500, 'throw']) {
        let calls = 0;
        const result = await checkProvider(provider, { env, fetchImpl: async () => {
            calls++;
            if (failure === 'throw') throw new Error(`bad key ${key}`);
            return response(failure, { error: { message: `bad key ${key}` } });
        } });
        assert.strictEqual(calls, 1);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.error, failure === 'throw' ? 'connection_failed' : `http_${failure}`);
        assert.ok(!JSON.stringify(result).includes(key));
    }
});

t.test('missing keys and cross-origin model lists never make a request', async () => {
    const fetchImpl = async () => { throw new Error('must not fetch'); };
    const missing = await checkProvider(provider, { env: {}, fetchImpl });
    assert.strictEqual(missing.error, 'key_not_set');
    const moved = await checkProvider({ ...provider, metadata: { models_endpoint: 'https://other.example/models' } }, { env, fetchImpl });
    assert.strictEqual(moved.ok, false);
    assert.strictEqual(moved.requests, 0);
});

t.test('search checks use their adapter once, with one result and no inference fallback', async () => {
    let calls = 0;
    const result = await checkProvider({ ...provider, kind: 'http', base_url: 'https://api.search.brave.com/res/v1', metadata: { search_adapters: ['brave', 'brave-images'] } }, {
        env, fetchImpl: async (url, init) => {
            calls++;
            assert.strictEqual(new URL(url).searchParams.get('count'), '1');
            assert.strictEqual(init.headers['x-subscription-token'], key);
            return response(200, { web: { results: [] } });
        },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.method, 'search');
    assert.strictEqual(calls, 1);
});

t.test('registered free account checks take precedence over model lists and searches', async () => {
    let calls = 0;
    const result = await checkProvider({ ...provider, kind: 'http', metadata: { check_endpoint: 'https://check.example/usage', search_adapters: ['brave'] } }, {
        env, fetchImpl: async (url) => { calls++; assert.strictEqual(url, 'https://check.example/usage'); return response(200, { label: key }); },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.method, 'account');
    assert.strictEqual(calls, 1);
    assert.ok(!JSON.stringify(result).includes(key));
});

let h;
let requests = 0;
let authUsed;
const logs = [];
const logger = { log: (...v) => logs.push(v.join(' ')), warn: (...v) => logs.push(v.join(' ')), error: (...v) => logs.push(v.join(' ')) };
const api = (method, path, body, tok = manage) => request(h.base, method, path, { body, tok });
const path = '/api/v1/admin/console/providers/keycheck';
t.test('boot the real encrypted store and save keys without making provider calls', async () => {
    h = await boot({ env: { OV_CONFIG_KEKS: `test:${crypto.randomBytes(32).toString('base64')}`, OV_CONFIG_KEK_CURRENT: 'test', AI_USER_MODULES: 'off', CHECK_KEY: key }, log: logger,
        fetchImpl: async (url, init) => { requests++; authUsed = init.headers.Authorization; return response(200, { data: [{ id: 'test' }] }); },
    });
    await h.registry.upsertProvider({ ...provider, key: 'keycheck', status: 'active', capabilities: ['chat'] });
    requests = 0;
    for (const value of [key, replacement]) {
        const saved = await api('POST', `${path}/key`, { api_key: value });
        assert.strictEqual(saved.status, 200, saved.text);
        assert.ok(!saved.text.includes(value));
    }
    assert.strictEqual(requests, 0);
    assert.strictEqual(providerSecret(await h.registry.getProvider('keycheck'), h.env), replacement);
    const read = await api('GET', '/api/v1/admin/console/providers');
    const stored = read.body.providers.find(p => p.key === 'keycheck');
    assert.strictEqual(stored.key_state.hint, '…5678');
    assert.strictEqual(stored.key_state.source, 'stored');
    assert.ok(stored.key_state.set_at);
    assert.ok(!read.text.includes(replacement) && !read.text.includes(key));
    const history = JSON.stringify(await h.db.prepare("SELECT values_json FROM config_snapshots WHERE namespace = 'ai.provider_keys'").all());
    assert.ok(!history.includes(key) && !history.includes(replacement), 'all persisted key revisions are encrypted');
});

t.test('the check route makes one request and records only its safe result', async () => {
    const before = requests;
    const check = await api('POST', `${path}/check`);
    assert.strictEqual(check.status, 200, check.text);
    assert.strictEqual(check.body.ok, true);
    assert.strictEqual(requests - before, 1);
    assert.strictEqual(authUsed, `Bearer ${replacement}`);
    const stored = await h.registry.getProvider('keycheck');
    assert.strictEqual(stored.metadata.last_check.ok, true);
    assert.strictEqual(stored.status, 'active');
    assert.ok(!JSON.stringify(stored.metadata).includes(replacement));
});

t.test('a service without owner capabilities gets 403 for every key operation', async () => {
    const before = requests;
    for (const [method, suffix] of [['POST', 'key'], ['DELETE', 'key'], ['POST', 'check']]) {
        const denied = await api(method, `${path}/${suffix}`, { api_key: key }, unprivileged);
        assert.strictEqual(denied.status, 403, denied.text);
    }
    assert.strictEqual(requests, before);
});

t.test('removal disables immediately, clears the stored key and disconnects environment fallback', async () => {
    const removed = await api('DELETE', `${path}/key`);
    assert.strictEqual(removed.status, 200, removed.text);
    const stored = await h.registry.getProvider('keycheck');
    assert.strictEqual(stored.status, 'disabled');
    assert.strictEqual(stored.secret_ref, null);
    assert.strictEqual(providerSecret(stored, h.env), '');
    assert.strictEqual(stored.metadata.last_check, null);
    const before = requests;
    const check = await api('POST', `${path}/check`);
    assert.strictEqual(check.body.error, 'key_not_set');
    assert.strictEqual(requests, before);
    assert.ok(!logs.join('\n').includes(key) && !logs.join('\n').includes(replacement));
});

t.run(() => h && h.stop());
