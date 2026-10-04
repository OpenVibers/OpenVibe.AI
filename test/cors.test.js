'use strict';
const assert = require('assert');
const { load } = require('../server/config');
const { boot, request, suite } = require('./helpers');

const t = suite('cors');
const allowed = 'https://ai.openvibe.services';
const otherAllowed = 'https://openvibe.services';
const rejected = 'https://ai.openvibe.services.evil.example';
let h;

function assertNoCors(headers) {
    for (const [name] of headers) assert.ok(!name.startsWith('access-control-'), `unexpected ${name}`);
}

t.test('config has exact public origins and accepts an override', () => {
    assert.deepStrictEqual(load({ NODE_ENV: 'test' }).cors.origins, [allowed, otherAllowed]);
    assert.deepStrictEqual(load({ NODE_ENV: 'test', AI_CORS_ORIGINS: ' https://reader.example, https://another.example ' }).cors.origins,
        ['https://reader.example', 'https://another.example']);
});

t.test('boot', async () => { h = await boot(); });

t.test('listed origins can read only the two public GETs without credentials', async () => {
    for (const [path, origin] of [['/stats', allowed], ['/release.json', otherAllowed]]) {
        const r = await request(h.base, 'GET', path, { headers: { Origin: origin } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.headers.get('access-control-allow-origin'), origin);
        assert.match(r.headers.get('vary'), /\bOrigin\b/i);
        assert.strictEqual(r.headers.get('access-control-allow-credentials'), null);
    }
});

t.test('unlisted and merely similar origins receive no CORS permission', async () => {
    for (const origin of [rejected, `${allowed}:443`, 'null']) {
        const r = await request(h.base, 'GET', '/stats', { headers: { Origin: origin } });
        assert.strictEqual(r.status, 200, r.text);
        assertNoCors(r.headers);
    }
    const r = await request(h.base, 'GET', '/release.json', { headers: { Origin: rejected } });
    assert.strictEqual(r.status, 200, r.text);
    assertNoCors(r.headers);
});

t.test('public GET preflight succeeds; rejected origin or method gets no CORS headers', async () => {
    for (const path of ['/stats', '/release.json']) {
        const r = await request(h.base, 'OPTIONS', path, { headers: {
            Origin: allowed, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Content-Type',
        } });
        assert.strictEqual(r.status, 204, r.text);
        assert.strictEqual(r.headers.get('access-control-allow-origin'), allowed);
        assert.strictEqual(r.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
        assert.strictEqual(r.headers.get('access-control-allow-headers'), 'Accept, Content-Type');
        assert.strictEqual(r.headers.get('access-control-allow-credentials'), null);
    }
    for (const [origin, method] of [[rejected, 'GET'], [allowed, 'POST']]) {
        const r = await request(h.base, 'OPTIONS', '/stats', { headers: { Origin: origin, 'Access-Control-Request-Method': method } });
        assert.strictEqual(r.status, 204, r.text);
        assertNoCors(r.headers);
    }
});

t.test('token and console routes never receive CORS headers', async () => {
    for (const [method, path] of [['GET', '/api/v1/runs'], ['OPTIONS', '/api/v1/runs'], ['GET', '/console'], ['OPTIONS', '/console'], ['GET', '/auth/login']]) {
        const r = await request(h.base, method, path, { headers: { Origin: allowed, 'Access-Control-Request-Method': 'GET' } });
        assertNoCors(r.headers);
    }
    for (const path of ['/stats/extra', '/release.json/extra']) {
        const r = await request(h.base, 'GET', path, { headers: { Origin: allowed } });
        assertNoCors(r.headers);
    }
});

t.test('stop', async () => { await h.stop(); });
t.run();
