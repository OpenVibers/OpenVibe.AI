'use strict';
// Community endpoints (the design's SDK gap): a standalone OpenAI-compatible server is registered by its own https
// address, and AI reaches it only through the egress guard. The tests are the guard's own: https only, no IP literal
// (127.0.0.1, 10/8, 169.254.169.254, [::1], a NAT64 spelling), no private DNS answer, no redirect to one; a timeout and
// a response cap; and never the buyer's identity in a header. Then the same trust as a machine running Link: the canaries, the
// model fingerprint, the free tier only until verified, and self-dealing earns 0.
const assert = require('assert');
const { boot, request, token, suite, ALL } = require('./helpers');
const { createEndpointOffers, judgeBaseUrl } = require('../server/community/endpoints');
const { createCommunity } = require('../server/community');
const { buildReceipt } = require('../server/exchange/receipts');

const t = suite('community-endpoints');
const OWNER = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1';
const OTHER = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2B2';
const silent = { log() {}, warn() {}, error() {} };

const INPUT = {
    base_url: 'https://models.example/v1', models: ['qwen3:32b'],
    price: { in_per_million: 10, out_per_million: 30 },
    hours: { start: '00:00', end: '23:59', tz: 'UTC' }, concurrency: 2, audience: 'everyone',
};

function cfg(over = {}) {
    return { networkInternalUrl: 'http://network.test', console: { clientId: 'ai' }, community: { enabled: true, refreshMs: 1000, canaryMaxAgeMs: 21600000, spotRate: 0, canaryTimeoutMs: 5000, trustDays: 7, dailyEarningCapMicro: 100000000, kudosPerThousandTokens: 1, ...over } };
}

function networkFetch(owner = OWNER) {
    return async (url) => {
        if (String(url).includes('/internal/projects/')) return { ok: true, status: 200, json: async () => ({ project: { id: 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1', owner: { type: 'user', id: owner } } }) };
        return { ok: false, status: 404, json: async () => null };
    };
}

/** A scripted OpenAI endpoint: canaries answer correctly; anything else echoes, or says what the test wants. */
function fakeEndpoint({ canary = true, model = 'qwen3:32b', answer = null } = {}) {
    const calls = [];
    const transport = async ({ url, headers, body }) => {
        const request = JSON.parse(body);
        calls.push({ url, headers, request });
        const last = String((request.messages[request.messages.length - 1] || {}).content || '');
        let text;
        if (last.includes('OPENVIBE-CANARY')) text = 'OPENVIBE-CANARY-7F3A';
        else if (last.includes('17 + 25')) text = canary ? '42' : '41';
        else if (last.includes('canary-ok')) text = 'canary-ok';
        else text = answer != null ? answer : `You said: ${last}`;
        return {
            status: 200, headers: {},
            body: JSON.stringify({ model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 5 } }),
        };
    };
    return { calls, transport };
}

function storeFor(db, { transport = null, lookup = null, owner = OWNER, fetchImpl = networkFetch(owner), over = {} } = {}) {
    let ms = Date.parse('2026-11-06T12:00:00Z');
    return createEndpointOffers({
        db, config: cfg(over), env: {}, fetchImpl, transport, lookup,
        clock: { now: () => ms }, log: silent, tokens: { getToken: async () => 'test-token' },
    });
}

t.test('the URL guard is https, a public host name, 443/8443 — never an address', async () => {
    for (const bad of ['http://models.example/v1', 'https://127.0.0.1/v1', 'https://10.0.0.1/v1', 'https://169.254.169.254/latest',
        'https://[::1]/v1', 'https://[64:ff9b::7f00:1]/v1', 'https://localhost/v1', 'https://models.local/v1',
        'https://user:pass@models.example/v1', 'https://models.example:8080/v1', 'https://models.example/v1?x=1']) {
        assert.throws(() => judgeBaseUrl(bad), /https|IP address|public host|credentials|port 443|query or fragment/, bad);
    }
    assert.strictEqual(String(judgeBaseUrl('https://models.example/v1')), 'https://models.example/v1');
    assert.strictEqual(judgeBaseUrl('https://models.example/').pathname, '/');
    assert.strictEqual(judgeBaseUrl('https://models.example:8443/v1').port, '8443');
});

t.test('the registration checks models, hours, time zone, price, concurrency and audience', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        const store = storeFor(h.db);
        const bad = [
            [{ ...INPUT, models: [] }, /models/], [{ ...INPUT, models: ['a', 'a'] }, /models/],
            [{ ...INPUT, hours: { start: '25:00', end: '01:00', tz: 'UTC' } }, /hours/],
            [{ ...INPUT, hours: { start: '00:00', end: '01:00', tz: 'Not/AZone' } }, /time zone/],
            [{ ...INPUT, concurrency: 9 }, /concurrency/], [{ ...INPUT, price: { in_per_million: -1, out_per_million: 0 } }, /price/],
            [{ ...INPUT, audience: 'nobody' }, /audience/], [{ ...INPUT, audience: 'group' }, /group/],
            [{ ...INPUT, owner: OWNER }, /unknown field/],
        ];
        for (const [input, re] of bad) await assert.rejects(() => store.create({ owner: OWNER, input }), re);
        const offer = await store.create({ owner: OWNER, input: { ...INPUT, audience: 'group', group: 'g1' } });
        assert.strictEqual(offer.offer_id, `endpoint:${offer.id}`);
        assert.deepStrictEqual(offer.models, ['qwen3:32b']);
        assert.strictEqual(offer.hours.tz, 'UTC');
        assert.deepStrictEqual(offer.price, { in_per_million: 10, out_per_million: 30 });
        assert.strictEqual(offer.group, 'g1');
    } finally { await h.stop(); }
});

t.test('a name that answers a private address is refused by the connection lookup', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        const lookup = (host, options, cb) => cb(null, [{ address: '10.1.2.3', family: 4 }]);
        const store = storeFor(h.db, { lookup });
        await store.create({ owner: OWNER, input: INPUT });
        const offer = (await store.liveOffers())[0];
        await assert.rejects(() => store.chat(offer, { model: 'qwen3:32b', messages: [{ role: 'user', content: 'hi' }] }), /non-public address/);
    } finally { await h.stop(); }
});

