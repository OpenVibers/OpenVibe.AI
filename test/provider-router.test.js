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
    assert.deepStrictEqual(failed.sort(), ['default.embedding', 'live.stt', 'media.paid'], `failed routes: ${failed}`);
    await h.stop(); await ok.close();
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
    const placed = await h.pool.candidates(r, ['classify'], 'classify');
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
        assert.strictEqual(rr.constraints.authority, authority, `${rr.key}: the shared provider is the authority`);
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
