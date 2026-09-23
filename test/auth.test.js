'use strict';
// Service-token auth and capability denial: no token, a bad signature, the wrong audience and an
// expired token are 401; a token without the capability is 403 capability.denied; family grants
// (ai.*) work; namespace-limited tokens cannot run other products' workflows; admin routes need the
// manage capabilities; provider responses never contain a secret value; runs are private to the
// requester.

const assert = require('assert');
const crypto = require('crypto');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('auth');
let h;
const SECRET = 'sk-test-THIS-MUST-NEVER-BE-RETURNED-0123456789';
const body = { workflow: 'ai.generate', input: { prompt: 'hi' } };

t.test('boot with a secret in the environment', async () => {
    h = await boot({ env: { AI_API_KEY: SECRET, AI_PROVIDER: 'openai', AI_BASE_URL: 'http://127.0.0.1:1/v1', AI_STUB_FALLBACK: 'true' } });
});

t.test('missing, forged, wrong-audience and expired tokens are 401', async () => {
    let r = await request(h.base, 'POST', '/api/v1/runs', { body });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.code, 'token.missing');
    assert.match(r.headers.get('content-type'), /application\/problem\+json/);
    const forgedKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    r = await request(h.base, 'POST', '/api/v1/runs', { tok: token('live', ALL, { key: forgedKey }), body });
    assert.strictEqual(r.body.code, 'token.bad_signature');
    r = await request(h.base, 'POST', '/api/v1/runs', { tok: token('live', ALL, { aud: 'openvibe.events' }), body });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.code, 'token.wrong_audience');
    r = await request(h.base, 'POST', '/api/v1/runs', { tok: token('live', ALL, { exp: Math.floor(Date.now() / 1000) - 3600 }), body });
    assert.strictEqual(r.body.code, 'token.expired');
});

t.test('a token without the capability is 403 capability.denied', async () => {
    const readOnly = token('live', ['ai.run.read']);
    let r = await request(h.base, 'POST', '/api/v1/runs', { tok: readOnly, body });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'capability.denied');
    r = await request(h.base, 'POST', '/api/v1/summarize', { tok: token('live', ['events.event.publish']), body: { text: 'x' } });
    assert.strictEqual(r.status, 403);
    const runner = token('live', ['ai.run.create']);
    for (const [m, p] of [['GET', '/api/v1/providers'], ['POST', '/api/v1/providers'], ['POST', '/api/v1/templates/ai.generate/versions'], ['GET', '/api/v1/usage'], ['GET', '/api/v1/audit'], ['POST', '/api/v1/quotas'], ['DELETE', '/api/v1/cache']]) {
        const x = await request(h.base, m, p, { tok: runner, body: m === 'GET' || m === 'DELETE' ? undefined : {} });
        assert.strictEqual(x.status, 403, `${m} ${p}`);
    }
    const wf = await request(h.base, 'GET', '/api/v1/workflows', { tok: runner });
    assert.strictEqual(wf.status, 200, 'callers can discover workflow schemas');
});

t.test('family grants (ai.*) and exact grants both work', async () => {
    assert.strictEqual((await request(h.base, 'POST', '/api/v1/runs?wait=3000', { tok: token('live', ['ai.*']), body })).status, 201);
    assert.strictEqual((await request(h.base, 'POST', '/api/v1/runs?wait=3000', { tok: token('live', ['ai.run.create']), body })).status, 201);
    assert.strictEqual((await request(h.base, 'POST', '/api/v1/runs', { tok: token('live', ['ai.run.*x']), body })).status, 403);
});

