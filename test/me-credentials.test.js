'use strict';
// L36 Y1/Y3/Y7/Y8: the person's own provider keys and how their runs route.
//   - GET/PUT/DELETE/POST /api/v1/me/credentials and GET/PUT /api/v1/me/ai/preferences are person-only: a service
//     token (with or without on_behalf_of) is refused, so is another site's cookie session;
//   - a token minted for openvibe.network (every site's session) may read but never write; a write needs aud
//     openvibe.ai, and a cookie write needs Origin or Sec-Fetch-Site;
//   - a key is sealed with the AAD self|subject|provider and never returned, logged or put in an error;
//   - test on save lists models, falls back to a one-token request, records 401 and a timeout;
//   - a run on_behalf_of a person tries their self key first, only_my_keys never falls back, and the explain names
//     paid_by and every attempt.
const assert = require('assert');
const crypto = require('crypto');
const { validate, schema } = require('openvibe-contracts');
const HAS_ME_CONTRACT = (() => { try { return Boolean(schema('ai.me-credential@1')); } catch { return false; } })();
const { boot, request, token, suite, ALL } = require('./helpers');
const { createCredentials, aadFor, PROVIDERS, SELF_OWNER } = require('../server/credentials');

const t = suite('me-credentials');
const KEY = 'cd'.repeat(32);
const DANA = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPX';
const API_KEY = 'sk-test-dana-0123456789WXYZ';
const ANTHROPIC_KEY = 'sk-ant-test-0123456789ABCD';
const person = token('dana', ALL, { sub: DANA, actorType: 'user' });
const siteSession = token('dana-site', ALL, { sub: DANA, actorType: 'user', extra: { aud: ['openvibe.network', 'openvibe.design'] } });
const service = token('live', [...ALL, 'ai.me.read', 'ai.me.manage']);
const serviceOnBehalf = token('live', [...ALL, 'ai.me.read', 'ai.me.manage'], { extra: { on_behalf_of: DANA } });
const calls = [];
const logs = [];
const capture = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
let mode = 'ok';
let h;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const credentialFetch = async (url, init = {}) => {
    const auth = (init.headers && (init.headers.Authorization || init.headers['x-api-key'])) || null;
    calls.push({ url, auth, body: init.body ? JSON.parse(init.body) : null });
    if (mode === 'timeout') return await new Promise(() => {});
    if (mode === 'auth') return json({ error: { message: `invalid key ${auth}` } }, 401);
    if (String(url).endsWith('/models')) {
        if (mode === 'empty') return json({ data: [] });
        return json({ data: [{ id: 'm-one' }, { id: 'm-two' }, { id: 'm-three' }] });
    }
    if (String(url).endsWith('/messages')) {
        return json({ model: 'm-one', content: [{ type: 'text', text: 'hello from dana\'s key' }], usage: { input_tokens: 4, output_tokens: 2 } });
    }
    if (String(url).endsWith('/chat/completions')) {
        return json({ model: 'm-one', choices: [{ message: { role: 'assistant', content: 'hello from dana\'s key' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
    }
    return json({});
};

t.test('boot', async () => {
    h = await boot({ env: { AI_CREDENTIALS_KEY: KEY, AI_CREDENTIAL_TEST_TIMEOUT_MS: '80' }, credentialFetch, log: capture });
});

t.test('the person routes refuse a service token, an on_behalf_of token, and another site\'s session', async () => {
    for (const tok of [service, serviceOnBehalf]) {
        const r = await request(h.base, 'GET', '/api/v1/me/credentials', { tok });
        assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied'], `${r.status} ${r.text}`);
    }
    // A person session cookie on AI's own site works, with the same-origin signal.
    const raw = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    await h.db.exec("INSERT INTO person_sessions (id_hash, subject, username, created_at, expires_at) VALUES ($1, $2, 'dana', '2026-10-01', '2030-10-01')", [hash, DANA]);
    const prefsBody = { only_my_keys: false, free_first: true, price_ceiling_usd_per_mtok: null, defaults: { text: 'auto', code: 'auto', vision: 'auto', image: 'auto' } };
    let r = await request(h.base, 'GET', '/api/v1/me/credentials', { headers: { Cookie: `ovai_person=${raw}` } });
    assert.strictEqual(r.status, 200, 'a read with no Origin or Sec-Fetch-Site still works');
    // A write with the cookie but neither header is not proof of same-origin: refused.
    r = await request(h.base, 'PUT', '/api/v1/me/ai/preferences', { headers: { Cookie: `ovai_person=${raw}` }, body: prefsBody });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied'], 'a write needs an origin signal');
    r = await request(h.base, 'PUT', '/api/v1/me/ai/preferences', { headers: { Cookie: `ovai_person=${raw}`, 'Sec-Fetch-Site': 'same-origin' }, body: prefsBody });
    assert.strictEqual(r.status, 200, 'a same-origin cookie write works');
    r = await request(h.base, 'GET', '/api/v1/me/credentials', { headers: { Cookie: `ovai_person=${raw}`, Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied'], 'another site cannot spend the session');
});

t.test('a site session token may read but never write; a token for openvibe.ai may write', async () => {
    let r = await request(h.base, 'GET', '/api/v1/me/credentials', { tok: siteSession });
    assert.strictEqual(r.status, 200, 'a site token reads the hints');
    r = await request(h.base, 'GET', '/api/v1/me/ai/preferences', { tok: siteSession });
    assert.strictEqual(r.status, 200, 'a site token reads the settings');
    const prefsBody = { only_my_keys: false, free_first: true, price_ceiling_usd_per_mtok: null, defaults: { text: 'auto', code: 'auto', vision: 'auto', image: 'auto' } };
    const writes = [
        ['PUT', '/api/v1/me/credentials/anthropic', { provider: 'anthropic', key: API_KEY }],
        ['DELETE', '/api/v1/me/credentials/anthropic', undefined],
        ['POST', '/api/v1/me/credentials/anthropic/test', undefined],
        ['PUT', '/api/v1/me/ai/preferences', prefsBody],
    ];
    for (const [method, path, body] of writes) {
        r = await request(h.base, method, path, { tok: siteSession, body });
        assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied'], `${method} ${path} refused a site session token: ${r.text}`);
    }
    // A token whose aud explicitly names openvibe.ai reaches the writes.
    r = await request(h.base, 'PUT', '/api/v1/me/ai/preferences', { tok: person, body: prefsBody });
    assert.strictEqual(r.status, 200, r.text);
});

t.test('store a key: sealed with self|subject|provider, a four-character hint, never the key', async () => {
    mode = 'ok';
    let r = await request(h.base, 'PUT', `/api/v1/me/credentials/anthropic`, { tok: person, body: { provider: 'anthropic', key: ANTHROPIC_KEY, budget_usd_per_day: 4, models: { chat: 'm-one' } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.provider, r.body.hint, r.body.status, r.body.models_count], ['anthropic', 'ABCD', 'ok', 3]);
    if (HAS_ME_CONTRACT) assert.ok(validate('ai.me-credential@1', r.body).valid, JSON.stringify(validate('ai.me-credential@1', r.body).errors));
    assert.ok(!r.text.includes(ANTHROPIC_KEY), 'the key never comes back');
    const row = await h.db.prepare('SELECT key_enc, key_hint, owner FROM subject_credentials WHERE owner = ? AND subject = ? AND provider = ?').get(SELF_OWNER, DANA, 'anthropic');
    assert.strictEqual(row.owner, 'self');
    assert.ok(row.key_enc.startsWith('v2:') && !row.key_enc.includes(ANTHROPIC_KEY), 'encrypted at rest');
    assert.ok(!logs.join('\n').includes(ANTHROPIC_KEY), 'not in a log line');
    const creds = createCredentials({ db: h.db, config: h.config });
    const cred = await creds.forRun('self', DANA, 'anthropic');
    assert.strictEqual(cred.apiKey, ANTHROPIC_KEY, 'opens with self|subject|provider');
    assert.strictEqual(aadFor('self', DANA, 'anthropic'), `self|${DANA}|anthropic`);
    // The AAD binds the provider: a row moved elsewhere does not decrypt.
    await h.db.prepare('UPDATE subject_credentials SET provider = ? WHERE owner = ? AND subject = ? AND provider = ?').run('openai', SELF_OWNER, DANA, 'anthropic');
    await assert.rejects(creds.forRun('self', DANA, 'openai'), /unable to authenticate|bad decrypt|Unsupported state/i);
    await h.db.prepare('UPDATE subject_credentials SET provider = ? WHERE owner = ? AND subject = ? AND provider = ?').run('anthropic', SELF_OWNER, DANA, 'openai');
});

t.test('test on save: success, an empty model list, a 401 and a timeout', async () => {
    // success already covered above (3 models). An empty list makes one one-token request.
    mode = 'empty';
    let r = await request(h.base, 'PUT', '/api/v1/me/credentials/openai', { tok: person, body: { provider: 'openai', key: API_KEY, models: { chat: 'm-chat' } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.status, r.body.models_count, r.body.last_error], ['ok', 0, null]);
    assert.ok(calls.some((c) => c.url.endsWith('/chat/completions') && c.body.max_tokens === 1), 'one token');
    // A 401 is failing, and the key is redacted from the error the provider echoed.
    mode = 'auth';
    r = await request(h.base, 'PUT', '/api/v1/me/credentials/openai', { tok: person, body: { provider: 'openai', key: API_KEY } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.status, 'failing');
    assert.ok(r.body.last_error && /refused/i.test(r.body.last_error), r.body.last_error);
    assert.ok(!r.body.last_error.includes(API_KEY), 'the key is not in the stored error');
    assert.ok(!r.text.includes(API_KEY), 'the key never comes back');
    // A timeout is failing after the (test-shortened) 10 s deadline.
    mode = 'timeout';
    r = await request(h.base, 'PUT', '/api/v1/me/credentials/gemini', { tok: person, body: { provider: 'gemini', key: 'sk-test-gemini-0123456789' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.status, r.body.last_error], ['failing', 'no response within 0s']);
    mode = 'ok';
    // Every console provider is storable, not only today's list.
    for (const provider of ['mistral', 'xai', 'groq', 'cerebras', 'together', 'fireworks']) {
        assert.ok(PROVIDERS.includes(provider), `${provider} is a provider`);
    }
});

t.test('a custom endpoint goes through the guarded fetcher\'s egress rules', async () => {
    const real = createCredentials({ db: h.db, config: h.config });   // no test fetch: the production guarded fetcher
    const out = await real.putSelf(DANA, 'custom', { provider: 'custom', key: 'sk-test-custom-0123456789', base_url: 'https://127.0.0.1/v1' });
    assert.strictEqual(out.status, 'failing');
    assert.ok(/IP-literal|non-public|refused|https/i.test(out.last_error), out.last_error);
    await real.removeSelf(DANA, 'custom');
});

t.test('preferences are per person, with defaults and a model per kind', async () => {
    let r = await request(h.base, 'GET', '/api/v1/me/ai/preferences', { tok: person });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.only_my_keys, r.body.free_first, r.body.defaults.text], [false, true, 'auto']);
    r = await request(h.base, 'PUT', '/api/v1/me/ai/preferences', { tok: person, body: { only_my_keys: true, free_first: false, price_ceiling_usd_per_mtok: 5, defaults: { text: 'm-default', code: 'auto', vision: 'auto', image: 'auto' } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.only_my_keys, r.body.free_first, r.body.price_ceiling_usd_per_mtok, r.body.defaults.text], [true, false, 5, 'm-default']);
    const other = token('bob', ALL, { sub: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPY', actorType: 'user' });
    r = await request(h.base, 'GET', '/api/v1/me/ai/preferences', { tok: other });
    assert.strictEqual(r.body.only_my_keys, false, 'preferences are per person');
});

t.test('a run on behalf of the person tries their key first; only_my_keys never falls back', async () => {
    // Dana already has an anthropic key; give her an OpenAI key that works (empty list, one-token) and a stored model.
    mode = 'ok';
    let r = await request(h.base, 'PUT', '/api/v1/me/credentials/openai', { tok: person, body: { provider: 'openai', key: API_KEY, models: { chat: 'm-chat' } } });
    assert.strictEqual(r.status, 200, r.text);
    const run = async () => await request(h.base, 'POST', '/api/v1/runs?wait=8000', { tok: service, body: { workflow: 'live.viewers.line', input: { role: 'chat', user: 'say hi' }, on_behalf_of: { type: 'user', id: DANA } } });
    r = await run();
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.run.status, 'succeeded', JSON.stringify(r.body.run).slice(0, 600));
    assert.strictEqual(r.body.run.output.text, "hello from dana's key", JSON.stringify(r.body.run).slice(0, 1200));
    assert.ok(r.body.run.explain && r.body.run.explain.paid_by === `your anthropic key …${ANTHROPIC_KEY.slice(-4)}`, JSON.stringify(r.body.run.explain));
    assert.ok(r.body.run.explain.attempts.some((a) => a.provider === 'anthropic' && a.status === 'ok' && a.key === r.body.run.explain.paid_by));
    // only_my_keys: a refused key is an explicit ai.needs_key, never a network fallback.
    r = await request(h.base, 'PUT', '/api/v1/me/ai/preferences', { tok: person, body: { only_my_keys: true, free_first: true, price_ceiling_usd_per_mtok: null, defaults: { text: 'auto', code: 'auto', vision: 'auto', image: 'auto' } } });
    assert.strictEqual(r.status, 200, r.text);
    mode = 'auth';
    r = await run();
    assert.strictEqual(r.body.run.status, 'failed', JSON.stringify(r.body.run).slice(0, 600));
    assert.strictEqual(r.body.run.error.code, 'ai.needs_key');
    assert.ok(/anthropic|openai/.test(String(r.body.run.error.detail)), `the error names the providers: ${r.body.run.error.detail}`);
    assert.ok(!r.text.includes(API_KEY), 'the key is never in the answer');
    // Without only_my_keys the network is the fallback, and explain says which key paid and what failed.
    r = await request(h.base, 'PUT', '/api/v1/me/ai/preferences', { tok: person, body: { only_my_keys: false, free_first: true, price_ceiling_usd_per_mtok: null, defaults: { text: 'auto', code: 'auto', vision: 'auto', image: 'auto' } } });
    assert.strictEqual(r.status, 200, r.text);
    r = await run();
    assert.strictEqual(r.body.run.status, 'succeeded', JSON.stringify(r.body.run).slice(0, 600));
    assert.strictEqual(r.body.run.explain.paid_by, 'openvibe');
    assert.ok(r.body.run.explain.attempts.some((a) => a.key.startsWith('your ') && a.status === 'failed'));
    const status = await h.db.prepare('SELECT status, last_error FROM subject_credentials WHERE owner = ? AND subject = ? AND provider = ?').get(SELF_OWNER, DANA, 'openai');
    assert.strictEqual(status.status, 'failing', 'a 401 marks the key failing');
    assert.ok(status.last_error && !status.last_error.includes(API_KEY));
    await request(h.base, 'DELETE', '/api/v1/me/credentials/openai', { tok: person });
});

t.test('a key never appears in a response, a log line or an error', async () => {
    const IVAN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPZ';
    const ivan = token('ivan', ALL, { sub: IVAN, actorType: 'user' });
    const key = 'sk-test-ivan-LEAKME-0123456789';
    mode = 'auth';
    const r = await request(h.base, 'PUT', `/api/v1/me/credentials/openai`, { tok: ivan, body: { provider: 'openai', key, models: { chat: 'm-chat' } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(!r.text.includes(key), 'not in the response');
    assert.ok(!logs.join('\n').includes(key), 'not in a log line');
    assert.ok(!String(r.body.last_error || '').includes(key), 'not in the error');
    const row = await h.db.prepare('SELECT last_error FROM subject_credentials WHERE owner = ? AND subject = ? AND provider = ?').get(SELF_OWNER, IVAN, 'openai');
    assert.ok(!String(row.last_error).includes(key), 'not in the stored error');
    mode = 'ok';
    await request(h.base, 'DELETE', `/api/v1/me/credentials/openai`, { tok: ivan });
});

t.test('shutdown', async () => { await h.stop(); });

t.run();
