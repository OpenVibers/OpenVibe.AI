'use strict';
// T6 step 8 (server/govern.js): tier budgets on openvibe-sdk/govern (ai-token, ai-usd; per subject and per
// project), the step-2 free allowance on the same store with the same numbers, the Billing reading from govern's
// onUsage, Valkey unreachable (paid fails closed, free keeps the quotas alone) and the flag off by default.
const assert = require('assert');
const { boot, request, token, suite, seamServer, silent, ALL } = require('./helpers');
const { testDb } = require('./db');
const { load } = require('../server/config');
const rates = require('../server/providers/rate-cards');
const { createFreeAllowance } = require('../server/free-allowance');
const { createTiers, createMeter } = require('../server/govern');
const usageSamples = require('../server/usage-samples');

const t = suite('govern-tiers');
const live = token('live', ALL);
const DAY = 86400000;
const at = (y, m, d, hh = 12) => Date.UTC(y, m - 1, d, hh);
const svc = (extra = {}) => ({ requesterType: 'service', requesterId: 'live', workflowKey: 'core.generate', ...extra });
const tiersWith = (env, clock) => createTiers({ config: load({ NODE_ENV: 'test', AI_GOVERN_TIERS: '1', ...env }), clock, log: silent });
const policy = (p) => JSON.stringify(p);
let tdb; let h; let seam;

t.test('flag off (the default): no tiers, no Valkey, admit holds nothing', async () => {
    const config = load({ NODE_ENV: 'production' });
    assert.strictEqual(config.govern.enabled, false);
    const tiers = createTiers({ config, log: silent });
    assert.strictEqual(tiers.enabled, false);
    assert.strictEqual(tiers.freeStore, null, 'the free allowance stays on PostgreSQL');
    assert.strictEqual(await tiers.admit(svc(), 'run_1'), null);
    assert.throws(() => createTiers({ config: load({ NODE_ENV: 'production', AI_GOVERN_TIERS: '1' }), log: silent }), /needs VALKEY_URL/, 'on in production without Valkey: no boot');
    assert.throws(() => load({ AI_GOVERN_TIER_MAP: 'service:live=gold' }), /AI_GOVERN_TIER_MAP/);
});

t.test('a tier budget is enforced and resets per window', async () => {
    let now = at(2026, 10, 4);
    const tiers = tiersWith({ AI_GOVERN_POLICY_JSON: policy({ 'ai-token': { free: { minute: 100 }, staff: {} } }), AI_GOVERN_HOLD_TOKENS: '60', AI_GOVERN_HOLD_USD: '0', AI_GOVERN_TIER_MAP: 'user:usr_staff=staff,service:console=staff' }, { now: () => now });
    const a = await tiers.admit(svc(), 'run_a');
    await tiers.settle(a, { tokens: 60, usd: 0 });
    await assert.rejects(tiers.admit(svc(), 'run_b'), (e) => {
        assert.strictEqual(e.status, 429);
        assert.strictEqual(e.code, 'govern.exceeded');
        assert.deepStrictEqual([e.extra.govern.tier, e.extra.govern.unit, e.extra.govern.window, e.extra.govern.limit, e.extra.govern.used], ['free', 'ai-token', 'minute', 100, 60]);
        assert.ok(e.extra.retry_after_seconds >= 1 && e.extra.retry_after_seconds <= 60);
        return true;
    });
    // Staff (here a staff subject in a staff project) is unlimited.
    for (const id of ['run_s1', 'run_s2', 'run_s3']) await tiers.settle(await tiers.admit(svc({ requesterId: 'console', actorKey: 'user:usr_staff' }), id), { tokens: 60 });
    now += 60000;
    const d = await tiers.admit(svc(), 'run_d');
    assert.ok(d && d.ids['ai-token'].length === 2, 'a new minute: admitted again');
    await tiers.release(d);
});

