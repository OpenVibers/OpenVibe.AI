'use strict';
/**
 * The owner's three economy switches act (the owner 2026-11-10):
 *
 *   - batches: a deferrable run (options.latency 'batch') waits on a provider's batch only when the
 *     switch is on for its kind; off, it answers at once in the background class and says why;
 *   - prompt cache: off, no cache-control marker and no warm-cache bias is sent; on, the adapters'
 *     own markers are sent and the stable system block comes first (only the order changes);
 *   - answer cache: off, an identical private run is computed again; on, the same person's repeat is
 *     served, never another person's, and never the uncensored kind.
 * The savings each switch reports come from what happened: cached tokens priced against the input
 * and cache-write cards, reused runs priced at their source's cost, and batch runs against list.
 */
const assert = require('assert');
const http = require('http');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');
const { createOwnerConfig } = require('../server/owner-config');

const t = suite('economy-switches');
const OWNER = token('owner', ['ai.provider.manage', 'ai.usage.read']);
const USR = (n) => `usr_01J${String(n).padStart(23, '0')}`;
const A = { type: 'user', id: USR(1) };
const B = { type: 'user', id: USR(2) };
const ADULT = USR(3);

/** An Anthropic-shaped seam: it answers chat and says how many prompt tokens were cached. */
async function anthropicSeam() {
    return await seamServer((body) => {
        const call = String(body.model || 'claude-sonnet-5-5');
        const marked = Array.isArray(body.system) && body.system.some((b) => b && b.cache_control);
        return {
            id: 'msg_test', type: 'message', role: 'assistant', model: call,
            content: [{ type: 'text', text: `answer ${Date.now()}` }],
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: marked ? 100 : 0, cache_creation_input_tokens: marked ? 20 : 0 },
        };
    });
}

/** A boot with one Anthropic provider and a priced model; the route is default.chat. */
async function bootAnthropic(seam, { env = {}, fetchImpl } = {}) {
    const h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_FREE_PROVIDERS: 'seam', AI_FREE_MAX_OUTPUT_PRICE_USD_PER_MTOK: '100', ...env }, fetchImpl });
    await h.registry.upsertProvider({ key: 'seam', kind: 'anthropic', status: 'active', base_url: seam.url, auth_mode: 'none', secret_ref: null, default_model: 'claude-sonnet-5-5', capabilities: ['chat', 'generate', 'complete'], timeout_ms: 5000 }, { actor: 'test' });
    await h.registry.upsertModel({ provider_key: 'seam', model_key: 'claude-sonnet-5-5', type: 'chat', status: 'active', cost: { in_per_mtok: 10, cached_per_mtok: 1, cache_write_per_mtok: 12.5, out_per_mtok: 20, source: 'urn:openvibe:ai:test', verified_at: '2026-01-01' } }, { actor: 'test' });
    await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: token('live', ALL), body: { primary: { provider: 'seam', model: 'claude-sonnet-5-5' }, fallbacks: [] } });
    return h;
}

const generate = (h, tok, body) => request(h.base, 'POST', '/api/v1/runs?wait=10000', { tok, body: { workflow: 'ai.generate', input: { prompt: 'the same question', system: 'You answer plainly.' }, ...body } });

