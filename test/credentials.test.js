'use strict';
// A person's own provider key (roadmap WS-O task 2; Contracts 0.73.0 ai.credential.manage):
//   - stored by a service holding ai.credential.manage, encrypted at rest and bound to its owner and subject, never
//     returned (a four-character hint only); another service neither sees nor uses it; off without AI_CREDENTIALS_KEY;
//   - a run naming it calls that provider with that key only (no fallback, never cached, the shared quota untouched),
//     logged under byo:<owner>:<subject>, and its own daily budget stops further runs (429);
//   - the guarded fetch reaches only public https endpoints.
const assert = require('assert');
const { boot, request, token, suite, ALL } = require('./helpers');
const { guardedFetch } = require('../server/providers/guarded-fetch');

const t = suite('credentials');
const KEY = 'ab'.repeat(32);
const DANA = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP1';
const API_KEY = 'sk-test-dana-0123456789WXYZ';
const live = token('live', [...ALL, 'ai.credential.manage']);
const tools = token('tools', [...ALL, 'ai.credential.manage']);
const noCap = token('live', ALL);
const calls = [];
// The person's provider: an OpenAI-compatible endpoint, answered in-process (the guarded fetch is tested below).
const credentialFetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization || init.headers.authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ model: 'gpt-4o-mini', choices: [{ message: { role: 'assistant', content: 'hello from dana\'s key' } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }), { status: 200, headers: { 'content-type': 'application/json' } });
};
let h;

t.test('boot with a credentials key', async () => {
    h = await boot({ env: { AI_CREDENTIALS_KEY: KEY, AI_PRICING_JSON: JSON.stringify({ 'gpt-4o-mini': { in: 1, out: 1 } }) }, credentialFetch });
});

t.test('store, read without the key, refuse other services', async () => {
    const put = { provider: 'openai', base_url: 'https://llm.example.com/v1', api_key: API_KEY, models: { chat: 'gpt-4o-mini' }, budget_usd_per_day: 0.003 };
    let r = await request(h.base, 'PUT', `/api/v1/credentials/${DANA}`, { tok: noCap, body: put });
    assert.strictEqual(r.status, 403, 'needs ai.credential.manage');
    r = await request(h.base, 'PUT', `/api/v1/credentials/${DANA}`, { tok: live, body: { ...put, base_url: 'http://10.0.0.1/v1' } });
    assert.strictEqual(r.status, 422, 'https only');
    r = await request(h.base, 'PUT', `/api/v1/credentials/${DANA}`, { tok: live, body: put });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.owner, r.body.key_hint, r.body.provider], ['live', '…WXYZ', 'openai']);
    assert.ok(!r.text.includes(API_KEY), 'the key never comes back');
    const { validate } = require('openvibe-contracts');
    assert.ok(validate('ai.credential@1', r.body).valid, JSON.stringify(validate('ai.credential@1', r.body).errors));
    const row = h.db.prepare('SELECT key_enc FROM subject_credentials WHERE owner = ? AND subject = ?').get('live', DANA);
    assert.ok(row.key_enc.startsWith('v1:') && !row.key_enc.includes(API_KEY), 'encrypted at rest');
    // A models change keeps the stored key; a new endpoint needs it again.
    r = await request(h.base, 'PUT', `/api/v1/credentials/${DANA}`, { tok: live, body: { provider: 'openai', base_url: 'https://llm.example.com/v1', models: { chat: 'gpt-4o-mini', vision: 'gpt-4o' }, budget_usd_per_day: 0.003 } });
    assert.deepStrictEqual([r.status, r.body.key_hint, r.body.models.vision], [200, '…WXYZ', 'gpt-4o']);
    r = await request(h.base, 'PUT', `/api/v1/credentials/${DANA}`, { tok: live, body: { provider: 'openai', base_url: 'https://attacker.example/v1' } });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'credential.key_required']);
    r = await request(h.base, 'GET', `/api/v1/credentials/${DANA}`, { tok: tools });
    assert.strictEqual(r.status, 404, 'another service does not see it');
    // A row moved to another owner does not decrypt: the key is bound to owner and subject.
    h.db.prepare("INSERT INTO subject_credentials (owner, subject, provider, base_url, key_enc, key_hint, models, created_at, updated_at) SELECT 'tools', subject, provider, base_url, key_enc, key_hint, models, created_at, updated_at FROM subject_credentials WHERE owner = 'live'").run();
    const creds = require('../server/credentials').createCredentials({ db: h.db, config: h.config });
    assert.throws(() => creds.forRun('tools', DANA));
    h.db.prepare("DELETE FROM subject_credentials WHERE owner = 'tools'").run();
});

