'use strict';
// T6 provider router (phase 1): a route names a capability and the router tries its pool in
// openvibe-sdk/placement order, over the existing retry/breaker/log loop.
//   - forced failure on EVERY route from registry.listRoutes(): the primary fails and the pool falls
//     back to another member (logged), or the route answers the explicit 503 provider.unavailable for
//     a single-provider capability — never synthetic output;
//   - two seam providers on one capability: the cheaper is chosen; a circuit-open provider is excluded;
//     an upstream 429 shifts to the other without opening the circuit;
//   - explain{objective,reasons,selected,candidates} rides every run response and GET /runs/:id, with
//     the per-attempt request log still there.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');

const t = suite('provider-router');
const tok = token('live', ALL);
let h;
const seam = () => seamServer((body) => (body.operation === 'embed'
    ? { vectors: [[0.1, 0.2]], model: 'seam-model', usage: { input: 1, output: 0 } }
    : { text: 'a real answer', model: 'seam-model', usage: { input: 5, output: 2 } }));

async function provider(body) {
    const r = await request(h.base, 'POST', '/api/v1/providers', { tok, body: { kind: 'http', auth_mode: 'none', timeout_ms: 3000, ...body } });
    assert.strictEqual(r.status, 201, r.text);
}
async function model(providerKey, modelKey, price) {
    const r = await request(h.base, 'POST', '/api/v1/models', { tok, body: { provider_key: providerKey, model_key: modelKey, type: 'chat', cost: { in_per_mtok: price, out_per_mtok: price } } });
    assert.strictEqual(r.status, 201, r.text);
}
async function route(key, body) {
    const r = await request(h.base, 'POST', `/api/v1/routes/${key}/versions`, { tok, body });
    assert.strictEqual(r.status, 201, r.text);
    return r.body.route;
}
const CANDIDATE_KEYS = ['cost', 'eligible', 'excluded_reason', 'latency', 'model', 'provider'];

t.test('forced failure on every route: a logged fallback, or an explicit 503 (never synthetic)', async () => {
    const ok = await seamServer(() => ({ text: 'a real answer', model: 'seam-model', usage: { input: 5, output: 2 } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_BREAKER_FAILURES: '50' } });
    await provider({ key: 'dead', base_url: 'http://127.0.0.1:1/x', capabilities: ['chat', 'generate', 'summarize', 'extract', 'json'] });
    await provider({ key: 'ok', base_url: ok.url, capabilities: ['chat', 'generate', 'summarize', 'extract', 'json'] });

    const routes = new Map();
    for (const r of await h.registry.listRoutes()) {
        const rr = await h.registry.resolveRoute(r.key);
        if (rr && !rr.disabled) routes.set(rr.key, rr);
    }
    assert.ok(routes.size >= 8, `routes discovered: ${[...routes.keys()].join(', ')}`);
    assert.ok(!routes.has('default.image'), 'no image route without AI_IMAGE_MODEL: the walk is unchanged');

    const failed = [];
    for (const rr of routes.values()) {
        const op = rr.capability === 'transcribe' || rr.key === 'live.stt' ? 'transcribe' : rr.capability === 'embed' ? 'embed' : 'chat';
        const req = op === 'embed' ? { input: ['x'], timeoutMs: 2000 }
            : op === 'transcribe' ? { filePath: '/nope.mp4', language: 'en', timeoutMs: 2000 }
                : { messages: [{ role: 'user', content: 'hi' }], timeoutMs: 2000 };
        const logs = [];
        let exec = null; let err = null;
        try { exec = await h.pool.execute(rr, op, req, { routeKey: rr.key, routeVersion: rr.version, logRequest: (e) => logs.push(e) }); } catch (e) { err = e; }

        const explain = exec ? exec.explain : (err && err.extra && err.extra.explain);
        assert.ok(explain && Array.isArray(explain.candidates), `${rr.key}: explain present`);
        for (const c of explain.candidates) assert.deepStrictEqual(Object.keys(c).sort(), CANDIDATE_KEYS, `${rr.key}: candidate shape`);
        if (err) {
            assert.strictEqual(err.status, 503, `${rr.key}: explicit 503 (${err.message})`);
            assert.strictEqual(err.code, 'provider.unavailable', `${rr.key}: stable code`);
            assert.ok(logs.some((e) => e.status !== 'ok'), `${rr.key}: the failure was logged`);
            failed.push(rr.key);
        } else {
            assert.ok(!exec.synthetic, `${rr.key}: never a synthetic answer`);
            assert.ok(exec.provider, `${rr.key}: a provider answered`);
            if (rr.capability === 'chat') {
                assert.ok(logs.some((e) => e.status === 'ok' && e.fallback === 1), `${rr.key}: the dead primary failed and the pool fell back`);
                assert.strictEqual(exec.explain.selected, 'ok', `${rr.key}: explain names the winner`);
            }
        }
    }
    assert.deepStrictEqual(failed.sort(), ['default.embedding', 'live.stt'], `failed routes: ${failed}`);
    await h.stop(); await ok.close();
});

