'use strict';
// A person's own provider key (roadmap WS-O task 2; Contracts 0.73.0 ai.credential.manage):
//   - stored by a service holding ai.credential.manage, encrypted at rest and bound to its owner and subject, never
//     returned (a four-character hint only); another service neither sees nor uses it; off without AI_CREDENTIALS_KEY;
//   - a run naming it calls that provider with that key only (no fallback, never cached, the shared quota untouched),
//     logged under byo:<owner>:<subject>, and its own daily budget stops further runs (429);
//   - the guarded fetch reaches only public https endpoints.
const assert = require('assert');
const crypto = require('crypto');
const { validate } = require('openvibe-contracts');
const { boot, request, token, suite, ALL } = require('./helpers');
const { guardedFetch } = require('../server/providers/guarded-fetch');
const { createCredentials, aadFor } = require('../server/credentials');

const t = suite('credentials');
const KEY = 'ab'.repeat(32);
const DANA = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP1';
const API_KEY = 'sk-test-dana-0123456789WXYZ';
const live = token('live', [...ALL, 'ai.credential.manage']);
const tools = token('tools', [...ALL, 'ai.credential.manage']);
const noCap = token('live', ALL);
const calls = [];
const logs = [];                 // every line the service logs, for "the key is never in one"
const capture = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
let upstream = 'ok';             // 'echo401': the provider refuses and echoes the key it was sent
// The person's provider: an OpenAI-compatible endpoint, answered in-process (the guarded fetch is tested below).
const credentialFetch = async (url, init) => {
    const sent = init.headers['x-api-key'] || init.headers.Authorization || init.headers.authorization;
    calls.push({ url, auth: sent, body: JSON.parse(init.body) });
    if (upstream === 'echo401') return new Response(JSON.stringify({ error: { message: `invalid key ${sent}` } }), { status: 401, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ model: 'gpt-4o-mini', choices: [{ message: { role: 'assistant', content: 'hello from dana\'s key' } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }), { status: 200, headers: { 'content-type': 'application/json' } });
};
let h;

t.test('boot with a credentials key', async () => {
    h = await boot({ env: { AI_CREDENTIALS_KEY: KEY, AI_PRICING_JSON: JSON.stringify({ 'gpt-4o-mini': { in: 1, out: 1 } }) }, credentialFetch, log: capture });
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
    const row = await h.db.prepare('SELECT key_enc FROM subject_credentials WHERE owner = ? AND subject = ?').get('live', DANA);
    assert.ok(row.key_enc.startsWith('v2:') && !row.key_enc.includes(API_KEY), 'encrypted at rest, bound to its provider');
    // A models change keeps the stored key; a new endpoint needs it again.
    r = await request(h.base, 'PUT', `/api/v1/credentials/${DANA}`, { tok: live, body: { provider: 'openai', base_url: 'https://llm.example.com/v1', models: { chat: 'gpt-4o-mini', vision: 'gpt-4o' }, budget_usd_per_day: 0.003 } });
    assert.deepStrictEqual([r.status, r.body.key_hint, r.body.models.vision], [200, '…WXYZ', 'gpt-4o']);
    r = await request(h.base, 'PUT', `/api/v1/credentials/${DANA}`, { tok: live, body: { provider: 'openai', base_url: 'https://attacker.example/v1' } });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'credential.key_required']);
    r = await request(h.base, 'GET', `/api/v1/credentials/${DANA}`, { tok: tools });
    assert.strictEqual(r.status, 404, 'another service does not see it');
    // A row moved to another owner does not decrypt: the key is bound to owner and subject.
    await h.db.prepare("INSERT INTO subject_credentials (owner, subject, provider, base_url, key_enc, key_hint, models, created_at, updated_at) SELECT 'tools', subject, provider, base_url, key_enc, key_hint, models, created_at, updated_at FROM subject_credentials WHERE owner = 'live'").run();
    const creds = require('../server/credentials').createCredentials({ db: h.db, config: h.config });
    await assert.rejects(creds.forRun('tools', DANA));
    await h.db.prepare("DELETE FROM subject_credentials WHERE owner = 'tools'").run();
});

t.test('a run with the credential uses that key only, uncached, and its budget stops it', async () => {
    const run = async (tok = live) => await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok, body: { workflow: 'live.viewers.line', input: { role: 'chat', user: 'say hi' }, credential: { subject: DANA } } });
    let r = await run();
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.run.status, 'succeeded', JSON.stringify(r.body.run));
    assert.strictEqual(r.body.run.output.text, "hello from dana's key");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://llm.example.com/v1/chat/completions');
    assert.strictEqual(calls[0].auth, `Bearer ${API_KEY}`);
    const reqs = await h.db.prepare('SELECT provider_key, status, cost_usd FROM requests WHERE run_id = ?').all(r.body.run.id);
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