t.test('a namespace-limited token may only run workflows in its namespaces', async () => {
    const liveOnly = token('live', ['ai.run.create'], { ns: ['live.*'] });
    assert.strictEqual((await request(h.base, 'POST', '/api/v1/runs?wait=3000', { tok: liveOnly, body: { workflow: 'live.translate', input: { text: 'bonjour tout le monde', from: 'fr', to: 'en' } } })).status, 201);
    const r = await request(h.base, 'POST', '/api/v1/runs', { tok: liveOnly, body: { workflow: 'wiki.generate_page', input: { title: 'x', sources: [{ source_type: 'web.page' }] } } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'capability.namespace_denied');
});

t.test('namespaces fail closed: a token without ns runs nothing outside its own fallback', async () => {
    const run = (tok, workflow, input) => request(h.base, 'POST', '/api/v1/runs', { tok, body: { workflow, input } });
    const denied = (r, what) => { assert.strictEqual(r.status, 403, what); assert.strictEqual(r.body.code, 'capability.namespace_denied', what); };
    // A service with no ns claim (or an empty one) is held to <service>.*.
    denied(await run(token('games', ['ai.run.create'], { ns: null }), 'ai.generate', { prompt: 'hi' }), 'svc:games without ns -> ai.generate');
    denied(await run(token('games', ['ai.run.create'], { ns: [] }), 'wiki.generate_page', { title: 'x', sources: [{ source_type: 'web.page' }] }), 'svc:games with ns [] -> wiki.*');
    assert.notStrictEqual((await run(token('games', ['ai.run.create'], { ns: null }), 'games.generate_lore', {})).status, 403, 'svc:games -> games.*');
    // Live (Network grants it no namespaces): live.* and network.site_copy by the default AI_NS_FALLBACK, nothing else.
    const live = token('live', ['ai.run.create'], { ns: null });
    assert.strictEqual((await request(h.base, 'POST', '/api/v1/runs?wait=3000', { tok: live, body: { workflow: 'live.translate', input: { text: 'bonjour tout le monde', from: 'fr', to: 'en' } } })).status, 201);
    assert.notStrictEqual((await run(live, 'network.site_copy', { sites: [], links: [] })).status, 403, 'svc:live -> network.site_copy');
    denied(await run(live, 'ai.generate', { prompt: 'hi' }), 'svc:live without ns -> ai.generate');
    denied(await run(live, 'network.other', {}), 'svc:live without ns -> network.other');
    denied(await request(h.base, 'POST', '/api/v1/generate', { tok: live, body: { prompt: 'hi' } }), 'direct operations are ai.* runs');
    // App and module tokens have no fallback.
    const app = token('x', ['ai.run.create'], { ns: null, sub: 'app:app_01HZZZZZZZZZZZZZZZZZZZZZZZ', actorType: 'app', extra: { project_id: 'prj_01HZZZZZZZZZZZZZZZZZZZZZZZ', env: 'production' } });
    denied(await run(app, 'ai.generate', { prompt: 'hi' }), 'app token without ns');
    // An explicit ns claim always decides (Network's own token: network.*).
    const network = token('network', ['ai.run.create'], { ns: ['network.*'] });
    denied(await run(network, 'live.translate', { text: 'hola', from: 'es', to: 'en' }), 'svc:network ns network.* -> live.*');
});

t.test('AI_NS_FALLBACK and AI_NS_REQUIRED', () => {
    const { load } = require('../server/config');
    const { namespaceAllowed } = require('../server/auth');
    const svc = (id, ns) => ({ sub: `svc:${id}`, ns });
    const d = load({}).namespaces;
    assert.deepStrictEqual(d, { required: true, derive: true, fallback: { live: ['live.*', 'network.site_copy'] } });
    assert.strictEqual(namespaceAllowed(svc('live', []), 'live.translate', d), true);
    assert.strictEqual(namespaceAllowed(svc('live', []), 'network.site_copy', d), true);
    assert.strictEqual(namespaceAllowed(svc('live', []), 'ai.generate', d), false);
    assert.strictEqual(namespaceAllowed(svc('news', undefined), 'news.summarize_story', d), true);
    assert.strictEqual(namespaceAllowed({ sub: 'svc:live' }, 'wiki.generate_page', d), false);
    assert.strictEqual(namespaceAllowed(null, 'ai.generate', d), false);
    const strict = load({ AI_NS_FALLBACK: 'none' }).namespaces;
    assert.strictEqual(namespaceAllowed(svc('live', []), 'live.translate', strict), false, 'none: no fallback at all');
    assert.strictEqual(namespaceAllowed(svc('live', ['live.*']), 'live.translate', strict), true);
    const custom = load({ AI_NS_FALLBACK: 'live=live.*, news=news.summarize_story|ai.summarize' }).namespaces;
    assert.strictEqual(namespaceAllowed(svc('live', []), 'network.site_copy', custom), false);
    assert.strictEqual(namespaceAllowed(svc('news', []), 'ai.summarize', custom), true);
    assert.strictEqual(namespaceAllowed(svc('news', []), 'news.compare_perspectives', custom), false);
    assert.throws(() => load({ AI_NS_FALLBACK: 'live' }), /AI_NS_FALLBACK/);
    const open = load({ AI_NS_REQUIRED: 'false' }).namespaces;
    assert.strictEqual(namespaceAllowed(svc('games', []), 'ai.generate', open), true, 'rollback lever: the old open rule');
    assert.strictEqual(namespaceAllowed(svc('games', ['games.*']), 'ai.generate', open), false, 'an ns claim still decides');
});

t.test('provider responses never contain a secret value', async () => {
    const admin = token('ops', ALL);
    const list = await request(h.base, 'GET', '/api/v1/providers', { tok: admin });
    assert.ok(!list.text.includes(SECRET), 'secret leaked in provider list');
    const shared = list.body.providers.find(p => p.key === 'shared');
    assert.strictEqual(shared.secret_ref, 'env:AI_API_KEY');
    assert.strictEqual(shared.credentials, 'configured');
    const one = await request(h.base, 'GET', '/api/v1/providers/shared', { tok: admin });
    assert.ok(!one.text.includes(SECRET));
    const bad = await request(h.base, 'POST', '/api/v1/providers', { tok: admin, body: { key: 'x', kind: 'openai', api_key: 'sk-raw' } });
    assert.strictEqual(bad.status, 422, 'raw secrets are refused');
    const bad2 = await request(h.base, 'POST', '/api/v1/providers', { tok: admin, body: { key: 'x', kind: 'openai', secret_ref: 'sk-raw-value' } });
    assert.strictEqual(bad2.status, 422, 'secret_ref must be a reference');
    const status = await request(h.base, 'GET', '/api/v1/status', { tok: admin });
    assert.ok(!status.text.includes(SECRET));
    const reqs = await request(h.base, 'GET', '/api/v1/requests?debug=1', { tok: admin });
    assert.ok(!reqs.text.includes(SECRET));
    const audit = await request(h.base, 'GET', '/api/v1/audit?limit=500', { tok: admin });
    assert.ok(!audit.text.includes(SECRET));
});

t.test("one service cannot read, cancel or retry another service's run", async () => {
    const mine = await request(h.base, 'POST', '/api/v1/runs?wait=3000', { tok: token('live', ALL), body });
    const id = mine.body.run.id;
    const other = token('games', ['ai.run.create', 'ai.run.read']);
    assert.strictEqual((await request(h.base, 'GET', `/api/v1/runs/${id}`, { tok: other })).status, 404);
    assert.strictEqual((await request(h.base, 'POST', `/api/v1/runs/${id}/retry`, { tok: other })).status, 404);
    const list = await request(h.base, 'GET', '/api/v1/runs', { tok: other });
    assert.ok(!list.body.runs.some(r => r.id === id));
    assert.strictEqual((await request(h.base, 'GET', `/api/v1/runs/${id}`, { tok: token('ops', ['ai.usage.read']) })).status, 200, 'usage readers can inspect');
});

t.test('health is public and says nothing secret', async () => {
    const r = await request(h.base, 'GET', '/api/health');
    assert.strictEqual(r.status, 200);
    const ready = await request(h.base, 'GET', '/api/ready');
    assert.strictEqual(ready.status, 200);
    assert.ok(!ready.text.includes(SECRET));
});

t.test('shutdown', async () => { await h.stop(); });

t.run();
