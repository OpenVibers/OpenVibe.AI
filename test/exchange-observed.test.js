'use strict';
// The catalog's uptime is per real provider attempt, not per run status. A failed run counts against an
// offer only when an attempt row names it; an ok attempt is a success only when it produced output (not an
// output.empty run, and not a text attempt that spent every token on reasoning). 20 samples before a number.
const assert = require('assert');
const { boot, request, suite } = require('./helpers');

const t = suite('exchange-observed');
let h;
let nowMs = Date.now();
let seq = 0;
// The catalog read is memoised for 30 s per kind; advancing this clock past that makes each test read
// what it just inserted.
const clock = { now: () => nowMs };
const at = (n) => new Date(nowMs - n * 86400000).toISOString();
const uid = (p) => `${p}_${Date.now()}_${seq++}`;

async function insertRun({ id = uid('run'), status = 'succeeded', provider = null, model = null, errorCode = null, created = at(0) } = {}) {
    await h.db.prepare(`INSERT INTO runs (id, workflow_key, workflow_version, status, requester_type, requester_id, input, input_hash,
            provider_key, model_key, error_code, created_at, started_at, finished_at)
        VALUES (?, 'ai.complete', 1, ?, 'service', 'test', '{}', 'input-hash', ?, ?, ?, ?, ?, ?)`)
        .run(id, status, provider, model, errorCode, created, created, created);
    return id;
}
async function insertRequest({ runId, provider = 'deepseek', model = 'deepseek-flash', status = 'ok', operation = 'chat',
    tokensOut = 7, tokensIn = 0, tokensCached = 0, latency = 100, created = at(0), seqNo = 0 }) {
    await h.db.prepare(`INSERT INTO requests (run_id, seq, operation, provider_key, model_key, status, tokens_in, tokens_out, tokens_cached, latency_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(runId, seqNo, operation, provider, model, status, tokensIn, tokensOut, tokensCached, latency, created);
}
async function reset() {
    await h.db.prepare('DELETE FROM requests').run();
    await h.db.prepare('DELETE FROM runs').run();
}
async function catalog() {
    nowMs += 31000;
    const r = await request(h.base, 'GET', '/api/v1/exchange/catalog');
    assert.strictEqual(r.status, 200, r.text);
    return r.body;
}
function flash(body) {
    const m = body.models.find((x) => x.slug === 'deepseek/deepseek-flash');
    assert.ok(m, 'the Flash model is an offer');
    const offer = m.offers.find((o) => o.provider === 'deepseek');
    assert.ok(offer, 'DeepSeek offers Flash');
    return offer;
}

t.test('boot with DeepSeek configured', async () => {
    h = await boot({ clock, env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER: 'openai', AI_API_KEY: 'test-openai-key', DEEPSEEK_KEY: 'test-deepseek-key', DEEPSEEK_API_KEY: 'test-deepseek-key' } });
    await h.registry.upsertProvider({
        key: 'deepseek', display_name: 'DeepSeek', kind: 'openai', auth_mode: 'bearer', secret_ref: 'env:DEEPSEEK_KEY',
        base_url: 'https://api.deepseek.test', capabilities: ['chat', 'json', 'tools'], provider_access: 'OWN_DEPLOYMENT',
    });
    await h.registry.upsertModel({ provider_key: 'deepseek', model_key: 'deepseek-flash', type: 'chat', context_window: 131072,
        cost: { in_per_mtok: 0.3, out_per_mtok: 1.2 } });
});

t.test('a failed run that reached no provider counts against no offer', async () => {
    await reset();
    // The production shape: refusals before routing keep no provider and no request row.
    for (let i = 0; i < 50; i++) await insertRun({ status: 'failed' });
    // A route that refused the offer logs only a skipped row: no provider was tried.
    const skipped = await insertRun({ status: 'failed' });
    await insertRequest({ runId: skipped, status: 'skipped' });

    const body = await catalog();
    assert.strictEqual(flash(body).requests_7d, 0);
    assert.strictEqual(flash(body).uptime, null);
    const total = body.models.reduce((n, m) => n + m.offers.reduce((a, o) => a + o.requests_7d, 0), 0);
    assert.strictEqual(total, 0, 'no offer counts a run that never reached a provider');
});

t.test('a failed run counts against the offer its failed attempt names', async () => {
    await reset();
    const failed = await insertRun({ status: 'failed' });
    await insertRequest({ runId: failed, status: 'error', tokensOut: 0, latency: 900 });
    for (let i = 0; i < 19; i++) {
        const id = await insertRun();
        await insertRequest({ runId: id });
    }

    const offer = flash(await catalog());
    assert.strictEqual(offer.requests_7d, 20);
    assert.strictEqual(offer.uptime, 0.95, '19 answered attempts and 1 failed attempt');
});

t.test('an ok attempt that produced no output is a failure, not a success', async () => {
    await reset();
    // 10 runs ended output.empty; their provider answered but produced nothing usable.
    for (let i = 0; i < 10; i++) {
        const id = await insertRun({ status: 'failed', errorCode: 'output.empty' });
        await insertRequest({ runId: id, tokensOut: 0 });
    }
    // 10 more spent every output token on reasoning: tokens_out 0 with no content.
    for (let i = 0; i < 10; i++) {
        const id = await insertRun();
        await insertRequest({ runId: id, operation: 'generate', tokensOut: 0 });
    }

    const offer = flash(await catalog());
    assert.strictEqual(offer.requests_7d, 20);
    assert.strictEqual(offer.uptime, 0, '20 ok-but-empty Flash attempts are 20 failures');
    assert.deepStrictEqual(offer.speed, { p50_ms: null, p95_ms: null }, 'an empty attempt is not a speed sample');
});

t.test('8 successes and 0 real failures are 100% only once 20 samples exist', async () => {
    await reset();
    for (let i = 0; i < 8; i++) {
        const id = await insertRun();
        await insertRequest({ runId: id });
    }
    let offer = flash(await catalog());
    assert.strictEqual(offer.requests_7d, 8);
    assert.strictEqual(offer.uptime, null, '8 answers is below the 20-sample floor');
    assert.deepStrictEqual(offer.speed, { p50_ms: null, p95_ms: null });

    for (let i = 0; i < 12; i++) {
        const id = await insertRun();
        await insertRequest({ runId: id });
    }
    offer = flash(await catalog());
    assert.strictEqual(offer.requests_7d, 20);
    assert.strictEqual(offer.uptime, 1);
    assert.deepStrictEqual(offer.speed, { p50_ms: 100, p95_ms: 100 });
});

t.test('the prompt-cache share comes from the cached token counts of real attempts', async () => {
    await reset();
    // 20 attempts of 1,000 prompt tokens; half reported 500 of them served from the provider's prompt cache.
    for (let i = 0; i < 20; i++) {
        const id = await insertRun();
        await insertRequest({ runId: id, tokensIn: 1000, tokensCached: i < 10 ? 500 : 0 });
    }
    const offer = flash(await catalog());
    assert.strictEqual(offer.cache_hit_share_7d, 0.25, '5,000 cached of 20,000 prompt tokens');
    assert.strictEqual(offer.cached_7d, 0, 'a provider-side cache hit is not a cached answer');
    const model = (await catalog()).models.find((x) => x.slug === 'deepseek/deepseek-flash');
    assert.strictEqual(model.cache_hit_share_7d, 0.25);
});

t.test('below 20 attempts, or with no reported input tokens, the share is null, never 0', async () => {
    await reset();
    for (let i = 0; i < 5; i++) {
        const id = await insertRun();
        await insertRequest({ runId: id, tokensIn: 100, tokensCached: 100 });
    }
    assert.strictEqual(flash(await catalog()).cache_hit_share_7d, null, '5 attempts is below the floor');

    await reset();
    for (let i = 0; i < 20; i++) {
        const id = await insertRun();
        await insertRequest({ runId: id });
    }
    assert.strictEqual(flash(await catalog()).cache_hit_share_7d, null, 'no attempt reported input tokens');
});

t.run();
