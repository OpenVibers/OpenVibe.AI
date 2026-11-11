'use strict';
/**
 * The owner's controls over the provider wave (migration 0075), the rented capacity, and the confirmed
 * prices as pending price-book changes.
 *
 *   - every new provider is listed with its traits, its allowance left and its end date, off by default;
 *   - the owner can turn one on/off and choose standard/flex, audited, and a staff member without
 *     ai.provider.manage is refused;
 *   - the routing rules start safe and the owner's row is what the pool reads;
 *   - the owner's own Runpod vLLM endpoint is priced per million tokens from the hour and the measured
 *     throughput, with its key left in the sealed key slot;
 *   - the confirmed readings enter the price book as pending changes; none is applied without the owner.
 */
const assert = require('assert');
const { boot, request, token, suite, ALL } = require('./helpers');
const { createPriceStore } = require('../server/pricebook/store');
const { proposePriceChanges } = require('../server/pricebook/propose');
const compute = require('../server/gpu/compute-providers');
const seed = require('../server/providers/pool-seed');

const t = suite('provider-controls');
const OWNER = token('owner', ['ai.provider.manage', 'ai.usage.read']);
const STAFF = token('staff', ['ai.run.read']);

let h;
t.test('boot and read the new provider controls', async () => {
    h = await boot({ env: { AI_STUB_FALLBACK: 'false' } });
    const view = await request(h.base, 'GET', '/api/v1/admin/console/owner-inference', { tok: token('svc', ALL) });
    assert.strictEqual(view.status, 200, view.text);
    const sable = view.body.controls.find((p) => p.key === 'sable');
    assert.ok(sable, 'Sable is listed');
    assert.strictEqual(sable.enabled, false, 'off');
    assert.strictEqual(sable.traits.payment, 'crypto-prepaid');
    assert.strictEqual(sable.data_policy.retention, 'limited');
    assert.ok(sable.traits.source.includes('sableapi.com'), 'the source travels with the trait');
    assert.strictEqual(sable.traits.checked, '2026-11-10');
    const itera = view.body.controls.find((p) => p.key === 'iteracompute');
    assert.deepStrictEqual(itera.traits.latency_classes, ['background', 'batch']);
    assert.strictEqual(itera.traits.concurrency, 1);
    assert.strictEqual(itera.allowance.left, 30000000, 'the allowance is unspent');
    assert.strictEqual(itera.allowance.ends_at, '2026-11-24T08:00:00Z');
    assert.deepStrictEqual(view.body.rules, { private_training: false, flex_interactive: false, latency_limited_interactive: false, free_allowance_first: true, updated_by: null, updated_at: null });
    assert.strictEqual(view.body.compute.providers.length, 2, 'Runpod and Vast');
    assert.strictEqual(view.body.compute.providers.find((p) => p.key === 'runpod').pods.find((g) => g.gpu === 'RTX 3090 24GB').hourly_usd, 0.5);
    assert.strictEqual(view.body.pricebook.confirmed.length, 4, 'four confirmed readings are bundled');
});

t.test('only the owner turns a provider on or chooses its tier; the write is audited', async () => {
    const refused = await request(h.base, 'POST', '/api/v1/admin/console/owner-inference/providers', { tok: STAFF, body: { provider_key: 'sable', enabled: true } });
    assert.strictEqual(refused.status, 403, 'staff refused');
    const on = await request(h.base, 'POST', '/api/v1/admin/console/owner-inference/providers', { tok: OWNER, body: { provider_key: 'sable', enabled: true, tier: 'standard' } });
    assert.strictEqual(on.status, 200, on.text);
    assert.strictEqual(on.body.provider.enabled, true);
    assert.strictEqual(on.body.provider.tier, 'standard');
    const row = await h.registry.getProvider('sable');
    assert.strictEqual(row.status, 'active');
    const audit = await h.registry.listAudit({ action: 'provider.control', limit: 5 });
    assert.ok(audit.some((a) => a.target_id === 'sable'), 'the change is audited');
    const off = await request(h.base, 'POST', '/api/v1/admin/console/owner-inference/providers', { tok: OWNER, body: { provider_key: 'sable', enabled: false } });
    assert.strictEqual(off.body.provider.enabled, false);
    assert.strictEqual((await h.registry.getProvider('sable')).status, 'disabled');
    const bad = await request(h.base, 'POST', '/api/v1/admin/console/owner-inference/providers', { tok: OWNER, body: { provider_key: 'sable', tier: 'priority' } });
    assert.strictEqual(bad.status, 422, 'an unknown tier is refused');
    const missing = await request(h.base, 'POST', '/api/v1/admin/console/owner-inference/providers', { tok: OWNER, body: { provider_key: 'nope', enabled: true } });
    assert.strictEqual(missing.status, 404);
});

