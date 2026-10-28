'use strict';
// A first-party generate run may pin one offer from GET /api/v1/routes (?operation=generate): the
// run tries that provider/model alone and records it, a model the routing does not offer is 422, an
// app token may not pin, a caller's namespace still fails closed, and quotas apply exactly as before.
const assert = require('assert');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');

const t = suite('pin-route');
const admin = token('live', ALL);
// Design's shape: a first-party service with ai.run.create and the ai.* namespace.
const design = token('design', ['ai.run.create', 'ai.run.read'], { ns: ['ai.*'] });
const ULID = '01JAB2C3D4E5F6G7H8J9K0MNPQ';
const app = token('app', ['ai.app.run'], {
    sub: `app:app_${ULID}`, actorType: 'app', ns: [`prj_${ULID}`, `app.p${ULID.toLowerCase()}.*`],
    extra: { project_id: `prj_${ULID}`, env: 'production' },
});

let h; let a; let b;
const calls = { a: 0, b: 0 };
const seam = (label) => seamServer(() => {
    calls[label]++;
    return { text: `<h1>${label}</h1>`, model: `${label}-model`, usage: { input: 3, output: 4 } };
});

async function provider(key, url, model) {
    const r = await request(h.base, 'POST', '/api/v1/providers', { tok: admin, body: {
        key, kind: 'http', base_url: url, auth_mode: 'none', default_model: model,
        capabilities: ['chat', 'generate', 'json'],
    } });
    assert.strictEqual(r.status, 201, r.text);
}
const offersOn = (routes, key) => (routes.find((r) => r.key === key) || {}).offers || [];

t.test('boot with two offered generate providers and no stub fallback', async () => {
    a = await seam('a');
    b = await seam('b');
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0' } });
    await provider('seam-a', a.url, 'a-model');
    await provider('seam-b', b.url, 'b-model');
});

t.test('GET /api/v1/routes?operation=generate lists the offers a pin may name', async () => {
    const r = await request(h.base, 'GET', '/api/v1/routes?operation=generate', { tok: design });
    assert.strictEqual(r.status, 200, r.text);
    const route = r.body.routes.find((x) => x.key === 'default.chat');
    assert.ok(route, 'default.chat is listed');
    const ids = offersOn(r.body.routes, 'default.chat').map((o) => `${o.provider}:${o.model}`).sort();
    assert.deepStrictEqual(ids, ['seam-a:a-model', 'seam-b:b-model']);
    assert.deepStrictEqual((r.body.offers || []).map((o) => `${o.provider}:${o.model}`).sort(), ids, "the generate menu is the default route offers");
    assert.ok(route.offers.every((o) => typeof o.provider === 'string' && 'model' in o), 'an offer is { provider, model }');
    const one = await request(h.base, 'GET', '/api/v1/routes/default.chat?operation=generate', { tok: design });
    assert.strictEqual(one.status, 200, one.text);
    assert.deepStrictEqual(one.body.route.offers.map((o) => `${o.provider}:${o.model}`).sort(), ids);
});

t.test('a pinned generate run uses that offer alone and records it', async () => {
    const before = { a: calls.a, b: calls.b };
    const r = await request(h.base, 'POST', '/api/v1/generate?wait=5000', { tok: design, body: {
        prompt: 'pin this one', route: { provider: 'seam-a', model: 'a-model' }, options: { cache: false },
    } });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.run.provenance.provider, 'seam-a');
    assert.strictEqual(r.body.run.provenance.model, 'a-model');
    assert.strictEqual(r.body.run.provenance.fallback_used, false);
    assert.match(r.body.run.explain.reasons.join(' '), /pinned to seam-a\/a-model/);
    assert.strictEqual(calls.a, before.a + 1);
    assert.strictEqual(calls.b, before.b, 'the other offer was not tried');
    const req = (await request(h.base, 'GET', `/api/v1/runs/${r.body.run.id}`, { tok: design })).body.requests;
    assert.deepStrictEqual(req.filter((x) => x.status !== 'skipped').map((x) => `${x.provider_key}:${x.model_key}`), ['seam-a:a-model']);
});

t.test('the same pin works on POST /api/v1/runs for ai.generate', async () => {
    const r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: design, body: {
        workflow: 'ai.generate', input: { prompt: 'by workflow' }, route: { provider: 'seam-b', model: 'b-model' }, options: { cache: false },
    } });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.run.provenance.provider, 'seam-b');
    assert.strictEqual(r.body.run.provenance.model, 'b-model');
});

