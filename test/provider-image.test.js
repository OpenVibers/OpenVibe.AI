'use strict';
// Image generation (T6 step 1): route default.image over the OpenAI Images API, POST /api/v1/image (workflow
// ai.image). Off unless AI_IMAGE_MODEL is set; metered per image (request log operation 'image', tokens_out =
// images; one platform.usage-sample@1 reading per attempt, resource output-images:<model>, unit image).
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');
const { STUB_PNG } = require('../server/providers/stub');

const t = suite('provider-image');
const tok = token('live', ALL);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';
const ENV = { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_BREAKER_FAILURES: '50', AI_PROVIDER: 'openai', AI_IMAGE_MODEL: 'gpt-image-1' };

/** An OpenAI-shaped upstream: /images/generations answers `images(body)`, anything else 404. */
const imagesServer = (images) => seamServer((body, req) => (req.url.endsWith('/images/generations') ? images(body) : { status: 404, body: { error: { message: 'not here' } } }));
const image = async (h, body) => {
    const r = await request(h.base, 'POST', '/api/v1/image?wait=10000', { tok, body });
    assert.strictEqual(r.status, 201, r.text);
    return r.body.run;
};
const requestsOf = async (h, id) => (await request(h.base, 'GET', `/api/v1/runs/${id}`, { tok })).body.requests;

t.test('(a) the Images API answers: output.images, a request log with operation image and usage.output = 1, one per-image reading', async () => {
    const up = await imagesServer((body) => ({ created: 1, data: [{ b64_json: PNG }] }));
    const h = await boot({ env: { ...ENV, AI_BASE_URL: `${up.url}/v1` } });
    try {
        const shared = await h.registry.getProvider('shared');
        assert.ok(shared.capabilities.includes('image'), 'shared advertises image with AI_IMAGE_MODEL');
        assert.strictEqual((await h.registry.getModel('shared', 'gpt-image-1')).type, 'image');
        const route = await h.registry.resolveRoute('default.image');
        assert.strictEqual(route.capability, 'image');
        assert.strictEqual(route.constraints.objective, 'correctness');
        assert.strictEqual(route.constraints.provider_scope, 'paid');

        const run = await image(h, { prompt: 'a goose eating croutons' });
        assert.strictEqual(run.status, 'succeeded', JSON.stringify(run.error));
        assert.deepStrictEqual(run.output, { images: [{ b64: PNG, url: null }], count: 1 });
        assert.strictEqual(run.synthetic, false);
        assert.deepStrictEqual(up.last, { model: 'gpt-image-1', prompt: 'a goose eating croutons', n: 1, size: '1024x1024' }, 'gpt-image-1 gets no response_format; size from AI_IMAGE_SIZE');
        assert.strictEqual(run.usage.tokens_out, 1, 'usage.output is the image count');
        assert.strictEqual(run.usage.cost_usd, 0, 'no rate card prices an image: never the image count read as tokens');

        const log = await requestsOf(h, run.id);
        assert.strictEqual(log.length, 1);
        assert.strictEqual(log[0].operation, 'image');
        assert.strictEqual(log[0].status, 'ok');
        assert.strictEqual(log[0].tokens_out, 1);
        assert.strictEqual(log[0].tokens_in, 0);
        assert.ok(log[0].prompt_hash && !JSON.stringify(log).includes('croutons'), 'the log keeps a hash, never the prompt');

        // Billing unset: the per-image reading is queued (written, never sent), and the run is unaffected.
        const rows = await h.db.prepare('SELECT event_id, envelope, sent_at FROM usage_sample_outbox ORDER BY id').all();
        assert.strictEqual(rows.length, 1, 'one reading per image attempt, no token readings');
        const s = typeof rows[0].envelope === 'string' ? JSON.parse(rows[0].envelope) : rows[0].envelope;
        assert.strictEqual(rows[0].event_id, `ai:${run.id}:0:images`);
        assert.strictEqual(rows[0].sent_at, null, 'queued');
        assert.ok(contracts.validate('platform.usage-sample@1', s).valid);
        assert.deepStrictEqual({ resource: s.resource, unit: s.unit, quantity: s.quantity, operation: s.operation, provider: s.provider },
            { resource: 'output-images:gpt-image-1', unit: 'image', quantity: 1, operation: 'ai.image', provider: 'shared' });

        // dall-e-* is asked for b64_json; n is clamped to 1..4, and to 1 for dall-e-3 (which refuses more).
        await h.registry.upsertModel({ provider_key: 'shared', model_key: 'dall-e-3', type: 'image' });
        const a = (await h.pool.adapter('shared')).adapter;
        const r = await a.image({ model: 'dall-e-3', prompt: 'x', n: 9, timeoutMs: 3000 });
        assert.strictEqual(up.last.response_format, 'b64_json');
        assert.strictEqual(up.last.n, 1);
        assert.strictEqual(r.usage.output, 1);
        await a.image({ model: 'gpt-image-1', prompt: 'x', n: 9, timeoutMs: 3000 });
        assert.strictEqual(up.last.n, 4);
        // A missing prompt is the caller's: 422 input.invalid.
        const bad = await request(h.base, 'POST', '/api/v1/image?wait=10000', { tok, body: {} });
        assert.strictEqual(bad.status, 422, bad.text);
        assert.strictEqual(bad.body.code, 'input.invalid');
    } finally { await h.stop(); await up.close(); }
});

