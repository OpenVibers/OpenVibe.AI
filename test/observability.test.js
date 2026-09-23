'use strict';
// Track O: GET /metrics answers direct loopback callers only, labels requests by route template and
// carries the AI gauges (queued/running runs, provider circuit state); /api/ready is 503 when the
// database fails, and provider configuration (missing credentials, an open circuit) degrades it.

const assert = require('assert');
const nodeHttp = require('http');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('observability');
const admin = token('ops', ALL);
const caller = token('live', ['ai.run.create', 'ai.run.read']);
let h;

function get(base, p, headers = {}) {
    return new Promise((resolve, reject) => nodeHttp.get(base + p, { headers }, (res) => {
        let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject));
}
const metric = (text, re) => { const m = text.match(re); return m ? Number(m[1]) : null; };

t.test('boot with one run slot, a configured shared key and a slow provider', async () => {
    h = await boot({ env: { AI_API_KEY: 'sk-test-not-real', AI_MAX_CONCURRENT_RUNS: '1', AI_STUB_FALLBACK: 'false' } });
    await h.keyLoaded;
    const p = await request(h.base, 'POST', '/api/v1/providers', { tok: admin, body: { key: 'slowstub', kind: 'stub', auth_mode: 'none', capabilities: ['chat', 'generate', 'summarize', 'json'], metadata: { delay_ms: 1500 } } });
    assert.strictEqual(p.status, 201, p.text);
    const r = await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: admin, body: { primary: { provider: 'slowstub' }, fallbacks: [] } });
    assert.strictEqual(r.status, 201, r.text);
});

t.test('/api/ready: every check reports; providers is the only optional one', async () => {
    const r = await request(h.base, 'GET', '/api/ready');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.status, 'ready');
    assert.strictEqual(r.body.service, 'ai');
    assert.deepStrictEqual(Object.keys(r.body.checks), ['db', 'workflows', 'network_jwks', 'providers']);
    for (const [name, c] of Object.entries(r.body.checks)) {
        assert.strictEqual(c.status, 'ok', `${name}: ${c.error}`);
        assert.strictEqual(c.required, name !== 'providers', name);
        assert.strictEqual(typeof c.latency_ms, 'number');
        assert.ok(Date.parse(c.checked_at));
    }
    assert.ok(r.body.providers.some(p => p.key === 'shared' && p.credentials === 'configured' && p.circuit === 'closed'));
    assert.strictEqual(r.body.runs.queued, 0);
    assert.ok(!r.text.includes('sk-test-not-real'));
});

t.test('/metrics: 404 through a proxy; queued and running runs, route templates, circuit state direct', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
        const c = await request(h.base, 'POST', '/api/v1/runs', { tok: caller, body: { workflow: 'ai.generate', input: { prompt: `metrics ${i}` }, options: { cache: false } } });
        assert.strictEqual(c.status, 202, c.text);
        ids.push(c.body.run.id);
    }
    await request(h.base, 'GET', `/api/v1/runs/${ids[0]}`, { tok: caller });
    for (const hdr of [{ 'X-Forwarded-For': '203.0.113.7' }, { 'X-Real-IP': '203.0.113.7' }, { 'CF-Connecting-IP': '203.0.113.7' }]) {
        const m = await get(h.base, '/metrics', hdr);
        assert.strictEqual(m.status, 404, JSON.stringify(hdr));
        assert.ok(!m.body.includes('ai_runs'));
    }
    const m = await get(h.base, '/metrics');
    assert.strictEqual(m.status, 200);
    const text = m.body;
    assert.strictEqual(metric(text, /\nai_runs\{state="queued"\} (\d+)\n/), 2, 'two runs wait for the one slot');
    assert.strictEqual(metric(text, /\nai_runs\{state="running"\} (\d+)\n/), 1);
    assert.strictEqual(metric(text, /\nai_runs_max_concurrent (\d+)\n/), 1);
    assert.ok(/http_requests_total\{method="POST",route="\/api\/v1\/runs",status_class="2xx"\} 3\n/.test(text));
    assert.ok(/http_requests_total\{method="GET",route="\/api\/v1\/runs\/:id",status_class="2xx"\} 1\n/.test(text), 'route template');
    assert.ok(!text.includes(ids[0]), 'no run id in any label');
    assert.ok(/http_request_duration_seconds_count\{method="GET",route="\/api\/ready"\} 1\n/.test(text));
    assert.ok(/\nprocess_resident_memory_bytes \d+\n/.test(text));
    assert.ok(/release_info\{service="ai",release="[^"]+"\} 1\n/.test(text));
    assert.ok(/ai_provider_circuit\{provider="shared",state="closed"\} 1\n/.test(text));
    assert.ok(/ai_provider_circuit\{provider="shared",state="open"\} 0\n/.test(text));
    assert.ok(/ai_provider_credentials_missing\{provider="shared"\} 0\n/.test(text));
    for (const id of ids) await request(h.base, 'POST', `/api/v1/runs/${id}/cancel`, { tok: caller });
});

t.test('an open circuit on a real provider degrades /api/ready (still 200) and shows on /metrics', async () => {
    h.db.prepare("INSERT INTO provider_health (provider_key, state, consecutive_failures, opened_at, last_error) VALUES ('shared', 'open', 3, ?, 'test')").run(Date.now());
    const r = await request(h.base, 'GET', '/api/ready');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.status, 'degraded');
    assert.deepStrictEqual(r.body.degraded, ['providers']);
    assert.strictEqual(r.body.checks.providers.error, 'shared: circuit open');
    const text = (await get(h.base, '/metrics')).body;
    assert.ok(/ai_provider_circuit\{provider="shared",state="open"\} 1\n/.test(text));
    assert.ok(/ai_provider_circuit\{provider="shared",state="closed"\} 0\n/.test(text));
    h.pool.resetHealth('shared');
});

t.test('a broken database makes the service unready (503); /metrics still answers', async () => {
    await h.stop();
    const fresh = await boot({ env: { AI_API_KEY: 'sk-test-not-real' } });
    fresh.db.close();
    const r = await request(fresh.base, 'GET', '/api/ready');
    assert.strictEqual(r.status, 503, r.text);
    assert.strictEqual(r.body.ready, false);
    assert.ok(r.body.failed.includes('db'), r.text);
    assert.strictEqual(r.body.providers, null);
    const m = await get(fresh.base, '/metrics');
    assert.strictEqual(m.status, 200);
    assert.ok(!/ai_provider_circuit\{/.test(m.body), 'a gauge that cannot be read is left out, not invented');
    try { await fresh.stop(); } catch { /* the database is already closed */ }
});

t.test('no shared key: ready but degraded, and says which provider lacks credentials', async () => {
    const d = await boot();
    const r = await request(d.base, 'GET', '/api/ready');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.status, 'degraded');
    assert.match(r.body.checks.providers.error, /shared: credentials missing/);
    const text = (await get(d.base, '/metrics')).body;
    assert.ok(/ai_provider_credentials_missing\{provider="shared"\} 1\n/.test(text));
    await d.stop();
});

t.run();
