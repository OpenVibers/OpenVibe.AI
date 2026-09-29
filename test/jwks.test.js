'use strict';
// Plan T0/T1: Network tokens verify through openvibe-sdk/auth's JWKS client, not a hand-written copy.
// A token signed by a key in a stub JWKS verifies; with the keys cached a JWKS outage still verifies;
// /api/ready is 503 until a fetch succeeds, and nothing public names the internal JWKS URL or its error.

const assert = require('assert');
const crypto = require('crypto');
const nodeHttp = require('http');
const { boot, request, token, suite, publicKey, ALL } = require('./helpers');

const t = suite('jwks');

const KID = 'test-key-1';
/** The test public key as Network publishes it (the SDK filters on kty/use/alg and matches on kid). */
function jwksDoc() {
    const jwk = crypto.createPublicKey(publicKey).export({ format: 'jwk' });
    return { keys: [{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' }] };
}
function jwksServer(doc) {
    const s = { calls: 0, doc };
    s.server = nodeHttp.createServer((_req, res) => {
        s.calls++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(s.doc));
    });
    return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => {
        s.url = `http://127.0.0.1:${s.server.address().port}`;
        s.close = () => new Promise((r) => { s.server.closeAllConnections?.(); s.server.close(() => r()); });
        resolve(s);
    }));
}

let h;
let jwks;
const body = { workflow: 'ai.generate', input: { prompt: 'jwks' } };
const run = (tok) => request(h.base, 'POST', '/api/v1/runs?wait=3000', { tok, body });

t.test('boot with a stub JWKS (no pinned key)', async () => {
    jwks = await jwksServer(jwksDoc());
    h = await boot({ env: { OV_NETWORK_PUBLIC_KEY: '', OV_NETWORK_INTERNAL_URL: jwks.url } });
});

t.test('/api/ready: 503 until the keys load (every endpoint needs a verified token)', async () => {
    const r = await request(h.base, 'GET', '/api/ready');
    assert.strictEqual(r.status, 503, r.text);
    const c = r.body.checks.network_jwks;
    assert.strictEqual(c.required, true);
    assert.strictEqual(c.status, 'fail');
});

t.test('a token signed by a key from the stub JWKS verifies', async () => {
    const r = await run(token('live', ALL));
    assert.strictEqual(r.status, 201, r.text);
    assert.ok(jwks.calls >= 1, 'the SDK fetched the JWKS');
});

t.test('/api/ready: the JWKS check turns ok once the keys are cached', async () => {
    const r = await request(h.base, 'GET', '/api/ready');
    const c = r.body.checks.network_jwks;
    assert.strictEqual(c.status, 'ok', JSON.stringify(c));
    assert.strictEqual(c.detail.keys, 1);
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(!r.text.includes(jwks.url), 'the internal JWKS URL is never public');
});

t.test('with the keys cached, a JWKS outage still verifies', async () => {
    await jwks.close();
    const before = jwks.calls;
    const r = await run(token('live', ALL));   // fresh token, same signing key
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(jwks.calls, before, 'the cached keys were used, no fetch attempted');
});

// The SDK supplies only the key: every claim rule is still openvibe-contracts' verifyServiceToken (a review caught a
// conversion that had dropped both of these).
t.test('a sandbox token is still refused', async () => {
    const r = await run(token('probe', ALL, { extra: { env: 'sandbox' } }));
    assert.strictEqual(r.status, 401, r.text);
    assert.match(r.text, /sandbox/);
});

t.test('a token whose sub is not a principal is a 401, never a 500', async () => {
    const r = await run(token('probe', ALL, { sub: 'not-a-service' }));
    assert.strictEqual(r.status, 401, r.text);
});

t.test('shutdown', async () => { await h.stop(); });

// A review caught the SDK's error (the internal JWKS URL and the connect error) answered as the 503 detail.
t.test('an unreachable JWKS is a 503 that names neither the URL nor the error', async () => {
    const dead = 'http://127.0.0.1:9';
    const h2 = await boot({ env: { OV_NETWORK_PUBLIC_KEY: '', OV_NETWORK_INTERNAL_URL: dead } });
    try {
        const r = await request(h2.base, 'POST', '/api/v1/runs?wait=3000', { tok: token('live', ALL), body });
        assert.strictEqual(r.status, 503, r.text);
        assert.ok(!r.text.includes('127.0.0.1:9') && !/ECONNREFUSED|fetch failed/i.test(r.text), r.text);
        const ready = await request(h2.base, 'GET', '/api/ready');
        assert.ok(!ready.text.includes('127.0.0.1:9') && !/ECONNREFUSED|fetch failed/i.test(ready.text), ready.text);
    } finally { await h2.stop(); }
});

t.run();
