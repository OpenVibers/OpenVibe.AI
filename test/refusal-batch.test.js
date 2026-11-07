'use strict';
/**
 * The measured refusal rates (server/refusal/) and the half-price batches (server/batch/).
 *
 * The refusal side:
 *
 *   - the job is due-based: its last run is a row in the database, so a restart in the middle of the
 *     week does not measure the offers again, and a week later it is due again;
 *   - the rate is the refusals over the attempts, written with the day it was measured, and an offer
 *     nobody measured stays unknown (never zero).
 *
 * The batch side, which is where the money is: a batch is half price for the customer, so it may only
 * run where the route really costs the network at most half of the retail card (server/batch/capacity.js).
 *
 *   - an item on an ordinary paid route outside a discount window never runs: it expires uncharged;
 *   - an item on OpenVibe's own route runs, and the customer is charged half;
 *   - a community offer above half the retail price is not eligible;
 *   - at the deadline with no budget the item expires, uncharged;
 *   - with a loss budget it runs on regular capacity, and the absorbed amount is recorded and capped
 *     per day;
 *   - the settle check refuses a route whose cost exceeds the charge.
 */
const assert = require('assert');
const http = require('http');
const { boot, request, token, suite, tmpDir, ALL } = require('./helpers');
const { createRefusalJob } = require('../server/refusal/job');
const { rateOf } = require('../server/refusal/rate');
const { batchCapacity } = require('../server/batch/capacity');
const { EXPIRED_REASON } = require('../server/batch/service');

const t = suite('refusal-batch');
const service = token('live', ALL);
const ULID = '01JAB2C3D4E5F6G7H8J9K0MNPQ';
const PRJ = `prj_${ULID}`;
const producer = token('app', ['ai.app.run'], { sub: `app:app_${ULID}`, actorType: 'app', ns: [PRJ, `app.${PRJ}.*`], extra: { project_id: PRJ, env: 'production' } });

/** A local fake Billing: the hold routes, OAuth and the usage relay (the same one the credits tests use). */
async function fakeBilling() {
    const state = { balance: 10_000_000_000n, held: 0n, holds: new Map(), settlements: new Map(), calls: [], seq: 0 };
    const available = () => state.balance - state.held;
    const part = (tokens, rate) => {
        const n = BigInt(tokens || 0) * BigInt(rate || 0);
        return n === 0n ? 0n : (n % 1000000n === 0n ? n / 1000000n : n / 1000000n + 1n);
    };
    const chargeOf = (usage, retail) => {
        const perM = retail.nano_usd_per_m || {};
        return part(usage.input_tokens, perM.input) + part(usage.cached_read_tokens, perM.cached_read)
            + part(usage.cache_write_tokens, perM.cache_write) + part(usage.output_tokens, perM.output)
            + BigInt(retail.per_request_nano_usd || 0);
    };
    state.chargeOf = chargeOf;
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const path = new URL(req.url, 'http://x').pathname;
            const body = (() => { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } })();
            state.calls.push({ path, body });
            const send = (status, out) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)); };
            if (path === '/oauth/token') return send(200, { access_token: 'test-token', token_type: 'Bearer', expires_in: 300, scope: '' });
            if (path === '/api/v1/usage') return send(201, { ok: true });
            if (path === '/internal/credits/holds') {
                const prev = state.holds.get(body.idempotency_key);
                if (prev) return send(201, { hold_id: prev.hold_id, held_nano_usd: prev.held_nano_usd, available_nano_usd: String(available() < 0n ? 0n : available()), lease_expires_at: new Date(Date.now() + 300000).toISOString() });
                const amount = BigInt(String(body.max_nano_usd));
                if (available() < amount) return send(402, { code: 'billing.insufficient_funds', detail: 'need ' + amount });
                const hold = { hold_id: `hld_${String(++state.seq).padStart(26, '0')}`, held_nano_usd: String(amount) };
                state.holds.set(body.idempotency_key, hold);
                state.held += amount;
                return send(201, { hold_id: hold.hold_id, held_nano_usd: hold.held_nano_usd, available_nano_usd: String(available()), lease_expires_at: new Date(Date.now() + 300000).toISOString() });
            }
            let m = /^\/internal\/credits\/holds\/([^/]+)\/extend$/.exec(path);
            if (m) {
                const hold = [...state.holds.values()].find((h) => h.hold_id === decodeURIComponent(m[1]));
                const add = BigInt(String(body.add_nano_usd));
                if (!hold || available() < add) return send(402, { code: 'billing.insufficient_funds', detail: 'cannot extend' });
                hold.held_nano_usd = String(BigInt(hold.held_nano_usd) + add);
                state.held += add;
                return send(200, { hold_id: hold.hold_id, held_nano_usd: hold.held_nano_usd, available_nano_usd: String(available()), lease_expires_at: new Date(Date.now() + 300000).toISOString() });
            }
            m = /^\/internal\/credits\/holds\/([^/]+)\/settle$/.exec(path);
            if (m) {
                const prev = state.settlements.get(body.idempotency_key);
                if (prev) return send(201, prev);
                const hold = [...state.holds.values()].find((h) => h.hold_id === decodeURIComponent(m[1]));
                if (!hold) return send(404, { code: 'billing.hold_not_found' });
                const charge = body.byok ? 0n : chargeOf(body.usage, body.retail);
                const held = BigInt(hold.held_nano_usd);
                const out = { charge_nano_usd: String(charge), released_nano_usd: String(charge >= held ? 0n : held - charge), journal_id: `txn_${state.settlements.size + 1}`, shortfall_nano_usd: '0' };
                state.settlements.set(body.idempotency_key, out);
                state.held -= held;
                state.balance -= charge;
                return send(201, out);
            }
            m = /^\/internal\/credits\/holds\/([^/]+)\/release$/.exec(path);
            if (m) return send(200, { hold_id: decodeURIComponent(m[1]), released_nano_usd: '0' });
            return send(404, { code: 'not_found', detail: path });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    state.url = `http://127.0.0.1:${server.address().port}`;
    state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    return state;
}

