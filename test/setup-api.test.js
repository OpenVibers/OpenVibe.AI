'use strict';
/**
 * The guided setup API (OpenVibe.Network /admin/ai/setup): every step has a state, a price and a key
 * page; a key is written sealed and never echoed; a test call goes through the route's own placement;
 * route choices and monthly caps are stored; the recommended set fills the routes.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, request, token, seamServer, suite } = require('./helpers');

const t = suite('setup-api');
const owner = token('network', ['ai.provider.manage']);
const reader = token('network', ['ai.usage.read']);
const keys = { OV_CONFIG_KEKS: `test:${crypto.randomBytes(32).toString('base64')}`, OV_CONFIG_KEK_CURRENT: 'test', AI_USER_MODULES: 'off' };
const KEY = 'setup-test-key-abcd1234';

let h;
let seam;

t.test('the page state: eight steps, owner only, key pages and spend', async () => {
    seam = await seamServer((body) => ({
        choices: [{ index: 0, message: { role: 'assistant', content: `(test) ${body.messages[body.messages.length - 1].content}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }, model: body.model,
    }));
    h = await boot({ env: keys });
    let r = await request(h.base, 'GET', '/api/v1/setup', { tok: owner });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.steps.length, 8, 'one step per job');
    assert.strictEqual(r.body.summary.total, 8);
    assert.strictEqual(r.body.steps.find((s) => s.id === 'chat').state, 'not_set', 'no chat key yet');
    assert.strictEqual(r.body.steps.find((s) => s.id === 'stt').state, 'ready', 'whisper.cpp on this host needs no key');
    assert.ok(r.body.steps.every((s) => s.key_page || s.id === 'stt' || s.id === 'embedding' || s.id === 'search'), 'a key page for every paid step');
    assert.ok(r.body.steps.find((s) => s.id === 'chat').recommended.price.text.includes('per 1M tokens'), 'price in plain numbers');
    assert.strictEqual(r.body.defaults.length, 8, 'one defaults row per kind');
    r = await request(h.base, 'GET', '/api/v1/setup', { tok: reader });
    assert.strictEqual(r.status, 200, 'a usage reader may read the page');
    const denied = await request(h.base, 'PUT', '/api/v1/setup/caps/chat', { tok: reader, body: { cap_usd: 1 } });
    assert.strictEqual(denied.status, 403, 'a write needs provider.manage');
});

t.test('a provider key is sealed, never echoed, and the provider turns on', async () => {
    await h.registry.upsertProvider({
        key: 'setup-test', display_name: 'Setup Test', kind: 'openai', status: 'disabled', base_url: seam.url,
        auth_mode: 'bearer', secret_ref: 'vault:setup-test', default_model: 'setup-model', capabilities: ['chat', 'generate'],
    }, { actor: 'test' });
    await h.registry.upsertModel({
        provider_key: 'setup-test', model_key: 'setup-model', display_name: 'Setup Model', type: 'chat', status: 'active',
        cost: { in_per_mtok: 0.2, out_per_mtok: 0.4 }, supports: { json: true, tools: true, streaming: true },
    }, { actor: 'test' });
    const r = await request(h.base, 'PUT', '/api/v1/setup/providers/setup-test/key', { tok: owner, body: { key: KEY } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.hint.last4, '1234', 'the answer shows the last four');
    assert.ok(!JSON.stringify(r.body).includes(KEY), 'the key itself is never returned');
    const provider = await h.registry.getProvider('setup-test');
    assert.strictEqual(provider.status, 'active', 'the provider is on once its key works');
    const state = await request(h.base, 'GET', '/api/v1/setup', { tok: owner });
    assert.strictEqual(state.body.steps.find((s) => s.id === 'chat').state, 'ready', 'the route now has a configured offer');
});

t.test('a test call goes through the route placement and answers with its cost', async () => {
    const r = await request(h.base, 'POST', '/api/v1/setup/test/chat', { tok: owner, body: { provider: 'setup-test', model: 'setup-model' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.provider, 'setup-test');
    assert.strictEqual(r.body.model, 'setup-model');
    assert.match(r.body.answer.text, /setup is ready/i, 'the provider\'s answer is shown');
    assert.ok(r.body.cost_usd >= 0, 'the cost is shown');
    assert.strictEqual(seam.last.model, 'setup-model', 'the routed model reached the provider');
    assert.ok(seam.last.messages, 'the request was a real chat call');
});

t.test('a route write pins the model the defaults table shows', async () => {
    const r = await request(h.base, 'PUT', '/api/v1/setup/routes/chat', { tok: owner, body: { provider: 'setup-test', model: 'setup-model' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.current, { provider: 'setup-test', model: 'setup-model' });
    const route = await h.registry.getRoute('default.chat');
    assert.strictEqual(route.constraints.model, 'setup-model', 'the route carries the choice');
    assert.strictEqual(route.constraints.authority, 'setup-test:setup-model');
    const state = await request(h.base, 'GET', '/api/v1/setup', { tok: owner });
    assert.deepStrictEqual(state.body.steps.find((s) => s.id === 'chat').current, { provider: 'setup-test', model: 'setup-model' });
    assert.strictEqual(state.body.defaults.find((d) => d.id === 'chat').current.model, 'setup-model');
});

t.test('the monthly cap is stored per kind and follows the step', async () => {
    const r = await request(h.base, 'PUT', '/api/v1/setup/caps/chat', { tok: owner, body: { cap_usd: 12.5 } });
    assert.strictEqual(r.status, 200, r.text);
    const state = await request(h.base, 'GET', '/api/v1/setup', { tok: owner });
    assert.strictEqual(state.body.steps.find((s) => s.id === 'chat').cap_usd, 12.5);
    assert.strictEqual(state.body.defaults.find((d) => d.id === 'chat').cap_usd, 12.5);
    const bad = await request(h.base, 'PUT', '/api/v1/setup/caps/chat', { tok: owner, body: { cap_usd: -1 } });
    assert.strictEqual(bad.status, 422, 'a negative cap is refused');
});

t.test('a cap refuses the next run of that kind before it spends', async () => {
    const runner = token('network', ['ai.run.create']);
    const first = await request(h.base, 'POST', '/api/v1/runs?wait=15000', { tok: runner, body: { workflow: 'ai.generate', input: { prompt: 'cap test one' } } });
    assert.ok([200, 201].includes(first.status), first.text);
    await h.db.prepare('UPDATE runs SET cost_usd = 1 WHERE id = ?').run(first.body.run.id);
    await request(h.base, 'PUT', '/api/v1/setup/caps/chat', { tok: owner, body: { cap_usd: 0.5 } });
    const second = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: runner, body: { workflow: 'ai.generate', input: { prompt: 'cap test two' } } });
    assert.strictEqual(second.status, 429, second.text);
    assert.strictEqual(second.body.code, 'cap.reached');
    assert.ok(second.headers.get('retry-after'), 'the refusal says when the cap resets');
    await request(h.base, 'PUT', '/api/v1/setup/caps/chat', { tok: owner, body: { cap_usd: 0 } });
});

t.test('the recommended set fills every route, including the image route it creates', async () => {
    const r = await request(h.base, 'POST', '/api/v1/setup/recommended', { tok: owner });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.applied.filter((x) => x.ok).length, 7, 'seven routed steps: '+JSON.stringify(r.body.applied));
    const image = await h.registry.getRoute('default.image');
    assert.ok(image, 'the image route exists after the set');
    assert.strictEqual(image.constraints.model, 'gpt-image-1');
    const chat = await h.registry.getRoute('default.chat');
    assert.strictEqual(chat.constraints.model, 'deepseek-flash', 'the recommended chat model');
    const model = await h.registry.getModel('deepseek', 'deepseek-flash');
    assert.ok(model && model.status === 'active', 'the model is registered so the route can serve it');
});

t.test('a refused key is scrubbed from the test answer', async () => {
    const badKey = 'setup-bad-key-9876';
    await h.registry.upsertProvider({
        key: 'setup-bad', display_name: 'Setup Bad', kind: 'openai', status: 'disabled', base_url: seam.url,
        auth_mode: 'bearer', secret_ref: 'vault:setup-bad', default_model: 'bad-model', capabilities: ['chat'],
    }, { actor: 'test' });
    await h.registry.upsertModel({ provider_key: 'setup-bad', model_key: 'bad-model', type: 'chat', status: 'active' }, { actor: 'test' });
    const put = await request(h.base, 'PUT', '/api/v1/setup/providers/setup-bad/key', { tok: owner, body: { key: badKey } });
    assert.strictEqual(put.status, 200, put.text);
    const original = seam.handler;
    seam.handler = () => ({ status: 401, body: { error: { message: `invalid key ${badKey}` } } });
    try {
        const r = await request(h.base, 'POST', '/api/v1/setup/test/chat', { tok: owner, body: { provider: 'setup-bad', model: 'bad-model' } });
        assert.ok(r.status >= 400, 'the refused test is an error: '+r.status+' '+r.text);
        assert.ok(!r.text.includes(badKey), 'the provider error never carries the key back');
    } finally { seam.handler = original; }
});

t.test('no key is required for the keyless steps', async () => {
    const whisper = await h.registry.getProvider('whisper');
    const r = await request(h.base, 'PUT', '/api/v1/setup/providers/whisper/key', { tok: owner, body: { key: 'anything-at-all' } });
    assert.strictEqual(r.status, 422, 'whisper.cpp takes no key');
    assert.ok(whisper.auth_mode === 'none');
});

t.run();
