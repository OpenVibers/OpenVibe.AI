'use strict';
/**
 * L37: a soft preference. The caller may name a provider (and a model) they would rather have. It is a wish, not a
 * pin: the person's own key for that provider answers first (at no fee), else the network offer for it, and the
 * normal routing is the fallback. It never disables own keys, never overrides only_my_keys, never beats the price
 * ceiling, and never forces a model that fails a hard need. An unknown id is ignored, never an error.
 */
const assert = require('assert');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');

const t = suite('prefer-route');
const KEY = 'cd'.repeat(32);
const DANA = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPX';
const ANTHROPIC_KEY = 'test-anthropic-key-not-a-secret';
const OPENAI_KEY = 'test-openai-key-not-a-secret';
const person = token('dana', ALL, { sub: DANA, actorType: 'user' });
const service = token('live', ALL);
const calls = [];
let h;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const credentialFetch = async (url, init = {}) => {
    calls.push({ url: String(url), auth: (init.headers && (init.headers.Authorization || init.headers['x-api-key'])) || null });
    if (String(url).endsWith('/models')) return json({ data: [{ id: 'm-one' }, { id: 'm-two' }] });
    if (String(url).endsWith('/messages')) return json({ model: 'm-one', content: [{ type: 'text', text: 'hello from dana key' }], usage: { input_tokens: 4, output_tokens: 2 } });
    if (String(url).endsWith('/chat/completions')) return json({ model: 'm-one', choices: [{ message: { role: 'assistant', content: 'hello from dana key' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
    return json({});
};

async function provider(body) {
    const r = await request(h.base, 'POST', '/api/v1/providers', { tok: service, body: { kind: 'http', auth_mode: 'none', timeout_ms: 3000, ...body } });
    assert.strictEqual(r.status, 201, r.text);
}
async function model(providerKey, modelKey, body) {
    const r = await request(h.base, 'POST', '/api/v1/models', { tok: service, body: { provider_key: providerKey, model_key: modelKey, type: 'chat', status: 'active', ...body } });
    assert.strictEqual(r.status, 201, r.text);
}
const prefs = (over) => ({ only_my_keys: false, free_first: true, price_ceiling_usd_per_mtok: null, defaults: { text: 'auto', code: 'auto', vision: 'auto', image: 'auto' }, ...(over || {}) });
const DESCRIBED = { listed: true, synced_at: '2026-10-31T00:00:00.000Z' };

t.test('boot', async () => {
    h = await boot({ env: { AI_CREDENTIALS_KEY: KEY, AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0' }, credentialFetch });
});

t.test("a person with their own anthropic key, asking for anthropic/claude-opus-5-5, runs on their key at no fee", async () => {
    const net = await seamServer(() => ({ text: 'the network answer', model: 'claude-opus-5-5', usage: { input: 3, output: 1 } }));
    await provider({ key: 'anthropic', base_url: net.url, capabilities: ['chat', 'generate', 'json'], default_model: 'claude-opus-5-5' });
    await model('anthropic', 'claude-opus-5-5', { cost: { in_per_mtok: 5, out_per_mtok: 25 }, supports: { json: true }, metadata: { tier: 'strong', ...DESCRIBED } });
    let r = await request(h.base, 'PUT', '/api/v1/me/credentials/anthropic', { tok: person, body: { provider: 'anthropic', key: ANTHROPIC_KEY, models: { chat: 'm-one' } } });
    assert.strictEqual(r.status, 200, r.text);
    const before = net.calls;
    r = await request(h.base, 'POST', '/api/v1/runs?wait=8000', { tok: service, body: {
        workflow: 'live.viewers.line', input: { role: 'chat', user: 'say hi' }, on_behalf_of: { type: 'user', id: DANA },
        prefer: { provider: 'anthropic', model: 'claude-opus-5-5' },
    } });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.run.status, 'succeeded', JSON.stringify(r.body.run).slice(0, 600));
    assert.ok(/your anthropic key/.test(r.body.run.explain.paid_by), 'their own key paid: ' + r.body.run.explain.paid_by);
    assert.strictEqual(Number(r.body.run.cost_usd || 0), 0, 'their own key costs them nothing');
    assert.strictEqual(r.body.run.explain.prefer.honoured, true, JSON.stringify(r.body.run.explain.prefer));
    assert.strictEqual(r.body.run.explain.prefer.provider, 'anthropic');
    assert.strictEqual(r.body.run.explain.prefer.model, 'claude-opus-5-5');
    assert.strictEqual(net.calls, before, 'the network offer was never called');
    await net.close();
});

t.test('without a key of their own, it runs on the network offer for that provider', async () => {
    const net = await seamServer(() => ({ text: 'the network answer', model: 'claude-opus-5-5', usage: { input: 3, output: 1 } }));
    await provider({ key: 'anthropic', base_url: net.url, capabilities: ['chat', 'generate', 'json'], default_model: 'claude-opus-5-5' });
    await model('anthropic', 'claude-opus-5-5', { cost: { in_per_mtok: 5, out_per_mtok: 25 }, supports: { json: true }, metadata: { tier: 'strong', ...DESCRIBED } });
    const r = await request(h.base, 'POST', '/api/v1/runs?wait=8000', { tok: service, body: {
        workflow: 'live.viewers.line', input: { role: 'chat', user: 'say hi' },
        prefer: { provider: 'anthropic', model: 'claude-opus-5-5' },
    } });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.run.status, 'succeeded', JSON.stringify(r.body.run).slice(0, 600));
    assert.strictEqual(r.body.run.provenance.provider, 'anthropic', 'the offer they named answered');
    assert.strictEqual(r.body.run.explain.prefer.honoured, true, JSON.stringify(r.body.run.explain.prefer));
    assert.ok(net.calls > 0, 'the network offer was called');
    await net.close();
});

t.test('only_my_keys with no matching key does not fall to the network', async () => {
    const net = await seamServer(() => ({ text: 'the network answer', model: 'claude-opus-5-5', usage: { input: 3, output: 1 } }));
    await provider({ key: 'anthropic', base_url: net.url, capabilities: ['chat', 'generate', 'json'], default_model: 'claude-opus-5-5' });
    await model('anthropic', 'claude-opus-5-5', { cost: { in_per_mtok: 5, out_per_mtok: 25 }, supports: { json: true }, metadata: { tier: 'strong', ...DESCRIBED } });
    // They keep a key, but not for the provider they ask for.
    let r = await request(h.base, 'DELETE', '/api/v1/me/credentials/anthropic', { tok: person });
    assert.ok([200, 204].includes(r.status), r.text);
    r = await request(h.base, 'PUT', '/api/v1/me/credentials/openai', { tok: person, body: { provider: 'openai', key: OPENAI_KEY, models: { chat: 'm-chat' } } });
    assert.strictEqual(r.status, 200, r.text);
    r = await request(h.base, 'PUT', '/api/v1/me/ai/preferences', { tok: person, body: prefs({ only_my_keys: true }) });
    assert.strictEqual(r.status, 200, r.text);
    const before = net.calls;
    r = await request(h.base, 'POST', '/api/v1/runs?wait=8000', { tok: service, body: {
        workflow: 'live.viewers.line', input: { role: 'chat', user: 'say hi' }, on_behalf_of: { type: 'user', id: DANA },
        prefer: { provider: 'anthropic', model: 'claude-opus-5-5' },
    } });
    const run = r.body.run;
    assert.ok(run.status === 'succeeded' || (run.error && run.error.code === 'ai.needs_key'), JSON.stringify(run).slice(0, 400));
    assert.strictEqual(run.explain.prefer.honoured, false, JSON.stringify(run.explain.prefer));
    assert.ok(run.explain.prefer.why, 'the explain says why the preference was not honoured');
    assert.strictEqual(net.calls, before, 'the network was never called');
    if (run.status === 'succeeded') assert.ok(/your openai key/.test(run.explain.paid_by), 'their own key paid: ' + run.explain.paid_by);
    r = await request(h.base, 'PUT', '/api/v1/me/ai/preferences', { tok: person, body: prefs() });
    assert.strictEqual(r.status, 200, r.text);
    await request(h.base, 'DELETE', '/api/v1/me/credentials/openai', { tok: person });
    await net.close();
});

t.test('a prefer that needs vision on a text-only model is not honoured', async () => {
    const see = await seamServer(() => ({ text: 'I can see', model: 'seer-m', usage: { input: 3, output: 1 } }));
    const blind = await seamServer(() => ({ text: 'I cannot', model: 'blind-m', usage: { input: 3, output: 1 } }));
    await provider({ key: 'seer', base_url: see.url, capabilities: ['chat', 'generate', 'vision', 'json'], default_model: 'seer-m' });
    await model('seer', 'seer-m', { supports: { json: true, vision: true }, metadata: { tier: 'balanced', ...DESCRIBED } });
    await provider({ key: 'blind', base_url: blind.url, capabilities: ['chat', 'generate', 'json'], default_model: 'blind-m' });
    await model('blind', 'blind-m', { supports: { json: true, vision: false }, metadata: { tier: 'balanced', ...DESCRIBED } });
    const r = await request(h.base, 'POST', '/api/v1/routes/test.prefer/versions', { tok: service, body: { capability: 'chat', constraints: { objective: 'cheapest' }, timeout_ms: 3000 } });
    assert.strictEqual(r.status, 201, r.text);
    const route = r.body.route;
    const exec = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'what is in this picture?' }], image: { base64: 'aGk=' }, timeoutMs: 3000, prefer: { provider: 'blind', model: 'blind-m' } }, { routeKey: route.key, routeVersion: route.version });
    assert.strictEqual(exec.provider, 'seer', 'the text-only model never answers a picture');
    assert.strictEqual(exec.explain.prefer.honoured, false, JSON.stringify(exec.explain.prefer));
    assert.ok(/cannot see/.test(exec.explain.prefer.why), exec.explain.prefer.why);
    await see.close(); await blind.close();
});

t.test('an unknown provider or model is ignored, never an error', async () => {
    const net = await seamServer(() => ({ text: 'the network answer', model: 'm', usage: { input: 3, output: 1 } }));
    await provider({ key: 'plain', base_url: net.url, capabilities: ['chat', 'generate', 'json'], default_model: 'plain-m' });
    await model('plain', 'plain-m', { supports: { json: true }, metadata: { tier: 'balanced', ...DESCRIBED } });
    const r = await request(h.base, 'POST', '/api/v1/routes/test.unknown/versions', { tok: service, body: { capability: 'chat', constraints: { objective: 'cheapest' }, timeout_ms: 3000 } });
    const route = r.body.route;
    const exec = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'hello' }], timeoutMs: 3000, prefer: { provider: 'nobody', model: 'nothing' } }, { routeKey: route.key, routeVersion: route.version });
    assert.ok(exec.provider, 'the run still answers');
    assert.strictEqual(exec.explain.prefer.honoured, false);
    assert.ok(/no provider by that name/.test(exec.explain.prefer.why), exec.explain.prefer.why);
    await net.close();
});

