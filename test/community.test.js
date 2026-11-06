'use strict';
// Community AI offers (the design's "Offer to the network"; plan E4): only an opted-in request may run on a person's
// machine; a new machine serves the free tier only; canaries and the model fingerprint verify it before traffic; a
// failed canary stops it; verified tokens are recorded in credits (never cash); /sell reads them back.
const assert = require('assert');
const { boot, suite } = require('./helpers');
const { createCommunity, withinHours, fingerprintMatches, similar } = require('../server/community');

const OWNER = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1';
const OTHER = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2B2';
const MACHINE = 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2D1';
const t = suite('community');

function offerDoc(over = {}) {
    return {
        offer_id: `ai:${MACHINE}`, machine_id: MACHINE, owner: OWNER,
        models: ['llama3.1:8b'], hours: { start: '00:00', end: '23:59', tz: 'UTC' }, concurrency: 1,
        price: { in_per_million: 10, out_per_million: 30 }, audience: 'everyone', group: null, ready: true,
        health: { status: 'up' }, ...over,
    };
}

/** A fake Node model server: canaries answer correctly, everything else echoes the last user message. */
function fakeMachines({ canary = true, spotAnswer = null } = {}) {
    const calls = [];
    return {
        enabled: true, calls,
        async chat({ machine, model, messages, community }) {
            calls.push({ machine, model, messages, community });
            const last = messages[messages.length - 1].content;
            let text;
            if (last.includes('OPENVIBE-CANARY')) text = 'OPENVIBE-CANARY-7F3A';
            else if (last.includes('17 + 25')) text = canary ? '42' : '41';
            else if (last.includes('canary-ok')) text = 'canary-ok';
            else text = spotAnswer != null ? spotAnswer : `You said: ${last}`;
            return { text, message: { role: 'assistant', content: text }, model, usage: { input: 10, output: 5 }, finish: 'stop' };
        },
    };
}

async function communityFor(db, machines, { docs = [offerDoc()], followers = [], merges = {}, dailyCapMicro = 100000000 } = {}) {
    const fetchImpl = async (url) => {
        if (url.includes('/internal/ai/offers')) return { ok: true, json: async () => ({ offers: docs }) };
        if (url.includes('/followers')) return { ok: true, json: async () => ({ follows: followers.map((f) => ({ follower: f })), next_cursor: null }) };
        if (url.includes('/internal/identity/resolve')) {
            const id = decodeURIComponent(String(url).split('subject_id=')[1] || '');
            const survivor = merges[id] || id;
            return { ok: true, json: async () => ({ subject: { id: survivor } }) };
        }
        return { ok: false, status: 404, json: async () => null };
    };
    let ms = Date.parse('2026-11-06T12:00:00Z');
    return createCommunity({
        db, machines, fetchImpl, clock: { now: () => ms }, random: () => 0,
        config: { networkInternalUrl: 'http://network.test', console: { clientId: 'ai' }, community: { enabled: true, refreshMs: 1000, canaryMaxAgeMs: 21600000, spotRate: 0, canaryTimeoutMs: 5000, trustDays: 7, dailyEarningCapMicro: dailyCapMicro, kudosPerThousandTokens: 1 } },
        env: {}, tokens: { getToken: async () => 'test-token' }, log: { warn() {}, error() {} },
    });
}

t.test('only an opted-in request is placed on a community machine', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        const machines = fakeMachines();
        const c = await communityFor(h.db, machines);
        assert.strictEqual(await c.execute({ operation: 'chat', req: { messages: [{ role: 'user', content: 'hi' }] }, ctx: { runId: 'x' } }), null);
        assert.strictEqual(machines.calls.length, 0, 'nothing reaches a person\'s machine unless the request opts in');
        assert.ok(await c.choose({ ctx: { communityOptIn: true, creditsRequired: true }, operation: 'chat' }));
    } finally { await h.stop(); }
});