t.test('(b) the first image provider answers 500: the pool falls back, with explain.candidates', async () => {
    const dead = await imagesServer(() => ({ status: 500, body: { error: { message: 'upstream down' } } }));
    const ok = await imagesServer((body) => ({ data: [{ b64_json: PNG }, { b64_json: PNG }].slice(0, body.n) }));
    const h = await boot({ env: { ...ENV, AI_BASE_URL: `${dead.url}/v1` } });
    try {
        await h.registry.upsertProvider({ key: 'img2', kind: 'openai', status: 'active', auth_mode: 'none', base_url: `${ok.url}/v1`, default_model: null, capabilities: ['image'], timeout_ms: 3000, metadata: { paid: true } });
        await h.registry.upsertModel({ provider_key: 'img2', model_key: 'gpt-image-1', type: 'image' });
        const run = await image(h, { prompt: 'a lighthouse', n: 2 });
        assert.strictEqual(run.status, 'succeeded', JSON.stringify(run.error));
        assert.strictEqual(run.output.count, 2);
        assert.strictEqual(run.provenance.provider, 'img2');
        const providers = run.explain.candidates.map(c => c.provider).sort();
        assert.deepStrictEqual(providers, ['img2', 'shared'], 'both paid image providers are candidates; never the stub or a chat model');
        assert.strictEqual(run.explain.selected, 'img2');
        const log = await requestsOf(h, run.id);
        assert.deepStrictEqual(log.map(e => [e.provider_key, e.status, e.fallback, e.operation]), [['shared', 'error', 0, 'image'], ['img2', 'ok', 1, 'image']]);
        assert.strictEqual(dead.calls, 1);
        assert.strictEqual(run.usage.tokens_out, 2, 'metered per image returned');
    } finally { await h.stop(); await dead.close(); await ok.close(); }
});

t.test('(b2) the route timeout outlasts AI_PROVIDER_TIMEOUT_MS, and a timed-out image is never retried', async () => {
    let delay = 1500;
    const up = await imagesServer(async () => { await new Promise(r => setTimeout(r, delay)); return { data: [{ b64_json: PNG }] }; });
    const h = await boot({ env: { ...ENV, AI_BASE_URL: `${up.url}/v1`, AI_PROVIDER_TIMEOUT_MS: '1000', AI_PROVIDER_RETRIES: '1' } });
    try {
        assert.strictEqual((await h.registry.getProvider('shared')).timeout_ms, 1000);
        const route = await h.registry.resolveRoute('default.image');
        const ok = await h.pool.execute(route, 'image', { prompt: 'x', n: 1 }, { routeKey: route.key });
        assert.strictEqual(ok.result.images.length, 1, 'the 120 s route timeout, not the provider\'s 1 s');
        assert.strictEqual(up.calls, 1);
        delay = 2500;
        let err = null;
        try { await h.pool.execute(route, 'image', { prompt: 'x', n: 1, timeoutMs: 1000 }, { routeKey: route.key }); } catch (e) { err = e; }
        assert.ok(err, 'timed out');
        assert.strictEqual(up.calls, 2, 'one attempt: a retry would be a second paid generation');
    } finally { await h.stop(); await up.close(); }
});

