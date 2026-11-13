'use strict';
// The two newest compatible surfaces (server/api/compat-extra.js), both converted onto the Chat Completions path:
// OpenAI's stateless Responses API (a plain call, a stream with the documented event order, a function_call item,
// previous_response_id refused) and Gemini's generateContent / streamGenerateContent (a plain call, SSE with ?alt=sse,
// the JSON array without it, x-goog-api-key and ?key= carrying an OpenVibe key).
const assert = require('assert');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('responses-gemini');
const service = token('live', ALL);
let h;
const post = (path, body, headers = {}) => request(h.base, 'POST', path, { tok: service, body, headers });

/** event/data SSE blocks -> [{ event, data }]. */
async function sseEvents(res) {
    const text = await res.text();
    const events = [];
    for (const block of text.split('\n\n')) {
        let event = null;
        let data = null;
        for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7).trim();
            else if (line.startsWith('data: ')) data = line.slice(6).trim();
        }
        if (event && data) events.push({ event, data: JSON.parse(data) });
    }
    return events;
}

const dataChunks = async (res) => (await res.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6).trim()).filter((d) => d !== '[DONE]').map((d) => JSON.parse(d));

t.test('boot', async () => { h = await boot({ env: { AI_FREE_PROVIDERS: 'stub' } }); });

t.test('Responses: a plain call answers the response object, usage and the run it was', async () => {
    const r = await post('/v1/responses', { model: 'openvibe', input: 'Say hello', instructions: 'Be brief.', store: true });
    assert.strictEqual(r.status, 200, r.text);
    const response = r.body;
    assert.strictEqual(response.object, 'response');
    assert.match(response.id, /^resp_run_/);
    assert.strictEqual(response.status, 'completed');
    assert.strictEqual(response.store, true, 'store is accepted and echoed');
    assert.strictEqual(response.instructions, 'Be brief.');
    assert.strictEqual(response.output[0].type, 'message');
    assert.strictEqual(response.output[0].role, 'assistant');
    assert.strictEqual(response.output[0].content[0].type, 'output_text');
    assert.ok(response.output[0].content[0].text.length > 0);
    assert.ok(response.usage.input_tokens > 0 && response.usage.output_tokens > 0);
    assert.strictEqual(response.usage.total_tokens, response.usage.input_tokens + response.usage.output_tokens);
    assert.strictEqual(response.usage.input_tokens_details.cached_tokens, 0);
    assert.strictEqual(response.usage.output_tokens_details.reasoning_tokens, 0);
    const runId = response.x_openvibe.run_id;
    assert.strictEqual(response.id, `resp_${runId}`);
    const run = await request(h.base, 'GET', `/api/v1/runs/${runId}`, { tok: service });
    assert.strictEqual(run.body.run.workflow.key, 'ai.complete');
    assert.ok(run.body.run.usage.tokens_in > 0, 'the run path recorded the usage');
});

