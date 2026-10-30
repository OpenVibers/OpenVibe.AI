'use strict';
// POST /v1/messages, Anthropic's Messages API on AI (Codes C3): a run of ai.messages behind the same Network-token auth,
// quotas, metering and audit as /v1/chat/completions.
//   - text, tools and a tool result pass through as written to an upstream that speaks Anthropic's format;
//   - stream: true answers Anthropic's own SSE events, in order, and the run ends with the whole message;
//   - x-openvibe-credential: <provider> uses the person's own key instead of the router, and that key never appears in a
//     response, a log line or an error;
//   - auth is refused without ai.run.create, and errors are Anthropic's shape.
const assert = require('assert');
const nodeHttp = require('http');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('messages-api');
const KEY = 'cd'.repeat(32);
const PERSON = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP7';
const PERSON_KEY = 'sk-ant-test-person-0123456789';
const service = token('live', ALL);
const noCap = token('live', ALL.filter((c) => c !== 'ai.run.create'));
const acting = token('codes', ALL, { extra: { on_behalf_of: PERSON } });
const manager = token('codes', [...ALL, 'ai.credential.manage'], { extra: { on_behalf_of: PERSON } });
const WEATHER = { name: 'get_weather', description: 'Weather for a city', input_schema: { type: 'object', required: ['city'], properties: { city: { type: 'string' } } } };

// A fake Anthropic upstream: a message in one piece, or Anthropic's SSE frames in order.
const upstream = { calls: [], mode: 'text', delayMs: 5 };
function messageFor(body) {
    if (upstream.mode === 'tool') {
        return { id: 'msg_tool_1', type: 'message', role: 'assistant', model: body.model, content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Lisbon' } },
        ], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 21, output_tokens: 9 } };
    }
    return { id: 'msg_test_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'Hello there' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 11, output_tokens: 2 } };
}
const FRAMES = [
    ['message_start', { type: 'message_start', message: { id: 'msg_stream_1', type: 'message', role: 'assistant', model: 'claude-test-1', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0 } } }],
    ['ping', { type: 'ping' }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
    ['message_stop', { type: 'message_stop' }],
];
async function startUpstream() {
    const server = nodeHttp.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', async () => {
            const body = JSON.parse(raw || '{}');
            upstream.calls.push({ url: req.url, headers: req.headers, body });
            if (body.stream) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                for (const [event, data] of FRAMES) {
                    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                    await new Promise((r) => setTimeout(r, upstream.delayMs));
                }
                return res.end();
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(messageFor(body)));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    upstream.url = `http://127.0.0.1:${server.address().port}`;
    upstream.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    return upstream;
}

// The person's own Anthropic key, answered in-process (the guarded fetch is replaced, as in credentials.test.js).
const ownCalls = [];
const credentialFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    ownCalls.push({ url, key: init.headers['x-api-key'], body });
    if (body.stream) {
        const frames = FRAMES.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
        return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(messageFor(body)), { status: 200, headers: { 'content-type': 'application/json' } });
};

const logs = [];
const capture = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
let h;

const sse = async (res) => {
    const text = await res.text();
    return text.split('\n\n').filter(Boolean).map((block) => {
        const e = /^event: (.+)$/m.exec(block);
        const d = /^data: (.*)$/m.exec(block);
        return { event: e && e[1].trim(), data: d ? JSON.parse(d[1]) : null };
    });
};
const post = (body, { tok = service, headers = {} } = {}) => fetch(`${h.base}/v1/messages`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

t.test('boot with a fake Anthropic upstream as the router\'s Messages provider', async () => {
    await startUpstream();
    h = await boot({ env: { AI_CREDENTIALS_KEY: KEY, AI_STUB_FALLBACK: 'false' }, credentialFetch, log: capture });
    const r = await request(h.base, 'POST', '/api/v1/providers', { tok: service, body: { key: 'anthropic-fake', kind: 'anthropic', base_url: upstream.url, auth_mode: 'none', default_model: 'claude-test-1', capabilities: ['chat', 'json'], timeout_ms: 5000 } });
    assert.strictEqual(r.status, 201, r.text);
});

t.test('a message answers Anthropic\'s shape, from a run of ai.messages that keeps no prompt', async () => {
    upstream.mode = 'text';
    const res = await post({ model: 'claude-sonnet-4-5', max_tokens: 64, system: 'Be brief.', messages: [{ role: 'user', content: 'Say hello' }] });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual([body.type, body.role, body.id], ['message', 'assistant', 'msg_test_1']);
    assert.deepStrictEqual(body.content, [{ type: 'text', text: 'Hello there' }]);
    assert.deepStrictEqual([body.stop_reason, body.usage.input_tokens, body.usage.output_tokens], ['end_turn', 11, 2]);
    const runId = res.headers.get('x-openvibe-run-id');
    assert.match(String(runId), /^run_/);
    const run = await request(h.base, 'GET', `/api/v1/runs/${runId}`, { tok: service });
    assert.strictEqual(run.body.run.workflow.key, 'ai.messages');
    assert.ok(!JSON.stringify(run.body.run.input || {}).includes('Say hello'), 'the prompt is not kept');
    // The caller's fields reached the upstream as written, with the routed model.
    const sent = upstream.calls[upstream.calls.length - 1].body;
    assert.deepStrictEqual([sent.model, sent.system, sent.max_tokens], ['claude-test-1', 'Be brief.', 64]);
    assert.deepStrictEqual(sent.messages, [{ role: 'user', content: 'Say hello' }]);
});

t.test('tools and tool_choice pass through; a tool_use comes back as Anthropic sends it', async () => {
    upstream.mode = 'tool';
    const res = await post({ max_tokens: 64, tools: [WEATHER], tool_choice: { type: 'auto' }, messages: [{ role: 'user', content: 'Weather in Lisbon?' }] });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.stop_reason, 'tool_use');
    assert.deepStrictEqual(body.content[1], { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Lisbon' } });
    const sent = upstream.calls[upstream.calls.length - 1].body;
    assert.deepStrictEqual([sent.tools, sent.tool_choice], [[WEATHER], { type: 'auto' }]);
    // The tool result goes back as a user content block, as Anthropic's clients send it.
    const second = await post({ max_tokens: 64, messages: [{ role: 'user', content: 'Weather in Lisbon?' }, { role: 'assistant', content: body.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '19 C and sunny' }] }] });
    assert.strictEqual(second.status, 200);
    assert.deepStrictEqual(upstream.calls[upstream.calls.length - 1].body.messages[2].content[0].type, 'tool_result');
    upstream.mode = 'text';
});

