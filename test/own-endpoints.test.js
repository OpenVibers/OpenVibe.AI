'use strict';
/**
 * Your own endpoint (the Exchange remake, product line 6): off without the owner's GPU key, cap and Balance
 * billing; started through the same GPU provisioner (never registered as an offer); reached only by its
 * owner's token; scaled to zero after its idle timer; and settled against Billing for the exact seconds,
 * never past the owner's monthly cap. Every GPU and Billing call is a local fake: no test reaches the
 * internet.
 */
const assert = require('assert');
const http = require('http');
const { boot, request, token, suite } = require('./helpers');
const { createGpuFetch } = require('./fixtures/gpu-fetch');

const t = suite('own-endpoints');
const T0 = Date.parse('2026-11-06T12:00:00Z');
const OWNER = { type: 'user', id: 'usr_' + 'A'.repeat(26) };
const PERSON = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP7';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A person's Network token, as Exchange holds it in the site session (audience openvibe.network). */
function userToken(subject = PERSON) {
    return token('a-person', [], { sub: subject, actorType: 'user', aud: 'openvibe.network', ns: null, exp: Math.floor(T0 / 1000) + 3600, extra: { iat: Math.floor(T0 / 1000) } });
}

/** A local fake Billing: the OAuth token and the four hold routes, with a balance and a real settle charge. */
async function fakeBilling({ balance = 10_000_000_000n } = {}) {
    const state = { balance, held: 0n, holds: new Map(), settlements: new Map(), releases: [], calls: [] };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const path = new URL(req.url, 'http://x').pathname;
            let body = {};
            try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
            if (path !== '/oauth/token') state.calls.push({ path, body });
            const send = (status, out) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)); };
            if (path === '/oauth/token') return send(200, { access_token: 'test-token', token_type: 'Bearer', expires_in: 300 });
            if (path === '/internal/credits/holds') {
                const prev = state.holds.get(body.idempotency_key);
                if (prev) return send(201, { hold_id: prev.hold_id, held_nano_usd: prev.held, available_nano_usd: String(state.balance - state.held) });
                const amount = BigInt(String(body.max_nano_usd));
                if (state.balance - state.held < amount) return send(402, { code: 'billing.insufficient_funds', detail: 'not enough Balance' });
                const hold = { hold_id: `hld_${String(state.holds.size + 1).padStart(26, '0')}`, held: String(amount), status: 'active', max: String(amount) };
                state.holds.set(body.idempotency_key, hold);
                state.held += amount;
                return send(201, { hold_id: hold.hold_id, held_nano_usd: hold.held, available_nano_usd: String(state.balance - state.held) });
            }
            let m = /^\/internal\/credits\/holds\/([^/]+)\/settle$/.exec(path);
            if (m) {
                const prev = state.settlements.get(body.idempotency_key);
                if (prev) return send(201, prev);
                const hold = [...state.holds.values()].find((x) => x.hold_id === decodeURIComponent(m[1]));
                if (!hold) return send(404, { code: 'billing.hold_not_found' });
                const perM = body.retail.nano_usd_per_m || {};
                const part = (n, r) => { const x = BigInt(n || 0) * BigInt(r || 0); return x === 0n ? 0n : (x % 1000000n === 0n ? x / 1000000n : x / 1000000n + 1n); };
                const charge = part(body.usage.input_tokens, perM.input) + part(body.usage.output_tokens, perM.output) + BigInt(body.retail.per_request_nano_usd || 0);
                const out = { charge_nano_usd: String(charge), released_nano_usd: String(BigInt(hold.held) - charge), journal_id: 'txn_1', shortfall_nano_usd: '0' };
                state.settlements.set(body.idempotency_key, out);
                hold.status = 'settled';
                state.held -= BigInt(hold.held);
                state.balance -= charge;
                return send(201, out);
            }
            m = /^\/internal\/credits\/holds\/([^/]+)\/release$/.exec(path);
            if (m) {
                const id = decodeURIComponent(m[1]);
                const hold = [...state.holds.values()].find((x) => x.hold_id === id);
                if (hold && hold.status !== 'settled') { hold.status = 'released'; state.held -= BigInt(hold.held); state.releases.push(id); }
                return send(200, { hold_id: id, released_nano_usd: hold ? hold.held : '0' });
            }
            return send(404, { code: 'not_found', detail: path });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    state.url = `http://127.0.0.1:${server.address().port}`;
    state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    return state;
}

