'use strict';
/**
 * The versioned rate cards for the search engines (plan §W.2 step 3, 11-13).
 *
 * The money is integer nano-USD from decimal text, never a float. One ACTIVE card exists per (engine, unit),
 * and a card is never edited: a new price is a new version, a draft until the owner activates it, and activating
 * it retires the card it replaces. A draft is never used by the search. Before a call the search holds the
 * card's ceiling × the units it may use; after it, it settles at the card's price × the units it used. The
 * receipt names the card, the terms, the class, the purpose, the hold and the settle.
 */
const assert = require('node:assert/strict');
const { suite, boot, request, token, ALL } = require('./helpers');
const { createRateCards, SEED, nanoOf, perThousand, settle, estimate } = require('../server/search/rate-cards');
const { createSearch, adapters } = require('../server/search');
const { searchRateCardsRouter } = require('../server/api/search-rate-cards');
const { routes, openapi } = require('../server/openapi');
const seed = require('./fixtures/search/rate-cards.json');

const t = suite('search rate cards');
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPX';
const json = (body) => new Response(JSON.stringify(body), { status: 200 });
const sample = id => require('./fixtures/search/' + id + '.json').response;

t.test('the money is integer nano-USD, never a float', () => {
    assert.equal(nanoOf('0.1') + nanoOf('0.2'), nanoOf('0.3'), '0.1 + 0.2 is 0.3, not 0.30000000000000004');
    assert.equal(nanoOf('0.000000001'), 1n);
    assert.equal(nanoOf('0.0000000011'), 2n, 'a finer digit rounds up to the next nano');
    assert.equal(nanoOf('1.0000000004'), 1000000001n);
    assert.equal(nanoOf('0'), 0n);
    assert.throws(() => nanoOf('1e-9'), (e) => e.status === 422, 'an exponent form is refused');
    assert.throws(() => nanoOf('-1'), (e) => e.status === 422);
    assert.throws(() => nanoOf('abc'), (e) => e.status === 422);
    // A thousand units of a $0.00265 engine is $2.65, exactly.
    assert.equal(settle({ price: '0.00265' }, 1000), 2650000000n, 'a thousand units at $0.00265 is $2.65');
    assert.equal(estimate({ ceiling: '0.005' }, 1), 5000000n);
    assert.equal(perThousand({ price: '0.005' }), '5');
    assert.equal(perThousand({ price: '0.0005' }), '0.5');
    assert.equal(perThousand({ price: '0.00265' }), '2.65');
});

t.test('the seed is the price every adapter carried before the clean cut', () => {
    assert.equal(SEED.length, adapters.length, 'every engine has a card');
    for (const a of adapters) {
        const row = seed.adapters[a.id];
        assert.ok(row, a.id + ' has a recorded price');
        const card = SEED.find((c) => c.engine === a.id);
        assert.ok(card, a.id + ' has a card');
        assert.equal(card.version, 1, a.id);
        assert.equal(card.status, 'active', a.id);
        assert.equal(card.price, row.price, a.id + ' keeps the price it had');
        assert.equal(card.ceiling, row.ceiling, a.id + ' keeps the reserve it had');
        assert.equal(card.unit, row.unit, a.id);
        assert.equal(card.read_on, row.checked_on, a.id + ' keeps the day its page was read');
        // The card's price is exactly the old price per 1,000, divided by 1,000, in integers.
        if (row.price_per_1000 != null)
            assert.equal(nanoOf(card.price) * 1000n, nanoOf(String(row.price_per_1000)), a.id);
    }
});

t.test('the migration seeds exactly these cards, and one active card per engine and unit', async () => {
    const testdb = await require('./db').testDb();
    try {
        const rows = await testdb.db.prepare('SELECT engine, unit, version, price, ceiling, currency, source_url, read_on, status FROM search_rate_cards ORDER BY engine, unit').all();
        assert.equal(rows.length, SEED.length, 'one card per engine');
        for (const row of rows) {
            const card = SEED.find((c) => c.engine === row.engine && c.unit === row.unit);
            assert.ok(card, row.engine + ' is seeded');
            assert.equal(row.version, card.version);
            assert.equal(row.price, card.price);
            assert.equal(row.ceiling, card.ceiling);
            assert.equal(row.currency, card.currency);
            assert.equal(row.source_url, card.source_url);
            assert.equal(String(row.read_on).slice(0, 10), card.read_on);
            assert.equal(row.status, 'active');
        }
        // The table says so: a second active card for the same (engine, unit) is refused.
        await assert.rejects(testdb.db.prepare("INSERT INTO search_rate_cards (id, engine, version, unit, price, ceiling, currency, read_on, status, created_at) VALUES ('src_second', 'brave', 9, 'request', '1', '1', 'USD', '2026-11-13', 'active', now())").run(),
            /search_rate_cards_active|duplicate key/);
    } finally { await testdb.close(); }
});