t.test('stream: Anthropic\'s events in order, and the run ends with the whole message', async () => {
    const res = await post({ max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'Stream please' }] });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const runId = res.headers.get('x-openvibe-run-id');
    const events = await sse(res);
    assert.deepStrictEqual(events.map((e) => e.event), FRAMES.map(([name]) => name));
    assert.deepStrictEqual(events[0].data.message.id, 'msg_stream_1');
    const text = events.filter((e) => e.data.type === 'content_block_delta').map((e) => e.data.delta.text).join('');
    assert.strictEqual(text, 'Hello there');
    assert.strictEqual(events[events.length - 1].data.type, 'message_stop');
    const run = await request(h.base, 'GET', `/api/v1/runs/${runId}`, { tok: service });
    assert.strictEqual(run.body.run.output.content[0].text, text, 'the run kept the whole answer the stream sent');
    assert.strictEqual(run.body.run.output.stop_reason, 'end_turn');
});

t.test('x-openvibe-credential: the person\'s own key, not the router\'s provider', async () => {
    let r = await request(h.base, 'PUT', `/api/v1/credentials/${PERSON}/anthropic`, { tok: manager, body: { key: PERSON_KEY, models: { chat: 'claude-test-1' } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(!r.text.includes(PERSON_KEY));
    const before = upstream.calls.length;
    // The person's subject comes from the token that acts for them (on_behalf_of).
    const res = await post({ max_tokens: 64, messages: [{ role: 'user', content: 'Say hello' }] }, { tok: acting, headers: { 'x-openvibe-credential': 'anthropic' } });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.content[0].text, 'Hello there');
    assert.strictEqual(upstream.calls.length, before, 'the router\'s provider was not called');
    const call = ownCalls[ownCalls.length - 1];
    assert.strictEqual(call.key, PERSON_KEY, 'the person\'s key was sent to their provider');
    assert.strictEqual(call.body.model, 'claude-test-1');
    assert.ok(!JSON.stringify(body).includes(PERSON_KEY), 'the key is not in the answer');
    const run = await request(h.base, 'GET', `/api/v1/runs/${res.headers.get('x-openvibe-run-id')}`, { tok: acting });
    assert.strictEqual(run.body.run.provenance.provider, `byo:codes:${PERSON}:anthropic`);
    // <provider>:<subject> names the person explicitly, without an on_behalf_of claim.
    const explicit = await post({ max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }, { tok: manager, headers: { 'x-openvibe-credential': `anthropic:${PERSON}` } });
    assert.strictEqual(explicit.status, 200);
    // A provider the credential does not speak is refused in Anthropic's shape.
    const wrong = await post({ max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }, { tok: acting, headers: { 'x-openvibe-credential': 'openai' } });
    assert.strictEqual(wrong.status, 404);
    assert.strictEqual((await wrong.json()).type, 'error');
    assert.ok(!logs.join('\n').includes(PERSON_KEY), 'the key is never in a log line');
    await request(h.base, 'DELETE', `/api/v1/credentials/${PERSON}/anthropic`, { tok: manager });
});

t.test('auth: a token without ai.run.create is refused, in Anthropic\'s error shape', async () => {
    let res = await fetch(`${h.base}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.strictEqual(res.status, 401);
    let body = await res.json();
    assert.deepStrictEqual([body.type, body.error.type], ['error', 'authentication_error']);
    res = await post({ max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }, { tok: noCap });
    assert.strictEqual(res.status, 403);
    body = await res.json();
    assert.deepStrictEqual([body.type, body.error.type], ['error', 'permission_error']);
    res = await post({ messages: [{ role: 'user', content: 'hi' }] }, { tok: service });
    assert.strictEqual(res.status, 400);
    body = await res.json();
    assert.deepStrictEqual([body.error.type, /max_tokens/.test(body.error.message)], ['invalid_request_error', true]);
});

t.test('stop', async () => { await upstream.close(); await h.stop(); });

t.run();
