'use strict';
// The OpenAI-compatible endpoint (server/api/openai.js): POST /v1/chat/completions answers OpenAI's Chat Completions shape
// from a run of ai.complete — text, tool calls and a tool-result round trip, emulated streaming as chunks then [DONE], an
// app token whose run is its project's, OpenAI-shaped errors (no token, bad body), GET /v1/models; and the OpenAI-format
// adapter's complete() passes tools, tool_choice and the tool messages through as written, mapping max_tokens to
// max_completion_tokens with room to think and low effort (and dropping sampling knobs) for a reasoning model.
const assert = require('assert');
const http = require('http');
const { boot, request, token, suite, ALL } = require('./helpers');
const { createOpenAiProvider } = require('../server/providers/openai');

const t = suite('openai-compat');
const service = token('live', ALL);
const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const app = token('app', ['ai.app.run'], { sub: `app:app_${PRJ.slice(4)}`, actorType: 'app', ns: [PRJ, `app.${PRJ}.*`], extra: { project_id: PRJ, env: 'production' } });
const WEATHER = { type: 'function', function: { name: 'get_weather', description: 'Weather for a city', parameters: { type: 'object', required: ['city'], properties: { city: { type: 'string' } } } } };
let h;
const post = (body, tok = service) => request(h.base, 'POST', '/v1/chat/completions', { tok, body });
const postJson = (path, body, tok = service) => request(h.base, 'POST', path, { tok, body });
const transcribe = async (fields = {}, file = { name: 'sample.wav', type: 'audio/wav', data: Buffer.from('RIFF....WAVEfmt ') }, tok = service) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
    form.append('file', new Blob([file.data], { type: file.type }), file.name);
    const res = await fetch(`${h.base}/v1/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: form });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.status, body, text, headers: res.headers };
};

// The free allowance (a service acting for a person) would be gated by AI_FREE_PROVIDERS; in tests the
// deterministic stub is the network's stand-in, so it is the named free-tier source.
t.test('boot', async () => { h = await boot({ env: { AI_FREE_PROVIDERS: 'stub' } }); });

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

const sse = async (res) => {
    const lines = (await res.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
    return { done: lines[lines.length - 1] === '[DONE]', chunks: lines.filter((l) => l !== '[DONE]').map((l) => JSON.parse(l)) };
};
const streamPost = (body, tok = service) => fetch(`${h.base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true, ...body }) });