t.test('a pinned route behaves as before', async () => {
    const net = await seamServer(() => ({ text: 'the network answer', model: 'm', usage: { input: 3, output: 1 } }));
    const pinned = await seamServer(() => ({ text: 'the pinned answer', model: 'm', usage: { input: 3, output: 1 } }));
    await provider({ key: 'pinned-one', base_url: pinned.url, capabilities: ['chat', 'generate', 'json'], default_model: 'p-m' });
    await model('pinned-one', 'p-m', { supports: { json: true }, metadata: { tier: 'balanced', ...DESCRIBED } });
    await provider({ key: 'other', base_url: net.url, capabilities: ['chat', 'generate', 'json'], default_model: 'o-m' });
    await model('other', 'o-m', { supports: { json: true }, metadata: { tier: 'balanced', ...DESCRIBED } });
    const r = await request(h.base, 'POST', '/api/v1/routes/test.pinned/versions', { tok: service, body: { primary: { provider: 'pinned-one' }, fallbacks: [{ provider: 'other' }], timeout_ms: 3000 } });
    assert.strictEqual(r.status, 201, r.text);
    const route = r.body.route;
    const exec = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'hello' }], timeoutMs: 3000, prefer: { provider: 'other', model: 'o-m' } }, { routeKey: route.key, routeVersion: route.version });
    assert.strictEqual(exec.provider, 'pinned-one', 'the pin decides, as before');
    assert.strictEqual(exec.explain.prefer.honoured, false);
    assert.ok(/pinned/.test(exec.explain.prefer.why), exec.explain.prefer.why);
    await net.close(); await pinned.close();
});

t.test('shutdown', async () => { await h.stop(); });
t.run();
