'use strict';
// The operator console (WS-O task 4): Network SSO with PKCE as client `ai`; staff-only access through
// the contracts staff map (anonymous -> sign-in page, a user or global_mod -> 403 and no session, an
// admin reads and manages workflows, only the owner manages providers, quotas and the cache); the
// session is re-mapped on every request; every page is server-rendered with no script, noindex,
// no-store, a strict CSP, captioned tables and labelled controls, and carries no secret value; every
// write needs the CSRF token and a same-origin request and writes the same audit row as the admin API
// (actor = the person); the failed-runs filters; the run detail page's bounded input; robots.txt;
// the nginx vhost; and 503 in production without the session secret.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { serviceAuth, ids } = require('openvibe-contracts');
const { boot, request, token, suite, seamServer, privateKey, ISSUER, ALL } = require('./helpers');
const { sanitizeNext, consoleCapabilities } = require('../server/console');
const { preview } = require('../server/console/queries');

const t = suite('console');
const NETWORK = 'http://network.test';
// Generated per run: nothing that looks like a credential is written into the repository.
const PROVIDER_SECRET = `sentinel-provider-${crypto.randomBytes(12).toString('hex')}`;
const CLIENT_SECRET = `sentinel-client-${crypto.randomBytes(12).toString('hex')}`;
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const SECRETS = [PROVIDER_SECRET, CLIENT_SECRET, SESSION_SECRET];
const ops = token('ops', ALL);
const live = token('live', ['ai.run.create', 'ai.run.read']);
const news = token('news', ['ai.run.create', 'ai.run.read']);

