'use strict';
/**
 * Owner inputs (the owner-setup design of 2026-11-07): every AI provider key and the GPU keys are x-owner-input fields
 * the admin panel's Setup tab lists, with a key page, a line on what to pick there and a test; every field of every AI
 * namespace has a title and a 30+ character description; the code uses the key entered in the panel when there is
 * one and the server's settings file otherwise; the test hook answers in one line and never carries the key, not even
 * when the provider echoes it back; no log line carries a key.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, request, token, suite } = require('./helpers');
const { lintSchema } = require('./lint-schema');
const { providerSecret } = require('../server/util');

const t = suite('owner-inputs');
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const KEK = crypto.randomBytes(32).toString('base64');
const ENV_KEY = 'made-up-env-key-FROM-THE-SETTINGS-FILE-4c1d9e0a7b';
const PANEL_KEY = 'made-up-panel-key-ENTERED-IN-SETUP-NEVER-SHOWN-93ab';
const BAD_KEY = 'made-up-bad-key-THE-PROVIDER-ECHOES-THIS-BACK-5e2f';
const VAST_KEY = 'made-up-vast-key-NEVER-IN-A-LOG-OR-ANSWER-11d0ffee';
const SECRETS = [ENV_KEY, PANEL_KEY, BAD_KEY, VAST_KEY];
const cfgTok = token('network', ['ai.config.manage', 'ai.provider.manage', 'ai.usage.read']);
const opsTok = token('network', ['ai.provider.manage']);
const noCap = token('live', ['ai.run.read']);
const owner = { 'X-OV-Subject': OWNER, 'X-OV-Fresh': '1' };
const cfg = (h, method, path, body) => request(h.base, method, path, { tok: cfgTok, body, headers: owner });

const calls = [];
/** The providers and marketplaces, faked: a good key is listed, a bad one is refused with the key echoed back. */
async function fakeFetch(url, init = {}) {
    const u = String(url);
    const headers = init.headers || {};
    const auth = String(headers.Authorization || headers.authorization || headers['x-api-key'] || '');
    calls.push({ url: u, auth });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.startsWith('https://keytest.example/v1/models')) {
        if (auth.endsWith(ENV_KEY) || auth.endsWith(PANEL_KEY)) return json(200, { object: 'list', data: [{ id: 'm-1' }, { id: 'm-2' }] });
        return json(401, { error: { message: `Incorrect API key provided: ${auth.replace(/^Bearer /, '')}. You can find your key at the dashboard.` } });
    }
    if (u === 'https://console.vast.ai/api/v0/users/current/') {
        return auth === `Bearer ${VAST_KEY}` ? json(200, { id: 7, credit: 12.5 }) : json(401, { detail: `bad key ${auth}` });
    }
    return json(404, { error: 'not here' });
}

let h;
const logs = [];
const capture = { log: (...a) => logs.push(a.join(' ')), info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
const consoleLines = [];
const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };

t.test('boot with a KEK, an env key for one provider and an image model', async () => {
    for (const k of Object.keys(original)) console[k] = (...a) => { consoleLines.push(a.join(' ')); original[k](...a); };
    h = await boot({
        env: { OV_CONFIG_KEKS: `k1:${KEK}`, OV_CONFIG_KEK_CURRENT: 'k1', AI_USER_MODULES: 'off', KEYTEST_API_KEY: ENV_KEY, AI_IMAGE_MODEL: 'gpt-image-1' },
        log: capture, fetchImpl: fakeFetch,
    });
    const created = await request(h.base, 'POST', '/api/v1/providers', {
        tok: opsTok,
        body: { key: 'keytest', display_name: 'Key Test', kind: 'openai', status: 'active', base_url: 'https://keytest.example/v1', auth_mode: 'bearer', secret_ref: 'env:KEYTEST_API_KEY', capabilities: ['chat'], timeout_ms: 5000 },
    });
    assert.strictEqual(created.status, 201, created.text);
    await h.settings.providerKeys.refresh();
});

