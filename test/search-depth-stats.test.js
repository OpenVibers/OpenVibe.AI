'use strict';
// What each search v2 depth really costs and takes (plan AD.34 item 5): each answered v2 search adds its receipt's cost
// and time to its depth and output; the summary gives medians and 90th percentiles of the last 200; only numbers are
// kept; and GET /api/v1/exchange/search/depths is public, with each depth's plan beside its measurements.
const assert = require('node:assert/strict');
const { createDepthStats, KEEP } = require('../server/search/depth-stats');
const { boot, request } = require('./helpers');

const json = (body) => new Response(JSON.stringify(body));

(async () => {
    // The store on its own: a Valkey-shaped list when there is one, the process's Map without.
    const lists = new Map();
    const valkey = { key: (...p) => p.join(':'), client: {
        lpush: async (k, v) => { const l = lists.get(k) || []; l.unshift(v); lists.set(k, l); },
        ltrim: async (k, a, b) => { lists.set(k, (lists.get(k) || []).slice(a, b + 1)); },
        lrange: async (k, a, b) => (lists.get(k) || []).slice(a, b + 1),
    } };
    const stats = createDepthStats({ valkey, now: () => Date.parse('2026-11-20T22:00:00Z') });
    for (let i = 1; i <= KEEP + 20; i++) await stats.record('fast', 'results', { cost_usd: i / 1e6, time_ms: 1000 + i });
    await stats.record('standard', 'answer', { cost_usd: 0.0023, time_ms: 13400 });
    await stats.record('bottomless', 'results', { cost_usd: 1, time_ms: 1 });
    await stats.record('fast', 'results', { cost_usd: 'x', time_ms: 5 });
    const sum = await stats.summary();
    const fast = sum.depths.find((d) => d.depth === 'fast' && d.output === 'results');
    assert.equal(fast.n, KEEP, 'the last 200, no more');
    assert.deepEqual(fast.time_ms, { p50: 1121, p90: 1200 }, 'medians over what was kept (the newest 200)');
    assert.equal(sum.depths.find((d) => d.depth === 'standard' && d.output === 'answer').cost_usd.p50, 0.0023);
    assert.equal(sum.depths.find((d) => d.depth === 'deep' && d.output === 'results').n, 0);
    assert.ok(!sum.depths.some((d) => d.depth === 'bottomless'), 'only the four depths');
    assert.ok([...lists.values()].flat().every((row) => /^\[[\d.e-]+,\d+,\d+\]$/.test(row)), 'only numbers are kept');
    const bare = createDepthStats();
    await bare.record('instant', 'results', { cost_usd: 0, time_ms: 900 });
    assert.equal((await bare.summary()).depths.find((d) => d.depth === 'instant' && d.output === 'results').n, 1, 'without Valkey, in the process');
    console.log('  ✓ the store: the last 200 per depth and output, medians and 90th percentiles, numbers only');

    // Through the service: a fast search is measured, and the endpoint is public.
    const h = await boot({
        env: { SEARCH_BRAVE_KEY: 'shared-brave-fixture', SEARCH_SERPER_KEY: 'shared-serper-fixture' },
        searchFetch: async (url) => {
            const host = new URL(url).hostname;
            if (host === 'google.serper.dev') return json({ organic: [{ title: 'Lantern', link: 'https://www.example.org/article/', snippet: 'A new lantern in Lisbon for winter visitors to see' }] });
            return json(require('./fixtures/search/brave.json').response);
        },
    });
    try {
        const { createKeys } = require('../server/platform/keys');
        const keys = createKeys({ db: h.db });
        const made = await keys.create('usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', { name: 'Search', monthly_cap_usd: 1, allowed_models: ['openvibe'], expires_at: new Date(Date.now() + 60000).toISOString() });
        const r = await request(h.base, 'POST', '/v1/search', { tok: made.secret, body: { q: 'lantern', depth: 'fast' } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        let fastRow = null;
        for (let i = 0; i < 50 && !(fastRow && fastRow.measured.results); i++) {
            const d = await request(h.base, 'GET', '/api/v1/exchange/search/depths');
            assert.equal(d.status, 200, 'public: no token');
            fastRow = d.body.depths.find((x) => x.depth === 'fast');
            if (!(fastRow && fastRow.measured.results)) await new Promise((res) => setTimeout(res, 20));
        }
        assert.deepEqual([fastRow.engines, fastRow.pages_read], [2, 0], "each depth's plan");
        assert.equal(fastRow.measured.results.n, 1);
        assert.equal(fastRow.measured.results.cost_usd.p50, r.body.receipt.cost_usd, 'what its receipt said');
        assert.equal(fastRow.measured.answer, null, 'nothing measured yet is null, not zero');
        console.log('  ✓ a v2 search is measured; GET /api/v1/exchange/search/depths is public, plan beside measurements');
    } finally {
        await h.close();
    }
    console.log('search-depth-stats: 2 checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
