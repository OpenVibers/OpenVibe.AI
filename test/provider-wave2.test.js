'use strict';
/**
 * The 2026-11-10 provider wave, parts 1 and 2.
 *
 * Part 1: the new provider records (Particle AI and its Flex tier, the OpenRouter Particle pin,
 * IteraCompute, Sable, Inception, DOS.AI) are seeded off and keyless, with their traits — classes of
 * work, concurrency, free allowance and its end, payment, training and retention — each with the page
 * and the day it was read.
 *
 * Part 2: routing honours them. A background/batch-only provider never answers an interactive request;
 * a provider that trains on or retains a prompt never receives a person's private data; a concurrency
 * cap skips to the next offer (never errors); a free allowance leads while it lasts and stops at its
 * date; an uncensored offer only ever answers behind the 18+ policy.
 */
const assert = require('assert');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');
const { PROVIDERS } = require('../server/providers/pool-providers');
const seed = require('../server/providers/pool-seed');
const traits = require('../server/providers/traits');
const { buildBody, buildCompleteBody } = require('../server/providers/openai');

const t = suite('provider-wave2');

// ── Part 1: the records ────────────────────────────────────────────────────────

t.test('each new provider is a record, off, keyless, with its traits, price and sources', () => {
    const by = (key) => PROVIDERS.find((p) => p.key === key);
    const itera = by('iteracompute');
    assert.ok(itera, 'IteraCompute is catalogued');
    assert.strictEqual(new URL(itera.base_url).hostname, 'api.iteracompute.com');
    const irow = seed.recordOf(itera);
    assert.strictEqual(irow.status, 'disabled', 'starts off');
    assert.strictEqual(irow.secret_ref, 'vault:iteracompute', 'a key slot, no key');
    assert.deepStrictEqual(irow.metadata.traits.latency_classes, ['background', 'batch'], 'never interactive');
    assert.strictEqual(irow.metadata.traits.concurrency, 1, 'one request per account');
    assert.strictEqual(irow.metadata.traits.free_allowance.tokens, 30000000);
    assert.strictEqual(irow.metadata.traits.free_allowance.ends_at, '2026-11-24T08:00:00Z', 'promotion end');
    assert.strictEqual(irow.metadata.traits.free_only, true);
    assert.match(itera.privacy.wording, /zero-data-retention guarantee/i, 'the retention statement is quoted');

    const sable = by('sable');
    assert.strictEqual(sable.base_url, 'https://sableapi.com/v1');
    assert.strictEqual(seed.recordOf(sable).metadata.uncensored, true);
    assert.strictEqual(seed.recordOf(sable).metadata.traits.payment, 'crypto-prepaid');
    assert.strictEqual(seed.recordOf(sable).metadata.data_policy.trains, false);
    assert.strictEqual(seed.recordOf(sable).metadata.data_policy.retention, 'limited', 'prompt cache hours to days');
    const sableModel = seed.modelOf(sable, sable.models[0]);
    assert.deepStrictEqual([sableModel.cost.in_per_mtok, sableModel.cost.out_per_mtok, sableModel.cost.cached_per_mtok], [0.15, 0.6, 0.01]);
    assert.strictEqual(sableModel.metadata.uncensored, true);
    assert.strictEqual(sableModel.supports.tools && sableModel.supports.vision, true, 'tools and vision');

    const inception = by('inception');
    assert.strictEqual(seed.recordOf(inception).metadata.data_policy.trains, true, 'trains until the owner records the setting off');
    assert.strictEqual(seed.recordOf(inception).metadata.traits.free_allowance.tokens, 100000000);
    assert.strictEqual(seed.recordOf(inception).metadata.traits.free_allowance.period, 'once');
    const mercury = seed.modelOf(inception, inception.models[0]);
    assert.deepStrictEqual([mercury.cost.in_per_mtok, mercury.cost.out_per_mtok, mercury.cost.cached_per_mtok], [0.2, 0.7, 0.02], 'the list price is recorded');
    assert.match(mercury.metadata.note, /\$0\.10|\$0\.35/, 'the launch price is noted, not assumed');

    assert.strictEqual(seed.recordOf(by('particle-ai')).metadata.tier_rates.flex, 0.5, 'Particle Flex is half price');
    assert.deepStrictEqual(seed.recordOf(by('particle-ai')).metadata.traits.tier_latency.flex, ['background', 'batch']);
    assert.strictEqual(seed.recordOf(by('dosai')).metadata.traits.latency_classes[0], 'batch', 'DOS.AI is batch only');

    const openrouter = by('openrouter');
    const pinned = seed.modelOf(openrouter, openrouter.models[0]);
    assert.deepStrictEqual([pinned.cost.in_per_mtok, pinned.cost.out_per_mtok, pinned.cost.cached_per_mtok], [0.025, 0.25, 0.003], 'the Particle Flex price read from OpenRouter');
    assert.deepStrictEqual(pinned.metadata.routing, { only: ['particle-ai'], allow_fallbacks: false, service_tier: 'flex', data_collection: 'deny' });
    assert.strictEqual(pinned.metadata.service_tier, 'flex');
    assert.strictEqual(traits.latencyAllows({ metadata: {} }, pinned, 'interactive'), false, 'a Flex offer never answers in front of a person');
    assert.strictEqual(traits.latencyAllows({ metadata: {} }, pinned, 'background'), true);
});

