'use strict';
// The model catalogue keeps itself current (plan L33 P1): a provider's own model list, read with its key, becomes
// described models — what each is, how strong, whether it sees, uses tools or thinks first, its context — that arrive
// switched off, keep a person's prices and status when read again, and are marked (never deleted) when the provider
// stops listing them. Fake Anthropic (Models API, paged) and OpenRouter (/models with context and modalities) servers.
const assert = require('assert');
const http = require('http');
const { suite } = require('./helpers');
const { createRegistry } = require('../server/registry');
const catalog = require('../server/providers/catalog');
const { testDb } = require('./db');

const t = suite('model-catalog');

function server(handler) {
    return new Promise((resolve) => {
        const seen = [];
        const s = http.createServer((req, res) => {
            seen.push({ url: req.url, headers: req.headers });
            const out = handler(req);
            res.writeHead(out.status || 200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(out.body || out));
        });
        s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, seen, close: () => new Promise((r) => s.close(r)) }));
    });
}

t.test('what a model id means: its kind, its strength and what it can do', () => {
    const d = (id) => catalog.describe(id);
    assert.deepStrictEqual([d('claude-opus-5-5').tier, d('claude-sonnet-5-5').tier, d('claude-haiku-5-5').tier, d('claude-fable-5-1').tier], ['frontier', 'strong', 'fast', 'frontier']);
    assert.ok(d('claude-opus-5-5').vision && d('claude-opus-5-5').tools && d('claude-opus-5-5').reasoning);
    assert.deepStrictEqual([d('models/gemini-2.5-pro').tier, d('gemini-2.5-flash').tier, d('gemini-2.5-flash-lite').tier], ['strong', 'balanced', 'fast'], 'Gemini, models/ or not');
    assert.strictEqual(d('gemini-2.5-flash-image').type, 'image');
    assert.ok(d('deepseek-reasoner').reasoning && d('deepseek-reasoner').tier === 'strong' && d('deepseek-chat').tier === 'balanced');
    assert.deepStrictEqual([d('text-embedding-3-small').type, d('whisper-1').type, d('veo-3').type], ['embedding', 'stt', 'video']);
    assert.strictEqual(d('anthropic/claude-sonnet-5-5').tier, 'strong', 'OpenRouter ids name the model after the slash');
    assert.strictEqual(d('something-new').tier, 'balanced', 'an unknown model is a balanced chat model');
    assert.ok(d('kimi-k2-thinking').reasoning && d('acme-reasoner').tier === 'strong', 'a thinking model by its name');
    const hinted = catalog.describe('claude-opus-5-5', { contextWindow: 1000000, maxOutput: 128000, vision: false });
    assert.ok(hinted.contextWindow === 1000000 && hinted.maxOutput === 128000 && hinted.vision === false, 'what the provider says wins');
});

