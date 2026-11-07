'use strict';
// Pooled community offers (ai.offer-pool@1): a pool's offer routes through its head, is verified as one machine is,
// is labelled "Community pool (N machines)", and a pool that is new or failed verification serves the free tier only.
const assert = require('node:assert/strict');
const { boot, suite } = require('./helpers');
const { createCommunity } = require('../server/community');
const pools = require('../server/community/pools');

const t = suite('community pools');
let harness;
async function fresh() {
    if (!harness) harness = await boot({ env: { AI_COMMUNITY: 'false' } });
    await harness.db.prepare('DELETE FROM community_usage').run();
    await harness.db.prepare('DELETE FROM community_offers').run();
    return harness;
}
const owner = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1';
const peerOwner = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A2';
const head = 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2D1';
const member = 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2D2';
const third = 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2D3';
const single = 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2D9';
const FREE = { communityOptIn: true, communityFree: true };
const PAID = { communityOptIn: true };
const ask = { messages: [{ role: 'user', content: 'hello' }] };

const offerDoc = (machine, extra = {}) => ({ offer_id: `ai:${machine}`, machine_id: machine, owner, models: ['pool-model'],
    hours: { start: '00:00', end: '00:00', tz: 'UTC' }, concurrency: 1,
    price: { in_per_million: 1, out_per_million: 2 }, audience: 'everyone', group: null,
    ready: true, health: { status: 'up' }, ...extra });
const poolDoc = (machines = [head, member]) => offerDoc(head, { pool: { machines, head } });

/**
 * A community module over fake Network offers and fake machines. `answers[machine]` is how a machine answers:
 * 'good' passes every canary, 'bad' fails the arithmetic canary, 'odd' passes canaries but answers prompts differently.
 */
function setup(db, docs, answers = {}, { spotRate = 0 } = {}) {
    const calls = [];
    const community = createCommunity({ db, config: { networkInternalUrl: 'http://network.test', community: { enabled: true, refreshMs: 1, spotRate } },
        env: {}, tokens: { getToken: async () => 'test-token' },
        fetchImpl: async () => ({ ok: true, json: async () => ({ offers: docs }) }),
        machines: { enabled: true, chat: async (request) => {
            calls.push(request);
            const how = answers[request.machine] || 'good';
            const message = request.messages.at(-1).content;
            const text = message.includes('OPENVIBE-CANARY') ? 'OPENVIBE-CANARY-7F3A'
                : message.includes('17 + 25') ? (how === 'bad' ? '41' : '42')
                    : message.includes('canary-ok') ? 'canary-ok'
                        : how === 'odd' ? 'purple elephants dance quietly tonight' : 'Hello from the answering machine';
            return { text, model: request.model, usage: { input: 10, output: 5 } };
        } }, log: { warn() {} }, random: () => 0 });
    return { community, calls };
}
const usage = async (db) => db.prepare('SELECT credits_micro, verified, earning_status FROM community_usage ORDER BY created_at').all();

t.test('a pool offer routes through its head, verifies like one machine, and is labelled', async () => {
    const h = await fresh();
    const { community: c, calls } = setup(h.db, [poolDoc()]);
    const [offer] = await c.offers();
    assert.deepEqual(offer.pool, { machines: [head, member].sort(), head });
    assert.equal(await c.choose({ ctx: PAID, operation: 'chat' }), null, 'a new pool cannot receive paid work');
    const out = await c.execute({ ctx: { ...FREE, runId: 'pool-1' }, req: ask });
    assert.equal(out.explain.community.label, 'Community pool (2 machines)');
    assert.equal(out.explain.community.kind, 'pool');
    assert.deepEqual(out.explain.community.pool, offer.pool);
    assert.equal(out.explain.community.verification, 'verified', 'the canary round ran on the pool');
    assert.equal(calls.length, 4, 'three canaries and the prompt');
    assert.ok(calls.every((r) => r.machine === head && r.community === true), 'canaries and prompts all go to the head');
    assert.ok(calls.every((r) => r.machine !== member), 'a member is never addressed directly');
    // Verified once, like one machine: the next request is just the prompt.
    await c.execute({ ctx: { ...PAID, runId: 'pool-2' }, req: ask });
    assert.equal(calls.length, 5, 'no canary round on every request');
    assert.ok(await c.choose({ ctx: PAID, operation: 'chat' }), 'a verified pool may serve paid work');
    const rows = await usage(h.db);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].verified, true);
    assert.ok(Number(rows[1].credits_micro) > 0, 'a verified pool earns');

    const pub = (await c.publicOffers())[0];
    assert.equal(pub.kind, 'pool');
    assert.equal(pub.label, 'Community pool (2 machines)');
    assert.equal(pub.free_only, false);
    assert.equal(pub.verified, true);
    assert.equal(pub.pool.machines.length, 2);
    assert.ok(pub.pool.machines.includes(pub.pool.head));
    const shown = JSON.stringify(pub);
    assert.ok(!shown.includes(owner) && !shown.includes(head) && !shown.includes(member), 'no owner or machine id is public');

    const sold = await c.sell(owner);
    assert.equal(sold.offers[0].kind, 'pool');
    assert.equal(sold.offers[0].label, 'Community pool (2 machines)');
    assert.equal(sold.offers[0].verified, true);
});