t.test('per subject and per project: the project budget counts every subject of the project', async () => {
    const tiers = tiersWith({ AI_GOVERN_POLICY_JSON: policy({ 'ai-usd': { free: { day: 1 }, paid: { day: 0.1 } } }), AI_GOVERN_HOLD_TOKENS: '0', AI_GOVERN_HOLD_USD: '0.06', AI_GOVERN_TIER_MAP: 'service:live=paid' }, { now: () => at(2026, 10, 4) });
    // A subject of a paid project is on the paid tier too, unless mapped: 0.1 a day for the subject and for the project.
    await tiers.settle(await tiers.admit(svc({ attributionKey: 'live:user:1' }), 'run_p1'), { usd: 0.05 });
    // user:2's own budget has room for the 0.06 hold; the project's (0.05 spent) does not.
    await assert.rejects(tiers.admit(svc({ attributionKey: 'live:user:2' }), 'run_p2'), (e) => e.code === 'govern.exceeded' && e.extra.govern.scope === 'project' && e.extra.govern.tier === 'paid');
    await tiers.release(await tiers.admit(svc({ attributionKey: 'live:user:2', requesterId: 'blog' }), 'run_p3'));   // another project
});

t.test('two concurrent runs cannot both spend the last unit', async () => {
    const tiers = tiersWith({ AI_GOVERN_POLICY_JSON: policy({ 'ai-token': { free: { day: 100 } } }), AI_GOVERN_HOLD_TOKENS: '50', AI_GOVERN_HOLD_USD: '0' }, { now: () => at(2026, 10, 4) });
    await tiers.settle(await tiers.admit(svc(), 'run_first'), { tokens: 50 });
    const got = await Promise.allSettled([tiers.admit(svc(), 'run_x'), tiers.admit(svc(), 'run_y')]);
    assert.deepStrictEqual(got.map((g) => g.status).sort(), ['fulfilled', 'rejected']);
    assert.strictEqual(got.find((g) => g.status === 'rejected').reason.code, 'govern.exceeded');
    // A released hold gives the unit back.
    await tiers.release(got.find((g) => g.status === 'fulfilled').value);
    await tiers.release(await tiers.admit(svc(), 'run_z'));
});

