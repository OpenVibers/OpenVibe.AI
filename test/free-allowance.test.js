'use strict';
// §2.1.8 bounded free allowance (server/free-allowance.js): a subject's tokens use the provider's free_allowance
// first, per metric and reset period; the free share is reported as free_allowance_used on the run's
// platform.usage-sample@1 and is never priced on its cost_estimate. Pricing only: no call is refused for it.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');
const { testDb } = require('./db');
const rates = require('../server/providers/rate-cards');
const { createFreeAllowance, subjectOf } = require('../server/free-allowance');

const t = suite('free-allowance');
const live = token('live', ALL);
const usageSamples = require('../server/usage-samples');
let tdb;
let h;
let seam;

const DAY = 86400000;
const at = (y, m, d, hh = 12) => Date.UTC(y, m - 1, d, hh);
// One provider's cards from an AI_PRICING_JSON default entry: in 1, cached 0.5, out 2 USD per million tokens.
const cardsWith = (terms) => async (provider, model) => rates.buildCards({ providerKey: provider, model, pricing: { table: { default: { in: 1, cached: 0.5, out: 2, ...terms } }, inputPerMtok: 0, outputPerMtok: 0 } });
const usedRows = async () => (await tdb.db.prepare('SELECT subject, provider, metric, period_start, period_end, free_used FROM free_allowance_usage ORDER BY subject, metric, period_start').all())
    .map((r) => ({ ...r, period_start: Number(r.period_start), period_end: Number(r.period_end), free_used: Number(r.free_used) }));
const clear = async () => { await tdb.db.prepare('DELETE FROM free_allowance_usage').run(); };
// claim() also returns byKind (per metric, for the readings); the aggregate is what these totals assert.
const agg = (c) => ({ tokens: c.tokens, usd: c.usd });

t.test('a migrated database', async () => { tdb = await testDb(); });

t.test('the subject is the attribution, else the actor, else the requester; none → nothing free', async () => {
    assert.strictEqual(subjectOf({ attributionKey: 'live:user:42', actorKey: 'user:usr_1', requesterType: 'service', requesterId: 'live' }), 'live:user:42');
    assert.strictEqual(subjectOf({ actorKey: 'user:usr_1', requesterType: 'service', requesterId: 'live' }), 'user:usr_1');
    assert.strictEqual(subjectOf({ requesterType: 'service', requesterId: 'live' }), 'service:live');
    assert.strictEqual(subjectOf({}), null);
    const fa = createFreeAllowance(tdb.db, { cardsFor: cardsWith({ free_allowance: 100, reset_period: 'day' }) });
    assert.deepStrictEqual(agg(await fa.claim(null, 'p', 'm', { in: 50 }, at(2026, 10, 4))), { tokens: 0, usd: 0 });
    assert.deepStrictEqual(await usedRows(), []);
});

t.test('free up to the allowance per metric, then fully priced; the real period is stored', async () => {
    await clear();
    const fa = createFreeAllowance(tdb.db, { cardsFor: cardsWith({ free_allowance: 100, reset_period: 'day' }) });
    const now = at(2026, 10, 4);
    let c = await fa.claim('s1', 'p', 'm', { in: 60, out: 30 }, now);
    assert.strictEqual(c.tokens, 90);
    assert.ok(Math.abs(c.usd - (60 * 1 + 30 * 2) / 1e6) < 1e-12, `usd ${c.usd}`);
    c = await fa.claim('s1', 'p', 'm', { in: 60, out: 30 }, now + 1000);
    assert.strictEqual(c.tokens, 40 + 30, 'input: the 40 left; output: 30 of the 70 left');
    c = await fa.claim('s1', 'p', 'm', { in: 60, cached: 10, out: 100 }, now + 2000);
    assert.strictEqual(c.tokens, 10 + 40, 'input exhausted; cached has its own 100; output the 40 left');
    c = await fa.claim('s1', 'p', 'm', { in: 60, out: 60 }, now + 3000);
    assert.deepStrictEqual(agg(c), { tokens: 0, usd: 0 }, 'fully priced once exhausted');
    assert.ok(Math.abs(c.byKind.in.cost - 60 / 1e6) < 1e-15 && Math.abs(c.byKind.out.cost - 120 / 1e6) < 1e-15 && c.byKind.cached.cost === 0, 'byKind carries each metric\'s list cost even when nothing is free');
    const rows = await usedRows();
    assert.deepStrictEqual(rows.map((r) => [r.metric, r.free_used]), [['cached-input-tokens:m', 10], ['input-tokens:m', 100], ['output-tokens:m', 100]]);
    for (const r of rows) assert.deepStrictEqual([r.period_start, r.period_end], [Date.UTC(2026, 9, 4), Date.UTC(2026, 9, 5)]);
});

