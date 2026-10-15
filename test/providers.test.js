'use strict';
// Provider adapters (ported from Live) against local fake servers — OpenAI-compatible (with the
// json_schema -> json_object step-down), Anthropic (forced tool JSON, cache_control, usage incl.
// cached tokens) — plus the stub's determinism and schema shapes, the whisper noise filter,
// template rendering and the loose JSON repair.

const assert = require('assert');
const { seamServer, suite } = require('./helpers');
const { createOpenAiProvider, buildBody: openaiBody } = require('../server/providers/openai');
const { createAnthropicProvider, buildBody: anthropicBody } = require('../server/providers/anthropic');
const { createStubProvider } = require('../server/providers/stub');
const { cleanSegments } = require('../server/providers/whisper');
const { render } = require('../server/templates');
const { parseJsonLoose } = require('../server/util');
const schemas = require('../server/schemas');
const { load } = require('../server/config');
const { providerRecords } = require('../server/workflows/seed');

const t = suite('providers');
const req = (extra = {}) => ({ system: [{ text: 'sys', cache: true }], messages: [{ role: 'user', content: 'hi' }], maxTokens: 50, temperature: 0.5, timeoutMs: 3000, model: 'gpt-4o-mini', ...extra });

t.test('OpenAI body: roles, reasoning models, structured output, prompt cache key', () => {
    const b = openaiBody({ ...req(), baseUrl: 'https://api.openai.com/v1', json: { name: 'r', schema: { type: 'object' } }, cacheKey: 'k' }, 'schema');
    assert.deepStrictEqual(b.messages[0], { role: 'system', content: 'sys' });
    assert.strictEqual(b.max_tokens, 50);
    assert.strictEqual(b.response_format.type, 'json_schema');
    assert.strictEqual(b.prompt_cache_key, 'k');
    const r = openaiBody({ ...req({ model: 'gpt-5-nano' }), baseUrl: 'https://x.example/v1' }, null);
    assert.ok(r.max_completion_tokens >= 256 + 512);
    assert.strictEqual(r.reasoning_effort, 'minimal');
    assert.strictEqual(r.temperature, undefined);
    assert.strictEqual(r.prompt_cache_key, undefined);
});

t.test('Anthropic body: cached system blocks, image block, forced tool for JSON', () => {
    const b = anthropicBody({ ...req(), image: { mediaType: 'image/jpeg', base64: 'AAAA' }, json: { name: 'r', schema: { type: 'object' } } });
    assert.deepStrictEqual(b.system[0].cache_control, { type: 'ephemeral' });
    assert.strictEqual(b.messages[0].content[1].type, 'image');
    assert.strictEqual(b.tool_choice.name, 'r');
});

t.test('OpenAI adapter steps down json_schema -> json_object on a gateway that refuses it', async () => {
    const seen = [];
    const systems = [];
    const srv = await seamServer((body) => {
        seen.push(body.response_format && body.response_format.type);
        systems.push((body.messages.find((m) => m.role === 'system') || {}).content || '');
        if (body.response_format && body.response_format.type === 'json_schema') return { status: 400, body: { error: { message: 'response_format json_schema is not supported' } } };
        return { choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } }, model: 'm' };
    });
    const a = createOpenAiProvider({ key: 'o', base_url: srv.url, capabilities: [] }, { apiKey: 'k' });
    const r = await a.chat(req({ json: { name: 'r', schema: { type: 'object' } } }));
    assert.deepStrictEqual(seen, ['json_schema', 'json_object']);
    // The schema the gateway refused travels in the instructions of the json_object request, not before.
    assert.ok(!systems[0].includes('JSON Schema'), 'not while structured output carries it');
    assert.ok(systems[1].includes('matches this JSON Schema exactly') && systems[1].includes('{"type":"object"}'), systems[1]);
    assert.strictEqual(r.text, '{"a":1}');
    assert.deepStrictEqual(r.usage, { input: 7, output: 3, cached: 2 });
    assert.ok(a.supports('embed') && a.supports('vision'));
    await srv.close();
});

