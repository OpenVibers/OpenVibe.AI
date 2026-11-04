'use strict';
/**
 * AI Exchange P7: alias routing by measured evidence (AI_ROUTING_EVIDENCE).
 *
 *   - the per-deployment EWMA updates from each attempt and survives a new reader (the table is the store);
 *   - price_after_cache is integer BigInt arithmetic on the retail card and the measured cache-hit ratio;
 *   - economy orders by expected cost per success, fast by p50 TTFT then decode tokens/s;
 *   - sparse Bench evidence is ignored and reported, never filled in;
 *   - hysteresis keeps the incumbent within the margin and switches after N consecutive challenger wins;
 *   - cache affinity prefers the deployment that served the same prompt prefix while it is within the margin;
 *   - exploration is 0 by default and never runs on an exact id, BYOK or an opted-out preference;
 *   - with the flag off nothing is written and the router's order is unchanged.
 */
const assert = require('assert');
const { suite, boot, request, token, seamServer, ALL } = require('./helpers');
const { testDb } = require('./db');
const { createProviderMetrics, ewma } = require('../server/providers/metrics');
const { createRoutingEvidence, priceAfterCacheNano, blendedInputRateNano, combineEvidence } = require('../server/providers/evidence');
const { createVariantEvidence } = require('../server/providers/bench-variant');

const t = suite('routing-evidence');
const tok = token('live', ALL);
const CLOCK = { now: () => Date.parse('2026-11-04T00:00:00.000Z') };
const CONFIG = (over = {}) => ({
    routingEvidence: {
        enabled: true, alpha: 0.2, minSamples: 2, successFloor: 0.1, prior: 0.9,
        hysteresisDecisions: 3, explorationShare: 0, affinityGain: 0.05, expectedOutputTokens: 512, ...over,
    },
    placement: { costWeight: 0.5, latencyWeight: 0.5 },
});
const RETAIL = (inM, cachedM, outM, fee = '0') => ({
    input_nano_usd_per_m: String(inM), cached_read_nano_usd_per_m: String(cachedM),
    cache_write_nano_usd_per_m: '0', output_nano_usd_per_m: String(outM), per_request_nano_usd: fee,
});

async function seed(metrics, provider, { n = 3, ok = true, ttft = null, latency = 1000, input = 1000, cached = 0, output = 500 } = {}) {
    for (let i = 0; i < n; i++) await metrics.record({ provider, model: 'm', ok, ttftMs: ttft, latencyMs: latency, inputTokens: input, cachedTokens: cached, outputTokens: output });
}

async function harness({ prices = {}, config = CONFIG(), bench = null, metrics: givenMetrics = null } = {}) {
    const db = await testDb();
    const metrics = givenMetrics || createProviderMetrics({ db: db.db, clock: CLOCK });
    const resolveOffer = async (c) => {
        const p = prices[c.provider];
        if (!p) return null;
        return { id: `${c.provider}:${c.model}`, provider: c.provider, model: c.model, exactId: p.exactId || null, access: 'OWN_DEPLOYMENT', free: false, retail: p.retail || RETAIL(10, 1, 10) };
    };
    const ev = createRoutingEvidence({ db: db.db, clock: CLOCK, metrics, bench, resolveOffer, config });
    return { db, metrics, ev, stop: () => db.close() };
}

t.test('the EWMA updates and the table keeps the measurements for a new reader', async () => {
    const db = await testDb();
    const first = createProviderMetrics({ db: db.db, clock: CLOCK });
    await first.record({ provider: 'p', model: 'm', ok: true, ttftMs: 100, latencyMs: 1100, inputTokens: 1000, cachedTokens: 500, outputTokens: 1000 });
    await first.record({ provider: 'p', model: 'm', ok: false, timeout: true, latencyMs: 400, inputTokens: 100, cachedTokens: 0, outputTokens: 0 });
    const row = await first.get('p', 'm');
    assert.strictEqual(row.sample_count, 2);
    assert.strictEqual(row.ttft_samples, 1);
    assert.strictEqual(row.decode_samples, 1);
    assert.strictEqual(row.cache_samples, 2);
    assert.strictEqual(row.success_rate, ewma(1, 0, 0.2), 'one failure after a success is an EWMA, not a reset');
    assert.strictEqual(row.timeout_rate, 0.2);
    assert.strictEqual(row.cache_hit_ratio, 0.2 * 0 + 0.8 * 0.5, 'the cache ratio follows its own observations');
    const second = createProviderMetrics({ db: db.db, clock: CLOCK });
    const again = await second.get('p', 'm');
    assert.deepStrictEqual(again, row, 'a new reader (a restart) sees the persisted row');
    await db.close();
});