t.test('every field of every AI namespace has a title, a 30+ character description and labelled options', async () => {
    const r = await cfg(h, 'GET', '/internal/config');
    assert.strictEqual(r.status, 200, r.text);
    const names = r.body.namespaces.map((n) => n.namespace).sort();
    assert.deepStrictEqual(names, ['ai.accounts', 'ai.decisions', 'ai.exchange', 'ai.gpus', 'ai.provider_keys', 'ai.servers']);
    for (const ns of r.body.namespaces) assert.deepStrictEqual(lintSchema(ns.schema), [], `${ns.namespace}: ${lintSchema(ns.schema).join('; ')}`);
});

t.test('a provider that takes a key is an owner input in the AI providers group, with its key page and a test', async () => {
    const r = await cfg(h, 'GET', '/internal/config/ai.provider_keys');
    const p = r.body.schema.properties;
    const oi = p['keytest.key']['x-owner-input'];
    assert.strictEqual(oi.group, 'ai-providers');
    assert.strictEqual(oi.test, true);
    assert.match(oi.unlocks, /Key Test/);
    assert.match(oi.get_it_how, /key/i);
    assert.strictEqual(p['keytest.key'].title, 'Key Test API key');
    assert.strictEqual(p['keytest.origin']['x-advanced'], true, 'the bound address is an advanced field');
    const ds = p['deepseek.key']['x-owner-input'];
    assert.deepStrictEqual([ds.group, ds.get_it_at], ['ai-providers', 'https://platform.deepseek.com/api_keys']);
    assert.strictEqual(p['stub.key']['x-owner-input'], undefined, 'the stub takes no key');
    assert.strictEqual(p['whisper.key']['x-owner-input'], undefined, 'whisper.cpp takes no key');
    assert.strictEqual(p['shared.key']['x-required-for'], 'Image generation', 'the image model runs on the shared provider: its key is the image key');
    assert.match(p['shared.key']['x-owner-input'].unlocks, /gpt-image-1/);
});

t.test('the GPU keys and the monthly cap are owner inputs in the GPUs group', async () => {
    const r = await cfg(h, 'GET', '/internal/config/ai.gpus');
    const p = r.body.schema.properties;
    assert.deepStrictEqual([p['vast.key']['x-owner-input'].group, p['vast.key']['x-owner-input'].test], ['gpus', true]);
    assert.strictEqual(p['vast.key']['x-owner-input'].get_it_at, 'https://cloud.vast.ai/manage-keys/');
    assert.deepStrictEqual([p['runpod.key']['x-owner-input'].group, p['runpod.key']['x-owner-input'].test], ['gpus', true]);
    assert.strictEqual(p.monthly_cap['x-owner-input'].group, 'gpus');
    assert.strictEqual(p.monthly_cap['x-required-for'], 'Renting GPUs and own endpoints');
    assert.strictEqual(p.monthly_cap['x-unit'], 'nano_usd');
});

t.test('without a key in the panel the provider uses the server settings file, and the test says so', async () => {
    const provider = await h.registry.getProvider('keytest');
    assert.strictEqual(providerSecret(provider, h.env), ENV_KEY);
    const r = await cfg(h, 'POST', '/internal/config/ai.provider_keys/test/keytest.key');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.ok, r.body.state, r.body.source], [true, 'connected', 'env']);
    assert.match(r.body.message, /^Key Test accepted the key and lists 2 models\. \(the value from the server's settings file, KEYTEST_API_KEY\)$/);
    assert.ok(!r.body.message.includes('\n'));
    assert.ok(calls.some((c) => c.url === 'https://keytest.example/v1/models' && c.auth === `Bearer ${ENV_KEY}`));
});

t.test('a key entered in the panel wins over the settings file at use time', async () => {
    const put = await cfg(h, 'PUT', '/internal/config/ai.provider_keys/secrets/keytest.key', { value: PANEL_KEY, reason: 'setup' });
    assert.strictEqual(put.status, 200, put.text);
    assert.ok(!put.text.includes(PANEL_KEY));
    const provider = await h.registry.getProvider('keytest');
    assert.strictEqual(providerSecret(provider, h.env), PANEL_KEY, 'the pool now sends the panel key');
    const view = await request(h.base, 'GET', '/api/v1/providers/keytest', { tok: opsTok });
    assert.strictEqual(view.body.credentials || (view.body.provider && view.body.provider.credentials), 'configured');
    const r = await cfg(h, 'POST', '/internal/config/ai.provider_keys/test/keytest.key');
    assert.deepStrictEqual([r.body.ok, r.body.state, r.body.source], [true, 'connected', 'vault']);
    assert.ok(calls.some((c) => c.auth === `Bearer ${PANEL_KEY}`), 'the test used the panel key');
});

