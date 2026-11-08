'use strict';
/**
 * BA3: a run whose latency class is 'batch' waits for a provider's own batch API.
 *
 *   - the run is created at once (202, status queued, latency_class 'batch') and takes no provider call;
 *   - the provider's batch answer finishes the same run, at the provider's batch price;
 *   - a restart while it waits leaves it queued, and the answer still finishes it;
 *   - ?wait= is answered at once with the queued run, never held for hours;
 *   - past deadline_hours the item re-routes to the background class once, and the run says it was clamped;
 *   - a route with no batch provider runs in the background class at once and says it was clamped.
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('batch-run');
const MODEL = 'gpt-4o-mini';

/** A stub provider that speaks the OpenAI batch API and answers an ordinary chat call too. */
function stubProvider() {
    const state = { files: new Map(), batches: new Map(), seq: 0, calls: [] };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const p = new URL(req.url, 'http://x').pathname;
            let body = {};
            try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
            state.calls.push({ path: p, method: req.method, body });
            const send = (status, out, type) => {
                res.writeHead(status, { 'Content-Type': type || 'application/json' });
                res.end(typeof out === 'string' ? out : JSON.stringify(out));
            };
            if (p === '/v1/files' && req.method === 'POST') {
                const id = `file_${++state.seq}`;
                state.files.set(id, body.file || '');
                return send(200, { id, object: 'file', bytes: (body.file || '').length });
            }
            if (p === '/v1/batches' && req.method === 'POST') {
                const id = `batch_${++state.seq}`;
                state.batches.set(id, { input_file_id: body.input_file_id, status: 'in_progress', output_file_id: null });
                return send(200, { id, object: 'batch', status: 'in_progress' });
            }
            if (p.startsWith('/v1/batches/')) {
                const b = state.batches.get(p.split('/')[3]);
                if (!b) return send(404, { error: { message: 'no such batch' } });
                return send(200, { id: p.split('/')[3], object: 'batch', status: b.status, output_file_id: b.output_file_id, error_file_id: null });
            }
            if (p.startsWith('/v1/files/') && p.endsWith('/content')) {
                return send(200, state.files.get(p.split('/')[3]) || '', 'application/x-ndjson');
            }
            if (p === '/v1/chat/completions') {
                return send(200, { id: 'cmpl_1', object: 'chat.completion', model: body.model || MODEL,
                    choices: [{ index: 0, message: { role: 'assistant', content: 'the ordinary path answered' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
            }
            return send(404, { error: { message: 'not found' } });
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const url = `http://127.0.0.1:${server.address().port}`;
            resolve({
                url, state,
                close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
                /** The provider answers every request in its file. */
                answer(id, { text = 'the batch answer' } = {}) {
                    const b = state.batches.get(id);
                    const lines = (state.files.get(b.input_file_id) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
                    const out = lines.map((line) => JSON.stringify({
                        id: 'req_1', custom_id: line.custom_id,
                        response: { status_code: 200, body: { id: 'cmpl_1', object: 'chat.completion', model: line.body.model,
                            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
                            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } } },
                        error: null,
                    }));
                    const outId = `file_out_${++state.seq}`;
                    state.files.set(outId, out.join('\n'));
                    b.output_file_id = outId;
                    b.status = 'completed';
                    return id;
                },
            });
        });
    });
}

/** A booted service whose shared provider is the stub, with a price card for the model. */
async function bootWith(stub, { env = {}, dir = undefined, priced = true } = {}) {
    const h = await boot({ dir, env: { AI_BATCH_NATIVE_MAX_ITEMS: '2', AI_BATCH_NATIVE_MAX_AGE_MS: '60000', ...env } });
    await h.registry.upsertProvider({ key: 'shared', base_url: `${stub.url}/v1`, auth_mode: 'none', provider_access: 'OWN_DEPLOYMENT' }, { actor: 'test' });
    if (priced) await h.registry.upsertModel({ provider_key: 'shared', model_key: MODEL, type: 'chat', cost: { in_per_mtok: 1, out_per_mtok: 2, source: 'urn:openvibe:ai:test', verified_at: '2026-01-01' } }, { actor: 'test' });
    return h;
}

/** A small fake Billing: the hold and the settle, and what they were told. */
async function fakeBilling() {
    const state = { balance: 1000000000000n, held: 0n, holds: new Map(), settlements: [], seq: 0 };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const p = new URL(req.url, 'http://x').pathname;
            let body = {};
            try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
            const send = (status, out) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)); };
            if (p === '/internal/credits/holds') {
                const want = BigInt(String(body.max_nano_usd || '0'));
                if (want > state.balance - state.held) return send(402, { detail: 'not enough balance', title: 'Insufficient funds' });
                const id = `hld_${++state.seq}`;
                state.holds.set(body.idempotency_key, { hold_id: id, held_nano_usd: String(body.max_nano_usd) });
                state.held += want;
                return send(201, { hold_id: id, held_nano_usd: String(body.max_nano_usd), available_nano_usd: String(state.balance - state.held), lease_expires_at: new Date(Date.now() + 300000).toISOString() });
            }
            if (p.startsWith('/internal/credits/holds/') && p.endsWith('/settle')) {
                state.settlements.push({ path: p, body });
                const hold = [...state.holds.values()].find((x) => x.hold_id === decodeURIComponent(p.split('/')[4]));
                return send(201, { charge_nano_usd: '0', released_nano_usd: String(hold ? hold.held_nano_usd : '0'), journal_id: `txn_${state.settlements.length}`, shortfall_nano_usd: '0' });
            }
            if (p.startsWith('/internal/credits/holds/') && p.endsWith('/release')) return send(200, { released: true });
            if (p === '/oauth/token') return send(200, { access_token: 'test-token', token_type: 'Bearer', expires_in: 300, scope: '' });
            if (p === '/api/v1/usage') return send(201, { ok: true });
            return send(404, { error: 'not found' });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    return { url, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

async function ageGroup(h) {
    await h.db.prepare("UPDATE batch_queue SET created_at = ? WHERE status = 'queued'").run(new Date(Date.now() - 60000).toISOString());
}

const tok = () => token('all', ALL, { sub: 'svc:test' });
const body = (extra = {}) => ({ workflow: 'ai.generate', input: { prompt: 'take your time' }, options: { latency: 'batch', cache: false }, ...extra });

t.test('a batch-class run is queued, answered by the provider\'s batch, and charged the batch price', async () => {
    const stub = await stubProvider();
    const h = await bootWith(stub);
    try {
        const started = Date.now();
        const res = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: tok(), body: body() });
        const took = Date.now() - started;
        assert.strictEqual(res.status, 202, `the queued run is 202 (${res.text})`);
        assert.strictEqual(res.body.run.status, 'queued');
        assert.strictEqual(res.body.run.latency_class, 'batch');
        assert.strictEqual(res.body.run.latency_clamped, null);
        assert.ok(took < 3000, `?wait= did not hold the caller (${took} ms)`);
        // The run has no provider call and waits in the database.
        const requests = await h.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE run_id = ?').get(res.body.run.id);
        assert.strictEqual(Number(requests.n), 0);
        const item = await h.db.prepare('SELECT * FROM batch_queue WHERE run_id = ?').get(res.body.run.id);
        assert.ok(item, 'the run waits in the batch queue');
        assert.strictEqual(item.kind, 'service');
        assert.strictEqual(JSON.parse(item.plan).runLevel, true, `the plan is a run-level plan: ${item.plan}`);
        assert.strictEqual(JSON.parse(item.plan).stepKind, 'llm');
        assert.strictEqual(stub.state.calls.filter((c) => c.path === '/v1/batches').length, 0);

        await ageGroup(h);
        const submitted = await h.batcher.submitOnce();
        assert.strictEqual(submitted.sent, 1);
        const providerBatch = stub.state.batches.keys().next().value;
        stub.answer(providerBatch, { text: 'the batch answer' });
        await h.batcher.pollOnce();

        const run = await h.db.prepare('SELECT * FROM runs WHERE id = ?').get(res.body.run.id);
        assert.strictEqual(run.status, 'succeeded');
        assert.strictEqual(run.latency_class, 'batch', 'the run it was created as');
        assert.strictEqual(run.service_tier, 'batch', 'the tier the provider really ran');
        assert.strictEqual(JSON.parse(run.output).text, 'the batch answer');
        // 100 input tokens at 1 USD/M and 50 output at 2 USD/M, both at the provider's half-price batch.
        const expected = Number((100n * 500000000n + 50n * 1000000000n) / 1000000n) / 1e9;
        assert.strictEqual(Number(run.cost_usd), expected, 'the run cost is the batch price');
        assert.ok(Number(run.cost_usd) > 0);
    } finally { await h.stop(); await stub.close(); }
});