t.test('a draft is never used; the owner activates it, and the hold and the settle follow the card', async () => {
    const h = await boot({ env: { SEARCH_BRAVE_KEY: 'shared-brave-key' }, searchFetch: async () => json(sample('brave')) });
    try {
        const env = { SEARCH_BRAVE_KEY: 'shared-brave-key' };
        const search = createSearch({ db: h.db, env, fetchImpl: async () => json(sample('brave')) });
        const owner = token('exchange', ALL);
        const headers = { 'x-ov-role': 'owner', 'x-ov-subject': OWNER };

        // Only the owner: another service, and the owner without the role, are refused.
        assert.equal((await request(h.base, 'GET', '/api/v1/admin/search/rate-cards', { tok: token('someone', ALL), headers })).status, 403);
        assert.equal((await request(h.base, 'GET', '/api/v1/admin/search/rate-cards', { tok: owner })).status, 403);

        // The list: every card, the active ones and the retired ones.
        const list = await request(h.base, 'GET', '/api/v1/admin/search/rate-cards', { tok: owner, headers });
        assert.equal(list.status, 200, JSON.stringify(list.body));
        assert.equal(list.body.rate_cards.length, SEED.length);

        // A new version is a draft, and a draft is never used.
        const draft = await request(h.base, 'POST', '/api/v1/admin/search/rate-cards', {
            tok: owner, headers,
            body: { engine: 'brave', unit: 'request', price: '0.004', ceiling: '0.006', source_url: 'https://example.org/pricing', read_on: '2026-11-13' },
        });
        assert.equal(draft.status, 200, JSON.stringify(draft.body));
        assert.equal(draft.body.rate_card.status, 'draft');
        assert.equal(draft.body.rate_card.version, 2);
        const before = await search.search('web', { q: 'lantern', engine: 'brave' });
        assert.equal(before.receipt.rate_card.version, 1, 'a draft is never used');
        assert.equal(before.receipt.cost_usd, 0.005, 'the price of today does not change');

        // The owner activates it: the card it replaces is retired, and the search follows the new card.
        const activated = await request(h.base, 'POST', `/api/v1/admin/search/rate-cards/${draft.body.rate_card.id}/activate`, { tok: owner, headers });
        assert.equal(activated.status, 200, JSON.stringify(activated.body));
        assert.equal(activated.body.rate_card.status, 'active');
        const after = await search.search('web', { q: 'lantern', engine: 'brave' });
        assert.equal(after.receipt.rate_card.id, draft.body.rate_card.id);
        assert.equal(after.receipt.rate_card.version, 2);
        assert.equal(after.receipt.estimate.nano_usd, '6000000', 'the hold is the ceiling');
        assert.equal(after.receipt.actual.nano_usd, '4000000', 'the settle is the price');
        assert.equal(after.receipt.cost_usd, 0.004);
        const cards = (await request(h.base, 'GET', '/api/v1/admin/search/rate-cards', { tok: owner, headers })).body.rate_cards.filter((c) => c.engine === 'brave');
        assert.equal(cards.filter((c) => c.status === 'active').length, 1, 'one active card per unit');
        assert.equal(cards.filter((c) => c.status === 'retired').length, 1, 'the card it replaced is retired');
        assert.equal(cards.filter((c) => c.status === 'draft').length, 0, 'the draft is the active one now');
    } finally { await h.stop(); }
});

t.test('the receipt names the card, the terms, the class and the purpose', async () => {
    const search = createSearch({ env: { SEARCH_BRAVE_KEY: 'shared-brave-key' }, fetchImpl: async () => json(sample('brave')) });
    const out = await search.search('web', { q: 'lantern', engine: 'brave', purpose: 'answer_grounding' });
    assert.deepEqual(out.receipt.rate_card, { id: 'src_brave_request_v1', version: 1 });
    assert.deepEqual(out.receipt.terms, { reviewed_on: '2026-11-13' });
    assert.equal(out.receipt.class, 'independent_index');
    assert.equal(out.receipt.purpose, 'answer_grounding');
    assert.equal(out.receipt.estimate.nano_usd, '5000000', 'the hold is the ceiling');
    assert.equal(out.receipt.actual.nano_usd, '5000000', 'the settle is the price');
    assert.equal(out.receipt.cost_usd, 0.005);
});

t.test('a card older than ninety days says so on the engines list', async () => {
    const testdb = await require('./db').testDb();
    try {
        const cards = createRateCards({ db: testdb.db });
        const old = await cards.addDraft({ engine: 'tavily', unit: 'request', price: '0.008', ceiling: '0.008', read_on: '2026-01-01' }, { actor: OWNER });
        await cards.activate(old.id, { actor: OWNER });
        const search = createSearch({ db: testdb.db, env: {}, fetchImpl: async () => assert.fail('no engine is called') });
        const engines = await search.engines();
        const tavily = engines.find((e) => e.id === 'tavily');
        assert.equal(tavily.rate_cards[0].stale, true, 'the card says it is old');
        assert.ok(tavily.rate_cards[0].age_days > 90);
        assert.equal(tavily.pricing_stale, true, 'the engine says its price is old');
        const brave = engines.find((e) => e.id === 'brave');
        assert.equal(brave.rate_cards[0].stale, false, 'a fresh card says nothing');
    } finally { await testdb.close(); }
});

t.test('the owner routes are a router of their own', () => {
    assert.equal(typeof searchRateCardsRouter, 'function');
});

t.test('the openapi documents the owner routes', () => {
    const documented = routes();
    assert.ok(documented.includes('GET /api/v1/admin/search/rate-cards'));
    assert.ok(documented.includes('POST /api/v1/admin/search/rate-cards'));
    assert.ok(documented.includes('POST /api/v1/admin/search/rate-cards/{id}/activate'));
    const doc = openapi();
    const path = '/api/v1/admin/search/rate-cards';
    assert.ok(doc.paths[path] && doc.paths[path].get && doc.paths[path].post, 'the document describes the routes');
    assert.ok(doc.paths[path].get.description.includes('owner'), 'the document says who may call them');
    assert.ok(doc.paths[`${path}/{id}/activate`].post, 'the document describes the activation');
});

t.run();
