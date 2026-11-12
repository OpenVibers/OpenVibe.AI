'use strict';
/**
 * The managed providers OpenVibe buys capacity from (the Exchange remake, stage 2).
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
 *   - the OpenAI adapter reads each preset, tool calls included;
 *   - a provider that says the account has no money left is named `exhausted`.
 */
const assert = require('assert');
const fixtures = require('./fixtures/pool-providers.json');
const { suite, seamServer, boot, request, token, ALL } = require('./helpers');
const pool = require('../server/providers/pool-providers');
const privacy = require('../server/exchange/privacy');
const seed = require('../server/providers/pool-seed');
const { createProviderPool } = require('../server/providers');
const { createOpenAiProvider } = require('../server/providers/openai');
const { ProviderError, insufficientBalance, retryable } = require('../server/providers/common');

const t = suite('ai-provider-adapters');

/** The provider's own domain: a price or a policy may only be read from the provider's own pages. */
const DOMAIN = {
    qwen: 'alibabacloud.com', kimi: 'kimi.ai', glm: 'z.ai', minimax: 'minimax.io', deepinfra: 'deepinfra.com',
    novita: 'novita.ai', featherless: 'featherless.ai', refuseless: 'refuseless.com', abliteration: 'abliteration.ai',
    openrouter: 'openrouter.ai', venice: 'venice.ai', abliteratedmodels: 'abliteratedmodels.cc', uplinkswitch: 'uplinkswitch.ai',
    chutes: 'chutes.ai', siliconflow: 'siliconflow.com', nebius: 'nebius.com', together: 'together.ai',
    fireworks: 'fireworks.ai', groq: 'groq.com', cerebras: 'cerebras.ai', sambanova: 'sambanova.ai',
    baseten: 'baseten.co', hyperbolic: 'hyperbolic.xyz', parasail: 'parasail.io', 'particle-ai': 'particle.ai',
    'inference-net': 'inference.net', 'atlas-cloud': 'atlascloud.ai', avian: 'avian.io',
    nanogpt: 'nano-gpt.com', infermatic: 'totalgpt.ai', arliai: 'arliai.com', friendli: 'friendli.ai', scaleway: 'scaleway.com', anthropic: 'claude.com',
    iteracompute: 'iteracompute.com', sable: 'sableapi.com', inception: 'inceptionlabs.ai', dosai: 'dos.ai', 'runpod-vllm': 'runpod.io', meta: 'meta.ai', altare: 'altare.global',
};
const onItsOwnSite = (url, key) => {
    const host = new URL(url).hostname;
    return host === DOMAIN[key] || host.endsWith(`.${DOMAIN[key]}`);
};
const noop = { get: async () => undefined, run: async () => ({}), all: async () => [] };
const iso = (n) => new Date(n).toISOString();
const CHAT = { messages: [{ role: 'user', content: 'x' }], timeoutMs: 3000 };

