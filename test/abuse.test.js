'use strict';
// Plan E5: the abuse module itself (server/abuse/index.js): device signatures, the trust-tier allowance, a shared
// device allowance, the ASN override, the rate limit, the anomaly throttle, proof of work and the operator view.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { suite, tmpDir, silent } = require('./helpers');
const { testDb } = require('./db');
const { load } = require('../server/config');
const { createAbuse } = require('../server/abuse');
const { solve } = require('../server/abuse/pow');

const t = suite('abuse');
const USER = (n) => `usr_01JAB2C3D4E5F6G7H8J9K0MN${String(n).padStart(2, '0').slice(-2)}`;
const DAY = 86_400_000;
let tdb;
let now = Date.UTC(2026, 10, 6, 12, 0, 0);
const clock = { now: () => now };
const BASE = {
    NODE_ENV: 'test', AI_ABUSE_SALT: 'a-test-salt', AI_FREE_DAILY_TOKENS: '1000', AI_ABUSE_NETWORK: '0',
    AI_ABUSE_RATE_PER_MIN: '1000', AI_ABUSE_HOSTING_RATE_PER_MIN: '1000', AI_ABUSE_VELOCITY_MIN_TOKENS_PER_MIN: '10000',
};

function make(overrides = {}, extra = {}) {
    const env = { ...BASE, ...overrides };
    return createAbuse({
        db: tdb.db, config: load(env), env, clock, log: silent,
        community: { kudosBonus: async () => 0 }, ...extra,
    });
}

const device = (abuse, id = 'device-one') => abuse._test.keyed('device', id);

async function clear() {
    for (const table of ['abuse_daily_usage', 'abuse_devices', 'abuse_velocity', 'abuse_network_seen', 'abuse_pow']) {
        await tdb.db.prepare(`DELETE FROM ${table}`).run();
    }
}

t.test('a migrated database', async () => { tdb = await testDb(); });

t.test('the signed device id survives a round trip and refuses a tamper', () => {
    const abuse = make();
    const { id, token } = (() => { const id = 'abcdefghijklmnopqrstuvwx'; return { id, token: abuse._test.signDevice(id) }; })();
    assert.strictEqual(abuse._test.verifyDevice(token), id);
    assert.strictEqual(abuse._test.verifyDevice(token.replace(/.$/, '0')), null);
    assert.strictEqual(abuse._test.verifyDevice(`${token}.x`), null);
    assert.strictEqual(abuse._test.verifyDevice(abuse._test.signDevice('abcdefghijklmnop')), 'abcdefghijklmnop');
});

t.test('a new account gets a quarter, records its tokens, and is refused when the day is spent', async () => {
    await clear();
    const abuse = make();
    const request = { deviceHash: device(abuse, 'allowance') };
    const first = await abuse.admit({ ctx: { requesterType: 'user', requesterId: USER(1) }, request, free: true });
    assert.strictEqual(first.tier, 'new');
    assert.strictEqual(first.allowance, 250);
    assert.strictEqual(first.key, `user:${USER(1)}`);
    await abuse.record({ admission: first, tokens: 100, inputHash: 'h1' });
    const second = await abuse.admit({ ctx: { requesterType: 'user', requesterId: USER(1) }, request, free: true });
    assert.strictEqual(second.allowance, 250, 'still the same day');
    await abuse.record({ admission: second, tokens: 200, inputHash: 'h2' });
    await assert.rejects(
        () => abuse.admit({ ctx: { requesterType: 'user', requesterId: USER(1) }, request, free: true }),
        (err) => err.status === 402 && err.code === 'ai.allowance_spent' && /250 tokens/.test(err.detail),
    );
});