t.test('an ai.complete run is answered by the provider\'s batch with its choices intact', async () => {
    const stub = await stubProvider();
    const h = await bootWith(stub);
    try {
        const res = await request(h.base, 'POST', '/api/v1/runs?wait=5000', {
            tok: tok(),
            body: { workflow: 'ai.complete', input: { messages: [{ role: 'user', content: 'hello' }] }, options: { latency: 'batch', cache: false } },
        });
        assert.strictEqual(res.status, 202, res.text);
        await ageGroup(h);
        await h.batcher.submitOnce();
        stub.answer(stub.state.batches.keys().next().value, { text: 'the complete batch answer' });
        await h.batcher.pollOnce();
        const run = await h.db.prepare('SELECT * FROM runs WHERE id = ?').get(res.body.run.id);
        assert.strictEqual(run.status, 'succeeded');
        const out = JSON.parse(run.output);
        assert.strictEqual(out.choices[0].message.content, 'the complete batch answer');
        assert.strictEqual(Number(run.tokens_in), 100);
        assert.strictEqual(Number(run.tokens_out), 50);
    } finally { await h.stop(); await stub.close(); }
});

t.test('a restart while the run waits leaves it queued, and the batch answer still finishes it', async () => {
    const stub = await stubProvider();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-batch-run-restart-'));
    const h1 = await bootWith(stub, { dir });
    let runId;
    try {
        const res = await request(h1.base, 'POST', '/api/v1/runs?wait=5000', { tok: tok(), body: body() });
        assert.strictEqual(res.status, 202, res.text);
        runId = res.body.run.id;
        await h1.stop();

        const h2 = await bootWith(stub, { dir });
        try {
            const left = await h2.db.prepare('SELECT status, latency_class FROM runs WHERE id = ?').get(runId);
            assert.strictEqual(left.status, 'queued', 'the restart did not fail the waiting run');
            assert.strictEqual(left.latency_class, 'batch');
            await ageGroup(h2);
            await h2.batcher.submitOnce();
            stub.answer(stub.state.batches.keys().next().value, { text: 'the answer after the restart' });
            await h2.batcher.pollOnce();
            const done = await h2.db.prepare('SELECT status, output, cost_usd FROM runs WHERE id = ?').get(runId);
            assert.strictEqual(done.status, 'succeeded');
            assert.strictEqual(JSON.parse(done.output).text, 'the answer after the restart');
            assert.ok(Number(done.cost_usd) > 0, 'the batch cost is on the run');
        } finally { await h2.stop(); }
    } finally { await stub.close(); }
});