/** A local OpenAI-format upstream. It fails its first call when the test asks it to. */
async function upstream({ failFirst = false } = {}) {
    const state = { calls: 0 };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
            state.calls++;
            if (failFirst && state.calls === 1) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'the upstream is unwell' })); return; }
            const completion = Math.min(12, Number(body.max_tokens || body.max_completion_tokens) || 12);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: 'chatcmpl-up', object: 'chat.completion', created: 1, model: 'gpt-up', choices: [{ index: 0, message: { role: 'assistant', content: 'an answer from upstream' }, finish_reason: 'stop' }], usage: { prompt_tokens: 60, completion_tokens: completion, total_tokens: 60 + completion } }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    state.url = `http://127.0.0.1:${server.address().port}/v1`;
    state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    return state;
}

/**
 * Two providers: OpenVibe's own deployment (metadata.local, idle capacity that costs nothing) and an
 * ordinary paid one. The route's primary and fallback are named by the test.
 */
async function seed(h, up, { primary = 'own', fallbacks = [], providers = ['own', 'paid'] } = {}) {
    for (const key of providers) {
        const made = await request(h.base, 'POST', '/api/v1/providers', { tok: service, body: {
            key, kind: 'openai', base_url: up.url, auth_mode: 'none', default_model: 'gpt-up', capabilities: ['chat'],
            provider_access: 'OWN_DEPLOYMENT', billing_profile: 'metered' } });
        assert.ok(made.status < 300, made.text);
        const model = await request(h.base, 'POST', '/api/v1/models', { tok: service, body: {
            provider_key: key, model_key: 'gpt-up', type: 'chat', supports: { streaming: true },
            cost: { in_per_mtok: 1, out_per_mtok: 2 }, metadata: { rate_version: 'retail-1' } } });
        assert.ok(model.status < 300, model.text);
    }
    // OpenVibe's own GPU deployment: idle capacity the network already pays for.
    await h.db.prepare("UPDATE providers SET metadata = jsonb_build_object('gpu', true) WHERE key = ?").run('own');
    const route = await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: service, body: {
        primary: { provider: primary, model: 'gpt-up' }, fallbacks, timeout_ms: 5000 } });
    assert.ok(route.status < 300, route.text);
}

