'use strict';
// AI Exchange on the operator console (AI_CREDITS / AI_ROUTING_EVIDENCE): staff only, the Credits settle
// queue counts and review rows with one audited "mark resolved" action that never retries, the measured
// routing evidence and incumbents, nothing from a settle body beyond the four usage counts, and no
// Exchange page or navigation when both flags are off.

const assert = require('assert');
const crypto = require('crypto');
const { serviceAuth, ids } = require('openvibe-contracts');
const { boot, suite, privateKey, ISSUER } = require('./helpers');

const t = suite('console-exchange');
const NETWORK = 'http://network.test';
const CLIENT_SECRET = `sentinel-client-${crypto.randomBytes(12).toString('hex')}`;
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const people = { user: ids.newId('user'), admin: ids.newId('user') };

const codes = new Map();
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
        if (body.client_id !== 'ai' || body.client_secret !== CLIENT_SECRET) return json(401, { error: 'invalid_client' });
        const c = codes.get(body.code);
        if (!c) return json(400, { error: 'invalid_grant' });
        codes.delete(body.code);
        if (c.redirect_uri !== body.redirect_uri) return json(400, { error: 'invalid_grant' });
        if (crypto.createHash('sha256').update(String(body.code_verifier || '')).digest('base64url') !== c.challenge) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: userToken(c), refresh_token: `rt_${crypto.randomBytes(6).toString('hex')}`, token_type: 'Bearer', expires_in: 3600 });
    }
    if (u === `${NETWORK}/oauth/revoke`) { revoked.push(JSON.parse(String(opts.body)).token); return json(200, { revoked: true }); }
    return globalThis.fetch(url, opts);
}