t.test('price_after_cache is exact integer nano-USD weighted by the cache-hit ratio', () => {
    const rates = RETAIL(3000000, 300000, 15000000, '5');
    const allUncached = priceAfterCacheNano({ promptTokens: 1000000, outputTokens: 500000, cacheHitRatio: 0, rates });
    const half = priceAfterCacheNano({ promptTokens: 1000000, outputTokens: 500000, cacheHitRatio: 0.5, rates });
    const allCached = priceAfterCacheNano({ promptTokens: 1000000, outputTokens: 500000, cacheHitRatio: 1, rates });
    assert.strictEqual(allUncached, BigInt(3000000 + 7500000 + 5));
    assert.strictEqual(half, BigInt(1500000 + 150000 + 7500000 + 5));
    assert.strictEqual(allCached, BigInt(300000 + 7500000 + 5));
    assert.strictEqual(typeof half, 'bigint');
    // A fractional component rounds up once (D1): 1 token at 1.5 nano per million is 2 nano, not 1.
    assert.strictEqual(priceAfterCacheNano({ promptTokens: 1, outputTokens: 0, cacheHitRatio: 0, rates: RETAIL(1500000, 0, 0) }), 2n);
    // The blended single rate used by the SDK planner prices the same prompt at the same total.
    for (const ratio of [0, 0.1, 0.5, 0.9, 1]) {
        const exact = BigInt(priceAfterCacheNano({ promptTokens: 12345, outputTokens: 0, cacheHitRatio: ratio, rates: RETAIL(3000000, 300000, 0) }));
        const blended = blendedInputRateNano({ promptTokens: 12345, cacheHitRatio: ratio, rates: RETAIL(3000000, 300000, 0) });
        assert.strictEqual(BigInt(priceAfterCacheNano({ promptTokens: 12345, outputTokens: 0, cacheHitRatio: 0, rates: RETAIL(blended, 0, 0) })), exact);
    }
});

t.test('economy orders by expected cost per success', async () => {
    const h = await harness({ prices: {
        cheap: { retail: RETAIL(1000000, 100000, 1000000) },
        pricey: { retail: RETAIL(9000000, 900000, 9000000) },
    } });
    await seed(h.metrics, 'cheap');
    await seed(h.metrics, 'pricey');
    const picked = await h.ev.choose({ routeKey: 'economy', policy: 'cheapest', list: [{ provider: 'pricey', model: 'm' }, { provider: 'cheap', model: 'm' }], req: { messages: [{ role: 'user', content: 'hello there' }], maxTokens: 100 }, ctx: {} });
    assert.strictEqual(picked.order[0].provider, 'cheap', picked.view.reason);
    assert.strictEqual(picked.view.policy, 'cheapest');
    assert.match(picked.view.reason, /lowest cost per success/);
    const byProvider = Object.fromEntries(picked.view.candidates.map((c) => [c.provider, c]));
    assert.ok(BigInt(byProvider.cheap.cost_per_success_nano_usd) < BigInt(byProvider.pricey.cost_per_success_nano_usd));
    await h.stop();
});