t.test('the rules are saved, audited, and the pool reads them', async () => {
    const saved = await request(h.base, 'POST', '/api/v1/admin/console/owner-inference/rules', { tok: OWNER, body: { latency_limited_interactive: true } });
    assert.strictEqual(saved.status, 200, saved.text);
    assert.strictEqual(saved.body.rules.latency_limited_interactive, true);
    assert.strictEqual(saved.body.rules.private_training, false, 'the other safe defaults hold');
    // The pool now lets a background-only provider answer interactively.
    const limited = await h.registry.upsertProvider({ key: 'limited-ok', kind: 'stub', status: 'active', auth_mode: 'none', capabilities: ['chat'], default_model: 'm',
        metadata: { traits: { latency_classes: ['background'], source: 'https://example.test', checked: '2026-11-10' } } });
    await h.registry.upsertModel({ provider_key: limited.key, model_key: 'm', status: 'active', cost: { in_per_mtok: 0, out_per_mtok: 0 }, metadata: {} });
    const run = await h.pool.execute({ key: 'rule-route', primary: { provider: 'limited-ok', model: 'm' }, fallbacks: [] }, 'chat', { messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 });
    assert.strictEqual(run.provider, 'limited-ok', 'the owner switch let it answer');
    const back = await request(h.base, 'POST', '/api/v1/admin/console/owner-inference/rules', { tok: OWNER, body: { latency_limited_interactive: false } });
    assert.strictEqual(back.body.rules.latency_limited_interactive, false, 'back to the safe value');
});

t.test('the owner endpoint is priced per million tokens from the hour and the throughput, keyless', async () => {
    const bad = await request(h.base, 'POST', '/api/v1/admin/console/owner-inference/endpoint', { tok: OWNER, body: { base_url: 'http://insecure.test/v1', model_key: 'm', hourly_usd: 1, throughput_tokens_per_hour: 1000 } });
    assert.strictEqual(bad.status, 422, 'plain http refused');
    const out = await request(h.base, 'POST', '/api/v1/admin/console/owner-inference/endpoint', { tok: OWNER, body: { base_url: 'https://pod-abc-8000.proxy.runpod.io/v1', model_key: 'deepseek-v4.1-flash', hourly_usd: 0.5, throughput_tokens_per_hour: 1000000 } });
    assert.strictEqual(out.status, 200, out.text);
    assert.strictEqual(out.body.provider.endpoint.hourly_usd, 0.5);
    assert.strictEqual(out.body.provider.endpoint.usd_per_mtok, 0.5, '$0.50 an hour at 1M tokens an hour is $0.50 a million');
    const provider = await h.registry.getProvider('runpod-vllm');
    assert.strictEqual(provider.base_url, 'https://pod-abc-8000.proxy.runpod.io/v1');
    assert.strictEqual(provider.secret_ref, 'vault:runpod-vllm', 'the key slot, never a value');
    const model = await h.registry.getModel('runpod-vllm', 'deepseek-v4.1-flash');
    assert.strictEqual(model.cost.in_per_mtok, 0.5);
    assert.strictEqual(model.metadata.hourly_usd, 0.5);
    const view = await request(h.base, 'GET', '/api/v1/admin/console/owner-inference', { tok: token('svc', ALL) });
    assert.strictEqual(view.body.compute.endpoint.usd_per_mtok, 0.5, 'the compute block shows the same arithmetic');
    assert.ok(!JSON.stringify(view.body).includes('vault:'), 'no secret reference is echoed as a value');
});

