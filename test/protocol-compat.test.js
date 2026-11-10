'use strict';
// AI Exchange H: the official-client compatibility fixtures for both wire protocols, with AI_MODEL_CATALOG on.
//
//   test/fixtures/protocol-compat/openai-chat-completions.json     OpenAI Chat Completions request / response / SSE shapes
//   test/fixtures/protocol-compat/anthropic-messages.json          Anthropic Messages request / message / named-SSE shapes
//
// Every fixture is replayed by a local fake upstream. The test then reads the answer exactly as an official client
// would: OpenAI's chat.completion / chat.completion.chunk + [DONE], Anthropic's message / message_start……message_stop.
// It asserts the protocol's own shape, usage, the x_openvibe disclosure (top-level and, on SSE, only the leading
// comment and the final chunk), and that an exact id is answered by its artifact or refused 400/404, never substituted.
// The aliases are exercised one by one in both protocols. The repo has no official openai / @anthropic-ai/sdk
// devDependency, so the fixtures go over HTTP; OpenVibe.Examples #55 covers the SDKs themselves.
const assert = require('assert');
const http = require('http');
const { boot, request, token, suite, ALL } = require('./helpers');
const openaiFixture = require('./fixtures/protocol-compat/openai-chat-completions.json');
const anthropicFixture = require('./fixtures/protocol-compat/anthropic-messages.json');

const t = suite('protocol-compat');
const service = token('live', ALL);
const ANTHROPIC_HEADERS = { 'anthropic-version': '2023-06-01' };

const ALPHA_ID = 'acme/m1:q4_k_m@rev1';
const BETA_ID = 'acme/m2@rev2';
const LOCAL_ID = 'acme/local@revL';
const DELTA_ID = 'anthropic/claude-test@revA';
const DELTA_LOCAL_ID = 'anthropic/claude-local@revB';
const IDS = { alpha: ALPHA_ID, beta: BETA_ID, local: LOCAL_ID, delta: DELTA_ID, 'delta-local': DELTA_LOCAL_ID };

let h;
let alpha;
let beta;
let local;
let delta;
let deltaLocal;

/* ── fake upstreams: replay one fixture scenario over the real wire protocol ───────────────── */
async function fakeUpstream(protocol, fixture) {
    const state = { calls: [], scenario: 'text', url: null };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
            state.calls.push({ url: req.url, body });
            const scenario = fixture.scenarios[state.scenario];
            if (!scenario) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: `no fixture scenario ${state.scenario}` }));
            }
            if (body.stream) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                if (protocol === 'openai') {
                    for (const chunk of scenario.stream) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    res.write('data: [DONE]\n\n');
                } else {
                    for (const frame of scenario.stream) res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
                }
                return res.end();
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(scenario.response));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    state.url = `http://127.0.0.1:${server.address().port}`;
    state.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
    return state;
}

const callCounts = () => [alpha.calls.length, beta.calls.length, local.calls.length, delta.calls.length, deltaLocal.calls.length];
const scenario = (upstream, name) => { upstream.scenario = name; };

/* ── reading the answer the way an official client does ───────────────────────────────────── */
const blocks = (text) => text.split('\n\n').filter((b) => b.trim());
const comment = (block) => {
    assert.match(block, /^: x_openvibe /, 'the leading block is the disclosure comment');
    return JSON.parse(block.slice(': x_openvibe '.length));
};
function parseOpenAiSse(text) {
    const all = blocks(text);
    const comments = all.filter((b) => b.startsWith(': '));
    const data = all.filter((b) => b.startsWith('data: ')).map((b) => b.slice('data: '.length));
    const done = data.length > 0 && data[data.length - 1] === '[DONE]';
    const chunks = data.filter((d) => d !== '[DONE]').map((d) => JSON.parse(d));
    return { all, comments, chunks, done };
}
function parseAnthropicSse(text) {
    const all = blocks(text);
    const comments = all.filter((b) => b.startsWith(': '));
    const frames = [];
    for (const block of all) {
        const e = /^event: (.+)$/m.exec(block);
        const d = /^data: (.*)$/m.exec(block);
        if (!e && !d) continue;
        assert.ok(e && d, `a complete named SSE frame: ${block}`);
        frames.push({ event: e[1].trim(), data: JSON.parse(d[1]) });
    }
    return { all, comments, frames };
}

