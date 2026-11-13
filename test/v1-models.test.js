'use strict';
// AI Exchange P4 (CHECKPOINT D3/D4/D8), behind AI_MODEL_CATALOG:
//   - GET /v1/models and /v1/models/{id} in both wire protocols: the registry's real models as ai.model@1 entries
//     plus the dynamic policy aliases, marked dynamic;
//   - an exact id runs only its artifact (never a substitute); an alias resolves through the same placement;
//   - the route disclosure inside x_openvibe (D3') on JSON responses, as the first SSE comment and on the final chunk;
//   - paid managed routing refuses UNVERIFIED/RESTRICTED offers, while an own deployment and CUSTOMER_BYOK work;
//   - with the flag off, the legacy single `openvibe` model and no disclosure, exactly as before.
const assert = require('assert');
const http = require('http');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('v1-models');
const service = token('live', ALL);
const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const PERSON = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP7';
const CREDENTIAL_KEY = 'cd'.repeat(32);
const ACTION = token('codes', ALL, { extra: { on_behalf_of: PERSON } });
const MANAGER = token('codes', [...ALL, 'ai.credential.manage'], { extra: { on_behalf_of: PERSON } });
const APP_D8 = token('app', ['ai.app.run'], { sub: `app:app_${PRJ.slice(4)}`, actorType: 'app', ns: [PRJ, `app.${PRJ}.*`], extra: { project_id: PRJ, env: 'production' } });
const APP_LEGACY = token('app', ['ai.app.run'], { sub: `app:app_${PRJ.slice(4)}`, actorType: 'app', ns: [PRJ, `app.${PRJ}.*`], extra: { project_id: PRJ, env: 'production' } });

const ALPHA_ID = 'acme/m1:q4_k_m@rev1';
const BETA_ID = 'acme/m2@rev2';
const GAMMA_ID = 'acme/m3@rev3';
const DELTA_ID = 'anthropic/claude-test@revA';
const WEATHER = { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } };

/* ── a fake OpenAI-compatible upstream (JSON and SSE) ─────────────────────── */
function openAiUpstream() {
    const state = { mode: 'ok', calls: [], url: null, close: null };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
            state.calls.push({ url: req.url, body });
            if (state.mode === 'fail') {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: { message: 'the artifact is down' } }));
            }
            const chunk = (choices, extra = {}) => JSON.stringify({ id: 'chatcmpl-up', object: 'chat.completion.chunk', created: 1, model: body.model, choices, ...extra });
            if (body.stream) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write(`data: ${chunk([{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }])}\n\n`);
                res.write(`data: ${chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])}\n\n`);
                res.write(`data: ${chunk([], { usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`);
                res.write('data: [DONE]\n\n');
                return res.end();
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ id: 'chatcmpl-up', object: 'chat.completion', model: body.model,
                choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 5, completion_tokens: 2 } }));
        });
    });
    server.listen(0, '127.0.0.1', () => { state.url = `http://127.0.0.1:${server.address().port}/v1`; });
    state.ready = new Promise((resolve) => server.on('listening', resolve));
    state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    return state;
}

/* ── a fake Anthropic Messages upstream (JSON and Anthropic's SSE frames) ──── */
function anthropicUpstream() {
    const state = { calls: [], url: null, close: null };
    const FRAMES = [
        ['message_start', { type: 'message_start', message: { id: 'msg_up', type: 'message', role: 'assistant', model: 'delta-1', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
        ['message_stop', { type: 'message_stop' }],
    ];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', async () => {
            let body = {};
            try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
            state.calls.push({ url: req.url, body });
            if (body.stream) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                for (const [event, data] of FRAMES) {
                    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                    await new Promise((r) => setTimeout(r, 2));
                }
                return res.end();
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ id: 'msg_up', type: 'message', role: 'assistant', model: body.model,
                content: [{ type: 'text', text: 'Hello there' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 2 } }));
        });
    });
    server.listen(0, '127.0.0.1', () => { state.url = `http://127.0.0.1:${server.address().port}`; });
    state.ready = new Promise((resolve) => server.on('listening', resolve));
    state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    return state;
}