t.test('an offer the routing does not list is 422 with words, and no provider is called', async () => {
    const before = calls.a + calls.b;
    for (const route of [
        { provider: 'seam-a', model: 'not-a-model' },
        { provider: 'nope', model: 'a-model' },
    ]) {
        const r = await request(h.base, 'POST', '/api/v1/generate', { tok: design, body: { prompt: 'x', route } });
        assert.strictEqual(r.status, 422, r.text);
        assert.strictEqual(r.body.code, 'input.invalid');
        assert.match(r.body.detail, /not offered/i);
    }
    const withCredential = await request(h.base, 'POST', '/api/v1/runs', { tok: design, body: {
        workflow: 'ai.generate', input: { prompt: 'x' }, route: { provider: 'seam-a', model: 'a-model' },
        credential: { subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' },
    } });
    assert.strictEqual(withCredential.status, 422);
    assert.match(withCredential.body.detail, /credential/i);
    assert.strictEqual(calls.a + calls.b, before, 'nothing was dispatched');
});

t.test('route pinning is only for the generate operation', async () => {
    const r = await request(h.base, 'POST', '/api/v1/chat', { tok: design, body: {
        messages: [{ role: 'user', content: 'hi' }], route: { provider: 'seam-a', model: 'a-model' },
    } });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.code, 'input.invalid');
    assert.match(r.body.detail, /generate operation/i);
});

t.test('an app token cannot pin a route', async () => {
    const r = await request(h.base, 'POST', '/api/v1/generate', { tok: app, body: {
        prompt: 'x', route: { provider: 'seam-a', model: 'a-model' },
    } });
    assert.strictEqual(r.status, 403, r.text);
    assert.strictEqual(r.body.code, 'capability.denied');
    assert.match(r.body.detail, /app may not pin/i);
});

t.test("a caller's namespace fails closed before any pin is considered", async () => {
    const liveOnly = token('live', ['ai.run.create'], { ns: ['live.*'] });
    const r = await request(h.base, 'POST', '/api/v1/generate', { tok: liveOnly, body: {
        prompt: 'x', route: { provider: 'seam-a', model: 'a-model' },
    } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'capability.namespace_denied');
});

t.test('an idempotency replay keeps its pin; a different pin under the same key conflicts', async () => {
    const body = { prompt: 'idem pin', route: { provider: 'seam-a', model: 'a-model' }, idempotency_key: 'pin-idem-0001', options: { cache: false } };
    const first = await request(h.base, 'POST', '/api/v1/generate?wait=5000', { tok: design, body });
    assert.strictEqual(first.status, 201, first.text);
    const replay = await request(h.base, 'POST', '/api/v1/generate?wait=5000', { tok: design, body });
    assert.strictEqual(replay.status, 200, replay.text);
    assert.strictEqual(replay.body.run.id, first.body.run.id);
    assert.strictEqual(replay.body.run.provenance.model, 'a-model');
    const other = await request(h.base, 'POST', '/api/v1/generate', { tok: design, body: { ...body, route: { provider: 'seam-b', model: 'b-model' } } });
    assert.strictEqual(other.status, 409);
    assert.strictEqual(other.body.code, 'idempotency.conflict');
});

t.test('quotas still apply to a pinned run', async () => {
    const pinner = token('pinner', ['ai.run.create'], { ns: ['ai.*'] });
    const q = await request(h.base, 'POST', '/api/v1/quotas', { tok: admin, body: {
        scope_type: 'service', scope_id: 'pinner', window: 'minute', max_requests: 1,
    } });
    assert.strictEqual(q.status, 201, q.text);
    const body = { prompt: 'quota', route: { provider: 'seam-a', model: 'a-model' }, options: { cache: false } };
    const first = await request(h.base, 'POST', '/api/v1/generate?wait=5000', { tok: pinner, body });
    assert.strictEqual(first.status, 201, first.text);
    const second = await request(h.base, 'POST', '/api/v1/generate', { tok: pinner, body });
    assert.strictEqual(second.status, 429, second.text);
    assert.strictEqual(second.body.code, 'quota.exceeded');
});

t.test('shutdown', async () => {
    await h.stop();
    await a.close();
    await b.close();
});

t.run();