function assertRouteDisclosure(x) {
    assert.ok(x && typeof x === 'object', 'the disclosure is an object');
    for (const k of ['resolved_model', 'revision', 'deployment', 'provider_access', 'rate_version', 'policy', 'fallback_reason']) {
        assert.ok(k in x, `x_openvibe.${k} is present`);
    }
}
function assertDisclosure(x) {
    assertRouteDisclosure(x);
    for (const k of ['run_id', 'provider', 'fallback_used', 'cost_usd']) assert.ok(k in x, `x_openvibe.${k} is present`);
    assert.match(String(x.run_id), /^run_/);
}

function assertOpenAiJson(body, expected) {
    assert.strictEqual(body.object, 'chat.completion');
    assert.match(body.id, /^chatcmpl-run_/);
    assert.strictEqual(typeof body.created, 'number');
    assert.strictEqual(body.model, expected.response.model);
    assert.strictEqual(body.system_fingerprint, expected.response.system_fingerprint);
    assert.deepStrictEqual(body.choices, expected.response.choices, 'the upstream choices are passed through untranslated');
    assert.ok(body.usage, 'usage is present');
    assert.deepStrictEqual(
        [body.usage.prompt_tokens, body.usage.completion_tokens, body.usage.total_tokens],
        [expected.response.usage.prompt_tokens, expected.response.usage.completion_tokens, expected.response.usage.total_tokens]
    );
    assertDisclosure(body.x_openvibe);
    assert.strictEqual(body.x_openvibe.run_id, body.id.slice('chatcmpl-'.length));
    assert.ok(!JSON.stringify(body.choices).includes('x_openvibe'), 'x_openvibe never rides inside choices');
}

function assertOpenAiStream(parsed, expected) {
    assert.strictEqual(parsed.comments.length, 1, 'exactly one SSE comment');
    assert.match(parsed.all[0], /^: x_openvibe /, 'the disclosure is the leading SSE block');
    const head = comment(parsed.comments[0]);
    assertRouteDisclosure(head);
    assert.ok(parsed.done, '[DONE] is last');
    assert.ok(!parsed.all.some((b) => /^event:/m.test(b)), 'OpenAI SSE carries no event names');
    assert.ok(parsed.chunks.length >= 2, 'deltas, then the final chunk');
    assert.ok(parsed.chunks.every((c) => c.object === 'chat.completion.chunk' && Array.isArray(c.choices)), 'chat.completion.chunk frames');
    const last = parsed.chunks[parsed.chunks.length - 1];
    assert.ok(last.x_openvibe, 'the final chunk carries x_openvibe');
    assert.deepStrictEqual(last.choices, []);
    assert.ok(parsed.chunks.slice(0, -1).every((c) => !('x_openvibe' in c)), 'only the final chunk carries x_openvibe');
    assert.ok(!JSON.stringify(parsed.chunks.map((c) => c.choices)).includes('x_openvibe'), 'x_openvibe never rides inside choices');
    assert.deepStrictEqual(
        parsed.chunks.filter((c) => c.choices.length).map((c) => c.choices),
        expected.stream.filter((c) => c.choices.length).map((c) => c.choices),
        'the upstream deltas are passed through in order'
    );
    const usage = parsed.chunks.find((c) => c.usage);
    assert.ok(usage, 'usage is present when stream_options.include_usage is asked');
    assert.deepStrictEqual(
        [usage.usage.prompt_tokens, usage.usage.completion_tokens, usage.usage.total_tokens],
        [expected.response.usage.prompt_tokens, expected.response.usage.completion_tokens, expected.response.usage.total_tokens]
    );
    assert.ok(parsed.chunks.indexOf(last) > parsed.chunks.indexOf(usage), 'x_openvibe is on the final chunk, after usage');
    assertDisclosure(last.x_openvibe);
    assert.deepStrictEqual(
        [head.resolved_model, head.deployment, head.provider_access, head.policy],
        [last.x_openvibe.resolved_model, last.x_openvibe.deployment, last.x_openvibe.provider_access, last.x_openvibe.policy],
        'the comment and the final chunk disclose the same route'
    );
}