t.test('a local embedding model makes default.embedding a pool: the failing paid upstream falls to the free local one', async () => {
    // Both upstreams speak the OpenAI API; the shared one is paid (metered), the local one free.
    const paid = await seamServer(() => ({ status: 500, body: { error: { message: 'upstream down' } } }));
    const local = await seamServer((body, req) => (req.url.endsWith('/embeddings')
        ? { data: [{ index: 0, embedding: [0.3, 0.4, 0.5] }], model: body.model, usage: { prompt_tokens: 2, total_tokens: 2 } }
        : { status: 404, body: { error: { message: 'not here' } } }));
    h = await boot({ env: {
        AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_BREAKER_FAILURES: '50',
        AI_PROVIDER: 'openai', AI_BASE_URL: `${paid.url}/v1`, AI_LOCAL_LLM_URL: `${local.url}/v1`, AI_LOCAL_EMBED_MODEL: 'nomic-embed-text',
    } });
    const lp = await h.registry.getProvider('local');
    assert.ok(lp.capabilities.includes('embed'), 'local advertises embed with an embedding model configured');
    const lm = await h.registry.getModel('local', 'nomic-embed-text');
    assert.strictEqual(lm && lm.type, 'embedding', 'the local embedding model is registered');

    // The seeded pool (objective balanced): the free local model answers, so default.embedding no longer 503s.
    const embed = async (rr, logs) => h.pool.execute(rr, 'embed', { input: ['x'], timeoutMs: 2000 }, { routeKey: rr.key, routeVersion: rr.version, logRequest: (e) => logs.push(e) });
    const seeded = await h.registry.resolveRoute('default.embedding');
    const direct = await embed(seeded, []);
    assert.strictEqual(direct.provider, 'local');
    assert.deepStrictEqual(direct.result.vectors, [[0.3, 0.4, 0.5]]);
    const placed = await h.pool.candidates(seeded, ['embed'], 'embed');
    assert.strictEqual(placed.placement.selected, 'local:nomic-embed-text', JSON.stringify(placed.explain));
    assert.deepStrictEqual(placed.explain.candidates.map((c) => `${c.provider}:${c.model}`).sort(), ['local:nomic-embed-text', 'shared:text-embedding-3-small']);

    // With the paid upstream as the authority, it is tried first; it fails and the run falls to local.
    const rr = await route('default.embedding', { capability: 'embed', constraints: { objective: 'correctness', authority: 'shared:text-embedding-3-small' }, timeout_ms: 3000 });
    const logs = [];
    const exec = await embed(rr, logs);
    assert.ok(!exec.synthetic, 'never a synthetic answer');
    assert.strictEqual(exec.provider, 'local');
    assert.strictEqual(exec.model, 'nomic-embed-text');
    assert.strictEqual(exec.explain.selected, 'local', JSON.stringify(exec.explain));
    assert.strictEqual(exec.explain.candidates.find((c) => c.provider === 'local').model, 'nomic-embed-text');
    assert.ok(paid.calls >= 1, 'the paid upstream was tried first');
    assert.ok(logs.some((e) => e.provider_key === 'shared' && e.status !== 'ok'), 'the paid failure is logged');
    assert.ok(logs.some((e) => e.provider_key === 'local' && e.model_key === 'nomic-embed-text' && e.status === 'ok' && e.fallback === 1), 'the fallback to local is logged');
    await h.stop(); await paid.close(); await local.close();
});

