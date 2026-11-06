'use strict';
// The public Exchange catalog: the real upstream, not the router's internal `shared` label; only models a
// configured key can serve; chat, embeddings, speech-to-text and image as separate kinds; and DeepSeek's own
// offers with the prices its page listed when they were checked (2026-11-06).
const assert = require('assert');
const { boot, request, suite } = require('./helpers');
const upstream = require('../server/providers/upstream');
const fixture = require('./fixtures/exchange-catalog/catalog.json');

const t = suite('exchange-catalog-kinds');
let h;

t.test('boot with the configured keys and the catalog fixture', async () => {
    h = await boot({ env: { AI_PROVIDER: 'openai', AI_API_KEY: 'test-openai-key', DEEPSEEK_API_KEY: 'test-deepseek-key', AI_STUB_FALLBACK: 'false' } });
    for (const p of fixture.providers) await h.registry.upsertProvider(p, { actor: 'test', origin: 'admin' });
    for (const m of fixture.models) await h.registry.upsertModel(m, { actor: 'test' });
});

t.test('the shared key is shown as its real upstream, and only its own models are offers', async () => {
    const r = await request(h.base, 'GET', '/api/v1/exchange/catalog');
    assert.strictEqual(r.status, 200, r.text);
    const gpt = r.body.models.find((m) => m.slug === 'openai/gpt-5');
    assert.ok(gpt, 'the OpenAI model is an offer');
    assert.strictEqual(gpt.offers[0].provider, 'openai');
    assert.strictEqual(gpt.offers[0].provider_name, 'OpenAI');
    assert.ok(!r.body.models.some((m) => m.slug === 'anthropic/claude-haiku'), 'an OpenAI key cannot serve claude-haiku');
    assert.doesNotMatch(r.text, /Shared provider|"provider":"shared"/, 'the internal label never leaves the catalog');
});

t.test('DeepSeek has its own offers, models and checked prices', async () => {
    const r = await request(h.base, 'GET', '/api/v1/exchange/catalog');
    const flash = r.body.models.find((m) => m.slug === 'deepseek/deepseek-flash');
    const pro = r.body.models.find((m) => m.slug === 'deepseek/deepseek-v4-pro');
    assert.ok(flash && pro, 'both DeepSeek chat models are offers');
    assert.strictEqual(flash.family, 'DeepSeek');
    assert.strictEqual(flash.offers[0].provider, 'deepseek');
    assert.strictEqual(flash.offers[0].price.out, 1.2);
    assert.strictEqual(pro.offers[0].price.out, 3.96);
    assert.match(flash.offers[0].price_source, /api-docs\.deepseek\.com/);
    assert.strictEqual(flash.offers[0].price_checked_at, '2026-11-06');
    assert.strictEqual(flash.context, 1048576);
});

t.test('free_tier marks what the free allowance and Try it may use, distinct from free', async () => {
    const r = await request(h.base, 'GET', '/api/v1/exchange/catalog');
    const offerOf = (slug) => {
        const model = r.body.models.find((m) => m.slug === slug);
        assert.ok(model, `the catalog lists ${slug}`);
        return model.offers[0];
    };
    const flash = offerOf('deepseek/deepseek-flash');
    assert.strictEqual(flash.free, false, 'a priced offer, not prepaid capacity');
    assert.strictEqual(flash.free_tier, true, 'DeepSeek Flash is $1.20 out: a named source under the $1.50 ceiling');
    assert.strictEqual(offerOf('deepseek/deepseek-v4-pro').free_tier, false, 'the same source at $3.96 out is above the ceiling');
    assert.strictEqual(offerOf('openai/gpt-5').free_tier, false, 'the shared OpenAI key is not a free-tier source');
    assert.strictEqual(offerOf('cheapco/cheap-chat').free_tier, false, 'cheap is not enough: the source must be named');
    const local = offerOf('local/bge-small-en-v1.5');
    assert.strictEqual(local.free, true);
    assert.strictEqual(local.free_tier, true, 'local capacity is free and named');
    assert.strictEqual(offerOf('whisper/whisper.cpp').free_tier, true, 'whisper.cpp is local capacity');
    assert.ok(r.body.models.every((m) => m.offers.every((o) => typeof o.free_tier === 'boolean')), 'every offer carries the flag');
});

t.test('a provider whose key is not configured is never an offer', async () => {
    const r = await request(h.base, 'GET', '/api/v1/exchange/catalog');
    assert.ok(!r.body.models.some((m) => m.slug === 'unconfigured/mystery-chat'));
    assert.doesNotMatch(r.text, /mystery-chat/);
});

t.test('chat, embeddings, speech-to-text and image are separate kinds, and ?kind filters', async () => {
    const all = await request(h.base, 'GET', '/api/v1/exchange/catalog');
    assert.strictEqual(all.status, 200, all.text);
    assert.ok(all.body.kinds.some((k) => k.kind === 'chat'));
    assert.ok(all.body.kinds.some((k) => k.kind === 'embedding'));
    assert.ok(all.body.kinds.some((k) => k.kind === 'stt'));
    const embed = all.body.models.find((m) => m.model === 'bge-small-en-v1.5' || m.slug === 'local/bge-small-en-v1.5');
    const stt = all.body.models.find((m) => m.slug === 'whisper/whisper.cpp');
    assert.strictEqual(embed.kind, 'embedding');
    assert.strictEqual(stt.kind, 'stt');

    const chat = await request(h.base, 'GET', '/api/v1/exchange/catalog?kind=chat');
    assert.strictEqual(chat.status, 200, chat.text);
    assert.ok(chat.body.models.length > 0);
    assert.ok(chat.body.models.every((m) => m.kind === 'chat'));
    assert.ok(!chat.body.models.some((m) => m.kind === 'embedding' || m.kind === 'stt'));

    const embeddings = await request(h.base, 'GET', '/api/v1/exchange/catalog?kind=embedding');
    assert.strictEqual(embeddings.body.kind, 'embedding');
    assert.ok(embeddings.body.models.every((m) => m.kind === 'embedding'));

    const bad = await request(h.base, 'GET', '/api/v1/exchange/catalog?kind=screenshot');
    assert.strictEqual(bad.status, 422);
    assert.strictEqual(bad.body.code, 'exchange.kind_invalid');
});

t.test('an unknown shared upstream is no offer at all', async () => {
    const unknown = upstream.upstreamOf({ key: 'shared', display_name: 'Shared provider', base_url: 'https://proxy.internal/v1', metadata: {} });
    assert.strictEqual(unknown, null);
    assert.strictEqual(upstream.serves(unknown, { key: 'shared' }, { model_key: 'gpt-5' }), false);
    assert.strictEqual(upstream.serves({ families: ['openai'] }, { key: 'shared' }, { model_key: 'gpt-5' }), true);
    assert.strictEqual(upstream.serves({ families: ['openai'] }, { key: 'shared' }, { model_key: 'claude-haiku' }), false);
    assert.strictEqual(upstream.configured({ status: 'active', auth_mode: 'bearer', secret_ref: 'env:NOT_SET_ANYWHERE' }, {}), false);
});