t.test('a new machine serves the free tier only until verified', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        const c = await communityFor(h.db, fakeMachines());
        assert.strictEqual(await c.choose({ ctx: { communityOptIn: true, creditsRequired: false }, operation: 'chat' }), null, 'not a paid run');
        const free = await c.choose({ ctx: { communityOptIn: true, creditsRequired: true }, operation: 'chat' });
        assert.ok(free, 'a free-tier run may use it');
        const out = await c.execute({ operation: 'chat', req: { messages: [{ role: 'user', content: 'hello' }] }, ctx: { communityOptIn: true, creditsRequired: true, runId: 'r1' } });
        assert.ok(out.provider.startsWith('community:'), out.provider);
        assert.strictEqual(out.explain.community.machine_id, MACHINE);
        assert.strictEqual(out.explain.openvibe.community.owner, OWNER, 'the answer says whose machine it came from');
        const verified = await c.offers();
        assert.ok(verified.length);
        assert.ok(await c.choose({ ctx: { communityOptIn: true, creditsRequired: false }, operation: 'chat' }), 'verified: a paid run may use it');
        const sell = await c.sell(OWNER);
        assert.strictEqual(sell.totals.requests, 1, 'the served request is on the seller dashboard');
        assert.deepStrictEqual([sell.totals.tokens_in, sell.totals.tokens_out], [10, 5]);
        assert.ok(sell.totals.pending_credits_micro > 0, 'verified tokens are recorded as pending credits');
        assert.strictEqual(sell.totals.spendable_credits_micro, 0, 'nothing is spendable until the requester was charged');
        assert.match(sell.note, /pending, not spendable/);
        assert.strictEqual(sell.offers[0].verification.status, 'verified');
        assert.strictEqual(sell.offers[0].free_only, false);
    } finally { await h.stop(); }
});

t.test('the Anthropic messages operation gets an Anthropic message back', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        const c = await communityFor(h.db, fakeMachines());
        const out = await c.execute({ operation: 'messages', req: { system: 'Be brief.', messages: [{ role: 'user', content: 'hello' }] },
            ctx: { communityOptIn: true, creditsRequired: true, runId: 'rm1' } });
        assert.ok(out, 'a community answer');
        assert.deepStrictEqual(out.result.message.content, [{ type: 'text', text: 'You said: hello' }]);
        assert.strictEqual(out.result.message.role, 'assistant');
    } finally { await h.stop(); }
});

t.test('a wrong canary fails verification and stops that machine', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        const machines = fakeMachines({ canary: false });
        const c = await communityFor(h.db, machines);
        const ctx = { communityOptIn: true, creditsRequired: true, runId: 'r2' };
        await assert.rejects(() => c.execute({ operation: 'chat', req: { messages: [{ role: 'user', content: 'hi' }] }, ctx }),
            (err) => err.code === 'community.verification_failed');
        assert.strictEqual(await c.choose({ ctx, operation: 'chat' }), null, 'a failed machine is never chosen again');
        const sell = await c.sell(OWNER);
        assert.strictEqual(sell.offers[0].verification.status, 'failed');
        assert.strictEqual(sell.offers[0].reputation, 0);
        assert.strictEqual(sell.totals.pending_credits_micro, 0, 'a failed canary earns nothing');
    } finally { await h.stop(); }
});

t.test('a model fingerprint must be the model the owner declared', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        const machines = fakeMachines();
        machines.chat = async (args) => ({ ...(await fakeMachines().chat(args)), model: 'some-other-model:7b' });
        const c = await communityFor(h.db, machines);
        await assert.rejects(() => c.execute({ operation: 'chat', req: { messages: [{ role: 'user', content: 'hi' }] }, ctx: { communityOptIn: true, creditsRequired: true, runId: 'r3' } }),
            (err) => err.code === 'community.verification_failed');
        assert.ok(fingerprintMatches('llama3.1:8b-q4', 'llama3.1:8b'));
        assert.ok(!fingerprintMatches('qwen2.5:7b', 'llama3.1:8b'));
        assert.ok(similar('A lock one thread holds at a time.', 'a lock one thread holds at a time'));
    } finally { await h.stop(); }
});

t.test('the offer hours are checked by the router too, in the owner time zone', async () => {
    const h = { start: '09:00', end: '17:00', tz: 'UTC' };
    const at = (iso) => Date.parse(iso);
    assert.ok(withinHours({ hours: h }, at('2026-11-06T12:00:00Z')));
    assert.ok(!withinHours({ hours: h }, at('2026-11-06T02:00:00Z')));
    assert.ok(withinHours({ hours: { start: '22:00', end: '06:00', tz: 'UTC' } }, at('2026-11-06T23:00:00Z')), 'overnight wraps');
    assert.ok(!withinHours({ hours: { start: '22:00', end: '06:00', tz: 'UTC' } }, at('2026-11-06T12:00:00Z')));
    assert.ok(withinHours({ hours: { start: '00:00', end: '00:00', tz: 'UTC' } }, at('2026-11-06T12:00:00Z')), 'start == end is all day');
});

t.test('a run by the offer owner is self-served: zero credits, labelled', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        const c = await communityFor(h.db, fakeMachines());
        const out = await c.execute({ operation: 'chat', req: { messages: [{ role: 'user', content: 'hi' }] },
            ctx: { communityOptIn: true, creditsRequired: true, onBehalfOf: OWNER, runId: 'self1' } });
        assert.strictEqual(out.explain.community.self_served, true);
        assert.strictEqual(out.explain.community.credits_micro, 0);
        assert.match(out.explain.reasons[0], /self-served/);
        const sell = await c.sell(OWNER);
        assert.strictEqual(sell.totals.self_served_requests, 1);
        assert.strictEqual(sell.totals.pending_credits_micro, 0);
    } finally { await h.stop(); }
});

