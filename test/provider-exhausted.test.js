'use strict';
// A provider that answers "insufficient balance" is exhausted, not flaky: its circuit opens at once for the
// long cooldown (10 minutes by default), shared by every request; it is never retried into; the route fails
// over down its offer list. When nothing can answer, the problem is 503 ai.resting with a human sentence and
// Retry-After, not a bare provider.unavailable.
const assert = require('assert');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');
const { AiError, sendError } = require('../server/util');

const t = suite('provider-exhausted');
const tok = token('live', ALL);

function fakeRes() {
    const headers = {};
    return { headers, statusCode: 0, body: null, headersSent: false, setHeader(k, v) { headers[k.toLowerCase()] = v; }, getHeader(k) { return headers[k.toLowerCase()]; }, end(s) { this.body = JSON.parse(s); this.headersSent = true; } };
}

t.test('402 Insufficient Balance opens the circuit at once, fails over, and never retries the same provider', async () => {
    const paid = await seamServer(() => ({ status: 402, body: { error: { message: 'Insufficient Balance', type: 'unknown_error', param: null, code: 'invalid_request_error' } } }));
    const local = await seamServer(() => ({ choices: [{ message: { content: 'a short local answer' } }], model: 'local-model', usage: { prompt_tokens: 4, completion_tokens: 3 } }));
    let now = 1762400000000;
    const clock = { now: () => now };
    const h = await boot({ clock, env: {
        AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '1', AI_BREAKER_FAILURES: '5', AI_BREAKER_EXHAUSTED_COOLDOWN_MS: '600000',
        AI_PROVIDER: 'openai', AI_BASE_URL: `${paid.url}/v1`, AI_API_KEY: 'test-key', AI_MODEL: 'paid-model',
        AI_LOCAL_LLM_URL: `${local.url}/v1`, AI_LOCAL_LLM_MODEL: 'local-model', AI_LOCAL_LLM_TIMEOUT_MS: '5000',
    } });
    const route = await h.registry.resolveRoute('default.chat');
    const logs = [];
    const ask = (signal) => h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'summarise this' }], maxTokens: 60, timeoutMs: 3000 }, { routeKey: route.key, routeVersion: route.version, logRequest: (e) => logs.push(e) });

    const first = await ask();
    assert.strictEqual(first.provider, 'local', 'the exhausted paid offer fell over to the local model');
    assert.strictEqual(first.local, true, 'the receipt labels a local answer');
    assert.strictEqual(first.result.text, 'a short local answer');
    assert.strictEqual(paid.calls, 1, 'the same provider is never retried after a balance answer (AI_PROVIDER_RETRIES=1)');
    assert.strictEqual(local.calls, 1);
    assert.strictEqual((await h.pool.health('shared')).state, 'open');
    assert.ok((await h.pool.health('shared')).exhausted_at, 'the health row says why it opened');
    assert.ok(logs.some((e) => e.provider_key === 'shared' && e.status === 'error'), 'the balance failure is logged');

    // Every request shares the pause: the next one skips the exhausted provider entirely.
    const second = await ask();
    assert.strictEqual(second.provider, 'local');
    assert.strictEqual(paid.calls, 1, 'a circuit-open exhausted provider is not called again');
    assert.strictEqual((await h.pool.health('shared')).state, 'open');

    // The fake clock passes the long cooldown: one half-open probe is allowed, and a second 402 opens it again.
    now += 600001;
    assert.strictEqual((await h.pool.health('shared')).state, 'half_open');
    const third = await ask();
    assert.strictEqual(third.provider, 'local');
    assert.strictEqual(paid.calls, 2, 'exactly one probe after the cooldown, never a retry');
    assert.strictEqual((await h.pool.health('shared')).state, 'open');

    // With the local model failing too, nothing can serve: 503 ai.resting, with Retry-After on the problem.
    local.handler = () => ({ status: 500, body: { error: { message: 'local is down' } } });
    local.calls = 0;
    let err = null;
    try { await ask(); } catch (e) { err = e; }
    assert.ok(err, 'nothing served');
    assert.strictEqual(err.status, 503);
    assert.strictEqual(err.code, 'ai.resting');
    assert.strictEqual(err.detail, 'AI is resting for a moment');
    assert.strictEqual(err.extra.retry_after_seconds, 600);
    const res = fakeRes();
    sendError(res, err, { requestId: 'req_1' }, { log() {}, warn() {}, error() {} });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.headers['retry-after'], '600');
    assert.strictEqual(res.body.detail, 'AI is resting for a moment');

    // The run API keeps that sentence clean (its tries/explain ride the explain, not the detail).
    const run = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok, body: { workflow: 'ai.generate', input: { prompt: 'hi' }, options: { cache: false } } });
    assert.strictEqual(run.body.run.status, 'failed', run.text);
    assert.strictEqual(run.body.run.error.code, 'ai.resting', run.text);
    assert.strictEqual(run.body.run.error.detail, 'AI is resting for a moment', run.text);
    await h.stop(); await paid.close(); await local.close();
});

