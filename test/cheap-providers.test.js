'use strict';
/**
 * The cheap hosted inference providers added 2026-11-10 (each endpoint read and probed keyless that day).
 * Every new row starts disabled with no key and an https endpoint on its own documented host; sync imports
 * a recorded models list (no network in tests) with prices from the provider's own list, models off.
 */
const assert = require('assert');
const { boot, request, token, suite } = require('./helpers');
const { PROVIDERS } = require('../server/providers/pool-providers');
const seed = require('../server/providers/pool-seed');

const t = suite('cheap-providers');
const owner = token('exchange', ['ai.provider.manage', 'ai.usage.read']);

const NEW_KEYS = ['parasail', 'particle-ai', 'inference-net', 'atlas-cloud', 'avian', 'mancer', 'nanogpt', 'infermatic', 'arliai', 'friendli', 'scaleway'];
const HOST = {
    parasail: 'api.parasail.io', 'particle-ai': 'api.particle.ai', 'inference-net': 'api.inference.net',
    'atlas-cloud': 'api.atlascloud.ai', avian: 'api.avian.io', mancer: 'neuro.mancer.tech', nanogpt: 'api.nano-gpt.com',
    infermatic: 'api.totalgpt.ai', arliai: 'api.arliai.com', friendli: 'api.friendli.ai', scaleway: 'api.scaleway.ai',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function fetchImpl(input) {
    const url = String(input);
    if (url === 'https://api.inference.net/v1/models') return json({ object: 'list', data: [
        { id: 'llama-3.3-70b', object: 'model', context_length: 131072, pricing: { prompt: '0.00000013', completion: '0.00000040', input_cache_read: '0.00000001' } },
        { id: 'glm-5.3-flash', object: 'model', context_length: 1048576, pricing: { prompt: '0.00000010', completion: '0.00000045' } },
    ] });
    if (url === 'https://api.atlascloud.ai/v1/models') return json({ code: 200, msg: 'succeed', data: [
        { id: 'deepseek-ai/DeepSeek-V3.2-Exp', object: 'model', context_length: 163840, quantization: 'fp8',
          pricing: { prompt: '0.00000026', completion: '0.00000038', input_cache_read: '0.00000013' } },
    ] });
    return json({}, 404);
}

t.test('every new row: https endpoint on its own host, off, no key', () => {
    for (const key of NEW_KEYS) {
        const p = PROVIDERS.find((x) => x.key === key);
        assert.ok(p, `${key} is catalogued`);
        assert.strictEqual(new URL(p.base_url).hostname, HOST[key], `${key} base host`);
        assert.ok(p.base_url.startsWith('https://'), `${key} https`);
        assert.ok(p.metadata === undefined || typeof p === 'object', `${key} record`);
        const row = seed.recordOf(p);
        assert.strictEqual(row.status, 'disabled', `${key} starts off`);
        assert.strictEqual(row.secret_ref, `vault:${key}`, `${key} key slot named, no key`);
        assert.strictEqual(row.metadata.api_family, 'openai', `${key} OpenAI wire format`);
        assert.ok(new URL(row.metadata.models_endpoint).hostname === HOST[key] || key === 'arliai', `${key} models on its own host`);
    }
    // Key-required lists stay out of the keyless sync, keyless ones join it.
    for (const key of ['parasail', 'particle-ai', 'infermatic', 'scaleway'])
        assert.notStrictEqual(PROVIDERS.find((x) => x.key === key).models_public, true, `${key} needs a key for its list`);
    for (const key of ['inference-net', 'atlas-cloud', 'avian', 'mancer', 'nanogpt', 'arliai', 'friendli'])
        assert.strictEqual(PROVIDERS.find((x) => x.key === key).models_public, true, `${key} list answers keyless`);
});

t.test('boot seeds the new providers disabled and credentialless; sync imports prices from the recorded list', async () => {
    const h = await boot({ fetchImpl, env: { AI_USER_MODULES: 'off' } });
    for (const key of NEW_KEYS) {
        const p = await h.registry.getProvider(key);
        assert.ok(p, `${key} seeded`);
        assert.strictEqual(p.status, 'disabled', `${key} off`);
        assert.strictEqual(p.secret_ref, `vault:${key}`, `${key} key slot`);
        assert.strictEqual(p.metadata.models_public === true, ['inference-net', 'atlas-cloud', 'avian', 'mancer', 'nanogpt', 'arliai', 'friendli'].includes(key), `${key} keyless list flag`);
    }
    const pub = await request(h.base, 'GET', '/api/v1/providers/inference-net', { tok: owner });
    assert.strictEqual(pub.body.provider.credentials, 'missing', 'no key configured');
    assert.ok(!pub.text.includes('vault:'), 'provider view names the slot, never a value');

    const syncOpts = { actor: 'cheap-providers-test' };
    const meta = { models_endpoint: 'https://api.inference.net/v1/models' };
    const provider = await h.registry.getProvider('inference-net');
    const { sync } = require('../server/providers/catalog');
    const result = await sync({ registry: h.registry, provider: { ...provider, metadata: { ...provider.metadata, ...meta } }, apiKey: null, fetchImpl, actor: 'cheap-providers-test' });
    assert.deepStrictEqual(result.added.sort(), ['glm-5.3-flash', 'llama-3.3-70b']);
    const llama = await h.registry.getModel('inference-net', 'llama-3.3-70b');
    assert.strictEqual(llama.status, 'disabled', 'synced models arrive off');
    assert.strictEqual(llama.cost.in_per_mtok, 0.13, 'prompt per-token string read as per-MTok');
    assert.strictEqual(llama.cost.out_per_mtok, 0.40);
    assert.strictEqual(llama.cost.cached_per_mtok, 0.01);
    assert.strictEqual(llama.cost.source, 'https://api.inference.net/v1/models', 'price source is the provider list');
    assert.strictEqual(llama.context_window, 131072);

    const atlas = await h.registry.getProvider('atlas-cloud');
    const atlasResult = await sync({ registry: h.registry, provider: { ...atlas, metadata: { ...atlas.metadata, models_endpoint: 'https://api.atlascloud.ai/v1/models' } }, apiKey: null, fetchImpl, actor: 'cheap-providers-test' });
    assert.deepStrictEqual(atlasResult.added, ['deepseek-ai/DeepSeek-V3.2-Exp']);
    const deepseek = await h.registry.getModel('atlas-cloud', 'deepseek-ai/DeepSeek-V3.2-Exp');
    assert.strictEqual(deepseek.status, 'disabled');
    assert.strictEqual(deepseek.cost.in_per_mtok, 0.26);
    assert.strictEqual(deepseek.cost.out_per_mtok, 0.38);
    assert.strictEqual(deepseek.context_window, 163840);
    await h.stop();
});