function assertAnthropicJson(body, expected) {
    assert.deepStrictEqual([body.type, body.role], ['message', 'assistant']);
    assert.strictEqual(body.id, 'msg_' + body.x_openvibe.run_id, 'gateway ids support generation lookup');
    assert.strictEqual(body.model, expected.response.model);
    assert.deepStrictEqual(body.content, expected.response.content, 'the upstream content blocks are passed through untranslated');
    assert.strictEqual(body.stop_reason, expected.response.stop_reason);
    assert.strictEqual(body.stop_sequence, expected.response.stop_sequence);
    assert.deepStrictEqual(
        [body.usage.input_tokens, body.usage.output_tokens],
        [expected.response.usage.input_tokens, expected.response.usage.output_tokens]
    );
    assertDisclosure(body.x_openvibe);
    assert.ok(!JSON.stringify(body.content).includes('x_openvibe'), 'x_openvibe never rides inside content');
}

function assertAnthropicStream(parsed, expected) {
    assert.strictEqual(parsed.comments.length, 1, 'exactly one SSE comment');
    assert.match(parsed.all[0], /^: x_openvibe /, 'the disclosure is the leading SSE block');
    const head = comment(parsed.comments[0]);
    assertRouteDisclosure(head);
    const last = parsed.frames[parsed.frames.length - 1];
    assert.ok(parsed.frames.length >= 2, 'message_start through message_stop');
    assert.deepStrictEqual(parsed.frames.map((f) => f.event), expected.stream.map((f) => f.event), 'the named events, in protocol order');
    const expectedEvents = expected.stream.slice(0, -1).map(f => f.event === 'message_start'
        ? { ...f.data, message: { ...f.data.message, id: 'msg_' + last.data.x_openvibe.run_id } } : f.data);
    assert.deepStrictEqual(parsed.frames.slice(0, -1).map((f) => f.data), expectedEvents, 'events pass through with the gateway generation id');
    assert.ok(parsed.frames.every((f) => f.event === f.data.type), 'the event name matches the data type');
    assert.deepStrictEqual([last.event, last.data.type], ['message_stop', 'message_stop']);
    assert.ok(last.data.x_openvibe, 'message_stop carries x_openvibe');
    assert.ok(parsed.frames.slice(0, -1).every((f) => !('x_openvibe' in f.data)), 'only message_stop carries x_openvibe');
    assert.ok(!JSON.stringify(parsed.frames.map((f) => f.data.content_block || {})).includes('x_openvibe'), 'x_openvibe never rides inside a content block');
    const start = parsed.frames.find((f) => f.event === 'message_start');
    const stop = parsed.frames.find((f) => f.event === 'message_delta');
    assert.strictEqual(start.data.message.usage.input_tokens, expected.response.usage.input_tokens, 'input usage is present on message_start');
    assert.strictEqual(stop.data.usage.output_tokens, expected.response.usage.output_tokens, 'output usage is present on message_delta');
    assert.strictEqual(stop.data.delta.stop_reason, expected.response.stop_reason);
    assertDisclosure(last.data.x_openvibe);
    assert.deepStrictEqual(
        [head.resolved_model, head.deployment, head.provider_access, head.policy],
        [last.data.x_openvibe.resolved_model, last.data.x_openvibe.deployment, last.data.x_openvibe.provider_access, last.data.x_openvibe.policy],
        'the comment and message_stop disclose the same route'
    );
}