// Codes C3: one credential per provider. The provider-less route is the default one (what a v1 caller stored).
t.test('one credential per provider: the legacy route is the default, each provider keeps its own', async () => {
    const FRAN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP3';
    const DEEPSEEK_KEY = 'sk-test-deepseek-0123456789';
    const ANTHROPIC_KEY = 'sk-ant-test-0123456789FGHI';
    let r = await request(h.base, 'PUT', `/api/v1/credentials/${FRAN}/deepseek`, { tok: live, body: { key: DEEPSEEK_KEY, models: { chat: 'deepseek-chat' } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.provider, r.body.key_hint], ['deepseek', '…6789']);
    assert.ok(!r.text.includes(DEEPSEEK_KEY), 'the key never comes back');
    assert.ok(validate('ai.credential@2', r.body).valid, JSON.stringify(validate('ai.credential@2', r.body).errors));
    // A provider added on its own is not the default: the v1 route still has none.
    assert.strictEqual((await request(h.base, 'GET', `/api/v1/credentials/${FRAN}`, { tok: live })).status, 404);
    assert.strictEqual((await request(h.base, 'GET', `/api/v1/credentials/${FRAN}/deepseek`, { tok: live })).body.provider, 'deepseek');
    // The legacy route stores the default provider.
    r = await request(h.base, 'PUT', `/api/v1/credentials/${FRAN}`, { tok: live, body: { provider: 'anthropic', key: ANTHROPIC_KEY, models: { chat: 'claude-haiku-4-5-20251001' } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.provider, 'anthropic');
    assert.strictEqual((await request(h.base, 'GET', `/api/v1/credentials/${FRAN}`, { tok: live })).body.provider, 'anthropic', 'the default is the v1 route');
    assert.strictEqual((await request(h.base, 'GET', `/api/v1/credentials/${FRAN}/anthropic`, { tok: live })).body.provider, 'anthropic');
    assert.strictEqual((await request(h.base, 'GET', `/api/v1/credentials/${FRAN}/deepseek`, { tok: live })).body.provider, 'deepseek', 'the other provider is still there');
    // A body that names another provider than the route is refused; an unknown provider is a miss.
    r = await request(h.base, 'PUT', `/api/v1/credentials/${FRAN}/deepseek`, { tok: live, body: { provider: 'anthropic', key: ANTHROPIC_KEY } });
    assert.deepStrictEqual([r.status, r.body.code], [422, 'input.invalid']);
    assert.strictEqual((await request(h.base, 'GET', `/api/v1/credentials/${FRAN}/groq`, { tok: live })).status, 404);
    // custom needs its https endpoint (ai.credential-put@2).
    r = await request(h.base, 'PUT', `/api/v1/credentials/${FRAN}/custom`, { tok: live, body: { key: 'sk-test-custom-0123456789' } });
    assert.deepStrictEqual([r.status, r.body.code], [422, 'input.invalid']);
    r = await request(h.base, 'PUT', `/api/v1/credentials/${FRAN}/custom`, { tok: live, body: { key: 'sk-test-custom-0123456789', base_url: 'https://llm.example.com/anthropic' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.base_url, 'https://llm.example.com/anthropic');
    // Deleting one provider leaves the others, and the default falls back to what is left.
    assert.strictEqual((await request(h.base, 'DELETE', `/api/v1/credentials/${FRAN}/anthropic`, { tok: live })).status, 204);
    r = await request(h.base, 'GET', `/api/v1/credentials/${FRAN}`, { tok: live });
    assert.strictEqual(r.status, 200);
    assert.ok(['deepseek', 'custom'].includes(r.body.provider), r.body.provider);
});

// The additional data binds the provider: a row moved to another provider does not decrypt.
t.test('the AAD binds the provider: a row moved to another provider does not decrypt', async () => {
    const GUS = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP4';
    const key = 'sk-test-gus-0123456789ABCD';
    let r = await request(h.base, 'PUT', `/api/v1/credentials/${GUS}/anthropic`, { tok: live, body: { key, models: { chat: 'claude-haiku-4-5-20251001' } } });
    assert.strictEqual(r.status, 200, r.text);
    const row = await h.db.prepare('SELECT key_enc FROM subject_credentials WHERE owner = ? AND subject = ? AND provider = ?').get('live', GUS, 'anthropic');
    assert.ok(row.key_enc.startsWith('v2:') && !row.key_enc.includes(key));
    // Exactly what a person with the database (or a bad migration) could do: move the sealed key to another provider.
    await h.db.prepare('UPDATE subject_credentials SET provider = ? WHERE owner = ? AND subject = ? AND provider = ?').run('deepseek', 'live', GUS, 'anthropic');
    const creds = createCredentials({ db: h.db, config: h.config });
    await assert.rejects(creds.forRun('live', GUS, 'deepseek'), /unable to authenticate|bad decrypt|Unsupported state/i, 'the provider is part of the AAD');
    // The AAD string itself names all three.
    assert.strictEqual(aadFor('live', GUS, 'deepseek'), `live|${GUS}|deepseek`);
});

// Rows written before the provider dimension (v1: bound to owner|subject) still read, and are rewritten as v2.
t.test('an old v1 row still decrypts, and is upgraded to the provider-bound AAD on first use', async () => {
    const HELEN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP5';
    const key = 'sk-test-helen-0123456789JKLM';
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(KEY, 'hex'), iv);
    c.setAAD(Buffer.from(`live|${HELEN}`));   // the pre-C3 AAD
    const body = Buffer.concat([c.update(key, 'utf8'), c.final()]);
    const sealed = `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${body.toString('base64')}`;
    const at = new Date().toISOString();
    await h.db.prepare(`INSERT INTO subject_credentials (owner, subject, provider, base_url, key_enc, key_hint, models, budget_usd_day, is_default, spend_key, created_at, updated_at)
        VALUES (?, ?, 'anthropic', NULL, ?, ?, '{}', NULL, false, ?, ?, ?)`).run('live', HELEN, sealed, `…${key.slice(-4)}`, `byo:live:${HELEN}`, at, at);
    const creds = createCredentials({ db: h.db, config: h.config });
    assert.strictEqual((await creds.forRun('live', HELEN, 'anthropic')).apiKey, key, 'an old row still decrypts with the old AAD');
    const after = await h.db.prepare('SELECT key_enc FROM subject_credentials WHERE owner = ? AND subject = ? AND provider = ?').get('live', HELEN, 'anthropic');
    assert.ok(after.key_enc.startsWith('v2:'), 'rewritten with the provider-bound AAD');
    assert.strictEqual((await creds.forRun('live', HELEN, 'anthropic')).apiKey, key, 'and it reads back');
    const got = await request(h.base, 'GET', `/api/v1/credentials/${HELEN}/anthropic`, { tok: live });
    assert.deepStrictEqual([got.status, got.body.provider], [200, 'anthropic']);
    assert.ok(!got.text.includes(key));
    assert.ok(validate('ai.credential@2', got.body).valid, JSON.stringify(validate('ai.credential@2', got.body).errors));
});

// A key is never in a response, a log line or an error, even when the provider echoes it back.
t.test('a key never appears in a response, a log line or an error', async () => {
    const IVAN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP6';
    const key = 'sk-test-ivan-LEAKME-0123456789';
    let r = await request(h.base, 'PUT', `/api/v1/credentials/${IVAN}/openai`, { tok: live, body: { key, models: { chat: 'gpt-4o-mini' } } });
    assert.strictEqual(r.status, 200, r.text);
    upstream = 'echo401';
    r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body: { workflow: 'live.viewers.line', input: { role: 'chat', user: 'say hi' }, credential: { subject: IVAN, provider: 'openai' } } });
    upstream = 'ok';
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.run.status, 'failed');
    assert.ok(!r.text.includes(key), 'not in the run response');
    const run = await request(h.base, 'GET', `/api/v1/runs/${r.body.run.id}`, { tok: live });
    assert.ok(!run.text.includes(key), 'not in the run read back');
    const reqs = await h.db.prepare('SELECT error FROM requests WHERE run_id = ?').all(r.body.run.id);
    assert.ok(reqs.length && reqs.every((x) => !String(x.error || '').includes(key)), 'not in the request log');
    assert.ok(!logs.join('\n').includes(key), 'not in a log line');
    assert.ok(!calls[calls.length - 1].body.messages.some((m) => String(m.content).includes(key)));
    await request(h.base, 'DELETE', `/api/v1/credentials/${IVAN}/openai`, { tok: live });
});

t.test('without AI_CREDENTIALS_KEY the routes answer 503', async () => {
    const off = await boot({});
    const r = await request(off.base, 'PUT', `/api/v1/credentials/${DANA}`, { tok: live, body: { provider: 'openai', api_key: API_KEY } });
    assert.deepStrictEqual([r.status, r.body.code], [503, 'credentials.unavailable']);
    await off.stop();
    await h.stop();
});

t.run();
