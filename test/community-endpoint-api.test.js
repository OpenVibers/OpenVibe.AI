'use strict';
// The public seller API (design EXCHANGE-REMAKE-2026-11-06, the SDK gap): a developer key registers, lists and removes
// a standalone OpenAI-compatible endpoint offer on the Exchange's public API. The owner is the app's project owner,
// read from Network; a first-party service token is refused; the seller never names an owner.
const assert = require('assert');
const { boot, request, token, suite } = require('./helpers');
const { createEndpointOffers } = require('../server/community/endpoints');

const t = suite('community-endpoint-api');
const OWNER = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1';
const APP = '01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
const PROJECT = '01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';
const silent = { log() {}, warn() {}, error() {} };

const INPUT = {
    base_url: 'https://models.example/v1', models: ['qwen3:32b'],
    price: { in_per_million: 10, out_per_million: 30 },
    hours: { start: '00:00', end: '23:59', tz: 'UTC' }, concurrency: 2, audience: 'everyone',
};

function appToken(caps = ['ai.app.run']) {
    return token('app', caps, {
        sub: `app:app_${APP}`, actorType: 'app', ns: [`prj_${PROJECT}`, `app.prj_${PROJECT}.*`],
        extra: { project_id: `prj_${PROJECT}`, env: 'production' },
    });
}

function endpointStore(db, { project = OWNER } = {}) {
    return createEndpointOffers({
        db,
        config: { networkInternalUrl: 'http://network.test', console: { clientId: 'ai' }, community: { enabled: true, endpoints: { enabled: true } } },
        env: {}, clock: { now: () => Date.parse('2026-11-06T12:00:00Z') }, log: silent,
        tokens: { getToken: async () => 'test-token' },
        fetchImpl: async (url) => (String(url).includes('/internal/projects/')
            ? (project ? { ok: true, status: 200, json: async () => ({ project: { id: `prj_${PROJECT}`, owner: { type: 'user', id: project } } }) }
                : { ok: false, status: 404, json: async () => null })
            : { ok: false, status: 404, json: async () => null }),
    });
}

let h;
t.test('boot', async () => {
    h = await boot({ communityEndpoints: (db) => endpointStore(db) });
});

t.test('the seller API is guarded: a token is required, and a service token is not a seller', async () => {
    const anon = await request(h.base, 'POST', '/api/v1/exchange/seller/offers', { body: INPUT });
    assert.strictEqual(anon.status, 401, anon.text);
    const service = await request(h.base, 'POST', '/api/v1/exchange/seller/offers', { tok: token('exchange', ['ai.run.create']), body: INPUT });
    assert.strictEqual(service.status, 403, service.text);
    assert.strictEqual(service.body.code, 'community.endpoint_owner');
    const appWithoutCap = await request(h.base, 'POST', '/api/v1/exchange/seller/offers', { tok: appToken(['ai.run.create']), body: INPUT });
    assert.strictEqual(appWithoutCap.status, 403, appWithoutCap.text);
    assert.strictEqual(appWithoutCap.body.code, 'capability.denied');
});