t.test('the local provider embeds on AI_LOCAL_EMBED_URL while chat stays on AI_LOCAL_LLM_URL', async () => {
    // llama.cpp serves one model per process: the chat GGUF and the embedding GGUF may be two local servers.
    const chat = await seamServer(() => ({ text: 'local chat answer', model: 'chat-model', usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    const embedSrv = await seamServer((body, req) => {
        assert.ok(req.url.endsWith('/embeddings'), `except embedding requests, nothing reaches the embed server (${req.url})`);
        return { data: [{ index: 0, embedding: [0.3, 0.4, 0.5] }], model: body.model, usage: { prompt_tokens: 2, total_tokens: 2 } };
    });
    h = await boot({ env: {
        AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_BREAKER_FAILURES: '50',
        AI_PROVIDER: 'openai', AI_BASE_URL: `${chat.url}/v1`,
        AI_LOCAL_LLM_URL: `${chat.url}/v1`, AI_LOCAL_LLM_MODEL: 'chat-model',
        AI_LOCAL_EMBED_URL: `${embedSrv.url}/v1`, AI_LOCAL_EMBED_MODEL: 'bge-small-en-v1.5',
    } });
    const local = await h.registry.getProvider('local');
    assert.strictEqual(local.metadata.embed_url, `${embedSrv.url}/v1`, 'the seeded local provider carries the embedding URL');

    const media = await h.registry.resolveRoute('media.local');
    const chatExec = await h.pool.execute(media, 'summarize', { messages: [{ role: 'user', content: 'hello' }], timeoutMs: 2000 }, { routeKey: media.key, routeVersion: media.version });
    assert.strictEqual(chatExec.provider, 'local');
    assert.strictEqual(chat.calls, 1, 'the chat model stays on AI_LOCAL_LLM_URL');
    assert.strictEqual(embedSrv.calls, 0);

    const embedding = await h.registry.resolveRoute('default.embedding');
    const embedExec = await h.pool.execute(embedding, 'embed', { input: ['x'], timeoutMs: 2000 }, { routeKey: embedding.key, routeVersion: embedding.version });
    assert.strictEqual(embedExec.provider, 'local');
    assert.deepStrictEqual(embedExec.result.vectors, [[0.3, 0.4, 0.5]]);
    assert.strictEqual(embedSrv.calls, 1, 'the embedding model is called on AI_LOCAL_EMBED_URL');
    assert.strictEqual(chat.calls, 1, 'and never on the chat server');
    await h.stop(); await chat.close(); await embedSrv.close();
});

t.test('two providers on one capability: the cheaper is chosen; a circuit-open one is excluded', async () => {
    const ok = await seam();
    const flaky = await seamServer(() => ({ status: 500, body: { error: { message: 'boom' } } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_BREAKER_FAILURES: '2', AI_BREAKER_COOLDOWN_MS: '600000', AI_PLACEMENT_MIN_GAIN: '0' } });
    await provider({ key: 'cheap', base_url: ok.url, capabilities: ['classify'], default_model: 'cheap-m' });
    await model('cheap', 'cheap-m', 1);
    await provider({ key: 'pricey', base_url: ok.url, capabilities: ['classify'], default_model: 'pricey-m' });
    await model('pricey', 'pricey-m', 20);
    const r = await route('test.pool-cheap', { capability: 'classify', constraints: { objective: 'cheapest' }, timeout_ms: 3000 });
    assert.strictEqual(r.capability, 'classify');

    const exec = await h.pool.execute(r, 'classify', { messages: [{ role: 'user', content: 'x' }], timeoutMs: 3000 }, { routeKey: r.key, routeVersion: r.version });
    assert.strictEqual(exec.provider, 'cheap', 'the cheaper provider is chosen');
    assert.strictEqual(exec.explain.selected, 'cheap');
    const byProvider = Object.fromEntries(exec.explain.candidates.map((c) => [c.provider, c]));
    assert.ok(byProvider.cheap.cost < byProvider.pricey.cost, 'rate cards carry the real prices');

    // explain is AI's projection of the placement result; that result is a platform.placement-result@1.
    const validated = [];
    const originalValidate = contracts.validate;
    let placed;
    contracts.validate = (name, value) => {
        const result = originalValidate(name, value);
        validated.push({ name, value, result });
        return result;
    };
    try { placed = await h.pool.candidates(r, ['classify'], 'classify'); }
    finally { contracts.validate = originalValidate; }
    const checkedOffers = validated.filter((x) => x.name === 'platform.resource-offer@1');
    const checkedRequirements = validated.filter((x) => x.name === 'platform.workload-requirements@1');
    assert.deepStrictEqual(checkedOffers.map((x) => x.value.offer_id).sort(), placed.placement.candidates.map((x) => x.id).sort(), 'every offer was validated before planning');
    assert.strictEqual(checkedRequirements.length, 1, 'requirements were validated before planning');
    for (const x of [...checkedOffers, ...checkedRequirements]) assert.ok(x.result.valid, `${x.name}: ${JSON.stringify(x.result.errors)}`);
    const v = contracts.validate('platform.placement-result@1', placed.placement);
    assert.ok(v.valid, `platform.placement-result@1: ${JSON.stringify(v.errors)}`);
    assert.strictEqual(placed.placement.selected, 'cheap:cheap-m');
    assert.strictEqual(placed.explain.selected, placed.placement.selected, 'explain.selected is the placement\'s');
    assert.deepStrictEqual(placed.explain.candidates.map((c) => (c.model ? `${c.provider}:${c.model}` : c.provider)), placed.placement.candidates.map((c) => c.id), 'one explain candidate per placement candidate');

    // A provider that keeps failing opens its circuit; placement then excludes it and the other answers.
    await provider({ key: 'flaky', base_url: flaky.url, capabilities: ['extract'], default_model: 'flaky-m' });
    await model('flaky', 'flaky-m', 1);
    await provider({ key: 'good', base_url: ok.url, capabilities: ['extract'], default_model: 'good-m' });
    await model('good', 'good-m', 20);
    const rb = await route('test.pool-breaker', { capability: 'extract', constraints: { objective: 'cheapest' }, timeout_ms: 3000 });
    const extract = { messages: [{ role: 'user', content: 'x' }], timeoutMs: 3000 };
    for (let i = 0; i < 2; i++) {
        const e = await h.pool.execute(rb, 'extract', extract, { routeKey: rb.key, routeVersion: rb.version });
        assert.strictEqual(e.provider, 'good', 'the failing provider falls back to good');
        assert.strictEqual(e.explain.selected, 'good');
    }
    assert.strictEqual((await h.pool.health('flaky')).state, 'open');
    const e3 = await h.pool.execute(rb, 'extract', extract, { routeKey: rb.key, routeVersion: rb.version });
    const flakyCand = e3.explain.candidates.find((c) => c.provider === 'flaky');
    assert.strictEqual(flakyCand.eligible, false, 'the open circuit excludes it');
    assert.match(flakyCand.excluded_reason, /health down/);
    assert.strictEqual(e3.provider, 'good');
    await ok.close(); await flaky.close();
});

t.test('an invalid offer fails closed before reaching the planner', async () => {
    const r = await h.registry.resolveRoute('test.pool-cheap');
    const originalListProviders = h.registry.listProviders;
    const placement = require('openvibe-sdk/placement');
    const originalPlan = placement.plan;
    let plannerCalls = 0;
    h.registry.listProviders = async (...args) => (await originalListProviders.apply(h.registry, args))
        .map((p) => p.key === 'cheap' ? { ...p, capabilities: ['classify', 42] } : p);
    placement.plan = () => { plannerCalls++; throw new Error('invalid offer reached planner'); };
    try {
        await assert.rejects(h.pool.candidates(r, ['classify'], 'classify'), /invalid platform\.resource-offer@1/);
        assert.strictEqual(plannerCalls, 0, 'planner was not called with the invalid offer');
    } finally {
        h.registry.listProviders = originalListProviders;
        placement.plan = originalPlan;
    }
});

t.test('invalid requirements fail closed before reaching the planner', async () => {
    const r = await h.registry.resolveRoute('test.pool-cheap');
    const placement = require('openvibe-sdk/placement');
    const originalPlan = placement.plan;
    let plannerCalls = 0;
    placement.plan = () => { plannerCalls++; throw new Error('invalid requirements reached planner'); };
    try {
        await assert.rejects(h.pool.candidates(r, ['classify', 42], 'classify'), /invalid platform\.workload-requirements@1/);
        assert.strictEqual(plannerCalls, 0, 'planner was not called with invalid requirements');
    } finally {
        placement.plan = originalPlan;
    }
});

t.test('an upstream 429 shifts to another provider without opening the circuit', async () => {
    const ok = await seamServer(() => ({ text: 'steady answer', model: 'steady-m', usage: { input: 3, output: 1 } }));
    const busy = await seamServer(() => ({ status: 429, body: { error: { message: 'rate limited' } } }));
    await provider({ key: 'busy', base_url: busy.url, capabilities: ['enrich'], default_model: 'busy-m' });
    await model('busy', 'busy-m', 0.5);
    await provider({ key: 'steady', base_url: ok.url, capabilities: ['enrich'], default_model: 'steady-m' });
    await model('steady', 'steady-m', 20);
    const r = await route('test.pool-429', { capability: 'enrich', constraints: { objective: 'cheapest' }, timeout_ms: 3000 });

    const exec = await h.pool.execute(r, 'enrich', { messages: [{ role: 'user', content: 'x' }], timeoutMs: 3000 }, { routeKey: r.key, routeVersion: r.version });
    assert.strictEqual(exec.provider, 'steady', 'the 429 provider is skipped for this call');
    assert.strictEqual(exec.explain.selected, 'steady');
    assert.strictEqual((await h.pool.health('busy')).state, 'closed', 'a 429 is capacity, not ill health');
    await ok.close(); await busy.close();
});

t.test('explain rides the run response and GET /runs/:id; the request log stays', async () => {
    const fails = await seamServer(() => ({ status: 500, body: { error: { message: 'down' } } }));
    const ok = await seamServer(() => ({ text: 'the fallback answer', model: 'p2-m', usage: { input: 4, output: 2 } }));
    await provider({ key: 'p1', base_url: fails.url, capabilities: ['chat', 'generate'], default_model: 'p1-m' });
    await model('p1', 'p1-m', 1);
    await provider({ key: 'p2', base_url: ok.url, capabilities: ['chat', 'generate'], default_model: 'p2-m' });
    await model('p2', 'p2-m', 20);
    const r = await route('default.chat', { capability: 'chat', constraints: { objective: 'cheapest' }, timeout_ms: 3000, response_format: 'text' });
    assert.strictEqual(r.capability, 'chat');

    const res = await request(h.base, 'POST', '/api/v1/generate?wait=5000', { tok, body: { prompt: 'hello', options: { cache: false } } });
    assert.strictEqual(res.status, 201, res.text);
    const run = res.body.run;
    assert.strictEqual(run.status, 'succeeded');
    assert.strictEqual(run.provenance.provider, 'p2');
    assert.ok(run.explain, 'the run carries explain');
    assert.strictEqual(run.explain.objective, 'cheapest');
    assert.ok(Array.isArray(run.explain.reasons) && run.explain.reasons.length);
    assert.strictEqual(run.explain.selected, 'p2');
    for (const c of run.explain.candidates) assert.deepStrictEqual(Object.keys(c).sort(), CANDIDATE_KEYS);
    const shared = run.explain.candidates.find((c) => c.provider === 'shared');
    assert.ok(shared && shared.eligible === false && shared.excluded_reason, 'the credential-less shared provider is excluded with a reason');

    const got = await request(h.base, 'GET', `/api/v1/runs/${run.id}`, { tok });
    assert.deepStrictEqual(got.body.run.explain, run.explain, 'GET /runs/:id returns the same explain');
    const reqs = got.body.requests;
    assert.ok(reqs.some((x) => x.provider_key === 'p1' && x.status === 'error'), 'the failed primary is in the request log');
    const fb = reqs.find((x) => x.provider_key === 'p2');
    assert.strictEqual(fb.status, 'ok');
    assert.strictEqual(fb.fallback, 1, 'the fallback attempt is marked');

    // A run that nothing can answer still carries explain (selected null) and the explicit 503 code.
    await request(h.base, 'POST', '/api/v1/providers/p2/disable', { tok });
    const bad = await request(h.base, 'POST', '/api/v1/generate?wait=5000', { tok, body: { prompt: 'nobody', options: { cache: false } } });
    assert.strictEqual(bad.body.run.status, 'failed', bad.text);
    assert.strictEqual(bad.body.run.error.code, 'provider.unavailable');
    assert.ok(bad.body.run.explain && bad.body.run.explain.selected === null, 'a failed run still explains itself');
    await fails.close(); await ok.close();
});

t.test('seeded text pools keep the shared provider as authority: a free local model is only the failover', async () => {
    const { plan } = require('openvibe-sdk/placement');
    const shared = await h.registry.getProvider('shared');
    const authority = shared.default_model ? `shared:${shared.default_model}` : 'shared';
    let checked = 0;
    for (const r of await h.registry.listRoutes()) {
        const rr = await h.registry.resolveRoute(r.key);
        if (!rr || rr.disabled || rr.capability !== 'chat' || rr.created_by !== 'seed' || !/^(live\.|default\.(chat|json)$)/.test(rr.key)) continue;
        checked++;
        assert.strictEqual(rr.constraints.objective, 'correctness', `${rr.key}: correctness keeps the authority`);
        // live.creative names a stronger model of the same shared provider (AI_CREATIVE_MODEL).
        if (rr.key === 'live.creative') assert.match(rr.constraints.authority, /^shared:/, 'live.creative: the shared provider is the authority');
        else assert.strictEqual(rr.constraints.authority, authority, `${rr.key}: the shared provider is the authority`);
    }
    assert.ok(checked >= 5, `seeded text pools checked: ${checked}`);
    // The planner under those constraints: the paid shared offer beats the free local one while it is up, and
    // the local one takes over the moment shared is down.
    const offer = (id, status, pricing) => ({ offer_id: id, kind: 'provider', provider: id.split(':')[0], region: 'global', trust: 'first-party', capabilities: ['chat'], latency_ms: {}, health: { status }, pricing });
    const req = { kind: 'ai', mobility: 'request', latency_class: 'interactive', objective: 'correctness', capabilities: ['chat'], units: 1, authority: 'shared:m' };
    const cards = [{ id: 'shared:m', provider: 'shared', metric: 'tokens', unit_size: 1e6, unit_price_usd: 2, free_allowance: 0, reset_period: 'month' }];
    const up = plan(req, [offer('shared:m', 'up', { model: 'metered', rate_card: 'shared:m' }), offer('local:l', 'up', { model: 'prepaid' })], { rateCards: cards });
    assert.strictEqual(up.selected, 'shared:m', JSON.stringify(up.reasons));
    const down = plan(req, [offer('shared:m', 'down', { model: 'metered', rate_card: 'shared:m' }), offer('local:l', 'up', { model: 'prepaid' })], { rateCards: cards });
    assert.strictEqual(down.selected, 'local:l', JSON.stringify(down.reasons));
});

t.test('shutdown', async () => { await h.stop(); });
t.run();
