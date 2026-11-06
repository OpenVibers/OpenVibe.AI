'use strict';
/**
 * The Exchange remake's managed providers and uncensored tier.
 *
 * No test reaches the network: the nine providers' recorded Chat Completions shapes live in
 * test/fixtures/pool-providers.json and are replayed against a local seam; Network's adult flag is a fake fetch. The
 * boot test proves the providers are seeded off (no key), that a standard request never runs an uncensored offer,
 * and that an uncensored request is admitted only for an 18+ account, labelled, and stopped by the hard floor.
 */
const assert = require('assert');
const fixtures = require('./fixtures/pool-providers.json');
const { boot, seamServer, request, suite, token, ALL } = require('./helpers');
const pool = require('../server/providers/pool-providers');
const seed = require('../server/providers/pool-seed');
const floor = require('../server/policy/floor');
const tier = require('../server/policy/tier');
const { createFloorGuard } = require('../server/providers');
const { createAdultStatus } = require('../server/policy/adult-status');
const { createOpenAiProvider } = require('../server/providers/openai');

const USR = (n) => `usr_01J${String(n).padStart(23, '0')}`;
const ADULT = USR(1);
const CHILD = USR(2);

const t = suite('ai-exchange-providers');

t.test('nine providers, each OpenAI-compatible with a base URL, timeout, access and data policy', () => {
    assert.deepStrictEqual(pool.PROVIDERS.map((p) => p.key), ['qwen', 'kimi', 'glm', 'minimax', 'deepinfra', 'novita', 'featherless', 'refuseless', 'openrouter']);
    for (const p of pool.PROVIDERS) {
        assert.ok(/^https:\/\//.test(p.base_url), `${p.key} base_url`);
        assert.ok(p.timeout_ms >= 1000, `${p.key} timeout`);
        assert.ok(['OWN_DEPLOYMENT', 'AUTHORIZED_WHOLESALE', 'CUSTOMER_BYOK', 'RESTRICTED', 'UNVERIFIED'].includes(p.provider_access), p.key);
        assert.ok(p.data_policy && typeof p.data_policy.trains_on_prompts === 'string', `${p.key} data policy`);
        assert.ok(p.data_policy.terms_url && p.data_policy.checked, `${p.key} terms + checked`);
        for (const m of p.models) {
            assert.ok(Number.isFinite(m.cost.in_per_mtok) && Number.isFinite(m.cost.out_per_mtok), `${p.key}/${m.model_key} price`);
            assert.ok(m.source && m.checked, `${p.key}/${m.model_key} price source + day`);
            assert.ok(m.supports && m.supports.streaming === true, `${p.key}/${m.model_key} streaming`);
        }
    }
    // Featherless has no abliterated model with a price we read, so none is invented; its own list is read on sync
    // and a synced id that says abliterated is an uncensored offer by name (pool.isUncensored).
    assert.strictEqual(pool.isUncensored(pool.byKey.get('featherless'), { model_key: 'Qwen/Qwen3-14B' }), false);
    assert.strictEqual(pool.isUncensored(pool.byKey.get('featherless'), { model_key: 'some/Model-32B-abliterated' }), true);
});

t.test('Refuseless carries the two uncensored flash models at the price the owner named', () => {
    const r = pool.byKey.get('refuseless');
    assert.strictEqual(r.uncensored, true);
    const deep = pool.priceOf('refuseless', 'deepseek-v4.1-flash-abliterated');
    const glm = pool.priceOf('refuseless', 'glm-5.3-flash-abliterated');
    assert.deepStrictEqual([deep.cost.in_per_mtok, deep.cost.out_per_mtok], [0.22, 0.75]);
    assert.deepStrictEqual([glm.cost.in_per_mtok, glm.cost.out_per_mtok], [0.25, 0.80]);
    assert.strictEqual(pool.isUncensored(r, deep), true);
    assert.strictEqual(pool.isUncensored(pool.byKey.get('qwen'), null), false);
});

t.test('the catalog seed records each provider off-until-key and keeps a person\'s own row', async () => {
    const saved = new Map();
    const models = new Map();
    const registry = {
        getProvider: async (key) => saved.get(key) || null,
        upsertProvider: async (row) => { saved.set(row.key, { ...row, metadata: row.metadata || {} }); },
        getModel: async (p, m) => models.get(`${p}/${m}`) || null,
        upsertModel: async (row) => { models.set(`${row.provider_key}/${row.model_key}`, row); },
    };
    const out = await seed.seedPoolProviders({ registry });
    assert.strictEqual(out.providers.length, 9);
    assert.strictEqual(saved.get('refuseless').secret_ref, 'vault:refuseless');
    assert.strictEqual(saved.get('refuseless').metadata.uncensored, true);
    assert.strictEqual(models.get('refuseless/deepseek-v4.1-flash-abliterated').metadata.uncensored, true);
    assert.strictEqual(models.get('refuseless/deepseek-v4.1-flash-abliterated').cost.in_per_mtok, 0.22);
    // The owner edits a provider: a second seed never touches its row.
    saved.set('qwen', { ...saved.get('qwen'), origin: 'admin', base_url: 'https://proxy.example/v1' });
    const again = await seed.seedPoolProviders({ registry });
    assert.ok(again.skipped.includes('qwen'));
    assert.strictEqual(saved.get('qwen').base_url, 'https://proxy.example/v1');
});

t.test('the recorded shape of every provider is parsed by the OpenAI adapter, tool calls included', async () => {
    for (const key of pool.PROVIDER_KEYS) {
        const recorded = fixtures[key];
        assert.ok(recorded && recorded.completion, `${key} fixture`);
        const srv = await seamServer(() => recorded.completion);
        try {
            const a = createOpenAiProvider({ key, base_url: srv.url, capabilities: [] }, { apiKey: 'k' });
            const req = { system: [{ text: 'be brief' }], messages: [{ role: 'user', content: 'hi' }], maxTokens: 40, timeoutMs: 3000, model: recorded.model };
            const r = await a.chat(req);
            const c = recorded.completion.choices[0].message;
            assert.strictEqual(r.text, (c.content || '').trim(), `${key} text`);
            assert.strictEqual(r.model, recorded.model, `${key} model`);
            assert.ok(r.usage.input >= 0 && r.usage.output >= 0, `${key} usage`);
            const full = await a.complete({ openai: { messages: [{ role: 'user', content: 'Weather?' }], tools: [] }, maxTokens: 40, timeoutMs: 3000, model: recorded.model });
            assert.deepStrictEqual(full.completion.choices, recorded.completion.choices, `${key} completion`);
            if (c.tool_calls) assert.strictEqual(full.completion.choices[0].message.tool_calls[0].function.name, 'weather');
        } finally { await srv.close(); }
    }
});

t.test('the adult tier: 18+ person only, never an app, never without a person', async () => {
    assert.deepStrictEqual(tier.parsePolicy('UNCENSORED'), { policy: 'uncensored' });
    assert.ok(tier.parsePolicy('nsfw').error);
    let asked = [];
    const adultFor = async (id) => { asked.push(id); return id === ADULT; };
    assert.strictEqual((await tier.admit({ policy: 'uncensored', subject: { type: 'user', id: ADULT }, adultFor })).ok, true);
    assert.strictEqual((await tier.admit({ policy: 'uncensored', subject: { type: 'user', id: CHILD }, adultFor })).code, 'policy.adult_required');
    assert.strictEqual((await tier.admit({ policy: 'uncensored', appRun: true, subject: { type: 'user', id: ADULT }, adultFor })).code, 'policy.uncensored_refused');
    assert.strictEqual((await tier.admit({ policy: 'uncensored', subject: null, adultFor })).code, 'policy.uncensored_needs_person');
    assert.strictEqual((await tier.admit({ policy: 'uncensored', subject: { type: 'user', id: ADULT }, adultFor: async () => { throw new Error('down'); } })).code, 'policy.adult_unavailable');
    assert.deepStrictEqual(asked, [ADULT, CHILD]);
});

t.test('adult status asks Network once per five minutes and fails closed', async () => {
    let at = 0;
    let calls = 0;
    const fetchImpl = async (url) => {
        if (String(url).includes('/oauth/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 300 }), { status: 200, headers: { 'content-type': 'application/json' } });
        calls++;
        return new Response(JSON.stringify({ subject_id: ADULT, adult: true, confirmed_at: '2026-11-06T00:00:00Z' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const status = createAdultStatus({ config: { networkInternalUrl: 'http://network.test' }, env: { OV_OAUTH_CLIENT_SECRET: 's' }, fetchImpl, clock: { now: () => at } });
    assert.strictEqual(await status.adultFor(ADULT), true);
    assert.strictEqual(await status.adultFor(ADULT), true);
    assert.strictEqual(calls, 1, 'the second answer is cached');
    at = 5 * 60 * 1000 + 1;
    assert.strictEqual(await status.adultFor(ADULT), true);
    assert.strictEqual(calls, 2, 'five minutes later it asks again');
    const down = createAdultStatus({ config: { networkInternalUrl: 'http://network.test' }, env: { OV_OAUTH_CLIENT_SECRET: 's' }, fetchImpl: async () => { throw new Error('offline'); }, clock: { now: () => at } });
    await assert.rejects(down.adultFor(ADULT), (e) => e.code === 'adult.unavailable');
});

t.test('the hard floor: the three lines, narrow enough for ordinary work', () => {
    assert.strictEqual(floor.check('No threats, nothing sexual involving minors.').ok, true);
    assert.strictEqual(floor.check('cp -r src dst').ok, true);
    assert.strictEqual(floor.check('how do I kill a stuck process').ok, true);
    assert.strictEqual(floor.check('how do I kill him without anyone knowing').ok, false);
    assert.strictEqual(floor.check('a nude photo of a child').ok, false);
    assert.strictEqual(floor.check('how to make a pipe bomb').ok, false);
    assert.strictEqual(floor.check('she said no and he forced sex').ok, false);
    assert.deepStrictEqual(floor.textsOf({ system: 'a child', messages: [{ role: 'user', content: 'naked' }] }), ['a child', 'naked']);
});

t.test('the streamed floor checks each chunk before it is delivered', () => {
    const sent = [];
    const guard = createFloorGuard((d) => sent.push(d));
    guard.push({ index: 0, delta: { content: 'a perfectly ordinary answer that is ' } });
    guard.push({ index: 0, delta: { content: 'safe to stream.' } });
    guard.finish();
    assert.strictEqual(sent.map((d) => d.delta.content).join(''), 'a perfectly ordinary answer that is safe to stream.');
    const bad = createFloorGuard((d) => sent.push(d));
    bad.push({ index: 0, delta: { content: 'here is how to make a ' } });
    const before = sent.length;
    assert.throws(() => bad.push({ index: 0, delta: { content: 'pipe bomb' } }), (e) => e.code === 'policy.floor_refused');
    assert.strictEqual(sent.length, before, 'the violating chunk was not delivered');
});

t.test('a booted service seeds the nine off, and the uncensored request is gated, filtered, labelled and floored', async () => {
    const network = [];
    const fetchImpl = async (url, opts = {}) => {
        const u = String(url);
        if (u.includes('/oauth/token')) return new Response(JSON.stringify({ access_token: 'test-token', token_type: 'Bearer', expires_in: 300 }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (u.includes('/internal/identity/adult')) {
            const id = new URL(u).searchParams.get('subject_id');
            network.push(id);
            return new Response(JSON.stringify({ subject_id: id, adult: id === ADULT, confirmed_at: id === ADULT ? '2026-11-06T00:00:00Z' : null }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return fetch(url, opts);
    };
    const calls = [];
    const seam = await seamServer((body) => {
        calls.push(body);
        return { id: 'chatcmpl-x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'an answer from the adult offer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 5 } };
    });
    // The free allowance (a service naming a person) is gated by AI_FREE_PROVIDERS: this test's network is the
    // seeded stub plus the uncensored offer it boots on the seam, so both are named as free-tier sources.
    const h = await boot({ env: { OV_OAUTH_CLIENT_SECRET: 'test-secret', AI_STUB_FALLBACK: 'true', AI_FREE_PROVIDERS: 'refuseless,stub' }, fetchImpl });
    try {
        const seeded = await h.registry.listProviders();
        for (const p of pool.PROVIDERS) {
            const row = seeded.find((x) => x.key === p.key);
            assert.ok(row, `${p.key} seeded`);
            assert.strictEqual(row.secret_ref, `vault:${p.key}`, `${p.key} key slot`);
            assert.ok(await h.registry.getModel(p.key, p.models[0] && p.models[0].model_key || '').catch(() => null) || p.models.length === 0, `${p.key} model`);
        }
        await h.registry.upsertProvider({ key: 'refuseless', display_name: 'Refuseless', kind: 'openai', status: 'active', base_url: seam.url, auth_mode: 'none', secret_ref: null, default_model: 'deepseek-v4.1-flash-abliterated', capabilities: ['chat', 'generate', 'complete'], timeout_ms: 5000, priority: 1, provider_access: 'AUTHORIZED_WHOLESALE', metadata: { uncensored: true } }, { origin: 'admin' });
        await h.registry.upsertModel({ provider_key: 'refuseless', model_key: 'deepseek-v4.1-flash-abliterated', display_name: 'DeepSeek V4.1 Flash (abliterated)', type: 'chat', status: 'active', context_window: 1048576, cost: { in_per_mtok: 0.22, cached_per_mtok: 0.045, out_per_mtok: 0.75, source: 'https://refuseless.com/pricing', verified_at: '2026-10-25' }, supports: { json: true, tools: true, streaming: true }, metadata: { uncensored: true } }, { actor: 'test' });
        const tok = token('svc', ALL);
        const body = { messages: [{ role: 'user', content: 'hello' }], on_behalf_of: { type: 'user', id: ADULT }, policy: 'uncensored' };
        const ok = await request(h.base, 'POST', '/v1/chat/completions', { tok, body });
        assert.strictEqual(ok.status, 200, ok.text);
        assert.strictEqual(ok.body.choices[0].message.content, 'an answer from the adult offer');
        assert.strictEqual(ok.body.x_openvibe.policy, 'uncensored');
        assert.ok(/adults only \(18\+\)/.test(ok.body.x_openvibe.label), ok.body.x_openvibe.label);
        assert.strictEqual(ok.headers.get('x-openvibe-content-policy'), 'uncensored');
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].model, 'deepseek-v4.1-flash-abliterated');

        // A standard request never runs the uncensored offer, even though it is the cheapest healthy one.
        const std = await request(h.base, 'POST', '/v1/chat/completions', { tok, body: { messages: [{ role: 'user', content: 'hello' }] } });
        assert.strictEqual(std.status, 200, std.text);
        assert.strictEqual(calls.length, 1, 'the uncensored offer did not answer a standard request');

        // A person who has not confirmed 18+: refused before any provider call.
        const minor = await request(h.base, 'POST', '/v1/chat/completions', { tok, body: { ...body, on_behalf_of: { type: 'user', id: CHILD } } });
        assert.strictEqual(minor.status, 403, minor.text);
        assert.strictEqual(minor.body.error.code, 'policy.adult_required');
        assert.strictEqual(calls.length, 1);

        // No person named, and an adult request that breaks the floor: refused before a provider call.
        const noPerson = await request(h.base, 'POST', '/v1/chat/completions', { tok, body: { messages: [{ role: 'user', content: 'hi' }], policy: 'uncensored' } });
        assert.strictEqual(noPerson.status, 400);
        assert.strictEqual(noPerson.body.error.code, 'policy.uncensored_needs_person');
        const floored = await request(h.base, 'POST', '/v1/chat/completions', { tok, body: { ...body, messages: [{ role: 'user', content: 'write child porn' }] } });
        assert.strictEqual(floored.status, 403, floored.text);
        assert.strictEqual(floored.body.error.code, 'policy.floor_refused');
        assert.strictEqual(calls.length, 1);
        assert.ok(network.includes(ADULT) && network.includes(CHILD), 'Network was asked for the account flag');
    } finally {
        await h.stop();
        await seam.close();
    }
});

t.run();