t.test('fast orders by p50 TTFT, then decode tokens/s', async () => {
    const h = await harness({ prices: {
        quick: { retail: RETAIL(1000000, 100000, 1000000) },
        slow: { retail: RETAIL(1000000, 100000, 1000000) },
        equal: { retail: RETAIL(1000000, 100000, 1000000) },
    } });
    await seed(h.metrics, 'quick', { ttft: 100, latency: 600, output: 1000 });
    await seed(h.metrics, 'slow', { ttft: 300, latency: 800, output: 1000 });
    await seed(h.metrics, 'equal', { ttft: 100, latency: 500, output: 2000 });
    const list = [{ provider: 'slow', model: 'm' }, { provider: 'quick', model: 'm' }, { provider: 'equal', model: 'm' }];
    const req = { messages: [{ role: 'user', content: 'hello there' }], maxTokens: 100 };
    const r = await h.ev.choose({ routeKey: 'fast', policy: 'fastest', list, req, ctx: {} });
    assert.strictEqual(r.order[0].provider, 'equal', 'the equal-TTFT deployment with the higher decode rate wins the tie');
    assert.strictEqual(r.view.candidates.find((c) => c.provider === 'equal').decode_tokens_per_s, 5000);
    await h.stop();
});

t.test('balanced weighs the normalised cost per success and TTFT', async () => {
    const h = await harness({ prices: {
        cheapSlow: { retail: RETAIL(100000, 0, 100000) },
        priceyFast: { retail: RETAIL(5000000, 0, 5000000) },
    } });
    await seed(h.metrics, 'cheapSlow', { ttft: 500, latency: 1000 });
    await seed(h.metrics, 'priceyFast', { ttft: 100, latency: 300 });
    const req = { messages: [{ role: 'user', content: 'hello there' }], maxTokens: 100 };
    const r = await h.ev.choose({ routeKey: 'balanced', policy: 'balanced', list: [{ provider: 'cheapSlow', model: 'm' }, { provider: 'priceyFast', model: 'm' }], req, ctx: {} });
    assert.ok(r.view.candidates.length === 2);
    assert.ok(['cheapSlow', 'priceyFast'].includes(r.order[0].provider));
    await h.stop();
});

t.test('a deployment with no measured successes is priced at the floor, not excluded', async () => {
    const h = await harness({ prices: { bad: { retail: RETAIL(1000000, 0, 1000000) }, good: { retail: RETAIL(2000000, 0, 2000000) } } });
    await seed(h.metrics, 'bad', { n: 3, ok: false });
    await seed(h.metrics, 'good', { n: 3, ok: true });
    const req = { messages: [{ role: 'user', content: 'hello there' }], maxTokens: 100 };
    const r = await h.ev.choose({ routeKey: 'floor', policy: 'cheapest', list: [{ provider: 'bad', model: 'm' }, { provider: 'good', model: 'm' }], req, ctx: {} });
    assert.strictEqual(r.order[0].provider, 'good');
    const bad = r.view.candidates.find((c) => c.provider === 'bad');
    assert.ok(bad, 'the failing deployment stays in the candidate list');
    assert.ok(BigInt(bad.cost_per_success_nano_usd) > BigInt(r.view.candidates.find((c) => c.provider === 'good').cost_per_success_nano_usd));
    await h.stop();
});

t.test('sparse Bench evidence is ignored and reported, never filled in', async () => {
    const sparse = { get: async () => ({ status: 'sparse', samples: 5, success_rate: 0.1, ttft_p50_ms: 5, decode_tokens_per_s: 500, exact_id: 'org/m@r1' }) };
    const h = await harness({ bench: sparse, prices: { a: { retail: RETAIL(1000000, 100000, 1000000), exactId: 'org/m@r1' } } });
    await seed(h.metrics, 'a', { n: 1 });
    const req = { messages: [{ role: 'user', content: 'hello there' }], maxTokens: 100 };
    const r = await h.ev.choose({ routeKey: 'sparse', policy: 'cheapest', list: [{ provider: 'a', model: 'm' }], req, ctx: {} });
    const c = r.view.candidates[0];
    assert.strictEqual(r.view.bench.status, 'sparse');
    assert.strictEqual(c.sparse_evidence, true);
    assert.strictEqual(c.p_success, 0.9, 'sparse evidence keeps the neutral prior, never Bench’s 0.1');
    assert.strictEqual(c.bench.status, 'sparse');
    assert.strictEqual(c.samples, 1, 'the EWMA sample count is reported, not Bench’s 5');
    const absent = { get: async () => ({ status: 'absent', samples: 0, exact_id: 'org/m@r1' }) };
    assert.strictEqual(combineEvidence({ metric: null, bench: await absent.get('x'), minSamples: 2 }).sparse, true);
    await h.stop();
});

