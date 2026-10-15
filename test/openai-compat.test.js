'use strict';
// The OpenAI-compatible endpoint (server/api/openai.js): POST /v1/chat/completions answers OpenAI's Chat Completions shape
// from a run of ai.complete — text, tool calls and a tool-result round trip, emulated streaming as chunks then [DONE], an
// app token whose run is its project's, OpenAI-shaped errors (no token, bad body), GET /v1/models; and the OpenAI-format
// adapter's complete() passes tools, tool_choice and the tool messages through as written, mapping max_tokens to
// max_completion_tokens (and dropping sampling knobs) for a reasoning model.
const assert = require('assert');
const { boot, request, token, suite, ALL } = require('./helpers');
const { createOpenAiProvider } = require('../server/providers/openai');

const t = suite('openai-compat');
const service = token('live', ALL);
const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const app = token('app', ['ai.app.run'], { sub: `app:app_${PRJ.slice(4)}`, actorType: 'app', ns: [PRJ, `app.${PRJ}.*`], extra: { project_id: PRJ, env: 'production' } });
const WEATHER = { type: 'function', function: { name: 'get_weather', description: 'Weather for a city', parameters: { type: 'object', required: ['city'], properties: { city: { type: 'string' } } } } };
let h;
const post = (body, tok = service) => request(h.base, 'POST', '/v1/chat/completions', { tok, body });

t.test('boot', async () => { h = await boot(); });

