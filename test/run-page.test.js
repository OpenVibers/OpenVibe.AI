'use strict';
/**
 * The person-facing run receipt (plan 2026-10-28 §3.10, GET /runs/:id): a Network person signs in with
 * PKCE, and sees one run only when its on_behalf_of is that person — status, workflow, model, cost,
 * times, and the output or the error, never the input or anyone else's run. The Action Center link
 * points here. The page is server-rendered, noindex, no-store, script-free and escaped.
 */
const assert = require('assert');
const crypto = require('crypto');
const { serviceAuth, ids } = require('openvibe-contracts');
const { boot, request, suite, privateKey, ISSUER } = require('./helpers');
const { sanitizeRunNext } = require('../server/console');
const items = require('../server/actions/items');

const t = suite('run-page');
const NETWORK = 'http://network.test';
const CLIENT_SECRET = `sentinel-client-${crypto.randomBytes(12).toString('hex')}`;
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

let h;
let wf;
let ada;
let bo;
let runIds = {};

// ── A fake Network: the token endpoint redeems the code for a person's access token ──
const codes = new Map();
function authorize({ subject_id, username = 'someone', expired = false }) {
    const code = crypto.randomBytes(16).toString('hex');
    codes.set(code, { subject_id, username, expired });
    return code;
}
function userToken(u) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({
        sub: 42, id: 42, ...(u.subject_id ? { subject_id: u.subject_id } : {}), username: u.username,
        iss: ISSUER, aud: ['openvibe.network'], iat: u.expired ? now - 7200 : now, exp: u.expired ? now - 3600 : now + 3600,
    }, privateKey);
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
async function fakeFetch(url, opts = {}) {
    const u = String(url);
    if (u === `${NETWORK}/oauth/token`) {
        const body = Object.fromEntries(new URLSearchParams(String(opts.body)));
        if (body.client_id !== 'ai' || body.client_secret !== CLIENT_SECRET) return json(401, { error: 'invalid_client' });
        const c = codes.get(body.code);
        if (!c) return json(400, { error: 'invalid_grant' });
        codes.delete(body.code);
        return json(200, { access_token: userToken(c), refresh_token: `rt_${crypto.randomBytes(6).toString('hex')}`, token_type: 'Bearer', expires_in: 3600 });
    }
    if (u === `${NETWORK}/oauth/revoke`) return json(200, { revoked: true });
    return globalThis.fetch(url, opts);
}

const setCookies = (res) => (res.headers.getSetCookie ? res.headers.getSetCookie() : []);
async function get(p, cookie) {
    const res = await fetch(h.base + p, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
    return { status: res.status, headers: res.headers, text: await res.text(), cookies: setCookies(res) };
}
async function signIn(subject, { username = 'ada', next = '/runs/run_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1', expired = false } = {}) {
    const login = await get(`/auth/person/login?next=${encodeURIComponent(next)}`);
    assert.strictEqual(login.status, 302, login.text);
    const loc = new URL(login.headers.get('location'));
    const flow = login.cookies.find((c) => c.startsWith('ovai_flow='));
    const code = authorize({ subject_id: subject, username, expired });
    const cb = await get(`/auth/callback?code=${code}&state=${encodeURIComponent(loc.searchParams.get('state'))}`, flow.split(';')[0]);
    const sess = cb.cookies.find((c) => c.startsWith('__Host-ovai_person=') && !c.startsWith('__Host-ovai_person=;'));
    return { login, loc, cb, setCookie: sess || null, cookie: sess ? sess.split(';')[0] : null };
}

async function addRun({ id = `run_${ids.ulid()}`, subject = ada, status = 'succeeded', created = Date.now(), started = null, finished = null,
    output = null, errorCode = null, errorDetail = null, cost = 0, model = null, provider = null, input = { prompt: 'PRIVATE-INPUT-DO-NOT-SHOW' } }) {
    await h.db.prepare(`INSERT INTO runs (id, workflow_key, workflow_version, status, requester_type, requester_id, on_behalf_of,
            input, input_hash, output, error_code, error_detail, cost_usd, provider_key, model_key, created_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, 'service', 'network', ?, ?, 'x', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, wf.key, wf.version, status, JSON.stringify({ type: 'user', id: subject }), JSON.stringify(input), output == null ? null : JSON.stringify(output),
            errorCode, errorDetail, cost, provider, model, iso(created), started ? iso(started) : null, finished ? iso(finished) : null);
    return id;
}

t.test('boot with the seeded ai.generate workflow', async () => {
    h = await boot({
        env: {
            BASE_URL: 'https://ai.test', OV_NETWORK_INTERNAL_URL: NETWORK, OV_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
            AI_CONSOLE_SESSION_SECRET: SESSION_SECRET, AI_PERSON_SESSION_TTL_MIN: '1440', AI_USER_MODULES: 'off',
        },
        fetchImpl: fakeFetch,
    });
    wf = await h.registry.getWorkflow('ai.generate');
    ada = ids.newId('user');
    bo = ids.newId('user');
});

t.test('the next is exactly one run page: open-redirect shapes go home', () => {
    for (const bad of ['//evil.com', '/\\evil.com', '/\t/runs/run_x', 'https://evil.com', '/auth/login', '/console', '/runs/', '/runs/run_nope', '', null]) {
        assert.strictEqual(sanitizeRunNext(bad), '/', JSON.stringify(bad));
    }
    const good = `/runs/run_${ids.ulid()}`;
    assert.strictEqual(sanitizeRunNext(good), good);
    const id = `run_${ids.ulid()}`;
    assert.strictEqual(items.runPage(id), `https://ai.openvibe.services/runs/${id}`);
});

t.test('anonymous: the page redirects to the person sign-in, then returns to the same run', async () => {
    const id = await addRun({ status: 'succeeded', created: Date.now() - DAY, finished: Date.now() - 1000 });
    const r = await get(`/runs/${id}`);
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get('location'), `/auth/person/login?next=${encodeURIComponent(`/runs/${id}`)}`);
    assert.strictEqual((await get('/runs/run_nope')).status, 404, 'a malformed id never starts a sign-in');
});

