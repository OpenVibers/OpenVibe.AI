'use strict';
// Exchange webhooks (the design's "For builders", item 7): a signed delivery, a retry with a backoff, a delivery log,
// a refused private receiver, and the three events wired into the run and the seller API. The signature is checked
// with openvibe-sdk/exchange's own verifier -- the header a receiver will use.
const assert = require('assert');
const { boot, request, token, suite, ALL } = require('./helpers');
const { testDb } = require('./db');
const { createWebhooks, judgeUrl } = require('../server/exchange/webhooks');
const { verifyWebhook } = require('openvibe-sdk/exchange');

const t = suite('exchange-webhooks');
const OWNER = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1';
const silent = { log() {}, warn() {}, error() {} };
const cfg = { webhooks: { enabled: true, baseDelayMs: 1000, maxDelayMs: 60000, maxAttempts: 3, timeoutMs: 1000, tickMs: 250 } };

function recorder(responses = []) {
    const calls = [];
    const transport = async (send) => {
        calls.push(send);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next || { status: 200, headers: {}, body: 'ok' };
    };
    return { calls, transport };
}

let store;
let ms = Date.parse('2026-11-07T12:00:00Z');
const clock = { now: () => ms };

t.test('a receiver URL goes through the egress guard, at registration', () => {
    const bad = [
        ['http://hooks.example.com/x', /https/],
        ['https://127.0.0.1/x', /IP address/],
        ['https://169.254.169.254/latest', /IP address/],
        ['https://[::1]/x', /IP address/],
        ['https://localhost/x', /public host name/],
        ['https://hooks.example.com:8080/x', /port 443 or 8443/],
        ['https://hooks.example.com/x?token=1', /query or fragment/],
    ];
    for (const [url, re] of bad) {
        assert.throws(() => judgeUrl(url), (err) => err.code === 'exchange.webhook_url' && re.test(err.detail), url);
    }
    assert.strictEqual(judgeUrl('https://hooks.example.com/exchange').toString(), 'https://hooks.example.com/exchange');
});