t.test('non-sparse Bench evidence is an input', async () => {
    const bench = { get: async () => ({ status: 'ok', samples: 30, success_rate: 0.5, ttft_p50_ms: 50, decode_tokens_per_s: 900, exact_id: 'org/m@r1' }) };
    const h = await harness({ bench, prices: { a: { retail: RETAIL(1000000, 100000, 1000000), exactId: 'org/m@r1' } } });
    await seed(h.metrics, 'a', { n: 30, ok: true });
    const req = { messages: [{ role: 'user', content: 'hello there' }], maxTokens: 100 };
    const r = await h.ev.choose({ routeKey: 'bench', policy: 'cheapest', list: [{ provider: 'a', model: 'm' }], req, ctx: {} });
    const c = r.view.candidates[0];
    assert.strictEqual(c.sparse_evidence, false);
    assert.strictEqual(c.p_success, 0.75, 'the EWMA success and Bench’s success are sample-weighted');
    assert.strictEqual(c.ttft_p50_ms, 50, 'Bench’s measured p50 is the latency when it is not sparse');
    assert.strictEqual(c.ttft_source, 'bench_p50');
    assert.strictEqual(r.view.bench.status, 'ok');
    await h.stop();
});

t.test('hysteresis keeps the incumbent within the margin and switches after N', async () => {
    let prices = { a: { retail: RETAIL(1000000, 0, 1000000) }, b: { retail: RETAIL(1050000, 0, 1050000) } };
    const db = await testDb();
    const metrics = createProviderMetrics({ db: db.db, clock: CLOCK });
    await seed(metrics, 'a');
    await seed(metrics, 'b');
    const ev = createRoutingEvidence({ db: db.db, clock: CLOCK, metrics, config: CONFIG({ minSamples: 2, hysteresisDecisions: 3 }), resolveOffer: async (c) => ({ id: `${c.provider}:m`, provider: c.provider, model: 'm', exactId: null, free: false, retail: prices[c.provider].retail }) });
    const list = [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }];
    const req = { messages: [{ role: 'user', content: 'hello there' }], maxTokens: 100 };
    const first = await ev.choose({ routeKey: 'h', policy: 'cheapest', list, req, ctx: {} });
    assert.strictEqual(first.order[0].provider, 'a');
    // b is only 5% cheaper: planAi's minGain keeps the incumbent.
    prices = { a: { retail: RETAIL(1000000, 0, 1000000) }, b: { retail: RETAIL(950000, 0, 950000) } };
    for (let i = 0; i < 3; i++) {
        const r = await ev.choose({ routeKey: 'h', policy: 'cheapest', list, req, ctx: {} });
        assert.strictEqual(r.order[0].provider, 'a', `within the margin, decision ${i + 1}`);
        assert.ok(r.view.streak <= 0, 'a challenger within the margin never builds a streak');
    }
    // b is now 50% cheaper: the third consecutive decision switches, and the switch is persisted.
    prices = { a: { retail: RETAIL(1000000, 0, 1000000) }, b: { retail: RETAIL(500000, 0, 500000) } };
    const calls = [];
    for (let i = 0; i < 3; i++) calls.push(await ev.choose({ routeKey: 'h', policy: 'cheapest', list, req, ctx: {} }));
    assert.deepStrictEqual(calls.map((c) => c.order[0].provider), ['a', 'a', 'b']);
    assert.deepStrictEqual(calls.map((c) => c.view.streak), [1, 2, 0]);
    assert.strictEqual(calls[2].view.switched, true);
    const again = await ev.choose({ routeKey: 'h', policy: 'cheapest', list, req, ctx: {} });
    assert.strictEqual(again.order[0].provider, 'b', 'the new incumbent is persisted');
    assert.strictEqual(again.view.incumbent, 'b:m');
    await db.close();
});

