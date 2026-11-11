'use strict';
const assert = require('assert');
const { boot, request, token, suite } = require('./helpers');
const { enrichment } = require('../server/providers/model-sync');
const t = suite('provider-model-sync');
const owner = token('exchange', ['ai.provider.manage', 'ai.usage.read']);
const denied = token('chat', ['ai.run.read']);
const secret = 'synthetic-provider-sync-key-not-real';
let time = Date.now();
let listing = [{ id: 'alpha', context_length: 2048 }, { id: 'beta', pricing: { prompt: '0.000001', completion: '0.000002' } }];
let fault = null;
let malformed = false;
let waitFor = null;
let h;
const calls = [];
const logs = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function fetchImpl(input, init = {}) {
    const url = String(input); calls.push(url);
    if (url !== 'https://models.example/catalog') assert.ok(!JSON.stringify(init).includes(secret), 'public metadata never receives the provider key');
    if (url === 'https://models.dev/api.json') return json({ 'sync-test': { api: 'https://models.example/v1', models: {
        alpha: { id: 'alpha', limit: { context: 8192, output: 1024 }, cost: { input: 0.1, output: 0.2 }, tool_call: true },
    } } });
    if (url === 'https://openrouter.ai/api/v1/models') return json({ data: [{ id: 'gamma', context_length: 4096, pricing: { prompt: '0.000099', completion: '0.000099' } }] });
    if (url === 'https://models.example/catalog') {
        assert.strictEqual(init.headers.Authorization, `Bearer ${secret}`);
        if (waitFor) await waitFor;
        if (fault) return json({ error: { message: secret } }, fault);
        if (malformed) return json({ message: 'temporarily unavailable' });
        return json({ data: listing });
    }
    return json({}, 404);
}
const api = (method, path, body, tok = owner) => request(h.base, method, path, { tok, body });
const prefix = '/api/v1/admin/console/providers/sync-test';
const ownCalls = () => calls.filter(u => u === 'https://models.example/catalog').length;

t.test('boot and sync the registered endpoint into the existing model table, off by default', async () => {
    h = await boot({ env: { SYNC_KEY: secret, AI_USER_MODULES: 'off' }, clock: { now: () => time }, fetchImpl,
        log: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) } });
    await h.registry.upsertProvider({ key: 'sync-test', kind: 'openai', status: 'active', base_url: 'https://models.example/v1', auth_mode: 'bearer', secret_ref: 'env:SYNC_KEY', capabilities: ['chat'],
        metadata: { models_endpoint: 'https://models.example/catalog' } });
    const r = await api('POST', prefix + '/sync');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.added, ['alpha', 'beta']);
    const events = await api('GET', '/api/v1/exchange/model-events');
    assert.strictEqual(events.status, 200, events.text);
    assert.deepStrictEqual(events.body.events.filter(e => e.provider === 'sync-test').map(e => [e.type, e.model]),
        [['model.added', 'alpha'], ['model.added', 'beta']]);
    const alpha = await h.registry.getModel('sync-test', 'alpha');
    assert.strictEqual(alpha.status, 'disabled');
    assert.strictEqual(alpha.context_window, 2048, 'the provider context wins');
    assert.strictEqual(alpha.max_output, 1024, 'missing context fields come from the existing metadata cache');
    assert.strictEqual(alpha.cost.in_per_mtok, 0.1);
    assert.strictEqual(alpha.cost.source, 'https://models.dev/api.json');
    assert.strictEqual((await h.registry.getModel('sync-test', 'beta')).cost.out_per_mtok, 2);
    const page = await api('GET', '/api/v1/admin/console/models?provider=sync-test');
    assert.strictEqual(page.body.models[0].provider, 'sync-test');
    assert.strictEqual(page.body.models[0].model, 'alpha');
    assert.strictEqual(page.body.sync_log[0].status, 'succeeded');
    assert.ok(!page.text.includes(secret));
});