t.test('the traits read an allowance, a period and training honestly', () => {
    const record = { metadata: { traits: { latency_classes: ['background', 'batch'], concurrency: 1, free_allowance: { tokens: 100, period: 'month', ends_at: '2026-11-24T08:00:00Z' } } } };
    assert.strictEqual(traits.latencyAllows(record, null, 'interactive'), false);
    assert.strictEqual(traits.latencyAllows(record, null, 'background'), true);
    assert.strictEqual(traits.concurrencyOf(record), 1);
    const before = traits.allowanceLeft(record, { used: 40, now: Date.parse('2026-11-20T00:00:00Z') });
    assert.deepStrictEqual([before.tokens, before.used, before.left, before.ended], [100, 40, 60, false]);
    const after = traits.allowanceLeft(record, { used: 40, now: Date.parse('2026-11-25T00:00:00Z') });
    assert.deepStrictEqual([after.left, after.ended], [0, true], 'zero after the end date');
    assert.strictEqual(traits.allowancePeriodStart(record, Date.parse('2026-11-20T10:00:00Z')), '2026-11-01', 'the month it counts');
    assert.strictEqual(traits.trainsOrRetains({ metadata: { data_policy: { trains: true, retention: 'none' } } }), true);
    assert.strictEqual(traits.trainsOrRetains({ metadata: { data_policy: { trains: false, retention: 'limited' } } }), true, 'retaining counts');
    assert.strictEqual(traits.trainsOrRetains({ metadata: { data_policy: { trains: false, retention: 'none' } } }), false);
    assert.strictEqual(traits.trainsOrRetains({ metadata: {} }), true, 'saying nothing is not a promise');
    assert.strictEqual(traits.isPrivateRequest({ presetPolicy: { data_policy: 'private' } }), true);
    assert.strictEqual(traits.isPrivateRequest({}), false);
});

t.test('an OpenRouter offer can pin a provider and carry the tier, and drops fields it does not document', () => {
    const body = buildBody({ model: 'deepseek/deepseek-v4.1-flash-1017', system: [], messages: [{ role: 'user', content: 'hi' }], maxTokens: 5,
        routing: { only: ['particle-ai'], allow_fallbacks: false, data_collection: 'deny', quantizations: ['fp8'], service_tier: 'flex', bogus: true } });
    assert.deepStrictEqual(body.provider, { only: ['particle-ai'], allow_fallbacks: false, data_collection: 'deny', quantizations: ['fp8'] });
    assert.strictEqual(body.service_tier, 'flex');
    assert.strictEqual(body.provider.bogus, undefined, 'nothing undocumented is forwarded');
    const complete = buildCompleteBody({ model: 'm', openai: { messages: [{ role: 'user', content: 'hi' }] }, maxTokens: 5, routing: { sort: 'price', max_price: { completion: 1 }, data_collection: 'deny' } });
    assert.deepStrictEqual(complete.provider, { sort: 'price', max_price: { completion: 1 }, data_collection: 'deny' });
});