t.test('a refused key is Not working in one line, and the echoed key never comes back', async () => {
    const put = await cfg(h, 'PUT', '/internal/config/ai.provider_keys/secrets/keytest.key', { value: BAD_KEY, reason: 'a wrong key' });
    assert.strictEqual(put.status, 200, put.text);
    const r = await cfg(h, 'POST', '/internal/config/ai.provider_keys/test/keytest.key');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.ok, r.body.state], [false, 'not_working']);
    assert.match(r.body.message, /^Key Test refused the key \(401\): Incorrect API key provided: \[hidden\]/);
    assert.ok(r.body.message.length <= 200 && !r.body.message.includes('\n'));
    assert.ok(!r.text.includes(BAD_KEY) && !r.text.includes(BAD_KEY.slice(0, 12)), 'the answer never carries the key');
});

t.test('removing the panel key falls back to the settings file', async () => {
    const del = await cfg(h, 'DELETE', '/internal/config/ai.provider_keys/secrets/keytest.key', { reason: 'back to env' });
    assert.strictEqual(del.status, 200, del.text);
    assert.strictEqual(providerSecret(await h.registry.getProvider('keytest'), h.env), ENV_KEY);
});

t.test('a GPU key is tested with a read-only account call; an unset one is 409 config.not_set', async () => {
    const none = await cfg(h, 'POST', '/internal/config/ai.gpus/test/runpod.key');
    assert.deepStrictEqual([none.status, none.body.code], [409, 'config.not_set'], 'as Shared 4.125.0\'s hook: nothing to test');
    const put = await cfg(h, 'PUT', '/internal/config/ai.gpus/secrets/vast.key', { value: VAST_KEY, reason: 'setup' });
    assert.strictEqual(put.status, 200, put.text);
    const r = await cfg(h, 'POST', '/internal/config/ai.gpus/test/vast.key');
    assert.deepStrictEqual([r.body.ok, r.body.state], [true, 'connected']);
    assert.strictEqual(r.body.message, 'Vast.ai accepted the key. The account has $12.50 of credit.');
    assert.ok(!calls.some((c) => /\/asks\/|\/bundles|DELETE/.test(c.url)), 'nothing was searched, rented or given back');
});

t.test('the test hook is guarded and only answers for keys that have a test', async () => {
    const r = await request(h.base, 'POST', '/internal/config/ai.provider_keys/test/keytest.key', { tok: noCap, headers: owner });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied']);
    const none = await cfg(h, 'POST', '/internal/config/ai.provider_keys/test/stub.key');
    assert.deepStrictEqual([none.status, none.body.code], [404, 'config.test_not_found']);
    const cap = await cfg(h, 'POST', '/internal/config/ai.gpus/test/monthly_cap');
    assert.strictEqual(cap.status, 404);
});

t.test('no log line, console line or audit row carries a key', async () => {
    for (const k of Object.keys(original)) console[k] = original[k];
    const audit = JSON.stringify(await h.db.prepare('SELECT * FROM audit_log').all());
    for (const s of SECRETS) {
        assert.ok(logs.every((line) => !line.includes(s)), `a log line carries ${s.slice(0, 16)}…`);
        assert.ok(consoleLines.every((line) => !line.includes(s)), `a console line carries ${s.slice(0, 16)}…`);
        assert.ok(!audit.includes(s), 'the audit carries a key');
    }
    assert.ok(logs.some((line) => /\[config\] test ai\.provider_keys keytest\.key: not working/.test(line)), 'the test outcome is logged, without the key');
    await h.stop();
});

(async () => {
    await t.run();
})().catch((err) => { console.error(err); process.exit(1); });