t.test('Valkey unreachable: a paid run is refused (503), an all-free run is admitted on the quotas alone, nothing is free', async () => {
    const down = { on() {}, defineCommand(name) { this[name] = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379')); }, async quit() {}, disconnect() {} };
    const valkey = require('openvibe-sdk/valkey').createValkey({ client: down, log: silent });
    const config = load({ NODE_ENV: 'production', AI_GOVERN_TIERS: '1', AI_GOVERN_TIER_MAP: 'live:user:9=paid' });
    const tiers = createTiers({ config, valkey, log: silent });
    await assert.rejects(tiers.admit(svc({ attributionKey: 'live:user:9' }), 'run_paid'), (e) => e.status === 503 && e.code === 'govern.unavailable');
    assert.strictEqual(await tiers.admit(svc({ attributionKey: 'live:user:1' }), 'run_free'), null);
    assert.deepStrictEqual(await tiers.freeStore.claim('k', 50, 100, 0, 0, Date.now()), { free: 0, used: null });
});

// ── The step-2 free-allowance numbers, on the govern store (test/free-allowance.test.js, same assertions) ──
const cardsWith = (terms) => async (provider, model) => rates.buildCards({ providerKey: provider, model, pricing: { table: { default: { in: 1, cached: 0.5, out: 2, ...terms } }, inputPerMtok: 0, outputPerMtok: 0 } });
const usedRows = async () => (await tdb.db.prepare('SELECT subject, provider, metric, period_start, period_end, free_used FROM free_allowance_usage ORDER BY subject, metric, period_start').all())
    .map((r) => ({ ...r, period_start: Number(r.period_start), period_end: Number(r.period_end), free_used: Number(r.free_used) }));
const onStore = (terms) => createFreeAllowance(tdb.db, { cardsFor: cardsWith(terms), store: tiersWith({}).freeStore });

t.test('a migrated database', async () => { tdb = await testDb(); });

t.test('on the store: free up to the allowance per metric, then fully priced; the period is kept', async () => {
    const fa = onStore({ free_allowance: 100, reset_period: 'day' });
    const now = at(2026, 10, 4);
    let c = await fa.claim('s1', 'p', 'm', { in: 60, out: 30 }, now);
    assert.strictEqual(c.tokens, 90);
    assert.ok(Math.abs(c.usd - (60 * 1 + 30 * 2) / 1e6) < 1e-12, `usd ${c.usd}`);
    assert.strictEqual((await fa.claim('s1', 'p', 'm', { in: 60, out: 30 }, now + 1000)).tokens, 40 + 30);
    assert.strictEqual((await fa.claim('s1', 'p', 'm', { in: 60, cached: 10, out: 100 }, now + 2000)).tokens, 10 + 40);
    const exhausted = await fa.claim('s1', 'p', 'm', { in: 60, out: 60 }, now + 3000);
    assert.deepStrictEqual([exhausted.tokens, exhausted.usd], [0, 0], 'fully priced once exhausted');
    const rows = await usedRows();
    assert.deepStrictEqual(rows.map((r) => [r.metric, r.free_used]), [['cached-input-tokens:m', 10], ['input-tokens:m', 100], ['output-tokens:m', 100]]);
    for (const r of rows) assert.deepStrictEqual([r.period_start, r.period_end], [Date.UTC(2026, 9, 4), Date.UTC(2026, 9, 5)]);
});

t.test('on the store: day and month reset at their boundary, none never resets', async () => {
    await tdb.db.prepare('DELETE FROM free_allowance_usage').run();
    const day = onStore({ free_allowance: 100, reset_period: 'day' });
    assert.strictEqual((await day.claim('s1', 'p', 'm', { in: 500 }, Date.UTC(2026, 9, 4, 23, 59, 59))).tokens, 100);
    assert.strictEqual((await day.claim('s1', 'p', 'm', { in: 500 }, Date.UTC(2026, 9, 4, 23, 59, 59, 999))).tokens, 0);
    assert.strictEqual((await day.claim('s1', 'p', 'm', { in: 500 }, Date.UTC(2026, 9, 5))).tokens, 100);
    const month = onStore({ free_allowance: 100, reset_period: 'month' });
    assert.strictEqual((await month.claim('s2', 'p', 'm', { in: 500 }, at(2026, 10, 1))).tokens, 100);
    assert.strictEqual((await month.claim('s2', 'p', 'm', { in: 500 }, Date.UTC(2026, 9, 31, 23, 59))).tokens, 0);
    assert.strictEqual((await month.claim('s2', 'p', 'm', { in: 500 }, Date.UTC(2026, 10, 1))).tokens, 100);
    const none = onStore({ free_allowance: 100, reset_period: 'none' });
    assert.strictEqual((await none.claim('s3', 'p', 'm', { in: 500 }, at(2026, 10, 4))).tokens, 100);
    assert.strictEqual((await none.claim('s3', 'p', 'm', { in: 500 }, at(2026, 10, 5))).tokens, 0);
    assert.strictEqual((await none.claim('s3', 'p', 'm', { in: 500 }, at(2026, 10, 4) + 800 * DAY)).tokens, 0);
    const terms = onStore({ free_allowance: 100, reset_period: 'none', effective_from: '2027-01-01' });
    assert.strictEqual((await terms.claim('s3', 'p', 'm', { in: 500 }, at(2027, 1, 2))).tokens, 100);
});

t.test('on the store: a lost counter restarts from PostgreSQL, never from zero', async () => {
    const fresh = onStore({ free_allowance: 100, reset_period: 'month' });   // a new store: as if Valkey lost its keys
    assert.strictEqual((await fresh.claim('s2', 'p', 'm', { in: 500 }, Date.UTC(2026, 9, 20))).tokens, 0);
});

t.test('on the store: concurrent claims never exceed the cap in total', async () => {
    await tdb.db.prepare('DELETE FROM free_allowance_usage').run();
    const fa = onStore({ free_allowance: 100, reset_period: 'month' });
    const got = await Promise.all(Array.from({ length: 12 }, () => tdb.db.tx(async () => (await fa.claim('s1', 'p', 'm', { in: 30, out: 30 }, at(2026, 10, 4))).tokens)));
    assert.strictEqual(got.reduce((a, b) => a + b, 0), 200, `claims ${got.join(',')}`);
    assert.deepStrictEqual((await usedRows()).map((r) => r.free_used), [100, 100]);
    await tdb.close();
});

t.test('the meter: one onUsage record per idempotency key at once', async () => {
    const reading = createMeter();
    const got = await Promise.all([reading({ subject: 'service:live', quantity: 5, key: 'ai:run_m:tokens' }), reading({ subject: 'service:live', quantity: 5, key: 'ai:run_m:tokens' })]);
    assert.strictEqual(got.filter(Boolean).length, 1);
    assert.deepStrictEqual([got.find(Boolean).idempotency_key, got.find(Boolean).amount, got.find(Boolean).subject], ['ai:run_m:tokens', 5, 'service:live']);
});

// On the containers' Valkey (OV_TEST_VALKEY_URL, set by openvibe-sdk/scripts/test-services.sh): govern's Lua and the
// free-allowance claim, atomic across concurrent callers. Without it (a plain `ov test`) this passes as skipped.
t.test('on Valkey: the tier budget and the free allowance hold under concurrent callers', async () => {
    if (!process.env.OV_TEST_VALKEY_URL) { console.log('    (skipped: no OV_TEST_VALKEY_URL)'); return; }
    const valkey = require('openvibe-sdk/valkey').createValkey({ url: process.env.OV_TEST_VALKEY_URL, prefix: `ov:ai-test:${Math.random().toString(36).slice(2)}:`, log: silent });
    const vdb = await testDb();
    try {
        const config = load({ NODE_ENV: 'test', AI_GOVERN_TIERS: '1', AI_GOVERN_POLICY_JSON: policy({ 'ai-token': { free: { day: 100 } } }), AI_GOVERN_HOLD_TOKENS: '50', AI_GOVERN_HOLD_USD: '0' });
        const tiers = createTiers({ config, valkey, log: silent });
        await tiers.settle(await tiers.admit(svc(), 'run_v1'), { tokens: 50 });
        const got = await Promise.allSettled([tiers.admit(svc(), 'run_v2'), tiers.admit(svc(), 'run_v3')]);
        assert.deepStrictEqual(got.map((g) => g.status).sort(), ['fulfilled', 'rejected']);
        await tiers.release(got.find((g) => g.status === 'fulfilled').value);
        const fa = createFreeAllowance(vdb.db, { cardsFor: cardsWith({ free_allowance: 100, reset_period: 'day' }), store: tiers.freeStore });
        const now = Date.now();
        const claimed = await Promise.all(Array.from({ length: 12 }, () => vdb.db.tx(async () => (await fa.claim('s1', 'p', 'm', { in: 30, out: 30 }, now)).tokens)));
        assert.strictEqual(claimed.reduce((x, y) => x + y, 0), 200, `claims ${claimed.join(',')}`);
        const rows = await vdb.db.prepare('SELECT metric, free_used, period_start FROM free_allowance_usage ORDER BY metric').all();
        assert.deepStrictEqual(rows.map((r) => [r.metric, Number(r.free_used)]), [['input-tokens:m', 100], ['output-tokens:m', 100]]);
        const ttl = await valkey.client.pttl(valkey.key('gov', 'free', `s1|p|input-tokens:m|${Number(rows[0].period_start)}`));
        assert.ok(ttl > 86400000 && ttl <= 2 * 86400000, `the counter expires a day after its period: ${ttl} ms`);
    } finally { await vdb.close(); await valkey.close(); }
});

// ── End to end with the flag on (no VALKEY_URL in tests: the store is in this process) ──
const readings = async () => (await h.db.prepare('SELECT envelope FROM usage_sample_outbox ORDER BY id').all())
    .map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope));