// ── Part 2: routing honours them ──────────────────────────────────────────────

let h;
let seam;
let slowSeam;
let release;
const provider = (body) => h.registry.upsertProvider({ kind: 'http', auth_mode: 'none', status: 'active', capabilities: ['chat', 'generate'], priority: 50, ...body });
const model = (provider_key, model_key, cost, metadata = {}) => h.registry.upsertModel({ provider_key, model_key, status: 'active', cost, metadata, supports: { streaming: true } });

t.test('boot with a seam provider and a fallback', async () => {
    seam = await seamServer(() => ({ text: 'answered', model: 'seam-model', usage: { input: 4, output: 2 } }));
    slowSeam = await seamServer(() => new Promise((resolve) => { release = () => resolve({ text: 'slow answer', model: 'seam-model', usage: { input: 4, output: 2 } }); }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false' } });
    await provider({ key: 'fallback-open', base_url: seam.url, timeout_ms: 5000, metadata: {
        data_policy: { trains: false, training: false, retention: 'none' }, privacy: { label: 'private', wording: 'keeps nothing, trains on nothing', checked: '2026-11-10' },
    } });
    await model('fallback-open', 'm', { in_per_mtok: 1, out_per_mtok: 1 });
});

t.test('a background-only provider never answers an interactive request, and answers a background one', async () => {
    await provider({ key: 'slowpool', base_url: seam.url, timeout_ms: 5000, metadata: { traits: { latency_classes: ['background', 'batch'], source: 'https://example.test/terms', checked: '2026-11-10' } } });
    await model('slowpool', 'm', { in_per_mtok: 0, out_per_mtok: 0 });
    const route = { key: 'wave-latency', primary: { provider: 'slowpool', model: 'm' }, fallbacks: [{ provider: 'fallback-open', model: 'm' }] };
    const interactive = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 });
    assert.strictEqual(interactive.provider, 'fallback-open', 'the interactive request skips the background-only offer');
    assert.ok(interactive.explain.candidates.some((c) => c.provider === 'slowpool' && /latency_class/.test(c.excluded_reason || '')), 'the reason is named');
    const background = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 }, { latencyClass: 'background' });
    assert.strictEqual(background.provider, 'slowpool', 'a run that may wait uses it');
});

t.test('a provider that trains on prompts never receives a person\'s private data', async () => {
    await provider({ key: 'trainer', base_url: seam.url, timeout_ms: 5000, metadata: { data_policy: { trains: true, retention: 'standard' }, traits: { source: 'https://example.test/privacy', checked: '2026-11-10' } } });
    await model('trainer', 'm', { in_per_mtok: 0, out_per_mtok: 0 });
    const route = { key: 'wave-private', primary: { provider: 'trainer', model: 'm' }, fallbacks: [{ provider: 'fallback-open', model: 'm' }] };
    const privateRun = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'my private note' }], maxTokens: 5 },
        { presetPolicy: { data_policy: 'private' }, presetName: 'private' });
    assert.strictEqual(privateRun.provider, 'fallback-open', 'the private request never reaches the trainer');
    assert.ok(privateRun.explain.candidates.some((c) => c.provider === 'trainer' && /private|train/i.test(c.excluded_reason || '')), 'the reason is named');
    const ordinary = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'a public question' }], maxTokens: 5 });
    assert.strictEqual(ordinary.provider, 'trainer', 'work not marked private may use it');
});