t.test('the confirmed readings become pending changes; nothing is applied automatically', async () => {
    const view = await request(h.base, 'GET', '/api/v1/admin/console/owner-inference', { tok: token('svc', ALL) });
    const proposals = view.body.pricebook.confirmed;
    const store = createPriceStore({ db: h.db });
    const dry = await proposePriceChanges({ registry: h.registry, store, proposals, dryRun: true });
    assert.ok(dry.proposed.some((p) => p.provider_key === 'sable'), 'the Sable reading is proposed');
    assert.ok(dry.proposed.some((p) => p.provider_key === 'inception'), 'the Inception reading is proposed');
    assert.ok(dry.proposed.some((p) => p.provider_key === 'openrouter'), 'the OpenRouter Particle Flex reading is proposed');
    const sable = dry.proposed.find((p) => p.provider_key === 'sable');
    assert.strictEqual(sable.fields.find((f) => f.field === 'in_per_mtok').next, 0.15);
    assert.match(sable.source, /sableapi\.com/, 'the provider page is the source');
    assert.strictEqual(sable.checked_at, '2026-11-10');
    const stillNull = await h.registry.getModel('sable', 'deepseek-v4.1-flash-1017-uncensored');
    assert.strictEqual(stillNull.cost.in_per_mtok, null, 'a dry run writes no price');
    const out = await proposePriceChanges({ registry: h.registry, store, proposals, actor: 'test' });
    assert.ok(out.proposed.length >= 3, 'the readings are written as pending');
    const pending = await store.pending(20);
    assert.ok(pending.some((p) => p.provider_key === 'sable' && p.status === 'pending'), 'pending until the owner decides');
    const live = await h.registry.getModel('sable', 'deepseek-v4.1-flash-1017-uncensored');
    assert.strictEqual(live.cost.in_per_mtok, null, 'the live price is still unchanged');
});

t.test('a disabled model keeps its price and status but gains the offer routing the catalogue states', async () => {
    const key = 'deepseek/deepseek-v4.1-flash-1017';
    const row = await h.registry.getModel('openrouter', key);
    // The production shape: an OpenRouter catalogue row already exists, off, with OpenRouter's own list price.
    await h.registry.upsertModel({ ...row, status: 'disabled', cost: { in_per_mtok: 0.006, out_per_mtok: 0.5, source: 'https://openrouter.ai/api/v1/models' },
        metadata: { ...(row.metadata || {}), routing: undefined, service_tier: undefined } });
    await seed.seedPoolProviders({ registry: h.registry, actor: 'test' });
    const after = await h.registry.getModel('openrouter', key);
    assert.strictEqual(after.status, 'disabled', 'the owner switch stays');
    assert.strictEqual(after.cost.in_per_mtok, 0.006, 'the live price is not overwritten');
    assert.deepStrictEqual(after.metadata.routing, { only: ['particle-ai'], allow_fallbacks: false, service_tier: 'flex', data_collection: 'deny' }, 'the offer routing is recorded');
    assert.strictEqual(after.metadata.service_tier, 'flex');
});

t.test('the rented capacity records name their prices and the startup credit note', () => {
    const runpod = compute.get('runpod');
    assert.strictEqual(compute.cheapest(runpod), 0.27);
    assert.strictEqual(runpod.credits.starter_usd, 1000);
    assert.match(runpod.credits.note, /nothing was applied/i);
    const vast = compute.get('vast');
    assert.strictEqual(vast.traits.latency_classes[0], 'background', 'spot capacity is background only');
    assert.strictEqual(vast.pods.find((g) => g.gpu.includes('3090')).spot_usd, 0.12);
});

t.run(() => h && h.stop());