t.test('a pool that fails verification serves the free tier only, earns nothing, and is labelled failed', async () => {
    const h = await fresh();
    const { community: c, calls } = setup(h.db, [poolDoc()], { [head]: 'bad' });
    const first = await c.execute({ ctx: { ...FREE, runId: 'failed-1' }, req: ask });
    assert.equal(first.explain.community.verification, 'failed');
    assert.equal(first.explain.community.label, 'Community pool (2 machines)');
    assert.match(first.explain.attempts[0].why, /free tier only/);
    assert.equal(await c.choose({ ctx: PAID, operation: 'chat' }), null, 'a failed pool never gets paid work');
    assert.ok(await c.choose({ ctx: FREE, operation: 'chat' }), 'a failed pool stays on the free tier');
    const before = calls.length;
    const second = await c.execute({ ctx: { ...FREE, runId: 'failed-2' }, req: ask });
    assert.equal(second.explain.community.verification, 'failed');
    assert.equal(calls.length, before + 1, 'a failed pool is not re-verified by traffic');
    const rows = await usage(h.db);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => Number(r.credits_micro) === 0 && r.verified === false), 'nothing earned on a failed pool');
    const pub = (await c.publicOffers())[0];
    assert.equal(pub.free_only, true);
    assert.equal(pub.verified, false);
});

t.test('a single machine that fails is still not used, even for the free tier', async () => {
    const h = await fresh();
    const { community: c } = setup(h.db, [offerDoc(single)], { [single]: 'bad' });
    await assert.rejects(c.execute({ ctx: { ...FREE, runId: 'single-1' }, req: ask }), (err) => err.code === 'community.verification_failed');
    assert.equal(await c.choose({ ctx: FREE, operation: 'chat' }), null);
    assert.equal((await c.publicOffers())[0].label, 'Community');
});

t.test('a spot re-run that disagrees drops the answer and leaves the pool free tier only', async () => {
    const h = await fresh();
    // A dearer trusted machine of another owner: the cheaper pool is chosen first, the peer re-runs the spot.
    const peer = { ...offerDoc(single), owner: peerOwner, price: { in_per_million: 5, out_per_million: 5 } };
    const { community: c } = setup(h.db, [poolDoc(), peer], { [head]: 'odd' }, { spotRate: 1 });
    const peerOffer = (await c.offers()).find((o) => !o.pool);
    await c.verify(peerOffer, 'pool-model');
    // A paid request on the verified pool: the canaries pass, then the spot re-run on the trusted peer disagrees.
    const poolOffer = (await c.offers()).find((o) => o.pool);
    await c.verify(poolOffer, 'pool-model');
    await assert.rejects(c.execute({ ctx: { ...PAID, communityModel: 'pool-model', runId: 'spot-1' }, req: ask }),
        (err) => err.code === 'community.verification_failed', 'the disagreeing answer is not returned');
    const left = await c.choose({ ctx: PAID, operation: 'chat' });
    assert.ok(left && !left.offer.pool, 'the pool lost paid work; the trusted machine keeps it');
    const pub = (await c.publicOffers()).find((o) => o.kind === 'pool');
    assert.equal(pub.free_only, true);
    // Without the peer, the failed pool still answers the free tier, and only the free tier.
    const alone = setup(h.db, [poolDoc()], { [head]: 'odd' });
    assert.equal(await alone.community.choose({ ctx: PAID, operation: 'chat' }), null);
    const freeOut = await alone.community.execute({ ctx: { ...FREE, runId: 'spot-2' }, req: ask });
    assert.equal(freeOut.explain.community.verification, 'failed');
    assert.equal(freeOut.explain.community.credits_micro, 0);
});

t.test('another member or head is a new, unverified pool', async () => {
    const h = await fresh();
    const a = setup(h.db, [poolDoc()]);
    await a.community.execute({ ctx: { ...FREE, runId: 'm-1' }, req: ask });
    assert.ok(await a.community.choose({ ctx: PAID, operation: 'chat' }), 'verified as [head, member]');
    const b = setup(h.db, [poolDoc([head, member, third])]);
    assert.equal(await b.community.choose({ ctx: PAID, operation: 'chat' }), null, 'a third member makes it unverified again');
    const out = await b.community.execute({ ctx: { ...FREE, runId: 'm-2' }, req: ask });
    assert.equal(out.explain.community.label, 'Community pool (3 machines)');
    assert.equal(b.calls.length, 4, 'the new membership runs its own canary round');
});

t.test('a malformed pool fails closed', async () => {
    const valid = pools.poolOf({ machines: [member, head], head }, head);
    assert.deepEqual(valid, { machines: [head, member].sort(), head });
    const bad = [
        { machines: [head, head], head },
        { machines: [head, member], head: third },
        { machines: [head], head },
        { machines: [head, member], head, address: '192.168.1.2/24' },
        { machines: [head, member], head, certificates: ['-----BEGIN CERTIFICATE-----'] },
        { machines: [head, 'node:abc'], head },
        { machines: Array.from({ length: 9 }, (_, i) => `dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2E${i}`), head: 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2E0' },
        [head, member],
        'pool',
    ];
    for (const value of bad) assert.equal(pools.poolOf(value, head), null, JSON.stringify(value));
    assert.equal(pools.poolOf({ machines: [head, member], head: member }, head), null, 'the head is the offer\'s own machine');
    assert.notEqual(pools.identity(valid), pools.identity({ machines: [head, third].sort(), head }));
    assert.equal(pools.identity(null), '', 'one machine keeps its verification key');
    assert.equal(pools.label(null), 'Community');
    const h = await fresh();
    const doc = poolDoc(); doc.pool.head = third;
    assert.deepEqual(await setup(h.db, [doc]).community.offers(), [], 'an offer with a malformed pool is dropped whole');
});

t.test('close the isolated test server', async () => { if (harness) await harness.stop(); });
t.run();