const alpha = openAiUpstream();
const beta = openAiUpstream();
const gamma = openAiUpstream();
const delta = anthropicUpstream();
const freecap = openAiUpstream();
let h;
let ownCalls = 0;
const credentialFetch = async (url, init) => {
    ownCalls++;
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: 'msg_own', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: 'from your own key' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 3, output_tokens: 2 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const post = (path, body, tok = service, headers = {}) => fetch(`${h.base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const chat = (model, extra = {}) => request(h.base, 'POST', '/v1/chat/completions', { tok: service, body: { model, messages: [{ role: 'user', content: 'Say hello' }], ...extra } });
const mkProvider = (body) => request(h.base, 'POST', '/api/v1/providers', { tok: service, body });
const mkModel = (body) => request(h.base, 'POST', '/api/v1/models', { tok: service, body });

t.test('boot: the catalog is on, with own, wholesale and unverified offers', async () => {
    await Promise.all([alpha.ready, beta.ready, gamma.ready, delta.ready, freecap.ready]);
    h = await boot({ env: { AI_MODEL_CATALOG: '1', AI_STUB_FALLBACK: 'false', AI_CREDENTIALS_KEY: CREDENTIAL_KEY }, credentialFetch });
    const providers = [
        { key: 'alpha', kind: 'openai', base_url: alpha.url, auth_mode: 'none', capabilities: ['chat', 'complete'], default_model: 'alpha-1', provider_access: 'OWN_DEPLOYMENT' },
        { key: 'beta', kind: 'openai', base_url: beta.url, auth_mode: 'none', capabilities: ['chat', 'complete'], default_model: 'beta-1', provider_access: 'AUTHORIZED_WHOLESALE' },
        { key: 'gamma', kind: 'openai', base_url: gamma.url, auth_mode: 'none', capabilities: ['chat', 'complete'], default_model: 'gamma-1' },
        { key: 'delta', kind: 'anthropic', base_url: delta.url, auth_mode: 'none', capabilities: ['chat', 'json'], default_model: 'delta-1', provider_access: 'OWN_DEPLOYMENT' },
    ];
    for (const p of providers) assert.strictEqual((await mkProvider(p)).status, 201);
    const cost = (input, output) => ({ in_per_mtok: input, out_per_mtok: output, cached_per_mtok: input / 10, source: 'https://example.com/pricing', verified_at: '2026-11-01' });
    const model = (provider_key, model_key, metadata, inUsd, outUsd, supports = { json: true, tools: true, streaming: true, vision: false }) =>
        mkModel({ provider_key, model_key, type: 'chat', status: 'active', context_window: 32768, max_output: 4096, supports, cost: cost(inUsd, outUsd), metadata });
    assert.strictEqual((await model('alpha', 'alpha-1', { org: 'acme', model: 'm1', quant: 'q4_k_m', revision: 'rev1', family: 'm', variant: 'original', license: 'mit', sha256: 'a'.repeat(64), rate_version: 'rr-1' }, 1, 2)).status, 201);
    assert.strictEqual((await model('beta', 'beta-1', { org: 'acme', model: 'm2', revision: 'rev2', rate_version: 'rr-2' }, 5, 10)).status, 201);
    assert.strictEqual((await model('gamma', 'gamma-1', { org: 'acme', model: 'm3', revision: 'rev3' }, 0.1, 0.2)).status, 201);
    assert.strictEqual((await model('delta', 'delta-1', { org: 'anthropic', model: 'claude-test', revision: 'revA' }, 3, 6)).status, 201);
});

t.test('both protocols list the real models and the dynamic aliases', async () => {
    const openai = await request(h.base, 'GET', '/v1/models', { tok: service });
    assert.strictEqual(openai.status, 200, openai.text);
    assert.strictEqual(openai.body.object, 'list');
    const byId = new Map(openai.body.data.map((m) => [m.id, m]));
    for (const id of ['openvibe', 'openvibe/auto', 'openvibe/economy', 'openvibe/balanced', 'openvibe/fast', 'openvibe/private', ALPHA_ID, BETA_ID, GAMMA_ID, DELTA_ID]) assert.ok(byId.has(id), `lists ${id}`);
    assert.deepStrictEqual([byId.get('openvibe/auto').dynamic, byId.get('openvibe/auto').policy], [true, 'auto']);
    assert.deepStrictEqual([byId.get('openvibe/economy').dynamic, byId.get('openvibe/economy').policy], [true, 'cheapest']);
    assert.strictEqual(byId.get(ALPHA_ID).dynamic, false);
    assert.deepStrictEqual([byId.get(ALPHA_ID).family, byId.get(ALPHA_ID).revision, byId.get(ALPHA_ID).retail_rate.input_nano_usd_per_m],
        ['m', 'rev1', '1000000000'], 'the ai.model@1 catalog facts, in integer nano-USD');

    const detail = await request(h.base, 'GET', `/v1/models/${encodeURIComponent(ALPHA_ID)}`, { tok: service });
    assert.strictEqual(detail.status, 200, detail.text);
    assert.deepStrictEqual([detail.body.id, detail.body.variant, detail.body.quant], [ALPHA_ID, 'original', 'q4_k_m']);
    const alias = await request(h.base, 'GET', '/v1/models/openvibe/private', { tok: service });
    assert.deepStrictEqual([alias.status, alias.body.dynamic, alias.body.policy], [200, true, 'private']);
    const missing = await request(h.base, 'GET', '/v1/models/acme/nope@rev0', { tok: service });
    assert.deepStrictEqual([missing.status, missing.body.error.code], [404, 'ai.model_not_found']);

    const anthropic = await request(h.base, 'GET', '/v1/models', { tok: service, headers: { 'anthropic-version': '2023-06-01' } });
    assert.strictEqual(anthropic.status, 200, anthropic.text);
    assert.strictEqual(anthropic.body.object, undefined);
    assert.strictEqual(anthropic.body.has_more, false);
    assert.strictEqual(anthropic.body.data.find((m) => m.id === 'openvibe/economy').dynamic, true);
    assert.strictEqual(anthropic.body.data.find((m) => m.id === ALPHA_ID).type, 'model');
    const one = await request(h.base, 'GET', `/v1/models/${encodeURIComponent(ALPHA_ID)}`, { tok: service, headers: { 'anthropic-version': '2023-06-01' } });
    assert.deepStrictEqual([one.status, one.body.id, one.body.display_name], [200, ALPHA_ID, 'alpha-1']);
});

t.test('every model lists the twelve features from the registry; unknown is null, never guessed', async () => {
    const r = await request(h.base, 'GET', '/v1/models', { tok: service });
    assert.strictEqual(r.status, 200, r.text);
    const keys = ['audio_in', 'audio_out', 'batch', 'files', 'logprobs', 'prompt_caching', 'realtime', 'reasoning_effort', 'streaming', 'structured_output', 'tools', 'vision'];
    for (const m of r.body.data) {
        assert.deepStrictEqual(Object.keys(m.features || {}).sort(), [...keys].sort(), `${m.id} carries every feature`);
        for (const [key, value] of Object.entries(m.features)) assert.ok(value === null || typeof value === 'boolean', `${m.id}.${key}`);
    }
    const alpha = r.body.data.find((m) => m.id === ALPHA_ID);
    assert.deepStrictEqual([alpha.features.tools, alpha.features.structured_output, alpha.features.vision, alpha.features.streaming, alpha.features.prompt_caching],
        [true, true, false, true, true], 'the registry support flags and the cache price');
    assert.deepStrictEqual([alpha.features.audio_in, alpha.features.audio_out, alpha.features.reasoning_effort, alpha.features.logprobs, alpha.features.batch, alpha.features.realtime, alpha.features.files],
        [null, null, null, null, null, null, null], 'nothing said is null');
    const alias = r.body.data.find((m) => m.id === 'openvibe/auto');
    assert.ok(Object.values(alias.features).every((value) => value === null), 'a dynamic alias is not one model, so every feature is unknown');
});

t.test('an exact id runs only that artifact; an alias is dynamic and says which model answered', async () => {
    alpha.calls.length = 0; beta.calls.length = 0; gamma.calls.length = 0;
    const exact = await chat(ALPHA_ID);
    assert.strictEqual(exact.status, 200, exact.text);
    const exactBody = exact.body;
    assert.strictEqual(alpha.calls.length, 1, 'alpha ran');
    assert.deepStrictEqual([beta.calls.length, gamma.calls.length], [0, 0], 'no other artifact was called');
    assert.deepStrictEqual([exactBody.x_openvibe.resolved_model, exactBody.x_openvibe.deployment, exactBody.x_openvibe.provider_access, exactBody.x_openvibe.policy],
        [ALPHA_ID, 'alpha', 'OWN_DEPLOYMENT', 'exact'], JSON.stringify(exactBody.x_openvibe));
    assert.deepStrictEqual([exactBody.model, exactBody.x_openvibe.rate_version], ['alpha-1', 'rr-1']);

    alpha.calls.length = 0; beta.calls.length = 0; gamma.calls.length = 0;
    const alias = await chat('openvibe/economy');
    assert.strictEqual(alias.status, 200, alias.text);
    const aliasBody = alias.body;
    assert.strictEqual(alpha.calls.length, 1, 'economy picked the cheapest eligible offer, alpha');
    assert.deepStrictEqual([beta.calls.length, gamma.calls.length], [0, 0], 'beta costs more; gamma is UNVERIFIED');
    assert.deepStrictEqual([aliasBody.x_openvibe.resolved_model, aliasBody.x_openvibe.deployment, aliasBody.x_openvibe.policy],
        [ALPHA_ID, 'alpha', 'cheapest']);
});

t.test('an exact id whose artifact is down fails, and never substitutes another model', async () => {
    await request(h.base, 'POST', '/api/v1/providers/alpha/disable', { tok: service, body: {} });
    beta.calls.length = 0;
    const down = await chat(ALPHA_ID);
    assert.deepStrictEqual([down.status, down.body.error.code], [400, 'ai.model_unavailable'], down.text);
    assert.strictEqual(beta.calls.length, 0, 'the other artifact was never called');

    // The deployment is active again but its upstream fails: still an error, still no substitute.
    await request(h.base, 'POST', '/api/v1/providers/alpha/enable', { tok: service, body: {} });
    alpha.mode = 'fail';
    beta.calls.length = 0;
    const failed = await chat(ALPHA_ID);
    assert.strictEqual(failed.status, 503, failed.text);
    assert.strictEqual(beta.calls.length, 0, 'not substituted after the artifact failed');
    alpha.mode = 'ok';
});

t.test('the UNVERIFIED gate: gamma is never resold, while own and wholesale offers work', async () => {
    gamma.calls.length = 0;
    const blocked = await chat(GAMMA_ID);
    assert.deepStrictEqual([blocked.status, blocked.body.error.code], [400, 'ai.model_unavailable']);
    assert.strictEqual(gamma.calls.length, 0, 'the UNVERIFIED offer was never called');
    // Both allowed accesses still serve a paid managed request.
    assert.strictEqual((await chat(BETA_ID)).status, 200);
    assert.strictEqual((await chat(ALPHA_ID)).status, 200);
});

t.test('BYOK still works with the catalog on, disclosed as CUSTOMER_BYOK', async () => {
    const put = await request(h.base, 'PUT', `/api/v1/credentials/${PERSON}/anthropic`, { tok: MANAGER, body: { key: 'sk-ant-test-person-0123456789', models: { chat: 'claude-test-1' } } });
    assert.strictEqual(put.status, 200, put.text);
    ownCalls = 0;
    const before = delta.calls.length;
    const res = await request(h.base, 'POST', '/v1/messages', { tok: ACTION, headers: { 'x-openvibe-credential': 'anthropic' }, body: { model: 'openvibe/auto', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] } });
    assert.strictEqual(res.status, 200, res.text);
    const body = res.body;
    assert.strictEqual(body.x_openvibe.provider_access, 'CUSTOMER_BYOK');
    assert.strictEqual(body.x_openvibe.policy, 'byok');
    assert.strictEqual(ownCalls, 1, 'the person\'s own key answered');
    assert.strictEqual(delta.calls.length, before, 'the managed Anthropic offer was not called');
    await request(h.base, 'DELETE', `/api/v1/credentials/${PERSON}/anthropic`, { tok: MANAGER });
});

t.test('the SSE disclosure: a leading comment and a field on the final chunk, both protocols', async () => {
    const openai = await post('/v1/chat/completions', { model: ALPHA_ID, stream: true, messages: [{ role: 'user', content: 'stream' }] });
    assert.strictEqual(openai.status, 200);
    const blocks = (await openai.text()).split('\n\n').filter(Boolean);
    assert.match(blocks[0], /^: x_openvibe /, 'the first SSE block is the disclosure comment');
    const head = JSON.parse(blocks[0].slice(': x_openvibe '.length));
    assert.deepStrictEqual([head.resolved_model, head.deployment, head.provider_access], [ALPHA_ID, 'alpha', 'OWN_DEPLOYMENT']);
    const chunks = blocks.filter((b) => b.startsWith('data: ') && !b.includes('[DONE]')).map((b) => JSON.parse(b.slice(6)));
    assert.deepStrictEqual([chunks[chunks.length - 1].x_openvibe.resolved_model, chunks[chunks.length - 1].x_openvibe.policy], [ALPHA_ID, 'exact']);

    delta.calls.length = 0;
    const anthropic = await post('/v1/messages', { model: DELTA_ID, max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'stream' }] }, service, { 'anthropic-version': '2023-06-01' });
    assert.strictEqual(anthropic.status, 200);
    const frames = (await anthropic.text()).split('\n\n').filter(Boolean);
    assert.match(frames[0], /^: x_openvibe /, 'the first Anthropic SSE block is the disclosure comment');
    const anthropicHead = JSON.parse(frames[0].slice(': x_openvibe '.length));
    assert.deepStrictEqual([anthropicHead.resolved_model, anthropicHead.deployment, anthropicHead.policy], [DELTA_ID, 'delta', 'exact']);
    const stop = frames.map((b) => { const d = /^data: (.*)$/m.exec(b); return d ? JSON.parse(d[1]) : null; }).filter((d) => d && d.type === 'message_stop');
    assert.strictEqual(stop.length, 1);
    assert.strictEqual(stop[0].x_openvibe.resolved_model, DELTA_ID, 'the final Anthropic chunk carries the disclosure');
});

t.test("D8': developer apps use ai.app.run on /v1/models and /v1/chat/completions", async () => {
    const list = await request(h.base, 'GET', '/v1/models', { tok: APP_D8 });
    assert.strictEqual(list.status, 200, list.text);
    assert.ok(list.body.data.some((m) => m.id === ALPHA_ID));
    assert.strictEqual((await request(h.base, 'GET', '/v1/models', { tok: APP_LEGACY })).status, 200, 'ai.app.run still works');
    // A free own deployment lets an app's free-only run answer through the same guard.
    assert.strictEqual((await mkProvider({ key: 'freecap', kind: 'openai', base_url: freecap.url, auth_mode: 'none', capabilities: ['chat', 'complete'], default_model: 'free-1', billing_profile: 'free', provider_access: 'OWN_DEPLOYMENT' })).status, 201);
    assert.strictEqual((await mkModel({ provider_key: 'freecap', model_key: 'free-1', type: 'chat', status: 'active', supports: { json: true, streaming: true } })).status, 201);
    const res = await chat('openvibe/auto', {});
    assert.strictEqual(res.status, 200);
    const appRes = await request(h.base, 'POST', '/v1/chat/completions', { tok: APP_D8, body: { model: 'openvibe/auto', messages: [{ role: 'user', content: 'app' }] } });
    assert.strictEqual(appRes.status, 200, appRes.text);
});

t.test('flag off: the legacy single model and no disclosure, exactly as before', async () => {
    const off = await boot();
    try {
        const list = await request(off.base, 'GET', '/v1/models', { tok: service });
        assert.deepStrictEqual(list.body.data.map((m) => m.id), ['openvibe']);
        assert.ok(list.body.data[0].features && Object.values(list.body.data[0].features).every((value) => value === null), 'the legacy virtual model has the feature matrix, all unknown');
        const anthropic = await request(off.base, 'GET', '/v1/models', { tok: service, headers: { 'anthropic-version': '2023-06-01' } });
        assert.deepStrictEqual(anthropic.body.data.map((m) => m.id), ['openvibe']);
        const res = await request(off.base, 'POST', '/v1/chat/completions', { tok: service, body: { model: 'not-a-catalog-id', messages: [{ role: 'user', content: 'hi' }] } });
        assert.strictEqual(res.status, 200);
        assert.strictEqual((res.body.x_openvibe || {}).resolved_model, undefined, 'no route disclosure with the flag off');
        assert.strictEqual((await request(off.base, 'GET', '/v1/models', { tok: APP_D8 })).status, 200, 'an ai.app.run app lists the legacy model as before');
        // An exact id is a pin: with the catalog off (a rollback of the flag) it is refused, never run on another model.
        const pin = 'qwen/qwen3-8b:q4_k_m@3f2a1c9';
        const chat = await request(off.base, 'POST', '/v1/chat/completions', { tok: service, body: { model: pin, messages: [{ role: 'user', content: 'hi' }] } });
        assert.strictEqual(chat.status, 400, 'an exact id with the catalog off is refused');
        assert.strictEqual(chat.body.error.code, 'ai.model_unavailable');
        const msg = await request(off.base, 'POST', '/v1/messages', { tok: service, body: { model: pin, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
        assert.strictEqual(msg.status, 400, 'and on Messages');
        assert.match(msg.body.error.message, /ai\.model_unavailable/);
    } finally { await off.stop(); }
});

t.test('stop', async () => {
    await h.stop();
    await Promise.all([alpha.close(), beta.close(), gamma.close(), delta.close(), freecap.close()]);
});

t.run();
