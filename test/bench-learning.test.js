'use strict';
// BENCH-11 (plan §4.12 and §4.7): Bench's bench.rating.changed reaches AI through its Events consumer,
// becomes per-kind evidence (rating, interval, games, cost per solved), and only an opted-in route uses it:
// the cheapest offer statistically tied with the best non-provisional rating. Provisional evidence never
// decides; no evidence leaves placement's order exactly as it was.
const assert = require('assert');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');

const t = suite('bench-learning');
const admin = token('live', ALL);
const SECRET = 'bench-events-secret-0123456789abcdef';
let h; let boards;

const boardRows = [
    { subject: 'leader-model', elo: 1200, games: 40, ci_lower: 1180, ci_upper: 1220, provisional: false, median_cost_usd: 0.5 },
    { subject: 'cheap-model', elo: 1180, games: 40, ci_lower: 1160, ci_upper: 1200, provisional: false, median_cost_usd: 0.1 },
];
const costRows = boardRows.map((r) => ({ subject: r.subject, cost_per_solved: r.subject === 'leader-model' ? 0.5 : 0.1, median_cost_usd: r.median_cost_usd }));

async function provider(key, model, price) {
    const r = await h.registry.upsertProvider({
        key, display_name: key, kind: 'http', status: 'active', base_url: 'http://127.0.0.1:9',
        auth_mode: 'none', default_model: model, capabilities: ['chat'],
    }, { actor: 'test' });
    assert.strictEqual(r.key, key);
    await h.registry.upsertModel({
        provider_key: key, model_key: model, type: 'chat',
        cost: { in_per_mtok: price, out_per_mtok: price },
    }, { actor: 'test' });
}

async function rating({ eventId, model, provider, rating: elo, lower, upper, games, cost, provisional = false, kind = 'chat.reply' }) {
    return await h.bench.applyEvent({
        event_id: eventId, event_type: 'bench.rating.changed', version: 1, source: 'bench',
        timestamp: '2026-10-20T10:00:00.000Z',
        payload: {
            kind_id: kind, category: 'all', subject: model, elo, games, win_rate: 0.6,
            ci_lower: lower, ci_upper: upper, provisional, median_cost_usd: null,
            cost_per_solved: cost, at: '2026-10-20T10:00:00.000Z',
            ...(provider ? { provider } : {}),
        },
    });
}