t.test('the counter resets at the period boundary: day and month; none never resets', async () => {
    await clear();
    const day = createFreeAllowance(tdb.db, { cardsFor: cardsWith({ free_allowance: 100, reset_period: 'day' }) });
    assert.strictEqual((await day.claim('s1', 'p', 'm', { in: 500 }, Date.UTC(2026, 9, 4, 23, 59, 59))).tokens, 100);
    assert.strictEqual((await day.claim('s1', 'p', 'm', { in: 500 }, Date.UTC(2026, 9, 4, 23, 59, 59, 999))).tokens, 0);
    assert.strictEqual((await day.claim('s1', 'p', 'm', { in: 500 }, Date.UTC(2026, 9, 5))).tokens, 100, 'a new UTC day');

    const month = createFreeAllowance(tdb.db, { cardsFor: cardsWith({ free_allowance: 100, reset_period: 'month' }) });
    assert.strictEqual((await month.claim('s2', 'p', 'm', { in: 500 }, at(2026, 10, 1))).tokens, 100);
    assert.strictEqual((await month.claim('s2', 'p', 'm', { in: 500 }, Date.UTC(2026, 9, 31, 23, 59))).tokens, 0, 'same month');
    assert.strictEqual((await month.claim('s2', 'p', 'm', { in: 500 }, Date.UTC(2026, 10, 1))).tokens, 100, 'a new UTC month');
    const m = (await usedRows()).filter((r) => r.subject === 's2').map((r) => [r.period_start, r.period_end]);
    assert.deepStrictEqual(m, [[Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1)], [Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1)]]);

    const none = createFreeAllowance(tdb.db, { cardsFor: cardsWith({ free_allowance: 100, reset_period: 'none' }) });
    assert.strictEqual((await none.claim('s3', 'p', 'm', { in: 500 }, at(2026, 10, 4))).tokens, 100);
    assert.strictEqual((await none.claim('s3', 'p', 'm', { in: 500 }, at(2026, 10, 5))).tokens, 0, 'not the next day');
    assert.strictEqual((await none.claim('s3', 'p', 'm', { in: 500 }, at(2026, 10, 4) + 800 * DAY)).tokens, 0, 'not past the usage lookback either');
    const terms = createFreeAllowance(tdb.db, { cardsFor: cardsWith({ free_allowance: 100, reset_period: 'none', effective_from: '2027-01-01' }) });
    assert.strictEqual((await terms.claim('s3', 'p', 'm', { in: 500 }, at(2027, 1, 2))).tokens, 100, 'a card with new terms is a new allowance');
});

t.test('free_allowance 0 (the default) claims nothing and writes nothing', async () => {
    await clear();
    const fa = createFreeAllowance(tdb.db, { cardsFor: cardsWith({}) });
    assert.deepStrictEqual(agg(await fa.claim('s1', 'p', 'm', { in: 100, cached: 10, out: 100 }, at(2026, 10, 4))), { tokens: 0, usd: 0 });
    const unbilled = createFreeAllowance(tdb.db, { cardsFor: async () => null });
    assert.deepStrictEqual(agg(await unbilled.claim('s1', 'p', 'm', { in: 100 }, at(2026, 10, 4))), { tokens: 0, usd: 0 });
    assert.deepStrictEqual(await usedRows(), []);
});

t.test('two subjects never share an allowance', async () => {
    await clear();
    const fa = createFreeAllowance(tdb.db, { cardsFor: cardsWith({ free_allowance: 100, reset_period: 'month' }) });
    const now = at(2026, 10, 4);
    assert.strictEqual((await fa.claim('live:user:1', 'p', 'm', { out: 150 }, now)).tokens, 100);
    assert.strictEqual((await fa.claim('live:user:2', 'p', 'm', { out: 150 }, now)).tokens, 100);
    assert.strictEqual((await fa.claim('live:user:1', 'p', 'm', { out: 150 }, now)).tokens, 0);
    assert.strictEqual((await fa.claim('live:user:1', 'other', 'm', { out: 150 }, now)).tokens, 100, 'nor two providers');
});

t.test('concurrent claims never exceed the cap in total', async () => {
    await clear();
    const fa = createFreeAllowance(tdb.db, { cardsFor: cardsWith({ free_allowance: 100, reset_period: 'month' }) });
    const now = at(2026, 10, 4);
    // Each claim in its own transaction (as account() makes it), all at once: on PostgreSQL they race for the row.
    const got = await Promise.all(Array.from({ length: 12 }, () => tdb.db.tx(async () => (await fa.claim('s1', 'p', 'm', { in: 30, out: 30 }, now)).tokens)));
    assert.strictEqual(got.reduce((a, b) => a + b, 0), 200, `claims ${got.join(',')}`);
    assert.deepStrictEqual((await usedRows()).map((r) => r.free_used), [100, 100]);
    await tdb.close();
});