t.test('a redirect is judged again: to a private address it is refused', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        for (const location of ['https://127.0.0.1/v1/chat/completions', 'https://[::1]/v1/chat/completions', 'https://169.254.169.254/v1/chat/completions']) {
            const transport = async () => ({ status: 307, headers: { location }, body: '' });
            const store = storeFor(h.db, { transport });
            await store.create({ owner: OWNER, input: INPUT });
            const offer = (await store.liveOffers())[0];
            await assert.rejects(() => store.chat(offer, { model: 'qwen3:32b', messages: [{ role: 'user', content: 'hi' }] }), /not allowed|non-public/, location);
        }
        // 301/302 are not followed for a POST at all.
        const transport = async () => ({ status: 302, headers: { location: 'https://other.example/v1/chat/completions' }, body: '' });
        const store = storeFor(h.db, { transport });
        await store.create({ owner: OWNER, input: INPUT });
        const offer = (await store.liveOffers())[0];
        await assert.rejects(() => store.chat(offer, { model: 'qwen3:32b', messages: [{ role: 'user', content: 'hi' }] }), /307 and 308/);
    } finally { await h.stop(); }
});

t.test('a dispatch carries no buyer identity and no caller field beyond the request itself', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        const fake = fakeEndpoint();
        const store = storeFor(h.db, { transport: fake.transport });
        await store.create({ owner: OWNER, input: INPUT });
        const offer = (await store.liveOffers())[0];
        await store.chat(offer, { model: 'qwen3:32b', messages: [{ role: 'user', content: 'hi' }] });
        const sent = fake.calls[0];
        assert.deepStrictEqual(Object.keys(sent.headers).sort(), ['Accept', 'Content-Length', 'Content-Type', 'User-Agent']);
        assert.ok(!/x-ov|x-openvibe|cookie|forwarded|authorization|openai-organization/i.test(Object.keys(sent.headers).join(' ')));
        assert.deepStrictEqual(Object.keys(sent.request).sort(), ['max_tokens', 'messages', 'model', 'stream']);
        assert.strictEqual(sent.request.user, undefined, 'the caller\'s user field is never passed through');
        assert.strictEqual(sent.request.stream, false);
        assert.ok(sent.url.endsWith('/v1/chat/completions'));
    } finally { await h.stop(); }
});