async function deliver(event) {
    const raw = JSON.stringify({ event });
    const headers = signDeliveryHeaders(raw, SECRET);
    const res = await fetch(`${h.base}/internal/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
}

t.test('boot with a fake Bench board endpoint and the Events consumer on', async () => {
    boards = await seamServer((_body, req) => {
        if (req.url.includes('/api/v1/boards/chat.reply') && req.url.includes('type=elo')) return { board: { kind_id: 'chat.reply', type: 'elo', rows: boardRows } };
        if (req.url.includes('/api/v1/boards/chat.reply') && req.url.includes('type=cost')) return { board: { kind_id: 'chat.reply', type: 'cost', rows: costRows } };
        return { status: 404, body: { code: 'bench.kind_not_found' } };
    });
    h = await boot({ env: {
        AI_EVENTS_SECRET: SECRET, AI_EVENTS_SUBSCRIBE: '0', AI_BENCH_URL: boards.url, AI_BENCH_TIMEOUT_MS: '2000',
    } });
    await provider('bench-leader', 'leader-model', 50);
    await provider('bench-cheap', 'cheap-model', 10);
    await provider('bench-far', 'far-model', 0.01);
    await provider('bench-prov', 'prov-model', 0.001);
});

t.test('a signed bench.rating.changed stores evidence, hydrates a sparse event from the board, and is idempotent', async () => {
    const event = {
        event_id: 'evt_bench_full_0001', event_type: 'bench.rating.changed', version: 1, source: 'bench',
        timestamp: '2026-10-20T10:00:00.000Z',
        payload: {
            kind_id: 'chat.reply', category: 'all', subject: 'leader-model', elo: 1200, games: 40, win_rate: 0.6,
            ci_lower: 1180, ci_upper: 1220, median_cost_usd: null, provisional: false, at: '2026-10-20T10:00:00.000Z',
        },
    };
    const first = await deliver(event);
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.strictEqual(first.body.stored, 1);
    let row = await h.db.prepare("SELECT * FROM bench_evidence WHERE kind_id = 'chat.reply' AND model = 'leader-model'").get();
    assert.ok(row, 'the rating is stored');
    assert.strictEqual(row.provider, 'bench-leader', 'the provider comes from AI registry when Bench rates only the model');
    assert.strictEqual(Number(row.rating), 1200);
    assert.strictEqual(Number(row.ci_lower), 1180);
    assert.strictEqual(Number(row.ci_upper), 1220);
    assert.strictEqual(Number(row.games), 40);
    assert.strictEqual(Number(row.cost_per_solved), 0.5, 'the board cost endpoint fills cost per solved');

    // Bench's current outbox announces only subjects; the consumer fills rating and cost from the boards.
    const sparse = await deliver({
        event_id: 'evt_bench_sparse_0002', event_type: 'bench.rating.changed', version: 1, source: 'bench',
        timestamp: '2026-10-20T10:05:00.000Z',
        payload: { kind_id: 'chat.reply', category: 'all', subjects: ['cheap-model'] },
    });
    assert.strictEqual(sparse.status, 200, JSON.stringify(sparse.body));
    row = await h.db.prepare("SELECT * FROM bench_evidence WHERE kind_id = 'chat.reply' AND model = 'cheap-model'").get();
    assert.strictEqual(Number(row.rating), 1180);
    assert.strictEqual(Number(row.cost_per_solved), 0.1);

    const again = await deliver({
        event_id: 'evt_bench_sparse_0002', event_type: 'bench.rating.changed', version: 1, source: 'bench',
        timestamp: '2026-10-20T10:05:00.000Z',
        payload: { kind_id: 'chat.reply', category: 'all', subjects: ['cheap-model'] },
    });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.duplicate, true, 'the inbox makes a redelivery a no-op');
    assert.strictEqual((await h.db.prepare("SELECT COUNT(*) AS n FROM bench_evidence WHERE model = 'cheap-model'").get()).n, 1);
});

t.test('the tie rule picks the cheapest offer whose interval overlaps the leader; provisional evidence never wins', async () => {
    // A provisional model is the cheapest and highest-rated, but under 10 games: it is not the leader and
    // is not a candidate. The leader is non-provisional; cheap-model overlaps it; far-model does not.
    await rating({ eventId: 'evt_bench_leader_0003', model: 'leader-model', rating: 1200, lower: 1180, upper: 1220, games: 40, cost: 0.5 });
    await rating({ eventId: 'evt_bench_cheap_0004', model: 'cheap-model', rating: 1180, lower: 1160, upper: 1200, games: 40, cost: 0.1 });
    await rating({ eventId: 'evt_bench_far_0005', model: 'far-model', rating: 900, lower: 850, upper: 950, games: 40, cost: 0.01 });
    await rating({ eventId: 'evt_bench_prov_0006', model: 'prov-model', rating: 2000, lower: 1900, upper: 2100, games: 9, cost: 0.001, provisional: true });

    const route = {
        key: 'bench.learning', capability: 'chat', constraints: { objective: 'cheapest' },
        learn_from_bench: true, bench_kind: 'chat.reply', pinned: [], fallbacks: [],
    };
    const out = await h.pool.candidates(route, ['chat'], 'chat');
    assert.strictEqual(out.order[0].provider, 'bench-cheap', `expected the tied cheap offer first, got ${JSON.stringify(out.order)}`);
    assert.strictEqual(out.order[0].model, 'cheap-model');
    assert.strictEqual(out.explain.bench.status, 'selected');
    assert.strictEqual(out.explain.bench.leader.model, 'leader-model');
    assert.strictEqual(out.explain.bench.selected.model, 'cheap-model');
    assert.match(out.explain.bench.reason, /cheapest offer statistically tied/i);
    assert.ok(!out.explain.bench.evidence.some((x) => x.model === 'prov-model'), 'provisional evidence is not used');
    assert.ok(!out.explain.bench.tied.some((x) => x.model === 'prov-model'), 'a provisional model is not tied');
    assert.ok(!out.explain.bench.tied.some((x) => x.model === 'far-model'), 'an interval that does not overlap is not tied');
});

t.test('only a route with learn_from_bench opts in; no evidence keeps placement order', async () => {
    const base = { key: 'bench.learning.off', capability: 'chat', constraints: { objective: 'cheapest' }, bench_kind: 'chat.reply', pinned: [], fallbacks: [] };
    const off = await h.pool.candidates({ ...base, learn_from_bench: false }, ['chat'], 'chat');
    assert.strictEqual(off.explain.bench.enabled, false);
    assert.strictEqual(off.explain.bench.status, 'off');
    assert.strictEqual(off.order[0].provider, 'bench-prov', 'placement stays cheapest: the evidence did not change the order');
    assert.notStrictEqual(off.order[0].provider, 'bench-cheap');

    const noEvidence = await h.pool.candidates({ ...base, key: 'bench.learning.none', learn_from_bench: true, bench_kind: 'codes.patch' }, ['chat'], 'chat');
    assert.strictEqual(noEvidence.explain.bench.status, 'no_evidence');
    assert.deepStrictEqual(noEvidence.order.map((x) => `${x.provider}:${x.model}`), off.order.map((x) => `${x.provider}:${x.model}`), 'no evidence leaves the order unchanged');

    const provisionalOnly = await h.pool.candidates({ ...base, key: 'bench.learning.prov', learn_from_bench: true, bench_kind: 'vision.answer' }, ['chat'], 'chat');
    await rating({ eventId: 'evt_bench_onlyprov_0007', kind: 'vision.answer', model: 'prov-model', rating: 2000, lower: 1900, upper: 2100, games: 9, cost: 0.001, provisional: true });
    const afterProvisional = await h.pool.candidates({ ...base, key: 'bench.learning.prov', learn_from_bench: true, bench_kind: 'vision.answer' }, ['chat'], 'chat');
    assert.strictEqual(afterProvisional.explain.bench.status, 'provisional_or_no_interval');
    assert.deepStrictEqual(afterProvisional.order.map((x) => `${x.provider}:${x.model}`), provisionalOnly.order.map((x) => `${x.provider}:${x.model}`), 'a provisional-only board changes nothing');
});

t.test('GET /api/v1/routes/:key shows the evidence and why, and lists the winning offer first', async () => {
    const created = await request(h.base, 'POST', '/api/v1/routes/bench.api/versions', { tok: admin, body: {
        capability: 'chat', constraints: { objective: 'cheapest' }, learn_from_bench: true, bench_kind: 'chat.reply',
    } });
    assert.strictEqual(created.status, 201, created.text);
    const r = await request(h.base, 'GET', '/api/v1/routes/bench.api', { tok: admin });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.route.learn_from_bench, true);
    assert.strictEqual(r.body.route.bench_kind, 'chat.reply');
    assert.strictEqual(r.body.route.bench.status, 'selected');
    assert.strictEqual(r.body.route.bench.selected.model, 'cheap-model');
    assert.ok(r.body.route.bench.evidence.length >= 2, 'the evidence it used is visible');
    assert.strictEqual(r.body.route.offers[0].provider, 'bench-cheap', 'the exposed offer order is the one runs try');
    assert.match(r.body.route.bench.reason, /statistically tied/i);

    const plain = await request(h.base, 'POST', '/api/v1/routes/bench.plain/versions', { tok: admin, body: {
        capability: 'chat', constraints: { objective: 'cheapest' },
    } });
    assert.strictEqual(plain.status, 201, plain.text);
    const p = await request(h.base, 'GET', '/api/v1/routes/bench.plain', { tok: admin });
    assert.strictEqual(p.body.route.learn_from_bench, false, 'off is the default');
    assert.strictEqual(p.body.route.bench.enabled, false);
});

t.test('shutdown', async () => {
    await h.stop();
    await boards.close();
});

t.run();
