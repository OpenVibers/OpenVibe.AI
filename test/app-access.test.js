'use strict';
// T6 step 10: developer-app access (ADR-014; capability ai.app.run, docs/capabilities-proposal/).
// An app token (sub app:app_<ULID>, project_id prj_<ULID>, env, audience openvibe.ai, ns as Network
// issues it) holding ai.app.run may use the six direct operations and GET /api/v1/runs/:id; every
// other route refuses it (403). Its runs are its PROJECT's: requester and attribution are the
// project, the free allowance is per project, the govern tier map is keyed by the project, every
// Billing reading carries the project, a sandbox or ungoverned run sees free/local capacity only, and a person's
// BYO key is never selected.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');
const usageSamples = require('../server/usage-samples');
const apps = require('../server/apps');

const t = suite('app-access');
const ULID_A = '01JAB2C3D4E5F6G7H8J9K0MNPQ';
const ULID_B = '01JAB2C3D4E5F6G7H8J9K0MNPR';
const PRJ_A = `prj_${ULID_A}`;
const PRJ_B = `prj_${ULID_B}`;
const KEY_A = apps.projectKey(PRJ_A);
const service = token('live', ALL);

/** A Network-shaped app token: sub app:app_<ULID>, actor_type app, project_id, env, ns (Network's own shape). */
function appToken(projectId, cap = ['ai.app.run'], { env = 'production' } = {}) {
    return token('app', cap, { sub: `app:app_${projectId.slice(4)}`, actorType: 'app', ns: [projectId, `app.${projectId}.*`], extra: { project_id: projectId, env } });
}
const appA = appToken(PRJ_A);
const appB = appToken(PRJ_B);
const sandboxA = appToken(PRJ_A, ['ai.app.run'], { env: 'sandbox' });

const CAPS = ['chat', 'generate', 'summarize', 'classify', 'extract', 'embed'];
/** The three provers one pinned default.chat route holds: a byok pool (first), a paid meter, a free server. */
async function seedProviders(h, seam) {
    const mk = (body) => request(h.base, 'POST', '/api/v1/providers', { tok: service, body: { kind: 'http', base_url: seam.url, auth_mode: 'none', capabilities: CAPS, ...body } });
    assert.strictEqual((await mk({ key: 'byokpool', auth_mode: 'bearer', secret_ref: 'env:BYOK_TEST_KEY', billing_profile: 'byok', default_model: 'byok-m' })).status, 201);
    assert.strictEqual((await mk({ key: 'paid', default_model: 'paid-m' })).status, 201);
    assert.strictEqual((await mk({ key: 'freecap', billing_profile: 'free', default_model: 'freecap-m' })).status, 201);
    // The paid model's 100-token-a-day free allowance, so a project's free use is observable.
    assert.strictEqual((await request(h.base, 'POST', '/api/v1/models', { tok: service, body: {
        provider_key: 'paid', model_key: 'paid-m', type: 'chat', cost: { in_per_mtok: 1000, out_per_mtok: 1000, free_allowance: 100, reset_period: 'day' } } })).status, 201);
    assert.strictEqual((await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: service, body: {
        primary: { provider: 'byokpool', model: 'byok-m' }, fallbacks: [{ provider: 'paid', model: 'paid-m' }, { provider: 'freecap', model: 'freecap-m' }] } })).status, 201);
}

let h; let seam;
t.test('boot with the seam providers', async () => {
    seam = await seamServer(() => ({ text: 'ok', usage: { input: 1000, output: 1000 } }));
    // The tier budgets govern these projects (an open free tier), so a production app run may reach the paid meter.
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', BYOK_TEST_KEY: 'sk-test-byok-value', AI_GOVERN_TIERS: '1',
        AI_GOVERN_POLICY_JSON: JSON.stringify({ 'ai-token': { free: {} }, 'ai-usd': { free: {} } }) } });
    await seedProviders(h, seam);
});

let chatRun; let genRun;
t.test('an app token with ai.app.run chats, generates and reads its own run', async () => {
    const chat = await request(h.base, 'POST', '/api/v1/chat', { tok: appA, body: { messages: [{ role: 'user', content: 'hello' }] } });
    assert.strictEqual(chat.status, 201, chat.text);
    chatRun = chat.body.run;
    assert.strictEqual(chatRun.provenance.provider, 'paid', 'the byok pool is never an app run\'s provider');
    assert.ok(chatRun.explain && Array.isArray(chatRun.explain.candidates), 'explain stays on every run response');

    const gen = await request(h.base, 'POST', '/api/v1/generate', { tok: appA, body: { prompt: 'hello there', options: { cache: false } } });
    assert.strictEqual(gen.status, 201, gen.text);
    genRun = gen.body.run;
    assert.strictEqual(genRun.provenance.provider, 'paid');

    const got = await request(h.base, 'GET', `/api/v1/runs/${genRun.id}`, { tok: appA });
    assert.strictEqual(got.status, 200, got.text);
    assert.strictEqual(got.body.run.id, genRun.id);
    assert.deepStrictEqual([got.body.run.requester.type, got.body.run.requester.id], ['project', PRJ_A], 'the run is the project\'s');
    assert.deepStrictEqual(got.body.run.attribution, { service: 'network', type: 'project', id: PRJ_A }, 'attributed to the project');
});

