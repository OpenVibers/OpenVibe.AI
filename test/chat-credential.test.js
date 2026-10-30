'use strict';
// The person's own key on the OpenAI-compatible endpoint (Codes C3): POST /v1/chat/completions honours
// x-openvibe-credential, so a harness that speaks OpenAI's format (Codex, any OpenAI-compatible client) runs with the
// person's own key instead of the router's provider. The key never appears in a response, a log line or an error.
const assert = require('assert');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('chat-credential');
const KEY = 'cd'.repeat(32);
const PERSON = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP7';
const PERSON_KEY = 'sk-openai-test-person-0123456789';
const service = token('live', ALL);
const acting = token('codes', ALL, { extra: { on_behalf_of: PERSON } });
const manager = token('codes', [...ALL, 'ai.credential.manage'], { extra: { on_behalf_of: PERSON } });

// The person's own provider, answered in-process (the guarded fetch is replaced, as in credentials.test.js).
const ownCalls = [];
const credentialFetch = async (url, init) => {
    ownCalls.push({ url, headers: init.headers || {}, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
        id: 'chatcmpl_person', object: 'chat.completion', model: 'gpt-person',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const logs = [];
const capture = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
let h;

const post = (body, { tok = service, headers = {} } = {}) => request(h.base, 'POST', '/v1/chat/completions', { tok, body, headers });

t.test('boot with the credentials key set', async () => {
    h = await boot({ env: { AI_CREDENTIALS_KEY: KEY, AI_STUB_FALLBACK: 'false' }, credentialFetch, log: capture });
});

t.test('the person\'s own key is stored and never answered', async () => {
    const r = await request(h.base, 'PUT', `/api/v1/credentials/${PERSON}/openai`, { tok: manager, body: { key: PERSON_KEY, models: { chat: 'gpt-person' } } });
    if (r.status !== 200) console.error('LOGS', logs.join('\n'));
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(!r.text.includes(PERSON_KEY), 'the key is not in the answer');
});

t.test('x-openvibe-credential uses the person\'s key, not the router\'s provider', async () => {
    const before = ownCalls.length;
    const res = await post({ model: 'openvibe', messages: [{ role: 'user', content: 'Say hello' }] }, { tok: acting, headers: { 'x-openvibe-credential': 'openai' } });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.choices[0].message.content, 'Hello there');
    assert.ok(ownCalls.length > before, 'the person\'s provider was called');
    const call = ownCalls[ownCalls.length - 1];
    assert.ok(String(call.headers.Authorization || call.headers.authorization || '').includes(PERSON_KEY), 'the person\'s key was sent to their provider');
    assert.ok(!JSON.stringify(res.body).includes(PERSON_KEY), 'the key is not in the answer');
    const run = await request(h.base, 'GET', `/api/v1/runs/${res.headers.get('x-openvibe-run-id')}`, { tok: acting });
    assert.strictEqual(run.body.run.provenance.provider, `byo:codes:${PERSON}:openai`);
});

t.test('<provider>:<subject> names the person explicitly, without an on_behalf_of claim', async () => {
    const res = await post({ model: 'openvibe', messages: [{ role: 'user', content: 'hi' }] }, { tok: manager, headers: { 'x-openvibe-credential': `openai:${PERSON}` } });
    assert.strictEqual(res.status, 200, res.text);
});

t.test('a header without a person is refused, in OpenAI\'s error shape', async () => {
    const res = await post({ model: 'openvibe', messages: [{ role: 'user', content: 'hi' }] }, { tok: service, headers: { 'x-openvibe-credential': 'openai' } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.type, 'invalid_request_error');
    assert.ok(!logs.join('\n').includes(PERSON_KEY), 'the key is never in a log line');
});

t.test('stop', async () => { await h.stop(); });

t.run();