t.test('owner names, prices and tiers survive; automatic listing never enables uncensored models', async () => {
    assert.strictEqual((await api('POST', prefix + '/model-settings', { auto_list_new_models: true, model_sync_interval_minutes: 60 })).status, 200);
    const edit = await api('PATCH', '/api/v1/models/sync-test/alpha', { display_name: 'Owner alpha', content_tier: 'uncensored', status: 'disabled', owner_override: { reason: 'agreed', cost: { in_per_mtok: 0.4 } } });
    assert.strictEqual(edit.status, 200, edit.text);
    listing = [...listing, { id: 'gamma' }, { id: 'delta-uncensored' }, { id: 'video-model' }];
    const r = await api('POST', prefix + '/sync');
    assert.strictEqual(r.status, 200, r.text);
    const alpha = await h.registry.getModel('sync-test', 'alpha');
    assert.strictEqual(alpha.display_name, 'Owner alpha');
    assert.strictEqual(alpha.status, 'disabled');
    assert.strictEqual(alpha.metadata.min_age, 18);
    assert.strictEqual(alpha.metadata.owner_override.cost.in_per_mtok, 0.4);
    assert.strictEqual(alpha.cost.in_per_mtok, 0.1);
    const gamma = await h.registry.getModel('sync-test', 'gamma');
    assert.strictEqual(gamma.status, 'active');
    assert.strictEqual(gamma.context_window, 4096);
    assert.strictEqual(gamma.cost.in_per_mtok, null, 'another reseller price is not this provider cost');
    const adult = await h.registry.getModel('sync-test', 'delta-uncensored');
    assert.strictEqual(adult.status, 'disabled');
    assert.strictEqual(adult.metadata.min_age, 18);
    assert.strictEqual((await h.registry.getModel('sync-test', 'video-model')).type, 'video');
    assert.strictEqual((await api('PATCH', '/api/v1/models/sync-test/delta-uncensored', { content_tier: 'standard' })).status, 422);
});

t.test('removed models are retained disabled; a reappearing model still needs an owner enable', async () => {
    listing = listing.filter(m => m.id !== 'gamma');
    assert.strictEqual((await api('POST', prefix + '/sync')).status, 200);
    const gone = await h.registry.getModel('sync-test', 'gamma');
    assert.strictEqual(gone.status, 'disabled');
    assert.ok(gone.metadata.missing_since);
    const retired = await api('GET', '/api/v1/exchange/model-events');
    assert.ok(retired.body.events.some(e => e.type === 'model.retired' && e.provider === 'sync-test' && e.model === 'gamma'));
    assert.strictEqual((await api('PATCH', '/api/v1/models/sync-test/gamma', { status: 'active' })).status, 409);
    listing.push({ id: 'gamma' });
    assert.strictEqual((await api('POST', prefix + '/sync')).status, 200);
    const back = await h.registry.getModel('sync-test', 'gamma');
    assert.strictEqual(back.status, 'disabled');
    assert.strictEqual(back.metadata.missing_since, undefined);
});

t.test('provider failures are logged without upstream text and do not retire models', async () => {
    fault = 401;
    const r = await api('POST', prefix + '/sync');
    assert.strictEqual(r.status, 401, r.text);
    const log = await api('GET', '/api/v1/admin/console/sync');
    assert.strictEqual(log.body.sync_log[0].error_code, 'provider.auth');
    assert.ok(!log.text.includes(secret) && !logs.join('\n').includes(secret));
    assert.strictEqual((await h.registry.getModel('sync-test', 'gamma')).metadata.listed, true);
    fault = null;
});

t.test('schedules are due-based, skip disabled providers and reuse cached public metadata', async () => {
    const before = ownCalls();
    time += 60 * 60_000;
    await h.modelSync.tick();
    assert.strictEqual(ownCalls(), before + 1);
    await h.modelSync.tick();
    assert.strictEqual(ownCalls(), before + 1);
    assert.strictEqual(calls.filter(u => u === 'https://models.dev/api.json').length, 1);
    assert.strictEqual(calls.filter(u => u === 'https://openrouter.ai/api/v1/models').length, 1);
    await h.registry.upsertProvider({ key: 'sync-test', status: 'disabled' });
    time += 60 * 60_000;
    await h.modelSync.tick();
    assert.strictEqual(ownCalls(), before + 1);
});

t.test('a malformed successful response never marks every model gone', async () => {
    malformed = true;
    const r = await api('POST', prefix + '/sync');
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.body.code, 'provider.catalog_invalid');
    assert.strictEqual((await h.registry.getModel('sync-test', 'gamma')).metadata.listed, true);
    malformed = false;
});