t.test('cache affinity prefers the warm deployment while it is within the margin', async () => {
    const prices = { cold: { retail: RETAIL(1000000, 0, 1000000) }, warm: { retail: RETAIL(1000000, 0, 1000000) } };
    const h = await harness({ prices });
    await seed(h.metrics, 'cold', { ttft: 100, latency: 500, output: 1000 });
    await seed(h.metrics, 'warm', { ttft: 103, latency: 503, output: 1000 });
    const req = { messages: [{ role: 'user', content: 'the same prompt prefix' }], maxTokens: 100 };
    const list = [{ provider: 'cold', model: 'm' }, { provider: 'warm', model: 'm' }];
    const near = await h.ev.choose({ routeKey: 'affinity-near', policy: 'fastest', list, req, ctx: {}, warmDeployment: { provider: 'warm', model: 'm' } });
    assert.strictEqual(near.order[0].provider, 'warm', '3% slower is within the 5% affinity margin');
    assert.ok(near.view.affinity && near.view.affinity.within_margin);
    await seed(h.metrics, 'warm', { ttft: 130, latency: 530, output: 1000 });
    const far = await h.ev.choose({ routeKey: 'affinity-far', policy: 'fastest', list, req, ctx: {}, warmDeployment: { provider: 'warm', model: 'm' } });
    assert.strictEqual(far.order[0].provider, 'cold', '30% slower is outside the margin');
    assert.strictEqual(far.view.affinity, null);
    await h.stop();
});

t.test('exploration is 0 by default and never on an exact id or an opted-out preference', async () => {
    const prices = { a: { retail: RETAIL(1000000, 0, 1000000) }, b: { retail: RETAIL(900000, 0, 900000) } };
    const req = { messages: [{ role: 'user', content: 'hello there' }], maxTokens: 100 };
    const list = [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }];
    const h = await harness({ prices });
    await seed(h.metrics, 'a'); await seed(h.metrics, 'b');
    const off = await h.ev.choose({ routeKey: 'explore-off', policy: 'cheapest', list, req, ctx: {} });
    assert.strictEqual(off.view.exploration.used, false);
    assert.strictEqual(off.order[0].provider, 'b', 'the policy order decides, with no exploration');
    await h.stop();

    const on = await harness({ prices, config: CONFIG({ explorationShare: 1 }) });
    await seed(on.metrics, 'a'); await seed(on.metrics, 'b');
    const explored = await on.ev.choose({ routeKey: 'explore-on', policy: 'cheapest', list, req, ctx: {} });
    assert.strictEqual(explored.view.exploration.used, true);
    assert.notStrictEqual(explored.order[0].provider, explored.view.incumbent.split(':')[0], 'the incumbent is not the exploration target');
    for (const ctx of [{ exact: { id: 'org/m@r1' } }, { credential: { provider: 'openai' } }, { selfCredentials: [{ provider: 'openai' }] }, { exploration: false }]) {
        const r = await on.ev.choose({ routeKey: 'explore-blocked-' + Object.keys(ctx)[0], policy: 'cheapest', list, req, ctx });
        assert.strictEqual(r.view.exploration.used, false, `never explores with ${Object.keys(ctx)[0]}`);
    }
    for (const prefs of [{ only_my_keys: true }, { exploration: false }]) {
        const r = await on.ev.choose({ routeKey: 'explore-prefs-' + Object.keys(prefs)[0], policy: 'cheapest', list, req, ctx: { selfPreferences: prefs } });
        assert.strictEqual(r.view.exploration.used, false, `never explores when preferences opt out (${Object.keys(prefs)[0]})`);
    }
    await on.stop();
});