async function bootWith(billing, clock) {
    return boot({ clock, env: {
        AI_CREDITS: '1', AI_MODEL_CATALOG: '1', AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0',
        AI_GOVERN_TIERS: '1', AI_GOVERN_POLICY_JSON: JSON.stringify({ 'ai-token': { free: {} }, 'ai-usd': { free: {} } }),
        OV_BILLING_INTERNAL_URL: billing.url, OV_NETWORK_INTERNAL_URL: billing.url,
        OV_OAUTH_CLIENT_SECRET: 'test-secret', OV_OAUTH_CLIENT_ID: 'ai', USAGE_SAMPLES: 'off',
    } });
}

/** Submit a batch and return its id. */
async function submit(h, { hours = null, items = [{ prompt: 'a prompt' }] } = {}) {
    const body = { items };
    if (hours != null) body.deadline_hours = hours;
    const r = await request(h.base, 'POST', '/api/v1/batches', { tok: producer, body });
    assert.strictEqual(r.status, 201, r.text);
    return r.body.batch.id;
}

async function itemOf(h, id, idx = 0) {
    const r = await request(h.base, 'GET', `/api/v1/batches/${id}`, { tok: producer });
    assert.strictEqual(r.status, 200, r.text);
    return r.body.batch.items[idx];
}

t.test('the refusal job is due-based: a restart does not measure the offers again', async () => {
    const dir = tmpDir();
    let now = Date.now();
    const clock = { now: () => now };
    const h1 = await boot({ dir, clock });
    try {
        const job = createRefusalJob({ db: h1.db, registry: h1.registry, pool: h1.pool, clock, config: { refusal: { enabled: true } } });
        assert.strictEqual(await job.due(), true, 'the job has never run: it is due at once');
        await job.runOnce({ force: true });
        assert.strictEqual(await job.due(), false, 'a finished run is not due again');
        const state = await job.state.read();
        assert.ok(state && state.last_run_at, 'the last run is a row in the database');
    } finally { await h1.stop(); }

    const h2 = await boot({ dir, clock });
    try {
        const job = createRefusalJob({ db: h2.db, registry: h2.registry, pool: h2.pool, clock, config: { refusal: { enabled: true } } });
        assert.strictEqual(await job.due(), false, 'the week did not restart with the deploy');
        now += 8 * 24 * 60 * 60 * 1000;
        assert.strictEqual(await job.due(), true, 'a week later the job is due again');
    } finally { await h2.stop(); }
});

t.test('the rate is the refusals over the attempts, with the day, and unknown stays unknown', async () => {
    assert.strictEqual(rateOf(0, 0), null, 'nothing asked is unknown, never zero');
    assert.strictEqual(rateOf(3, 4), 0.75, 'three of four probes refused');
    assert.strictEqual(rateOf(0, 4), 0, 'a model that refused nothing has a rate of zero');
    const h = await boot();
    try {
        await request(h.base, 'POST', '/api/v1/providers', { tok: service, body: {
            key: 'up', kind: 'openai', base_url: 'http://127.0.0.1:9/v1', auth_mode: 'none', default_model: 'gpt-up',
            capabilities: ['chat'], provider_access: 'OWN_DEPLOYMENT', billing_profile: 'metered' } });
        await request(h.base, 'POST', '/api/v1/models', { tok: service, body: {
            provider_key: 'up', model_key: 'gpt-up', type: 'chat', cost: { in_per_mtok: 1, out_per_mtok: 2 } } });
        const job = createRefusalJob({
            db: h.db, registry: h.registry, pool: h.pool, config: { refusal: { enabled: true, probesPerOffer: 4 } },
            measure: async () => ({ refusals: 3, attempts: 4 }),
        });
        await job.runOnce({ force: true });
        const row = await h.db.prepare('SELECT * FROM refusal_rates WHERE provider_key = ? AND model_key = ?').get('up', 'gpt-up');
        assert.ok(row, 'the rate was stored');
        assert.strictEqual(Number(row.refusal_rate), 0.75, 'the rate is the refusals over the attempts');
        assert.strictEqual(Number(row.refusals), 3);
        assert.strictEqual(Number(row.attempts), 4);
        assert.strictEqual(String(row.measured_on).slice(0, 10), new Date().toISOString().slice(0, 10), 'the rate carries the day it was measured');
        assert.ok(row.prompt_set, 'the rate says which probe set it was measured with');
    } finally { await h.stop(); }
});

