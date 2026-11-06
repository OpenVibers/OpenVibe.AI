'use strict';
/**
 * The ten managed providers OpenVibe buys capacity from (the Exchange remake, stage 2).
 *
 * No test reaches the network: every provider's recorded Chat Completions shape lives in
 * test/fixtures/pool-providers.json and is replayed against a local seam. What this proves:
 *
 *   - the catalogue is the providers' own pages: a price carries its page and the day it was read, a price
 *     nobody publishes stays null, the quantization stays null unless a provider states it, and the refusal
 *     rate stays null;
 *   - the privacy label says `private` only where the provider's own terms say it keeps nothing and trains on
 *     nothing, and `anonymized` everywhere else;
 *   - every offer is off until its key exists (the pool skips it `no_credentials`);
 *   - the OpenAI adapter reads all ten, tool calls included;
 *   - a provider that says the account has no money left is named `exhausted`.
 */
const assert = require('assert');
const fixtures = require('./fixtures/pool-providers.json');
const { suite, seamServer, boot, request, token, ALL } = require('./helpers');
const pool = require('../server/providers/pool-providers');
const seed = require('../server/providers/pool-seed');
const { createProviderPool } = require('../server/providers');
const { createOpenAiProvider } = require('../server/providers/openai');
const { exhaustedCode, retryable } = require('../server/providers/common');

const t = suite('ai-provider-adapters');

/** The provider's own domain: a price or a policy may only be read from the provider's own pages. */
const DOMAIN = {
    qwen: 'alibabacloud.com', kimi: 'kimi.ai', glm: 'z.ai', minimax: 'minimax.io', deepinfra: 'deepinfra.com',
    novita: 'novita.ai', featherless: 'featherless.ai', refuseless: 'refuseless.com', abliteration: 'abliteration.ai',
    openrouter: 'openrouter.ai',
};
const onItsOwnSite = (url, key) => {
    const host = new URL(url).hostname;
    return host === DOMAIN[key] || host.endsWith(`.${DOMAIN[key]}`);
};
const noop = { get: async () => undefined, run: async () => ({}), all: async () => [] };
const iso = (n) => new Date(n).toISOString();
const CHAT = { messages: [{ role: 'user', content: 'x' }], timeoutMs: 3000 };