// End to end: a run's reading carries free_allowance_used, and its cost_estimate leaves the free share out.
const env = { AI_STUB_FALLBACK: 'false' };
const readings = async () => (await h.db.prepare('SELECT envelope FROM usage_sample_outbox ORDER BY id').all())
    .map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope));
const gen = async () => await request(h.base, 'POST', '/api/v1/generate', { tok: live, body: { prompt: `p${Math.random()}`, options: { cache: false } } });

t.test('boot with a seam provider whose model has a free allowance of 100 tokens a day', async () => {
    seam = await seamServer(() => ({ text: 'ok', usage: { input: 1000, output: 1000 } }));
    h = await boot({ env });
    await request(h.base, 'POST', '/api/v1/providers', { tok: live, body: { key: 'seam', kind: 'http', base_url: seam.url, auth_mode: 'none', capabilities: ['generate', 'chat'] } });
    let r = await request(h.base, 'POST', '/api/v1/models', { tok: live, body: { provider_key: 'seam', model_key: 'm1', cost: { in_per_mtok: 1000, out_per_mtok: 1000, free_allowance: 100, reset_period: 'day' } } });
    assert.ok(r.status < 300, r.text);
    r = await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: live, body: { primary: { provider: 'seam', model: 'm1' }, fallbacks: [] } });
    assert.strictEqual(r.status, 201, r.text);
});

t.test('the first run is free up to the allowance per metric, the next one is fully priced', async () => {
    assert.strictEqual((await gen()).status, 201);
    assert.strictEqual((await gen()).status, 201);
    const all = await readings();
    for (const s of all) assert.ok(contracts.validate('platform.usage-sample@1', s).valid, JSON.stringify(s));
    const runs = await h.db.prepare('SELECT id FROM runs ORDER BY created_at, id').all();
    const byKind = (s) => Object.fromEntries(all.filter((x) => x.idempotency_key.startsWith(`ai:${s}:0:`)).map((x) => [x.idempotency_key.split(':')[3], x]));
    const a = byKind(runs[0].id); const b = byKind(runs[1].id);
    assert.deepStrictEqual([a.in.quantity, a.cached.quantity, a.out.quantity], [1000, 0, 1000], 'one reading per kind');
    assert.deepStrictEqual([a.in.free_allowance_used, a.out.free_allowance_used], [100, 100], '100 input + 100 output tokens free, each on its own reading');
    assert.ok(!('free_allowance_used' in a.cached), 'the cached metric was fully free of charge');
    assert.ok(Math.abs(a.in.cost_estimate - 0.9) < 1e-9 && Math.abs(a.out.cost_estimate - 0.9) < 1e-9, `the free share is not priced: ${a.in.cost_estimate}, ${a.out.cost_estimate}`);
    for (const s of [b.in, b.cached, b.out]) assert.ok(!('free_allowance_used' in s), 'nothing free: the field is absent');
    assert.ok(Math.abs(b.in.cost_estimate - 1) < 1e-9 && Math.abs(b.out.cost_estimate - 1) < 1e-9, `fully priced: ${b.in.cost_estimate}, ${b.out.cost_estimate}`);
    const rows = await h.quotas.freeAllowance.current();
    assert.deepStrictEqual(rows.map((r) => [r.subject, r.provider, r.metric, r.free_used, r.free_allowance, r.remaining]),
        [['service:live', 'seam', 'input-tokens:m1', 100, 100, 0], ['service:live', 'seam', 'output-tokens:m1', 100, 100, 0]]);
    // Pricing, never admission: the run cost and the request counters are what they always were.
    const run = await h.db.prepare('SELECT cost_usd FROM runs ORDER BY created_at DESC LIMIT 1').get();
    assert.ok(Math.abs(Number(run.cost_usd) - 2) < 1e-9);
});

t.test('explain shows the free share on the first run\'s readings and leaves it out on the next', async () => {
    const [first, next] = await h.db.prepare('SELECT id FROM runs ORDER BY created_at, id').all();
    const explain = async (id) => Object.fromEntries((await request(h.base, 'GET', `/api/v1/runs/${id}`, { tok: live })).body.run.explain.usage_readings.map((u) => [u.idempotency_key.split(':')[3], u]));
    const a = await explain(first.id);
    assert.deepStrictEqual([a.in.idempotency_key, a.in.state, a.in.free_allowance_used], [`ai:${first.id}:0:in`, 'queued', 100]);
    assert.strictEqual(a.out.free_allowance_used, 100);
    assert.ok(!('free_allowance_used' in (await explain(next.id)).in));
});

t.test('shutdown', async () => { usageSamples._reset(); await h.stop(); await seam.close(); });

t.run();
