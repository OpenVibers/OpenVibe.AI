'use strict';
// T6 J4: AI's prices are platform.rate-card@1 objects and each provider's period is a platform.provider-state@1,
// validated against openvibe-contracts (no skip: a missing contract fails). One card per metric (input, cached
// input, output) carries the configured number exactly; unknown provenance stays visibly unknown. The states
// reach openvibe-sdk/placement, so a free allowance left wins and an open breaker (health down) never does.
const assert = require('assert');
const { validate } = require('openvibe-contracts');
const rates = require('../server/providers/rate-cards');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('rate-card');
const tok = token('live', ALL);
let h;

function valid(name, obj) {
    const v = validate(name, obj);
    assert.ok(v.valid, `${name} ${JSON.stringify(obj)}: ${JSON.stringify(v.errors)}`);
}
const UNKNOWN = { effective_from: '1970-01-01', verified_at: '1970-01-01' };

t.test('cards from every price source validate, keep each number and mark unknown provenance', () => {
    const pricing = {
        table: {
            'gpt-4o': { in: 2.5, out: 10, cached: 1.25, source: 'https://openai.com/api/pricing/', verified_at: '2026-09-30', effective_from: '2026-09-01' },
            default: { in: 0.7 },
        },
        inputPerMtok: 3, outputPerMtok: 15,
    };
    const fromTable = rates.buildCards({ providerKey: 'shared', model: 'gpt-4o-mini', pricing });
    const fromDefault = rates.buildCards({ providerKey: 'shared', model: 'other', pricing });
    const flat = rates.buildCards({ providerKey: 'shared', model: 'other', pricing: { table: {}, inputPerMtok: 3, outputPerMtok: 15 } });
    const fromRow = rates.buildCards({ providerKey: 'p', model: 'm', row: { cost: { in_per_mtok: 1.1, out_per_mtok: 4.4, cached_per_mtok: null, free_allowance: 0, reset_period: 'month', source: null, verified_at: null, effective_from: null } }, pricing });
    const own = rates.buildCards({ providerKey: 'byo:live:1', model: 'x', pricing: { table: {} }, flat: false });
    for (const set of [fromTable, fromDefault, flat, fromRow, own]) for (const c of [set.in, set.cached, set.out]) valid('platform.rate-card@1', c);

    // Separate metrics, the configured numbers untouched (no (in+out)/2 any more).
    assert.deepStrictEqual(rates.pricesOf(fromTable), { in: 2.5, out: 10, cached: 1.25 });
    assert.deepStrictEqual([fromTable.in.metric, fromTable.cached.metric, fromTable.out.metric], ['input-tokens:gpt-4o-mini', 'cached-input-tokens:gpt-4o-mini', 'output-tokens:gpt-4o-mini']);
    assert.deepStrictEqual({ ...fromTable.in, id: undefined }, { id: undefined, provider: 'shared', metric: 'input-tokens:gpt-4o-mini', unit_size: 1e6, unit_price_usd: 2.5, free_allowance: 0, reset_period: 'month', effective_from: '2026-09-01', source: 'https://openai.com/api/pricing/', verified_at: '2026-09-30' });
    // The default entry has no output price: that card is the flat rate, and says so.
    assert.deepStrictEqual(rates.pricesOf(fromDefault), { in: 0.7, out: 15, cached: 0.7 * 0.1 });
    assert.strictEqual(fromDefault.out.source, 'urn:openvibe:ai:unverified:flat');
    assert.strictEqual(fromDefault.in.source, 'urn:openvibe:ai:unverified:pricing');
    assert.strictEqual(fromDefault.cached.source, 'urn:openvibe:ai:unverified:derived');
    assert.deepStrictEqual(rates.pricesOf(flat), { in: 3, out: 15, cached: 3 * 0.1 });
    assert.deepStrictEqual(rates.pricesOf(fromRow), { in: 1.1, out: 4.4, cached: 1.1 * 0.1 });
    for (const c of [flat.in, flat.out, fromRow.in, fromRow.out, fromDefault.in]) assert.deepStrictEqual({ effective_from: c.effective_from, verified_at: c.verified_at }, UNKNOWN);
    assert.strictEqual(fromRow.in.source, 'urn:openvibe:ai:unverified:models');
    assert.deepStrictEqual(rates.pricesOf(own), { in: 0, out: 0, cached: 0 });
    assert.strictEqual(own.in.source, 'urn:openvibe:ai:unverified:unpriced');

    // costOf bills the three metrics on their own cards.
    assert.strictEqual(rates.costOfUsage(fromTable, { input: 1e6, cached: 4e5, output: 2e6 }), 0.6 * 2.5 + 0.4 * 1.25 + 2 * 10);
});

