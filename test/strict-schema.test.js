'use strict';
// A loose schema (strict: false) goes to OpenAI as a strict one, so the answer is decoded against it, and comes back
// fitted to the caller's own schema (server/providers/strict-schema.js). 2026-11-15: gpt-5-nano, only reading the deep
// dive's loose plan schema, answered with the schema itself, and every deep dive failed at its first step.

const assert = require('assert');
const { seamServer, suite } = require('./helpers');
const { toStrict, fitAnswer } = require('../server/providers/strict-schema');
const { createOpenAiProvider, buildBody } = require('../server/providers/openai');
const { createResponsesProvider } = require('../server/providers/responses');
const { PLAN_OUTPUT, ANALYSIS_OUTPUT, CHOOSE_OUTPUT, SYNTHESIS_OUTPUT } = require('../server/deep-dive/schema');
const schemas = require('../server/schemas');

const t = suite('strict-schema');
const req = (extra = {}) => ({ system: [{ text: 'sys', cache: true }], messages: [{ role: 'user', content: 'plan it' }], maxTokens: 400, temperature: 0.3, timeoutMs: 3000, model: 'gpt-5-nano', ...extra });

// Every object closed with every property required, nothing strict mode refuses, all the way down.
function assertStrict(s, path = '$') {
    if (!s || typeof s !== 'object') return;
    for (const k of ['maxLength', 'minLength', 'default', 'examples']) assert.ok(!(k in s), `${path}: ${k} dropped`);
    if (s.properties) {
        assert.strictEqual(s.additionalProperties, false, `${path}: closed`);
        assert.deepStrictEqual([...s.required].sort(), Object.keys(s.properties).sort(), `${path}: every property required`);
        for (const [k, v] of Object.entries(s.properties)) assertStrict(v, `${path}.${k}`);
    }
    if (s.items) assertStrict(s.items, `${path}[]`);
    if (s.anyOf) s.anyOf.forEach((x, i) => assertStrict(x, `${path}|${i}`));
}

t.test('the deep dive plan schema becomes strict: closed, all required, optional ones nullable, limits dropped', () => {
    const s = toStrict(PLAN_OUTPUT);
    assert.ok(s, 'convertible');
    assertStrict(s);
    const search = s.properties.searches.items;
    assert.deepStrictEqual(search.properties.kind.type, ['string', 'null'], 'an optional enum is a nullable string');
    assert.ok(search.properties.kind.enum.includes(null) && search.properties.kind.enum.includes('web'));
    assert.strictEqual(search.properties.q.type, 'string', 'a required string stays required and not nullable');
    assert.strictEqual(s.properties.questions.minItems, 3, 'list limits strict mode accepts are kept');
    assert.deepStrictEqual(PLAN_OUTPUT.properties.questions.items.properties.key, { type: 'string', maxLength: 40 }, 'the caller\'s schema is untouched');
});

t.test('the other deep dive steps convert too', () => {
    for (const [name, sch] of Object.entries({ ANALYSIS_OUTPUT, CHOOSE_OUTPUT, SYNTHESIS_OUTPUT })) {
        const s = toStrict(sch);
        if (s) assertStrict(s, name);
    }
    assert.ok(toStrict(ANALYSIS_OUTPUT), 'the site analysis converts');
    assert.ok(toStrict(CHOOSE_OUTPUT), 'the site choice converts');
});

t.test('what cannot be strict stays loose: a free-form object, a non-object root, an unknown keyword', () => {
    assert.strictEqual(toStrict({ type: 'object' }), null);
    assert.strictEqual(toStrict({ type: 'object', properties: { meta: { type: 'object', additionalProperties: true } } }), null);
    assert.strictEqual(toStrict({ type: 'array', items: { type: 'string' } }), null);
    assert.strictEqual(toStrict({ type: 'object', properties: { a: { type: 'string', patternProperties: {} } } }), null);
    assert.strictEqual(toStrict(null), null);
});

t.test('the answer is fitted back: optional nulls out, strings and lists cut at their limits, nullable kept', () => {
    const schema = { type: 'object', required: ['a'], properties: { a: { type: 'string', maxLength: 5 }, b: { enum: ['x', 'y'] }, c: { type: ['string', 'null'] }, d: { type: 'array', maxItems: 2, items: { type: 'object', required: ['n'], properties: { n: { type: 'integer' }, note: { type: 'string' } } } } } };
    const out = fitAnswer({ a: 'abcdefgh', b: null, c: null, d: [{ n: 1, note: null }, { n: 2, note: 'ok' }, { n: 3, note: null }] }, schema);
    assert.deepStrictEqual(out, { a: 'abcde', c: null, d: [{ n: 1 }, { n: 2, note: 'ok' }] });
    assert.ok(schemas.validate(schema, out).valid);
});