t.test('ten providers, each OpenAI-compatible, with a base URL, a timeout, an access mode and a privacy label', () => {
    assert.deepStrictEqual(pool.PROVIDERS.map((p) => p.key),
        ['qwen', 'kimi', 'glm', 'minimax', 'deepinfra', 'novita', 'featherless', 'refuseless', 'abliteration', 'openrouter']);
    assert.deepStrictEqual(pool.PROVIDER_KEYS, pool.PROVIDERS.map((p) => p.key));
    for (const p of pool.PROVIDERS) {
        assert.ok(/^https:\/\//.test(p.base_url), `${p.key} base_url`);
        assert.ok(p.timeout_ms >= 1000, `${p.key} timeout`);
        assert.ok(['OWN_DEPLOYMENT', 'AUTHORIZED_WHOLESALE', 'CUSTOMER_BYOK', 'RESTRICTED', 'UNVERIFIED'].includes(p.provider_access), p.key);
        assert.ok(p.data_policy && typeof p.data_policy.trains_on_prompts === 'string', `${p.key} data policy`);
        assert.ok(p.data_policy.terms_url && p.data_policy.checked, `${p.key} terms + checked`);
        assert.ok(['private', 'anonymized'].includes(p.privacy.label), `${p.key} privacy label`);
        assert.ok(p.privacy.terms_url && p.privacy.wording && p.privacy.checked, `${p.key} privacy page + wording + day`);
        assert.ok(onItsOwnSite(p.privacy.terms_url, p.key), `${p.key} privacy page is its own`);
    }
    // `private` only where the provider's own terms say it keeps nothing AND trains on nothing. Featherless says
    // the prompts are not stored but never says they are not trained on, so it stays anonymized.
    const priv = pool.PROVIDERS.filter((p) => p.privacy.label === 'private').map((p) => p.key);
    assert.deepStrictEqual(priv, ['deepinfra', 'abliteration']);
    for (const key of priv) {
        const w = pool.byKey.get(key).privacy.wording.toLowerCase();
        assert.ok(w.includes('train') && w.includes('stor'), `${key} says what it does with a prompt`);
    }
    assert.ok(/not (collect or )?store/.test(pool.byKey.get('featherless').privacy.wording.toLowerCase()), 'Featherless says what it keeps');
    // The commercial gate: only Featherless may serve managed paid routes, and only with an agreement.
    assert.strictEqual(pool.byKey.get('featherless').provider_access, 'AUTHORIZED_WHOLESALE');
    assert.strictEqual(pool.byKey.get('deepinfra').provider_access, 'RESTRICTED');
    assert.ok(['qwen', 'kimi', 'glm', 'minimax', 'novita', 'refuseless', 'abliteration', 'openrouter']
        .every((k) => pool.byKey.get(k).provider_access === 'UNVERIFIED'), 'the rest stay unverified');
});

t.test('every price comes from the provider\'s own page, with the day it was read', () => {
    for (const p of pool.PROVIDERS) {
        for (const m of p.models) {
            assert.ok(m.source && m.checked, `${p.key}/${m.model_key} price page + day`);
            assert.ok(onItsOwnSite(m.source, p.key), `${p.key}/${m.model_key} price page is its own`);
            assert.strictEqual(m.checked, pool.CHECKED, `${p.key}/${m.model_key} price day`);
            for (const f of ['in_per_mtok', 'out_per_mtok', 'cached_per_mtok']) {
                assert.ok(m.cost[f] === null || (Number.isFinite(m.cost[f]) && m.cost[f] >= 0), `${p.key}/${m.model_key} ${f}`);
            }
            assert.ok(m.supports && m.supports.streaming === true, `${p.key}/${m.model_key} streaming`);
            // The quantization is what the provider states; none of the ten states it, so it stays null.
            assert.ok(m.quantization === null || typeof m.quantization === 'string', `${p.key}/${m.model_key} quantization`);
            // The refusal rate stays null until a provider publishes one or a measurement job owns it.
            assert.strictEqual(m.refusal_rate, null, `${p.key}/${m.model_key} refusal rate`);
        }
    }
    // A price nobody publishes is null, never a guess: Refuseless publishes none.
    for (const m of pool.byKey.get('refuseless').models) {
        assert.strictEqual(m.cost.in_per_mtok, null, `refuseless/${m.model_key} input price`);
        assert.strictEqual(m.cost.out_per_mtok, null, `refuseless/${m.model_key} output price`);
    }
    // Abliteration.ai publishes its prices, cache reads included (10% of the input price).
    const abl = pool.priceOf('abliteration', 'abliterated-model-large-flash');
    assert.deepStrictEqual([abl.cost.in_per_mtok, abl.cost.cached_per_mtok, abl.cost.out_per_mtok], [1.00, 0.10, 2.00]);
    // Refuseless and Abliteration.ai are the uncensored tier; a standard model is not.
    assert.strictEqual(pool.byKey.get('refuseless').uncensored, true);
    assert.strictEqual(pool.byKey.get('abliteration').uncensored, true);
    assert.strictEqual(pool.isUncensored(pool.byKey.get('qwen'), null), false);
    assert.strictEqual(pool.isUncensored(pool.byKey.get('featherless'), { model_key: 'some/Model-32B-abliterated' }), true);
});

t.test('the seed writes the privacy label, the quantization and the refusal rate into the registry', async () => {
    const saved = new Map();
    const models = new Map();
    const registry = {
        getProvider: async (key) => saved.get(key) || null,
        upsertProvider: async (row) => { saved.set(row.key, { ...row, metadata: row.metadata || {} }); },
        getModel: async (p, m) => models.get(`${p}/${m}`) || null,
        upsertModel: async (row) => { models.set(`${row.provider_key}/${row.model_key}`, row); },
    };
    const out = await seed.seedPoolProviders({ registry });
    assert.strictEqual(out.providers.length, 10);
    assert.strictEqual(saved.get('refuseless').secret_ref, 'vault:refuseless');
    assert.strictEqual(saved.get('abliteration').secret_ref, 'vault:abliteration');
    assert.strictEqual(saved.get('deepinfra').metadata.privacy.label, 'private');
    assert.strictEqual(saved.get('qwen').metadata.privacy.label, 'anonymized');
    assert.strictEqual(models.get('refuseless/deepseek-v4.1-flash-abliterated').metadata.refusal_rate, null);
    assert.strictEqual(models.get('refuseless/deepseek-v4.1-flash-abliterated').metadata.quantization, null);
    assert.strictEqual(models.get('refuseless/deepseek-v4.1-flash-abliterated').cost.in_per_mtok, null);
    assert.strictEqual(models.get('abliteration/abliterated-model').cost.in_per_mtok, 1.00);
    assert.strictEqual(models.get('abliteration/abliterated-model').metadata.privacy.label, 'private');
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

t.test('a catalogue offer with no key is skipped no_credentials: the offer is off until its key exists', async () => {
    const row = { ...seed.recordOf(pool.byKey.get('refuseless')), origin: 'catalog' };
    const registry = {
        getProvider: async (k) => (k === 'refuseless' ? row : null),
        listProviders: async () => [row],
        listModels: async () => [],
        getModel: async () => null,
        audit: async () => {},
    };
    const config = {
        breaker: { failureThreshold: 3, cooldownMs: 1000 }, providerRetries: 0, retryDelayMs: 1, stubFallback: false,
        placement: { minGain: 0, costWeight: 1, latencyWeight: 1 }, pricing: { table: {}, inputPerMtok: 0.5, outputPerMtok: 1.5 },
    };
    const p = createProviderPool({ db: { prepare: () => noop }, registry, config, env: {} });
    const route = { key: 'test.no-key', primary: { provider: 'refuseless', model: null }, fallbacks: [], timeout_ms: 3000 };
    const logs = [];
    await assert.rejects(
        p.execute(route, 'chat', CHAT, { routeKey: route.key, logRequest: (e) => logs.push(e) }),
        (err) => err.status === 503 && err.code === 'provider.unavailable' && JSON.stringify(err.extra.tried).includes('no_credentials'),
        'an offer with no key cannot answer');
    assert.ok(logs.some((e) => e.status === 'skipped' && e.skip_reason === 'no_credentials'), 'the attempt is logged as a credential skip');
});

t.test('a provider that says the account has no money left is exhausted', async () => {
    const recorded = fixtures.exhausted.refuseless;
    assert.strictEqual(exhaustedCode(recorded.status, recorded.body), 'provider.exhausted');
    assert.strictEqual(exhaustedCode(402, null), 'provider.exhausted');
    assert.strictEqual(exhaustedCode(429, { error: { code: 'model_busy', message: 'Model is busy. Retry shortly.' } }), null, 'a busy model is not an empty account');
    assert.strictEqual(exhaustedCode(429, { error: { message: 'Insufficient quota' } }), 'provider.exhausted');
    assert.strictEqual(exhaustedCode(500, { error: { message: 'the backend fell over' } }), null);
    // An empty account is not a transient failure: trying again costs the same nothing.
    assert.strictEqual(retryable({ code: 'provider.exhausted', status: 402 }), false);

    // The adapter names the state the provider answered in.
    const srv = await seamServer(() => ({ status: recorded.status, body: recorded.body }));
    try {
        const a = createOpenAiProvider({ key: 'refuseless', base_url: srv.url, capabilities: [] }, { apiKey: 'k' });
        await assert.rejects(
            a.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, timeoutMs: 3000, model: 'deepseek-v4.1-flash-abliterated' }),
            (err) => err.code === 'provider.exhausted' && err.status === 402,
            'Refuseless\'s own 402 is exhausted');

        // And the pool carries the code with the failure, so the empty-failover job can read it.
        const providers = { empty: { key: 'empty', kind: 'openai', status: 'active', auth_mode: 'none', secret_ref: null, default_model: 'm', capabilities: ['chat'], timeout_ms: 30000, priority: 10, updated_at: iso(0), billing_profile: 'metered', metadata: {}, base_url: srv.url } };
        const registry = {
            getProvider: async (k) => providers[k] || null,
            listProviders: async () => Object.values(providers),
            listModels: async () => [],
            getModel: async () => null,
            audit: async () => {},
        };
        const config = {
            breaker: { failureThreshold: 3, cooldownMs: 1000 }, providerRetries: 0, retryDelayMs: 1, stubFallback: false,
            placement: { minGain: 0, costWeight: 1, latencyWeight: 1 }, pricing: { table: {}, inputPerMtok: 0.5, outputPerMtok: 1.5 },
        };
        const p = createProviderPool({ db: { prepare: () => noop }, registry, config, env: {} });
        const route = { key: 'test.exhausted', primary: { provider: 'empty', model: null }, fallbacks: [], timeout_ms: 3000 };
        await assert.rejects(
            p.execute(route, 'chat', CHAT, { routeKey: route.key }),
            (err) => err.status === 503 && err.code === 'provider.unavailable'
                && err.extra.tried.some((x) => x.code === 'provider.exhausted'),
            'the pool reports the exhausted state');
    } finally { await srv.close(); }
});

t.test('a booted service seeds the ten offers, each with its own key slot', async () => {
    const h = await boot({ env: { AI_STUB_FALLBACK: 'true' } });
    try {
        const rows = await h.registry.listProviders();
        for (const p of pool.PROVIDERS) {
            const row = rows.find((x) => x.key === p.key);
            assert.ok(row, `${p.key} seeded`);
            assert.strictEqual(row.secret_ref, `vault:${p.key}`, `${p.key} key slot`);
            assert.ok(row.metadata && row.metadata.catalog === 'pool-providers', `${p.key} catalogue row`);
            assert.strictEqual(row.metadata.privacy.label, p.privacy.label, `${p.key} privacy label`);
        }
        // The key is not there yet, so the offer cannot answer: the pool skips it.
        const chat = await h.pool.candidates({ key: 'test.seeded', capability: 'chat', constraints: { objective: 'cheapest' }, pinned: [], fallbacks: [] }, ['chat'], 'chat');
        assert.ok(!chat.order.some((c) => c.provider === 'refuseless'), 'an offer with no key is not a candidate');
    } finally { await h.stop(); }
});

t.run();