t.test('another project never reads an app run (404)', async () => {
    assert.strictEqual((await request(h.base, 'GET', `/api/v1/runs/${genRun.id}`, { tok: appB })).status, 404);
});

t.test('an app token without ai.app.run is refused on the app routes', async () => {
    const noCap = appToken(PRJ_A, ['ai.run.read']);
    const post = await request(h.base, 'POST', '/api/v1/generate', { tok: noCap, body: { prompt: 'x' } });
    assert.deepStrictEqual([post.status, post.body.code], [403, 'capability.denied']);
    const get = await request(h.base, 'GET', `/api/v1/runs/${genRun.id}`, { tok: noCap });
    assert.deepStrictEqual([get.status, get.body.code], [403, 'capability.denied']);
});

t.test('every other route is first-party only: an app token gets 403', async () => {
    const routes = [
        ['POST', '/api/v1/runs', { workflow: 'ai.generate', input: { prompt: 'x' } }],
        ['GET', '/api/v1/runs', undefined],
        ['GET', `/api/v1/runs/${genRun.id}/citations`, undefined],
        ['POST', `/api/v1/runs/${genRun.id}/cancel`, undefined],
        ['POST', '/api/v1/enrich', { record: {}, instructions: 'x' }],
        ['GET', '/api/v1/providers', undefined],
    ];
    for (const [method, path, body] of routes) {
        const r = await request(h.base, method, path, { tok: appA, body });
        assert.strictEqual(r.status, 403, `${method} ${path}: ${r.text}`);
        assert.strictEqual(r.body.code, 'capability.denied', `${method} ${path}`);
    }
    // A sandbox app token is accepted on the app routes only: the door refuses it here, as before.
    const sb = await request(h.base, 'POST', '/api/v1/runs', { tok: sandboxA, body: { workflow: 'ai.generate', input: { prompt: 'x' } } });
    assert.deepStrictEqual([sb.status, sb.body.code], [401, 'token.sandbox_refused']);
});

t.test('an app may only run its own app.<project_key>.* namespace', async () => {
    const principal = { projectKey: KEY_A };
    assert.strictEqual(KEY_A, `p${ULID_A.toLowerCase()}`, 'project_key follows Events\' p+lowercase-ULID rule');
    assert.ok(apps.appMayRun(principal, `app.${KEY_A}.draft`), 'its own namespace');
    assert.ok(apps.appMayRun(principal, `app.${KEY_A}`), 'the namespace itself');
    assert.ok(apps.appMayRun(principal, 'ai.chat'), 'the direct operations ai.app.run grants by route');
    assert.ok(!apps.appMayRun(principal, 'live.translate'));
    assert.ok(!apps.appMayRun(principal, 'network.site_copy'));
    assert.ok(!apps.appMayRun(principal, `app.${apps.projectKey(PRJ_B)}.draft`), "another project's namespace");
    // The route that would take an arbitrary workflow (POST /api/v1/runs) is first-party only.
    const r = await request(h.base, 'POST', '/api/v1/runs', { tok: appA, body: { workflow: 'live.translate', input: { text: 'bonjour', from: 'fr', to: 'en' } } });
    assert.strictEqual(r.status, 403);
});

