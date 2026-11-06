'use strict';
// The free tier's sources: a run nobody pays for (the free allowance, the anonymous Try it) may use only
// offers from AI_FREE_PROVIDERS (default deepseek,local,community) AND at or below the output price ceiling.
// The provider is as much a rule as the price: a cheaper OpenAI offer is skipped for a free run, while a
// person's own token pays for it and a local model stays free capacity.
const assert = require('assert');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');
const { load } = require('../server/config');
const freeTier = require('../server/free-tier');

const t = suite('free-providers');
const tok = token('test', ALL);
const person = token('dana', ALL, { sub: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPY', actorType: 'user' });
const models = {
    deepseek: { model_key: 'deepseek-flash', display_name: 'DeepSeek Flash', type: 'chat', supports: { json: true, tools: true, streaming: true }, cost: { in_per_mtok: 0.3, out_per_mtok: 1.2 } },
    openai: { model_key: 'gpt-5-nano', display_name: 'GPT-5 nano', type: 'chat', supports: { json: true, tools: true, streaming: true }, cost: { in_per_mtok: 0.05, out_per_mtok: 0.2 } },
    local2: { model_key: 'qwen3-1.7b', display_name: 'Qwen3 1.7B', type: 'chat', supports: { json: true, streaming: true } },
};
let h; let srv; let route;

t.test('the default sources, the local family and the ceiling rule', () => {
    const cfg = load({});
    assert.deepStrictEqual(cfg.freeUse.providers, ['deepseek', 'local', 'community']);
    assert.strictEqual(cfg.freeUse.maxOutputPricePerMtok, 1.5);
    assert.deepStrictEqual(load({ AI_FREE_PROVIDERS: 'deepseek, local' }).freeUse.providers, ['deepseek', 'local']);
    assert.deepStrictEqual(load({ AI_FREE_PROVIDERS: '' }).freeUse.providers, ['deepseek', 'local', 'community']);
    const sources = freeTier.sourcesOf(cfg.freeUse);
    assert.ok(freeTier.allowsProvider('deepseek', { key: 'deepseek', kind: 'openai' }, sources));
    assert.ok(freeTier.allowsProvider('local2', { key: 'local2', kind: 'openai', metadata: { local: true } }, sources), 'local covers the second local server');
    assert.ok(freeTier.allowsProvider('whisper', { key: 'whisper', kind: 'whisper' }, sources), 'local covers whisper.cpp');
    assert.ok(!freeTier.allowsProvider('shared', { key: 'shared', kind: 'openai' }, sources), 'the shared OpenAI key is not a free-tier source');
    assert.ok(freeTier.allowsCommunity(sources));
    assert.strictEqual(freeTier.allowsOffer({ providerKey: 'deepseek', outputPrice: 1.2 }, cfg.freeUse), true);
    assert.strictEqual(freeTier.allowsOffer({ providerKey: 'deepseek', outputPrice: 3.96 }, cfg.freeUse), false, 'dearer than the ceiling');
    assert.strictEqual(freeTier.allowsOffer({ providerKey: 'openai', outputPrice: 0.2 }, cfg.freeUse), false, 'cheap is not enough: the source must be named');
    assert.strictEqual(freeTier.allowsOffer({ providerKey: 'local2', providerRecord: { kind: 'openai', metadata: { local: true } }, outputPrice: null }, cfg.freeUse), true);
});

t.test('boot a named source and a cheaper provider outside the list', async () => {
    srv = await seamServer(() => ({ text: 'an answer', model: 'm', usage: { input: 5, output: 2 } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0' } });
    for (const key of ['deepseek', 'openai']) {
        await h.registry.upsertProvider({ key, display_name: key, kind: 'http', status: 'active', base_url: srv.url, auth_mode: 'none', capabilities: ['chat', 'generate', 'json'], default_model: models[key].model_key, timeout_ms: 3000 }, { actor: 'test', origin: 'admin' });
        await h.registry.upsertModel({ provider_key: key, ...models[key] }, { actor: 'test' });
    }
    route = await h.registry.createRouteVersion('test.free-providers', { capability: 'chat', constraints: { objective: 'correctness' }, timeout_ms: 3000 }, { actor: 'test' });
});

t.test('a free run skips the cheaper provider outside the list and answers from DeepSeek', async () => {
    const out = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'hello' }], timeoutMs: 3000 }, { routeKey: route.key, routeVersion: route.version, freeUse: true });
    assert.strictEqual(out.provider, 'deepseek');
    assert.ok(out.explain.attempts.some((a) => a.provider === 'openai' && /free_provider_not_allowed/.test(a.error || '')), JSON.stringify(out.explain.attempts));
});

t.test('the free allowance (a service naming a person) gets the same rule', async () => {
    const r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok, body: {
        workflow: 'ai.complete', input: { messages: [{ role: 'user', content: 'hello' }] },
        on_behalf_of: { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPY' } } });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.run.status, 'succeeded', r.text);
    assert.strictEqual(r.body.run.provenance.provider, 'deepseek', r.text);
});

t.test('when every offering provider is outside the list, a free run is refused 402, never run', async () => {
    const off = await request(h.base, 'POST', '/api/v1/providers/deepseek/disable', { tok });
    assert.strictEqual(off.status, 200, off.text);
    const before = srv.calls;
    await assert.rejects(
        () => h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'hello' }], timeoutMs: 3000 }, { routeKey: route.key, routeVersion: route.version, freeUse: true }),
        (err) => err.code === 'billing.payer_required' && /free allowance/.test(err.detail || err.message) && /deepseek, local, community/.test(err.detail || err.message),
    );
    assert.strictEqual(srv.calls, before, 'no provider was called');
});

t.test("a person's own token may still use the provider outside the list", async () => {
    const r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: person, body: { workflow: 'ai.complete', input: { messages: [{ role: 'user', content: 'hello' }] } } });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.run.status, 'succeeded', r.text);
    assert.strictEqual(r.body.run.provenance.provider, 'openai');
});

t.test('`local` covers a second local server (local2) for a free run', async () => {
    await h.registry.upsertProvider({ key: 'local2', display_name: 'Local model 2', kind: 'http', status: 'active', base_url: srv.url, auth_mode: 'none', billing_profile: 'free', capabilities: ['chat', 'generate', 'json'], default_model: models.local2.model_key, timeout_ms: 3000, metadata: { local: true } }, { actor: 'test', origin: 'admin' });
    await h.registry.upsertModel({ provider_key: 'local2', ...models.local2 }, { actor: 'test' });
    const out = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'hello' }], timeoutMs: 3000 }, { routeKey: route.key, routeVersion: route.version, freeUse: true });
    assert.strictEqual(out.provider, 'local2');
    assert.strictEqual(out.cost, 0);
});

t.test('stop', async () => { await h.stop(); await srv.close(); });
