'use strict';
// Quotas are enforced BEFORE any provider is called: a refused request is a 429 problem with
// Retry-After, creates no run and never reaches a provider. Per-service '*' quotas count each
// service separately; attribution quotas (Live's per-streamer budgets) and cost caps work too.

const assert = require('assert');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');

const t = suite('quota');
const live = token('live', ALL);
const tools = token('tools', ['ai.run.create', 'ai.run.read']);
let h;
let seam;

const runCount = () => h.db.prepare('SELECT COUNT(*) n FROM runs').get().n;
const gen = (tok, prompt, extra = {}) => request(h.base, 'POST', '/api/v1/generate', { tok, body: { prompt, options: { cache: false }, ...extra } });

t.test('boot with a counting seam provider as the only route target', async () => {
    seam = await seamServer(() => ({ text: 'ok', usage: { input: 1000, output: 1000 } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_QUOTA_SERVICE_RPM: '3' } });
    await request(h.base, 'POST', '/api/v1/providers', { tok: live, body: { key: 'seam', kind: 'http', base_url: seam.url, auth_mode: 'none', capabilities: ['generate', 'chat'] } });
    await request(h.base, 'POST', '/api/v1/models', { tok: live, body: { provider_key: 'seam', model_key: 'm1', cost: { in_per_mtok: 1000, out_per_mtok: 1000 } } });
    const r = await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: live, body: { primary: { provider: 'seam', model: 'm1' }, fallbacks: [] } });
    assert.strictEqual(r.status, 201, r.text);
});

t.test('the per-service rate refuses the 4th request with 429 before the provider is called', async () => {
    for (let i = 0; i < 3; i++) assert.strictEqual((await gen(live, `p${i}`)).status, 201);
    const callsBefore = seam.calls;
    const runsBefore = runCount();
    const r = await gen(live, 'one too many');
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.body.code, 'quota.exceeded');
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.ok(r.body.retry_after_seconds >= 1 && r.body.retry_after_seconds <= 60);
    assert.strictEqual(r.body.quota.scope_type, 'service');
    assert.strictEqual(r.body.quota.scope_id, 'live');
    assert.strictEqual(seam.calls, callsBefore, 'the provider was never called');
    assert.strictEqual(runCount(), runsBefore, 'no run was created');
});

t.test("'*' service quotas give each service its own window", async () => {
    const r = await gen(tools, 'from tools');
    assert.strictEqual(r.status, 201, 'another service is not limited by live\'s usage');
});

t.test('attribution quotas limit one attributed owner (Live per-streamer budget)', async () => {
    await request(h.base, 'POST', '/api/v1/quotas', { tok: live, body: { scope_type: 'service', scope_id: '*', window: 'minute', max_requests: 1000 } });
    const q = await request(h.base, 'POST', '/api/v1/quotas', { tok: live, body: { scope_type: 'attribution', scope_id: 'live:user:42', window: 'day', max_requests: 1 } });
    assert.strictEqual(q.status, 201, q.text);
    const who = { service: 'live', type: 'user', id: '42' };
    assert.strictEqual((await gen(live, 'streamer 42 a', { attribution: who })).status, 201);
    const calls = seam.calls;
    const r = await gen(live, 'streamer 42 b', { attribution: who });
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.body.quota.scope_type, 'attribution');
    assert.strictEqual(seam.calls, calls);
    assert.strictEqual((await gen(live, 'streamer 7', { attribution: { service: 'live', type: 'user', id: '7' } })).status, 201, 'other owners unaffected');
});

t.test('a daily cost cap (AI_MAX_COST_USD_PER_DAY semantics) stops spend once reached', async () => {
    await request(h.base, 'POST', '/api/v1/quotas', { tok: live, body: { scope_type: 'global', window: 'day', max_cost_usd: 0.001 } });
    // Each call costs (1000 + 1000) tokens at $1000/Mtok = $2, so the cap is already spent.
    const calls = seam.calls;
    const r = await gen(tools, 'after the cap');
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.body.quota.scope_type, 'global');
    assert.strictEqual(seam.calls, calls);
    const usage = await request(h.base, 'GET', '/api/v1/usage', { tok: live });
    assert.ok(usage.body.usage.some(u => u.requester === 'service:live' && u.cost_usd > 0), 'usage is recorded per requester');
    const cur = await request(h.base, 'GET', '/api/v1/quotas', { tok: live });
    assert.ok(cur.body.current.some(c => c.quota.scope_type === 'global' && c.used.cost_usd > 0.001));
});

t.test('quota changes are audited', async () => {
    const a = await request(h.base, 'GET', '/api/v1/audit?target_type=quota', { tok: live });
    assert.ok(a.body.audit.some(x => x.action === 'quota.create' && x.actor === 'svc:live'));
});

t.test('shutdown', async () => { await h.stop(); await seam.close(); });

t.run();