t.test('a subscription: the secret is shown once, the list never carries it, removal is the owner\'s', async () => {
    const dbh = await testDb();
    store = createWebhooks({ db: dbh.db, config: cfg, clock, log: silent, transport: recorder().transport });
    const created = await store.create({ owner: OWNER, input: { url: 'https://hooks.example.com/exchange', events: ['usage'] } });
    assert.match(created.id, /^whk_/);
    assert.match(created.secret, /^whsec_/);
    assert.deepStrictEqual(created.events, ['usage']);
    const listed = await store.list(OWNER);
    assert.strictEqual(listed.length, 1);
    assert.ok(!('secret' in listed[0]), 'the list never carries the secret');
    assert.deepStrictEqual(await store.deliveries({ id: created.id, owner: OWNER }), []);
    await assert.rejects(() => store.remove({ id: created.id, owner: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2B2' }), (err) => err.code === 'exchange.webhook_not_found');
    assert.deepStrictEqual(await store.remove({ id: created.id, owner: OWNER }), { id: created.id, removed: true });
    assert.deepStrictEqual(await store.list(OWNER), []);
    await dbh.close();
});

t.test('signature round-trip with the SDK verifier, and a delivery log a developer can read', async () => {
    const dbh = await testDb();
    const rec = recorder();
    store = createWebhooks({ db: dbh.db, config: cfg, clock, log: silent, transport: rec.transport });
    const sub = await store.create({ owner: OWNER, input: { url: 'https://hooks.example.com/exchange', events: ['usage'] } });
    const queued = await store.emit({ owner: OWNER, type: 'usage', source: 'run_1', data: { run_id: 'run_1', tokens: { input: 3, output: 2 } } });
    assert.strictEqual(queued, 1);
    assert.strictEqual(rec.calls.length, 0, 'the event is a row: nothing is sent before the worker runs');
    const out = await store.deliverDue();
    assert.deepStrictEqual(out, { sent: 1, delivered: 1, failed: 0 });
    assert.strictEqual(rec.calls.length, 1);
    const sent = rec.calls[0];
    assert.strictEqual(sent.method, 'POST');
    assert.strictEqual(sent.url, 'https://hooks.example.com/exchange');
    assert.strictEqual(sent.headers['X-OpenVibe-Event'], 'usage');
    assert.match(sent.headers['X-OpenVibe-Signature-V2'], /^t=\d+,v2=[0-9a-f]{64}$/);
    assert.strictEqual(verifyWebhook(sent.body, sent.headers['X-OpenVibe-Signature-V2'], sub.secret, { now: ms }), true);
    assert.strictEqual(verifyWebhook(`${sent.body} `, sent.headers['X-OpenVibe-Signature-V2'], sub.secret, { now: ms }), false, 'the raw bytes are signed');
    assert.strictEqual(verifyWebhook(sent.body, sent.headers['X-OpenVibe-Signature-V2'], 'whsec_wrong', { now: ms }), false);
    const payload = JSON.parse(sent.body);
    assert.strictEqual(payload.type, 'usage');
    assert.strictEqual(payload.data.run_id, 'run_1');
    assert.ok(!sent.body.includes(sub.secret), 'the secret never rides in the body');
    const log = await store.deliveries({ id: sub.id, owner: OWNER });
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].status, 'delivered');
    assert.strictEqual(log[0].attempts, 1);
    assert.strictEqual(log[0].last_status, 200);
    assert.deepStrictEqual(log[0].payload, payload);
    assert.strictEqual((await store.deliverDue()).sent, 0, 'a delivered row is not sent again');
    await dbh.close();
});

t.test('a 503 is retried with a growing backoff; a 404 fails at once', async () => {
    const dbh = await testDb();
    const rec = recorder([{ status: 503, headers: {}, body: 'busy' }, { status: 200, headers: {}, body: 'ok' }, { status: 404, headers: {}, body: 'gone' }]);
    store = createWebhooks({ db: dbh.db, config: { webhooks: { ...cfg.webhooks, maxAttempts: 5 } }, clock, log: silent, transport: rec.transport });
    const sub = await store.create({ owner: OWNER, input: { url: 'https://hooks.example.com/exchange' } });
    await store.emit({ owner: OWNER, type: 'usage', source: 'run_2', data: { run_id: 'run_2' } });
    assert.deepStrictEqual(await store.deliverDue(), { sent: 1, delivered: 0, failed: 0 });
    let log = (await store.deliveries({ id: sub.id, owner: OWNER }))[0];
    assert.strictEqual(log.status, 'pending');
    assert.strictEqual(log.attempts, 1);
    assert.strictEqual(log.last_status, 503);
    assert.strictEqual(Date.parse(log.next_attempt_at) - ms, 1000, 'the first retry waits baseDelayMs');
    assert.strictEqual((await store.deliverDue()).sent, 0, 'not due yet');
    ms += 1001;
    assert.deepStrictEqual(await store.deliverDue(), { sent: 1, delivered: 1, failed: 0 });
    log = (await store.deliveries({ id: sub.id, owner: OWNER }))[0];
    assert.strictEqual(log.attempts, 2);
    assert.strictEqual(log.status, 'delivered');

    await store.emit({ owner: OWNER, type: 'earnings', source: 'run_3', data: { credits_micro: 5 } });
    assert.deepStrictEqual(await store.deliverDue(), { sent: 1, delivered: 0, failed: 1 });
    log = (await store.deliveries({ id: sub.id, owner: OWNER }))[0];
    assert.strictEqual(log.event_type, 'earnings');
    assert.strictEqual(log.status, 'failed');
    assert.strictEqual(log.attempts, 1, 'a 404 is not retried');
    await dbh.close();
});

t.test('a community answer queues earnings to the seller and the project that registered the offer', async () => {
    const dbh = await testDb();
    const rec = recorder();
    const store2 = createWebhooks({ db: dbh.db, config: cfg, clock, log: silent, transport: rec.transport });
    const PROJECT = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';
    await store2.create({ owner: OWNER, input: { url: 'https://hooks.example.com/owner' } });
    await store2.create({ owner: PROJECT, input: { url: 'https://hooks.example.com/project' } });
    const row = {
        id: 'run_community', requester_type: 'user', requester_id: OWNER,
        explain: JSON.stringify({ community: { kind: 'endpoint', machine_id: 'endpoint:ep_1', offer_id: 'endpoint:ep_1', project_id: PROJECT,
            owner: OWNER, model: 'qwen3:32b', credits_micro: 500, earning_status: 'pending', self_served: false, kudos: 0, tokens_in: 12, tokens_out: 8 } }),
    };
    const record = { subject: OWNER, provider: 'community-endpoint:ep_1', model: 'qwen3:32b', tokens_input: 12, tokens_output: 8,
        tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0, list_cost_usd: 0, charged_usd: 0, fee_usd: 0, cache_saved_usd: 0,
        paid_by: 'network_allowance', latency_ms: 10, ttft_ms: 2, at: '2026-11-07T12:00:00Z' };
    assert.strictEqual(await store2.usage({ row, record, outcome: 'succeeded' }), 3, 'usage to the owner, earnings to the owner and the project');
    await store2.deliverDue();
    const events = rec.calls.map((c) => ({ event: c.headers['X-OpenVibe-Event'], url: c.url, body: JSON.parse(c.body) }));
    assert.strictEqual(events.filter((e) => e.event === 'usage').length, 1);
    const earnings = events.filter((e) => e.event === 'earnings');
    assert.strictEqual(earnings.length, 2);
    assert.deepStrictEqual(earnings.map((e) => e.url).sort(), ['https://hooks.example.com/owner', 'https://hooks.example.com/project']);
    assert.strictEqual(earnings[0].body.data.offer_id, 'endpoint:ep_1');
    assert.strictEqual(earnings[0].body.data.credits_micro, 500);
    assert.strictEqual(earnings[0].body.data.earning_status, 'pending');
    await dbh.close();
});

// ── The wiring: a run and an offer removal each queue their event ─────────────────────────────
let h;
let rec;

t.test('boot with a webhook store on a socket the tests drive', async () => {
    rec = recorder();
    h = await boot({ webhooks: (db) => createWebhooks({ db, config: cfg, log: silent, transport: rec.transport }) });
});

t.test('a completed run queues a signed usage event for the person', async () => {
    const person = token('dana', ALL, { sub: OWNER, actorType: 'user' });
    const created = await request(h.base, 'POST', '/api/v1/exchange/webhooks', { tok: person, body: { url: 'https://hooks.example.com/exchange', events: ['usage', 'offer.down'] } });
    assert.strictEqual(created.status, 201, created.text);
    const secret = created.body.webhook.secret;
    const chat = await request(h.base, 'POST', '/v1/chat/completions', { tok: person, body: { model: 'openvibe', messages: [{ role: 'user', content: 'say hi' }] } });
    assert.strictEqual(chat.status, 200, chat.text);
    const out = await h.webhooks.deliverDue();
    assert.ok(out.sent >= 1, 'the run queued a delivery');
    const call = rec.calls.find((c) => c.headers['X-OpenVibe-Event'] === 'usage');
    assert.ok(call, 'a usage delivery');
    assert.strictEqual(verifyWebhook(call.body, call.headers['X-OpenVibe-Signature-V2'], secret), true);
    const payload = JSON.parse(call.body);
    assert.strictEqual(payload.data.run_id, chat.headers.get('x-openvibe-run-id'));
    assert.strictEqual(payload.data.outcome, 'succeeded');
    assert.ok(payload.data.tokens.output >= 0);
    assert.ok(!payload.data.prompt && !payload.data.answer, 'never the prompt or the answer');

    // The developer reads the same delivery, and the caller's own usage, with their token.
    const log = await request(h.base, 'GET', `/api/v1/exchange/webhooks/${created.body.webhook.id}/deliveries`, { tok: person });
    assert.strictEqual(log.status, 200, log.text);
    assert.strictEqual(log.body.deliveries[0].event_type, 'usage');
    assert.strictEqual(log.body.deliveries[0].status, 'delivered');
    assert.ok(!log.text.includes(secret), 'the delivery log never carries the secret');
    const mine = await request(h.base, 'GET', '/api/v1/exchange/me/usage?days=7', { tok: person });
    assert.strictEqual(mine.status, 200, mine.text);
    assert.strictEqual(mine.body.requester, `user:${OWNER}`);
    assert.ok(Array.isArray(mine.body.usage));
    const other = token('eli', ALL, { sub: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2B2', actorType: 'user' });
    const notMine = await request(h.base, 'GET', `/api/v1/exchange/webhooks/${created.body.webhook.id}/deliveries`, { tok: other });
    assert.strictEqual(notMine.status, 404, notMine.text);
});

t.test('removing an endpoint offer queues offer.down', async () => {
    const person = token('dana', ALL, { sub: OWNER, actorType: 'user' });
    const created = await request(h.base, 'POST', '/api/v1/exchange/seller/offers', { tok: person, body: {
        base_url: 'https://models.example/v1', models: ['qwen3:32b'],
        price: { in_per_million: 10, out_per_million: 30 }, hours: { start: '00:00', end: '23:59', tz: 'UTC' },
        concurrency: 2, audience: 'everyone',
    } });
    assert.strictEqual(created.status, 201, created.text);
    const removed = await request(h.base, 'DELETE', `/api/v1/exchange/seller/offers/${created.body.offer.id}`, { tok: person });
    assert.strictEqual(removed.status, 200, removed.text);
    await h.webhooks.deliverDue();
    const call = rec.calls.find((c) => c.headers['X-OpenVibe-Event'] === 'offer.down');
    assert.ok(call, 'an offer.down delivery');
    const payload = JSON.parse(call.body);
    assert.strictEqual(payload.type, 'offer.down');
    assert.strictEqual(payload.data.offer_id, `endpoint:${created.body.offer.id}`);
    assert.deepStrictEqual(payload.data.models, ['qwen3:32b']);
});

t.test('a service token cannot register a webhook', async () => {
    const service = token('live', ['ai.run.create', 'ai.app.run']);
    const out = await request(h.base, 'POST', '/api/v1/exchange/webhooks', { tok: service, body: { url: 'https://hooks.example.com/x' } });
    assert.strictEqual(out.status, 403, out.text);
    assert.strictEqual(out.body.code, 'exchange.webhook_owner');
});

t.test('the private receiver is refused by the API', async () => {
    const person = token('dana', ALL, { sub: OWNER, actorType: 'user' });
    for (const url of ['https://127.0.0.1/hook', 'https://localhost/hook', 'http://hooks.example.com/hook']) {
        const out = await request(h.base, 'POST', '/api/v1/exchange/webhooks', { tok: person, body: { url } });
        assert.strictEqual(out.status, 422, out.text);
        assert.strictEqual(out.body.code, 'exchange.webhook_url');
    }
});

t.test('stop', async () => { await h.stop(); });

t.run();