t.test('(c) no image provider answers: 503 provider.unavailable, never synthetic', async () => {
    const h = await boot({ env: { ...ENV, AI_BASE_URL: 'http://127.0.0.1:1/v1' } });
    try {
        const run = await image(h, { prompt: 'a lighthouse' });
        assert.strictEqual(run.status, 'failed');
        assert.strictEqual(run.error.code, 'provider.unavailable');
        const route = await h.registry.resolveRoute('default.image');
        let err = null;
        try { await h.pool.execute(route, 'image', { prompt: 'x', n: 1, timeoutMs: 2000 }, { routeKey: route.key }); } catch (e) { err = e; }
        assert.ok(err, 'no answer');
        assert.strictEqual(err.status, 503);
        assert.strictEqual(err.code, 'provider.unavailable');
        assert.ok(err.extra.explain.candidates.every(c => c.provider !== 'stub'), 'the stub is not appended without AI_STUB_FALLBACK');
    } finally { await h.stop(); }
});

t.test('(d) AI_STUB_FALLBACK: the stub answers a deterministic 1x1 PNG, marked synthetic', async () => {
    const h = await boot({ env: { ...ENV, AI_STUB_FALLBACK: 'true', AI_BASE_URL: 'http://127.0.0.1:1/v1' } });
    try {
        const run = await image(h, { prompt: 'a lighthouse', n: 2 });
        assert.strictEqual(run.status, 'succeeded', JSON.stringify(run.error));
        assert.strictEqual(run.synthetic, true);
        assert.deepStrictEqual(run.output.images, [{ b64: STUB_PNG, url: null }, { b64: STUB_PNG, url: null }]);
        const png = Buffer.from(STUB_PNG, 'base64');
        assert.strictEqual(png.subarray(1, 4).toString(), 'PNG');
        assert.strictEqual(png.readUInt32BE(16), 1, 'width 1');
        assert.strictEqual(png.readUInt32BE(20), 1, 'height 1');
        const log = await requestsOf(h, run.id);
        assert.deepStrictEqual(log.map(e => [e.provider_key, e.status]), [['shared', 'error'], ['stub', 'ok']]);
    } finally { await h.stop(); }
});

t.test('(e) AI_IMAGE_MODEL unset: no default.image route, no image capability, and POST /api/v1/image is not configured', async () => {
    const h = await boot({ env: { AI_STUB_FALLBACK: 'true', AI_PROVIDER: 'openai' } });
    try {
        assert.ok(!await h.registry.getRoute('default.image'), 'no default.image route');
        assert.ok(!(await h.registry.getProvider('shared')).capabilities.includes('image'));
        assert.ok(!(await h.registry.listModels()).some(m => m.type === 'image'), 'no image model is seeded');
        const run = await image(h, { prompt: 'a lighthouse' });
        assert.strictEqual(run.status, 'failed');
        // The answer every operation gives when its route is not configured (engine routeFor).
        assert.deepStrictEqual(run.error, { code: 'route.unavailable', detail: 'no route default.image' });
        assert.strictEqual((await requestsOf(h, run.id)).length, 0, 'no provider was called');
        assert.strictEqual((await h.db.prepare('SELECT count(*) AS n FROM usage_sample_outbox').get()).n * 1, 0, 'nothing metered');
    } finally { await h.stop(); }
});

t.run();