const gen = async () => await request(h.base, 'POST', '/api/v1/generate', { tok: live, body: { prompt: `p${Math.random()}`, options: { cache: false } } });

t.test('boot with AI_GOVERN_TIERS=1 and a seam model with a free allowance of 100 tokens a day', async () => {
    seam = await seamServer(() => ({ text: 'ok', usage: { input: 1000, output: 1000 } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_GOVERN_TIERS: '1', AI_GOVERN_POLICY_JSON: policy({ 'ai-token': { free: { day: 5000 } } }), AI_GOVERN_HOLD_TOKENS: '1000' } });
    assert.strictEqual(h.tiers.enabled, true);
    await request(h.base, 'POST', '/api/v1/providers', { tok: live, body: { key: 'seam', kind: 'http', base_url: seam.url, auth_mode: 'none', capabilities: ['generate', 'chat'] } });
    let r = await request(h.base, 'POST', '/api/v1/models', { tok: live, body: { provider_key: 'seam', model_key: 'm1', cost: { in_per_mtok: 1000, out_per_mtok: 1000, free_allowance: 100, reset_period: 'day' } } });
    assert.ok(r.status < 300, r.text);
    r = await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: live, body: { primary: { provider: 'seam', model: 'm1' }, fallbacks: [] } });
    assert.strictEqual(r.status, 201, r.text);
});