t.test('OpenAI adapter: auth failures and timeouts are typed errors', async () => {
    const srv = await seamServer((b) => (b.messages[b.messages.length - 1].content === 'slow' ? new Promise(r => setTimeout(() => r({}), 1500)) : { status: 401, body: { error: { message: 'bad key' } } }));
    const a = createOpenAiProvider({ key: 'o', base_url: srv.url, capabilities: [] }, { apiKey: 'k' });
    await assert.rejects(a.chat(req({ messages: [{ role: 'user', content: 'x' }] })), e => e.code === 'provider.auth' && e.status === 401);
    await assert.rejects(a.chat(req({ messages: [{ role: 'user', content: 'slow' }], timeoutMs: 300 })), e => e.code === 'provider.timeout');
    const ctl = new AbortController();
    const p = a.chat(req({ messages: [{ role: 'user', content: 'slow' }], signal: ctl.signal }));
    ctl.abort();
    await assert.rejects(p, e => e.code === 'provider.cancelled');
    await srv.close();
});

t.test('Anthropic adapter returns tool JSON and counts cache reads', async () => {
    const srv = await seamServer((b, r) => {
        assert.strictEqual(r.headers['x-api-key'], 'ak');
        return { content: [{ type: 'tool_use', name: 'r', input: { ok: true } }], usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 10, cache_creation_input_tokens: 1 }, model: 'claude-x' };
    });
    const a = createAnthropicProvider({ key: 'a', base_url: srv.url, capabilities: [] }, { apiKey: 'ak' });
    const r = await a.chat(req({ json: { name: 'r', schema: { type: 'object' } } }));
    assert.deepStrictEqual(r.json, { ok: true });
    assert.deepStrictEqual(r.usage, { input: 16, output: 2, cached: 10 });
    assert.strictEqual(a.supports('embed'), false);
    await srv.close();
});

t.test('stub: deterministic, schema-shaped, clearly synthetic', async () => {
    const s = createStubProvider({ key: 'stub', metadata: {} });
    const schema = { type: 'object', additionalProperties: false, required: ['a', 'b', 'c', 'd'], properties: { a: { enum: ['x', 'y'] }, b: { type: 'integer', minimum: 3, maximum: 5 }, c: { type: 'array', items: { type: 'string', maxLength: 30 }, minItems: 2, maxItems: 2 }, d: { type: ['string', 'null'] } } };
    const one = await s.generate({ messages: [{ role: 'user', content: 'q' }], json: { name: 'r', schema } });
    const two = await s.generate({ messages: [{ role: 'user', content: 'q' }], json: { name: 'r', schema } });
    assert.deepStrictEqual(one.json, two.json);
    assert.ok(schemas.validate(schema, one.json).valid, JSON.stringify(one.json));
    assert.ok(one.json.d.startsWith('(synthetic)'));
    assert.strictEqual(one.synthetic, true);
    const diff = await s.generate({ messages: [{ role: 'user', content: 'other' }], json: { name: 'r', schema } });
    assert.notDeepStrictEqual(diff.json, one.json);
    const e = await s.embed({ input: ['a', 'b'] });
    assert.strictEqual(e.vectors.length, 2);
    assert.ok(Math.abs(e.vectors[0].reduce((n, x) => n + x * x, 0) - 1) < 1e-3, 'unit vectors');
    const tx = await s.transcribe({});
    assert.ok(tx.segments.length >= 2 && tx.segments.every(x => x.end > x.start));
    const failing = createStubProvider({ key: 'f', metadata: { fail: 'error' } });
    await assert.rejects(failing.chat({ messages: [] }), e2 => e2.code === 'provider.http');
});

t.test("whisper filter (Live's): hallucinations, subtitle boilerplate, loops; fillers only without VAD", () => {
    const segs = [{ start: 0, end: 1, text: 'Thank you.' }, { start: 1, end: 2, text: 'ok so the build broke' }, { start: 2, end: 3, text: 'ok so the build broke' },
        { start: 3, end: 4, text: '[MUSIC]' }, { start: 4, end: 5, text: 'For more information, visit www.fema.org.' }, { start: 5, end: 6, text: 'you' }];
    assert.deepStrictEqual(cleanSegments(segs, false).map(s => s.text), ['ok so the build broke']);
    assert.deepStrictEqual(cleanSegments(segs, true).map(s => s.text), ['ok so the build broke', 'you']);
});