t.test('past deadline_hours the run re-routes to the background class once, and says it was clamped', async () => {
    const stub = await stubProvider();
    const h = await bootWith(stub);
    try {
        const res = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: tok(), body: body({ options: { latency: 'batch', deadline_hours: 1, cache: false } }) });
        assert.strictEqual(res.status, 202, res.text);
        // The deadline passes while the item still waits for a group.
        await h.db.prepare('UPDATE batch_queue SET deadline_at = ? WHERE run_id = ?').run(new Date(Date.now() - 1000).toISOString(), res.body.run.id);
        await h.batcher.submitOnce();
        // It was never handed to the provider: it re-routed instead.
        assert.strictEqual(stub.state.calls.filter((c) => c.path === '/v1/batches').length, 0);
        const item = await h.db.prepare('SELECT status FROM batch_queue WHERE run_id = ?').get(res.body.run.id);
        assert.strictEqual(item.status, 'rerouted');
        const run = await h.db.prepare('SELECT * FROM runs WHERE id = ?').get(res.body.run.id);
        assert.strictEqual(run.status, 'succeeded', 'the background path answered it');
        assert.strictEqual(run.latency_class, 'background');
        assert.deepStrictEqual(JSON.parse(run.options).latency_clamped, { asked: 'batch', used: 'background' });
        assert.strictEqual(JSON.parse(run.output).text, 'the ordinary path answered');
        // Once: another pass does not send it or run it again.
        await h.batcher.submitOnce();
        await h.batcher.pollOnce();
        assert.strictEqual(stub.state.calls.filter((c) => c.path === '/v1/batches').length, 0);
        const after = await h.db.prepare('SELECT status FROM batch_queue WHERE run_id = ?').get(res.body.run.id);
        assert.strictEqual(after.status, 'rerouted');
    } finally { await h.stop(); await stub.close(); }
});