t.test('a registered endpoint joins the router: canaries first, free tier until verified, then a labelled answer', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        const fake = fakeEndpoint();
        const store = storeFor(h.db, { transport: fake.transport });
        await store.create({ owner: OWNER, input: INPUT });
        const community = createCommunity({
            db: h.db, config: cfg(), env: {}, endpoints: store, fetchImpl: networkFetch(), log: silent,
            tokens: { getToken: async () => 'test-token' }, clock: { now: () => Date.parse('2026-11-06T12:00:00Z') }, random: () => 1,
        });
        const out = await community.execute({ operation: 'chat', req: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 64 },
            ctx: { communityOptIn: true, creditsRequired: true, runId: 'r1', onBehalfOf: OTHER } });
        assert.ok(out, 'an endpoint offer is eligible');
        assert.match(out.provider, /^community-endpoint:ep_/);
        assert.strictEqual(out.explain.openvibe.provider_access, 'COMMUNITY_ENDPOINT');
        assert.strictEqual(out.explain.openvibe.deployment, out.provider);
        assert.strictEqual(out.explain.community.kind, 'endpoint');
        assert.strictEqual(out.explain.community.verification, 'verified');
        assert.strictEqual(out.explain.community.free_tier, true);
        assert.strictEqual(out.result.text, 'You said: hello');
        // Three canary calls, then the request.
        assert.strictEqual(fake.calls.length, 4);
        const state = await h.db.prepare('SELECT * FROM community_offers WHERE machine_id = ?').get(out.explain.community.machine_id);
        assert.strictEqual(state.status, 'verified');
        assert.ok(Number(state.canary_passes) >= 1, 'one round of three canaries passed');
        const receipt = buildReceipt({ run: { id: 'run_1' }, explain: out.explain, usage: out.usage, provider: out.provider, model: 'qwen3:32b' });
        assert.strictEqual(receipt.offer.provider_access, 'COMMUNITY_ENDPOINT');
        assert.strictEqual(receipt.offer.community, 'endpoint', 'the receipt says a community endpoint answered');
        assert.match(receipt.offer.provider, /^community-endpoint:ep_/);
    } finally { await h.stop(); }
});

t.test('a wrong canary answer or a fingerprint mismatch fails verification and stops traffic', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        for (const fake of [fakeEndpoint({ canary: false }), fakeEndpoint({ model: 'some-other-model' })]) {
            const store = storeFor(h.db, { transport: fake.transport });
            const created = await store.create({ owner: OWNER, input: INPUT });
            const community = createCommunity({
                db: h.db, config: cfg(), env: {}, endpoints: store, fetchImpl: networkFetch(), log: silent,
                tokens: { getToken: async () => 'test-token' }, clock: { now: () => Date.parse('2026-11-06T12:00:00Z') }, random: () => 1,
            });
            await assert.rejects(() => community.execute({ operation: 'chat', req: { messages: [{ role: 'user', content: 'hello' }] },
                ctx: { communityOptIn: true, creditsRequired: true, runId: 'r2', onBehalfOf: OTHER } }), /canary|answers as/);
            const row = await h.db.prepare('SELECT status FROM community_offers WHERE offer_id = ?').get(`endpoint:${created.id}`);
            assert.strictEqual(row.status, 'failed');
        }
    } finally { await h.stop(); }
});

t.test('a request on the seller\'s own account is self-served and earns 0', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        const fake = fakeEndpoint();
        const store = storeFor(h.db, { transport: fake.transport });
        await store.create({ owner: OWNER, input: INPUT });
        const community = createCommunity({
            db: h.db, config: cfg(), env: {}, endpoints: store, fetchImpl: networkFetch(), log: silent,
            tokens: { getToken: async () => 'test-token' }, clock: { now: () => Date.parse('2026-11-06T12:00:00Z') }, random: () => 1,
        });
        const out = await community.execute({ operation: 'chat', req: { messages: [{ role: 'user', content: 'hello' }] },
            ctx: { communityOptIn: true, creditsRequired: true, runId: 'r3', onBehalfOf: OWNER } });
        assert.strictEqual(out.explain.community.self_served, true);
        assert.strictEqual(out.explain.community.credits_micro, 0);
        assert.strictEqual(out.explain.community.earning_status, 'self');
    } finally { await h.stop(); }
});