t.test('templates render values, JSON and sections; loose JSON repair works', () => {
    assert.strictEqual(render('a {{x}} {{json y}}{{#z}} z!{{/z}}{{^w}} no-w{{/w}}', { x: 1, y: { k: 'v' }, z: [1] }), 'a 1 {"k":"v"} z! no-w');
    assert.strictEqual(render('{{#e}}hidden{{/e}}{{a.b}}', { e: [], a: { b: 'deep' } }), 'deep');
    assert.deepStrictEqual(parseJsonLoose('Sure! {"tags":["a","b"}'), { tags: ['a', 'b'] });
    assert.deepStrictEqual(parseJsonLoose('{“a”: 1,}'), { a: 1 });
});

t.test('local provider: never json, embed only with AI_LOCAL_EMBED_MODEL', () => {
    const caps = (env) => {
        const p = providerRecords(load(env), env).find(x => x.key === 'local');
        return p && p.capabilities;
    };
    assert.strictEqual(caps({}), undefined, 'no local provider without AI_LOCAL_LLM_URL');
    const plain = caps({ AI_LOCAL_LLM_URL: 'http://127.0.0.1:8090/v1' });
    assert.deepStrictEqual(plain, ['chat', 'generate', 'summarize', 'classify', 'extract']);
    const withEmbed = caps({ AI_LOCAL_LLM_URL: 'http://127.0.0.1:8090/v1', AI_LOCAL_EMBED_MODEL: ' nomic-embed-text ' });
    assert.deepStrictEqual(withEmbed, [...plain, 'embed']);
    assert.strictEqual(load({ AI_LOCAL_EMBED_MODEL: ' nomic-embed-text ' }).localLlm.embedModel, 'nomic-embed-text');
});

t.test('image: off without AI_IMAGE_MODEL; the Images API body, per-image usage and the stub PNG', async () => {
    const shared = (env) => providerRecords(load(env), env).find(x => x.key === 'shared');
    assert.ok(!shared({}).capabilities.includes('image'), 'no image capability without AI_IMAGE_MODEL');
    assert.ok(shared({ AI_IMAGE_MODEL: 'gpt-image-1' }).capabilities.includes('image'));
    assert.ok(!shared({ AI_PROVIDER: 'anthropic', AI_IMAGE_MODEL: 'gpt-image-1' }).capabilities.includes('image'), 'never on Anthropic');
    assert.deepStrictEqual(load({}).image, { model: '', size: '1024x1024' });
    assert.deepStrictEqual(load({ AI_IMAGE_MODEL: ' dall-e-3 ', AI_IMAGE_SIZE: '1792x1024' }).image, { model: 'dall-e-3', size: '1792x1024' });

    const seen = [];
    const s = await seamServer((body, r) => { seen.push([r.url, body]); return { data: [{ url: 'https://img.example/1.png', revised_prompt: 'a goose' }], model: body.model }; });
    const a = createOpenAiProvider({ key: 'o', base_url: s.url }, { apiKey: 'k' });
    assert.ok(a.supports('image'));
    const r = await a.image({ model: 'dall-e-3', prompt: 'goose', n: 0, size: '1024x1024', timeoutMs: 3000 });
    assert.deepStrictEqual(seen[0], ['/images/generations', { model: 'dall-e-3', prompt: 'goose', n: 1, size: '1024x1024', response_format: 'b64_json' }]);
    assert.deepStrictEqual(r.images, [{ b64: null, url: 'https://img.example/1.png', revised_prompt: 'a goose' }]);
    assert.deepStrictEqual(r.usage, { input: 0, output: 1, cached: 0 }, 'metered per image, never per token');
    s.handler = () => ({ data: [] });
    await assert.rejects(a.image({ model: 'gpt-image-1', prompt: 'goose', timeoutMs: 3000 }), (e) => e.code === 'provider.output');
    await s.close();

    const stub = createStubProvider();
    const one = await stub.image({ prompt: 'goose', n: 3 });
    assert.strictEqual(one.images.length, 3);
    assert.deepStrictEqual(one, await stub.image({ prompt: 'another prompt', n: 3 }), 'the same PNG for every prompt');
    assert.strictEqual(Buffer.from(one.images[0].b64, 'base64').subarray(1, 4).toString(), 'PNG');
    assert.strictEqual(one.usage.output, 3);
    assert.strictEqual((await stub.image({ prompt: 'goose', n: 99 })).images.length, 4, 'n is clamped to 4');
});

t.run();
