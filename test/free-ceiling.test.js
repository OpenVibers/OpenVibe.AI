'use strict';
// Spend safety: a run nobody pays for (the free allowance, the anonymous Try it) may use only offers from
// AI_FREE_PROVIDERS and at or below AI_FREE_MAX_OUTPUT_PRICE_USD_PER_MTOK (default 1.5 per 1M output tokens).
// A person's own token may pay a dearer model from their Balance; their own key never goes through the
// router's caps at all. The provider allowlist has its own test file (free-providers.test.js); this one names
// its two test providers so it can exercise the ceiling alone.
const assert = require('assert');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');
const { load } = require('../server/config');
const models = require('./fixtures/free-ceiling/models.json');

const t = suite('free-ceiling');
let h; let srv; let route;
const tok = token('test', ALL);
const exchange = token('exchange', ALL);

t.test('the ceiling is $1.5 by default and configurable', () => {
    assert.strictEqual(load({}).freeUse.maxOutputPricePerMtok, 1.5);
    assert.strictEqual(load({ AI_FREE_MAX_OUTPUT_PRICE_USD_PER_MTOK: '2.5' }).freeUse.maxOutputPricePerMtok, 2.5);
});

t.test('boot two offers: cheap, and a frontier model over the ceiling', async () => {
    // OpenAI format: the anonymous Try it and a person's own token reach the service through ai.complete
    // (a Chat Completions passthrough), which only an OpenAI-format provider offers.
    srv = await seamServer(() => ({ model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'an answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_FREE_PROVIDERS: 'cheap,dear' } });
    for (const [key, label] of [['cheap', 'Cheap'], ['dear', 'Dear']]) {
        await h.registry.upsertProvider({ key, display_name: label, kind: 'openai', status: 'active', base_url: `${srv.url}/v1`, auth_mode: 'none', capabilities: ['chat', 'generate', 'json'], default_model: models[key].model_key, timeout_ms: 3000 }, { actor: 'test', origin: 'admin' });
        await h.registry.upsertModel({ provider_key: key, ...models[key] }, { actor: 'test' });
    }
    route = await h.registry.createRouteVersion('test.free-ceiling', { capability: 'chat', constraints: { objective: 'correctness' }, timeout_ms: 3000 }, { actor: 'test' });
});

t.test('the free run takes the cheap model, though the heavy task would otherwise take the frontier one', async () => {
    const out = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'write the whole function' }], reasoning: true, maxTokens: 8000, timeoutMs: 3000 }, { routeKey: route.key, routeVersion: route.version, freeUse: true });
    assert.strictEqual(out.provider, 'cheap', 'the over-ceiling frontier offer was skipped');
    assert.ok(out.explain.attempts.some((a) => a.provider === 'dear' && /over_price_ceiling/.test(a.error || '')));
});

t.test('when every capable offer is too dear, a free run is refused with 402, never run', async () => {
    const off = await request(h.base, 'POST', '/api/v1/providers/cheap/disable', { tok });
    assert.strictEqual(off.status, 200, off.text);
    const before = srv.calls;
    await assert.rejects(
        () => h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'hello' }], timeoutMs: 3000 }, { routeKey: route.key, routeVersion: route.version, freeUse: true }),
        (err) => err.code === 'billing.payer_required' && /free allowance/.test(err.detail || err.message),
    );
    assert.strictEqual(srv.calls, before, 'no provider was called');
});

t.test('the anonymous ai.complete run is capped; the same request on a person\'s own token is not', async () => {
    const anon = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: exchange, body: { workflow: 'ai.complete', input: { messages: [{ role: 'user', content: 'hello' }] } } });
    assert.strictEqual(anon.status, 201, anon.text);
    assert.strictEqual(anon.body.run.status, 'failed');
    assert.strictEqual(anon.body.run.error.code, 'billing.payer_required');

    const person = token('dana', ALL, { sub: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPY', actorType: 'user' });
    const paid = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: person, body: { workflow: 'ai.complete', input: { messages: [{ role: 'user', content: 'hello' }] } } });
    assert.strictEqual(paid.status, 201, paid.text);
    assert.strictEqual(paid.body.run.status, 'succeeded', paid.text);
    assert.strictEqual(paid.body.run.provenance.provider, 'dear');
});

t.test('stop', async () => { await h.stop(); await srv.close(); });

t.run();
