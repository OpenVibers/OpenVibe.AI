'use strict';
/**
 * BA2: the native batcher, end to end against a stub provider (no real key, no real provider).
 *
 * The stub speaks OpenAI's batch API (POST /v1/files, POST /v1/batches, GET /v1/batches/:id and the
 * content of an output or error file), so the whole path is exercised: the queue, the group, the
 * provider's file, the answers, the failure of one request, the re-route of a batch that misses its
 * deadline, and the money of a customer batch settled at half the price.
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot, request, token, suite, ALL } = require('./helpers');
const { createOpenAiCompatibleAdapter } = require('../server/batch/providers/openai-compatible');

const t = suite('batch-native');
const MODEL = 'gpt-5-nano';
const PRINCIPAL = { kind: 'service', sub: 'svc:test', subject: { type: 'service', id: 'test' }, onBehalfOf: null };

/** A stub provider that speaks OpenAI's batch API. */
function stubProvider() {
    const state = { files: new Map(), batches: new Map(), seq: 0, calls: [] };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const path = new URL(req.url, 'http://x').pathname;
            let body = {};
            try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
            state.calls.push({ path, method: req.method, body });
            const send = (status, out, type) => {
                res.writeHead(status, { 'Content-Type': type || 'application/json' });
                res.end(typeof out === 'string' ? out : JSON.stringify(out));
            };
            if (path === '/v1/files' && req.method === 'POST') {
                const id = `file_${++state.seq}`;
                state.files.set(id, body.file || '');
                return send(200, { id, object: 'file', bytes: (body.file || '').length });
            }
            if (path === '/v1/batches' && req.method === 'POST') {
                const id = `batch_${++state.seq}`;
                state.batches.set(id, { input_file_id: body.input_file_id, status: 'in_progress', output_file_id: null, error_file_id: null });
                return send(200, { id, object: 'batch', status: 'in_progress' });
            }
            if (path.startsWith('/v1/batches/')) {
                const id = path.split('/')[3];
                const b = state.batches.get(id);
                if (!b) return send(404, { error: { message: 'no such batch' } });
                return send(200, { id, object: 'batch', status: b.status, output_file_id: b.output_file_id, error_file_id: b.error_file_id });
            }
            if (path.startsWith('/v1/files/') && path.endsWith('/content')) {
                const id = path.split('/')[3];
                return send(200, state.files.get(id) || '', 'application/x-ndjson');
            }
            if (path === '/v1/chat/completions') {
                return send(200, { id: 'cmpl_1', object: 'chat.completion', model: body.model || MODEL, choices: [{ index: 0, message: { role: 'assistant', content: 'the ordinary path answered' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
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
                /** The provider's answers for a batch: one line per request, plus the errors of the refused ones. */
                answer(id, { text = null, error = null } = {}) {
                    const b = state.batches.get(id);
                    const file = state.files.get(b.input_file_id) || '';
                    const lines = file.split('\n').filter(Boolean).map((l) => JSON.parse(l));
                    const out = [];
                    const errs = [];
                    for (const line of lines) {
                        if (error && error.custom_id === line.custom_id) {
                            errs.push(JSON.stringify({ id: 'req_x', custom_id: line.custom_id, response: null, error: { code: error.code || 'server_error', message: error.message || 'the provider failed this request' } }));
                            continue;
                        }
                        out.push(JSON.stringify({
                            id: 'req_1', custom_id: line.custom_id,
                            response: { status_code: 200, body: { id: 'cmpl_1', object: 'chat.completion', model: line.body.model, choices: [{ index: 0, message: { role: 'assistant', content: (text && text[line.custom_id]) || `answer for ${line.custom_id}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } } },
                            error: null,
                        }));
                    }
                    const outId = `file_out_${++state.seq}`;
                    state.files.set(outId, out.join('\n'));
                    b.output_file_id = outId;
                    if (errs.length) {
                        const errId = `file_err_${++state.seq}`;
                        state.files.set(errId, errs.join('\n'));
                        b.error_file_id = errId;
                    }
                    b.status = 'completed';
                    return id;
                },
            });
        });
    });
}

/** A booted service whose shared provider is the stub, with a price card for the model. */
async function bootWith(stub, env = {}, dir = undefined) {
    const h = await boot({ dir, env: { AI_BATCH_NATIVE_MAX_ITEMS: '2', AI_BATCH_NATIVE_MAX_AGE_MS: '60000', ...env } });
    await h.registry.upsertProvider({ key: 'shared', base_url: `${stub.url}/v1`, provider_access: 'OWN_DEPLOYMENT' }, { actor: 'test' });
    await h.registry.upsertModel({ provider_key: 'shared', model_key: MODEL, type: 'chat', cost: { in_per_mtok: 1, out_per_mtok: 2, source: 'urn:openvibe:ai:test', verified_at: '2026-01-01' } }, { actor: 'test' });
    return h;
}

t.test('the JSONL file has the provider\'s own shape, and the provider\'s own limits', () => {
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'http://x/v1', apiKey: 'k', limits: { maxItems: 3, maxBytes: 400, oneModelPerFile: true } });
    const file = adapter.buildFile([{ customId: 'bni_1', body: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] } }]);
    assert.deepStrictEqual(JSON.parse(file.lines[0]), {
        custom_id: 'bni_1', method: 'POST', url: '/v1/chat/completions',
        body: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.ok(file.bytes > 0);
    // The provider's own limits: too many requests, two models in one file, a file that is too big.
    assert.throws(() => adapter.buildFile([1, 2, 3, 4].map((n) => ({ customId: `bni_${n}`, body: { model: 'm1', messages: [] } }))), /at most 3 requests/);
    assert.throws(() => adapter.buildFile([{ customId: 'a', body: { model: 'm1', messages: [] } }, { customId: 'b', body: { model: 'm2', messages: [] } }]), /one model per file/);
    assert.throws(() => adapter.buildFile([{ customId: 'a', body: { model: 'm1', messages: [{ role: 'user', content: 'x'.repeat(500) }] } }]), /file limit/);
});

t.test('a full group is submitted to the provider as one batch', async () => {
    const stub = await stubProvider();
    const h = await bootWith(stub);
    try {
        await h.batcher.enqueue({ principal: PRINCIPAL, provider: 'shared', model: MODEL, prompt: 'one' });
        // Not full yet (the limit is two).
        await h.batcher.submitOnce();
        assert.strictEqual(stub.state.calls.filter((c) => c.path === '/v1/batches').length, 0);
        // The second item makes the group full: one file, one batch.
        await h.batcher.enqueue({ principal: PRINCIPAL, provider: 'shared', model: MODEL, prompt: 'two' });
        const res = await h.batcher.submitOnce();
        assert.strictEqual(res.sent, 1);
        const files = stub.state.calls.filter((c) => c.path === '/v1/files');
        const batches = stub.state.calls.filter((c) => c.path === '/v1/batches');
        assert.strictEqual(files.length, 1);
        assert.strictEqual(batches.length, 1);
        const lines = files[0].body.file.split('\n').filter(Boolean);
        assert.strictEqual(lines.length, 2);          // the group is two items, the third waits
        assert.strictEqual(batches[0].body.completion_window, '24h');
        assert.strictEqual(batches[0].body.endpoint, '/v1/chat/completions');
    } finally { await h.stop(); await stub.close(); }
});

t.test('an old group is submitted even when it is not full', async () => {
    const stub = await stubProvider();
    const h = await bootWith(stub, { AI_BATCH_NATIVE_MAX_AGE_MS: '1000' });
    try {
        const item = await h.batcher.enqueue({ principal: PRINCIPAL, provider: 'shared', model: MODEL, prompt: 'lonely' });
        // The group is one minute old: old enough to be sent.
        await h.db.prepare('UPDATE batch_queue SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), item.id);
        const res = await h.batcher.submitOnce();
        assert.strictEqual(res.sent, 1);
        assert.strictEqual(stub.state.calls.filter((c) => c.path === '/v1/batches').length, 1);
    } finally { await h.stop(); await stub.close(); }
});

t.test('the answers are mapped back onto their own runs by custom_id', async () => {
    const stub = await stubProvider();
    const h = await bootWith(stub);
    try {
        const a = await h.batcher.enqueue({ principal: PRINCIPAL, provider: 'shared', model: MODEL, prompt: 'first' });
        const b = await h.batcher.enqueue({ principal: PRINCIPAL, provider: 'shared', model: MODEL, prompt: 'second' });
        await h.batcher.submitOnce();
        const batchId = stub.state.batches.keys().next().value;
        stub.answer(batchId, { text: { [a.id]: 'the answer for a', [b.id]: 'the answer for b' } });
        await h.batcher.pollOnce();
        const runA = await h.db.prepare('SELECT * FROM runs WHERE id = ?').get(a.runId);
        const runB = await h.db.prepare('SELECT * FROM runs WHERE id = ?').get(b.runId);
        assert.strictEqual(runA.status, 'succeeded');
        assert.strictEqual(runB.status, 'succeeded');
        assert.strictEqual(JSON.parse(runA.output).text, 'the answer for a');
        assert.strictEqual(JSON.parse(runB.output).text, 'the answer for b');
        // The tokens are the provider's own, and the cost is the provider's batch price (half of its list price).
        assert.strictEqual(Number(runA.tokens_in), 100);
        assert.strictEqual(Number(runA.tokens_out), 50);
        // 100 input tokens at 1 USD per million, halved by the provider's batch price, plus the output.
        const expected = (100n * 1000000000n / 2n / 1000000n) + (50n * 2000000000n / 2n / 1000000n);
        assert.strictEqual(String(runA.cost_usd), String(Number(expected) / 1e9));
    } finally { await h.stop(); await stub.close(); }
});

t.test('a partial failure fails only its own item', async () => {
    const stub = await stubProvider();
    const h = await bootWith(stub);
    try {
        const a = await h.batcher.enqueue({ principal: PRINCIPAL, provider: 'shared', model: MODEL, prompt: 'first' });
        const b = await h.batcher.enqueue({ principal: PRINCIPAL, provider: 'shared', model: MODEL, prompt: 'second' });
        await h.batcher.submitOnce();
        const batchId = stub.state.batches.keys().next().value;
        stub.answer(batchId, { error: { custom_id: b.id, code: 'server_error', message: 'the provider refused this one' } });
        await h.batcher.pollOnce();
        const runA = await h.db.prepare('SELECT * FROM runs WHERE id = ?').get(a.runId);
        const runB = await h.db.prepare('SELECT * FROM runs WHERE id = ?').get(b.runId);
        assert.strictEqual(runA.status, 'succeeded');
        assert.strictEqual(runB.status, 'failed');
        assert.strictEqual(runB.error_code, 'server_error');
        const items = await h.db.prepare('SELECT status FROM batch_queue WHERE id IN (?, ?) ORDER BY id').all(a.id, b.id);
        assert.deepStrictEqual(items.map((i) => i.status).sort(), ['failed', 'succeeded']);
    } finally { await h.stop(); await stub.close(); }
});

t.test('a batch the provider cannot finish in time is re-routed to the ordinary path', async () => {
    const stub = await stubProvider();
    const h = await bootWith(stub);
    try {
        const item = await h.batcher.enqueue({ principal: PRINCIPAL, provider: 'shared', model: MODEL, prompt: 'late' });
        await h.batcher.enqueue({ principal: PRINCIPAL, provider: 'shared', model: MODEL, prompt: 'later' });
        // The deadline is already gone: the provider cannot meet it.
        await h.db.prepare('UPDATE batch_queue SET deadline_at = ? WHERE status = ?').run(new Date(Date.now() - 1000).toISOString(), 'queued');
        await h.batcher.submitOnce();
        await h.batcher.pollOnce();
        const row = await h.db.prepare('SELECT status, error_code FROM batch_queue WHERE id = ?').get(item.id);
        assert.strictEqual(row.status, 'rerouted');
        assert.strictEqual(row.error_code, 'batch.rerouted');
        // The run went back to the ordinary path: it is not waiting for the provider any more.
        const run = await h.db.prepare('SELECT status FROM runs WHERE id = ?').get(item.runId);
        assert.notStrictEqual(run.status, 'queued');
    } finally { await h.stop(); await stub.close(); }
});

t.test('two pollers never settle the same item twice', async () => {
    const stub = await stubProvider();
    const h = await bootWith(stub);
    try {
        const a = await h.batcher.enqueue({ principal: PRINCIPAL, provider: 'shared', model: MODEL, prompt: 'first' });
        await h.batcher.enqueue({ principal: PRINCIPAL, provider: 'shared', model: MODEL, prompt: 'second' });
        await h.batcher.submitOnce();
        const batchId = stub.state.batches.keys().next().value;
        stub.answer(batchId, { text: { [a.id]: 'only once' } });
        await h.batcher.pollOnce();
        await h.batcher.pollOnce();          // the second poller finds the batch settled
        const row = await h.db.prepare('SELECT status, cost_nano_usd FROM batch_queue WHERE id = ?').get(a.id);
        assert.strictEqual(row.status, 'succeeded');
        const run = await h.db.prepare('SELECT status, tokens_in, tokens_out FROM runs WHERE id = ?').get(a.runId);
        assert.strictEqual(run.status, 'succeeded');
        assert.strictEqual(Number(run.tokens_in), 100);
        assert.strictEqual(Number(run.tokens_out), 50);
    } finally { await h.stop(); await stub.close(); }
});

t.test('a customer batch runs on the native route and is settled at half the price', async () => {
    const stub = await stubProvider();
    const billing = await fakeBilling();
    const h = await bootWith(stub, {
        AI_CREDITS: '1', USAGE_SAMPLES: 'off',
        OV_BILLING_INTERNAL_URL: billing.url, OV_NETWORK_INTERNAL_URL: billing.url,
        OV_OAUTH_CLIENT_SECRET: 'test-secret', OV_OAUTH_CLIENT_ID: 'ai',
    });
    try {
        const ULID = '01JAB2C3D4E5F6G7H8J9K0MNPQ';
        const PRJ = `prj_${ULID}`;
        const appTok = token('app', ['ai.app.run'], { sub: `app:app_${ULID}`, actorType: 'app', ns: [PRJ, `app.${PRJ}.*`], extra: { project_id: PRJ, env: 'production' } });
        const res = await request(h.base, 'POST', '/api/v1/batches', { tok: appTok, body: { items: [{ prompt: 'a customer prompt' }], model: MODEL } });
        assert.strictEqual(res.status, 201);
        const batchId = res.body.batch.id;
        // The capacity: the native batch route of the shared provider is eligible, and it costs at most half.
        const model = await h.registry.listModels().then((rows) => rows.find((r) => r.model_key === MODEL));
        const capacity = await h.batcher.cardsFor('shared', MODEL);
        assert.ok(capacity.batch, 'the provider has a batch card');
        assert.ok(BigInt(capacity.batch.nano_usd_per_m.input) <= BigInt(String(Math.floor(1000000000 / 2))), 'the batch price is at most half the list price');
        // The batch worker puts the item on the native route.
        const run = await h.batches.runOnce();
        assert.ok(run.route === 'native-batch', JSON.stringify(run));
        assert.strictEqual(run.queued, true);
        // The provider answers it. The group is one item and not full, so it goes out when it is old.
        await h.db.prepare("UPDATE batch_queue SET created_at = ? WHERE status = 'queued'").run(new Date(Date.now() - 60000).toISOString());
        await h.batcher.submitOnce();
        const providerBatch = stub.state.batches.keys().next().value;
        stub.answer(providerBatch, { text: {} });
        await h.batcher.pollOnce();
        // The customer is charged half the retail price, and the network's real cost is the batch price.
        const settle = billing.state.settlements[0];
        assert.ok(settle, 'the customer was charged');
        assert.strictEqual(settle.body.retail.nano_usd_per_m.input, String(Math.floor(1000000000 / 2)));
        assert.strictEqual(settle.body.retail.nano_usd_per_m.output, String(Math.floor(2000000000 / 2)));
        const item = await h.db.prepare('SELECT status, answer, charged_nano_usd FROM batch_items WHERE batch_id = ?').get(batchId);
        assert.strictEqual(item.status, 'succeeded');
        assert.strictEqual(String(item.charged_nano_usd), String(settle.body.supply_cost_nano_usd));
    } finally { await h.stop(); await stub.close(); await billing.close(); }
});

/** A small fake Billing: the hold and the settle, and what they were told. */
async function fakeBilling({ balance = 1000000000000n } = {}) {
    const state = { balance: BigInt(balance), held: 0n, holds: new Map(), settlements: [], seq: 0 };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const path = new URL(req.url, 'http://x').pathname;
            let body = {};
            try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
            const send = (status, out) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)); };
            if (path === '/internal/credits/holds') {
                const want = BigInt(String(body.max_nano_usd || '0'));
                if (want > state.balance - state.held) {
                    return send(402, { detail: 'not enough balance', title: 'Insufficient funds' });
                }
                const prev = state.holds.get(body.idempotency_key);
                if (prev) return send(201, { hold_id: prev.hold_id, held_nano_usd: prev.held_nano_usd, available_nano_usd: String(state.balance - state.held), lease_expires_at: new Date(Date.now() + 300000).toISOString() });
                const id = `hld_${++state.seq}`;
                state.holds.set(body.idempotency_key, { hold_id: id, held_nano_usd: String(body.max_nano_usd) });
                state.held += BigInt(String(body.max_nano_usd));
                return send(201, { hold_id: id, held_nano_usd: String(body.max_nano_usd), available_nano_usd: String(state.balance - state.held), lease_expires_at: new Date(Date.now() + 300000).toISOString() });
            }
            if (path.startsWith('/internal/credits/holds/') && path.endsWith('/settle')) {
                state.settlements.push({ path, body });
                const hold = [...state.holds.values()].find((x) => x.hold_id === decodeURIComponent(path.split('/')[4]));
                const held = hold ? BigInt(hold.held_nano_usd) : 0n;
                return send(201, { charge_nano_usd: '0', released_nano_usd: String(held), journal_id: `txn_${state.settlements.length}`, shortfall_nano_usd: '0' });
            }
            if (path.startsWith('/internal/credits/holds/') && path.endsWith('/release')) {
                return send(200, { released: true });
            }
            if (path === '/oauth/token') return send(200, { access_token: 'test-token', token_type: 'Bearer', expires_in: 300, scope: '' });
            if (path === '/api/v1/usage') return send(201, { ok: true });
            return send(404, { error: 'not found' });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    return { url, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

t.test('a first-party service with the ai.batches.create grant may open a batch of the network\'s own', async () => {
    const stub = await stubProvider();
    const h = await bootWith(stub);
    try {
        // The grant: the batch is the network's own, and it names the service that asked.
        const granted = token('live', ['ai.run.create', 'ai.batches.create'], { sub: 'svc:live' });
        const res = await request(h.base, 'POST', '/api/v1/batches', { tok: granted, body: { items: [{ prompt: 'a service prompt' }], model: MODEL } });
        assert.strictEqual(res.status, 201, res.text);
        assert.strictEqual(res.body.batch.owner_type, 'service');
        assert.strictEqual(res.body.batch.owner_id, 'live');
        // A service without the grant may not open one.
        const plain = token('live', ['ai.run.create'], { sub: 'svc:live' });
        const refused = await request(h.base, 'POST', '/api/v1/batches', { tok: plain, body: { items: [{ prompt: 'a service prompt' }] } });
        assert.strictEqual(refused.status, 403);
        assert.strictEqual(refused.body.code, 'batch.no_grant');
    } finally { await h.stop(); await stub.close(); }
});

t.test('a restart while the batch waits leaves the run queued, and the answer still finishes it', async () => {
    const stub = await stubProvider();
    const billing = await fakeBilling();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-batch-restart-'));
    const env = {
        AI_CREDITS: '1', USAGE_SAMPLES: 'off',
        OV_BILLING_INTERNAL_URL: billing.url, OV_NETWORK_INTERNAL_URL: billing.url,
        OV_OAUTH_CLIENT_SECRET: 'test-secret', OV_OAUTH_CLIENT_ID: 'ai',
    };
    const h1 = await bootWith(stub, env, dir);
    try {
        const ULID = '01JAB2C3D4E5F6G7H8J9K0MNPQ';
        const PRJ = `prj_${ULID}`;
        const appTok = token('app', ['ai.app.run'], { sub: `app:app_${ULID}`, actorType: 'app', ns: [PRJ, `app.${PRJ}.*`], extra: { project_id: PRJ, env: 'production' } });
        const res = await request(h1.base, 'POST', '/api/v1/batches', { tok: appTok, body: { items: [{ prompt: 'a customer prompt' }], model: MODEL } });
        assert.strictEqual(res.status, 201, res.text);
        const run = await h1.batches.runOnce();
        assert.strictEqual(run.route, 'native-batch');
        assert.strictEqual(run.queued, true);
        const item = await h1.db.prepare('SELECT * FROM batch_items WHERE batch_id = ?').get(res.body.batch.id);
        // The group goes out to the provider.
        await h1.db.prepare("UPDATE batch_queue SET created_at = ? WHERE status = 'queued'").run(new Date(Date.now() - 60000).toISOString());
        await h1.batcher.submitOnce();
        assert.strictEqual(stub.state.calls.filter((c) => c.path === '/v1/batches').length, 1);
        // The service goes away with the run still waiting for the provider.
        await h1.stop();

        // A restart on the same database: the run is still waiting, so it is not interrupted.
        const h2 = await bootWith(stub, env, dir);
        try {
            const row = await h2.db.prepare('SELECT status FROM runs WHERE id = ?').get(item.run_id);
            assert.strictEqual(row.status, 'queued', 'the restart did not fail the waiting run');
            // The provider answers, and the run finishes on the ordinary path.
            const providerBatch = stub.state.batches.keys().next().value;
            stub.answer(providerBatch, { text: {} });
            await h2.batcher.pollOnce();
            const done = await h2.db.prepare('SELECT * FROM runs WHERE id = ?').get(item.run_id);
            assert.strictEqual(done.status, 'succeeded');
            assert.ok(String(done.output).includes('answer for'), 'the run carries the provider\'s answer');
            assert.ok(Number(done.cost_usd) > 0, 'the run carries the batch cost');
            assert.ok(billing.state.settlements.length >= 1, 'the customer was charged the ordinary way');
        } finally { await h2.stop(); }
    } finally { await stub.close(); await billing.close(); }
});

t.test('a customer who cannot pay is refused before the provider is given the work', async () => {
    const stub = await stubProvider();
    const billing = await fakeBilling({ balance: 1n });
    const h = await bootWith(stub, {
        AI_CREDITS: '1', USAGE_SAMPLES: 'off',
        OV_BILLING_INTERNAL_URL: billing.url, OV_NETWORK_INTERNAL_URL: billing.url,
        OV_OAUTH_CLIENT_SECRET: 'test-secret', OV_OAUTH_CLIENT_ID: 'ai',
    });
    try {
        const ULID = '01JAB2C3D4E5F6G7H8J9K0MNPQ';
        const PRJ = `prj_${ULID}`;
        const appTok = token('app', ['ai.app.run'], { sub: `app:app_${ULID}`, actorType: 'app', ns: [PRJ, `app.${PRJ}.*`], extra: { project_id: PRJ, env: 'production' } });
        const res = await request(h.base, 'POST', '/api/v1/batches', { tok: appTok, body: { items: [{ prompt: 'a customer prompt' }], model: MODEL } });
        assert.strictEqual(res.status, 201, res.text);
        const run = await h.batches.runOnce();
        assert.strictEqual(run.queued, false);
        assert.strictEqual(run.error, 'billing.insufficient_funds');
        // The provider was never asked to do the work: nobody owes it anything.
        assert.strictEqual(stub.state.calls.filter((c) => c.path === '/v1/batches').length, 0);
        const item = await h.db.prepare('SELECT * FROM batch_items WHERE batch_id = ?').get(res.body.batch.id);
        assert.strictEqual(item.status, 'failed');
        assert.strictEqual(item.error_code, 'billing.insufficient_funds');
    } finally { await h.stop(); await stub.close(); await billing.close(); }
});

t.test('a token without ai.batches.create is refused even when it carries every other AI capability', async () => {
    const stub = await stubProvider();
    const h = await bootWith(stub);
    try {
        const every = token('live', ALL, { sub: 'svc:live' });
        const refused = await request(h.base, 'POST', '/api/v1/batches', { tok: every, body: { items: [{ prompt: 'a service prompt' }], model: MODEL } });
        assert.strictEqual(refused.status, 403);
        assert.strictEqual(refused.body.code, 'batch.no_grant');
    } finally { await h.stop(); await stub.close(); }
});

t.run();
