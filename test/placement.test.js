'use strict';
// T6 placement (openvibe-sdk/placement, used by the provider router): ordering by price, latency and
// objective; hard constraints exclude a candidate with a reason (capability, health, trust, ceiling);
// an unpriced paid provider is never assumed free; hysteresis keeps the current placement unless a
// candidate is clearly better; correctness keeps the named authority. Pure offers — no network.
const assert = require('assert');
const { plan } = require('openvibe-sdk/placement');
const { suite } = require('./helpers');

const t = suite('placement');
const card = (id, provider, price) => ({ id, provider, metric: 'tokens', unit_size: 1e6, unit_price_usd: price, free_allowance: 0, reset_period: 'month' });
const offer = (id, opts = {}) => ({
    offer_id: id, kind: 'provider', region: 'global', trust: 'first-party', capabilities: ['chat'],
    health: { status: 'up' }, pricing: { model: 'metered', rate_card: id }, ...opts,
});
const req = (over = {}) => ({ kind: 'ai', mobility: 'request', latency_class: 'interactive', objective: 'balanced', capabilities: ['chat'], units: 1, ...over });

t.test('cheapest picks the lower-priced offer', () => {
    const offers = [offer('pricey'), offer('cheap')];
    const r = plan(req({ objective: 'cheapest' }), offers, { rateCards: [card('pricey', 'pricey', 30), card('cheap', 'cheap', 5)] });
    assert.strictEqual(r.selected, 'cheap');
    assert.deepStrictEqual(r.candidates.map((c) => [c.id, c.eligible]), [['pricey', true], ['cheap', true]]);
});

t.test('lowest-latency picks the faster offer', () => {
    const offers = [offer('slow', { latency_ms: { p95: 900 } }), offer('fast', { latency_ms: { p95: 90 } })];
    const r = plan(req({ objective: 'lowest-latency' }), offers, { rateCards: [card('slow', 'slow', 1), card('fast', 'fast', 1)] });
    assert.strictEqual(r.selected, 'fast');
});

t.test('hard constraints exclude with a reason; the eligible one is chosen', () => {
    const offers = [
        offer('nocap', { capabilities: ['vision'] }),
        offer('sick', { health: { status: 'down' } }),
        offer('outsider', { trust: 'community' }),
        offer('slow', { latency_ms: { p95: 5000 } }),
        offer('good'),
    ];
    const r = plan(req({ trust: ['first-party'], max_latency_ms: 1000 }), offers, { rateCards: offers.map((o) => card(o.offer_id, o.offer_id, 1)) });
    const why = Object.fromEntries(r.candidates.map((c) => [c.id, c.excluded_because]));
    assert.match(why.nocap, /lacks chat/);
    assert.match(why.sick, /health down/);
    assert.match(why.outsider, /trust/);
    assert.match(why.slow, /over 1000 ms/);
    assert.strictEqual(r.selected, 'good');
});

t.test('an unpriced paid provider is excluded, never assumed free', () => {
    const unpriced = { offer_id: 'free?', kind: 'provider', region: 'global', trust: 'first-party', capabilities: ['chat'], health: { status: 'up' }, pricing: { model: 'metered' } };
    const offers = [offer('priced'), unpriced];
    const r = plan(req({ objective: 'cheapest' }), offers, { rateCards: [card('priced', 'priced', 5)] });
    const u = r.candidates.find((c) => c.id === 'free?');
    assert.strictEqual(u.eligible, true, 'not a hard-constraint failure');
    assert.ok(!Number.isFinite(u.estimated_cost_usd), 'no price known, so no finite cost estimate');
    assert.strictEqual(r.selected, 'priced');
});

t.test('hysteresis: a slightly better candidate does not move the current placement', () => {
    const offers = [offer('current'), offer('rival')];
    const rateCards = [card('current', 'current', 10), card('rival', 'rival', 9)];
    const stays = plan(req({ objective: 'cheapest' }), offers, { rateCards, current: 'current', minGain: 0.5 });
    assert.strictEqual(stays.selected, 'current', stays.reasons.join('; '));
    assert.ok(stays.reasons.some((x) => /stays on current/.test(x)));
    const moves = plan(req({ objective: 'cheapest' }), offers, { rateCards, current: 'current', minGain: 0.05 });
    assert.strictEqual(moves.selected, 'rival');
});

t.test('correctness keeps the named authority, whatever the price', () => {
    const offers = [offer('authority'), offer('cheaper')];
    const r = plan(req({ objective: 'correctness', authority: 'authority' }), offers, { rateCards: [card('authority', 'authority', 50), card('cheaper', 'cheaper', 1)] });
    assert.strictEqual(r.selected, 'authority');
    assert.ok(r.reasons.some((x) => /authority keeps critical work/.test(x)));
});

t.test('a candidate that is no longer eligible fails over immediately (no minGain hold)', () => {
    const offers = [offer('current', { health: { status: 'down' } }), offer('other')];
    const r = plan(req({ objective: 'cheapest' }), offers, { rateCards: [card('current', 'current', 1), card('other', 'other', 9)], current: 'current', minGain: 0.9 });
    assert.strictEqual(r.selected, 'other');
    assert.ok(r.reasons.some((x) => /no longer eligible/.test(x)));
});

t.run();
