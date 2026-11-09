'use strict';
const assert = require('node:assert/strict');
const { createSearch, CHARGE } = require('../server/search');
const { boot, request, token, ALL } = require('./helpers');
const { createKeys } = require('../server/platform/keys');
const { createCredentials } = require('../server/credentials');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const sample = id => require('./fixtures/search/' + id + '.json').response;
const alice = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPX';
const bob = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPY';
(async () => {
    let time = 0;
    const seen = [], own = { alice: { brave: 'alice-brave-key' }, bob: {} };
    const s = createSearch({ env: { SEARCH_BRAVE_KEY: 'shared-brave-key', SEARCH_DEEPSEEK_KEY: 'shared-deepseek-key', SEARCH_SERPER_KEY: 'shared-serper-key' }, now: () => time,
        credentials: { searchForRun: async (subject, engine) => own[subject]?.[engine] ? { apiKey: own[subject][engine] } : null },
        fetchImpl: async (url, init) => {
            const host = new URL(url).hostname;
            seen.push({ host, headers: init.headers });
            if (host === 'api.search.brave.com') return json(sample('brave'));
            if (host === 'api.deepseek.com') return json(sample('deepseek'));
            return json({}, 503);
        },
    });
    const byok = await s.search('web', { q: 'x', freshness: 'day' }, { subject: 'alice' });
    assert.equal(byok.receipt.engine, 'brave');
    assert.equal(byok.receipt.cost_usd, .005);
    assert.equal(byok[CHARGE], 0);
    assert.equal(seen[0].headers['x-subscription-token'], 'alice-brave-key');
    const shared = await s.search('web', { q: 'x', freshness: 'day', subject: 'alice' }, { subject: 'bob' });
    assert.equal(shared.receipt.engine, 'deepseek', 'body cannot claim another person; cheapest fresh shared engine wins');
    assert.equal(shared[CHARGE], .00075);
    assert.equal((await s.search('web', { q: 'x', freshness: 'day', max_cost_usd: .001 })).receipt.engine, 'deepseek');
    await assert.rejects(s.search('web', { q: 'x', engine: 'brave', max_cost_usd: 0 }), /No configured engine/);
    const countPriced = createSearch({ env: { SEARCH_EXA_KEY: 'shared-exa', SEARCH_SERPAPI_KEY: 'shared-serpapi' }, fetchImpl: async url => {
        assert.equal(new URL(url).hostname, 'serpapi.com', '50 Exa results cost more than SerpAPI despite the lower base tariff');
        return json(sample('serpapi'));
    } });
    assert.equal((await countPriced.search('web', { q: 'lantern', freshness: 'day', limit: 50 })).receipt.engine, 'serpapi');
    // Failed shared hosts cool down for a minute; one person's bad key does not poison ours or another person.
    let fail = true, calls = 0;
    const health = createSearch({ env: { SEARCH_BRAVE_KEY: 'shared', SEARCH_DEEPSEEK_KEY: 'shared' }, now: () => time,
        credentials: { searchForRun: async (subject, engine) => subject === 'alice' && ['brave', 'deepseek'].includes(engine) ? { apiKey: 'bad-person-key' } : null },
        fetchImpl: async (url, init) => {
            calls++;
            if (Object.values(init.headers).includes('bad-person-key') || Object.values(init.headers).includes('Bearer bad-person-key')) return json({}, 401);
            if (url.includes('deepseek') && fail) return json({}, 503);
            return json(sample(url.includes('deepseek') ? 'deepseek' : 'brave'));
        },
    });
    await assert.rejects(health.search('web', { q: 'x', freshness: 'day' }, { subject: 'alice' }));
    await assert.rejects(health.search('web', { q: 'x', freshness: 'day' }, { subject: 'alice' }));
    assert.equal((await health.search('web', { q: 'x', freshness: 'day' })).receipt.engine, 'brave');
    const afterFail = calls; fail = false;
    assert.equal((await health.search('web', { q: 'x', freshness: 'day' })).receipt.engine, 'brave');
    assert.equal(calls, afterFail + 1);
    time = 60001;
    assert.equal((await health.search('web', { q: 'x', freshness: 'day' })).receipt.engine, 'deepseek');
    assert.equal(health.engines().find(e => e.id === 'deepseek').healthy, true);
    // A possibly billed timeout consumes its ceiling, leaving no room to overspend on fallback.
    let budgetCalls = 0;
    const bounded = createSearch({ env: { SEARCH_DEEPSEEK_KEY: 'shared', SEARCH_SERPER_KEY: 'shared' }, fetchImpl: async () => { budgetCalls++; throw new Error('timeout with upstream details'); } });
    await assert.rejects(bounded.search('web', { q: 'x', freshness: 'day', max_cost_usd: .001 }), e => e[CHARGE] === .00075 && !e.message.includes('upstream details'));
    assert.equal(budgetCalls, 1);
    const refusedReader = createSearch({ env: { SEARCH_DEEPSEEK_KEY: 'shared' }, targetGuard: async () => { throw new Error('private target'); }, fetchImpl: () => assert.fail('private target called') });
    await assert.rejects(refusedReader.read({ engine: 'deepseek', url: 'https://private.example' }), e => e[CHARGE] === 0);
    const unknownLicense = createSearch({ env: { SEARCH_BRAVE_IMAGES_KEY: 'fixture-key' }, fetchImpl: async () => json(sample('brave-images')) });
    assert.equal((await unknownLicense.search('images', { engine: 'brave-images', q: 'cat', commercial: true })).results.length, 0);
    let targetChecks = 0;
    const reader = createSearch({ env: {}, credentials: { searchForRun: async (_s, engine) => engine === 'jina' ? { apiKey: 'own-jina' } : null }, targetGuard: async () => { targetChecks++; }, fetchImpl: async () => json(require('./fixtures/search/jina-fetch.json')) });
    const read = await reader.read({ url: 'https://example.org/article' }, { subject: alice });
    assert.equal(read.receipt.engine, 'jina'); assert.equal(read[CHARGE], 0); assert.equal(targetChecks, 1);

    const cipherKey = 'ab'.repeat(32), callsHttp = [];
    const h = await boot({ env: { AI_CREDENTIALS_KEY: cipherKey, SEARCH_BRAVE_KEY: 'shared-brave-key' }, searchFetch: async (url, init) => { callsHttp.push({ url, init }); return json(sample('brave')); } });
    try {
        const creds = createCredentials({ db: h.db, config: { credentialsKey: cipherKey } });
        const tok = token('alice', ALL, { sub: alice, actorType: 'user' });
        const bobTok = token('bob', ALL, { sub: bob, actorType: 'user' });
        const service = token('actor', ALL, { extra: { on_behalf_of: alice } });
        const path = '/api/v1/me/search-credentials/brave';
        const stored = await request(h.base, 'PUT', path, { tok, body: { key: 'alice-search-fixture' } });
        assert.equal(stored.status, 200, JSON.stringify(stored.body));
        assert.equal(callsHttp.length, 0, 'save makes no paid call');
        assert.equal((await request(h.base, 'PUT', path, { tok: service, body: { key: 'intruder-fixture-key' } })).status, 403);
        assert.equal((await request(h.base, 'GET', '/api/v1/me/search-credentials', { tok: bobTok })).body.engines.length, 0);
        assert.equal((await creds.listSelf(alice)).length, 0, 'search keys never enter model routing');
        assert.equal((await creds.searchForRun(alice, 'brave')).apiKey, 'alice-search-fixture');
        const row = await h.db.prepare('SELECT key_enc FROM subject_credentials WHERE subject = ? AND provider = ?').get(alice, 'search-brave');
        assert.ok(row.key_enc.startsWith('v2:') && !row.key_enc.includes('alice-search-fixture'));
        await h.db.prepare('UPDATE subject_credentials SET subject = ? WHERE subject = ? AND provider = ?').run(bob, alice, 'search-brave');
        await assert.rejects(creds.searchForRun(bob, 'brave'), 'ciphertext cannot move between people');
        await h.db.prepare('UPDATE subject_credentials SET subject = ? WHERE subject = ? AND provider = ?').run(alice, bob, 'search-brave');
        const keys = createKeys({ db: h.db });
        const freeKey = await keys.create(alice, { name: 'BYOK only', monthly_cap_usd: 0, allowed_models: ['unrelated-model'] });
        const result = await request(h.base, 'POST', '/v1/search', { tok: freeKey.secret, body: { q: 'lantern', engine: 'brave' } });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.body.receipt.cost_usd, .005);
        assert.equal(callsHttp.at(-1).init.headers['x-subscription-token'], 'alice-search-fixture');
        assert.equal(JSON.stringify(result.body).includes('alice-search-fixture'), false);
        const paidKey = await keys.create(bob, { name: 'One search', monthly_cap_usd: .005, allowed_models: ['unrelated-model'] });
        const results = await Promise.all([1, 2].map(() => request(h.base, 'POST', '/v1/search', { tok: paidKey.secret, body: { q: 'lantern', engine: 'brave' } })));
        assert.deepEqual(results.map(r => r.status).sort(), [200, 429], 'concurrent calls cannot exceed the cap');
        for (let i = 0; i < 100; i++) {
            const usage = (await keys.usage(bob)).rows;
            if (usage.some(r => r.status === 'settled')) break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        const paid = (await keys.usage(bob)).rows;
        assert.equal(paid.length, 1);
        assert.equal(paid[0].status, 'settled');
        assert.equal(paid[0].cost_usd, .005);
        assert.equal((await keys.usage(alice)).rows[0].cost_usd, 0, 'BYOK is not billed by Exchange');
        await request(h.base, 'DELETE', path, { tok });
        assert.equal(await creds.searchForRun(alice, 'brave'), null);
    } finally { await h.stop(); }
    console.log('search routing: BYOK isolation, encrypted storage, no save-time spend, health, freshness, price and concurrent paid caps passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
