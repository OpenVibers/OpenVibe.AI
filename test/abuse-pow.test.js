'use strict';
// Plan E5 proof of work (server/abuse/pow.js): a hashcash challenge, issued and stored as its hash, accepted once.
const assert = require('assert');
const { suite } = require('./helpers');
const { testDb } = require('./db');
const { createPow, zeroBits, solve, digest } = require('../server/abuse/pow');

const t = suite('abuse-pow');
let tdb;
let now = Date.UTC(2026, 10, 6, 12, 0, 0);
const clock = { now: () => now };

t.test('a migrated database', async () => { tdb = await testDb(); });

t.test('leading zero bits', () => {
    assert.strictEqual(zeroBits(Buffer.from([0xff])), 0);
    assert.strictEqual(zeroBits(Buffer.from([0x7f])), 1);
    assert.strictEqual(zeroBits(Buffer.from([0x00, 0x0f])), 12);
    assert.strictEqual(zeroBits(Buffer.from([0x00, 0x00, 0x01])), 23);
});

t.test('a solved challenge is accepted exactly once', async () => {
    const pow = createPow({ db: tdb.db, clock, bits: 6, ttlMs: 60_000 });
    const issued = await pow.issue({ deviceHash: 'a'.repeat(64) });
    assert.strictEqual(issued.bits, 6);
    const nonce = solve(issued.challenge, 6);
    const token = `${issued.challenge}:${nonce}`;
    assert.strictEqual(await pow.verify(token, { deviceHash: 'a'.repeat(64) }), true);
    assert.strictEqual(await pow.verify(token, { deviceHash: 'a'.repeat(64) }), false, 'single use');
});

t.test('a wrong nonce, an expired challenge and another device are refused', async () => {
    const pow = createPow({ db: tdb.db, clock, bits: 5, ttlMs: 60_000 });
    const one = await pow.issue({});
    assert.strictEqual(await pow.verify(`${one.challenge}:0`, {}), false);
    const two = await pow.issue({ deviceHash: 'b'.repeat(64) });
    const good = `${two.challenge}:${solve(two.challenge, 5)}`;
    assert.strictEqual(await pow.verify(good, { deviceHash: 'c'.repeat(64) }), false, 'issued for one device');
    const three = await pow.issue({});
    const saved = now;
    now += 61_000;
    assert.strictEqual(await pow.verify(`${three.challenge}:${solve(three.challenge, 5)}`, {}), false, 'expired');
    now = saved;
});

t.test('the database keeps the challenge hash, never the challenge', async () => {
    const pow = createPow({ db: tdb.db, clock, bits: 4 });
    const issued = await pow.issue({});
    const rows = await tdb.db.prepare('SELECT * FROM abuse_pow').all();
    assert.ok(rows.some((r) => r.challenge_hash === digestHash(issued.challenge)));
    assert.ok(!rows.some((r) => JSON.stringify(r).includes(issued.challenge)));
});

function digestHash(challenge) {
    return require('crypto').createHash('sha256').update(challenge).digest('hex');
}

t.test('stop', async () => { await tdb.close(); });

t.run();
