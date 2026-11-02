'use strict';
// Your AI (plan L36 Y1/Y3/Y8): GET /you and its forms on ai.openvibe.services. Signed out it says what it is; signed in
// (AI's own person session) it lists every provider with the person's key state, saves, tests and removes keys, and
// sets how their AI is paid. Every POST needs this site's own origin signal; a key never comes back in the page.
const assert = require('assert');
const crypto = require('crypto');
const { boot, suite } = require('./helpers');
const { SELF_OWNER } = require('../server/credentials');

const t = suite('you-page');
const KEY = 'ef'.repeat(32);
const DANA = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPY';
const ANTHROPIC_KEY = 'sk-ant-test-you-0123456789WXYZ';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let refuse = false;
const credentialFetch = async (url) => {
    if (refuse) return json({ error: { message: 'invalid key' } }, 401);
    if (String(url).endsWith('/models')) return json({ data: [{ id: 'm-one' }, { id: 'm-two' }] });
    return json({});
};
let h, cookie;
const page = (path, o = {}) => fetch(h.base + path, { redirect: 'manual', ...o, headers: { ...(o.headers || {}) } }).then(async (r) => ({ status: r.status, headers: r.headers, text: await r.text() }));
const post = (path, fields, headers = { 'Sec-Fetch-Site': 'same-origin' }) => page(path, { method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', Cookie: cookie, ...headers } });
const flash = (r) => Object.fromEntries(new URLSearchParams(String(r.headers.get('location') || '').split('?')[1] || ''));

t.test('boot', async () => {
    h = await boot({ env: { AI_CREDENTIALS_KEY: KEY, AI_CREDENTIAL_TEST_TIMEOUT_MS: '80' }, credentialFetch, log: { log() {}, warn() {}, error() {} } });
    const raw = crypto.randomBytes(32).toString('base64url');
    await h.db.exec("INSERT INTO person_sessions (id_hash, subject, username, created_at, expires_at) VALUES ($1, $2, 'dana', '2026-10-01', '2030-10-01')", [crypto.createHash('sha256').update(raw).digest('hex'), DANA]);
    cookie = `ovai_person=${raw}`;
});

t.test('signed out: what it is and a sign-in, private and not indexed', async () => {
    const r = await page('/you');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('x-robots-tag'), /noindex/);
    assert.ok(r.text.includes('Your keys, on every OpenVibe site.') && r.text.includes('href="/auth/person/login?next=%2Fyou"'));
});

t.test('signed in: every provider, none added yet, and how the AI is paid', async () => {
    const r = await page('/you', { headers: { Cookie: cookie } });
    assert.strictEqual(r.status, 200);
    for (const name of ['Anthropic', 'OpenAI', 'Google Gemini', 'DeepSeek', 'Mistral', 'xAI', 'Groq', 'OpenRouter', 'Another OpenAI-compatible API']) assert.ok(r.text.includes(`<summary>${name}<span>Add</span></summary>`), name);
    assert.ok(r.text.includes('No keys yet.'), 'an empty list says so');
    assert.ok(r.text.includes('action="/you/keys/anthropic"') && r.text.includes('href="https://console.anthropic.com/settings/keys"'), 'a form and where to get a key');
    assert.ok(r.text.includes('name="only_my_keys" value="0" checked'), 'my keys first by default');
    assert.ok(r.text.includes('href="https://openvibe.report/you"'), 'what it cost is on Report');
});

t.test('save a key: sealed, tested, never shown again; the page says it works', async () => {
    const r = await post('/you/keys/anthropic', { key: ANTHROPIC_KEY });
    assert.strictEqual(r.status, 303);
    assert.match(flash(r).ok, /Saved your Anthropic key, and it works/);
    const row = await h.db.prepare('SELECT key_enc, status FROM subject_credentials WHERE owner = ? AND subject = ? AND provider = ?').get(SELF_OWNER, DANA, 'anthropic');
    assert.ok(row && row.key_enc.startsWith('v2:') && !row.key_enc.includes(ANTHROPIC_KEY));
    const view = await page('/you', { headers: { Cookie: cookie } });
    assert.ok(view.text.includes('Working') && view.text.includes('…WXYZ') && view.text.includes('2 models'));
    assert.ok(!view.text.includes(ANTHROPIC_KEY), 'the key never comes back');
    assert.ok(view.text.includes('action="/you/keys/anthropic/test"') && view.text.includes('Replace the key'));
    assert.ok(view.text.includes('<b>Anthropic</b>') && !view.text.includes('<summary>Anthropic<span>Add</span></summary>'), 'a saved key moves out of the add list');
});

t.test('a key the provider refuses is saved and says so; test and remove work', async () => {
    refuse = true;
    let r = await post('/you/keys/openai', { key: 'sk-test-you-refused-012345' });
    assert.match(flash(r).error, /Saved your OpenAI key, but it did not work/);
    r = await post('/you/keys/openai/test', {});
    assert.match(flash(r).error, /did not work/);
    refuse = false;
    r = await post('/you/keys/openai/test', {});
    assert.match(flash(r).ok, /Your OpenAI key works/);
    r = await post('/you/keys/openai/remove', {});
    assert.match(flash(r).ok, /Removed your OpenAI key/);
    r = await post('/you/keys/openai/remove', {});
    assert.match(flash(r).error, /no key to remove/);
});

t.test('how the AI is paid: only my keys, free tiers, a ceiling', async () => {
    const r = await post('/you/preferences', { only_my_keys: '1', price_ceiling_usd_per_mtok: '2.5' });
    assert.match(flash(r).ok, /Saved how your AI is paid/);
    const view = await page('/you', { headers: { Cookie: cookie } });
    assert.ok(view.text.includes('name="only_my_keys" value="1" checked') && view.text.includes('<b>Only your keys</b>'));
    assert.ok(view.text.includes('Free tiers first: <b>off</b>'), 'an unticked box is off');
    assert.ok(view.text.includes('value="2.5"'));
});

t.test('another site, a missing origin signal or no session cannot change anything', async () => {
    let r = await post('/you/keys/anthropic/remove', {}, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' });
    assert.strictEqual(r.status, 403);
    r = await post('/you/keys/anthropic/remove', {}, {});
    assert.strictEqual(r.status, 403, 'no origin signal at all is refused');
    r = await page('/you/preferences', { method: 'POST', body: 'only_my_keys=0', headers: { 'content-type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' } });
    assert.strictEqual(r.status, 303);
    assert.match(r.headers.get('location'), /^\/auth\/person\/login/);
    const still = await h.db.prepare('SELECT 1 AS x FROM subject_credentials WHERE owner = ? AND subject = ? AND provider = ?').get(SELF_OWNER, DANA, 'anthropic');
    assert.ok(still, 'the key is still there');
});

t.test('close', async () => { await h.close(); });
t.run();
