'use strict';
// The OpenAI Responses adapter (kind 'responses') with a stubbed fetchImpl: the pool builds it,
// it POSTs {base}/responses with input, instructions and the bearer key, parses output_text and
// usage, asks for JSON through text.format (with the openai.js step-down), maps a non-2xx exactly
// like openai.js does, and never lets the key into a thrown error.

const assert = require('assert');
const { suite } = require('./helpers');
const { createResponsesProvider, buildBody } = require('../server/providers/responses');
const { createOpenAiProvider } = require('../server/providers/openai');
const { createProviderPool } = require('../server/providers');
const { ProviderError, retryable } = require('../server/providers/common');
const { PROVIDER_KINDS } = require('../server/registry');

const t = suite('provider-responses');
const KEY = 'sk-resp-secret-0123456789';
const req = (extra = {}) => ({ system: [{ text: 'be brief' }], messages: [{ role: 'user', content: 'hi' }], maxTokens: 50, temperature: 0.2, timeoutMs: 3000, model: 'gpt-4.1-mini', ...extra });
const ok = { model: 'gpt-4.1-mini-2025', output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello ' }, { type: 'output_text', text: 'there' }] }], usage: { input_tokens: 11, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } } };

/** A fetchImpl that records each call and answers with respond(body, call). */
function stubFetch(respond) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, headers: init.headers, body });
        const out = await respond(body, calls.length);
        const status = out && out.status ? out.status : 200;
        const payload = out && out.status ? out.body : out;
        return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload || {}) };
    };
    return { calls, fetchImpl };
}

t.test('the pool builds kind responses with the key from its secret reference', async () => {
    const record = { key: 'resp', kind: 'responses', base_url: 'https://gw.example/v1/', secret_ref: 'env:RESP_KEY', capabilities: [], updated_at: 1 };
    const noop = { get: async () => undefined, run: async () => ({}), all: async () => [] };
    const s = stubFetch(() => ok);
    const pool = createProviderPool({ db: { prepare: () => noop }, registry: { getProvider: async (k) => (k === 'resp' ? record : null) }, config: { breaker: { failureThreshold: 3, cooldownMs: 1000 } }, fetchImpl: s.fetchImpl, env: { RESP_KEY: KEY } });
    assert.ok(PROVIDER_KINDS.includes('responses'), 'the registry accepts kind responses');
    const { adapter } = await pool.adapter('resp');
    assert.strictEqual(adapter.kind, 'responses');
    assert.ok(adapter.supports('chat') && adapter.supports('json') && adapter.supports('vision'));
    assert.ok(!adapter.supports('embed') && !adapter.supports('transcribe'));
    assert.strictEqual(typeof adapter.summarize, 'function');
    await adapter.chat(req());
    assert.strictEqual(s.calls[0].url, 'https://gw.example/v1/responses');
    assert.strictEqual(s.calls[0].headers.Authorization, `Bearer ${KEY}`);
});

t.test('POST /responses with input and instructions; output_text and usage are parsed', async () => {
    const s = stubFetch(() => ok);
    const a = createResponsesProvider({ key: 'r', capabilities: [] }, { apiKey: KEY, fetchImpl: s.fetchImpl });
    const r = await a.chat(req());
    assert.strictEqual(s.calls[0].url, 'https://api.openai.com/v1/responses');
    assert.strictEqual(s.calls[0].headers.Authorization, `Bearer ${KEY}`);
    assert.strictEqual(s.calls[0].headers['Content-Type'], 'application/json');
    const b = s.calls[0].body;
    assert.strictEqual(b.model, 'gpt-4.1-mini');
    assert.strictEqual(b.instructions, 'be brief');
    assert.deepStrictEqual(b.input, [{ role: 'user', content: 'hi' }]);
    assert.strictEqual(b.max_output_tokens, 50);
    assert.strictEqual(b.text, undefined);
    assert.strictEqual(r.text, 'hello there');
    assert.strictEqual(r.model, 'gpt-4.1-mini-2025');
    assert.deepStrictEqual(r.usage, { input: 11, output: 4, cached: 3 });
    const bare = await createResponsesProvider({ key: 'r' }, { apiKey: KEY, fetchImpl: stubFetch(() => ({ output: [] })).fetchImpl }).chat(req());
    assert.deepStrictEqual([bare.text, bare.model, bare.usage], ['', 'gpt-4.1-mini', { input: 0, output: 0, cached: 0 }]);
});