/* ── HTTP helpers ──────────────────────────────────────────────────────────────────────────── */
const post = (path, body, headers = {}) => request(h.base, 'POST', path, { tok: service, body, headers });
async function stream(path, body, headers = {}) {
    const res = await fetch(`${h.base}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${service}`, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    return { res, text: await res.text() };
}

/* ── boot ──────────────────────────────────────────────────────────────────────────────────── */
t.test('boot: the catalog is on, with an exact artifact for each protocol and a local private one', async () => {
    [alpha, beta, local] = await Promise.all([fakeUpstream('openai', openaiFixture), fakeUpstream('openai', openaiFixture), fakeUpstream('openai', openaiFixture)]);
    [delta, deltaLocal] = await Promise.all([fakeUpstream('anthropic', anthropicFixture), fakeUpstream('anthropic', anthropicFixture)]);
    h = await boot({ env: { AI_MODEL_CATALOG: '1', AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0' } });
    const providers = [
        { key: 'alpha', kind: 'openai', base_url: `${alpha.url}/v1`, auth_mode: 'none', capabilities: ['chat', 'complete', 'tools', 'json'], default_model: 'alpha-1', provider_access: 'OWN_DEPLOYMENT' },
        { key: 'beta', kind: 'openai', base_url: `${beta.url}/v1`, auth_mode: 'none', capabilities: ['chat', 'complete', 'tools', 'json'], default_model: 'beta-1', provider_access: 'AUTHORIZED_WHOLESALE' },
        { key: 'local', kind: 'openai', base_url: `${local.url}/v1`, auth_mode: 'none', capabilities: ['chat', 'complete', 'tools', 'json'], default_model: 'local-1', provider_access: 'OWN_DEPLOYMENT', metadata: { local: true } },
        { key: 'delta', kind: 'anthropic', base_url: delta.url, auth_mode: 'none', capabilities: ['chat', 'messages', 'tools', 'json'], default_model: 'delta-1', provider_access: 'OWN_DEPLOYMENT' },
        { key: 'delta-local', kind: 'anthropic', base_url: deltaLocal.url, auth_mode: 'none', capabilities: ['chat', 'messages', 'tools', 'json'], default_model: 'delta-local-1', provider_access: 'OWN_DEPLOYMENT', metadata: { local: true } },
    ];
    for (const provider of providers) {
        const made = await request(h.base, 'POST', '/api/v1/providers', { tok: service, body: provider });
        assert.strictEqual(made.status, 201, made.text);
    }
    const cost = (input, output) => ({ in_per_mtok: input, out_per_mtok: output, cached_per_mtok: input / 10, source: 'https://example.com/pricing', verified_at: '2026-11-01' });
    const models = [
        { provider_key: 'alpha', model_key: 'alpha-1', metadata: { org: 'acme', model: 'm1', quant: 'q4_k_m', revision: 'rev1', family: 'm', variant: 'original', license: 'mit', rate_version: 'rr-alpha' }, cost: cost(1, 2) },
        { provider_key: 'beta', model_key: 'beta-1', metadata: { org: 'acme', model: 'm2', revision: 'rev2', rate_version: 'rr-beta' }, cost: cost(5, 10) },
        { provider_key: 'local', model_key: 'local-1', metadata: { org: 'acme', model: 'local', revision: 'revL', rate_version: 'rr-local' }, cost: cost(10, 20) },
        { provider_key: 'delta', model_key: 'delta-1', metadata: { org: 'anthropic', model: 'claude-test', revision: 'revA', rate_version: 'rr-delta' }, cost: cost(3, 6) },
        { provider_key: 'delta-local', model_key: 'delta-local-1', metadata: { org: 'anthropic', model: 'claude-local', revision: 'revB', rate_version: 'rr-delta-local' }, cost: cost(4, 8) },
    ];
    for (const model of models) {
        const made = await request(h.base, 'POST', '/api/v1/models', {
            tok: service,
            body: { type: 'chat', status: 'active', context_window: 32768, max_output: 4096, supports: { json: true, tools: true, streaming: true, vision: false }, ...model },
        });
        assert.strictEqual(made.status, 201, made.text);
    }
    // The aliases resolve through the same catalog.
    for (const id of [...Object.values(IDS)]) {
        const found = await request(h.base, 'GET', `/v1/models/${encodeURIComponent(id)}`, { tok: service });
        assert.strictEqual(found.status, 200, `${id}: ${found.text}`);
    }
});

/* ── OpenAI: every fixture, non-streamed and streamed ─────────────────────────────────────── */
t.test('OpenAI Chat Completions: text, tool call, tool result, json_object, json_schema, multi-turn, exact id — JSON and SSE', async () => {
    const before = callCounts();
    for (const name of ['text', 'tool_call', 'tool_result', 'json_object', 'json_schema', 'multi_turn', 'exact_id']) {
        const expected = openaiFixture.scenarios[name];
        scenario(alpha, name);

        const plain = await post('/v1/chat/completions', expected.request);
        assert.strictEqual(plain.status, 200, `${name}: ${plain.text}`);
        assertOpenAiJson(plain.body, expected);
        const sent = alpha.calls[alpha.calls.length - 1].body;
        assert.strictEqual(sent.model, 'alpha-1', `${name}: the exact artifact's own model ran`);
        assert.deepStrictEqual(sent.messages, expected.request.messages, `${name}: messages pass through as written`);
        if (expected.request.tools) assert.deepStrictEqual(sent.tools, expected.request.tools, `${name}: tools pass through`);
        if (expected.request.tool_choice !== undefined) assert.deepStrictEqual(sent.tool_choice, expected.request.tool_choice, `${name}: tool_choice passes through`);
        if (expected.request.response_format) assert.deepStrictEqual(sent.response_format, expected.request.response_format, `${name}: response_format passes through`);

        scenario(alpha, name);
        const streamed = await stream('/v1/chat/completions', expected.stream_request);
        assert.strictEqual(streamed.res.status, 200, `${name} stream: ${streamed.text}`);
        assert.match(streamed.res.headers.get('content-type'), /^text\/event-stream/);
        const parsed = parseOpenAiSse(streamed.text);
        assertOpenAiStream(parsed, expected);
        const sentStream = alpha.calls[alpha.calls.length - 1].body;
        assert.deepStrictEqual([sentStream.stream, sentStream.stream_options], [true, { include_usage: true }], `${name}: the upstream is asked to stream its usage`);
        assert.deepStrictEqual(sentStream.messages, expected.stream_request.messages);
        if (expected.stream_request.response_format) assert.deepStrictEqual(sentStream.response_format, expected.stream_request.response_format);
    }
    assert.strictEqual(alpha.calls.length, before[0] + 14, 'alpha answered every OpenAI fixture');
    assert.deepStrictEqual([beta.calls.length, local.calls.length, delta.calls.length, deltaLocal.calls.length], [before[1], before[2], before[3], before[4]], 'the exact id never substituted another provider');
});

/* ── OpenAI exact ids: 404, 400, no substitution ──────────────────────────────────────────── */
t.test('OpenAI exact ids: an unknown id is 404, an unavailable one is 400, and neither falls back', async () => {
    // Missing: every provider is up, so a substitution would be visible.
    const beforeMissing = callCounts();
    for (const body of [openaiFixture.refusals.exact_missing.request, openaiFixture.refusals.exact_missing.stream_request]) {
        const res = await post('/v1/chat/completions', body);
        assert.strictEqual(res.status, 404, res.text);
        assert.strictEqual(res.body.error.code, 'ai.model_not_found');
        assert.strictEqual(res.body.error.type, 'invalid_request_error');
        assert.match(res.headers.get('content-type'), /application\/json/, 'a refused exact id is an HTTP error, not an SSE stream');
    }
    assert.deepStrictEqual(callCounts(), beforeMissing, 'the unknown artifact called no provider');

    // Unavailable: the artifact exists, but its only deployment is disabled; the other providers stay up.
    const beforeUnavailable = callCounts();
    assert.strictEqual((await request(h.base, 'POST', '/api/v1/providers/alpha/disable', { tok: service, body: {} })).status, 200);
    try {
        for (const body of [openaiFixture.refusals.exact_unavailable.request, openaiFixture.refusals.exact_unavailable.stream_request]) {
            const res = await post('/v1/chat/completions', body);
            assert.strictEqual(res.status, 400, res.text);
            assert.strictEqual(res.body.error.code, 'ai.model_unavailable');
            assert.strictEqual(res.body.error.type, 'invalid_request_error');
            assert.match(res.headers.get('content-type'), /application\/json/, 'a refused exact id is an HTTP error, not an SSE stream');
        }
    } finally {
        assert.strictEqual((await request(h.base, 'POST', '/api/v1/providers/alpha/enable', { tok: service, body: {} })).status, 200);
    }
    assert.deepStrictEqual(callCounts(), beforeUnavailable, 'the unavailable artifact fell back to no provider');

    scenario(alpha, 'exact_id');
    const exact = await post('/v1/chat/completions', openaiFixture.scenarios.exact_id.request);
    assert.strictEqual(exact.status, 200, exact.text);
    assert.deepStrictEqual(
        [exact.body.x_openvibe.resolved_model, exact.body.x_openvibe.deployment, exact.body.x_openvibe.policy],
        [ALPHA_ID, 'alpha', 'exact'],
        'the exact artifact answered, and the disclosure says so'
    );
});

/* ── OpenAI aliases: each one, JSON and SSE ───────────────────────────────────────────────── */
t.test('OpenAI aliases: every dynamic alias answers, and x_openvibe names its policy', async () => {
    for (const upstream of [alpha, beta, local]) scenario(upstream, 'text');
    const base = openaiFixture.scenarios.text.request;
    for (const alias of openaiFixture.aliases) {
        const before = callCounts();
        const body = { ...base, model: alias.model };
        const plain = await post('/v1/chat/completions', body);
        assert.strictEqual(plain.status, 200, `${alias.model}: ${plain.text}`);
        assertOpenAiJson(plain.body, openaiFixture.scenarios.text);
        assert.strictEqual(plain.body.x_openvibe.policy, alias.policy, `${alias.model}: the alias policy is disclosed`);
        assert.strictEqual(plain.body.x_openvibe.resolved_model, IDS[plain.body.x_openvibe.deployment], `${alias.model}: resolved_model matches the deployment`);
        const after = callCounts();
        const increased = ['alpha', 'beta', 'local'].filter((key, i) => after[i] === before[i] + 1);
        assert.strictEqual(increased.length, 1, `${alias.model}: exactly one provider answered`);
        assert.strictEqual(increased[0], plain.body.x_openvibe.deployment, `${alias.model}: the disclosed deployment answered`);
        if (alias.deployment) assert.strictEqual(plain.body.x_openvibe.deployment, alias.deployment, `${alias.model}: private stays local`);
        assert.deepStrictEqual([after[3], after[4]], [before[3], before[4]], `${alias.model}: no Anthropic upstream was called`);

        const streamed = await stream('/v1/chat/completions', { ...body, stream: true, stream_options: { include_usage: true } });
        assert.strictEqual(streamed.res.status, 200, `${alias.model} stream: ${streamed.text}`);
        const parsed = parseOpenAiSse(streamed.text);
        assertOpenAiStream(parsed, openaiFixture.scenarios.text);
        assert.strictEqual(comment(parsed.comments[0]).policy, alias.policy, `${alias.model}: the leading comment discloses the alias policy`);
        assert.strictEqual(parsed.chunks[parsed.chunks.length - 1].x_openvibe.policy, alias.policy);
        if (alias.deployment) assert.strictEqual(parsed.chunks[parsed.chunks.length - 1].x_openvibe.deployment, alias.deployment);
    }
});

/* ── Anthropic: every fixture, non-streamed and streamed ──────────────────────────────────── */
t.test('Anthropic Messages: text, tool_use, tool_result, structured JSON tool, multi-turn, exact id — message and named SSE', async () => {
    const before = callCounts();
    for (const name of ['text', 'tool_use', 'tool_result', 'json_structured', 'multi_turn', 'exact_id']) {
        const expected = anthropicFixture.scenarios[name];
        scenario(delta, name);

        const plain = await post('/v1/messages', expected.request, ANTHROPIC_HEADERS);
        assert.strictEqual(plain.status, 200, `${name}: ${plain.text}`);
        assertAnthropicJson(plain.body, expected);
        const sent = delta.calls[delta.calls.length - 1].body;
        assert.strictEqual(sent.model, 'delta-1', `${name}: the exact artifact's own model ran`);
        assert.deepStrictEqual(sent.messages, expected.request.messages, `${name}: messages pass through as written`);
        if (expected.request.system !== undefined) assert.deepStrictEqual(sent.system, expected.request.system, `${name}: the system prompt passes through`);
        if (expected.request.tools) assert.deepStrictEqual(sent.tools, expected.request.tools, `${name}: tools pass through`);
        if (expected.request.tool_choice !== undefined) assert.deepStrictEqual(sent.tool_choice, expected.request.tool_choice, `${name}: tool_choice passes through`);

        scenario(delta, name);
        const streamed = await stream('/v1/messages', expected.stream_request, ANTHROPIC_HEADERS);
        assert.strictEqual(streamed.res.status, 200, `${name} stream: ${streamed.text}`);
        assert.match(streamed.res.headers.get('content-type'), /^text\/event-stream/);
        const parsed = parseAnthropicSse(streamed.text);
        assertAnthropicStream(parsed, expected);
        const sentStream = delta.calls[delta.calls.length - 1].body;
        assert.strictEqual(sentStream.stream, true);
        assert.deepStrictEqual(sentStream.messages, expected.stream_request.messages);
    }
    assert.strictEqual(delta.calls.length, before[3] + 12, 'delta answered every Anthropic fixture');
    assert.deepStrictEqual([alpha.calls.length, beta.calls.length, local.calls.length, deltaLocal.calls.length], [before[0], before[1], before[2], before[4]], 'the exact id never substituted another provider');
});

/* ── Anthropic exact ids: 404, 400, no substitution ───────────────────────────────────────── */
t.test('Anthropic exact ids: an unknown id is 404, an unavailable one is 400, and neither falls back', async () => {
    // Missing: every provider is up, so a substitution would be visible.
    const beforeMissing = callCounts();
    for (const body of [anthropicFixture.refusals.exact_missing.request, anthropicFixture.refusals.exact_missing.stream_request]) {
        const res = await post('/v1/messages', body, ANTHROPIC_HEADERS);
        assert.strictEqual(res.status, 404, res.text);
        assert.strictEqual(res.body.type, 'error');
        assert.deepStrictEqual([res.body.error.type, res.body.error.code], ['not_found_error', 'ai.model_not_found']);
        assert.ok(!res.headers.get('content-type').startsWith('text/event-stream'), 'a refused exact id is an HTTP error, not an SSE stream');
    }
    assert.deepStrictEqual(callCounts(), beforeMissing, 'the unknown artifact called no provider');

    // Unavailable: the artifact exists, but its only deployment is disabled; the other providers stay up.
    const beforeUnavailable = callCounts();
    assert.strictEqual((await request(h.base, 'POST', '/api/v1/providers/delta/disable', { tok: service, body: {} })).status, 200);
    try {
        for (const body of [anthropicFixture.refusals.exact_unavailable.request, anthropicFixture.refusals.exact_unavailable.stream_request]) {
            const res = await post('/v1/messages', body, ANTHROPIC_HEADERS);
            assert.strictEqual(res.status, 400, res.text);
            assert.strictEqual(res.body.type, 'error');
            assert.deepStrictEqual([res.body.error.type, res.body.error.code], ['invalid_request_error', 'ai.model_unavailable']);
            assert.ok(!res.headers.get('content-type').startsWith('text/event-stream'), 'a refused exact id is an HTTP error, not an SSE stream');
        }
    } finally {
        assert.strictEqual((await request(h.base, 'POST', '/api/v1/providers/delta/enable', { tok: service, body: {} })).status, 200);
    }
    assert.deepStrictEqual(callCounts(), beforeUnavailable, 'the unavailable artifact fell back to no provider');

    scenario(delta, 'exact_id');
    const exact = await post('/v1/messages', anthropicFixture.scenarios.exact_id.request, ANTHROPIC_HEADERS);
    assert.strictEqual(exact.status, 200, exact.text);
    assert.deepStrictEqual(
        [exact.body.x_openvibe.resolved_model, exact.body.x_openvibe.deployment, exact.body.x_openvibe.policy],
        [DELTA_ID, 'delta', 'exact'],
        'the exact artifact answered, and the disclosure says so'
    );
});

/* ── Anthropic aliases: each one, message and SSE ─────────────────────────────────────────── */
t.test('Anthropic aliases: every dynamic alias answers, and x_openvibe names its policy', async () => {
    for (const upstream of [delta, deltaLocal]) scenario(upstream, 'text');
    const base = anthropicFixture.scenarios.text.request;
    for (const alias of anthropicFixture.aliases) {
        const before = callCounts();
        const body = { ...base, model: alias.model };
        const plain = await post('/v1/messages', body, ANTHROPIC_HEADERS);
        assert.strictEqual(plain.status, 200, `${alias.model}: ${plain.text}`);
        assertAnthropicJson(plain.body, anthropicFixture.scenarios.text);
        assert.strictEqual(plain.body.x_openvibe.policy, alias.policy, `${alias.model}: the alias policy is disclosed`);
        assert.strictEqual(plain.body.x_openvibe.resolved_model, IDS[plain.body.x_openvibe.deployment], `${alias.model}: resolved_model matches the deployment`);
        const after = callCounts();
        const increased = ['delta', 'delta-local'].filter((key, i) => after[i + 3] === before[i + 3] + 1);
        assert.strictEqual(increased.length, 1, `${alias.model}: exactly one provider answered`);
        assert.strictEqual(increased[0], plain.body.x_openvibe.deployment, `${alias.model}: the disclosed deployment answered`);
        if (alias.deployment) assert.strictEqual(plain.body.x_openvibe.deployment, alias.deployment, `${alias.model}: private stays local`);
        assert.deepStrictEqual([after[0], after[1], after[2]], [before[0], before[1], before[2]], `${alias.model}: no OpenAI upstream was called`);

        const streamed = await stream('/v1/messages', { ...body, stream: true }, ANTHROPIC_HEADERS);
        assert.strictEqual(streamed.res.status, 200, `${alias.model} stream: ${streamed.text}`);
        const parsed = parseAnthropicSse(streamed.text);
        assertAnthropicStream(parsed, anthropicFixture.scenarios.text);
        const last = parsed.frames[parsed.frames.length - 1];
        assert.strictEqual(comment(parsed.comments[0]).policy, alias.policy, `${alias.model}: the leading comment discloses the alias policy`);
        assert.strictEqual(last.data.x_openvibe.policy, alias.policy);
        if (alias.deployment) assert.strictEqual(last.data.x_openvibe.deployment, alias.deployment);
    }
});

t.test('stop', async () => {
    await h.stop();
    await Promise.all([alpha.close(), beta.close(), local.close(), delta.close(), deltaLocal.close()]);
});

t.run();