const baseEnv = {
    BASE_URL: 'https://ai.test', OV_NETWORK_INTERNAL_URL: NETWORK, OV_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    AI_CONSOLE_SESSION_SECRET: SESSION_SECRET, AI_USER_MODULES: 'off', AI_STUB_FALLBACK: 'false',
};
let h;
let adminCookie = null;
const setCookies = (res) => (res.headers.getSetCookie ? res.headers.getSetCookie() : []);
async function get(p, cookie) {
    const res = await fetch(h.base + p, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
    return { status: res.status, headers: res.headers, text: await res.text(), cookies: setCookies(res) };
}
async function post(p, cookie, form) {
    const res = await fetch(h.base + p, {
        method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
        body: new URLSearchParams(form).toString(),
    });
    return { status: res.status, headers: res.headers, text: await res.text(), cookies: setCookies(res) };
}
async function signIn(subject, { role = 'admin', is_owner = false, username = 'staffer', staff_caps, next = '/console/exchange' } = {}) {
    const login = await get(`/auth/login?next=${encodeURIComponent(next)}`);
    assert.strictEqual(login.status, 302);
    const loc = new URL(login.headers.get('location'));
    const flow = login.cookies.find((c) => c.startsWith('ovai_flow='));
    const code = authorize({ subject_id: subject, role, is_owner, username, staff_caps, challenge: loc.searchParams.get('code_challenge'), redirect_uri: loc.searchParams.get('redirect_uri') });
    const cb = await get(`/auth/callback?code=${code}&state=${encodeURIComponent(loc.searchParams.get('state'))}`, flow.split(';')[0]);
    const sess = cb.cookies.find((c) => c.startsWith('__Host-ovai_staff=') && !c.startsWith('__Host-ovai_staff=;'));
    return { cb, cookie: sess ? sess.split(';')[0] : null };
}
const csrfOf = (page) => (page.text.match(/name="_csrf" value="([^"]+)"/) || [])[1];
const sessionCount = async () => (await h.db.prepare('SELECT COUNT(*) AS n FROM console_sessions').get()).n;
function assertPage(r, p) {
    assert.strictEqual(r.status, 200, `${p}: ${r.status} ${r.text.slice(0, 300)}`);
    assert.match(r.headers.get('content-type'), /text\/html/, p);
    assert.ok(!/<script/i.test(r.text), `${p}: no script`);
    const csp = r.headers.get('content-security-policy') || '';
    assert.ok(csp.includes("default-src 'none'") && csp.includes("form-action 'self'") && !csp.includes('unsafe-inline'), `${p}: CSP`);
    assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow', p);
    assert.match(r.headers.get('cache-control') || '', /no-store/, p);
    assert.strictEqual((r.text.match(/<h1[ >]/g) || []).length, 1, `${p}: one h1`);
    assert.strictEqual((r.text.match(/<table/g) || []).length, (r.text.match(/<caption>/g) || []).length, `${p}: every table has a caption`);
    assert.ok(!r.text.includes(CLIENT_SECRET) && !r.text.includes(SESSION_SECRET), `${p}: no secret`);
}

const REVIEW_A = 'ai-settle:req_REVIEWA';
const REVIEW_B = 'ai-settle:req_REVIEWB';
const REVIEW_BODY_A = JSON.stringify({
    idempotency_key: REVIEW_A,
    subject: 'SUBJECT-MARKER-usr_01JABCDEFGHJKMNPQRSTVWXYZ00',
    usage: { input_tokens: 111, cached_read_tokens: 222, cache_write_tokens: 333, output_tokens: 444 },
    retail: { version: 'RETAIL-MARKER-9f3a', nano_usd_per_m: { input: 'SUPPLY-MARKER-111', cached_read: 'SUPPLY-MARKER-222', cache_write: 'SUPPLY-MARKER-333', output: 'SUPPLY-MARKER-444' }, per_request_nano_usd: 'SUPPLY-MARKER-555' },
    supply_cost_nano_usd: 'SUPPLY-MARKER-666',
    byok: false,
    attempts: [{ deployment_id: 'DEPLOY-MARKER-xyz', started_at: '2026-11-05T10:00:00.000Z', ended_at: '2026-11-05T10:00:01.000Z', error_code: null }],
});
const REVIEW_BODY_B = JSON.stringify({
    idempotency_key: REVIEW_B,
    usage: { input_tokens: 5, cached_read_tokens: 6, cache_write_tokens: 7, output_tokens: 8 },
    retail: { version: 'SECOND-MARKER', nano_usd_per_m: { input: '0', cached_read: '0', cache_write: '0', output: '0' }, per_request_nano_usd: '0' },
    supply_cost_nano_usd: '0', byok: false, attempts: [],
});

async function seedQueue({ id, hold, request, body, status, tries, createdAt, lastError = null }) {
    const at = new Date(createdAt).toISOString();
    await h.db.prepare(`INSERT INTO credit_settle_queue
        (id, hold_id, request_id, settle_body, attempts, status, tries, next_at, last_error, created_at, updated_at)
        VALUES (?, ?, ?, ?::jsonb, '[]'::jsonb, ?, ?, ?::timestamptz, ?, ?::timestamptz, ?::timestamptz)`).run(
        id, hold, request, body, status, tries, at, lastError, at, at);
}

t.test('boot with both flags on and seed queue, metrics and incumbent rows', async () => {
    h = await boot({ env: { ...baseEnv, AI_CREDITS: 'true', AI_ROUTING_EVIDENCE: 'true' }, fetchImpl: fakeFetch });
    const now = Date.now();
    await seedQueue({ id: 'ai-settle:req_QUEUED', hold: 'hold_queued', request: 'req_QUEUED', body: REVIEW_BODY_B, status: 'queued', tries: 4, createdAt: now - 300000, lastError: 'billing unavailable' });
    await seedQueue({ id: 'ai-settle:req_SENT', hold: 'hold_sent', request: 'req_SENT', body: REVIEW_BODY_B, status: 'sent', tries: 0, createdAt: now - 200000 });
    await seedQueue({ id: REVIEW_A, hold: 'hold_review_a', request: 'req_REVIEWA', body: REVIEW_BODY_A, status: 'review', tries: 2, createdAt: now - 150000, lastError: 'billing.invalid_request: output_tokens' });
    await seedQueue({ id: REVIEW_B, hold: 'hold_review_b', request: 'req_REVIEWB', body: REVIEW_BODY_B, status: 'review', tries: 1, createdAt: now - 100000 });
    await h.db.prepare(`INSERT INTO provider_metrics
        (provider_key, model_key, ttft_ms, ttft_samples, decode_tps, decode_samples, success_rate, timeout_rate, cache_hit_ratio, cache_samples, sample_count, updated_at)
        VALUES ('alpha', 'model-a', 420, 30, 55.5, 25, 0.97, 0.01, 0.42, 22, 40, ?::timestamptz)`).run(new Date(now).toISOString());
    await h.db.prepare(`INSERT INTO provider_metrics
        (provider_key, model_key, ttft_ms, ttft_samples, decode_tps, decode_samples, success_rate, timeout_rate, cache_hit_ratio, cache_samples, sample_count, updated_at)
        VALUES ('beta', 'model-b', NULL, 0, NULL, 0, 0.5, 0.25, 0, 0, 2, ?::timestamptz)`).run(new Date(now).toISOString());
    await h.db.prepare(`INSERT INTO routing_incumbents
        (decision_key, provider_key, model_key, challenger_provider, challenger_model, challenger_streak, updated_at)
        VALUES ('openvibe/auto|chat|balanced', 'alpha', 'model-a', 'beta', 'model-b', 2, ?::timestamptz)`).run(new Date(now).toISOString());
});

t.test('anonymous get the sign-in page (401), never data', async () => {
    const r = await get('/console/exchange');
    assert.strictEqual(r.status, 401);
    assert.ok(r.text.includes('Sign in with OpenVibe.Network'));
    assert.ok(!r.text.includes('<table'));
});

t.test('non-staff are refused at sign-in (403) and get no session; the refusal is audited', async () => {
    const r = await signIn(people.user, { role: 'user' });
    assert.strictEqual(r.cb.status, 403);
    assert.strictEqual(r.cookie, null);
    assert.ok(r.cb.text.includes('only for OpenVibe.Network staff'));
    assert.strictEqual(await sessionCount(), 0);
    assert.strictEqual((await h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'console.sign_in.refused' AND actor = ?").get(people.user)).n, 1);
    assert.ok(revoked.length >= 1, 'the Network refresh token is revoked');
});

t.test('an admin sees both sections from the seeded rows; no settle body text beyond the four counts', async () => {
    const s = await signIn(people.admin, { username: 'ops' });
    assert.strictEqual(s.cb.status, 303);
    assert.strictEqual(s.cb.headers.get('location'), '/console/exchange');
    assert.ok(s.cookie);
    adminCookie = s.cookie;
    const page = await get('/console/exchange', s.cookie);
    assertPage(page, '/console/exchange');
    const text = page.text;
    assert.ok(text.includes('<a href="/console/exchange" aria-current="page">Exchange</a>'), 'the nav entry is current');
    assert.ok(text.includes('Credits settle queue') && text.includes('Routing evidence'), 'both sections');
    assert.match(text, /<div class="k">Queued<\/div><div class="v">1<\/div>/);
    assert.match(text, /<div class="k">Sent<\/div><div class="v">1<\/div>/);
    assert.match(text, /<div class="k">Review<\/div><div class="v">2<\/div>/);
    assert.match(text, /<div class="k">Oldest queued<\/div><div class="v">[4-6] min<\/div>/);
    assert.ok(text.includes('hold_review_a') && text.includes('hold_review_b'));
    assert.ok(text.includes('req_REVIEWA') && text.includes('billing.invalid_request: output_tokens'));
    const wraps = (text.match(/class="tablewrap"/g) || []).length;
    assert.ok(wraps >= 3, `every table is inside a scroll wrapper (${wraps})`);
    // The four settle usage counts (summed over the review rows) are the only settle-body data shown.
    assert.match(text, /tokens in 116 · cached read 228 · cache write 340 · out 452/);
    for (const marker of ['SUBJECT-MARKER-usr_01JABCDEFGHJKMNPQRSTVWXYZ00', 'RETAIL-MARKER-9f3a', 'SUPPLY-MARKER-111', 'SUPPLY-MARKER-666', 'DEPLOY-MARKER-xyz', 'SECOND-MARKER', '"byok"', 'supply_cost_nano_usd', 'nano_usd_per_m']) {
        assert.ok(!text.includes(marker), `settle body field leaked: ${marker}`);
    }
    assert.ok(text.includes('alpha:model-a') && text.includes('beta:model-b'));
    assert.ok(text.includes('97.0 %') && text.includes('1.0 %') && text.includes('420 ms') && text.includes('55.5') && text.includes('42.0 %'));
    assert.ok(text.includes('openvibe/auto|chat|balanced') && text.includes('n=30') && text.includes('n=25') && text.includes('n=22'));
});

t.test('"mark resolved" changes only that row, never retries it, and writes the console audit row', async () => {
    const page = await get('/console/exchange', adminCookie);
    const csrf = csrfOf(page);
    assert.ok(csrf, 'the page carries the CSRF token');
    const before = await h.db.prepare('SELECT * FROM credit_settle_queue WHERE id = ?').get(REVIEW_A);
    const other = await h.db.prepare('SELECT * FROM credit_settle_queue WHERE id = ?').get(REVIEW_B);
    const url = `/console/exchange/credits/${encodeURIComponent(REVIEW_A)}/resolve`;
    const r = await post(url, adminCookie, { _csrf: csrf });
    assert.strictEqual(r.status, 303, r.text.slice(0, 300));
    assert.strictEqual(r.headers.get('location'), '/console/exchange?done=settle_resolved');
    const after = await h.db.prepare('SELECT * FROM credit_settle_queue WHERE id = ?').get(REVIEW_A);
    assert.strictEqual(after.status, 'resolved');
    assert.strictEqual(after.tries, before.tries, 'no retry');
    assert.strictEqual(after.next_at, before.next_at, 'the retry schedule is untouched');
    assert.strictEqual(after.resolved_by, people.admin);
    assert.ok(after.resolved_at);
    const otherAfter = await h.db.prepare('SELECT * FROM credit_settle_queue WHERE id = ?').get(REVIEW_B);
    assert.strictEqual(otherAfter.status, other.status, 'the other review row is unchanged');
    assert.strictEqual(otherAfter.tries, other.tries);
    const auditPage = await get('/console/audit?kind=exchange', adminCookie);
    assert.ok(auditPage.text.includes('credit_settle.resolve') && auditPage.text.includes('AI Exchange'), 'the audit page lists it under AI Exchange');
    const audited = await h.db.prepare("SELECT * FROM audit_log WHERE action = 'credit_settle.resolve' ORDER BY id").all();
    assert.strictEqual(audited.length, 1);
    assert.strictEqual(audited[0].actor, people.admin);
    assert.strictEqual(audited[0].target_type, 'credit_settle');
    assert.strictEqual(audited[0].target_id, REVIEW_A);
    assert.strictEqual(JSON.parse(audited[0].metadata).hold_id, 'hold_review_a');
    // A resolved row is no longer offered, and a second attempt is a 409 that changes and audits nothing.
    const shown = await get('/console/exchange', adminCookie);
    assert.match(shown.text, /<div class="k">Review<\/div><div class="v">1<\/div>/);
    assert.ok(!shown.text.includes('hold_review_a'));
    const again = await post(url, adminCookie, { _csrf: csrf });
    assert.strictEqual(again.status, 409, again.text.slice(0, 300));
    assert.strictEqual((await h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'credit_settle.resolve'").get()).n, 1);
    // A missing CSRF token is refused and does not resolve the other row.
    const denied = await post(`/console/exchange/credits/${encodeURIComponent(REVIEW_B)}/resolve`, adminCookie, {});
    assert.strictEqual(denied.status, 403);
    assert.strictEqual((await h.db.prepare('SELECT status FROM credit_settle_queue WHERE id = ?').get(REVIEW_B)).status, 'review');
});

t.test('a staff session without ai.workflow.manage reads the page but cannot mark a row resolved', async () => {
    const s = await signIn(people.admin, { username: 'reader', staff_caps: ['staff.site.view'] });
    assert.strictEqual(s.cb.status, 303);
    const page = await get('/console/exchange', s.cookie);
    assertPage(page, '/console/exchange (reader)');
    assert.ok(page.text.includes('Credits settle queue'));
    assert.ok(!page.text.includes('Mark resolved'), 'no action without ai.workflow.manage');
    assert.ok(page.text.toLowerCase().includes('never retries the settle'));
    const denied = await post(`/console/exchange/credits/${encodeURIComponent(REVIEW_B)}/resolve`, s.cookie, { _csrf: csrfOf(page) });
    assert.strictEqual(denied.status, 403);
    assert.ok(denied.text.includes('This needs ai.workflow.manage'));
    assert.strictEqual((await h.db.prepare('SELECT status FROM credit_settle_queue WHERE id = ?').get(REVIEW_B)).status, 'review');
});

t.test('with both flags off the Exchange page and its sections are absent', async () => {
    await h.stop();
    h = await boot({ env: { ...baseEnv, AI_CREDITS: 'false', AI_ROUTING_EVIDENCE: 'false' }, fetchImpl: fakeFetch });
    const s = await signIn(people.admin, { username: 'ops' });
    assert.strictEqual(s.cb.status, 303);
    const overview = await get('/console', s.cookie);
    assertPage(overview, '/console');
    assert.ok(!overview.text.includes('href="/console/exchange"'), 'no Exchange navigation');
    const page = await get('/console/exchange', s.cookie);
    assert.strictEqual(page.status, 404);
    assert.ok(!page.text.includes('Credits settle queue') && !page.text.includes('Routing evidence'));
});

t.run();