t.test('sign-in: PKCE S256 as client ai, a host-only person cookie, and back to the run page', async () => {
    const created = runIds.created = Date.now() - 3 * DAY;
    const id = runIds.ok = await addRun({ status: 'succeeded', created, started: created + DAY, finished: created + 2 * DAY,
        cost: 0.0012, provider: 'deepseek', model: 'deepseek-flash', output: { text: 'The answer is <script>alert(1)</script> & done.' } });
    const r = await signIn(ada, { next: `/runs/${id}` });
    assert.strictEqual(r.login.status, 302);
    assert.strictEqual(r.loc.origin + r.loc.pathname, 'https://openvibe.network/oauth/authorize');
    assert.strictEqual(r.loc.searchParams.get('client_id'), 'ai');
    assert.strictEqual(r.loc.searchParams.get('redirect_uri'), 'https://ai.test/auth/callback');
    assert.strictEqual(r.loc.searchParams.get('response_type'), 'code');
    assert.strictEqual(r.loc.searchParams.get('code_challenge_method'), 'S256');
    assert.match(r.loc.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    assert.strictEqual(r.cb.status, 303, r.cb.text);
    assert.strictEqual(r.cb.headers.get('location'), `/runs/${id}`);
    for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(r.setCookie.includes(attr), `${attr}: ${r.setCookie}`);
    assert.ok(!/domain=/i.test(r.setCookie), 'host-only');
    const maxAge = Number((r.setCookie.match(/Max-Age=(\d+)/) || [])[1]);
    assert.ok(maxAge > 0 && maxAge <= 7 * 24 * 3600, `max-age ${maxAge}`);
    const row = await h.db.prepare('SELECT * FROM person_sessions WHERE subject = ?').get(ada);
    assert.notStrictEqual(row.id_hash, r.cookie.split('=')[1], 'only a hash of the session id is stored');
    runIds.adaCookie = r.cookie;
});

t.test('the receipt shows only that person\'s run: status, workflow, model, cost, time, output; never the input', async () => {
    const r = await get(`/runs/${runIds.ok}`, runIds.adaCookie);
    assert.strictEqual(r.status, 200, r.text.slice(0, 400));
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.ok(r.text.includes('succeeded') && r.text.includes('ai.generate') && r.text.includes('deepseek-flash'));
    assert.ok(r.text.includes('$0.001200'), 'the cost');
    assert.ok(r.text.includes(`<time datetime="${iso(runIds.created)}">`), 'the created time');
    assert.ok(r.text.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; done.'), 'the output is escaped');
    assert.ok(!r.text.includes('<script>alert(1)</script>'), 'no raw output markup');
    assert.ok(!r.text.includes('PRIVATE-INPUT-DO-NOT-SHOW'), 'the input is never shown');
    assert.ok(r.text.includes('This page shows only your own run. Its input is not shown.'));
    assert.ok(!/<script/i.test(r.text), 'no script');
    assert.ok(r.text.includes('<meta name="robots" content="noindex,nofollow">'));
    assert.match(r.headers.get('content-security-policy') || '', /default-src 'none'/);
    assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer');
    assert.match(r.headers.get('cache-control') || '', /no-store/);
    assert.strictEqual((r.text.match(/<h1[ >]/g) || []).length, 1, 'one h1');
});

t.test('a failed or running run: the error or the live state, with no output yet', async () => {
    const failed = runIds.failed = await addRun({ status: 'failed', created: Date.now() - 2 * DAY, started: Date.now() - 2 * DAY, finished: Date.now() - DAY,
        errorCode: 'run.provider_error', errorDetail: '<script>it broke</script>' });
    let r = await get(`/runs/${failed}`, runIds.adaCookie);
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('<code>run.provider_error</code>') || r.text.includes('run.provider_error'));
    assert.ok(r.text.includes('&lt;script&gt;it broke&lt;/script&gt;') && !r.text.includes('<script>it broke</script>'));
    assert.ok(r.text.includes('No output: the run failed.'));

    const running = await addRun({ status: 'running', created: Date.now() - 3600_000, started: Date.now() - 1800_000, provider: 'deepseek', model: 'deepseek-flash' });
    r = await get(`/runs/${running}`, runIds.adaCookie);
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('Running') && r.text.includes('reload this page'));
    assert.ok(r.text.includes('No output yet.'));
});

