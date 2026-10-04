'use strict';
// GET /stats: the public price/latency page. Server-rendered, no sign-in; rows come from provider_stats_daily
// (quotas.statsFor) and the platform.rate-card@1 cards only. Nothing per caller ever reaches it: not the
// requester, the attribution, a person's own-key provider (byo:<owner>:<subject>), a base URL or a secret.
const assert = require('assert');
const { boot, request, suite } = require('./helpers');

const t = suite('stats-page');
let h;

const SEAM_URL = 'http://127.0.0.1:9/seam-internal';
const ctx = { requesterType: 'service', requesterId: 'live', attributionKey: 'live:user:4242', workflowKey: 'default.generate' };
const attempt = (provider_key, model_key, status, latency_ms) => ({ provider_key, model_key, status, latency_ms, cost_usd: 0.001, tokens_in: 10, tokens_out: 5, route_key: null });

t.test('boot', async () => {
    h = await boot({ env: { AI_STUB_FALLBACK: 'false' } });
});

t.test('no samples: 200 without auth, text/html, a short public cache and an honest empty state', async () => {
    const r = await request(h.base, 'GET', '/stats');
    assert.strictEqual(r.status, 200, r.text);
    assert.match(r.headers.get('content-type'), /^text\/html/);
    assert.strictEqual(r.headers.get('cache-control'), require('openvibe-shared/cache-policy').htmlHeaders());
    assert.match(r.headers.get('cache-control'), /^public, max-age=\d+/);
    assert.ok(r.headers.get('content-security-policy'), 'the console CSP (no scripts)');
    assert.match(r.text, /no provider calls in the last 7 days/);
    assert.doesNotMatch(r.text, /<table/);
    assert.doesNotMatch(r.text, /<script/i);
});

t.test('seeded stats: one row per provider and model with p50, p95, success rate, price and allowance', async () => {
    await h.registry.upsertProvider({ key: 'seam', kind: 'http', auth_mode: 'bearer', secret_ref: 'env:SEAM_SECRET_KEY', base_url: SEAM_URL, capabilities: ['chat', 'json'], timeout_ms: 5000 });
    await h.registry.upsertModel({ provider_key: 'seam', model_key: 'seam-model', type: 'chat', cost: { in_per_mtok: 3, out_per_mtok: 15, cached_per_mtok: 0.3, free_allowance: 1000000, reset_period: 'month' } });
    await h.quotas.account(ctx, [], {
        provider: 'seam', model: 'seam-model', writeUsage: false,
        attempts: [attempt('seam', 'seam-model', 'ok', 80), attempt('seam', 'seam-model', 'ok', 90), attempt('seam', 'seam-model', 'ok', 150), attempt('seam', 'seam-model', 'error', 3000)],
    });
    // A person's own key: its runs are recorded under byo:<owner>:<subject>, never a public row.
    await h.quotas.account(ctx, [], { provider: 'byo:user:usr_owner1:usr_subject1', model: 'own-model', writeUsage: false, attempts: [attempt('byo:user:usr_owner1:usr_subject1', 'own-model', 'ok', 40)] });

    const r = await request(h.base, 'GET', '/stats');
    assert.strictEqual(r.status, 200, r.text);
    assert.doesNotMatch(r.text, /no provider calls/);
    const rows = r.text.match(/<tbody>([\s\S]*)<\/tbody>/)[1].split('</tr>').filter((x) => x.includes('<td'));
    assert.strictEqual(rows.length, 1, r.text);
    const cells = [...rows[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
    // Provider, Model, Capability, p50, p95, Success rate, Price, Free allowance (bucket upper bounds: 100 ms, 3200 ms).
    assert.deepStrictEqual(cells.slice(0, 6), ['seam', 'seam-model', 'chat', '100 ms', '3,200 ms', '75.0 % (3 / 4)']);
    assert.match(cells[6], /in \$3\.0000 · cached \$0\.3000 · out \$15\.0000 per 1M tokens/);
    assert.match(cells[7], /in 1,000,000 tokens \/ month/);
    for (const h2 of ['Provider', 'Model', 'Capability', 'p50', 'p95', 'Success rate', 'Price', 'Free allowance']) assert.ok(r.text.includes(`<th scope="col">${h2}</th>`), h2);
    assert.match(r.text, /last 7 UTC days \(\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\)/);
});

t.test('a subject with free allowance used this period is still not on the page', async () => {
    const free = await h.quotas.freeAllowance.claim('live:user:4242', 'seam', 'seam-model', { in: 10 });
    assert.strictEqual(free.tokens, 10);
    assert.ok((await h.quotas.freeAllowance.current()).some((r) => r.subject === 'live:user:4242'), 'the staff console has the row');
});

t.test('no caller identifiers, internal URLs or secrets in the HTML', async () => {
    const r = await request(h.base, 'GET', '/stats');
    for (const leak of ['byo:', 'usr_owner1', 'usr_subject1', 'own-model', 'service:live', 'live:user:4242', 'default.generate', 'ai:run_', SEAM_URL, '127.0.0.1', 'SEAM_SECRET_KEY', 'env:']) {
        assert.ok(!r.text.includes(leak), `the page shows ${leak}`);
    }
});

t.test('stop', async () => { await h.stop(); });

t.run();