t.test('a run with the credential uses that key only, uncached, and its budget stops it', async () => {
    const run = (tok = live) => request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok, body: { workflow: 'live.viewers.line', input: { role: 'chat', user: 'say hi' }, credential: { subject: DANA } } });
    let r = await run();
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.run.status, 'succeeded', JSON.stringify(r.body.run));
    assert.strictEqual(r.body.run.output.text, "hello from dana's key");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://llm.example.com/v1/chat/completions');
    assert.strictEqual(calls[0].auth, `Bearer ${API_KEY}`);
    const reqs = h.db.prepare('SELECT provider_key, status, cost_usd FROM requests WHERE run_id = ?').all(r.body.run.id);
    assert.deepStrictEqual(reqs.map((x) => [x.provider_key, x.status]), [[`byo:live:${DANA}`, 'ok']]);
    assert.ok(Math.abs(reqs[0].cost_usd - 0.002) < 1e-9, 'priced at list price');
    r = await run();
    assert.strictEqual(r.body.run.status, 'succeeded');
    assert.strictEqual(calls.length, 2, 'never served from the cache');
    r = await run();
    assert.deepStrictEqual([r.status, r.body.code], [429, 'quota.exceeded'], 'the daily budget (0.003) is spent');
    assert.strictEqual(calls.length, 2);
    r = await request(h.base, 'GET', `/api/v1/credentials/${DANA}`, { tok: live });
    assert.ok(Math.abs(r.body.spent_usd_today - 0.004) < 1e-9);
    // Another service cannot run with it; neither can a person's token.
    r = await run(tools);
    assert.deepStrictEqual([r.status, r.body.code], [404, 'credential.not_found']);
    r = await run(token('dana', ALL, { sub: DANA, actorType: 'user' }));
    assert.ok([401, 403].includes(r.status), `a user token: ${r.status}`);
    // Deleted: runs refuse it.
    assert.strictEqual((await request(h.base, 'DELETE', `/api/v1/credentials/${DANA}`, { tok: live })).status, 204);
    r = await run();
    assert.deepStrictEqual([r.status, r.body.code], [404, 'credential.not_found']);
});

t.test("a templated workflow on a person's key uses their model for the route's role", async () => {
    const EVE = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP2';
    let r = await request(h.base, 'PUT', `/api/v1/credentials/${EVE}`, { tok: live, body: { provider: 'openai', base_url: 'https://llm.example.com/v1', api_key: 'sk-test-dana-0123456789WXYZ', models: { chat: 'm-chat', director: 'm-director' } } });
    assert.strictEqual(r.status, 200, r.text);
    r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body: { workflow: 'live.viewers.plan', input: { stable: 'roster', volatile: 'chat', max_lines: 2 }, credential: { subject: EVE } } });
    assert.strictEqual(r.body.run.status, 'succeeded', JSON.stringify(r.body.run.error || r.body.run).slice(0, 400));
    assert.strictEqual(calls[calls.length - 1].body.model, 'm-director', 'live.director -> the director model');
    await request(h.base, 'DELETE', `/api/v1/credentials/${EVE}`, { tok: live });
});

t.test('the guarded fetch reaches only public https endpoints', async () => {
    for (const [url, why] of [['http://example.com/v1', 'https only'], ['https://127.0.0.1/v1', 'IP literal'], ['https://user:pw@example.com/v1', 'credentials in URL'], ['https://localhost:9/v1', 'resolves to loopback']]) {
        await assert.rejects(guardedFetch(url, { method: 'POST', headers: {}, body: '{}' }), (e) => e.code === 'EADDRNOTPUBLIC', why);
    }
});

t.test('without AI_CREDENTIALS_KEY the routes answer 503', async () => {
    const off = await boot({});
    const r = await request(off.base, 'PUT', `/api/v1/credentials/${DANA}`, { tok: live, body: { provider: 'openai', api_key: API_KEY } });
    assert.deepStrictEqual([r.status, r.body.code], [503, 'credentials.unavailable']);
    await off.stop();
    await h.stop();
});

t.run();