t.test('more than three accounts on one device share one allowance, at the lowest tier', async () => {
    await clear();
    const abuse = make({ AI_FREE_DAILY_TOKENS: '4000' });
    const hash = device(abuse, 'family');
    const keys = [];
    for (let i = 1; i <= 4; i++) {
        const a = await abuse.admit({ ctx: { requesterType: 'user', requesterId: USER(i) }, request: { deviceHash: hash }, free: true });
        keys.push(a);
    }
    assert.strictEqual(keys[3].accounts, 4);
    assert.strictEqual(keys[3].shared, true, 'the fourth account makes it shared');
    assert.strictEqual(keys[3].key, `device:${hash}`);
    assert.strictEqual(keys[3].allowance, 1000, 'a quarter of 4000, the lowest tier on the device');
    await abuse.record({ admission: keys[3], tokens: 1000, inputHash: 'shared' });
    await assert.rejects(
        () => abuse.admit({ ctx: { requesterType: 'user', requesterId: USER(2) }, request: { deviceHash: hash }, free: true }),
        (err) => err.status === 402 && err.code === 'ai.allowance_spent',
        'one account cannot spend a second allowance on the shared device',
    );
});

t.test('a hosting ASN is the new tier and a lower rate whatever Network says', async () => {
    await clear();
    const dir = tmpDir();
    const v4 = path.join(dir, 'ip2asn-v4.tsv');
    fs.writeFileSync(v4, '5.0.0.0\t5.255.255.255\t64500\tDE\tExample Hosting GmbH\n9.9.9.0\t9.9.9.255\t19281\tUS\tQuad9\n');
    const seen = [];
    const fetchImpl = async (url) => {
        seen.push(url);
        return { ok: true, status: 200, json: async () => ({ subject: { type: 'user', id: USER(1) }, trust: { account_age_hours: 900, account_age_days: 37, verified: true, verified_by: ['passkey'], passkey: true, linked_accounts: 0, active_30d: true } }) };
    };
    const abuse = make({ AI_ABUSE_NETWORK: '1', AI_IP2ASN_V4: v4, AI_IP2ASN_V6: '' }, { fetchImpl, tokens: { getToken: async () => 'service-token' } });
    const exchange = { subject: { type: 'service', id: 'exchange' } };
    const hosted = await abuse.admit({
        principal: exchange, ctx: { requesterType: 'service', requesterId: 'exchange', onBehalfOf: USER(1) },
        request: { explicitIp: '5.1.2.3', deviceHash: device(abuse, 'hosted') }, free: true,
    });
    assert.strictEqual(hosted.asn, 64500);
    assert.strictEqual(hosted.hosting, true);
    assert.strictEqual(hosted.tier, 'new');
    assert.strictEqual(hosted.allowance, 250);
    assert.ok(seen.some((u) => /&trust=1/.test(u)), 'the identity read asked for trust');
    const home = await abuse.admit({
        principal: exchange, ctx: { requesterType: 'service', requesterId: 'exchange', onBehalfOf: USER(1) },
        request: { explicitIp: '9.9.9.9', deviceHash: device(abuse, 'home') }, free: true,
    });
    assert.strictEqual(home.hosting, false);
    assert.strictEqual(home.tier, 'verified');
    assert.strictEqual(home.allowance, 1000);
});

t.test('the rate limit is per device and per ASN; the hosting rate is lower', async () => {
    await clear();
    const abuse = make({ AI_ABUSE_RATE_PER_MIN: '2', AI_ABUSE_HOSTING_RATE_PER_MIN: '1' });
    const hash = device(abuse, 'rate');
    await abuse.admit({ ctx: { requesterType: 'user', requesterId: USER(2) }, request: { deviceHash: hash }, free: true });
    await abuse.admit({ ctx: { requesterType: 'user', requesterId: USER(2) }, request: { deviceHash: hash }, free: true });
    await assert.rejects(
        () => abuse.admit({ ctx: { requesterType: 'user', requesterId: USER(2) }, request: { deviceHash: hash }, free: true }),
        (err) => err.status === 429 && err.code === 'ai.rate_limited',
    );
    assert.strictEqual(abuse.gaugeValues().find((g) => g.labels.reason === 'network').value, 1);
});