t.test('the readings carry step 2\'s numbers and come one per attempt per metric', async () => {
    assert.strictEqual((await gen()).status, 201);
    assert.strictEqual((await gen()).status, 201);
    const runs = await h.db.prepare('SELECT id FROM runs ORDER BY created_at, id').all();
    const all = await readings();
    const byKind = (id) => Object.fromEntries(all.filter((x) => x.idempotency_key.startsWith(`ai:${id}:0:`)).map((x) => [x.idempotency_key.split(':')[3], x]));
    const a = byKind(runs[0].id); const b = byKind(runs[1].id);
    assert.deepStrictEqual(Object.keys(a).sort(), ['cached', 'in', 'out'], 'one reading per metric');
    assert.deepStrictEqual([a.in.free_allowance_used, a.out.free_allowance_used], [100, 100]);
    assert.ok(Math.abs(a.in.cost_estimate - 0.9) < 1e-9 && Math.abs(a.out.cost_estimate - 0.9) < 1e-9, `${a.in.cost_estimate}, ${a.out.cost_estimate}`);
    assert.ok(!('free_allowance_used' in b.in) && !('free_allowance_used' in b.out));
    assert.ok(Math.abs(b.in.cost_estimate - 1) < 1e-9 && Math.abs(b.out.cost_estimate - 1) < 1e-9, `${b.in.cost_estimate}, ${b.out.cost_estimate}`);
    const rows = await h.quotas.freeAllowance.current();
    assert.deepStrictEqual(rows.map((r) => [r.metric, r.free_used, r.remaining]), [['input-tokens:m1', 100, 0], ['output-tokens:m1', 100, 0]]);
});

t.test('a run whose hold no longer fits is refused before the provider; reserve() did not count it', async () => {
    const counted = async () => Number((await h.db.prepare("SELECT requests FROM usage_counters WHERE scope_type = 'service' AND scope_id = 'live' AND \"window\" = 'day' AND workflow_prefix = ''").get()).requests);
    const before = await counted();
    const r = await gen();   // 4000 used + a 1000 hold = 5000: admitted; it spends 2000, so the next hold does not fit
    assert.strictEqual(r.status, 201, r.text);
    const calls = seam.calls;
    const no = await gen();
    assert.deepStrictEqual([no.status, no.body.code], [429, 'govern.exceeded'], no.text);
    assert.strictEqual(seam.calls, calls, 'no provider call');
    assert.strictEqual(await counted(), before + 1, 'the refused run is not counted');
    assert.strictEqual((await readings()).length, 9, 'three runs, one reading per attempt per metric');
});

t.test('shutdown', async () => { usageSamples._reset(); await h.stop(); await seam.close(); });

t.run();