t.test('a developer key registers its own endpoint offer, and the owner is the project owner', async () => {
    const created = await request(h.base, 'POST', '/api/v1/exchange/seller/offers', { tok: appToken(), body: INPUT });
    assert.strictEqual(created.status, 201, created.text);
    const offer = created.body.offer;
    assert.match(offer.id, /^ep_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.strictEqual(offer.offer_id, `endpoint:${offer.id}`);
    assert.strictEqual(offer.base_url, 'https://models.example/v1');
    assert.deepStrictEqual(offer.models, ['qwen3:32b']);
    assert.deepStrictEqual(offer.hours, { start: '00:00', end: '23:59', tz: 'UTC' });
    assert.deepStrictEqual(offer.price, { in_per_million: 10, out_per_million: 30 });
    assert.strictEqual(offer.concurrency, 2);
    assert.strictEqual(offer.audience, 'everyone');

    const listed = await request(h.base, 'GET', '/api/v1/exchange/seller/offers', { tok: appToken() });
    assert.strictEqual(listed.status, 200, listed.text);
    assert.strictEqual(listed.body.owner, OWNER, 'the owner is the project\'s person, never the app');
    assert.strictEqual(listed.body.offers.length, 1);
    assert.strictEqual(listed.body.offers[0].id, offer.id);

    const removed = await request(h.base, 'DELETE', `/api/v1/exchange/seller/offers/${offer.id}`, { tok: appToken() });
    assert.strictEqual(removed.status, 200, removed.text);
    assert.deepStrictEqual(removed.body, { id: offer.id, removed: true });

    const after = await request(h.base, 'GET', '/api/v1/exchange/seller/offers', { tok: appToken() });
    assert.strictEqual(after.status, 200);
    assert.deepStrictEqual(after.body.offers, []);
});

t.test('an address the egress guard would refuse is refused at registration, with the seller\'s key', async () => {
    for (const [base_url, re] of [['http://models.example/v1', /https/], ['https://127.0.0.1/v1', /IP address/],
        ['https://169.254.169.254/latest', /IP address/], ['https://[::1]/v1', /IP address/], ['https://localhost/v1', /public host name/]]) {
        const out = await request(h.base, 'POST', '/api/v1/exchange/seller/offers', { tok: appToken(), body: { ...INPUT, base_url } });
        assert.strictEqual(out.status, 422, out.text);
        assert.strictEqual(out.body.code, 'community.endpoint_url');
        assert.match(out.body.detail, re);
    }
});

t.test('a key removes its own offers only', async () => {
    const other = await h.endpoints.create({ owner: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2B2', input: { ...INPUT, base_url: 'https://other.example/v1' } });
    const notMine = await request(h.base, 'DELETE', `/api/v1/exchange/seller/offers/${other.id}`, { tok: appToken() });
    assert.strictEqual(notMine.status, 404, notMine.text);
    assert.strictEqual(notMine.body.code, 'community.endpoint_not_found');

    const created = await request(h.base, 'POST', '/api/v1/exchange/seller/offers', { tok: appToken(), body: INPUT });
    assert.strictEqual(created.status, 201, created.text);
    const removed = await request(h.base, 'DELETE', `/api/v1/exchange/seller/offers/${created.body.offer.id}`, { tok: appToken() });
    assert.strictEqual(removed.status, 200, removed.text);
    const again = await request(h.base, 'DELETE', `/api/v1/exchange/seller/offers/${created.body.offer.id}`, { tok: appToken() });
    assert.strictEqual(again.status, 404, again.text);
});

t.test('Exchange lists an endpoint publicly without its address or owner', async () => {
    const created = await request(h.base, 'POST', '/api/v1/exchange/seller/offers', { tok: appToken(), body: INPUT });
    assert.strictEqual(created.status, 201, created.text);
    await h.community.offers({ force: true });
    const listed = await request(h.base, 'GET', '/api/v1/community/offers');
    assert.strictEqual(listed.status, 200, listed.text);
    const offer = listed.body.offers.find((o) => o.kind === 'endpoint');
    assert.ok(offer, 'the endpoint is in the public list');
    assert.match(offer.offer_id, /^community_[0-9a-f]{16}$/);
    assert.strictEqual(offer.base_url, undefined, 'the address is never public');
    assert.strictEqual(offer.owner, undefined);
    assert.deepStrictEqual(offer.models, ['qwen3:32b']);
});

t.test('a project Network does not know is refused, never guessed', async () => {
    const h2 = await boot({ communityEndpoints: (db) => endpointStore(db, { project: null }) });
    try {
        const out = await request(h2.base, 'POST', '/api/v1/exchange/seller/offers', { tok: appToken(), body: INPUT });
        assert.strictEqual(out.status, 403, out.text);
        assert.strictEqual(out.body.code, 'community.endpoint_owner');
    } finally { await h2.stop(); }
});

t.run();
