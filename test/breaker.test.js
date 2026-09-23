'use strict';
// The circuit breaker tracks PROVIDER health. A request the provider rejects as malformed (HTTP 400,
// 413, 422: a bad image, an oversized max_tokens, an invalid schema) is the caller's fault, so it
// must not count toward opening the circuit: otherwise any one caller can take a shared provider
// away from every other caller by sending a few bad requests in a row.

const assert = require('assert');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');

const t = suite('breaker');
const admin = token('live', ALL);
const attacker = token('news', ['ai.run.create', 'ai.run.read']);
let h;
let seam;

t.test('boot: one seam provider that rejects "BAD" prompts with HTTP 400', async () => {
    seam = await seamServer((body) => {
        const text = JSON.stringify(body.messages || []);
        if (text.includes('BAD')) return { status: 400, body: { error: { message: 'invalid request: image could not be decoded' } } };
        return { text: 'fine', model: 'seam-model', usage: { input: 3, output: 1 } };
    });
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_BREAKER_FAILURES: '2', AI_BREAKER_COOLDOWN_MS: '600000' } });
    const p = await request(h.base, 'POST', '/api/v1/providers', { tok: admin, body: { key: 'seam', kind: 'http', auth_mode: 'none', base_url: seam.url, capabilities: ['chat', 'generate', 'json'], timeout_ms: 5000 } });
    assert.strictEqual(p.status, 201, p.text);
    const r = await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: admin, body: { primary: { provider: 'seam' }, fallbacks: [], timeout_ms: 5000 } });
    assert.strictEqual(r.status, 201, r.text);
});

t.test('bad requests from one caller fail that caller only; the circuit stays closed for everyone', async () => {
    for (let i = 0; i < 4; i++) {
        const bad = await request(h.base, 'POST', '/api/v1/generate', { tok: attacker, body: { prompt: `BAD ${i}`, options: { cache: false } } });
        assert.strictEqual(bad.body.run.status, 'failed', bad.text);
    }
    assert.strictEqual(h.pool.health('seam').state, 'closed', 'client errors must not open the circuit');
    const good = await request(h.base, 'POST', '/api/v1/generate', { tok: admin, body: { prompt: 'hello', options: { cache: false } } });
    assert.strictEqual(good.body.run.status, 'succeeded', good.text);
    assert.strictEqual(good.body.run.output.text, 'fine');
});

t.test('server errors still open it', async () => {
    seam.handler = () => ({ status: 503, body: { error: { message: 'overloaded' } } });
    for (let i = 0; i < 2; i++) await request(h.base, 'POST', '/api/v1/generate', { tok: admin, body: { prompt: `x ${i}`, options: { cache: false } } });
    assert.strictEqual(h.pool.health('seam').state, 'open');
});

t.test('shutdown', async () => { await h.stop(); await seam.close(); });

t.run();
