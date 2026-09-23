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
    const srv = await seamServer((body) => {
        seen.push(body.response_format && body.response_format.type);
        if (body.response_format && body.response_format.type === 'json_schema') return { status: 400, body: { error: { message: 'response_format json_schema is not supported' } } };
        return { choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } }, model: 'm' };
    });
    const a = createOpenAiProvider({ key: 'o', base_url: srv.url, capabilities: [] }, { apiKey: 'k' });
    const r = await a.chat(req({ json: { name: 'r', schema: { type: 'object' } } }));
    assert.deepStrictEqual(seen, ['json_schema', 'json_object']);
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

t.run();
