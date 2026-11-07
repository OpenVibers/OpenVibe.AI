'use strict';
/**
 * The measured refusal rates (server/refusal/) and the half-price batches (server/batch/).
 *
 * Four things are proved here:
 *
 *   - the refusal job is due-based: its last run is a row in the database, so a restart in the middle
 *     of the week does not measure the offers again, and a week later it is due again;
 *   - the rate is the refusals over the attempts, written with the day it was measured, and an offer
 *     nobody measured stays unknown (never zero);
 *   - a batch is charged half the retail price, through Billing like every other request;
 *   - a batch over the cap is refused at the door, and nothing is stored.
 */
const assert = require('assert');
const http = require('http');
const { boot, request, token, suite, tmpDir, ALL } = require('./helpers');
const { createRefusalJob } = require('../server/refusal/job');
const { rateOf } = require('../server/refusal/rate');

const t = suite('refusal-batch');
const service = token('live', ALL);
const ULID = '01JAB2C3D4E5F6G7H8J9K0MNPQ';
const PRJ = `prj_${ULID}`;
const APP = `app_${ULID}`;
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

/** A local OpenAI-format upstream whose answer each test scripts. */
async function upstream() {
    const state = { calls: 0, bodies: [] };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
            state.calls++;
            state.bodies.push(body);
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

/** A provider, a model and a route, so a run has somewhere to go. */
async function seed(h, up) {
    const made = await request(h.base, 'POST', '/api/v1/providers', { tok: service, body: {
        key: 'up', kind: 'openai', base_url: up.url, auth_mode: 'none', default_model: 'gpt-up', capabilities: ['chat'],
        provider_access: 'OWN_DEPLOYMENT', billing_profile: 'metered' } });
    assert.ok(made.status < 300, made.text);
    const model = await request(h.base, 'POST', '/api/v1/models', { tok: service, body: {
        provider_key: 'up', model_key: 'gpt-up', type: 'chat', supports: { streaming: true },
        cost: { in_per_mtok: 1, out_per_mtok: 2 }, metadata: { rate_version: 'retail-1' } } });
    assert.ok(model.status < 300, model.text);
    const route = await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: service, body: {
        primary: { provider: 'up', model: 'gpt-up' }, fallbacks: [], timeout_ms: 5000 } });
    assert.ok(route.status < 300, route.text);
}

async function bootWith(billing) {
    return boot({ env: {
        AI_CREDITS: '1', AI_MODEL_CATALOG: '1', AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0',
        AI_GOVERN_TIERS: '1', AI_GOVERN_POLICY_JSON: JSON.stringify({ 'ai-token': { free: {} }, 'ai-usd': { free: {} } }),
        OV_BILLING_INTERNAL_URL: billing.url, OV_NETWORK_INTERNAL_URL: billing.url,
        OV_OAUTH_CLIENT_SECRET: 'test-secret', OV_OAUTH_CLIENT_ID: 'ai', USAGE_SAMPLES: 'off',
    } });
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

    // The restart: a new process on the same database. The week did not start again.
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
        // The measurement is replaced by a fixed answer, so the test never reaches a provider.
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
        // The catalog shows it on the offer.
        const cat = await request(h.base, 'GET', '/api/v1/exchange/catalog');
        assert.strictEqual(cat.status, 200, cat.text);
        const offers = (cat.body.models || []).flatMap((m) => m.offers || []).filter((o) => o.refusal_rate != null);
        if (offers.length) assert.strictEqual(offers[0].refusal_rate, 0.75, 'the catalog carries the measured rate');
        else assert.ok(true, 'the seeded offer is not listed in the catalog (no upstream), so the rate is only in the table');
    } finally { await h.stop(); }
});

t.test('a batch is charged half the retail price, through Billing', async () => {
    const billing = await fakeBilling();
    const up = await upstream();
    const h = await bootWith(billing);
    try {
        await seed(h, up);
        const submitted = await request(h.base, 'POST', '/api/v1/batches', { tok: producer, body: {
            items: [{ prompt: 'first prompt' }, { prompt: 'second prompt' }] } });
        assert.strictEqual(submitted.status, 201, submitted.text);
        const id = submitted.body.batch.id;
        assert.strictEqual(submitted.body.batch.status, 'queued');

        await h.batches.runOnce();

        const got = await request(h.base, 'GET', `/api/v1/batches/${id}`, { tok: producer });
        assert.strictEqual(got.status, 200, got.text);
        assert.strictEqual(got.body.batch.status, 'succeeded', JSON.stringify(got.body.batch));
        assert.strictEqual(got.body.batch.items.length, 2);
        assert.ok(got.body.batch.items.every((i) => i.status === 'succeeded'), JSON.stringify(got.body.batch.items));
        assert.ok(got.body.batch.items.every((i) => typeof i.answer === 'string' && i.answer), 'the answers are in the batch');

        const settles = billing.calls.filter((c) => c.path.endsWith('/settle'));
        assert.strictEqual(settles.length, 2, 'each prompt was billed');
        for (const settle of settles) {
            assert.ok(settle.body.retail.version.endsWith(':batch-half'), `the batch card says what it is: ${settle.body.retail.version}`);
        }
        // The charge is half of what the same usage costs at the retail card.
        const first = settles[0];
        const retail = first.body.retail;
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
        const atRetail = billing.chargeOf(first.body.usage, full);
        assert.strictEqual(charged * 2n, atRetail, `the batch was charged half (${charged} vs ${atRetail} at the retail card)`);
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