// ── A fake Network: /oauth/token redeems PKCE-bound codes for user access tokens, /oauth/revoke ──
const codes = new Map();
const grants = [];
const revoked = [];
function authorize({ subject_id, role = 'user', is_owner = false, username = 'someone', staff_caps, challenge, redirect_uri }) {
    const code = crypto.randomBytes(16).toString('hex');
    codes.set(code, { subject_id, role, is_owner, username, staff_caps, challenge, redirect_uri });
    return code;
}
function userToken(u) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({
        sub: 42, id: 42, ...(u.subject_id ? { subject_id: u.subject_id } : {}), username: u.username, role: u.role, ...(u.is_owner ? { is_owner: true } : {}),
        ...(u.staff_caps ? { staff_caps: u.staff_caps, staff_map: '1.1.0' } : {}),
        iss: ISSUER, aud: ['openvibe.live', 'openvibe.network'], iat: now, exp: now + 3600,
    }, privateKey);
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
async function fakeFetch(url, opts = {}) {
    const u = String(url);
    if (u === `${NETWORK}/oauth/token`) {
        const body = Object.fromEntries(new URLSearchParams(String(opts.body)));
        grants.push(body);
        if (body.client_id !== 'ai' || body.client_secret !== CLIENT_SECRET) return json(401, { error: 'invalid_client' });
        const c = codes.get(body.code);
        if (!c) return json(400, { error: 'invalid_grant' });
        codes.delete(body.code);
        if (c.redirect_uri !== body.redirect_uri) return json(400, { error: 'invalid_grant', error_description: 'Redirect URI mismatch' });
        if (crypto.createHash('sha256').update(String(body.code_verifier || '')).digest('base64url') !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return json(200, { access_token: userToken(c), refresh_token: `rt_${crypto.randomBytes(6).toString('hex')}`, token_type: 'Bearer', expires_in: 3600 });
    }
    if (u === `${NETWORK}/oauth/revoke`) { revoked.push(JSON.parse(String(opts.body)).token); return json(200, { revoked: true }); }
    return globalThis.fetch(url, opts);
}

let h;
let seam;
let slow;
const people = { user: ids.newId('user'), mod: ids.newId('user'), admin: ids.newId('user'), owner: ids.newId('user') };
const cookies = {};
const csrf = {};
const runIds = {};

const setCookies = (res) => (res.headers.getSetCookie ? res.headers.getSetCookie() : []);
async function get(p, cookie, headers = {}) {
    const res = await fetch(h.base + p, { redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
    return { status: res.status, headers: res.headers, text: await res.text(), cookies: setCookies(res) };
}
async function post(p, cookie, form, headers = {}) {
    const res = await fetch(h.base + p, {
        method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: new URLSearchParams(form).toString(),
    });
    return { status: res.status, headers: res.headers, text: await res.text(), cookies: setCookies(res) };
}
async function signIn(subject, { role = 'admin', is_owner = false, username = 'staffer', staff_caps, next = '/console' } = {}) {
    const login = await get(`/auth/login?next=${encodeURIComponent(next)}`);
    assert.strictEqual(login.status, 302);
    const loc = new URL(login.headers.get('location'));
    const flow = login.cookies.find((c) => c.startsWith('ovai_flow='));
    const code = authorize({ subject_id: subject, role, is_owner, username, staff_caps, challenge: loc.searchParams.get('code_challenge'), redirect_uri: loc.searchParams.get('redirect_uri') });
    const cb = await get(`/auth/callback?code=${code}&state=${encodeURIComponent(loc.searchParams.get('state'))}`, flow.split(';')[0]);
    const sess = cb.cookies.find((c) => c.startsWith('__Host-ovai_staff=') && !c.startsWith('__Host-ovai_staff=;'));
    return { cb, setCookie: sess || null, cookie: sess ? sess.split(';')[0] : null };
}
const csrfOf = (page) => (page.text.match(/name="_csrf" value="([^"]+)"/) || [])[1];
const auditRows = (where, ...args) => h.db.prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY id`).all(...args);
const sessionCount = () => h.db.prepare('SELECT COUNT(*) AS n FROM console_sessions').get().n;

/** Controls that are neither hidden nor inside a <label>. */
function unlabelled(text) {
    const out = [];
    const re = /<(input|select|textarea)\b[^>]*>/g;
    let m;
    while ((m = re.exec(text))) {
        if (/type="(hidden|submit)"/.test(m[0])) continue;
        const before = text.slice(0, m.index);
        if (before.lastIndexOf('<label') === -1 || before.lastIndexOf('</label>') > before.lastIndexOf('<label')) out.push(m[0]);
    }
    return out;
}
function assertPage(r, p) {
    assert.strictEqual(r.status, 200, `${p}: ${r.status} ${r.text.slice(0, 300)}`);
    assert.match(r.headers.get('content-type'), /text\/html/, p);
    assert.ok(!/<script/i.test(r.text), `${p}: no script`);
    assert.ok(!/ style="/.test(r.text), `${p}: no inline style attribute (the CSP would block it)`);
    const csp = r.headers.get('content-security-policy') || '';
    assert.ok(csp.includes("default-src 'none'") && csp.includes("form-action 'self'") && csp.includes("frame-ancestors 'none'") && !csp.includes('unsafe-inline'), `${p}: CSP ${csp}`);
    assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow', p);
    assert.ok(r.text.includes('<meta name="robots" content="noindex,nofollow">'), `${p}: meta robots`);
    assert.match(r.headers.get('cache-control') || '', /no-store/, p);
    assert.strictEqual((r.text.match(/<h1[ >]/g) || []).length, 1, `${p}: one h1`);
    assert.strictEqual((r.text.match(/<table/g) || []).length, (r.text.match(/<caption>/g) || []).length, `${p}: every table has a caption`);
    assert.deepStrictEqual(unlabelled(r.text), [], `${p}: every control is labelled`);
    for (const s of SECRETS) assert.ok(!r.text.includes(s), `${p}: a secret value leaked`);
    assert.ok(!r.text.includes('[redacted]'), `${p}: the page itself rendered a secret (the last-resort scrubber caught it)`);
}

t.test('boot with a provider secret, a seam provider, a failing stub and a few runs', async () => {
    seam = await seamServer(() => ({ text: 'a real answer', model: 'seam-model', usage: { input: 12, output: 4 } }));
    slow = await seamServer(() => new Promise((r) => setTimeout(() => r({ text: 'late' }), 3000)));
    h = await boot({
        env: {
            BASE_URL: 'https://ai.test', OV_NETWORK_INTERNAL_URL: NETWORK, OV_OAUTH_CLIENT_SECRET: CLIENT_SECRET, AI_CONSOLE_SESSION_SECRET: SESSION_SECRET,
            AI_USER_MODULES: 'off', AI_API_KEY: PROVIDER_SECRET, AI_PROVIDER: 'openai', AI_BASE_URL: 'http://127.0.0.1:1/v1', AI_STUB_FALLBACK: 'false',
        },
        fetchImpl: fakeFetch,
    });
    const provider = async (body) => { const r = await request(h.base, 'POST', '/api/v1/providers', { tok: ops, body: { auth_mode: 'none', capabilities: ['chat', 'generate', 'summarize', 'json'], timeout_ms: 5000, ...body } }); assert.strictEqual(r.status, 201, r.text); };
    await provider({ key: 'badstub', kind: 'stub', metadata: { fail: 'error' } });
    await provider({ key: 'okseam', kind: 'http', base_url: `${seam.url}/complete?token=xxxxxxxxxxxx` });
    await provider({ key: 'slowseam', kind: 'http', base_url: slow.url });
    const route = async (p) => assert.strictEqual((await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: ops, body: { primary: { provider: p }, fallbacks: [] } })).status, 201);
    const gen = async (tok, prompt, extra = {}) => (await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok, body: { workflow: 'ai.generate', input: { prompt, ...extra } } })).body.run;
    await route('badstub');
    const f1 = await gen(live, 'this will fail');
    const f2 = await gen(news, 'this will fail too');
    assert.strictEqual(f1.status, 'failed');
    assert.strictEqual(f2.status, 'failed');
    runIds.failLive = f1.id;
    runIds.failNews = f2.id;
    runIds.code = f1.error.code;
    await route('okseam');
    const ok = await gen(live, `${'long prompt text '.repeat(40)}END-OF-PROMPT`);
    assert.strictEqual(ok.status, 'succeeded', JSON.stringify(ok.error));
    runIds.ok = ok.id;
    assert.ok(h.cache.stats().length >= 1, 'a real answer was cached');
});

t.test('the staff map: admin reads and manages workflows, only the owner manages providers, a global_mod gets nothing', () => {
    assert.deepStrictEqual(consoleCapabilities({ role: 'admin' }), ['ai.usage.read', 'ai.workflow.manage']);
    assert.deepStrictEqual(consoleCapabilities({ role: 'admin', is_owner: true }), ['ai.usage.read', 'ai.workflow.manage', 'ai.provider.manage']);
    assert.deepStrictEqual(consoleCapabilities({ role: 'global_mod' }), []);
    assert.deepStrictEqual(consoleCapabilities({ role: 'user' }), []);
    assert.deepStrictEqual(consoleCapabilities({ role: 'owner' }), [], 'owner is never a stored role claim');
    assert.deepStrictEqual(consoleCapabilities({ role: 'admin', staff_caps: ['staff.site.view'], staff_map: '1.1.0' }), ['ai.usage.read'], 'issued staff capabilities win over the role');
});

t.test('anonymous: console pages answer the sign-in page (401), never data; writes change nothing', async () => {
    for (const p of ['/console', '/console/runs?status=failed', '/console/providers', '/console/audit', `/console/runs/${runIds.failLive}`, '/console/nope']) {
        const r = await get(p);
        assert.strictEqual(r.status, 401, p);
        assert.ok(r.text.includes('Sign in with OpenVibe.Network'), p);
        assert.ok(!r.text.includes('<table'), `${p}: no data`);
        assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow');
    }
    assert.ok((await get('/console/runs?status=failed')).text.includes(`href="/auth/login?next=${encodeURIComponent('/console/runs?status=failed')}"`));
    const before = h.quotas.list().length;
    assert.strictEqual((await post('/console/quotas', null, { scope_type: 'service', scope_id: 'live', window: 'day', max_requests: '1' })).status, 401);
    assert.strictEqual((await post('/console/providers/okseam/status', null, { status: 'disabled' })).status, 401);
    assert.strictEqual(h.quotas.list().length, before);
    assert.strictEqual(h.registry.getProvider('okseam').status, 'active');
});

t.test('sign-in redirects to the Network with PKCE S256 as client ai, with a signed host-only flow cookie', async () => {
    const login = await get('/auth/login?next=/console/runs');
    assert.strictEqual(login.status, 302);
    const loc = new URL(login.headers.get('location'));
    assert.strictEqual(loc.origin + loc.pathname, 'https://openvibe.network/oauth/authorize');
    assert.strictEqual(loc.searchParams.get('client_id'), 'ai');
    assert.strictEqual(loc.searchParams.get('redirect_uri'), 'https://ai.test/auth/callback');
    assert.strictEqual(loc.searchParams.get('response_type'), 'code');
    assert.strictEqual(loc.searchParams.get('code_challenge_method'), 'S256');
    assert.match(loc.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    assert.ok(loc.searchParams.get('state').length >= 32);
    const flow = login.cookies.find((c) => c.startsWith('ovai_flow='));
    for (const attr of ['HttpOnly', 'Secure', 'Path=/auth', 'SameSite=Lax']) assert.ok(flow.includes(attr), `flow cookie ${attr}: ${flow}`);
    assert.ok(!/domain=/i.test(flow));
    assert.strictEqual(login.headers.get('x-robots-tag'), 'noindex, nofollow');
});

t.test('the callback refuses a missing or mismatched state, a forged flow cookie and a code bound to another challenge', async () => {
    const login = await get('/auth/login');
    const loc = new URL(login.headers.get('location'));
    const flow = login.cookies.find((c) => c.startsWith('ovai_flow=')).split(';')[0];
    const redirect = loc.searchParams.get('redirect_uri');
    let code = authorize({ subject_id: people.admin, role: 'admin', challenge: loc.searchParams.get('code_challenge'), redirect_uri: redirect });
    assert.strictEqual((await get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`)).status, 400, 'no flow cookie');
    assert.strictEqual((await get(`/auth/callback?code=${code}&state=wrong`, flow)).status, 400, 'wrong state');
    const [body] = flow.slice('ovai_flow='.length).split('.');
    assert.strictEqual((await get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`, `ovai_flow=${body}.forged`)).status, 400, 'forged signature');
    code = authorize({ subject_id: people.admin, role: 'admin', challenge: 'A'.repeat(43), redirect_uri: redirect });
    assert.strictEqual((await get(`/auth/callback?code=${code}&state=${encodeURIComponent(loc.searchParams.get('state'))}`, flow)).status, 400, 'PKCE mismatch');
    assert.strictEqual(sessionCount(), 0);
});

t.test('non-staff get 403 and no session: a user, a global_mod, a token without a subject; refusals are audited', async () => {
    for (const [subject, role] of [[people.user, 'user'], [people.mod, 'global_mod'], [null, 'admin']]) {
        const r = await signIn(subject, { role });
        assert.strictEqual(r.cb.status, 403, `${role} ${subject}`);
        assert.strictEqual(r.cookie, null);
        assert.ok(r.cb.text.includes('only for OpenVibe.Network staff'));
    }
    assert.strictEqual(sessionCount(), 0);
    const refused = auditRows("action = 'console.sign_in.refused'");
    assert.deepStrictEqual(refused.map((x) => x.actor).sort(), ['anonymous', people.mod, people.user].sort());
    assert.ok(refused.every((x) => /^[0-9a-f]{32}$/.test(JSON.parse(x.metadata).ip_hash)), 'the client address is kept as a keyed hash');
    assert.ok(revoked.length >= 3, 'the Network refresh token is revoked straight away');
});

t.test('an admin signs in: host-only, HttpOnly, Secure, SameSite=Strict, short-lived session; back to the page asked for', async () => {
    const r = await signIn(people.admin, { username: 'goosely', next: '/console/runs?status=failed' });
    assert.strictEqual(r.cb.status, 303);
    assert.strictEqual(r.cb.headers.get('location'), '/console/runs?status=failed');
    for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(r.setCookie.includes(attr), `${attr}: ${r.setCookie}`);
    assert.ok(!/domain=/i.test(r.setCookie), 'host-only');
    const maxAge = Number((r.setCookie.match(/Max-Age=(\d+)/) || [])[1]);
    assert.ok(maxAge > 0 && maxAge <= 3600, `max-age ${maxAge}`);
    cookies.admin = r.cookie;
    const row = h.db.prepare('SELECT * FROM console_sessions WHERE subject = ?').get(people.admin);
    assert.notStrictEqual(row.id_hash, r.cookie.split('=')[1], 'only a hash of the session id is stored');
    assert.strictEqual(JSON.parse(row.staff).role, 'admin');
    assert.strictEqual(auditRows("action = 'console.sign_in' AND actor = ?", people.admin).length, 1);
    const g = grants.filter((x) => x.grant_type === 'authorization_code').pop();
    assert.strictEqual(g.client_id, 'ai');
    assert.strictEqual(g.redirect_uri, 'https://ai.test/auth/callback');
});

t.test('next is always a console page: open-redirect shapes go to /console', async () => {
    for (const bad of ['//evil.com', '/\\evil.com', '/\t/evil.com', '/\n/evil.com', 'https://evil.com', '/auth/login', '/api/v1/runs', '/consolex', `/console/${'a'.repeat(400)}`, '', null]) {
        assert.strictEqual(sanitizeNext(bad), '/console', JSON.stringify(bad));
    }
    for (const good of ['/console', '/console/runs?status=failed', '/console/workflows/ai.generate']) assert.strictEqual(sanitizeNext(good), good);
    const r = await signIn(people.admin, { next: '//evil.com' });
    assert.strictEqual(r.cb.headers.get('location'), '/console');
});

t.test('every page: server-rendered, no script, noindex, no-store, strict CSP, captions and labels, no secret value', async () => {
    const list = ['/console', '/console/providers', '/console/routes', '/console/routes/default.chat', '/console/routes/default.chat?version=1', '/console/templates',
        '/console/templates/ai.generate', '/console/workflows', '/console/workflows/ai.generate', '/console/runs', '/console/runs?status=failed',
        `/console/runs/${runIds.failLive}`, `/console/runs/${runIds.ok}`, '/console/quotas', '/console/usage', '/console/cache', '/console/audit', '/console/audit?kind=all'];
    for (const p of list) assertPage(await get(p, cookies.admin), p);
    const prov = await get('/console/providers', cookies.admin);
    assert.ok(prov.text.includes('<code>env:AI_API_KEY</code>'), 'the secret reference name is shown');
    assert.ok(prov.text.includes(`${seam.url}/complete`) && !prov.text.includes('token='), 'base URLs lose their query string');
    assert.ok(!prov.text.includes('action="/console/providers/okseam/status"'), 'an admin gets no provider buttons');
    assert.ok(prov.text.includes('need <code>ai.provider.manage</code> (the owner'));
    const wf = await get('/console/workflows/ai.generate', cookies.admin);
    assert.ok(wf.text.includes('/versions/1/status"'), 'an admin can change workflow version status');
    assert.strictEqual((await get('/console/runs/run_00000000000000000000000000', cookies.admin)).status, 404);
    assert.strictEqual((await get('/console/nope', cookies.admin)).status, 404);
});

t.test('an admin cannot use owner-only actions (ai.provider.manage): 403, audited, nothing changes', async () => {
    const page = await get('/console/providers', cookies.admin);
    csrf.admin = csrfOf(page);
    assert.ok(csrf.admin, 'the sign-out form carries the CSRF token');
    for (const [p, form] of [['/console/providers/okseam/status', { status: 'disabled' }], ['/console/providers/okseam/reset', {}], ['/console/quotas', { scope_type: 'service', scope_id: 'live', window: 'day', max_requests: '5' }], ['/console/cache/purge', { workflow: 'ai.generate' }]]) {
        const r = await post(p, cookies.admin, { ...form, _csrf: csrf.admin });
        assert.strictEqual(r.status, 403, p);
        assert.ok(r.text.includes('This needs ai.provider.manage'), p);
    }
    assert.strictEqual(h.registry.getProvider('okseam').status, 'active');
    assert.ok(h.cache.stats().length >= 1);
    assert.strictEqual(auditRows("action = 'console.request.refused' AND actor = ?", people.admin).length, 4);
});

t.test('CSRF: a write needs the session token and a same-origin request', async () => {
    const draft = await request(h.base, 'POST', '/api/v1/workflows/ai.generate/versions', { tok: ops, body: { status: 'draft' } });
    assert.strictEqual(draft.status, 201, draft.text);
    const v = draft.body.workflow.version;
    const p = `/console/workflows/ai.generate/versions/${v}/status`;
    const refusedBefore = auditRows("action = 'console.request.refused'").length;
    for (const [form, headers, why] of [
        [{ status: 'archived' }, {}, 'no token'],
        [{ status: 'archived', _csrf: 'x'.repeat(43) }, {}, 'wrong token'],
        [{ status: 'archived', _csrf: csrf.admin }, { 'Sec-Fetch-Site': 'cross-site' }, 'cross-site'],
        [{ status: 'archived', _csrf: csrf.admin }, { Origin: 'https://evil.test' }, 'foreign origin'],
    ]) {
        const r = await post(p, cookies.admin, form, headers);
        assert.strictEqual(r.status, 403, why);
        assert.strictEqual(h.registry.getWorkflow('ai.generate', v).status, 'draft', why);
    }
    assert.strictEqual(auditRows("action = 'console.request.refused'").length, refusedBefore + 4);
    const ok = await post(p, cookies.admin, { status: 'archived', _csrf: csrf.admin }, { Origin: 'https://ai.test', 'Sec-Fetch-Site': 'same-origin' });
    assert.strictEqual(ok.status, 303, ok.text);
    assert.strictEqual(ok.headers.get('location'), `/console/workflows/ai.generate?version=${v}&done=version_status`);
    assert.strictEqual(h.registry.getWorkflow('ai.generate', v).status, 'archived');
    const row = auditRows("action = 'workflow.status' AND target_id = 'ai.generate'").pop();
    assert.strictEqual(row.actor, people.admin);
    assert.deepStrictEqual(JSON.parse(row.metadata), { version: v, from: 'draft', to: 'archived' });
    const bad = await post(p, cookies.admin, { status: 'published', _csrf: csrf.admin });
    assert.strictEqual(bad.status, 422, 'an unknown status is refused by registry.setStatus');
});

t.test('owner: providers, circuits, quotas and cache purge through the console, each audited with the person as actor', async () => {
    const r = await signIn(people.owner, { is_owner: true, username: 'owner' });
    assert.strictEqual(r.cb.status, 303);
    cookies.owner = r.cookie;
    const page = await get('/console/providers', cookies.owner);
    assertPage(page, '/console/providers (owner)');
    assert.ok(page.text.includes('action="/console/providers/okseam/status"'));
    csrf.owner = csrfOf(page);
    let x = await post('/console/providers/badstub/status', cookies.owner, { status: 'disabled', _csrf: csrf.owner });
    assert.strictEqual(x.status, 303);
    assert.strictEqual(h.registry.getProvider('badstub').status, 'disabled');
    assert.strictEqual(auditRows("action = 'provider.update' AND target_id = 'badstub' AND actor = ?", people.owner).length, 1);
    x = await post('/console/providers/badstub/reset', cookies.owner, { _csrf: csrf.owner });
    assert.strictEqual(x.status, 303);
    assert.strictEqual(auditRows("action = 'provider.circuit_reset' AND target_id = 'badstub' AND actor = ?", people.owner).length, 1);
    assert.strictEqual((await post('/console/providers/nope/reset', cookies.owner, { _csrf: csrf.owner })).status, 404);

    x = await post('/console/quotas', cookies.owner, { scope_type: 'service', scope_id: 'live', window: 'fortnight', max_requests: '5', _csrf: csrf.owner });
    assert.strictEqual(x.status, 422, 'quotas.upsert refuses an unknown window');
    assert.ok(x.text.includes('window must be minute, hour or day'));
    x = await post('/console/quotas', cookies.owner, { scope_type: 'service', scope_id: 'live', window: 'day', max_requests: '500', max_tokens: '', max_cost_usd: '2.5', _csrf: csrf.owner });
    assert.strictEqual(x.status, 303);
    const q = h.quotas.list().find((z) => z.scope_type === 'service' && z.scope_id === 'live' && z.window === 'day');
    assert.strictEqual(q.max_requests, 500);
    assert.strictEqual(q.max_tokens, null);
    assert.strictEqual(q.max_cost_usd, 2.5);
    assert.strictEqual(auditRows("action = 'quota.create' AND actor = ?", people.owner).length, 1);

    x = await post('/console/cache/purge', cookies.owner, { _csrf: csrf.owner });
    assert.strictEqual(x.status, 422, 'purging everything needs the confirmation box');
    assert.ok(h.cache.stats().length >= 1);
    x = await post('/console/cache/purge', cookies.owner, { workflow: 'ai.generate', _csrf: csrf.owner });
    assert.strictEqual(x.status, 303);
    assert.match(x.headers.get('location'), /done=cache_purged&removed=1$/);
    assert.strictEqual(h.cache.stats().length, 0);
    const purge = auditRows("action = 'cache.purge' AND actor = ?", people.owner).pop();
    assert.strictEqual(purge.target_id, 'ai.generate');
    assert.strictEqual(JSON.parse(purge.metadata).removed, 1);
});

t.test('admin API changes write the same audit rows, and the audit page shows who changed what', async () => {
    assert.strictEqual((await request(h.base, 'POST', '/api/v1/providers/badstub/enable', { tok: ops })).status, 200);
    assert.strictEqual((await request(h.base, 'POST', '/api/v1/quotas', { tok: ops, body: { scope_type: 'global', window: 'hour', max_cost_usd: 10 } })).status, 201);
    assert.strictEqual((await request(h.base, 'POST', '/api/v1/providers/badstub/reset', { tok: ops })).status, 200);
    assert.strictEqual((await request(h.base, 'DELETE', '/api/v1/cache?workflow=ai.generate', { tok: ops })).status, 200);
    for (const action of ['provider.update', 'quota.create', 'provider.circuit_reset', 'cache.purge', 'route.version', 'workflow.version']) {
        assert.ok(auditRows('action = ? AND actor = ?', action, 'svc:ops').length >= 1, `${action} by svc:ops`);
    }
    const a = await get('/console/audit', cookies.admin);
    assertPage(a, '/console/audit');
    assert.ok(a.text.includes('<code>svc:ops</code>'), 'API changes are listed');
    assert.ok(a.text.includes(`@owner <code>${people.owner}</code>`), 'console changes name the person');
    assert.ok(a.text.includes('<code>quota.create</code>') && a.text.includes('<code>provider.circuit_reset</code>') && a.text.includes('<code>workflow.status</code>'));
    assert.ok(!a.text.includes('<code>run.create</code>'), 'runs are not configuration changes');
    assert.ok(a.text.includes(`base_url=${seam.url}/complete`) && !a.text.includes('token='), 'audited base URLs lose their query string too');
    const byActor = await get(`/console/audit?actor=${people.owner}&action=provider.update`, cookies.admin);
    assert.ok(byActor.text.includes('badstub'));
    assert.ok(!byActor.text.includes('<code>svc:ops</code>'));
    const runsKind = await get('/console/audit?kind=runs', cookies.admin);
    assert.ok(runsKind.text.includes('<code>run.create</code>'));
    const consoleKind = await get('/console/audit?kind=console', cookies.admin);
    assert.ok(consoleKind.text.includes('<code>console.sign_in.refused</code>') && consoleKind.text.includes('<code>console.request.refused</code>'));
    assert.strictEqual((await get('/console/audit?before=x', cookies.admin)).status, 400);
});

t.test('failed-runs filters: status, requester, workflow, error code and time', async () => {
    let r = await get('/console/runs?status=failed', cookies.admin);
    assert.ok(r.text.includes(runIds.failLive) && r.text.includes(runIds.failNews), 'both failed runs');
    assert.ok(!r.text.includes(runIds.ok), 'not the succeeded one');
    assert.ok(r.text.includes('Failed runs in the last 24 hours, by error code') && r.text.includes(`<code>${runIds.code}</code>`));
    r = await get('/console/runs?status=failed&requester=news', cookies.admin);
    assert.ok(r.text.includes(runIds.failNews) && !r.text.includes(runIds.failLive), 'a bare service name means service:<name>');
    r = await get('/console/runs?status=failed&requester=service:live&workflow=ai.generate', cookies.admin);
    assert.ok(r.text.includes(runIds.failLive) && !r.text.includes(runIds.failNews));
    r = await get(`/console/runs?code=${runIds.code}`, cookies.admin);
    assert.ok(r.text.includes(runIds.failLive) && r.text.includes(runIds.failNews) && !r.text.includes(runIds.ok));
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
    r = await get(`/console/runs?status=failed&from=${tomorrow}`, cookies.admin);
    assert.ok(r.text.includes('no run matches') && !r.text.includes(runIds.failLive));
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    r = await get(`/console/runs?status=failed&from=${yesterday}&to=${new Date().toISOString().slice(0, 10)}`, cookies.admin);
    assert.ok(r.text.includes(runIds.failLive), 'a day range includes the whole last day');
    r = await get('/console/runs?status=bogus&requester=%3Cscript%3E', cookies.admin);
    assert.strictEqual(r.status, 400);
    assert.ok(r.text.includes('ignored malformed filter(s): status, requester'));
    assert.ok(!r.text.includes('<script>'), 'what was typed is escaped');
});

t.test('run detail: error code, attempts, provider, request log; input bounded and credential keys hidden', async () => {
    let r = await get(`/console/runs/${runIds.failLive}`, cookies.admin);
    assert.ok(r.text.includes(`<code class="bad">${runIds.code}</code>`));
    assert.ok(r.text.includes('<code>badstub</code>'), 'the request log names the provider tried');
    assert.ok(r.text.includes('Provider requests'));
    r = await get(`/console/runs/${runIds.ok}`, cookies.admin);
    assert.ok(r.text.includes('<code>okseam</code> / <code>seam-model</code>'));
    assert.ok(r.text.includes('more characters)'), 'long strings are cut');
    assert.ok(!r.text.includes('END-OF-PROMPT'), 'the whole prompt is not shown');
    const p = preview({ record: { api_key: 'zzzzzzzzzzzzzzzz', accessToken: 'x', token: 'y', title: 'kept', list: Array.from({ length: 30 }, (_, i) => i) } });
    assert.ok(p.cut);
    assert.ok(!p.text.includes('zzzzzzzzzzzzzzzz') && !p.text.includes('"x"') && !p.text.includes('"y"'), 'credential-named keys are blanked');
    assert.ok(p.text.includes('"api_key": "[not shown]"') && p.text.includes('"title": "kept"') && p.text.includes('(10 more items)'));
    assert.strictEqual(preview(null).text, null);
    assert.ok(r.text.includes('a real answer'), 'the output is shown');
    assert.ok(!/debug_(prompt|response)/.test(r.text));
    assert.ok(r.text.includes('Grounding'));
});

t.test('cancel: an admin cancels a running run (ai.workflow.manage), audited with the person as actor', async () => {
    assert.strictEqual((await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: ops, body: { primary: { provider: 'slowseam' }, fallbacks: [] } })).status, 201);
    const c = await request(h.base, 'POST', '/api/v1/runs', { tok: live, body: { workflow: 'ai.generate', input: { prompt: 'slow one' }, options: { cache: false } } });
    assert.strictEqual(c.status, 202);
    const id = c.body.run.id;
    const page = await get(`/console/runs/${id}`, cookies.admin);
    assert.ok(page.text.includes(`action="/console/runs/${id}/cancel"`));
    const x = await post(`/console/runs/${id}/cancel`, cookies.admin, { _csrf: csrf.admin });
    assert.strictEqual(x.status, 303);
    assert.strictEqual(h.runs.get(id).status, 'cancelled');
    assert.strictEqual(auditRows("action = 'run.cancel' AND target_id = ? AND actor = ?", id, people.admin).length, 1);
    const again = await post(`/console/runs/${id}/cancel`, cookies.admin, { _csrf: csrf.admin });
    assert.strictEqual(again.status, 409, 'a finished run cannot be cancelled');
    await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: ops, body: { primary: { provider: 'okseam' }, fallbacks: [] } });
});

t.test('the staff mapping is applied on every request: a session whose claims no longer map is ended', async () => {
    const r = await signIn(people.mod, { role: 'admin', username: 'demoted' });
    assert.strictEqual(r.cb.status, 303);
    assert.strictEqual((await get('/console', r.cookie)).status, 200);
    h.db.prepare("UPDATE console_sessions SET staff = ? WHERE subject = ? AND revoked_at IS NULL").run(JSON.stringify({ role: 'global_mod' }), people.mod);
    const x = await get('/console', r.cookie);
    assert.strictEqual(x.status, 403);
    assert.ok(x.cookies.some((c) => c.startsWith('__Host-ovai_staff=;')), 'the cookie is cleared');
    assert.strictEqual((await get('/console', r.cookie)).status, 401, 'and the session is gone');
});

t.test('sign out revokes the session', async () => {
    const x = await post('/auth/logout', cookies.admin, { _csrf: csrf.admin });
    assert.strictEqual(x.status, 303);
    assert.ok(x.cookies.some((c) => c.startsWith('__Host-ovai_staff=;')));
    assert.strictEqual((await get('/console', cookies.admin)).status, 401);
    assert.strictEqual(auditRows("action = 'console.sign_out' AND actor = ?", people.admin).length, 1);
    for (const s of SECRETS) assert.ok(!JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all()).includes(s), 'no secret in the audit log');
});

t.test('robots.txt keeps crawlers out of the console and sign-in; there is no sitemap', async () => {
    const r = await request(h.base, 'GET', '/robots.txt');
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('Disallow: /console') && r.text.includes('Disallow: /auth/'));
    assert.ok(!/sitemap/i.test(r.text));
    assert.strictEqual((await request(h.base, 'GET', '/sitemap.xml')).status, 404);
    assert.ok((await request(h.base, 'GET', '/')).text.includes('/console'));
});

t.test('the nginx vhost proxies /console, /auth/ and /robots.txt with the client address from $remote_addr only', () => {
    const conf = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx', 'ai.openvibe.network.conf'), 'utf8');
    const active = conf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    for (const loc of ['location /console', 'location /auth/', 'location = /robots.txt']) {
        const i = active.indexOf(`${loc} {`);
        assert.ok(i >= 0, `${loc} is proxied`);
        const block = active.slice(i, active.indexOf('}', i));
        assert.ok(block.includes('proxy_pass http://127.0.0.1:4700;'), loc);
        for (const hdr of ['X-Real-IP $remote_addr', 'X-Forwarded-For $remote_addr', 'CF-Connecting-IP $remote_addr']) assert.ok(block.includes(hdr), `${loc}: ${hdr}`);
    }
    assert.ok(!active.includes('$proxy_add_x_forwarded_for'));
});

t.test('production without AI_CONSOLE_SESSION_SECRET: the console answers 503 and the API is unaffected', async () => {
    const p = await boot({ env: { NODE_ENV: 'production', BASE_URL: 'https://ai.test', OV_NETWORK_INTERNAL_URL: NETWORK, OV_OAUTH_CLIENT_SECRET: CLIENT_SECRET, AI_USER_MODULES: 'off' }, fetchImpl: fakeFetch });
    try {
        for (const x of ['/console', '/auth/login']) {
            const r = await fetch(p.base + x, { redirect: 'manual' });
            assert.strictEqual(r.status, 503, x);
            assert.ok((await r.text()).includes('Console unavailable'));
        }
        assert.strictEqual((await fetch(`${p.base}/api/health`)).status, 200);
    } finally { await p.stop(); }
});

t.test('shutdown', async () => {
    await h.stop();
    await seam.close();
    await slow.close();
});

t.run();