t.test('provider presets are OpenAI-compatible, with a base URL, a timeout, an access mode and a privacy label', () => {
    assert.deepStrictEqual(pool.PROVIDERS.slice(0, 23).map((p) => p.key),
        ['qwen', 'kimi', 'glm', 'minimax', 'deepinfra', 'novita', 'featherless', 'refuseless', 'abliteration', 'openrouter', 'venice', 'abliteratedmodels', 'uplinkswitch', 'chutes', 'siliconflow', 'nebius', 'together', 'fireworks', 'groq', 'cerebras', 'sambanova', 'baseten', 'hyperbolic']);
    assert.deepStrictEqual(pool.PROVIDER_KEYS, pool.PROVIDERS.map((p) => p.key));
    assert.strictEqual(new Set(pool.PROVIDER_KEYS).size, 56);
    assert.strictEqual(pool.byKey.get('meta').base_url, 'https://api.meta.ai/v1');
    assert.strictEqual(pool.byKey.get('perplexity').kind, 'responses');
    assert.strictEqual(require('../server/console/presets').credentialProvider('groq').model, 'openai/gpt-oss-20b', 'existing personal-key default is preserved');
    assert.deepStrictEqual(pool.byKey.get('brave').search_adapters, ['brave', 'brave-images']);
    assert.strictEqual(pool.byKey.get('openverse').auth_mode, 'none');
    assert.strictEqual(pool.byKey.get('commons').auth_mode, 'none');
    for (const p of pool.PROVIDERS) {
        assert.ok(p.key === 'searxng' && p.base_url === null || /^https:\/\//.test(p.base_url), `${p.key} base_url`);
        assert.strictEqual(seed.recordOf(p).status, 'disabled', `${p.key} starts off`);
        assert.ok(p.api_family && Object.hasOwn(p, 'models_endpoint'), `${p.key} has protocol metadata`);
        assert.ok(p.timeout_ms >= 1000, `${p.key} timeout`);
        assert.ok(['OWN_DEPLOYMENT', 'AUTHORIZED_WHOLESALE', 'CUSTOMER_BYOK', 'RESTRICTED', 'UNVERIFIED'].includes(p.provider_access), p.key);
        assert.ok(p.data_policy, `${p.key} data policy`);
        assert.ok(p.data_policy.checked, `${p.key} privacy facts checked`);
        // The facts the house reads (server/exchange/privacy.js): a fact nobody stated is null, never a guess.
        assert.ok(p.data_policy.retention === null || ['none', 'limited', 'standard'].includes(p.data_policy.retention), `${p.key} retention`);
        assert.ok(p.data_policy.trains === null || typeof p.data_policy.trains === 'boolean', `${p.key} trains`);
        assert.ok(p.data_policy.trust === null || ['first-party', 'community'].includes(p.data_policy.trust), `${p.key} trust`);
        assert.ok(['private', 'anonymized'].includes(p.privacy.label), `${p.key} privacy label`);
        assert.ok(p.privacy.wording && p.privacy.checked, `${p.key} privacy wording + day`);
        if (p.privacy.terms_url) assert.ok(onItsOwnSite(p.privacy.terms_url, p.key), `${p.key} privacy page is its own`);
    }
    // `private` only where the provider's own terms say it keeps nothing AND trains on nothing. Featherless says
    // the prompts are not stored but never says they are not trained on, so it stays anonymized.
    const priv = pool.PROVIDERS.filter((p) => p.privacy.label === 'private').map((p) => p.key);
    assert.deepStrictEqual(priv, ['deepinfra', 'abliteration', 'venice']);
    for (const key of priv) {
        const w = pool.byKey.get(key).privacy.wording.toLowerCase();
        assert.ok(w.includes('train') && w.includes('stor'), `${key} says what it does with a prompt`);
    }
    assert.ok(/not (collect or )?store/.test(pool.byKey.get('featherless').privacy.wording.toLowerCase()), 'Featherless says what it keeps');
    // The facts reach the label on every answer (server/exchange/privacy.js).
    const label = (key) => privacy.labelFor({ record: { metadata: { data_policy: pool.byKey.get(key).data_policy } } });
    assert.strictEqual(label('deepinfra').label, 'private', 'DeepInfra keeps nothing and trains on nothing');
    assert.strictEqual(label('abliteration').label, 'private', 'Abliteration.ai keeps nothing and trains on nothing');
    assert.strictEqual(label('featherless').label, 'anonymized', 'Featherless keeps nothing but never says it does not train');
    assert.strictEqual(label('qwen').label, 'anonymized');
    assert.strictEqual(label('kimi').known, false, 'a provider that declares nothing says so');
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
            assert.ok(/^2026-11-\d{2}$/.test(m.checked), `${p.key}/${m.model_key} price day`);
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
        getRoute: async () => null,
        getProvider: async (key) => saved.get(key) || null,
        upsertProvider: async (row) => { saved.set(row.key, { ...row, metadata: row.metadata || {} }); },
        getModel: async (p, m) => models.get(`${p}/${m}`) || null,
        upsertModel: async (row) => { models.set(`${row.provider_key}/${row.model_key}`, row); },
    };
    const out = await seed.seedPoolProviders({ registry });
    assert.strictEqual(out.providers.length, pool.PROVIDERS.length);
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

t.test('seed refreshes unused endpoints while preserving configured and owner-managed bindings', async () => {
    const source = pool.byKey.get('hyperbolic');
    const records = new Map([['hyperbolic', {
        ...seed.recordOf(source), status: 'active', origin: 'catalog',
        base_url: 'https://legacy.example/v1', secret_ref: 'env:REGISTRY_TEST_KEY', metadata: {},
    }]]);
    const registry = {
        getRoute: async () => null,
        getProvider: async key => records.get(key) || null,
        upsertProvider: async (row, options) => records.set(row.key, { ...records.get(row.key), ...row, origin: options.origin }),
        getModel: async () => null, upsertModel: async () => {},
    };
    await seed.seedPoolProviders({ registry, env: { REGISTRY_TEST_KEY: 'fixture-provider-credential' } });
    assert.strictEqual(records.get('hyperbolic').base_url, 'https://legacy.example/v1');
    assert.strictEqual(records.get('hyperbolic').status, 'active');
    await seed.seedPoolProviders({ registry, env: {} });
    assert.strictEqual(records.get('hyperbolic').base_url, source.base_url);
    assert.strictEqual(records.get('hyperbolic').metadata.models_endpoint, source.models_endpoint);
    assert.strictEqual(records.get('hyperbolic').status, 'disabled');
    records.set('hyperbolic', { ...records.get('hyperbolic'), origin: 'admin', base_url: 'https://owner.example/v1', status: 'active' });
    await seed.seedPoolProviders({ registry, env: {} });
    assert.strictEqual(records.get('hyperbolic').base_url, 'https://owner.example/v1');
    assert.strictEqual(records.get('hyperbolic').status, 'active');
});

t.test('the recorded shape of every provider is parsed by the OpenAI adapter, tool calls included', async () => {
    for (const key of pool.PROVIDERS.filter(p => p.kind === 'openai').map(p => p.key)) {
        const recorded = fixtures[key] || fixtures.openrouter;
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

t.test('a catalogue offer with no key is off: the pool skips it no_credentials', async () => {
    // The commercial gate (an UNVERIFIED offer) keeps most of the catalogue out of the managed pool; the
    // credential gate is what this test is about, so the row carries the access mode the owner would grant.
    const row = { ...seed.recordOf(pool.byKey.get('qwen')), status: 'active', provider_access: 'OWN_DEPLOYMENT', origin: 'catalog' };
    const registry = {
        getRoute: async () => null,
        getProvider: async (k) => (k === 'qwen' ? row : null),
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
    const route = { key: 'test.no-key', primary: { provider: 'qwen', model: null }, fallbacks: [], timeout_ms: 3000 };
    const { explain } = await p.candidates(route, ['chat'], 'chat', {});
    assert.strictEqual(explain.candidates[0].eligible, false, 'an offer with no key is not eligible');
    assert.strictEqual(explain.candidates[0].excluded_reason, 'no_credentials');
    await assert.rejects(
        p.execute(route, 'chat', CHAT, { routeKey: route.key }),
        (err) => err.status === 503 && err.code === 'provider.unavailable',
        'an offer with no key cannot answer');
});

t.test('a provider that says the account has no money left is exhaustion, and it is never retried into', async () => {
    // The empty-failover work owns what happens then (the long circuit, the failover, 503 ai.resting):
    // server/providers/index.js and common.js. What matters here is that a provider's own answer is read as
    // exhaustion and not as a transient fault.
    const recorded = fixtures.exhausted.refuseless;
    const err = new ProviderError('Out of credits', { status: recorded.status, code: 'provider.http', body: recorded.body });
    assert.strictEqual(insufficientBalance(err), true, 'Refuseless\'s own 402 is exhaustion');
    assert.strictEqual(retryable(err), false, 'an empty account is not retried into');
    assert.strictEqual(insufficientBalance(new ProviderError('Model is busy. Retry shortly.', { status: 429, code: 'provider.http', body: { error: { code: 'model_busy' } } })), false, 'a busy model is not an empty account');
    assert.strictEqual(insufficientBalance(new ProviderError('the backend fell over', { status: 500, code: 'provider.http', body: {} })), false);
});

t.test('a booted service seeds the registry and preserves the existing environment key slot', async () => {
    const h = await boot({ env: { AI_STUB_FALLBACK: 'false' } });
    try {
        const rows = await h.registry.listProviders();
        for (const p of pool.PROVIDERS) {
            const row = rows.find((x) => x.key === p.key);
            assert.ok(row, `${p.key} seeded`);
            assert.strictEqual(row.secret_ref, p.key === 'deepseek' ? 'env:DEEPSEEK_API_KEY' : p.auth_mode === 'none' ? null : `vault:${p.key}`, `${p.key} key slot`);
            if (p.key === 'deepseek') continue; // the existing environment-backed seed retains its configuration
            assert.ok(row.metadata && row.metadata.catalog === 'pool-providers', `${p.key} catalogue row`);
            assert.strictEqual(row.metadata.privacy.label, p.privacy.label, `${p.key} privacy label`);
        }
        // The key is not there yet, so the offer cannot answer: the pool skips it.
        const route = { key: 'test.seeded', primary: { provider: 'qwen', model: null }, fallbacks: [], timeout_ms: 3000 };
        const { explain } = await h.pool.candidates(route, ['chat'], 'chat', {});
        assert.strictEqual(explain.candidates[0].eligible, false, 'an offer with no key is not eligible');
        assert.ok(/no_credentials|disabled/.test(String(explain.candidates[0].excluded_reason)), explain.candidates[0].excluded_reason);
        await assert.rejects(
            h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'x' }], timeoutMs: 3000 }, { routeKey: route.key }),
            (err) => err.code === 'provider.unavailable',
            'the catalogue offer is off until its key exists');
    } finally { await h.stop(); }
});

t.run();