t.test('another person\'s run is a 404; so is this person\'s run to another person', async () => {
    const theirs = await addRun({ subject: bo, status: 'succeeded', finished: Date.now() - 1000, output: { text: 'BO-PRIVATE-OUTPUT' } });
    let r = await get(`/runs/${theirs}`, runIds.adaCookie);
    assert.strictEqual(r.status, 404);
    assert.ok(!r.text.includes('BO-PRIVATE-OUTPUT'), 'no other person\'s output');
    const boSignIn = await signIn(bo, { username: 'bo', next: `/runs/${theirs}` });
    assert.strictEqual(boSignIn.cb.status, 303);
    r = await get(`/runs/${theirs}`, boSignIn.cookie);
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('BO-PRIVATE-OUTPUT'));
    assert.strictEqual((await get(`/runs/${runIds.ok}`, boSignIn.cookie)).status, 404);
});

t.test('a service token or an expired token starts no person session; a bad state is refused', async () => {
    const noSubject = await signIn(null, { next: '/runs/run_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1' });
    assert.strictEqual(noSubject.cb.status, 403);
    assert.strictEqual(noSubject.cookie, null);
    const expired = await signIn(ada, { expired: true, next: '/runs/run_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1' });
    assert.ok(expired.cb.status >= 400);
    assert.strictEqual(expired.cookie, null);
    const login = await get('/auth/person/login?next=%2Fruns%2Frun_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1');
    const flow = login.cookies.find((c) => c.startsWith('ovai_flow=')).split(';')[0];
    const code = authorize({ subject_id: ada });
    assert.strictEqual((await get(`/auth/callback?code=${code}&state=wrong`, flow)).status, 400);
});

t.test('a run receipt is personal: no console page and no API is opened by the person cookie', async () => {
    assert.strictEqual((await get('/console', runIds.adaCookie)).status, 401);
    assert.strictEqual((await get(`/api/v1/runs/${runIds.ok}`, runIds.adaCookie)).status, 401);
});

t.test('boot leaves the person page out of search and the API index names it', async () => {
    const robots = await request(h.base, 'GET', '/robots.txt');
    assert.ok(robots.text.includes('Disallow: /runs') && robots.text.includes('Disallow: /console') && robots.text.includes('Disallow: /auth/'));
    const index = await request(h.base, 'GET', '/');
    assert.ok(index.text.includes('GET  /runs/:id  your run receipt'));
});

t.test('stop the service', async () => { await h.stop(); });
t.run();
