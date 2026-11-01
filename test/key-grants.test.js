'use strict';
// L55 C3: a person opts in, per app, before any app may use their own key (the owner's rule L24: nothing uses their
// data or keys by default).
//   - a service that holds no credential of its own is refused with ai.credential_not_allowed, and the detail names
//     the page where the person allows it;
//   - once the person allows that app for that provider, the call runs on the person's own key (and the key never
//     reaches the app, a response, a log line or an error);
//   - per provider, or for all of them; another person's key is never reachable;
//   - taking the grant away takes effect at once;
//   - the service may ask which providers the person allowed it for: names only, and nothing at all when it may
//     not use them;
//   - every such use is audited: who, which service, which provider, which run.
const assert = require('assert');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('key-grants');
const KEY = 'cd'.repeat(32);
const DANA = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPX';
const ELI = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPW';
const DANA_KEY = 'sk-openai-test-dana-0123456789';
const ELI_KEY = 'sk-openai-test-eli-0123456789';
const person = token('dana', ALL, { sub: DANA, actorType: 'user' });
const eli = token('eli', ALL, { sub: ELI, actorType: 'user' });
const actor = token('actor', ALL);
const other = token('other', ALL);
const calls = [];
const logs = [];
const capture = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
let h;

const credentialFetch = async (url, init = {}) => {
    calls.push({ url: String(url), auth: (init.headers && (init.headers.Authorization || init.headers.authorization)) || null });
    return new Response(JSON.stringify({
        id: 'chatcmpl_person', object: 'chat.completion', model: 'gpt-person',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from your key' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const chat = (subject = DANA, tok = actor) => request(h.base, 'POST', '/v1/chat/completions', {
    tok, body: { model: 'openvibe', messages: [{ role: 'user', content: 'Say hello' }] },
    headers: { 'x-openvibe-credential': 'openai:' + subject },
});

t.test('boot', async () => { h = await boot({ env: { AI_CREDENTIALS_KEY: KEY, AI_STUB_FALLBACK: 'false' }, credentialFetch, log: capture }); });

t.test('the person stores their own key, and never sees it again', async () => {
    const r = await request(h.base, 'PUT', '/api/v1/me/credentials/openai', { tok: person, body: { key: DANA_KEY, models: { chat: 'gpt-person' } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(!r.text.includes(DANA_KEY), 'the key is not in the answer');
});

t.test('a service that may not use the key is refused, and the answer says where to allow it', async () => {
    const res = await chat();
    assert.strictEqual(res.status, 403, res.text);
    assert.strictEqual(res.body.error.code, 'ai.credential_not_allowed');
    assert.ok(res.body.error.message.includes('allow actor to use your openai key'), res.text);
    assert.ok(res.body.error.message.includes('/you?allow=actor&provider=openai'), 'the detail names the page');
    assert.ok(!res.text.includes(DANA_KEY), 'the key is not in the error');
});

t.test('the person allows the app for that provider, and the call runs on their key', async () => {
    const allow = await request(h.base, 'PUT', '/api/v1/me/key-apps/actor', { tok: person, body: { provider: 'openai' } });
    assert.strictEqual(allow.status, 200, allow.text);
    const before = calls.length;
    const res = await chat();
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.choices[0].message.content, 'Hello from your key');
    assert.ok(calls.length > before, 'the person\'s provider was called');
    assert.ok(String(calls[calls.length - 1].auth).includes(DANA_KEY), 'the person\'s key paid for it');
    assert.ok(!res.text.includes(DANA_KEY), 'the key is not in the answer');
    const run = await request(h.base, 'GET', '/api/v1/runs/' + res.headers.get('x-openvibe-run-id'), { tok: actor });
    assert.strictEqual(run.body.run.provenance.provider, 'byo:self:' + DANA + ':openai');
});

t.test('the use is audited: who, which service, which provider, which run', async () => {
    const rows = await h.testdb.db.prepare("SELECT actor, action, target_id, metadata FROM audit_log WHERE action = 'credential.self.use'").all();
    assert.ok(rows.length >= 1, 'the use is audited');
    const row = rows[rows.length - 1];
    const meta = String(row.metadata || '');
    assert.ok(meta.includes('actor'), meta);
    assert.ok(meta.includes('openai'), meta);
    assert.ok(meta.includes('run_id'), meta);
    assert.ok(!meta.includes(DANA_KEY), 'the key is never in the audit row');
    assert.ok(!String(row.target_id).includes(DANA_KEY));
});

t.test('another person\'s key is never reachable', async () => {
    const saved = await request(h.base, 'PUT', '/api/v1/me/credentials/openai', { tok: eli, body: { key: ELI_KEY, models: { chat: 'gpt-person' } } });
    assert.strictEqual(saved.status, 200, saved.text);
    const res = await chat(ELI);
    assert.strictEqual(res.status, 403, res.text);
    assert.strictEqual(res.body.error.code, 'ai.credential_not_allowed');
});

t.test('the service may ask which providers it may use: names only', async () => {
    const res = await request(h.base, 'GET', '/api/v1/allowed-keys/' + DANA, { tok: actor });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body.providers, ['openai']);
    assert.ok(!res.text.includes(DANA_KEY), 'no key material in the answer');
    // A person who allowed nobody: nothing at all.
    const none = await request(h.base, 'GET', '/api/v1/allowed-keys/' + ELI, { tok: actor });
    assert.strictEqual(none.status, 404);
    assert.ok(!none.text.includes('sk-'), 'nothing about the person\'s keys');
    // Another service: nothing either.
    const otherService = await request(h.base, 'GET', '/api/v1/allowed-keys/' + DANA, { tok: other });
    assert.strictEqual(otherService.status, 404);
});

t.test('taking the grant away takes effect at once', async () => {
    const gone = await request(h.base, 'DELETE', '/api/v1/me/key-apps/actor?provider=openai', { tok: person });
    assert.strictEqual(gone.status, 204);
    const res = await chat();
    assert.strictEqual(res.status, 403, res.text);
    assert.strictEqual(res.body.error.code, 'ai.credential_not_allowed');
});

t.test('the person\'s own list names the apps, never the keys', async () => {
    const allow = await request(h.base, 'PUT', '/api/v1/me/key-apps/actor', { tok: person, body: { provider: '*' } });
    assert.strictEqual(allow.status, 200, allow.text);
    const list = await request(h.base, 'GET', '/api/v1/me/key-apps', { tok: person });
    assert.strictEqual(list.status, 200, list.text);
    assert.strictEqual(list.body.apps.length, 1);
    assert.strictEqual(list.body.apps[0].service, 'actor');
    assert.strictEqual(list.body.apps[0].provider, '*');
    assert.ok(!list.text.includes(DANA_KEY));
});

t.test('the person\'s own list is theirs alone: a service is refused', async () => {
    const res = await request(h.base, 'GET', '/api/v1/me/key-apps', { tok: actor });
    assert.strictEqual(res.status, 403);
});

t.test('the key is never in a log line', async () => {
    assert.ok(!logs.join('\n').includes(DANA_KEY));
});

t.test('stop', async () => { await h.stop(); });

t.run();