t.test("Anthropic's list (paged, with limits and capabilities) and OpenRouter's (context, modalities, tools)", async () => {
    const anthropic = await server((req) => (req.url.includes('after_id=claude-sonnet-5-5')
        ? { data: [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', max_input_tokens: 1000000, max_tokens: 64000 }], has_more: false }
        : { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { image_input: { supported: true }, thinking: { supported: true } } },
            { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', max_input_tokens: 1000000, max_tokens: 128000 }], has_more: true, last_id: 'claude-sonnet-5-5' }));
    try {
        // listRemote only reads an anthropic.com list; point a record at the fake through a base URL that says so.
        const list = await catalog.listRemote({ kind: 'anthropic', base_url: `${anthropic.url}/v1` }, 'ak');
        assert.deepStrictEqual(list, [], 'an Anthropic-format endpoint of another provider has no list to read');
        const real = await catalog.listRemote({ kind: 'anthropic', base_url: 'https://api.anthropic.com/v1' }, 'ak', { fetchImpl: (u, o) => globalThis.fetch(u.replace('https://api.anthropic.com', anthropic.url), o) });
        assert.deepStrictEqual(real.map((m) => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], 'every page');
        assert.strictEqual(anthropic.seen[0].headers['x-api-key'], 'ak');
        assert.ok(anthropic.seen[0].headers['anthropic-version']);
        assert.deepStrictEqual(real[0].hints, { contextWindow: 1000000, maxOutput: 128000, vision: true, reasoning: true });
    } finally { await anthropic.close(); }

    const openrouter = await server(() => ({ data: [
        { id: 'google/gemini-2.5-pro', name: 'Google: Gemini 2.5 Pro', context_length: 1048576, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools', 'reasoning'] },
        { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3', context_length: 163840, architecture: { input_modalities: ['text'] }, supported_parameters: ['tools'] },
    ] }));
    try {
        const list = await catalog.listRemote({ kind: 'openai', base_url: `${openrouter.url}/api/v1` }, 'ok');
        assert.strictEqual(openrouter.seen[0].headers.authorization, 'Bearer ok');
        assert.deepStrictEqual(list[0], { id: 'google/gemini-2.5-pro', name: 'Google: Gemini 2.5 Pro', hints: { contextWindow: 1048576, maxOutput: undefined, vision: true, tools: true, reasoning: true } });
        assert.strictEqual(list[1].hints.vision, false);
    } finally { await openrouter.close(); }
});

t.test('sync: new models arrive switched off; a known one keeps its status and prices; an unlisted one is marked', async () => {
    const rdb = await testDb();
    const registry = createRegistry(rdb.db, { env: {} });
    let listed = [
        { id: 'deepseek-chat', object: 'model' }, { id: 'deepseek-reasoner', object: 'model' },
    ];
    const fake = await server(() => ({ data: listed }));
    try {
        await registry.upsertProvider({ key: 'deepseek', display_name: 'DeepSeek', kind: 'openai', status: 'active', base_url: `${fake.url}/v1`, auth_mode: 'bearer', secret_ref: null, capabilities: ['chat'], timeout_ms: 30000, priority: 10 }, { actor: 'test', origin: 'admin' });
        // A person registered deepseek-chat with its prices and turned it on before any sync.
        await registry.upsertModel({ provider_key: 'deepseek', model_key: 'deepseek-chat', status: 'active', cost: { in_per_mtok: 0.27, out_per_mtok: 1.1, source: 'https://api-docs.deepseek.com/quick_start/pricing', verified_at: '2026-10-31' } });
        const provider = await registry.getProvider('deepseek');
        const first = await catalog.sync({ registry, provider, apiKey: 'k' });
        assert.deepStrictEqual(first.added, ['deepseek-reasoner']);
        assert.deepStrictEqual(first.updated, ['deepseek-chat']);
        const chat = await registry.getModel('deepseek', 'deepseek-chat');
        const reasoner = await registry.getModel('deepseek', 'deepseek-reasoner');
        assert.ok(chat.status === 'active' && chat.cost.in_per_mtok === 0.27 && chat.cost.source, "the person's status and prices stay");
        assert.ok(reasoner.status === 'disabled' && reasoner.cost.in_per_mtok == null, 'a new model is off, with no price until a person types one');
        assert.ok(reasoner.metadata.tier === 'strong' && reasoner.metadata.reasoning === true && reasoner.supports.tools, 'and described');
        listed = [{ id: 'deepseek-chat' }];
        const second = await catalog.sync({ registry, provider, apiKey: 'k' });
        assert.deepStrictEqual(second.missing, ['deepseek-reasoner']);
        const gone = await registry.getModel('deepseek', 'deepseek-reasoner');
        assert.ok(gone && gone.metadata.missing_since, 'no longer listed: marked, not deleted');
        const third = await catalog.sync({ registry, provider, apiKey: 'k' });
        assert.deepStrictEqual(third.missing, [], 'and marked once');
    } finally { await fake.close(); await rdb.close(); }
});

t.run();