t.test('free tokens per minute above the last week\'s baseline are throttled, with an operator event', async () => {
    await clear();
    const audits = [];
    const abuse = make({ AI_FREE_DAILY_TOKENS: '100000' }, { registry: { audit: async (...args) => audits.push(args) } });
    const hash = device(abuse, 'velocity');
    const first = await abuse.admit({ ctx: { requesterType: 'user', requesterId: USER(3) }, request: { deviceHash: hash }, free: true });
    await abuse.record({ admission: first, tokens: 15000, inputHash: 'same-prompt' });
    await assert.rejects(
        () => abuse.admit({ ctx: { requesterType: 'user', requesterId: USER(3) }, request: { deviceHash: hash }, free: true, inputHash: 'same-prompt' }),
        (err) => err.status === 429 && err.code === 'ai.abuse_throttled' && /paused/.test(err.detail),
    );
    assert.ok(audits.some((a) => a[1] === 'abuse.throttled'), 'the audit log has the throttle');
    assert.strictEqual(abuse.gaugeValues().find((g) => g.labels.reason === 'velocity').value, 1);
});

t.test('the anonymous Try it needs one proof of work, accepted once', async () => {
    await clear();
    const abuse = make({ AI_POW_REQUIRED: '1', AI_POW_BITS: '4', AI_FREE_DAILY_TOKENS: '1000' });
    const hash = device(abuse, 'anonymous');
    const ctx = { requesterType: 'service', requesterId: 'exchange' };
    await assert.rejects(
        () => abuse.admit({ ctx, request: { deviceHash: hash }, free: true, anonymous: true }),
        (err) => err.status === 403 && err.code === 'ai.pow_required',
    );
    const issued = await abuse.issueChallenge({ meta: { deviceHash: hash } });
    const token = `${issued.challenge}:${solve(issued.challenge, issued.bits)}`;
    const a = await abuse.admit({ ctx, request: { deviceHash: hash, pow: token }, free: true, anonymous: true });
    assert.strictEqual(a.anonymous, true);
    assert.strictEqual(a.subject, null);
    await assert.rejects(
        () => abuse.admit({ ctx, request: { deviceHash: hash, pow: token }, free: true, anonymous: true }),
        (err) => err.status === 403 && err.code === 'ai.pow_invalid',
    );
});

t.test('the operator view lists recent events and today\'s counters; prune removes expired rows', async () => {
    await clear();
    const abuse = make();
    await tdb.db.prepare(`INSERT INTO audit_log (at, actor, action, target_type, target_id, metadata) VALUES (?, 'system', 'abuse.throttled', 'abuse', 'velocity:input', '{"reason":"velocity","kind":"input"}')`)
        .run(new Date(now - 1000).toISOString());
    await tdb.db.prepare('INSERT INTO abuse_daily_usage (subject, day, tokens, updated_at) VALUES (?, ?, 5, ?)').run(`user:${USER(1)}`, new Date(now).toISOString().slice(0, 10), new Date(now).toISOString());
    const out = await abuse.overview();
    assert.strictEqual(out.events[0].action, 'abuse.throttled');
    assert.strictEqual(out.events[0].metadata.reason, 'velocity');
    assert.deepStrictEqual(out.usage[0], { subject: `user:${USER(1)}`, tokens: 5 });
    const html = require('../server/console/views').pages.abuse({ staff: { subject: USER(1), username: 'op', role: 'owner' }, csrf: 'c', report: out });
    assert.ok(html.includes('Abuse prevention') && html.includes('abuse.throttled'), 'the operator page renders the events');
    await tdb.db.prepare('INSERT INTO abuse_network_seen (prefix_hash, asn, hosting, first_seen, last_seen, expires_at) VALUES (?, 1, 0, ?, ?, ?)').run('x', new Date(now).toISOString(), new Date(now).toISOString(), new Date(now - 1000).toISOString());
    await tdb.db.prepare('INSERT INTO abuse_velocity (kind, key_hash, minute, tokens, updated_at) VALUES (?, ?, ?, 1, ?)').run('input', 'y', 1, new Date(now).toISOString());
    await tdb.db.prepare('INSERT INTO abuse_devices (device_hash, subject, first_seen, last_seen) VALUES (?, ?, ?, ?)').run('z', USER(1), new Date(now - 400 * DAY).toISOString(), new Date(now - 400 * DAY).toISOString());
    const removed = await abuse.prune();
    assert.strictEqual(removed.network, 1);
    assert.strictEqual(removed.velocity, 1);
    assert.strictEqual(removed.devices, 1);
});

t.test('stop', async () => { await tdb.close(); });

t.run();