t.test('prompt cache: on sends the cache marker and prices the saving with the write card; off sends neither', async () => {
    const seam = await anthropicSeam();
    const h = await bootAnthropic(seam);
    try {
        const oc = createOwnerConfig({ db: h.db, registry: h.registry });
        await oc.setEconomy({ capability: 'chat', batches: true, prompt_cache: true, small_first: false, answer_cache: false }, { actor: 'test' });
        const on = await generate(h, token('live', ALL), { input: { prompt: 'cache on', system: 'You answer plainly.' }, options: { cache: false } });
        assert.equal(on.status, 201, on.text);
        assert.ok(Array.isArray(seam.last.system), 'the Anthropic body carries system blocks');
        assert.deepEqual(seam.last.system[0].cache_control, { type: 'ephemeral' }, 'the stable block carries cache_control');
        assert.match(seam.last.system[0].text, /You answer plainly/, 'the stable words are first');

        const cached = await h.db.prepare('SELECT tokens_cached, tokens_cache_write FROM requests WHERE run_id = ? AND status = ?').get(on.body.run.id, 'ok');
        assert.equal(Number(cached.tokens_cached), 100, 'the cached read is recorded');
        assert.equal(Number(cached.tokens_cache_write), 20, 'the cache write is recorded');
        const saving = await oc.savings('chat');
        assert.equal(saving.prompt_cache.cached_tokens, 100);
        // 100 * (10 - 1) - 20 * (12.5 - 10) = 900 - 50 nano-free dollars per million = $0.00085.
        assert.equal(saving.prompt_cache.saved_usd, 0.00085, `the write card is subtracted (${saving.prompt_cache.saved_usd})`);

        await oc.setEconomy({ capability: 'chat', batches: true, prompt_cache: false, small_first: false, answer_cache: false }, { actor: 'test' });
        const off = await generate(h, token('live', ALL), { input: { prompt: 'cache off', system: 'You answer plainly.' }, options: { cache: false } });
        assert.equal(off.status, 201, off.text);
        assert.equal(seam.last.system[0].cache_control, undefined, 'no cache-control marker when the switch is off');
        assert.ok(seam.last.system[0].text, 'the same words are still there');
        assert.equal((await oc.getEconomy()).find((r) => r.capability === 'chat').prompt_cache, false);
    } finally { await h.stop(); await seam.close(); }
});

t.test('answer cache: same person on is reused, off is computed; never across people', async () => {
    const seam = await anthropicSeam();
    const h = await bootAnthropic(seam);
    try {
        const oc = createOwnerConfig({ db: h.db, registry: h.registry });
        const tok = token('live', ALL);
        await oc.setEconomy({ capability: 'chat', batches: true, prompt_cache: false, small_first: false, answer_cache: true }, { actor: 'test' });
        const first = await generate(h, tok, { on_behalf_of: A, input: { prompt: 'reuse me', system: 'You answer plainly.' } });
        assert.equal(first.body.run.status, 'succeeded', JSON.stringify(first.body.run.error));
        const calls = seam.calls;
        const again = await generate(h, tok, { on_behalf_of: A, input: { prompt: 'reuse me', system: 'You answer plainly.' } });
        assert.equal(again.body.run.status, 'cached', 'the same person is served the stored answer');
        assert.equal(seam.calls, calls, 'no provider call');
        const other = await generate(h, tok, { on_behalf_of: B, input: { prompt: 'reuse me', system: 'You answer plainly.' } });
        assert.equal(other.body.run.status, 'succeeded', "another person never reads A's entry");
        assert.equal(seam.calls, calls + 1);
        assert.notEqual(other.body.run.output.text, first.body.run.output.text);

        await oc.setEconomy({ capability: 'chat', batches: true, prompt_cache: false, small_first: false, answer_cache: false }, { actor: 'test' });
        const off = await generate(h, tok, { on_behalf_of: A, input: { prompt: 'reuse me', system: 'You answer plainly.' } });
        assert.equal(off.body.run.status, 'succeeded', 'off computes the same person again');
        assert.equal(seam.calls, calls + 2);
        const savings = await oc.savings('chat');
        assert.ok(savings.answer_cache.cached_runs >= 1, 'the reused run is counted');
        assert.ok(savings.answer_cache.saved_usd > 0, 'the reused run is priced at its source cost');
    } finally { await h.stop(); await seam.close(); }
});

