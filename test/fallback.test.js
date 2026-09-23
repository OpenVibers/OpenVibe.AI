'use strict';
// Routing: a degraded primary falls back AND records that it did (run, request log, audit); the
// circuit breaker opens after repeated failures and the open provider is skipped; disabled or
// credential-less providers are skipped; timeouts are strict; when nothing can answer the run
// fails with an explicit provider.unavailable instead of inventing output.

const assert = require('assert');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');

const t = suite('fallback');
const tok = token('live', ALL);
let h;
let ok;
let slow;

async function route(primary, fallbacks) {
    const r = await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok, body: { primary: { provider: primary }, fallbacks: fallbacks.map(p => ({ provider: p })), timeout_ms: 5000 } });
    assert.strictEqual(r.status, 201, r.text);
    return r.body.route;
}
async function provider(body) {
    const r = await request(h.base, 'POST', '/api/v1/providers', { tok, body: { kind: 'http', auth_mode: 'none', capabilities: ['chat', 'generate', 'json'], timeout_ms: 5000, ...body } });
    assert.strictEqual(r.status, 201, r.text);
}
const generate = (prompt) => request(h.base, 'POST', '/api/v1/generate', { tok, body: { prompt, options: { cache: false } } });

t.test('boot with stub fallback off and two seam providers', async () => {
    ok = await seamServer(() => ({ text: 'a real answer', model: 'seam-model', usage: { input: 12, output: 4 } }));
    slow = await seamServer(() => new Promise(r => setTimeout(() => r({ text: 'too late' }), 2500)));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_BREAKER_FAILURES: '2', AI_BREAKER_COOLDOWN_MS: '600000' } });
    await provider({ key: 'dead', base_url: 'http://127.0.0.1:1/x' });
    await provider({ key: 'ok', base_url: ok.url });
    await provider({ key: 'slow', base_url: slow.url, timeout_ms: 1000 });
    const v = await route('dead', ['ok']);
    assert.ok(v.version >= 2, 'a route edit is a new version');
});

t.test('a failing primary falls back, and the run, request log and audit all say so', async () => {
    const r = await generate('hello');
    assert.strictEqual(r.status, 201, r.text);
    const run = r.body.run;
    assert.strictEqual(run.status, 'succeeded');
    assert.strictEqual(run.output.text, 'a real answer');
    assert.strictEqual(run.synthetic, false);
    assert.strictEqual(run.provenance.provider, 'ok');
    assert.strictEqual(run.provenance.fallback_used, true);
    const d = await request(h.base, 'GET', `/api/v1/runs/${run.id}`, { tok });
    const reqs = d.body.requests;
    assert.ok(reqs.filter(x => x.provider_key === 'dead' && x.status === 'error').length === 2, 'primary tried and retried once');
    const good = reqs.find(x => x.provider_key === 'ok');
    assert.strictEqual(good.status, 'ok');
    assert.strictEqual(good.fallback, 1);
    assert.strictEqual(good.tokens_in, 12);
    assert.ok(good.prompt_hash && good.input_hash && good.output_hash, 'hashes, not raw prompts');
    assert.ok(!('debug_prompt' in good), 'raw prompt fields are not exposed');
    const audit = await request(h.base, 'GET', `/api/v1/audit?action=run.fallback&target_id=${run.id}`, { tok });
    assert.strictEqual(audit.body.audit.length, 1);
    const fb = await request(h.base, 'GET', '/api/v1/requests?fallback=1', { tok });
    assert.ok(fb.body.requests.some(x => x.run_id === run.id));
});

t.test('the circuit opens after repeated failures and the open provider is skipped', async () => {
    await generate('second');                      // second consecutive failure of `dead` opens it
    assert.strictEqual(h.pool.health('dead').state, 'open');
    const r = await generate('third');
    const d = await request(h.base, 'GET', `/api/v1/runs/${r.body.run.id}`, { tok });
    const skip = d.body.requests.find(x => x.provider_key === 'dead');
    assert.strictEqual(skip.status, 'skipped');
    assert.strictEqual(skip.skip_reason, 'circuit_open');
    assert.strictEqual(r.body.run.provenance.fallback_used, true);
    const audit = await request(h.base, 'GET', '/api/v1/audit?action=provider.circuit_opened', { tok });
    assert.ok(audit.body.audit.some(a => a.target_id === 'dead'));
    const reset = await request(h.base, 'POST', '/api/v1/providers/dead/reset', { tok });
    assert.strictEqual(reset.body.health.state, 'closed');
});

t.test('a strict timeout counts as a failure and moves on', async () => {
    await route('slow', ['ok']);
    const started = Date.now();
    const r = await generate('slowly');
    assert.strictEqual(r.body.run.provenance.provider, 'ok');
    const d = await request(h.base, 'GET', `/api/v1/runs/${r.body.run.id}`, { tok });
    assert.ok(d.body.requests.some(x => x.provider_key === 'slow' && x.status === 'timeout'));
    assert.ok(Date.now() - started < 5000, 'did not wait for the slow provider');
});

t.test('disabled and credential-less providers are skipped', async () => {
    await request(h.base, 'POST', '/api/v1/providers/slow/disable', { tok });
    await request(h.base, 'POST', '/api/v1/providers', { tok, body: { key: 'nokey', kind: 'openai', base_url: 'https://api.openai.com/v1', auth_mode: 'bearer', secret_ref: 'env:NOT_SET_ANYWHERE', capabilities: ['chat', 'generate'] } });
    await route('slow', ['nokey', 'ok']);
    const r = await generate('skip them');
    const d = await request(h.base, 'GET', `/api/v1/runs/${r.body.run.id}`, { tok });
    assert.deepStrictEqual(d.body.requests.filter(x => x.status === 'skipped').map(x => [x.provider_key, x.skip_reason]), [['slow', 'disabled'], ['nokey', 'no_credentials']]);
    assert.strictEqual(r.body.run.provenance.provider, 'ok');
});

t.test('with nothing able to answer the run fails explicitly (no stub in production mode)', async () => {
    await request(h.base, 'POST', '/api/v1/providers/ok/disable', { tok });
    const r = await generate('nobody home');
    assert.strictEqual(r.body.run.status, 'failed');
    assert.strictEqual(r.body.run.error.code, 'provider.unavailable');
    assert.strictEqual(r.body.run.output, null);
});

t.test('with stub fallback on (dev/test default) the stub answers and is marked synthetic', async () => {
    await h.stop();
    h = await boot({ env: { AI_BREAKER_FAILURES: '5' } });
    const r = await request(h.base, 'POST', '/api/v1/generate', { tok, body: { prompt: 'anything' } });
    assert.strictEqual(r.body.run.status, 'succeeded');
    assert.strictEqual(r.body.run.provenance.provider, 'stub');
    assert.strictEqual(r.body.run.synthetic, true);
    assert.strictEqual(r.body.run.provenance.fallback_used, true, 'the shared provider (no key) was skipped');
    assert.ok(r.body.run.output.text.startsWith('(synthetic)'));
});

t.test('shutdown', async () => { await h.stop(); await ok.close(); await slow.close(); });

t.run();
