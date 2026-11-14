'use strict';
const assert = require('node:assert/strict');
const { boot, request } = require('./helpers');
const { createKeys } = require('../server/platform/keys');

(async () => {
    let upstreamCalls = 0;
    let searchStarted, releaseSearch;
    let searchGate;
    const h = await boot({
        env: { SEARCH_BRAVE_KEY: 'shared-brave-fixture' },
        searchFetch: async () => {
            upstreamCalls++;
            if (searchGate) { searchStarted(); await searchGate; }
            return new Response(JSON.stringify(require('./fixtures/search/brave.json').response));
        },
    });
    const prepare = h.db.prepare.bind(h.db);
    const holds = [];
    h.db.prepare = (sql) => {
        const statement = prepare(sql);
        if (!sql.includes('SET reserved = x.reserved + m.take')) return statement;
        return { async get(...args) {
            const row = await statement.get(...args);
            holds.push(row ? Number(row.take) : null);
            return row;
        } };
    };
    try {
        const keys = createKeys({ db: h.db });
        const made = await keys.create('usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', {
            name: 'Search and inference', monthly_cap_usd: 2, allowed_models: ['openvibe'],
            expires_at: new Date(Date.now() + 60000).toISOString(),
        });
        const call = (path, body) => request(h.base, 'POST', path, {
            tok: made.secret, body, headers: { 'idempotency-key': 'search-inference-same-001' },
        });
        const usage = () => h.db.prepare('SELECT * FROM exchange_key_usage WHERE key_id = ? ORDER BY model').all(made.key.id);
        const month = () => h.db.prepare('SELECT spent,reserved FROM exchange_key_months WHERE key_id = ?').get(made.key.id);
        const settled = async (count) => {
            for (let i = 0; i < 200; i++) {
                const rows = await usage();
                if (rows.length === count && rows.every(row => row.status === 'settled') && (await month()).reserved === 0) return rows;
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.fail('Exchange holds did not settle');
        };
        const searchBody = { q: 'lantern', engine: 'brave' };
        const inferenceBody = { model: 'openvibe', messages: [{ role: 'user', content: 'Hello' }] };
        const invalid = await call('/v1/search', { ...searchBody, q: '' });
        assert.equal(invalid.status, 422);
        assert.equal(holds.length, 0, 'search preparation rejects invalid input before a hold');

        const search = await call('/v1/search', searchBody);
        assert.equal(search.status, 200, search.text);
        assert.equal(search.body.receipt.cost_usd, .005);
        assert.deepEqual(holds, [.005], 'paid search holds its plan ceiling');
        const searchRows = await settled(1);
        assert.equal(searchRows[0].model, 'search:/v1/search');
        assert.equal(searchRows[0].cost_usd, .005, 'search charges its receipt once');
        assert.equal(searchRows[0].tokens_in, 0);
        assert.equal(searchRows[0].tokens_out, 0);
        assert.equal((await h.db.prepare('SELECT id FROM runs').all()).length, 0, 'search creates no inference ledger entry');
        assert.equal((await h.db.prepare('SELECT * FROM exchange_key_requests').all()).length, 0, 'search does not claim inference idempotency');

        const first = await call('/v1/chat/completions', inferenceBody);
        assert.equal(first.status, 200, first.text);
        assert.deepEqual(holds, [.005, 1], 'one bounded hold per search and inference');
        const before = await settled(2);
        const originalClaim = await h.db.prepare('SELECT max_cost_usd FROM exchange_key_requests WHERE owner = ?').get('usr_01JAB2C3D4E5F6G7H8J9K0MNPQ');
        assert.equal(Number(originalClaim.max_cost_usd), 1);

        // Exhaust the cap: a replay must still reuse its original admitted ceiling.
        await h.db.prepare('UPDATE exchange_key_months SET spent = 2 WHERE key_id = ?').run(made.key.id);
        const replay = await call('/v1/chat/completions', inferenceBody);
        assert.equal(replay.status, 200, replay.text);
        assert.equal(replay.headers.get('x-openvibe-replayed'), '1');
        assert.deepEqual(replay.body, first.body);
        assert.deepEqual(holds, [.005, 1], 'replay does not reserve');
        assert.deepEqual(await usage(), before, 'replay does not charge or create a usage row');
        assert.deepEqual(await month(), { spent: 2, reserved: 0 });
        assert.equal((await h.db.prepare('SELECT id FROM runs').all()).length, 1);
        const denied = await call('/v1/chat/completions', { ...inferenceBody, model: 'other' });
        assert.equal(denied.status, 403, 'model restrictions apply before replay');
        assert.equal(holds.length, 2);

        // A positive remaining cap admits a partial hold, but cannot buy the cheapest candidate.
        await h.db.prepare('UPDATE exchange_key_months SET spent = 1.999 WHERE key_id = ?').run(made.key.id);
        const capped = await call('/v1/search', searchBody);
        assert.equal(capped.status, 429, capped.text);
        assert.ok(capped.text.includes('exchange.key_cap'));
        assert.equal(holds.length, 3);
        assert.ok(Math.abs(holds[2] - .001) < 1e-12);
        const afterCap = await settled(3);
        assert.equal(afterCap.filter(row => row.model === 'search:/v1/search' && row.cost_usd === 0).length, 1);
        assert.deepEqual(await month(), { spent: 1.999, reserved: 0 }, 'cap rejection releases its partial hold');
        assert.equal(upstreamCalls, 1, 'cap rejection never calls the provider');

        const stale = await keys.resolve(made.secret);
        await h.db.prepare('UPDATE exchange_api_keys SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', made.key.id);
        for (const [path, body] of [['/v1/search', searchBody], ['/v1/chat/completions', inferenceBody]]) {
            assert.equal((await call(path, body)).status, 401, 'expired key rejects search and inference replay');
        }
        for (const search of [false, true]) {
            await assert.rejects(keys.reserve(stale, search ? 'search:/v1/search' : 'openvibe', false, .005, search), e => e.status === 401);
        }
        assert.equal(holds.length, 3, 'expired keys take no hold at lookup or reserve');
        assert.deepEqual(await usage(), afterCap);
        assert.deepEqual(await month(), { spent: 1.999, reserved: 0 });
        assert.equal(upstreamCalls, 1);

        // Disconnect while the provider is pending: close must release the hold even without finish.
        // The query is one nobody asked before, so the search reaches the provider (a kept answer would be
        // served without it, and there would be nothing pending to disconnect).
        const disconnected = await keys.create(stale.owner, {
            name: 'Disconnected search', monthly_cap_usd: 1, allowed_models: ['openvibe'],
        });
        const started = new Promise(resolve => { searchStarted = resolve; });
        searchGate = new Promise(resolve => { releaseSearch = resolve; });
        const controller = new AbortController();
        const pending = fetch(h.base + '/v1/search', {
            method: 'POST', signal: controller.signal,
            headers: { authorization: 'Bearer ' + disconnected.secret, 'content-type': 'application/json' },
            body: JSON.stringify({ ...searchBody, q: 'lantern still pending' }),
        }).catch(error => error);
        await started;
        controller.abort();
        await pending;
        let closed;
        for (let i = 0; i < 200; i++) {
            closed = await h.db.prepare('SELECT spent,reserved FROM exchange_key_months WHERE key_id = ?').get(disconnected.key.id);
            if (closed?.reserved === 0) break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.deepEqual(closed, { spent: .005, reserved: 0 }, 'close settles unknown cost at the hold and releases it');
        const unresolved = await h.db.prepare('SELECT status,cost_usd FROM exchange_key_usage WHERE key_id = ?').get(disconnected.key.id);
        assert.deepEqual(unresolved, { status: 'unresolved', cost_usd: .005 });
        releaseSearch();
        console.log('Shared-key search, inference replay, expiry and partial-cap settlement passed');
    } finally {
        releaseSearch?.();
        h.db.prepare = prepare;
        await h.stop();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
