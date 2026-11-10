'use strict';

// Stage B5, AI's side: Bench's public fidelity score is read through once, cached, and put on the exact
// provider offer in the market feed. Bench down or unconfigured leaves the field null (not measured), never
// a zero. The test fetches a fixture; no Bench and no provider is called.
const assert = require('assert');
const { createFidelitySource, keyOf } = require('../server/exchange/fidelity');
const { buildOffers } = require('../server/exchange/market');

const BENCH = {
    $schema: 'exchange.fidelity@1',
    objective_set: 'fidelity-2026-11-09.v1',
    items: 10,
    offers: [
        { model: 'acme/alpha-1', provider: 'acme', provider_model: 'ACME/Alpha-1', score: 0.9, n: 10, passed: 9, interval: { lower: 0.596, upper: 0.982 }, compared_to: 'acme/alpha-1', prompt_set: 'fidelity-2026-11-09.v1', measured_at: '2026-11-09T08:00:00.000Z', measured_on: '2026-11-09' },
        { model: 'acme/alpha-1', provider: 'beta', provider_model: 'beta/alpha-1', score: null, n: 0, interval: { lower: null, upper: null }, compared_to: 'acme/alpha-1', measured_at: '2026-11-09T08:00:00.000Z' },
    ],
};

const presets = [{
    key: 'acme', display_name: 'Acme', models: [{
        model_key: 'acme/alpha-1', display_name: 'Alpha 1', type: 'chat',
        cost: { in: 1, out: 2, cached: null }, source: 'https://acme.test/prices', checked: '2026-11-01',
    }],
}];

(async () => {
    let time = Date.parse('2026-11-09T09:00:00Z');
    let calls = 0;
    let fail = false;
    const source = createFidelitySource({
        url: 'https://bench.openvibe.services/',
        fetchImpl: async (url) => {
            calls++;
            assert.strictEqual(url, 'https://bench.openvibe.services/api/v1/fidelity');
            if (fail) throw new Error('offline');
            return new Response(JSON.stringify(BENCH), { status: 200, headers: { 'content-type': 'application/json' } });
        },
        clock: { now: () => time },
        log: { warn() {} },
    });

    const first = await source.read();
    const score = first.get(keyOf('acme', 'ACME/Alpha-1'));
    assert(score, 'the exact endpoint is keyed case-insensitively');
    assert.strictEqual(score.score, 0.9);
    assert.strictEqual(score.n, 10);
    assert.deepStrictEqual(score.interval, { lower: 0.596, upper: 0.982 });
    assert.strictEqual(score.compared_to, 'acme/alpha-1');
    assert(!first.has(keyOf('beta', 'beta/alpha-1')), 'a row with no score is not published as a score');

    await source.read();
    assert.strictEqual(calls, 1, 'the read is cached');
    time += 6 * 60 * 1000;
    await source.read();
    assert.strictEqual(calls, 2, 'the cache expires after five minutes');
    fail = true;
    time += 6 * 60 * 1000;
    const afterFailure = await source.read();
    assert.strictEqual(afterFailure.get(keyOf('acme', 'acme/alpha-1')).score, 0.9, 'a failed refresh keeps the last good answer');
    assert.strictEqual(calls, 3);

    const disabled = createFidelitySource({ url: 'https://bench.openvibe.services', fetchImpl: async () => { throw new Error('must not be called'); }, enabled: false });
    assert.strictEqual((await disabled.read()).size, 0);

    const offers = buildOffers({ presets, fidelity: first });
    const offer = offers.find((o) => o.provider === 'acme' && o.provider_model === 'acme/alpha-1');
    assert(offer, 'the preset offer is listed');
    assert.strictEqual(offer.fidelity.score, 0.9);
    assert.strictEqual(offer.fidelity.compared_to, 'acme/alpha-1');
    assert.strictEqual(offer.fidelity.n, 10);
    const unmeasured = buildOffers({ presets });
    assert.strictEqual(unmeasured[0].fidelity, null, 'no measurement is null, never zero');

    console.log('exchange fidelity: Bench score read once, attached to the exact offer, null when unmeasured');
})().catch((e) => { console.error(e); process.exit(1); });