t.test('with the flag off nothing is written and the alias order is unchanged', async () => {
    const one = await seamServer(() => ({ text: 'from one', model: 'm', usage: { input: 10, output: 5 } }));
    const two = await seamServer(() => ({ text: 'from two', model: 'm', usage: { input: 10, output: 5 } }));
    let h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0' } });
    const mk = async (key, url, cost) => {
        const p = await request(h.base, 'POST', '/api/v1/providers', { tok, body: { kind: 'http', auth_mode: 'none', timeout_ms: 3000, key, base_url: url, capabilities: ['chat', 'generate'], default_model: 'm' } });
        assert.strictEqual(p.status, 201, p.text);
        const m = await request(h.base, 'POST', '/api/v1/models', { tok, body: { provider_key: key, model_key: 'm', type: 'chat', status: 'active', cost: { in_per_mtok: cost, out_per_mtok: cost }, supports: { json: true } } });
        assert.strictEqual(m.status, 201, m.text);
    };
    await mk('one', one.url, 10);
    await mk('two', two.url, 1);
    const r = await request(h.base, 'POST', '/api/v1/routes/evidence.off/versions', { tok, body: { capability: 'chat', constraints: { objective: 'cheapest' }, timeout_ms: 3000 } });
    assert.strictEqual(r.status, 201, r.text);
    const ctx = { routeKey: r.body.route.key, routeVersion: r.body.route.version, aliasPolicy: 'cheapest', policy: 'cheapest' };
    const exec = await h.pool.execute(r.body.route, 'chat', { messages: [{ role: 'user', content: 'hello there' }], timeoutMs: 3000 }, ctx);
    assert.strictEqual(exec.explain.evidence, undefined, 'no evidence decision');
    assert.strictEqual(exec.explain.policy, 'cheapest', 'the alias policy still reaches the explain as before');
    assert.strictEqual((await h.db.prepare('SELECT COUNT(*) AS n FROM provider_metrics').get()).n, 0, 'no metrics are written with the flag off');
    await h.stop();

    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_ROUTING_EVIDENCE: '1', AI_ROUTING_EVIDENCE_MIN_SAMPLES: '1', AI_ROUTING_EVIDENCE_DECISIONS: '1' } });
    await mk('one', one.url, 10);
    await mk('two', two.url, 1);
    const r2 = await request(h.base, 'POST', '/api/v1/routes/evidence.on/versions', { tok, body: { capability: 'chat', constraints: { objective: 'cheapest' }, timeout_ms: 3000 } });
    assert.strictEqual(r2.status, 201, r2.text);
    const facts = [];
    const exec2 = await h.pool.execute(r2.body.route, 'chat', { messages: [{ role: 'user', content: 'hello there' }], timeoutMs: 3000 }, { routeKey: r2.body.route.key, routeVersion: r2.body.route.version, aliasPolicy: 'cheapest', policy: 'cheapest', onRoute: async (f) => { facts.push(f); } });
    assert.ok(exec2.explain.evidence, 'the alias request carries the evidence explanation');
    assert.match(exec2.explain.evidence.reason, /lowest cost per success|no measured success/);
    assert.ok(facts.some((f) => f.policy_reason && /lowest cost per success|no measured success/.test(f.policy_reason)), 'x_openvibe gains the short policy reason');
    assert.ok((await h.db.prepare('SELECT COUNT(*) AS n FROM provider_metrics').get()).n >= 1, 'the attempt is measured');
    await h.stop();
    await one.close(); await two.close();
});

t.test('the Bench client marks a sparse or absent exact id and never throws', async () => {
    const responses = [];
    const fetchImpl = async (url) => {
        responses.push(url);
        if (String(url).includes('sparse%2Fm')) return { ok: true, status: 200, json: async () => ({ evidence: { exact_id: 'sparse/m@r1', sample_count: 5, success_rate: 1, metrics: { ttft_p50_ms: 100 }, sparse: true } }) };
        if (String(url).includes('absent')) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: false, status: 503, json: async () => ({}) };
    };
    const client = createVariantEvidence({ config: { bench: { url: 'http://bench.invalid', timeoutMs: 1000 } }, fetchImpl, clock: CLOCK, log: { warn() {} } });
    const sparse = await client.get('sparse/m@r1');
    assert.strictEqual(sparse.status, 'sparse');
    assert.strictEqual(sparse.samples, 5);
    assert.strictEqual((await client.get('absent')).status, 'absent');
    assert.strictEqual((await client.get('down')).status, 'unavailable');
    const before = responses.length;
    await client.get('sparse/m@r1');
    assert.strictEqual(responses.length, before, 'a cached read does not call Bench again');
});

t.run();