t.test('body: reasoning models, image input, no instructions without a system prompt', () => {
    const r = buildBody({ ...req({ model: 'gpt-5-mini', system: [] }), image: { mediaType: 'image/png', base64: 'AAAA' } }, null);
    assert.strictEqual(r.instructions, undefined);
    assert.ok(r.max_output_tokens >= 256 + 512);
    assert.deepStrictEqual(r.reasoning, { effort: 'minimal' });
    assert.strictEqual(r.temperature, undefined);
    assert.deepStrictEqual(r.input[0].content, [{ type: 'input_text', text: 'hi' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }]);
});

t.test('a JSON request sets text.format and steps down json_schema -> json_object on a gateway that refuses it', async () => {
    const s = stubFetch((body) => (body.text.format.type === 'json_schema'
        ? { status: 400, body: { error: { message: "Invalid value for 'text.format': json_schema is not supported" } } }
        : { output: [{ type: 'message', content: [{ type: 'output_text', text: '{"a":1}' }] }], usage: { input_tokens: 7, output_tokens: 3 } }));
    const a = createResponsesProvider({ key: 'r', capabilities: [] }, { apiKey: KEY, fetchImpl: s.fetchImpl });
    const r = await a.chat(req({ json: { name: 'r', schema: { type: 'object' } } }));
    assert.deepStrictEqual(s.calls[0].body.text, { format: { type: 'json_schema', name: 'r', schema: { type: 'object' }, strict: true } });
    assert.deepStrictEqual(s.calls[1].body.text, { format: { type: 'json_object' } });
    assert.strictEqual(r.text, '{"a":1}');
    assert.deepStrictEqual(r.usage, { input: 7, output: 3, cached: 0 });
});

t.test('a non-2xx maps to the same ProviderError, code, status and retryable flag as openai.js', async () => {
    for (const [status, code, retry] of [[500, 'provider.http', true], [429, 'provider.http', true], [401, 'provider.auth', false], [400, 'provider.http', false]]) {
        const answer = () => ({ status, body: { error: { message: `upstream ${status}` } } });
        const fromResponses = await createResponsesProvider({ key: 'r' }, { apiKey: KEY, fetchImpl: stubFetch(answer).fetchImpl }).chat(req()).then(() => null, e => e);
        const fromOpenAi = await createOpenAiProvider({ key: 'o' }, { apiKey: KEY, fetchImpl: stubFetch(answer).fetchImpl }).chat(req()).then(() => null, e => e);
        for (const e of [fromResponses, fromOpenAi]) {
            assert.ok(e instanceof ProviderError, `${status}: ProviderError`);
            assert.deepStrictEqual([e.status, e.code, retryable(e), e.message], [status, code, retry, `upstream ${status}`]);
        }
    }
    const down = await createResponsesProvider({ key: 'r' }, { apiKey: KEY, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }).chat(req()).then(() => null, e => e);
    assert.ok(down instanceof ProviderError && down.code === 'provider.unreachable' && retryable(down));
});

t.test('the API key never appears in a thrown error, even when the upstream echoes it', async () => {
    const echo = stubFetch(() => ({ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}.` } } }));
    const e = await createResponsesProvider({ key: 'r' }, { apiKey: KEY, fetchImpl: echo.fetchImpl }).chat(req()).then(() => null, x => x);
    assert.ok(e instanceof ProviderError && e.code === 'provider.auth');
    assert.ok(!e.message.includes(KEY) && !JSON.stringify(e.body || {}).includes(KEY) && !String(e.stack).includes(KEY), e.message);
    assert.match(e.message, /\[redacted\]/);
    const raw = stubFetch(() => ({ status: 502, body: `bad gateway for Bearer ${KEY}` }));
    const e2 = await createResponsesProvider({ key: 'r' }, { apiKey: KEY, fetchImpl: raw.fetchImpl }).chat(req()).then(() => null, x => x);
    assert.ok(e2 instanceof ProviderError && e2.status === 502 && !e2.message.includes(KEY), e2.message);
});

t.run();