t.test('a plain chat answers the Chat Completions shape, with usage and the run it was', async () => {
    const r = await post({ model: 'openvibe', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Say hello' }] });
    assert.strictEqual(r.status, 200, r.text);
    const c = r.body;
    assert.strictEqual(c.object, 'chat.completion');
    assert.match(c.id, /^chatcmpl-run_/);
    assert.strictEqual(c.choices[0].message.role, 'assistant');
    assert.strictEqual(typeof c.choices[0].message.content, 'string');
    assert.strictEqual(c.choices[0].finish_reason, 'stop');
    assert.ok(c.usage.prompt_tokens > 0 && c.usage.total_tokens === c.usage.prompt_tokens + c.usage.completion_tokens);
    assert.ok(c.x_openvibe.run_id && c.x_openvibe.provider);
    assert.strictEqual(r.headers.get('x-openvibe-run-id'), c.x_openvibe.run_id);
    const run = await request(h.base, 'GET', `/api/v1/runs/${c.x_openvibe.run_id}`, { tok: service });
    assert.strictEqual(run.body.run.workflow.key, 'ai.complete');
    assert.ok(!JSON.stringify(run.body.run.input || {}).includes('Say hello'), 'the prompt is not kept');
});

t.test('tools: the model calls one; the tool result goes back and it answers', async () => {
    const msgs = [{ role: 'user', content: 'Weather in Lisbon?' }];
    const first = await post({ model: 'openvibe', messages: msgs, tools: [WEATHER], tool_choice: 'auto' });
    assert.strictEqual(first.status, 200, first.text);
    const choice = first.body.choices[0];
    assert.strictEqual(choice.finish_reason, 'tool_calls');
    const call = choice.message.tool_calls[0];
    assert.strictEqual(call.type, 'function');
    assert.strictEqual(call.function.name, 'get_weather');
    assert.ok(JSON.parse(call.function.arguments).city !== undefined, 'arguments follow the parameters schema');
    const second = await post({ model: 'openvibe', tools: [WEATHER], messages: [...msgs, choice.message, { role: 'tool', tool_call_id: call.id, content: '19 C and sunny' }] });
    assert.strictEqual(second.status, 200, second.text);
    assert.strictEqual(second.body.choices[0].finish_reason, 'stop');
    assert.match(second.body.choices[0].message.content, /19 C and sunny/);
});

t.test('stream: chunks with the delta, then finish_reason, usage on request, then [DONE]', async () => {
    const res = await fetch(`${h.base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openvibe', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Stream please' }] }) });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const lines = (await res.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
    assert.strictEqual(lines[lines.length - 1], '[DONE]');
    const chunks = lines.slice(0, -1).map((l) => JSON.parse(l));
    assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk'));
    assert.strictEqual(chunks[0].choices[0].delta.role, 'assistant');
    assert.strictEqual(typeof chunks[0].choices[0].delta.content, 'string');
    assert.strictEqual(chunks[1].choices[0].finish_reason, 'stop');
    assert.ok(chunks.some((c) => c.usage && c.usage.total_tokens > 0), 'usage when asked');
});

t.test('an app token works, and its run is its project\'s', async () => {
    const r = await post({ model: 'openvibe', messages: [{ role: 'user', content: 'From an app' }] }, app);
    assert.strictEqual(r.status, 200, r.text);
    const run = await request(h.base, 'GET', `/api/v1/runs/${r.body.x_openvibe.run_id}`, { tok: service });
    assert.match(JSON.stringify(run.body.run.attribution || {}), new RegExp(PRJ));
});

t.test('errors come in OpenAI\'s shape: no token, no messages, n > 1', async () => {
    const none = await request(h.base, 'POST', '/v1/chat/completions', { body: { messages: [{ role: 'user', content: 'x' }] } });
    assert.strictEqual(none.status, 401);
    assert.strictEqual(typeof none.body.error.message, 'string');
    assert.strictEqual(none.body.error.type, 'authentication_error');
    const empty = await post({ model: 'openvibe', messages: [] });
    assert.deepStrictEqual([empty.status, empty.body.error.type], [400, 'invalid_request_error']);
    assert.strictEqual((await post({ model: 'openvibe', n: 2, messages: [{ role: 'user', content: 'x' }] })).status, 400);
});

t.test('a provider may declare tools (and complete) in its capabilities', async () => {
    const r = await request(h.base, 'POST', '/api/v1/providers', { tok: service, body: { key: 'toolsup', kind: 'openai', base_url: 'https://upstream.example/v1', auth_mode: 'none', capabilities: ['chat', 'complete', 'tools'], default_model: 'm' } });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual(r.body.provider.capabilities, ['chat', 'complete', 'tools']);
    assert.strictEqual((await request(h.base, 'POST', '/api/v1/providers/toolsup/disable', { tok: service, body: {} })).status, 200, 'and is kept out of the way of the other checks');
});

t.test('GET /v1/models lists the router model', async () => {
    const r = await request(h.base, 'GET', '/v1/models', { tok: service });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.data.map((m) => m.id), ['openvibe']);
});

t.test('the OpenAI-format adapter passes the request through as written', async () => {
    const seen = [];
    const fetchImpl = async (url, opts) => {
        seen.push({ url, body: JSON.parse(opts.body) });
        return new Response(JSON.stringify({ model: 'up-1', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 7 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const p = createOpenAiProvider({ key: 'up', base_url: 'https://upstream.example/v1', capabilities: ['chat', 'tools'] }, { apiKey: 'k'.repeat(40), fetchImpl });
    assert.strictEqual(p.supports('complete'), true, 'complete follows chat');
    assert.strictEqual(p.supports('tools'), true);
    const messages = [{ role: 'user', content: 'Weather in Oslo?' }];
    const out = await p.complete({ model: 'gpt-4.1-mini', maxTokens: 300, temperature: 0.2, openai: { messages, tools: [WEATHER], tool_choice: 'required', parallel_tool_calls: false, top_p: 0.9 } });
    assert.strictEqual(seen[0].url, 'https://upstream.example/v1/chat/completions');
    assert.deepStrictEqual(seen[0].body, { model: 'gpt-4.1-mini', messages, tools: [WEATHER], tool_choice: 'required', parallel_tool_calls: false, top_p: 0.9, max_tokens: 300, temperature: 0.2 });
    assert.deepStrictEqual([out.model, out.usage.input, out.usage.output, out.completion.choices[0].finish_reason], ['up-1', 12, 7, 'tool_calls']);
    await p.complete({ model: 'gpt-5-nano', maxTokens: 300, temperature: 0.2, openai: { messages, top_p: 0.9 } });
    assert.deepStrictEqual(seen[1].body, { model: 'gpt-5-nano', messages, max_completion_tokens: 300 }, 'a reasoning model: max_completion_tokens, no sampling knobs');
    const plain = createOpenAiProvider({ key: 'local', capabilities: ['chat'] }, { fetchImpl });
    assert.strictEqual(plain.supports('tools'), false, 'tools are declared, never assumed');
});

t.test('close', async () => { await h.stop(); });
t.run();
