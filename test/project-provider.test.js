'use strict';
// An app's own provider on the OpenAI-compatible endpoint (x_openvibe.provider, ADR-056): the project secret is revealed
// by Network for that run, to the provider's origin, in the app's environment; the request (tools included) goes to the
// project's provider with that key and the model it named, and the run is the project's. Refused: an unknown or
// ungranted secret (403), a non-https base URL (400), a service token naming a provider (403). The key is never stored.
const assert = require('assert');
const { boot, request, token, suite } = require('./helpers');

const t = suite('project-provider');
const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const appToken = (env) => token('app', ['ai.app.run'], { sub: `app:app_${PRJ.slice(4)}`, actorType: 'app', ns: [PRJ, `app.${PRJ}.*`], extra: { project_id: PRJ, env } });
const service = token('live', ['ai.run.create', 'ai.run.read']);
const KEY = `sk-own-${'k'.repeat(32)}`;
const PROVIDER = { base_url: 'https://llm.example.org/v1/', model: 'gpt-own-1', secret: 'llm-key' };
const WEATHER = { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } };
const NETWORK = 'http://network.test';
let h;
const reveals = [];
const upstream = [];

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// OpenVibe.Network: a client-credentials token, and /internal/secrets/use revealing llm-key to https://llm.example.org only.
async function network(url, init = {}) {
    const u = new URL(url);
    if (u.pathname === '/oauth/token') return json(200, { access_token: 'svc-token', token_type: 'Bearer', expires_in: 300 });
    if (u.pathname === '/internal/secrets/use') {
        const b = JSON.parse(init.body);
        reveals.push({ auth: init.headers.Authorization, ...b });
        if (b.name === 'llm-key' && b.purpose === 'reveal' && b.origin === 'https://llm.example.org') return json(200, { value: KEY, version: 3 });
        return json(404, { code: 'secret.not_found' });
    }
    return json(404, {});
}
// The project's provider (through the credential fetch, as guardedFetch would reach it): a tool call when given tools.
async function provider(url, init = {}) {
    const body = JSON.parse(init.body);
    upstream.push({ url, auth: init.headers.Authorization || init.headers.authorization, body });
    const message = body.tools ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] } : { role: 'assistant', content: 'from the project provider' };
    return json(200, { id: 'chatcmpl-own', object: 'chat.completion', model: body.model, choices: [{ index: 0, message, finish_reason: body.tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
}
const post = (tok, extra) => request(h.base, 'POST', '/v1/chat/completions', { tok, body: { model: 'x', messages: [{ role: 'user', content: 'Weather in Oslo?' }], ...extra } });

t.test('boot (stub fallback off: only the project provider can answer)', async () => {
    h = await boot({
        env: { AI_STUB_FALLBACK: 'false', OV_OAUTH_CLIENT_SECRET: 's'.repeat(40), OV_NETWORK_INTERNAL_URL: NETWORK },
        fetchImpl: (url, init) => (String(url).startsWith(NETWORK) ? network(url, init) : globalThis.fetch(url, init)),
        credentialFetch: provider,
    });
});

t.test('the project secret is revealed for the run and the request (tools too) goes to the project provider', async () => {
    const r = await post(appToken('production'), { tools: [WEATHER], x_openvibe: { provider: PROVIDER } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(r.body.choices[0].message.tool_calls[0].function.name, 'get_weather');
    assert.strictEqual(r.body.x_openvibe.provider, `project:${PRJ}`);
    assert.deepStrictEqual(reveals.map((x) => [x.auth, x.project_id, x.environment, x.name, x.purpose, x.origin]),
        [['Bearer svc-token', PRJ, 'production', 'llm-key', 'reveal', 'https://llm.example.org']]);
    assert.deepStrictEqual([upstream[0].url, upstream[0].auth, upstream[0].body.model, upstream[0].body.tools.length],
        ['https://llm.example.org/v1/chat/completions', `Bearer ${KEY}`, 'gpt-own-1', 1]);
    const run = await request(h.base, 'GET', `/api/v1/runs/${r.body.x_openvibe.run_id}`, { tok: appToken('production') });
    assert.strictEqual(run.status, 200, run.text);
    assert.match(run.body.run.explain.reasons.join(' '), /project's own provider at https:\/\/llm\.example\.org \(project secret llm-key, production\)/);
    assert.ok(!JSON.stringify(run.body).includes(KEY), 'the key is not in the run');
    const row = await h.testdb.db.prepare('SELECT options FROM runs WHERE id = ?').get(r.body.x_openvibe.run_id);
    assert.ok(!String(row.options).includes(KEY) && String(row.options).includes('llm-key'), 'the run keeps the secret\'s name, never its value');
});

t.test('a sandbox app reveals from the sandbox environment', async () => {
    const r = await post(appToken('sandbox'), { x_openvibe: { provider: PROVIDER } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.choices[0].message.content, 'from the project provider');
    assert.strictEqual(reveals[reveals.length - 1].environment, 'sandbox');
});

t.test('refused: a secret not granted (403), a base URL that is not https (400), a service naming a provider (403)', async () => {
    const calls = upstream.length;
    const missing = await post(appToken('production'), { x_openvibe: { provider: { ...PROVIDER, secret: 'other-key' } } });
    assert.strictEqual(missing.status, 403, missing.text);
    assert.strictEqual(missing.body.error.code, 'project_secret.refused');
    const plain = await post(appToken('production'), { x_openvibe: { provider: { ...PROVIDER, base_url: 'http://llm.example.org/v1' } } });
    assert.strictEqual(plain.status, 400, plain.text);
    assert.strictEqual(plain.body.error.code, 'input.invalid');
    const bad = await post(appToken('production'), { x_openvibe: { provider: { ...PROVIDER, secret: 'Not A Name' } } });
    assert.strictEqual(bad.status, 400, bad.text);
    const svc = await post(service, { x_openvibe: { provider: PROVIDER } });
    assert.strictEqual(svc.status, 403, svc.text);
    assert.strictEqual(svc.body.error.code, 'capability.denied');
    assert.strictEqual(upstream.length, calls, 'nothing refused reached a provider');
});

t.test('close', async () => { await h.stop(); });
t.run();