t.test('a requester merged into the owner is self-served too', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        const c = await communityFor(h.db, fakeMachines(), { merges: { [OTHER]: OWNER } });
        const out = await c.execute({ operation: 'chat', req: { messages: [{ role: 'user', content: 'hi' }] },
            ctx: { communityOptIn: true, creditsRequired: true, onBehalfOf: OTHER, runId: 'merged1' } });
        assert.strictEqual(out.explain.community.self_served, true);
        assert.strictEqual(out.explain.community.credits_micro, 0);
    } finally { await h.stop(); }
});

t.test('a new machine\'s seller earnings are capped by the day', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        const c = await communityFor(h.db, fakeMachines(), { dailyCapMicro: 1 });
        const out = await c.execute({ operation: 'chat', req: { messages: [{ role: 'user', content: 'hi' }] },
            ctx: { communityOptIn: true, creditsRequired: true, onBehalfOf: OTHER, runId: 'cap1' } });
        assert.strictEqual(out.explain.community.earning_status, 'capped');
        assert.strictEqual(out.explain.community.credits_micro, 1, 'the daily cap is one micro-credit');
        const sell = await c.sell(OWNER);
        assert.strictEqual(sell.offers[0].daily_cap.earned_today_micro, 1);
        assert.ok(sell.offers[0].daily_cap.trust_ends_at);
    } finally { await h.stop(); }
});

t.test('a volunteer earns kudos, never cash', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        const c = await communityFor(h.db, fakeMachines(), { docs: [offerDoc({ price: { in_per_million: 0, out_per_million: 0 } })] });
        const out = await c.execute({ operation: 'chat', req: { messages: [{ role: 'user', content: 'hi' }] },
            ctx: { communityOptIn: true, creditsRequired: true, onBehalfOf: OTHER, runId: 'kudos1' } });
        assert.ok(out.explain.community.kudos > 0);
        const sell = await c.sell(OWNER);
        assert.ok(sell.kudos.balance > 0);
        assert.strictEqual(sell.kudos.never_cash, true);
        assert.strictEqual(sell.kudos.never_expires, true);
        assert.ok(sell.kudos.benefits.queue_priority >= 0);
        assert.ok(sell.kudos.benefits.free_allowance_bonus_tokens > 0);
        assert.strictEqual(await c.queuePriority(OWNER), sell.kudos.benefits.queue_priority);
        assert.strictEqual(await c.kudosBonus(`user:${OWNER}`), sell.kudos.benefits.free_allowance_bonus_tokens);
        assert.strictEqual(sell.totals.pending_credits_micro, 0, 'a volunteer earns no credits');
    } finally { await h.stop(); }
});

t.test('a canary/spot failure rate resets reputation', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        const c = await communityFor(h.db, fakeMachines());
        const key = `${offerDoc().offer_id}|llama3.1:8b`;
        await h.db.prepare(`INSERT INTO community_offers (offer_key, offer_id, machine_id, owner_subject, model, models, price_in, price_out, status,
            canary_passes, canary_failures, checks, up_checks, reputation, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'llama3.1:8b', '["llama3.1:8b"]', 10, 30, 'verified', 9, 2, 4, 4, 90, now(), now())`)
            .run(key, offerDoc().offer_id, MACHINE, OWNER);
        await c._test.refreshReputation(key);
        const row = await h.db.prepare('SELECT reputation FROM community_offers WHERE offer_key = ?').get(key);
        assert.strictEqual(Number(row.reputation), 0, '2 failures out of 11 attempts resets it');
    } finally { await h.stop(); }
});

t.test('followers and groups are enforced, everyone is open', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        const c = await communityFor(h.db, fakeMachines(), { docs: [offerDoc({ audience: 'followers' })], followers: [OTHER] });
        assert.ok(await c.choose({ ctx: { communityOptIn: true, creditsRequired: true, onBehalfOf: OTHER }, operation: 'chat' }), 'a follower may use it');
        assert.strictEqual(await c.choose({ ctx: { communityOptIn: true, creditsRequired: true, onBehalfOf: OWNER }, operation: 'chat' }), null, 'someone else may not');
        const g = await communityFor(h.db, fakeMachines(), { docs: [offerDoc({ audience: 'group', group: 'team-a' })] });
        assert.ok(await g.choose({ ctx: { communityOptIn: true, creditsRequired: true, communityGroup: 'team-a' }, operation: 'chat' }));
        assert.strictEqual(await g.choose({ ctx: { communityOptIn: true, creditsRequired: true, communityGroup: 'team-b' }, operation: 'chat' }), null);
    } finally { await h.stop(); }
});

t.run();