t.test("a person's BYO key is never selected for an app run", async () => {
    // The byok pool record resolves and is the pinned route's primary: a service run uses it.
    const svc = await request(h.base, 'POST', '/api/v1/generate', { tok: service, body: { prompt: 'service work', options: { cache: false } } });
    assert.strictEqual(svc.status, 201, svc.text);
    assert.strictEqual(svc.body.run.provenance.provider, 'byokpool', 'a service run may use the pooled key');
    // An app may not send one, and never lands on the byok pool.
    const denied = await request(h.base, 'POST', '/api/v1/generate', { tok: appA, body: { prompt: 'x', credential: { subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' } } });
    assert.deepStrictEqual([denied.status, denied.body.code], [403, 'capability.denied']);
    for (const run of [chatRun.id, genRun.id]) {
        const providers = (await h.db.prepare('SELECT DISTINCT provider_key FROM requests WHERE run_id = ?').all(run)).map((r) => r.provider_key);
        assert.deepStrictEqual(providers, ['paid'], `${run}: only the paid provider, never byokpool`);
    }
});

let sandboxRun;
t.test('a sandbox app run uses free and local capacity only', async () => {
    const r = await request(h.base, 'POST', '/api/v1/generate', { tok: sandboxA, body: { prompt: 'sandbox work', options: { cache: false } } });
    assert.strictEqual(r.status, 201, r.text);
    sandboxRun = r.body.run;
    assert.strictEqual(sandboxRun.provenance.provider, 'freecap', 'the paid provider and the byok pool were never candidates');
    const providers = (await h.db.prepare('SELECT DISTINCT provider_key FROM requests WHERE run_id = ?').all(sandboxRun.id)).map((x) => x.provider_key);
    assert.deepStrictEqual(providers, ['freecap']);
    const why = Object.fromEntries(sandboxRun.explain.candidates.map((c) => [c.provider, c.excluded_reason]));
    assert.strictEqual(why.paid, 'free_only');
    assert.strictEqual(why.byokpool, 'byok');
});

const readings = async (runId) => (await h.db.prepare('SELECT envelope FROM usage_sample_outbox ORDER BY id').all())
    .map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope))
    .filter((s) => s.idempotency_key.startsWith(`ai:${runId}:`));
const freeRows = async (projectId) => (await h.db.prepare('SELECT metric, free_used FROM free_allowance_usage WHERE subject = ? ORDER BY metric').all(`network:project:${projectId}`))
    .map((r) => [r.metric, Number(r.free_used)]);

t.test('every reading carries the project; the free allowance is per project', async () => {
    for (const runId of [chatRun.id, genRun.id, sandboxRun.id]) {
        const samples = await readings(runId);
        assert.ok(samples.length >= 3, `${runId}: in, cached and out readings`);
        for (const s of samples) {
            assert.ok(contracts.validate('platform.usage-sample@1', s).valid, JSON.stringify(s));
            assert.strictEqual(s.project, PRJ_A, `${s.idempotency_key}: the project`);
            assert.strictEqual(s.subject, `project:${PRJ_A}`, `${s.idempotency_key}: billed as the project`);
        }
    }
    // Project A's first paid run claimed the paid model's 100-token free allowance, per kind; nothing after it did.
    assert.deepStrictEqual(await freeRows(PRJ_A), [['input-tokens:paid-m', 100], ['output-tokens:paid-m', 100]]);
    // Project B has its own allowance: its first run claims 100 again.
    const b = await request(h.base, 'POST', '/api/v1/generate', { tok: appB, body: { prompt: 'project b work', options: { cache: false } } });
    assert.strictEqual(b.status, 201, b.text);
    assert.deepStrictEqual(await freeRows(PRJ_B), [['input-tokens:paid-m', 100], ['output-tokens:paid-m', 100]]);
    assert.deepStrictEqual(await freeRows(PRJ_A), [['input-tokens:paid-m', 100], ['output-tokens:paid-m', 100]], 'never shared');
});

// The govern tier budgets are looked up per PROJECT (server/govern.js project = requester): mapping
// project:<prj_…> to staff admits only that project's app runs; the free tier's 0 budget refuses the rest.
let h2; let seam2;
t.test('the govern tier map is keyed by the app\'s project', async () => {
    seam2 = await seamServer(() => ({ text: 'ok', usage: { input: 10, output: 10 } }));
    h2 = await boot({ env: {
        AI_STUB_FALLBACK: 'false', AI_GOVERN_TIERS: '1', AI_GOVERN_HOLD_TOKENS: '1',
        AI_GOVERN_POLICY_JSON: JSON.stringify({ 'ai-token': { free: { day: 0 }, staff: {} }, 'ai-usd': { free: { day: 0.5 }, staff: {} } }),
        AI_GOVERN_TIER_MAP: `project:${PRJ_A}=staff`,
    } });
    await seedProviders(h2, seam2);
    const a = await request(h2.base, 'POST', '/api/v1/generate', { tok: appA, body: { prompt: 'staff project', options: { cache: false } } });
    assert.strictEqual(a.status, 201, `project A is on staff: ${a.text}`);
    const b = await request(h2.base, 'POST', '/api/v1/generate', { tok: appB, body: { prompt: 'free project', options: { cache: false } } });
    assert.deepStrictEqual([b.status, b.body.code], [429, 'govern.exceeded'], 'project B is on the free tier with a 0 budget');
});

// Without tier budgets (AI_GOVERN_TIERS off) nothing bounds a project's metered spend, so every app run,
// production too, is limited to free and local capacity; a first-party run keeps the whole pool.
let h3; let seam3;
t.test('an ungoverned app run uses free and local capacity only', async () => {
    seam3 = await seamServer(() => ({ text: 'ok', usage: { input: 10, output: 10 } }));
    h3 = await boot({ env: { AI_STUB_FALLBACK: 'false', BYOK_TEST_KEY: 'sk-test-byok-value' } });
    await seedProviders(h3, seam3);
    const r = await request(h3.base, 'POST', '/api/v1/generate', { tok: appA, body: { prompt: 'ungoverned', options: { cache: false } } });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.run.provenance.provider, 'freecap');
    const why = Object.fromEntries(r.body.run.explain.candidates.map((c) => [c.provider, c.excluded_reason]));
    assert.deepStrictEqual([why.byokpool, why.paid], ['byok', 'free_only']);
    const svc = await request(h3.base, 'POST', '/api/v1/generate', { tok: service, body: { prompt: 'service work', options: { cache: false } } });
    assert.strictEqual(svc.body.run.provenance.provider, 'byokpool', 'a first-party run is unaffected');
});

t.test('shutdown', async () => {
    usageSamples._reset(); await h.stop(); await seam.close();
    await h2.stop(); await seam2.close();
    await h3.stop(); await seam3.close();
});

t.run();