t.test('provider states validate: usage per metric, linear forecast, reserve only when configured, breaker as health', () => {
    const cards = Object.values(rates.buildCards({ providerKey: 'p', model: 'm', pricing: { table: {}, inputPerMtok: 3, outputPerMtok: 15 } }));
    const now = Date.UTC(2026, 9, 11, 0, 0, 0);       // 10 of October's 31 days have passed
    const usageRows = [{ model_key: 'm', tokens_in: 1000, tokens_out: 300, tokens_cached: 200 }, { model_key: 'other', tokens_in: 5, tokens_out: 5, tokens_cached: 0 }];
    const s = rates.providerState({ provider: 'p', cards, usageRows, breaker: 'closed', now });
    valid('platform.provider-state@1', s);
    assert.deepStrictEqual(s.usage, { 'input-tokens:m': 800, 'cached-input-tokens:m': 200, 'output-tokens:m': 300 });
    assert.strictEqual(s.period_start, '2026-10-01T00:00:00.000Z');
    assert.strictEqual(s.period_end, '2026-11-01T00:00:00.000Z');
    assert.strictEqual(s.forecast['input-tokens:m'], 800 * 3.1);
    assert.strictEqual(s.health, 'up');
    assert.ok(!('reserve' in s), 'no reserve unless configured');
    const half = rates.providerState({ provider: 'p', cards, breaker: 'half_open', reserve: { 'input-tokens:m': 0.25, bad: 2 }, now });
    valid('platform.provider-state@1', half);
    assert.strictEqual(half.health, 'degraded');
    assert.deepStrictEqual(half.reserve, { 'input-tokens:m': 0.25 });
    const open = rates.providerState({ provider: 'p', cards, breaker: 'open', now });
    valid('platform.provider-state@1', open);
    assert.strictEqual(open.health, 'down');

    // A provider whose models reset differently: each metric counts and forecasts over its own card's period.
    const rowCard = (model, reset_period, effective_from = null) => rates.buildCards({ providerKey: 'p', model, pricing: { table: {} },
        row: { cost: { in_per_mtok: 1, out_per_mtok: 1, cached_per_mtok: null, free_allowance: 0, reset_period, source: null, verified_at: null, effective_from } } });
    const mixed = [rowCard('d', 'day'), rowCard('mo', 'month'), rowCard('n', 'none', '2026-10-05')].flatMap(Object.values);
    const days = ['2026-10-11', '2026-10-06', '2026-10-02', '2026-09-30'];
    const rows = days.flatMap((day) => ['d', 'mo', 'n'].map((model_key) => ({ day, model_key, tokens_in: 10, tokens_out: 0, tokens_cached: 0 })));
    const ms = rates.providerState({ provider: 'p', cards: mixed, usageRows: rows, now: now + 6 * 3600000 });
    valid('platform.provider-state@1', ms);
    assert.deepStrictEqual([ms.usage['input-tokens:d'], ms.usage['input-tokens:mo'], ms.usage['input-tokens:n']], [10, 30, 20]);
    assert.strictEqual(ms.forecast['input-tokens:d'], 10 * 4, 'a day card forecasts to the end of its day');
    assert.strictEqual(ms.forecast['input-tokens:n'], 20, 'a card that never resets forecasts what it has used');
    assert.deepStrictEqual([ms.period_start, ms.period_end], ['2026-10-11T00:00:00.000Z', '2026-10-12T00:00:00.000Z'], 'the state window is the shortest reset period');
    // 'none' is bounded: from effective_from when known, never more than NONE_LOOKBACK_DAYS back.
    const n = rowCard('n', 'none', '2026-10-05');
    assert.strictEqual(rates.usageSince([n.in, n.out], now), '2026-10-05');
    const cap = new Date(now - rates.NONE_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
    assert.strictEqual(rates.usageSince([n.cached], now), cap, 'the derived cached card has no effective_from of its own');
    assert.strictEqual(rates.usageSince(Object.values(rowCard('n', 'none')), now), cap);
});

async function provider(key, capability = 'classify') {
    const r = await request(h.base, 'POST', '/api/v1/providers', { tok, body: { key, kind: 'http', auth_mode: 'none', timeout_ms: 3000, base_url: 'http://127.0.0.1:1/x', capabilities: [capability], default_model: `${key}-m` } });
    assert.strictEqual(r.status, 201, r.text);
}
async function model(key, cost) {
    const r = await request(h.base, 'POST', '/api/v1/models', { tok, body: { provider_key: key, model_key: `${key}-m`, type: 'chat', cost } });
    assert.strictEqual(r.status, 201, r.text);
    return r.body.model;
}

t.test('the router plans on full rate cards and provider states: a free allowance left wins, then runs out', async () => {
    h = await boot({ env: { AI_STUB_FALLBACK: 'false' } });
    await provider('allow');
    await provider('plain');
    const m = await model('allow', { in_per_mtok: 2, out_per_mtok: 8, free_allowance: 1e6, reset_period: 'month', source: 'https://example.com/pricing', verified_at: '2026-09-30' });
    assert.deepStrictEqual(m.cost, { in_per_mtok: 2, out_per_mtok: 8, cached_per_mtok: null, free_allowance: 1e6, reset_period: 'month', effective_from: null, source: 'https://example.com/pricing', verified_at: '2026-09-30' });
    await model('plain', { in_per_mtok: 2, out_per_mtok: 8 });
    const bad = await request(h.base, 'POST', '/api/v1/models', { tok, body: { provider_key: 'plain', model_key: 'plain-m', cost: { in_per_mtok: 2, verified_at: 'yesterday' } } });
    assert.strictEqual(bad.status, 422, 'a provenance field that is not the contract\'s shape is refused');
    const route = (await request(h.base, 'POST', '/api/v1/routes/test.rate-cards/versions', { tok, body: { capability: 'classify', constraints: { objective: 'cheapest' }, timeout_ms: 3000 } })).body.route;

    const c1 = await h.pool.candidates(route, ['classify'], 'classify');
    for (const c of c1.rateCards) valid('platform.rate-card@1', c);
    for (const s of c1.states) valid('platform.provider-state@1', s);
    for (const key of ['allow', 'plain']) assert.ok(c1.states.some((s) => s.provider === key), `a state for ${key}`);
    valid('platform.placement-result@1', c1.placement);
    assert.strictEqual(c1.placement.selected, 'allow:allow-m', 'equal prices: the free allowance left wins');
    assert.strictEqual(c1.placement.candidates.find((c) => c.id === 'allow:allow-m').estimated_cost_usd, 0);
    assert.ok(c1.placement.reasons.some((r) => /free allowance/.test(r)));
    // priceFor/costOf read the same cards placement saw.
    const allowIn = c1.rateCards.find((c) => c.id === 'allow:allow-m/input-tokens');
    assert.deepStrictEqual(await h.pool.priceFor('allow', 'allow-m'), { in: allowIn.unit_price_usd, out: 8, cached: 2 * 0.1 });
    assert.strictEqual(allowIn.free_allowance, 1e6);
    assert.strictEqual(await h.pool.costOf('allow', 'allow-m', { input: 1e6, output: 1e6, cached: 0 }), 10);

    // This period's usage already spends the allowance: the forecast says it runs out, so it is not free any more.
    await h.db.prepare(`INSERT INTO usage_daily (day, requester, attribution, workflow_key, provider_key, model_key, requests, tokens_in, tokens_out, tokens_cached, cost_usd)
        VALUES (?, 'service:live', '', 'test', 'allow', 'allow-m', 1, 2000000, 0, 0, 0)`).run(new Date().toISOString().slice(0, 10));
    const c2 = await h.pool.candidates(route, ['classify'], 'classify');
    const st = c2.states.find((s) => s.provider === 'allow');
    valid('platform.provider-state@1', st);
    assert.strictEqual(st.usage['input-tokens:allow-m'], 2000000);
    assert.ok(c2.placement.candidates.find((c) => c.id === 'allow:allow-m').estimated_cost_usd > 0, 'an allowance that is spent is not free');
});

t.test('an open breaker is health down in the state and the provider is not selected', async () => {
    await provider('cheapest', 'enrich');
    await model('cheapest', { in_per_mtok: 0.1, out_per_mtok: 0.1 });
    await provider('dearer', 'enrich');
    await model('dearer', { in_per_mtok: 5, out_per_mtok: 5 });
    const route = (await request(h.base, 'POST', '/api/v1/routes/test.rate-cards-breaker/versions', { tok, body: { capability: 'enrich', constraints: { objective: 'cheapest' }, timeout_ms: 3000 } })).body.route;
    assert.strictEqual((await h.pool.candidates(route, ['enrich'], 'enrich')).placement.selected, 'cheapest:cheapest-m');
    await h.db.prepare(`INSERT INTO provider_health (provider_key, state, consecutive_failures, opened_at, last_error, last_success_at, last_failure_at)
        VALUES ('cheapest', 'open', 5, ?, 'boom', NULL, ?)`).run(Date.now(), Date.now());
    const c = await h.pool.candidates(route, ['enrich'], 'enrich');
    const st = c.states.find((s) => s.provider === 'cheapest');
    valid('platform.provider-state@1', st);
    assert.strictEqual(st.health, 'down');
    assert.notStrictEqual(c.placement.selected, 'cheapest:cheapest-m');
    assert.match(c.placement.candidates.find((x) => x.id === 'cheapest:cheapest-m').excluded_because, /health down/);
    await h.stop();
});

t.test('a null price cell in AI_PRICING_JSON falls back, it is not a price of 0', () => {
    const pricing = { table: { n: { in: 2, cached: null, out: 8 } }, inputPerMtok: 3, outputPerMtok: 15 };
    const cards = rates.buildCards({ providerKey: 'p', model: 'n', pricing });
    assert.deepStrictEqual(rates.pricesOf(cards), { in: 2, out: 8, cached: 2 * 0.1 });
    assert.strictEqual(cards.cached.source, 'urn:openvibe:ai:unverified:derived');
});

t.test('a table entry with null or empty prices uses the flat rates', () => {
    const pricing = { table: { n: { in: null, out: '' } }, inputPerMtok: 3, outputPerMtok: 15 };
    const cards = rates.buildCards({ providerKey: 'p', model: 'n', pricing });
    assert.deepStrictEqual(rates.pricesOf(cards), { in: 3, out: 15, cached: 3 * 0.1 });
    assert.strictEqual(cards.in.source, 'urn:openvibe:ai:unverified:flat');
    assert.strictEqual(cards.out.source, 'urn:openvibe:ai:unverified:flat');
});

t.test('a none card not yet effective counts from the start of today, so its start is a whole day', () => {
    const now = Date.parse('2026-10-02T15:00:00Z');
    assert.deepStrictEqual(rates.periodOf('none', now, '2026-12-01'), { start: Date.parse('2026-10-02T00:00:00Z'), end: now });
    const base = rates.buildCards({ providerKey: 'p', model: 'n', pricing: { table: {}, inputPerMtok: 3, outputPerMtok: 15 } });
    const card = { ...base.in, reset_period: 'none', effective_from: '2026-12-01' };
    assert.strictEqual(rates.usageSince([card], now), '2026-10-02');
    const state = rates.providerState({ provider: 'p', cards: [card], usageRows: [], now });
    assert.strictEqual(state.period_start, '2026-10-02T00:00:00.000Z');
    assert.ok(Date.parse(state.period_start) < Date.parse(state.period_end), 'the start is strictly before the end');
});

t.run();