t.test('OpenAI adapter: a loose schema goes strict, and the strict answer passes the caller\'s schema', async () => {
    const seen = [];
    const long = 'q'.repeat(500);
    const srv = await seamServer((b) => {
        seen.push(b.response_format);
        return { choices: [{ message: { content: JSON.stringify({ questions: [{ key: 'hierarchy', question: long }, { key: 'type', question: 'Which type?' }, { key: 'trust', question: 'What builds trust?' }], searches: [{ q: 'pricing page design', kind: null }] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 40 }, model: 'gpt-5-nano' };
    });
    const p = createOpenAiProvider({ key: 'o', base_url: srv.url, capabilities: [] }, { apiKey: 'k' });
    const r = await p.chat(req({ json: { name: 'deep_dive_plan', schema: PLAN_OUTPUT, strict: false } }));
    await srv.close();
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].type, 'json_schema');
    assert.strictEqual(seen[0].json_schema.strict, true, 'sent strict');
    assertStrict(seen[0].json_schema.schema);
    const json = JSON.parse(r.text);
    assert.strictEqual(json.searches[0].kind, undefined, 'the optional null is taken out');
    assert.strictEqual(json.questions[0].question.length, 400, 'cut at the caller\'s maxLength');
    assert.ok(schemas.validate(PLAN_OUTPUT, json).valid, 'valid against the deep dive\'s own schema');
});

t.test('OpenAI adapter: a refused strict schema goes as written, then json_object, then prose', async () => {
    const seen = [];
    const srv = await seamServer((b) => {
        const rf = b.response_format;
        seen.push(rf ? (rf.type === 'json_schema' ? `schema:${rf.json_schema.strict}` : rf.type) : 'prose');
        if (rf) return { status: 400, body: { error: { message: `Invalid schema for response_format: ${rf.type} not supported` } } };
        return { choices: [{ message: { content: '{"questions":[],"searches":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: 'm' };
    });
    const p = createOpenAiProvider({ key: 'o', base_url: srv.url, capabilities: [] }, { apiKey: 'k' });
    await p.chat(req({ model: 'gpt-4o-mini', json: { name: 'plan', schema: PLAN_OUTPUT, strict: false } }));
    assert.deepStrictEqual(seen, ['schema:true', 'schema:false', 'json_object', 'prose']);
    seen.length = 0;
    await p.chat(req({ model: 'gpt-4o-mini', json: { name: 'plan', schema: PLAN_OUTPUT, strict: false } }));
    assert.deepStrictEqual(seen, ['prose'], 'a model that refused structured output starts where it answered');
    seen.length = 0;
    await p.chat(req({ model: 'gpt-5-nano', json: { name: 'plan', schema: PLAN_OUTPUT, strict: false } })).catch(() => {});
    assert.strictEqual(seen[0], 'schema:true', 'another model on the same provider still tries strict first');
    await srv.close();
});

t.test('OpenAI adapter: a gateway with json_object but no json_schema costs one refusal, once', async () => {
    const seen = [];
    const srv = await seamServer((b) => {
        const rf = b.response_format;
        seen.push(rf ? (rf.type === 'json_schema' ? `schema:${rf.json_schema.strict}` : rf.type) : 'prose');
        if (rf && rf.type === 'json_schema') return { status: 400, body: { error: { message: 'This response_format type is unavailable now' } } };
        return { choices: [{ message: { content: '{"questions":[],"searches":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: 'deepseek-flash' };
    });
    const p = createOpenAiProvider({ key: 'deepseek', base_url: srv.url, capabilities: [] }, { apiKey: 'k' });
    await p.chat(req({ model: 'deepseek-flash', json: { name: 'plan', schema: PLAN_OUTPUT, strict: false } }));
    await p.chat(req({ model: 'deepseek-flash', json: { name: 'plan', schema: PLAN_OUTPUT, strict: false } }));
    await srv.close();
    assert.deepStrictEqual(seen, ['schema:true', 'schema:false', 'json_object', 'json_object']);
});

t.test('a strict caller and a free-form schema are sent as written', () => {
    const strictCaller = buildBody({ ...req(), baseUrl: 'https://api.openai.com/v1', json: { name: 'r', schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false } } }, 'schema');
    assert.deepStrictEqual(strictCaller.response_format.json_schema.schema, { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false });
    assert.strictEqual(strictCaller.response_format.json_schema.strict, true);
    const free = buildBody({ ...req(), baseUrl: 'https://api.openai.com/v1', json: { name: 'r', schema: { type: 'object' }, strict: false } }, 'strict');
    assert.deepStrictEqual(free.response_format.json_schema, { name: 'r', schema: { type: 'object' }, strict: false }, 'nothing to convert: as written');
});

t.test('Responses adapter: the same strict format and the fitted answer', async () => {
    const seen = [];
    const srv = await seamServer((b) => {
        seen.push(b.text && b.text.format);
        return { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ questions: [{ key: 'a', question: 'A?' }, { key: 'b', question: 'B?' }, { key: 'c', question: 'C?' }], searches: [{ q: 'x', kind: null }] }) }] }], usage: { input_tokens: 5, output_tokens: 5 }, model: 'gpt-5-nano' };
    });
    const p = createResponsesProvider({ key: 'r', base_url: srv.url, capabilities: [] }, { apiKey: 'k' });
    const r = await p.chat(req({ json: { name: 'plan', schema: PLAN_OUTPUT, strict: false } }));
    await srv.close();
    assert.strictEqual(seen[0].strict, true);
    assertStrict(seen[0].schema);
    assert.ok(schemas.validate(PLAN_OUTPUT, JSON.parse(r.text)).valid);
});

t.run();