t.test('concurrent syncs of the same provider cannot overlap', async () => {
    let release;
    waitFor = new Promise(resolve => { release = resolve; });
    const first = h.modelSync.run('sync-test');
    assert.throws(() => h.modelSync.run('sync-test'), err => err.code === 'provider.sync_running');
    release(); await first; waitFor = null;
});

t.test('sync and preferences require the existing provider-manage gate', async () => {
    for (const suffix of ['/sync', '/model-settings']) assert.strictEqual((await api('POST', prefix + suffix, {}, denied)).status, 403);
    assert.strictEqual((await api('POST', prefix + '/model-settings', { auto_list_new_models: true, model_sync_interval_minutes: 1 })).status, 422);
});

t.test('boot-time provider seeds preserve owner names and content tiers too', async () => {
    const { seed } = require('../server/workflows/seed');
    const options = { registry: h.registry, quotas: h.quotas, config: h.config, env: h.env, db: h.db };
    await h.registry.upsertProvider({ key: 'deepseek', status: 'active' }, { origin: 'admin' });
    await seed(options);
    const qwen = require('../server/providers/pool-providers').byKey.get('qwen').models[0].model_key;
    for (const [provider, model] of [['deepseek', 'deepseek-flash'], ['qwen', qwen]]) {
        const r = await api('PATCH', `/api/v1/models/${provider}/${encodeURIComponent(model)}`, { display_name: 'Owner label', content_tier: 'uncensored', owner_override: { reason: 'owner rate', cost: { in_per_mtok: 2 } } });
        assert.strictEqual(r.status, 200, r.text);
    }
    await seed(options);
    for (const [provider, model] of [['deepseek', 'deepseek-flash'], ['qwen', qwen]]) {
        const row = await h.registry.getModel(provider, model);
        assert.strictEqual(row.display_name, 'Owner label');
        assert.strictEqual(row.metadata.uncensored, true);
        assert.strictEqual(row.metadata.min_age, 18);
        assert.strictEqual(row.metadata.owner_override.cost.in_per_mtok, 2);
    }
});

t.test('pinned routes skip disabled and gone models and keep the reason on the receipt', async () => {
    for (const key of ['sync-first', 'sync-next']) {
        await h.registry.upsertProvider({ key, kind: 'stub', status: 'active', auth_mode: 'none', capabilities: ['chat'], default_model: 'm' });
        await h.registry.upsertModel({ provider_key: key, model_key: 'm', status: 'active' });
    }
    const route = { key: 'sync-fallback', primary: { provider: 'sync-first', model: 'm' }, fallbacks: [{ provider: 'sync-next', model: 'm' }] };
    const run = () => h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'hello' }], maxTokens: 20 });
    const first = await run();
    assert.strictEqual(first.provider, 'sync-first');
    await h.registry.upsertModel({ provider_key: 'sync-first', model_key: 'm', status: 'disabled' });
    const disabled = await run();
    assert.strictEqual(disabled.provider, 'sync-next');
    assert.ok(disabled.explain.attempts.some(a => a.provider === 'sync-first' && a.error === 'model_disabled'));
    await h.registry.upsertModel({ provider_key: 'sync-first', model_key: 'm', status: 'active', metadata: { missing_since: new Date(time).toISOString() } });
    const gone = await run();
    assert.strictEqual(gone.provider, 'sync-next');
    assert.ok(gone.explain.attempts.some(a => a.provider === 'sync-first' && a.error === 'model_gone'));
});

t.test('metadata prices use a matching provider, preserve zero and refuse stale price data', () => {
    const dev = { entries: [{ provider: 'other', id: 'm', model: { cost: { input: 99 } } }, { provider: 'p', id: 'm', model: { cost: { input: 0 } } }], source: 'https://models.dev/api.json', checked_at: new Date(time).toISOString(), stale: false };
    const router = { entries: [], stale: true };
    assert.strictEqual(enrichment({ key: 'p' }, dev, router)('m').cost.in_per_mtok, 0);
    assert.strictEqual(enrichment({ key: 'p' }, { ...dev, stale: true }, router)('m').cost, null);
});

t.run(() => h && h.stop());