t.test('Responses stream: the documented events in order, the deltas joining into the final text', async () => {
    const res = await fetch(`${h.base}/v1/responses`, { method: 'POST', headers: { Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openvibe', input: 'Stream please', stream: true }) });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    assert.match(String(res.headers.get('x-openvibe-run-id')), /^run_/);
    const events = await sseEvents(res);
    const types = events.map((e) => e.event);
    assert.deepStrictEqual(types.slice(0, 3), ['response.created', 'response.output_item.added', 'response.content_part.added']);
    const lastDelta = types.lastIndexOf('response.output_text.delta');
    assert.ok(types.indexOf('response.output_text.delta') > 2 && lastDelta > types.indexOf('response.output_text.delta'), 'streamed in pieces');
    assert.deepStrictEqual(types.slice(lastDelta + 1), ['response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed']);
    const joined = events.filter((e) => e.event === 'response.output_text.delta').map((e) => e.data.delta).join('');
    const done = events.find((e) => e.event === 'response.output_text.done').data;
    const completed = events.find((e) => e.event === 'response.completed').data.response;
    assert.strictEqual(done.text, joined);
    assert.strictEqual(completed.output[0].content[0].text, joined);
    assert.strictEqual(completed.id, `resp_${res.headers.get('x-openvibe-run-id')}`);
    assert.ok(completed.usage.input_tokens > 0);
});

t.test('Responses: a function tool call is a function_call item, and its output can be sent back', async () => {
    const tools = [{ type: 'function', name: 'get_weather', description: 'Weather for a city',
        parameters: { type: 'object', required: ['city'], properties: { city: { type: 'string' } } } }];
    const r = await post('/v1/responses', { input: 'Weather in Lisbon?', tools, tool_choice: 'auto' });
    assert.strictEqual(r.status, 200, r.text);
    const call = r.body.output.find((item) => item.type === 'function_call');
    assert.ok(call, JSON.stringify(r.body).slice(0, 300));
    assert.strictEqual(call.name, 'get_weather');
    assert.match(call.call_id, /^call_/);
    assert.ok(JSON.parse(call.arguments).city);
    const back = await post('/v1/responses', { input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Weather in Lisbon?' }] },
        { type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments },
        { type: 'function_call_output', call_id: call.call_id, output: '19 C and sunny' },
    ] });
    assert.strictEqual(back.status, 200, back.text);
    assert.match(back.body.output[0].content[0].text, /19 C and sunny/);
});

t.test('Responses: previous_response_id is refused, and only function tools are accepted', async () => {
    const r = await post('/v1/responses', { input: 'hello', previous_response_id: 'resp_old' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error.message, 'previous_response_id is not supported: send the whole conversation as input');
    assert.strictEqual(r.body.error.type, 'invalid_request_error');
    const other = await post('/v1/responses', { input: 'hello', tools: [{ type: 'web_search' }] });
    assert.strictEqual(other.status, 400);
    assert.strictEqual(other.body.error.type, 'invalid_request_error');
});

t.test('Gemini generateContent answers candidates and usage, with x-goog-api-key and ?key= auth', async () => {
    const body = { contents: [{ role: 'user', parts: [{ text: 'Hello Gemini' }] }], systemInstruction: { parts: [{ text: 'Be nice' }] },
        generationConfig: { temperature: 0.2, maxOutputTokens: 64 } };
    const r = await request(h.base, 'POST', '/v1beta/models/gemini-2.0-flash:generateContent', { body, headers: { 'x-goog-api-key': service } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.candidates[0].content.role, 'model');
    assert.strictEqual(typeof r.body.candidates[0].content.parts[0].text, 'string');
    assert.ok(r.body.candidates[0].content.parts[0].text.length > 0);
    assert.strictEqual(r.body.candidates[0].finishReason, 'STOP');
    assert.ok(r.body.usageMetadata.promptTokenCount > 0 && r.body.usageMetadata.candidatesTokenCount > 0);
    assert.strictEqual(r.body.usageMetadata.totalTokenCount, r.body.usageMetadata.promptTokenCount + r.body.usageMetadata.candidatesTokenCount);
    assert.strictEqual(r.body.usageMetadata.cachedContentTokenCount, 0);
    assert.ok(r.body.modelVersion);
    const run = await request(h.base, 'GET', `/api/v1/runs/${r.headers.get('x-openvibe-run-id')}`, { tok: service });
    assert.strictEqual(run.body.run.workflow.key, 'ai.complete');
    assert.ok(run.body.run.usage.tokens_in > 0, 'the run path recorded the usage');
    const byQuery = await request(h.base, 'POST', `/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(service)}`, { body });
    assert.strictEqual(byQuery.status, 200, byQuery.text);
    assert.ok(byQuery.body.candidates[0].content.parts[0].text.length > 0);
});

t.test('Gemini streamGenerateContent?alt=sse streams candidate chunks and usageMetadata', async () => {
    const res = await fetch(`${h.base}/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse`, { method: 'POST',
        headers: { Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Stream Gemini' }] }] }) });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const chunks = await dataChunks(res);
    assert.ok(chunks.length > 2, `streamed in pieces (${chunks.length})`);
    const text = chunks.flatMap((c) => (c.candidates || []).flatMap((cand) => (cand.content && cand.content.parts) || [])).filter((p) => typeof p.text === 'string').map((p) => p.text).join('');
    assert.ok(text.length > 0);
    const finish = chunks.find((c) => (c.candidates || []).some((cand) => cand.finishReason));
    assert.strictEqual(finish.candidates[0].finishReason, 'STOP');
    assert.ok(chunks.some((c) => c.usageMetadata && c.usageMetadata.promptTokenCount > 0), 'usageMetadata in the stream');
});

t.test('Gemini streamGenerateContent without alt answers one JSON array', async () => {
    const res = await fetch(`${h.base}/v1beta/models/gemini-2.0-flash:streamGenerateContent`, { method: 'POST',
        headers: { 'x-goog-api-key': service, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Array Gemini' }] }] }) });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    const chunks = await res.json();
    assert.ok(Array.isArray(chunks) && chunks.length > 2);
    const text = chunks.flatMap((c) => (c.candidates || []).flatMap((cand) => (cand.content && cand.content.parts) || [])).filter((p) => typeof p.text === 'string').map((p) => p.text).join('');
    assert.ok(text.length > 0);
});

t.test('close', async () => { await h.stop(); });
t.run();