t.test('stream: the deltas as they come, joined they are the answer; then finish, usage on request, x_openvibe, [DONE]', async () => {
    const res = await streamPost({ model: 'openvibe', stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Stream please' }] });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const runId = res.headers.get('x-openvibe-run-id');
    assert.match(String(runId), /^run_/);
    const { done, chunks } = await sse(res);
    assert.ok(done, '[DONE] last');
    assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk' && c.id === `chatcmpl-${runId}`));
    const deltas = chunks.filter((c) => c.choices.length && c.choices[0].delta && typeof c.choices[0].delta.content === 'string');
    assert.ok(deltas.length > 2, `streamed in pieces (${deltas.length})`);
    assert.strictEqual(deltas[0].choices[0].delta.role, 'assistant');
    const joined = deltas.map((c) => c.choices[0].delta.content).join('');
    const finish = chunks.findIndex((c) => c.choices.length && c.choices[0].finish_reason);
    assert.strictEqual(chunks[finish].choices[0].finish_reason, 'stop');
    assert.ok(finish > chunks.indexOf(deltas[deltas.length - 1]), 'the finish comes after the last delta');
    assert.ok(chunks.some((c) => c.usage && c.usage.total_tokens > 0), 'usage when asked');
    assert.strictEqual(chunks.find((c) => c.x_openvibe).x_openvibe.run_id, runId);
    const run = await request(h.base, 'GET', `/api/v1/runs/${runId}`, { tok: service });
    assert.strictEqual(run.body.run.output.choices[0].message.content, joined, 'the run kept the whole answer the stream sent');
});

t.test('stream: a tool call arrives as its id and name, then its arguments in pieces, and they join into valid JSON', async () => {
    const { chunks } = await sse(await streamPost({ messages: [{ role: 'user', content: 'Weather in Lisbon?' }], tools: [WEATHER] }));
    const calls = chunks.flatMap((c) => (c.choices[0] && c.choices[0].delta && c.choices[0].delta.tool_calls) || []);
    assert.ok(calls.length > 2, 'in pieces');
    assert.strictEqual(calls[0].function.name, 'get_weather');
    assert.match(calls[0].id, /^call_/);
    assert.ok(JSON.parse(calls.map((t) => (t.function && t.function.arguments) || '').join('')), 'the arguments join into JSON');
    assert.strictEqual(chunks.find((c) => c.choices[0] && c.choices[0].finish_reason).choices[0].finish_reason, 'tool_calls');
});

t.test('an app token works, and its run is its project\'s', async () => {
    const r = await post({ model: 'openvibe', messages: [{ role: 'user', content: 'From an app' }] }, app);
    assert.strictEqual(r.status, 200, r.text);
    const run = await request(h.base, 'GET', `/api/v1/runs/${r.body.x_openvibe.run_id}`, { tok: service });
    assert.match(JSON.stringify(run.body.run.attribution || {}), new RegExp(PRJ));
});

t.test('a service acting for a person names them: the run is theirs (the claim, or the x_openvibe extension)', async () => {
    const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
    const acting = token('actor', ALL, { extra: { on_behalf_of: USR } });
    const claimed = await post({ model: 'openvibe', messages: [{ role: 'user', content: 'For a person' }] }, acting);
    assert.strictEqual(claimed.status, 200, claimed.text);
    const runFor = async (id) => (await request(h.base, 'GET', `/api/v1/runs/${id}`, { tok: service })).body.run;
    assert.deepStrictEqual((await runFor(claimed.body.x_openvibe.run_id)).on_behalf_of, { type: 'user', id: USR }, 'the token\'s claim is the run\'s person');
    const supplied = await post({ model: 'openvibe', messages: [{ role: 'user', content: 'For a person' }], x_openvibe: { on_behalf_of: { type: 'user', id: USR } } });
    assert.strictEqual(supplied.status, 200, supplied.text);
    assert.deepStrictEqual((await runFor(supplied.body.x_openvibe.run_id)).on_behalf_of, { type: 'user', id: USR }, 'the extension is the run\'s person');
    const bad = await post({ model: 'openvibe', messages: [{ role: 'user', content: 'x' }], x_openvibe: { on_behalf_of: { type: 'user', id: 'nobody' } } });
    assert.strictEqual(bad.status, 400, 'a bad SubjectRef is refused before the run');
    assert.strictEqual(bad.body.error.type, 'invalid_request_error');
    const swapped = await post({ model: 'openvibe', messages: [{ role: 'user', content: 'x' }], x_openvibe: { on_behalf_of: { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNP1' } } }, acting);
    assert.deepStrictEqual([swapped.status, swapped.body.error.code], [403, 'capability.denied'], 'a run token cannot name someone else');
    const denied = await post({ model: 'openvibe', messages: [{ role: 'user', content: 'x' }], x_openvibe: { on_behalf_of: { type: 'user', id: USR } } }, app);
    assert.deepStrictEqual([denied.status, denied.body.error.code], [403, 'capability.denied'], 'an app run never names a person');
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
    assert.deepStrictEqual(seen[1].body, { model: 'gpt-5-nano', messages, max_completion_tokens: 300 + 1024, reasoning_effort: 'low' }, 'a reasoning model: max_completion_tokens with room to think, low effort, no sampling knobs');
    const plain = createOpenAiProvider({ key: 'local', capabilities: ['chat'] }, { fetchImpl });
    assert.strictEqual(plain.supports('tools'), false, 'tools are declared, never assumed');
});

t.test('production\'s shape: an OpenAI-format provider declaring chat (not complete) answers it, no stub behind it', async () => {
    const calls = [];
    const upstream = http.createServer((req, res) => {
        let b = '';
        req.on('data', (d) => { b += d; });
        req.on('end', () => {
            calls.push({ path: req.url, body: JSON.parse(b) });
            const body = JSON.parse(b);
            if (body.stream) {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                const chunk = (o) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-up', object: 'chat.completion.chunk', model: 'gpt-up', ...o })}\n\n`);
                if (body.messages[0].content === 'break') { chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'half ' }, finish_reason: null }] }); return setTimeout(() => res.destroy(), 50); }
                ['from ', 'the ', 'stream'].forEach((w, i) => chunk({ choices: [{ index: 0, delta: i ? { content: w } : { role: 'assistant', content: w }, finish_reason: null }] }));
                chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
                chunk({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } });
                res.write('data: [DONE]\n\n');
                return res.end();
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: 'chatcmpl-up', object: 'chat.completion', created: 1, model: 'gpt-up', choices: [{ index: 0, message: { role: 'assistant', content: 'from upstream' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
        });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const h2 = await boot({ env: { AI_STUB_FALLBACK: 'false' } });
    try {
        const made = await request(h2.base, 'POST', '/api/v1/providers', { tok: service, body: { key: 'up', kind: 'openai', base_url: `http://127.0.0.1:${upstream.address().port}/v1`, auth_mode: 'none', default_model: 'gpt-up', capabilities: ['chat'] } });
        assert.ok(made.status < 300, made.text);
        const r = await request(h2.base, 'POST', '/v1/chat/completions', { tok: service, body: { model: 'anything', messages: [{ role: 'user', content: 'hi' }] } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.choices[0].message.content, 'from upstream');
        assert.strictEqual(r.body.x_openvibe.provider, 'up');
        assert.deepStrictEqual([calls.length, calls[0].path, calls[0].body.model], [1, '/v1/chat/completions', 'gpt-up']);
        // Tools need a provider that declares them: none does here, so the answer is OpenAI's JSON error with 503 (never a
        // 502, which Cloudflare would replace with its own page).
        // stream: true reaches the upstream as stream: true (include_usage asked), and its deltas are passed on in order.
        const streamed = await fetch(`${h2.base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'stream it' }] }) });
        const sent = await sse(streamed);
        assert.ok(sent.done);
        assert.deepStrictEqual(sent.chunks.filter((c) => c.choices.length && c.choices[0].delta.content).map((c) => c.choices[0].delta.content), ['from ', 'the ', 'stream'], 'the upstream deltas, in order');
        assert.deepStrictEqual([calls[calls.length - 1].body.stream, calls[calls.length - 1].body.stream_options], [true, { include_usage: true }]);
        const srun = await request(h2.base, 'GET', `/api/v1/runs/${sent.chunks.find((c) => c.x_openvibe).x_openvibe.run_id}`, { tok: service });
        assert.deepStrictEqual([srun.body.run.output.choices[0].message.content, srun.body.run.usage.tokens_in, srun.body.run.usage.tokens_out], ['from the stream', 9, 3], 'the run kept the joined answer and the upstream usage');
        // An upstream that breaks off after a delta: an error event, then [DONE]; nothing is retried or handed on.
        const before = calls.length;
        const broken = await sse(await fetch(`${h2.base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'break' }] }) }));
        assert.ok(broken.done);
        assert.strictEqual(broken.chunks[0].choices[0].delta.content, 'half ');
        const err = broken.chunks.find((c) => c.error);
        assert.ok(err && err.error.code === 'provider.stream_broken', JSON.stringify(broken.chunks).slice(0, 300));
        assert.strictEqual(calls.length, before + 1, 'not retried');
        const beforeTools = calls.length;
        const tools = await request(h2.base, 'POST', '/v1/chat/completions', { tok: service, body: { messages: [{ role: 'user', content: 'Weather?' }], tools: [WEATHER] } });
        assert.strictEqual(tools.status, 503, tools.text);
        assert.strictEqual(tools.body.error.code, 'provider.unavailable');
        assert.strictEqual(calls.length, beforeTools, 'the provider without tools was not asked');
    } finally {
        await h2.stop();
        await new Promise((r) => upstream.close(r));
    }
});

t.test('POST /v1/audio/transcriptions: multipart audio through the router, in OpenAI\'s shape', async () => {
    const r = await transcribe({ model: 'whisper-1', language: 'en', prompt: 'OpenVibe', temperature: '0', response_format: 'json' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(typeof r.body.text, 'string');
    assert.ok(r.body.text.length > 0);
    assert.ok(r.headers.get('x-openvibe-run-id'), 'the run is named in the header');
    assert.strictEqual(r.body.x_openvibe.run_id, r.headers.get('x-openvibe-run-id'));
    assert.strictEqual(r.body.x_openvibe.requested_model, 'whisper-1');
    assert.strictEqual(r.body.x_openvibe.response_format, 'json');
    const run = await request(h.base, 'GET', `/api/v1/runs/${r.body.x_openvibe.run_id}`, { tok: service });
    assert.strictEqual(run.body.run.workflow.key, 'ai.transcribe');
    assert.ok(run.body.run.usage && typeof run.body.run.usage.cost_usd === 'number', 'the run path recorded its usage');
    assert.ok(!JSON.stringify(run.body.run.input || {}).includes('data:audio'), 'the audio is not kept');
});

t.test('POST /v1/audio/transcriptions: verbose_json segments and the plain text format', async () => {
    const v = await transcribe({ model: 'whisper-1', language: 'en', response_format: 'verbose_json' });
    assert.strictEqual(v.status, 200, v.text);
    assert.deepStrictEqual([v.body.task, v.body.language], ['transcribe', 'en']);
    assert.ok(Array.isArray(v.body.segments) && v.body.segments.length > 0);
    assert.strictEqual(typeof v.body.segments[0].start, 'number');
    assert.strictEqual(typeof v.body.segments[0].end, 'number');
    assert.strictEqual(typeof v.body.segments[0].text, 'string');
    assert.ok(v.body.duration > 0);

    const t = await transcribe({ model: 'whisper-1', language: 'en', response_format: 'text' });
    assert.strictEqual(t.status, 200, t.text);
    assert.match(t.headers.get('content-type'), /^text\/plain/);
    assert.ok(t.text.trim().length > 0);
    assert.ok(t.headers.get('x-openvibe-run-id'));
});

t.test('POST /v1/audio/transcriptions: a file that is not audio is refused, and so is an unknown format', async () => {
    const bad = await transcribe({ model: 'whisper-1' }, { name: 'notes.txt', type: 'text/plain', data: Buffer.from('not audio') });
    assert.deepStrictEqual([bad.status, bad.body.error.type, bad.body.error.code], [400, 'invalid_request_error', 'input.invalid'], bad.text);
    const format = await transcribe({ model: 'whisper-1', response_format: 'srt' });
    assert.deepStrictEqual([format.status, format.body.error.code], [400, 'input.invalid']);
    const model = await transcribe({});
    assert.deepStrictEqual([model.status, model.body.error.code], [400, 'input.invalid'], 'model is required as OpenAI requires it');
});

t.test('POST /v1/moderations: a structured classification in OpenAI\'s shape, labelled as one', async () => {
    const r = await postJson('/v1/moderations', { model: 'omni-moderation-latest', input: ['a friendly hello', 'I will find where you live'] });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.results.length, 2);
    const categories = ['hate', 'hate/threatening', 'harassment', 'harassment/threatening', 'self-harm', 'self-harm/intent', 'self-harm/instructions', 'sexual', 'sexual/minors', 'violence', 'violence/graphic'];
    for (const result of r.body.results) {
        assert.strictEqual(typeof result.flagged, 'boolean');
        for (const key of categories) {
            assert.strictEqual(typeof result.categories[key], 'boolean', key);
            assert.strictEqual(typeof result.category_scores[key], 'number', key);
        }
    }
    assert.deepStrictEqual([r.body.x_openvibe.method, r.body.x_openvibe.route], ['structured_model', 'moderation.classify']);
    assert.match(r.body.x_openvibe.note, /no provider moderation endpoint/);
    assert.strictEqual(r.body.x_openvibe.run_ids.length, 2);
    assert.strictEqual(r.body.x_openvibe.classification.length, 2);
    const first = await request(h.base, 'GET', `/api/v1/runs/${r.body.x_openvibe.run_ids[0]}`, { tok: service });
    assert.deepStrictEqual([first.body.run.workflow.key, typeof first.body.run.usage.cost_usd], ['ai.moderate', 'number'], 'the run path recorded its usage');
});

t.test('POST /v1/rerank: Cohere/Jina shape from embeddings cosine similarity, labelled', async () => {
    const r = await postJson('/v1/rerank', { model: 'rerank-v3.5', query: 'a cat', documents: ['a cat on a mat', 'a dog barking', { text: 'a bird in a tree' }], top_n: 2 });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.results.length, 2);
    for (const hit of r.body.results) {
        assert.ok(Number.isInteger(hit.index) && hit.index >= 0 && hit.index < 3);
        assert.strictEqual(typeof hit.relevance_score, 'number');
    }
    assert.ok(r.body.results[0].relevance_score >= r.body.results[1].relevance_score, 'sorted by score');
    assert.deepStrictEqual([r.body.meta.method, r.body.x_openvibe.method], ['embeddings_cosine', 'embeddings_cosine']);
    assert.match(r.body.x_openvibe.note, /cosine similarity/);
    assert.strictEqual(r.body.x_openvibe.requested_model, 'rerank-v3.5');
    const run = await request(h.base, 'GET', `/api/v1/runs/${r.body.x_openvibe.run_id}`, { tok: service });
    assert.deepStrictEqual([run.body.run.workflow.key, typeof run.body.run.usage.tokens_in], ['ai.embed', 'number'], 'the run path recorded its usage');

    const kept = await postJson('/v1/rerank', { query: 'x', documents: [{ text: 'one' }, { text: 'two' }], return_documents: true });
    assert.strictEqual(kept.status, 200, kept.text);
    assert.ok(kept.body.results.every((hit) => hit.document && typeof hit.document.text === 'string'), 'documents return when asked');
    const bad = await postJson('/v1/rerank', { query: 'x', documents: ['one'], top_n: 2 });
    assert.deepStrictEqual([bad.status, bad.body.error.code], [400, 'input.invalid']);
});

t.test('close', async () => { await h.stop(); });
t.run();