t.test('a community offer above half the retail price is not eligible', async () => {
    const model = { provider_key: 'up', model_key: 'gpt-up', cost: { in_per_mtok: 1, out_per_mtok: 2 }, metadata: { rate_version: 'retail-1' } };
    const world = (offer) => ({
        registry: { listModels: async () => [model], getProvider: async () => ({ key: 'up', status: 'active', metadata: {} }) },
        community: { offers: async () => (offer ? [offer] : []) },
    });
    const dear = { offer_id: 'off_1', models: ['gpt-up'], price: { in_per_million: 2, out_per_million: 4 } };
    const dearCapacity = await batchCapacity(model, new Date('2026-11-07T12:00:00Z'), world(dear));
    assert.strictEqual(dearCapacity.routes.length, 0, 'a community offer above half the retail price is not eligible');
    assert.strictEqual(dearCapacity.charge.nano_usd_per_m.input, '500000000', 'the charge is half the retail card');
    const cheap = { offer_id: 'off_2', models: ['gpt-up'], price: { in_per_million: 0.2, out_per_million: 0.4 } };
    const cheapCapacity = await batchCapacity(model, new Date('2026-11-07T12:00:00Z'), world(cheap));
    assert.strictEqual(cheapCapacity.routes.length, 1, 'a community offer at a quarter of the retail price is eligible');
    assert.strictEqual(cheapCapacity.routes[0].source, 'community');
});