t.test('an OpenAI-style 429 insufficient_quota is exhausted too, not ordinary rate-limit capacity', async () => {
    const paid = await seamServer(() => ({ status: 429, body: { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } } }));
    const local = await seamServer(() => ({ choices: [{ message: { content: 'local' } }], model: 'local-model', usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const h = await boot({ env: {
        AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '1', AI_BREAKER_FAILURES: '5',
        AI_PROVIDER: 'openai', AI_BASE_URL: `${paid.url}/v1`, AI_API_KEY: 'test-key', AI_MODEL: 'paid-model',
        AI_LOCAL_LLM_URL: `${local.url}/v1`, AI_LOCAL_LLM_MODEL: 'local-model', AI_LOCAL_LLM_TIMEOUT_MS: '5000',
    } });
    const route = await h.registry.resolveRoute('default.chat');
    const out = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'hi' }], maxTokens: 30, timeoutMs: 3000 }, { routeKey: route.key });
    assert.strictEqual(out.provider, 'local');
    assert.strictEqual(paid.calls, 1, 'not retried and not treated as ordinary 429 capacity');
    const health = await h.pool.health('shared');
    assert.strictEqual(health.state, 'open');
    assert.ok(health.exhausted_at);
    await h.stop(); await paid.close(); await local.close();
});

t.test('the local model is short text only, capped, and one request at a time', async () => {
    const paid = await seamServer(() => ({ status: 500, body: { error: { message: 'paid is down' } } }));
    let localCalls = 0;
    const local = await seamServer(async (body) => {
        localCalls++;
        await new Promise((r) => setTimeout(r, 250));
        return { choices: [{ message: { content: 'short' } }], model: 'local-model', usage: { prompt_tokens: 3, completion_tokens: 2 } };
    });
    const h = await boot({ env: {
        AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_BREAKER_FAILURES: '50',
        AI_PROVIDER: 'openai', AI_BASE_URL: `${paid.url}/v1`, AI_API_KEY: 'test-key', AI_MODEL: 'paid-model',
        AI_LOCAL_LLM_URL: `${local.url}/v1`, AI_LOCAL_LLM_MODEL: 'local-model', AI_LOCAL_LLM_TIMEOUT_MS: '5000',
        AI_LOCAL_LLM_MAX_TOKENS: '256', AI_LOCAL_LLM_CONCURRENCY: '1',
    } });
    const route = await h.registry.resolveRoute('default.chat');
    const req = { messages: [{ role: 'user', content: 'summarise' }], maxTokens: 600, timeoutMs: 3000 };

    const one = await h.pool.execute(route, 'chat', req, { routeKey: route.key });
    assert.strictEqual(one.provider, 'local');
    assert.strictEqual(local.last.max_tokens, 256, 'the local answer is capped at AI_LOCAL_LLM_MAX_TOKENS, whatever the route asked');

    // Two at once: one gets the local model, the other is told AI is resting instead of a second local generation.
    const results = await Promise.allSettled([
        h.pool.execute(route, 'chat', req, { routeKey: route.key }),
        h.pool.execute(route, 'chat', req, { routeKey: route.key }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    assert.strictEqual(ok.length, 1, 'one concurrent local request at a time');
    assert.strictEqual(bad.length, 1);
    assert.strictEqual(bad[0].reason.code, 'ai.resting', bad[0].reason.message);
    assert.strictEqual(localCalls, 2, 'the second request never reached the local model');

    // Code and long reasoning are never sent to the host's model.
    const before = localCalls;
    const longRoute = { ...route, max_output_tokens: 4000 };
    let longErr = null;
    try { await h.pool.execute(longRoute, 'chat', { ...req, maxTokens: 4000 }, { routeKey: route.key }); } catch (e) { longErr = e; }
    assert.ok(longErr, 'nothing served the long route');
    assert.strictEqual(localCalls, before, 'the local model was not offered a long answer');
    await h.stop(); await paid.close(); await local.close();
});

t.run();
