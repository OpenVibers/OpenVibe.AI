'use strict';
// The Exchange market at production size builds in well under a second (2026-11-15: a CPU profile of a 60-second AI
// freeze put 141 of 224 seconds in buildOffers: a scan of every models.dev entry for each offer, of every record for
// each observation, of every price change and every routed offer for each offer, with bare() on each. AI answered
// nothing meanwhile, and openvibe.exchange "failed to load").
const assert = require('assert');
const { buildOffers } = require('../server/exchange/market');
const { lookupMetadata } = require('../server/exchange/model-metadata');
const { PROVIDERS } = require('../server/providers/pool-providers');
const { SOURCES } = require('../server/pricebook/sources');

const own = SOURCES.find((s) => s.role === 'own' && PROVIDERS.some((p) => p.key === s.provider));
assert.ok(own, 'an own-page price source of a known provider');
const provider = own.provider;
const N = 1500;
const rows = Array.from({ length: N }, (_, i) => ({ provider_key: provider, model_key: `maker/model-${i}`, display_name: `Model ${i}`, type: 'chat', context_window: 128000, cost: { in_per_mtok: 1, out_per_mtok: 2, source: own.url, verified_at: '2026-11-01' }, metadata: {} }));
const observations = Array.from({ length: N }, (_, i) => ({ provider_key: provider, model_key: `maker/model-${i}-latest`, price: { in: 1, out: 3, cached: null }, source: own.url, checked_at: '2026-11-10' }));
const changes = Array.from({ length: 6000 }, (_, i) => ({ provider_key: provider, model_key: `maker/model-${i % N}`, field: 'out_per_mtok', new_price: 4, source: own.url, checked_at: `2026-11-${String(1 + (i % 28)).padStart(2, '0')}` }));
const entries = Array.from({ length: 6000 }, (_, i) => ({ id: `model-${i}`, provider: 'models', maker: 'maker', model: { release_date: '2026-01-01', limit: { context: 200000 } } }));
const catalogue = { models: Array.from({ length: N }, (_, i) => ({ slug: `model-${i}`, offers: [{ provider, model: `maker/model-${i}` }] })) };

const t0 = Date.now();
const offers = buildOffers({ providers: [{ key: provider }], rows, changes, catalogue, metadata: { entries }, observations });
const ms = Date.now() - t0;
assert.ok(offers.length >= N, `every record is an offer (${offers.length})`);
assert.ok(ms < 2000, `built in ${ms} ms (it took minutes)`);
const one = offers.find((o) => o.provider_model === 'maker/model-7');
assert.strictEqual(one.routed, true, 'the routed set still finds it');
assert.strictEqual(one.price.out, 4, 'the newest own-page change still wins');
assert.strictEqual(one.context, 128000);
// The metadata lookup by bare id, at size: the same answer as a scan, many times faster.
const t1 = Date.now();
for (let i = 0; i < 3000; i++) lookupMetadata(entries, `openrouter/model-${i}-latest`, 'openrouter');
assert.ok(Date.now() - t1 < 500, `3,000 lookups in ${Date.now() - t1} ms`);
assert.strictEqual(lookupMetadata(entries, 'x/model-42', 'models').context, 200000);
console.log(`exchange-market-scale: ${N} offers, ${changes.length} changes, ${entries.length} metadata entries in ${ms} ms`);