t.test('a batch item on an ordinary paid route never runs: it expires uncharged', async () => {
    const billing = await fakeBilling();
    const up = await upstream();
    let now = Date.now();
    const clock = { now: () => now };
    const h = await bootWith(billing, clock);
    try {
        await seed(h, up, { primary: 'paid', providers: ['paid'] });
        const id = await submit(h, { hours: 1 });
        await h.batches.runOnce();
        let item = await itemOf(h, id);
        assert.strictEqual(item.status, 'waiting', 'no low-cost capacity: the item waits');
        assert.strictEqual(billing.calls.filter((c) => c.path.endsWith('/settle')).length, 0, 'nothing was charged');
        // The deadline passes with no eligible capacity: the item expires, and it is never charged.
        now += 2 * 3600 * 1000;
        await h.batches.runOnce();
        item = await itemOf(h, id);
        assert.strictEqual(item.status, 'expired', 'the item expired');
        assert.strictEqual(item.reason, EXPIRED_REASON, 'and says why, in plain words');
        assert.strictEqual(String(item.charged_nano_usd), '0', 'and it was never charged');
        assert.strictEqual(billing.calls.filter((c) => c.path.endsWith('/settle')).length, 0, 'no settle at all');
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('a batch item on OpenVibe\'s own route runs and is charged half', async () => {
    const billing = await fakeBilling();
    const up = await upstream();
    const h = await bootWith(billing);
    try {
        await seed(h, up, { primary: 'own' });
        const id = await submit(h);
        await h.batches.runOnce();
        const item = await itemOf(h, id);
        assert.strictEqual(item.status, 'succeeded', JSON.stringify(item));
        assert.strictEqual(item.capacity, 'own', 'it ran on the network\'s own capacity');
        assert.ok(item.answer, 'the answer is in the batch');
        const settles = billing.calls.filter((c) => c.path.endsWith('/settle'));
        assert.strictEqual(settles.length, 1, 'the item was billed once');
        assert.ok(settles[0].body.retail.version.endsWith(':batch-half'), 'the batch card says what it is');
        // The charge is half of what the same usage costs at the retail card.
        const retail = settles[0].body.retail;
        const full = {
            nano_usd_per_m: {
                input: String(BigInt(retail.nano_usd_per_m.input) * 2n),
                cached_read: String(BigInt(retail.nano_usd_per_m.cached_read) * 2n),
                cache_write: String(BigInt(retail.nano_usd_per_m.cache_write) * 2n),
                output: String(BigInt(retail.nano_usd_per_m.output) * 2n),
            },
            per_request_nano_usd: String(BigInt(retail.per_request_nano_usd) * 2n),
        };
        const charged = BigInt([...billing.settlements.values()][0].charge_nano_usd);
        const atRetail = billing.chargeOf(settles[0].body.usage, full);
        assert.strictEqual(charged * 2n, atRetail, 'the batch was charged half');
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('with a loss budget the item runs on regular capacity, and the absorbed amount is recorded and capped', async () => {
    const billing = await fakeBilling();
    const up = await upstream();
    let now = Date.now();
    const clock = { now: () => now };
    const h = await bootWith(billing, clock);
    try {
        await seed(h, up, { primary: 'paid', providers: ['paid'] });
        h.batches.settings.lossBudgetUsdPerDay = 1;
        const id = await submit(h, { hours: 1 });
        now += 2 * 3600 * 1000;
        await h.batches.runOnce();
        const item = await itemOf(h, id);
        assert.strictEqual(item.status, 'succeeded', JSON.stringify(item));
        assert.strictEqual(item.capacity, 'regular', 'it ran on regular capacity');
        assert.ok(BigInt(item.absorbed_nano_usd) > 0n, 'the absorbed amount is recorded on the item');
        const batch = (await request(h.base, 'GET', `/api/v1/batches/${id}`, { tok: producer })).body.batch;
        assert.strictEqual(batch.ran_on_regular_capacity, true, 'the batch says it ran on regular capacity');
        // The budget is per UTC day: with a budget too small to cover the difference, the item expires.
        h.batches.settings.lossBudgetUsdPerDay = 0.000000001;
        const second = await submit(h, { hours: 1 });
        now += 2 * 3600 * 1000;
        await h.batches.runOnce();
        const expired = await itemOf(h, second);
        assert.strictEqual(expired.status, 'expired', 'the budget is capped, so the item expires instead');
        assert.strictEqual(String(expired.charged_nano_usd), '0', 'and it is never charged');
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('the settle check refuses a route whose cost exceeds the charge', async () => {
    const billing = await fakeBilling();
    const up = await upstream({ failFirst: true });
    const h = await bootWith(billing);
    try {
        // The route's own offer fails, and the router falls over to the paid one: the answer came from a
        // route that costs more than the customer paid, so the settle is refused.
        await seed(h, up, { primary: 'own', fallbacks: [{ provider: 'paid', model: 'gpt-up' }] });
        const id = await submit(h);
        await h.batches.runOnce();
        const item = await itemOf(h, id);
        assert.strictEqual(item.status, 'waiting', 'the item waits for a route it can afford');
        assert.strictEqual(item.error_code, 'batch.cost_exceeded', 'and says why');
        assert.strictEqual(billing.calls.filter((c) => c.path.endsWith('/settle')).length, 0, 'nothing was charged');
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('a batch over the cap is refused, and nothing is stored', async () => {
    const h = await boot();
    try {
        const items = Array.from({ length: 1001 }, (_, i) => ({ prompt: `prompt number ${i}` }));
        const r = await request(h.base, 'POST', '/api/v1/batches', { tok: producer, body: { items } });
        assert.strictEqual(r.status, 422, r.text);
        assert.strictEqual(r.body.code, 'batch.too_large', r.text);
        const rows = await h.db.prepare('SELECT COUNT(*)::int AS n FROM batches').get();
        assert.strictEqual(rows.n, 0, 'nothing was stored');
    } finally { await h.stop(); }
});

t.run();