/** The GPU fixture plus a canned OpenAI answer and the fake Billing's own HTTP, so one fetch serves all. */
function marketplace(billing) {
    const api = createGpuFetch();
    const chat = [];
    const fetchImpl = async (url, opts = {}) => {
        const u = String(url);
        if (billing && u.startsWith(billing.url)) return globalThis.fetch(u, opts);
        if (u.includes('/v1/chat/completions')) {
            chat.push({ url: u, body: JSON.parse(opts.body || '{}') });
            return new Response(JSON.stringify({ id: 'chatcmpl-own', object: 'chat.completion', model: 'own-model', choices: [{ index: 0, message: { role: 'assistant', content: 'from your GPU' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return api.fetchImpl(u, opts);
    };
    return { api, chat, fetchImpl };
}

async function setGpus(h, { key = 'vast-test-key', cap = '50000000000', idle = null } = {}) {
    const store = h.settings.gpus.store;
    const values = { monthly_cap: Number(cap) };
    if (idle != null) values.idle_minutes = idle;
    await store.apply(values, { merge: true, actor: OWNER, reason: 'the test' });
    if (key) await store.setSecret('vast.key', key, { actor: OWNER, reason: 'the test' });
}

const billingEnv = (billing) => ({ AI_CREDITS: '1', OV_BILLING_INTERNAL_URL: billing.url, OV_NETWORK_INTERNAL_URL: billing.url, OV_OAUTH_CLIENT_SECRET: 'test-secret' });

t.test('the two owner inputs are marked for Setup: key and cap, group gpus, needed for own endpoints', async () => {
    const h = await boot({ clock: { now: () => T0 } });
    try {
        const sum = await h.settings.gpus.store.summary();
        for (const key of ['vast.key', 'runpod.key', 'monthly_cap']) {
            const field = sum.schema.properties[key];
            assert.strictEqual(field['x-owner-input'].group, 'gpus', key + ' is grouped under GPUs (the group id)');
            assert.match(String(field['x-required-for']), /own endpoints/, key + ' is needed for own endpoints');
            assert.ok(String(field.title || '').length > 2, key + ' has a plain title');
            assert.ok(String(field.description || '').length >= 30, key + ' has a description');
            assert.match(String(field['x-owner-input'].get_it_at), /^https:\/\//, key + ' says where to get it');
        }
        assert.strictEqual(sum.schema.properties['vast.key']['x-owner-input'].unlocks.length > 30, true);
    } finally { await h.stop(); }
});

t.test('off without a GPU key or a cap, with a plain reason; nothing is rented', async () => {
    const now = T0;
    const h = await boot({ clock: { now: () => now } });
    try {
        const st = h.ownEndpoints.status();
        assert.strictEqual(st.enabled, false);
        assert.match(st.reason, /GPU provider key/);
        const pub = await request(h.base, 'GET', '/api/v1/exchange/endpoints');
        assert.strictEqual(pub.status, 200);
        assert.strictEqual(pub.body.enabled, false);
        assert.match(pub.body.reason, /GPU provider key/, 'the public status carries the plain reason');
        const anonymous = await request(h.base, 'GET', '/api/v1/own-endpoints');
        assert.strictEqual(anonymous.status, 401, 'the person API needs a person');
        const r = await request(h.base, 'POST', '/api/v1/own-endpoints', { tok: userToken(), body: { model: 'deepseek-r1-32b' } });
        assert.strictEqual(r.status, 409);
        assert.match(r.text, /GPU provider key/);
        // a key but no cap: still off, and it says which one is missing
        await setGpus(h, { cap: '0' });
        const noCap = h.ownEndpoints.status();
        assert.strictEqual(noCap.enabled, false);
        assert.match(noCap.reason, /monthly GPU cap/);
    } finally { await h.stop(); }
});

t.test('off when Balance billing is not on, even with a key and a cap', async () => {
    const now = T0;
    const h = await boot({ clock: { now: () => now } });
    try {
        await setGpus(h);
        const st = h.ownEndpoints.status();
        assert.strictEqual(st.enabled, false);
        assert.match(st.reason, /Balance billing is not on/);
        const r = await request(h.base, 'POST', '/api/v1/own-endpoints', { tok: userToken(), body: { model: 'deepseek-r1-32b' } });
        assert.strictEqual(r.status, 409);
        assert.match(r.text, /Balance billing is not on/);
    } finally { await h.stop(); }
});

t.test('a person starts a private endpoint: the hold is taken first, the rent is never an offer, and the proxy answers', async () => {
    const billing = await fakeBilling();
    const m = marketplace(billing);
    let now = T0;
    const h = await boot({ clock: { now: () => now }, fetchImpl: m.fetchImpl, env: billingEnv(billing) });
    try {
        await setGpus(h, { cap: '50000000000', idle: 1 });
        const created = await request(h.base, 'POST', '/api/v1/own-endpoints', { tok: userToken(), body: { model: 'deepseek-r1-32b', idle_minutes: 1 } });
        assert.strictEqual(created.status, 201, created.text);
        const ep = created.body.endpoint;
        assert.strictEqual(ep.status, 'requested');
        assert.match(ep.url, /\/api\/v1\/own-endpoints\/oep_[^/]+\/v1$/);
        assert.strictEqual(m.api.calls.create.length, 0, 'nothing is rented before the reconciler takes the hold');
        assert.strictEqual(billing.calls.length, 0);

        // the reconciler starts it: search, hold, then the marketplace
        await h.ownEndpoints.tick();
        assert.strictEqual(m.api.calls.search, 1);
        assert.strictEqual(billing.calls.filter((c) => c.path === '/internal/credits/holds').length, 1, 'the hold was taken');
        assert.strictEqual(m.api.calls.create.length, 1, 'the instance was rented');
        let cur = await h.ownEndpoints.get(PERSON, ep.id);
        assert.strictEqual(cur.status, 'starting');
        assert.ok(BigInt(cur.reserved_nano) > 0n);

        // it comes up: the provider is NOT registered, so the router and the catalogue never see it
        now += 60_000;
        await h.gpus.tick();
        cur = await h.ownEndpoints.get(PERSON, ep.id);
        assert.strictEqual(cur.status, 'running');
        assert.strictEqual(await h.registry.getProvider('own-' + ep.id), null, 'a private endpoint is never an offer');

        // the owner's OpenAI-compatible call reaches the rented GPU and marks the use
        const proxied = await request(h.base, 'POST', `/api/v1/own-endpoints/${ep.id}/v1/chat/completions`, { tok: userToken(), body: { model: ep.id, messages: [{ role: 'user', content: 'hello' }] } });
        assert.strictEqual(proxied.status, 200, proxied.text);
        assert.strictEqual(proxied.body.choices[0].message.content, 'from your GPU');
        assert.strictEqual(m.chat.length, 1);
        const fresh = await h.db.prepare('SELECT last_used_at FROM gpu_instances WHERE own_endpoint_id = ?').get(ep.id);
        assert.ok(fresh.last_used_at, 'the use was marked (the idle timer is honest)');

        // a service token can never manage or call it
        const service = token('live', ['ai.run.create']);
        const refused = await request(h.base, 'GET', '/api/v1/own-endpoints', { tok: service });
        assert.strictEqual(refused.status, 403);

        // idle: it scales to zero after its own minute, and Billing settles the exact spent seconds
        now += 61_000;
        await h.gpus.tick();
        const stopped = await h.ownEndpoints.get(PERSON, ep.id);
        assert.strictEqual(stopped.status, 'stopped');
        assert.match(String(stopped.error || ''), /idle|scale/i);
        assert.strictEqual(m.api.calls.destroy.length, 1, 'the instance was given back');
        const settled = [...billing.settlements.values()][0];
        assert.ok(settled, 'the hold was settled');
        const row = await h.db.prepare('SELECT charged_nano FROM own_endpoints WHERE id = ?').get(ep.id);
        assert.strictEqual(settled.charge_nano_usd, String(row.charged_nano), 'the person pays exactly what the GPU ledger says');
        assert.ok(BigInt(settled.charge_nano_usd) > 0n);
        const spend = await h.gpus.moneySummary();
        assert.ok(spend.committed_nano <= spend.cap_nano, 'inside the owner cap');
    } finally { await h.stop(); await billing.close(); }
});

t.test('the owner monthly cap stops a new start, with a plain reason', async () => {
    const billing = await fakeBilling();
    const m = marketplace(billing);
    const now = T0;
    const h = await boot({ clock: { now: () => now }, fetchImpl: m.fetchImpl, env: billingEnv(billing) });
    try {
        await setGpus(h, { cap: '1000000' });   // $0.001: less than an hour of a $0.1348/h GPU
        const created = await request(h.base, 'POST', '/api/v1/own-endpoints', { tok: userToken(), body: { model: 'deepseek-r1-32b' } });
        assert.strictEqual(created.status, 201);
        await h.ownEndpoints.tick();
        const cur = await h.ownEndpoints.get(PERSON, created.body.endpoint.id);
        assert.strictEqual(cur.status, 'refused');
        assert.match(String(cur.error), /cap/i);
        assert.strictEqual(m.api.calls.create.length, 0, 'nothing was rented');
        assert.strictEqual(billing.calls.length, 0, 'no hold was taken, no money moved');
    } finally { await h.stop(); await billing.close(); }
});

t.test('own weights and a LoRA run on the same provisioner, never on a catalog key', async () => {
    const billing = await fakeBilling();
    const m = marketplace(billing);
    let now = T0;
    const h = await boot({ clock: { now: () => now }, fetchImpl: m.fetchImpl, env: billingEnv(billing) });
    try {
        await setGpus(h);
        const made = await request(h.base, 'POST', '/api/v1/own-endpoints', { tok: userToken(), body: {
            weights: { repo: 'someone/My-Model-GGUF', file: 'My-Model-Q4_K_M.gguf', lora_repo: 'someone/my-lora', lora_file: 'adapter.gguf' },
            display_name: 'My own weights',
        } });
        assert.strictEqual(made.status, 201, made.text);
        assert.strictEqual(made.body.endpoint.source, 'weights');
        await h.ownEndpoints.tick();
        assert.strictEqual(m.api.calls.create.length, 1);
        const body = m.api.calls.create[0].body;
        assert.match(String(body.args), /huggingface\.co\/someone\/My-Model-GGUF\/resolve\/main\/My-Model-Q4_K_M\.gguf/);
        assert.match(String(body.args), /--lora \/models\/adapter\.gguf/);
        // an invalid repository never reaches the marketplace
        const bad = await request(h.base, 'POST', '/api/v1/own-endpoints', { tok: userToken(), body: { weights: { repo: 'file:///etc/passwd', file: 'x.gguf' } } });
        assert.strictEqual(bad.status, 422);
    } finally { await h.stop(); await billing.close(); }
});

t.test('a person sees only their own endpoints', async () => {
    const billing = await fakeBilling();
    const m = marketplace(billing);
    const now = T0;
    const h = await boot({ clock: { now: () => now }, fetchImpl: m.fetchImpl, env: billingEnv(billing) });
    try {
        await setGpus(h);
        const made = await request(h.base, 'POST', '/api/v1/own-endpoints', { tok: userToken(), body: { model: 'deepseek-r1-32b' } });
        assert.strictEqual(made.status, 201);
        const other = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP8';
        const peek = await request(h.base, 'GET', `/api/v1/own-endpoints/${made.body.endpoint.id}`, { tok: userToken(other) });
        assert.strictEqual(peek.status, 404);
    } finally { await h.stop(); await billing.close(); }
});

if (require.main === module) t.run();
module.exports = { suite: t };