t.test('a route with no batch provider runs in the background class at once and says it was clamped', async () => {
    const stub = await stubProvider();
    const h = await bootWith(stub, { priced: false });
    try {
        const res = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: tok(), body: body() });
        assert.strictEqual(res.status, 201, `no provider can batch, so the run answers (${res.text})`);
        assert.strictEqual(res.body.run.latency_class, 'background');
        assert.deepStrictEqual(res.body.run.latency_clamped, { asked: 'batch', used: 'background' });
        assert.strictEqual((await h.db.prepare('SELECT COUNT(*) AS n FROM batch_queue').get()).n, 0, 'nothing waits for a batch');
        assert.strictEqual(JSON.parse(JSON.stringify(res.body.run.output)).text, 'the ordinary path answered');
    } finally { await h.stop(); await stub.close(); }
});

t.test('the ordinary payer is charged the batch price, and the Balance is checked when the run is queued', async () => {
    const stub = await stubProvider();
    const billing = await fakeBilling();
    const h = await bootWith(stub, {
        env: {
            AI_CREDITS: '1', USAGE_SAMPLES: 'off',
            OV_BILLING_INTERNAL_URL: billing.url, OV_NETWORK_INTERNAL_URL: billing.url,
            OV_OAUTH_CLIENT_SECRET: 'test-secret', OV_OAUTH_CLIENT_ID: 'ai',
        },
    });
    try {
        const person = token('dana', ALL, { sub: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2B3', actorType: 'user' });
        const res = await request(h.base, 'POST', '/api/v1/runs?wait=5000', {
            tok: person,
            body: { workflow: 'ai.complete', input: { messages: [{ role: 'user', content: 'hello' }] }, options: { latency: 'batch', cache: false } },
        });
        assert.strictEqual(res.status, 202, res.text);
        // BA2's probe checked the person's Balance when the run was queued (under its own key).
        assert.ok([...billing.state.holds.keys()].some((k) => String(k).includes(':probe:')), 'the queued run probed the Balance');
        await ageGroup(h);
        await h.batcher.submitOnce();
        stub.answer(stub.state.batches.keys().next().value, { text: 'the paid batch answer' });
        await h.batcher.pollOnce();

        const settle = billing.state.settlements[0];
        assert.ok(settle, 'the ordinary payer was charged');
        assert.strictEqual(settle.body.retail.nano_usd_per_m.input, '500000000', 'half the retail input price');
        assert.strictEqual(settle.body.retail.nano_usd_per_m.output, '1000000000', 'half the retail output price');
        const run = await h.db.prepare('SELECT status, cost_usd, service_tier FROM runs WHERE id = ?').get(res.body.run.id);
        assert.strictEqual(run.status, 'succeeded');
        assert.strictEqual(run.service_tier, 'batch');
        assert.strictEqual(String(settle.body.supply_cost_nano_usd), String(Math.round(Number(run.cost_usd) * 1e9)));
    } finally { await h.stop(); await stub.close(); await billing.close(); }
});

t.test('deadline_hours is 1 to 72', async () => {
    const stub = await stubProvider();
    const h = await bootWith(stub);
    try {
        for (const hours of [0, 73, 'soon']) {
            const res = await request(h.base, 'POST', '/api/v1/runs', { tok: tok(), body: body({ options: { latency: 'batch', deadline_hours: hours } }) });
            assert.strictEqual(res.status, 422, `${hours}: ${res.text}`);
            assert.strictEqual(res.body.code, 'input.invalid');
        }
    } finally { await h.stop(); await stub.close(); }
});

t.run();
