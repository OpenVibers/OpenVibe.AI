'use strict';
const assert = require('node:assert/strict');
const { boot } = require('./helpers');
const { createKeys } = require('../server/platform/keys');
(async () => {
    const h = await boot();
    try {
        let now = Date.now();
        const keys = createKeys({ db: h.db, clock: { now: () => now } });
        await assert.rejects(
            keys.create('alice', {
                name: 'bad',
                monthly_cap_usd: 1,
                allowed_models: [],
                expires_at: 'not-a-date',
            }),
            (e) => e.status === 422,
        );
        const made = await keys.create('alice', {
            name: 'expiring',
            monthly_cap_usd: 1,
            allowed_models: [],
            expires_at: new Date(now + 1000).toISOString(),
        });
        const resolved = await keys.resolve(made.secret);
        assert.ok(resolved);
        assert.ok(made.key.expires_at);
        now += 2000;
        assert.equal(await keys.resolve(made.secret), undefined);
        for (const free of [false, true])
            await assert.rejects(keys.reserve(resolved, 'model', free), (e) => e.status === 401);
        assert.equal((await h.db.prepare('SELECT * FROM exchange_key_months WHERE key_id = ?').all(resolved.id)).length, 0);
        assert.equal((await h.db.prepare('SELECT * FROM exchange_key_usage WHERE key_id = ?').all(resolved.id)).length, 0);

        const boundary = await keys.create('alice', {
            name: 'boundary', monthly_cap_usd: 2, allowed_models: [],
            expires_at: new Date(now + 1000).toISOString(),
        });
        const stale = await keys.resolve(boundary.secret);
        const firstHold = await keys.reserve(stale, 'model', false, 0.5);
        assert.equal(firstHold.amount, 0.5, 'main retains bounded holds');
        await firstHold.settle({ cost_usd: 0.1 });
        now += 1000;
        assert.equal(await keys.resolve(boundary.secret), undefined, 'expiry is inclusive');
        await assert.rejects(keys.reserve(stale, 'model'), (e) => e.status === 401);
        const ledger = await h.db.prepare('SELECT spent,reserved FROM exchange_key_months WHERE key_id = ?').get(stale.id);
        assert.deepEqual(ledger, { spent: 0.1, reserved: 0 });

        // Expiry after the initial check is still refused by the atomic hold statement.
        const racing = await keys.create('alice', {
            name: 'race', monthly_cap_usd: 2, allowed_models: [],
            expires_at: new Date(now + 1000).toISOString(),
        });
        const raceKey = await keys.resolve(racing.secret);
        const raceDb = { prepare(sql) {
            const statement = h.db.prepare(sql);
            if (sql.startsWith('INSERT INTO exchange_key_months')) return { async run(...args) {
                const result = await statement.run(...args);
                now += 1000;
                return result;
            } };
            return statement;
        } };
        await assert.rejects(createKeys({ db: raceDb, clock: { now: () => now } }).reserve(raceKey, 'model'), (e) => e.status === 429);
        assert.equal((await h.db.prepare('SELECT reserved FROM exchange_key_months WHERE key_id = ?').get(raceKey.id)).reserved, 0);
        assert.equal((await h.db.prepare('SELECT * FROM exchange_key_usage WHERE key_id = ?').all(raceKey.id)).length, 0);
        assert.equal((await keys.list('alice')).length, 3);
        console.log(
            'Expired keys fail authentication and stale-key reservations',
        );
    } finally {
        await h.stop();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