t.test('the answer cache never serves the uncensored kind', async () => {
    const seam = await seamServer((body) => ({ id: 'c1', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'adult answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 5 } }));
    const fetchImpl = async (url, opts) => {
        if (String(url).includes('/oauth/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 300 }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (String(url).includes('/internal/identity/adult')) return new Response(JSON.stringify({ subject_id: ADULT, adult: true, confirmed_at: '2026-11-06T00:00:00Z' }), { status: 200, headers: { 'content-type': 'application/json' } });
        return globalThis.fetch(url, opts);
    };
    const h = await boot({ env: { OV_OAUTH_CLIENT_SECRET: 'test-secret', AI_STUB_FALLBACK: 'false', AI_FREE_PROVIDERS: 'adult', AI_FREE_MAX_OUTPUT_PRICE_USD_PER_MTOK: '100' }, fetchImpl });
    try {
        await h.registry.upsertProvider({ key: 'adult', kind: 'openai', status: 'active', base_url: seam.url, auth_mode: 'none', secret_ref: null, default_model: 'uncensored-1', capabilities: ['chat', 'generate'], metadata: { uncensored: true } }, { actor: 'test' });
        await h.registry.upsertModel({ provider_key: 'adult', model_key: 'uncensored-1', type: 'chat', status: 'active', cost: { in_per_mtok: 1, out_per_mtok: 2, source: 'urn:openvibe:ai:test', verified_at: '2026-01-01' }, metadata: { uncensored: true } }, { actor: 'test' });
        await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: token('live', ALL), body: { primary: { provider: 'adult', model: 'uncensored-1' }, fallbacks: [] } });
        const oc = createOwnerConfig({ db: h.db, registry: h.registry });
        // The uncensored policy answers chat/complete/messages only, and every one of those workflows
        // has cache_mode none; the run-level contentPolicy guard in server/runs.js is the second lock.
        const body = { messages: [{ role: 'user', content: 'hello there' }], on_behalf_of: { type: 'user', id: ADULT }, policy: 'uncensored' };
        const one = await request(h.base, 'POST', '/v1/chat/completions', { tok: token('live', ALL), body });
        assert.equal(one.status, 200, one.text);
        const two = await request(h.base, 'POST', '/v1/chat/completions', { tok: token('live', ALL), body });
        assert.equal(two.status, 200, two.text);
        assert.equal(two.body.choices[0].message.content, 'adult answer');
        assert.equal(seam.calls, 2, 'both adult runs called the provider; no answer cache');
        assert.equal(require('../server/owner-config').capabilityOfRun({ steps: [{ kind: 'passthrough' }] }, { contentPolicy: 'uncensored' }), 'uncensored');
        assert.equal((await oc.getEconomy()).find((r) => r.capability === 'uncensored').answer_cache, false, 'the row reads off');
        await oc.setEconomy({ capability: 'uncensored', batches: true, prompt_cache: true, small_first: false, answer_cache: true }, { actor: 'test' });
        assert.equal((await oc.getEconomy()).find((r) => r.capability === 'uncensored').answer_cache, false, 'it cannot be turned on');
        assert.equal((await oc.savings('uncensored')).answer_cache.cached_runs, 0);
    } finally { await h.stop(); await seam.close(); }
});

/** A stub provider that speaks OpenAI's batch API and answers the ordinary chat path too. */
function batchStub() {
    const state = { files: new Map(), batches: new Map(), seq: 0, calls: [] };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const p = new URL(req.url, 'http://x').pathname;
            let body = {};
            try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
            state.calls.push({ path: p, method: req.method, body });
            const send = (status, out, type) => { res.writeHead(status, { 'Content-Type': type || 'application/json' }); res.end(typeof out === 'string' ? out : JSON.stringify(out)); };
            if (p === '/v1/files' && req.method === 'POST') { const id = `file_${++state.seq}`; state.files.set(id, body.file || ''); return send(200, { id, object: 'file' }); }
            if (p === '/v1/batches' && req.method === 'POST') { const id = `batch_${++state.seq}`; state.batches.set(id, { input_file_id: body.input_file_id, status: 'in_progress', output_file_id: null }); return send(200, { id, object: 'batch', status: 'in_progress' }); }
            if (p.startsWith('/v1/batches/')) { const b = state.batches.get(p.split('/')[3]); return b ? send(200, { id: p.split('/')[3], object: 'batch', status: b.status, output_file_id: b.output_file_id }) : send(404, { error: { message: 'no batch' } }); }
            if (p.startsWith('/v1/files/') && p.endsWith('/content')) return send(200, state.files.get(p.split('/')[3]) || '', 'application/x-ndjson');
            if (p === '/v1/chat/completions') return send(200, { id: 'c1', object: 'chat.completion', model: body.model || 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ordinary path' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
            return send(404, { error: { message: 'not found' } });
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${server.address().port}`, state,
            close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
            answer(id) {
                const b = state.batches.get(id);
                const lines = (state.files.get(b.input_file_id) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
                const out = lines.map((line) => JSON.stringify({ custom_id: line.custom_id, response: { status_code: 200, body: { id: 'cmpl', object: 'chat.completion', model: line.body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'batch answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } } }, error: null }));
                const outId = `out_${++state.seq}`;
                state.files.set(outId, out.join('\n'));
                b.output_file_id = outId; b.status = 'completed';
            },
        }));
    });
}

t.test('batches: on queues a deferrable run, off answers it now and says why; a call not marked deferrable never waits', async () => {
    const stub = await batchStub();
    const h = await boot({ env: { AI_BATCH_NATIVE_MAX_ITEMS: '2', AI_BATCH_NATIVE_MAX_AGE_MS: '60000', AI_STUB_FALLBACK: 'false', AI_FREE_PROVIDERS: 'shared' } });
    try {
        await h.registry.upsertProvider({ key: 'shared', status: 'active', base_url: `${stub.url}/v1`, auth_mode: 'none', secret_ref: null, provider_access: 'OWN_DEPLOYMENT', capabilities: ['chat', 'generate'] }, { actor: 'test' });
        await h.registry.upsertModel({ provider_key: 'shared', model_key: 'gpt-4o-mini', type: 'chat', status: 'active', cost: { in_per_mtok: 1, out_per_mtok: 2, source: 'urn:openvibe:ai:test', verified_at: '2026-01-01' } }, { actor: 'test' });
        await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: token('live', ALL), body: { primary: { provider: 'shared', model: 'gpt-4o-mini' }, fallbacks: [] } });
        const oc = createOwnerConfig({ db: h.db, registry: h.registry });
        const body = (extra = {}) => ({ workflow: 'ai.generate', input: { prompt: `take your time ${Math.random()}` }, options: { cache: false, ...extra } });
        const tok = token('live', ALL);

        await oc.setEconomy({ capability: 'batch', batches: true, prompt_cache: true, small_first: false, answer_cache: true }, { actor: 'test' });
        const on = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok, body: body({ latency: 'batch' }) });
        assert.equal(on.status, 202, on.text);
        assert.equal(on.body.run.latency_class, 'batch');
        assert.ok(await h.db.prepare('SELECT id FROM batch_queue WHERE run_id = ?').get(on.body.run.id), 'the run waits for a batch');

        const immediate = await request(h.base, 'POST', '/api/v1/runs?wait=10000', { tok, body: body() });
        assert.equal(immediate.status, 201, immediate.text);
        assert.equal(immediate.body.run.status, 'succeeded', 'a call not marked deferrable answers at once');
        assert.equal(immediate.body.run.latency_class, 'interactive');

        await oc.setEconomy({ capability: 'batch', batches: false, prompt_cache: true, small_first: false, answer_cache: true }, { actor: 'test' });
        const off = await request(h.base, 'POST', '/api/v1/runs?wait=10000', { tok, body: body({ latency: 'batch' }) });
        assert.equal(off.status, 201, off.text);
        assert.equal(off.body.run.status, 'succeeded', 'the switch off answers instead of delaying');
        assert.equal(off.body.run.latency_class, 'background');
        assert.deepEqual(off.body.run.latency_clamped, { asked: 'batch', used: 'background', economy: 'batches off for batch' });
        assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM batch_queue WHERE run_id = ?').get(off.body.run.id)).n, 0, 'nothing waits');
        assert.ok(stub.state.calls.some((c) => c.path === '/v1/chat/completions'), 'the ordinary path answered');

        // The queue that was opened before the switch moved is still answered by the provider's batch.
        const queued = await h.db.prepare("SELECT id, provider, model FROM batch_queue WHERE status = 'queued'").all();
        if (queued.length) {
            await h.db.prepare("UPDATE batch_queue SET created_at = ? WHERE status = 'queued'").run(new Date(Date.now() - 60000).toISOString());
            await h.batcher.submitOnce();
            const id = stub.state.batches.keys().next().value;
            if (id) { stub.answer(id); await h.batcher.pollOnce(); }
        }
        const done = await h.db.prepare('SELECT latency_class, status FROM runs WHERE id = ?').get(on.body.run.id);
        assert.equal(done.status, 'succeeded');
        assert.equal(done.latency_class, 'batch');
        const saving = await oc.savings('batch');
        assert.equal(saving.batches.runs, 1);
        assert.ok(saving.batches.saved_usd > 0, 'the batch price is measured against list');
    } finally { await h.stop(); await stub.close(); }
});

t.test('a caller max_price still refuses before any provider call', async () => {
    const seam = await anthropicSeam();
    const h = await bootAnthropic(seam);
    try {
        const calls = seam.calls;
        const r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: token('live', ALL), body: { workflow: 'ai.generate', input: { prompt: 'price me' }, preset: { name: 'cheap', policy: { max_price: 0.001 } } } });
        assert.equal(r.status, 201, r.text);
        assert.equal(r.body.run.status, 'failed');
        assert.equal(r.body.run.error.code, 'ai.max_price_exceeded');
        assert.equal(seam.calls, calls, 'no provider was called');
    } finally { await h.stop(); await seam.close(); }
});

t.test('Anthropic and Gemini batches turn on only for a configured provider', async () => {
    const { batchProviderFor, enabledProviders } = require('../server/batch/providers');
    const keyed = { status: 'active', auth_mode: 'key', secret_ref: 'env:BATCH_TEST_KEY' };
    assert.equal(batchProviderFor('anthropic', keyed, {}), null, 'no key means off');
    assert.ok(batchProviderFor('anthropic', keyed, { BATCH_TEST_KEY: 'x' }), 'a keyed provider turns it on');
    assert.ok(batchProviderFor('gemini', { ...keyed, auth_mode: 'none', secret_ref: null }, {}), 'a local seam counts as configured');
    assert.equal(batchProviderFor('anthropic', { ...keyed, status: 'disabled' }, { BATCH_TEST_KEY: 'x' }), null, 'an inactive provider stays off');
    assert.ok(enabledProviders({ configured: ['anthropic'] }).anthropic, 'the configured list joins the always-on providers');
    assert.equal(enabledProviders().anthropic, undefined, 'without a configured provider it is not offered');
    // The batcher's body is OpenAI-shaped; the adapter moves it to the provider's own shape.
    const { createAnthropicAdapter } = require('../server/batch/providers/anthropic');
    const { createGeminiAdapter } = require('../server/batch/providers/gemini');
    const a = createAnthropicAdapter({ baseUrl: 'https://example.test/v1', apiKey: 'x' });
    const ab = a.buildFile([{ customId: '1', body: { model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }] } }]);
    assert.equal(ab.requests[0].params.system[0].text, 'rules');
    assert.equal(ab.requests[0].params.messages[0].role, 'user');
    const g = createGeminiAdapter({ baseUrl: 'https://example.test/v1', apiKey: 'x' });
    const gb = g.buildFile([{ customId: '1', body: { model: 'gemini-3-flash', messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }] } }]);
    assert.equal(gb.requests[0].request.systemInstruction.parts[0].text, 'rules');
    assert.equal(gb.requests[0].request.contents[0].parts[0].text, 'hi');
});

t.run();