t.test('a concurrency cap skips to the next offer, never errors', async () => {
    await provider({ key: 'one-at-a-time', base_url: slowSeam.url, timeout_ms: 10000, metadata: { traits: { concurrency: 1, source: 'https://example.test/limits', checked: '2026-11-10' } } });
    await model('one-at-a-time', 'm', { in_per_mtok: 0, out_per_mtok: 0 });
    const route = { key: 'wave-cap', primary: { provider: 'one-at-a-time', model: 'm' }, fallbacks: [{ provider: 'fallback-open', model: 'm' }] };
    const first = h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'first' }], maxTokens: 5 });
    await new Promise((r) => setTimeout(r, 120));
    const second = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'second' }], maxTokens: 5 });
    assert.strictEqual(second.provider, 'fallback-open', 'the second request skips the busy provider');
    assert.ok(second.explain.attempts.some((a) => a.provider === 'one-at-a-time' && /concurrency_cap/.test(a.error || '')), 'the cap is named');
    release();
    const done = await first;
    assert.strictEqual(done.provider, 'one-at-a-time', 'the first call still finishes on the provider');
});

t.test('a free allowance leads while it lasts, and stops at its end date', async () => {
    await provider({ key: 'free-pool', base_url: seam.url, timeout_ms: 5000, metadata: { traits: { free_only: true, free_allowance: { tokens: 1000, period: 'month', ends_at: '2026-11-24T08:00:00Z' }, source: 'https://example.test/free', checked: '2026-11-10' } } });
    await model('free-pool', 'm', { in_per_mtok: 9, out_per_mtok: 9 });
    const route = { key: 'wave-free', capability: 'chat', primary: { provider: 'fallback-open', model: 'm' }, fallbacks: [] };
    const run = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'use the free tokens first' }], maxTokens: 5 });
    assert.strictEqual(run.provider, 'free-pool', 'the free allowance is spent before the cheaper-looking paid price');
    // Spend the allowance: the same offer is skipped.
    const day = new Date().toISOString().slice(0, 10);
    await h.db.prepare(`INSERT INTO usage_daily (day, requester, attribution, workflow_key, provider_key, model_key, requests, tokens_in, tokens_out, cost_usd) VALUES (?, 'service:test', '', 'test', 'free-pool', 'm', 1, 900, 200, 0)`).run(day);
    const spent = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'again' }], maxTokens: 5 });
    assert.strictEqual(spent.provider, 'fallback-open', 'a spent free-only allowance is not called');
});

t.test('an uncensored offer (Sable) answers only the 18+ policy, never a standard request', async () => {
    const sable = PROVIDERS.find((p) => p.key === 'sable');
    await provider({ key: 'sable', base_url: seam.url, timeout_ms: 5000, metadata: seed.recordOf(sable).metadata });
    await model('sable', sable.models[0].model_key, { in_per_mtok: 0.15, out_per_mtok: 0.6, cached_per_mtok: 0.01 }, { uncensored: true, data_policy: sable.data_policy, privacy: sable.privacy });
    const route = { key: 'wave-uncensored', capability: 'chat', primary: { provider: 'fallback-open', model: 'm' }, fallbacks: [] };
    const standard = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'hello' }], maxTokens: 5 });
    assert.strictEqual(standard.provider, 'fallback-open', 'a standard request never runs the uncensored offer');
    // The 18+ gate has no adult status here: an uncensored request is refused before any call.
    await assert.rejects(
        () => h.pool.execute({ ...route, key: 'wave-adult' }, 'chat', { messages: [{ role: 'user', content: 'hello' }], maxTokens: 5 }, { contentPolicy: 'uncensored' }),
        (err) => [400, 403, 503].includes(err.status),
        'an uncensored request without the 18+ floor is refused',
    );
});

t.test('a caller may name its data policy, and a bad one is refused', async () => {
    const bad = await request(h.base, 'POST', '/api/v1/generate', { tok: token('svc', ALL), body: { prompt: 'hi', options: { data_policy: 'nonsense' } } });
    assert.strictEqual(bad.status, 422, bad.text);
});

t.run(() => h && h.stop());
