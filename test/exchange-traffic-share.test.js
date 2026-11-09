'use strict';

// Stage B8: the weekly real-traffic share from Exchange receipts. Aggregate only, k >= 20 per cell,
// opt-outs respected, stored once per completed week. The tests replay a small week into a real
// database; no test calls a provider.
const assert = require('assert');
const { boot, request, suite } = require('./helpers');
const { aggregateWeek, mondayOf, lastCompleteWeek, categoryOf } = require('../server/exchange/share');

const DAY_MS = 86400000;
const t = suite('exchange-traffic-share');
let h;

let seq = 0;
const uid = (p) => `${p}_${Date.now()}_${seq++}`;
const iso = (ms) => new Date(ms).toISOString();

async function insertRun({ id, type, requester, provider, model, created, history = true, status = 'succeeded', synthetic = 0 }) {
    await h.db.prepare(`INSERT INTO runs (id, workflow_key, workflow_version, status, requester_type, requester_id, input, input_hash,
            provider_key, model_key, synthetic, options, created_at, started_at, finished_at)
        VALUES (?, 'ai.chat', 1, ?, ?, ?, '{}', 'input-hash', ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, status, type, requester, provider, model, synthetic, JSON.stringify({ history }), created, created, created);
}
async function insertReceipt({ runId, type, requester, provider, model, created, tokensIn = 100, tokensOut = 10 }) {
    const body = {
        id: `rcpt_${runId}`,
        run_id: runId,
        created_at: created,
        offer: { provider, model },
        usage: { tokens_in: tokensIn, tokens_out: tokensOut },
    };
    await h.db.prepare(`INSERT INTO ai_receipts (id, run_id, requester_type, requester_id, body, created_at)
        VALUES (?, ?, ?, ?, ?::jsonb, ?)`)
        .run(body.id, runId, type, requester, JSON.stringify(body), created);
}

let weekStart;
async function addTraffic({ type, requester, provider, model, count, history = true, status = 'succeeded', tokensIn = 100, tokensOut = 10 }) {
    for (let i = 0; i < count; i++) {
        const id = uid('run');
        const created = iso(weekStart + (i % 4) * 6 * 3600000);
        await insertRun({ id, type, requester, provider, model, created, history, status });
        await insertReceipt({ runId: id, type, requester, provider, model, created, tokensIn, tokensOut });
    }
}

t.test('aggregateWeek publishes only cells with k requests and folds apps into one category', () => {
    const rows = [
        { requester_type: 'service', requester_id: 'live', provider: 'deepseek', model: 'deepseek-chat', requests: 25, tokens_in: 2500, tokens_out: 250 },
        { requester_type: 'service', requester_id: 'live', provider: 'qwen', model: 'qwen2.5', requests: 5, tokens_in: 500, tokens_out: 50 },
        { requester_type: 'app', requester_id: 'prj_PRIVATE', provider: 'deepseek', model: 'deepseek-chat', requests: 20, tokens_in: 2000, tokens_out: 200 },
        { requester_type: 'service', requester_id: 'codes', provider: 'acme', model: 'acme-1', requests: 2, tokens_in: 200, tokens_out: 20 },
    ];
    const out = aggregateWeek({ rows, weekStart: Date.parse('2026-11-09T00:00:00Z'), k: 20 });
    assert.strictEqual(out.week_start, '2026-11-09');
    assert.strictEqual(out.week_end, '2026-11-16');
    assert.strictEqual(out.totals.requests, 45, 'only the published cells count');
    assert.strictEqual(out.categories.length, 2);
    assert.strictEqual(out.categories[0].category, 'live');
    assert.strictEqual(out.categories.find((c) => c.category === 'apps').requests, 20, 'every app is one category');
    assert.strictEqual(out.offers.length, 1, 'only the published provider/model cell remains');
    assert.strictEqual(out.withheld.cells, 2, 'the small service cells are withheld');
    assert.strictEqual(out.withheld.requests, 7);
    const share = out.categories.reduce((n, c) => n + c.request_share, 0);
    assert(Math.abs(share - 1) < 1e-9, 'published category shares add to one');
    assert(!JSON.stringify(out).includes('prj_PRIVATE'), 'no project or app id is published');
    assert.strictEqual(categoryOf({ requester_type: 'service', requester_id: 'live' }), 'live');
});

t.test('boot', async () => {
    h = await boot();
    const now = Date.now();
    weekStart = lastCompleteWeek(now);
    assert.strictEqual(mondayOf(weekStart), weekStart);
});

t.test('a completed week is stored once and the read is public and cached', async () => {
    await addTraffic({ type: 'service', requester: 'live', provider: 'deepseek', model: 'deepseek-chat', count: 25 });
    await addTraffic({ type: 'app', requester: 'prj_SECRET_APP', provider: 'deepseek', model: 'deepseek-chat', count: 20 });
    await addTraffic({ type: 'service', requester: 'codes', provider: 'acme', model: 'acme-1', count: 10 });
    // Opted out and failed traffic must not be in any number, not even the withheld total.
    await addTraffic({ type: 'service', requester: 'live', provider: 'deepseek', model: 'deepseek-chat', count: 7, history: false });
    await addTraffic({ type: 'service', requester: 'live', provider: 'deepseek', model: 'deepseek-chat', count: 4, status: 'failed' });

    const first = await request(h.base, 'GET', '/api/v1/exchange/share');
    assert.strictEqual(first.status, 200, first.text);
    assert.strictEqual(first.headers.get('cache-control'), 'public, max-age=300');
    const body = first.body;
    assert.strictEqual(body.$schema, 'exchange.traffic-share@1');
    assert.strictEqual(body.week_start, iso(weekStart).slice(0, 10));
    assert(body.k >= 20);
    assert.strictEqual(body.totals.requests, 45, 'opt-outs and failures are excluded');
    assert.strictEqual(body.withheld.cells, 1);
    assert.strictEqual(body.withheld.requests, 10);
    assert.deepStrictEqual(body.categories.map((c) => c.category).sort(), ['apps', 'live']);
    assert.strictEqual(body.offers.find((o) => o.provider === 'deepseek').requests, 45);
    assert(!/prj_SECRET_APP/.test(first.text), 'no developer app is named');
    assert(!/run_|rcpt_|usr_/.test(first.text), 'no run, receipt or person id leaves the read');
    assert.strictEqual(body.offers.every((o) => o.request_share > 0 && o.request_share <= 1), true);

    const second = await request(h.base, 'GET', '/api/v1/exchange/share');
    assert(second.body.recomputed_at === null);
    assert.strictEqual((await h.db.prepare('SELECT COUNT(*)::int AS n FROM exchange_traffic_share').get()).n, 1, 'the week is stored once, not recomputed on every read');
});

t.test('a named week is validated and old receipts are not a silent empty week', async () => {
    const day = iso(weekStart).slice(0, 10);
    const stored = await request(h.base, 'GET', `/api/v1/exchange/share?week=${day}`);
    assert.strictEqual(stored.status, 200, stored.text);
    assert.strictEqual(stored.body.week_start, day);
    const tuesday = iso(weekStart + DAY_MS).slice(0, 10);
    assert.strictEqual((await request(h.base, 'GET', `/api/v1/exchange/share?week=${tuesday}`)).status, 422);
    const nextMonday = iso(mondayOf(Date.now())).slice(0, 10);
    assert.strictEqual((await request(h.base, 'GET', `/api/v1/exchange/share?week=${nextMonday}`)).status, 422);
    const old = iso(weekStart - 42 * DAY_MS).slice(0, 10);
    assert.strictEqual((await request(h.base, 'GET', `/api/v1/exchange/share?week=${old}`)).status, 404);
});

(async () => {
    try {
        await t.run();
    } finally {
        if (h) await h.stop();
    }
})().catch((e) => { console.error(e); process.exit(1); });