t.test('a request that opts in reaches the endpoint through the OpenAI route and is labelled', async () => {
    const fake = fakeEndpoint();
    const h = await boot({ communityEndpoints: (db) => storeFor(db, { transport: fake.transport }) });
    try {
        await h.endpoints.create({ owner: OWNER, input: INPUT });
        const r = await request(h.base, 'POST', '/v1/chat/completions', {
            tok: token('live', ALL), headers: { 'x-openvibe-community': '1' },
            body: { model: 'openvibe/auto', messages: [{ role: 'user', content: 'hi' }] },
        });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.headers.get('x-openvibe-community'), '1');
        assert.match(r.body.x_openvibe.provider, /^community-endpoint:ep_/);
        assert.strictEqual(r.body.x_openvibe.community.kind, 'endpoint');
        assert.strictEqual(r.body.x_openvibe.community.verification, 'verified');
        assert.strictEqual(r.body.choices[0].message.content, 'You said: hi');
    } finally { await h.stop(); }
});

t.test('about 1% of endpoint answers are re-run on a trusted peer and compared', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        const calls = [];
        const transport = async ({ url, body }) => {
            const request = JSON.parse(body);
            calls.push(request);
            const last = String((request.messages[request.messages.length - 1] || {}).content || '');
            const canary = last.includes('OPENVIBE-CANARY') ? 'OPENVIBE-CANARY-7F3A' : last.includes('17 + 25') ? '42' : last.includes('canary-ok') ? 'canary-ok' : null;
            const text = canary || (String(url).includes('a.example') ? 'You said: hello' : 'an answer that shares no words at all with that one');
            return { status: 200, headers: {}, body: JSON.stringify({ model: 'qwen3:32b', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } }) };
        };
        const store = storeFor(h.db, { transport });
        // A is cheaper, so it answers; B is verified first, so it is the trusted peer for the spot re-run.
        const a = await store.create({ owner: OWNER, input: { ...INPUT, base_url: 'https://a.example/v1', price: 10 } });
        const b = await store.create({ owner: OWNER, input: { ...INPUT, base_url: 'https://b.example/v1', price: 20 } });
        const offers = await store.liveOffers();
        const offerB = offers.find((o) => o.endpoint.id === b.id);
        const community = createCommunity({
            db: h.db, config: cfg({ spotRate: 0.01 }), env: {}, endpoints: store, fetchImpl: networkFetch(), log: silent,
            tokens: { getToken: async () => 'test-token' }, clock: { now: () => Date.parse('2026-11-06T12:00:00Z') }, random: () => 0,
        });
        await community.verify(offerB, 'qwen3:32b');
        await assert.rejects(() => community.execute({ operation: 'chat', req: { messages: [{ role: 'user', content: 'hello' }] },
            ctx: { communityOptIn: true, creditsRequired: true, runId: 'r4', onBehalfOf: OTHER } }), /disagreed with a trusted/);
        const row = await h.db.prepare('SELECT status FROM community_offers WHERE offer_id = ?').get(`endpoint:${a.id}`);
        assert.strictEqual(row.status, 'failed', 'a spot mismatch fails the offer');
    } finally { await h.stop(); }
});

t.test('the seller\'s concurrency is respected: over it the router falls back', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        let release;
        const gate = new Promise((r) => { release = r; });
        const transport = async () => {
            await gate;
            return { status: 200, headers: {}, body: JSON.stringify({ model: 'qwen3:32b', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }], usage: {} }) };
        };
        const store = storeFor(h.db, { transport, over: {} });
        await store.create({ owner: OWNER, input: { ...INPUT, concurrency: 1 } });
        const offer = (await store.liveOffers())[0];
        const first = store.chat(offer, { model: 'qwen3:32b', messages: [{ role: 'user', content: 'one' }] });
        await assert.rejects(() => store.chat(offer, { model: 'qwen3:32b', messages: [{ role: 'user', content: 'two' }] }), /concurrency limit/);
        release();
        assert.strictEqual((await first).text, 'ok');
    } finally { await h.stop(); }
});

t.run();
