'use strict';
// Exchange's search page searches as the signed-in person with their site session (audience openvibe.network),
// forwarded from Exchange's server. AI's search routes took only an AI-audience person token, so every search there
// answered 401 token.wrong_audience until 2026-11-15. Now, on the search routes only, that session is taken when the
// request carries Exchange's Origin (the rule server/me.js applies to Exchange's writes); from anywhere else, and on
// the other routes, it is refused as before.
//
//   node test/exchange-search-session.test.js
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { boot, request, suite, privateKey, ISSUER } = require('./helpers');

const t = suite('exchange-search-session');
const PERSON = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP7';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function userToken(audience) {
    const now = Math.floor(Date.now() / 1000);
    const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: ISSUER, sub: PERSON, subject_id: PERSON, aud: [audience], iat: now, exp: now + 3600, jti: `tok_${crypto.randomBytes(8).toString('hex')}` })}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
const iconify = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/search') return new Response(JSON.stringify({ icons: ['lucide:search'] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/collections') return new Response(JSON.stringify({ lucide: { name: 'Lucide', author: { name: 'Lucide' }, license: { spdx: 'ISC', url: 'https://example.test/license' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error(`unexpected ${url}`);
};
const EXCHANGE = 'https://openvibe.exchange';
const icons = { q: 'search', engine: 'iconify', limit: 1 };
let h;

t.test('boot', async () => { h = await boot({ searchFetch: iconify }); });

t.test('the site session searches when Exchange forwards it', async () => {
    const r = await request(h.base, 'POST', '/v1/search/icons', { tok: userToken('openvibe.network'), headers: { Origin: EXCHANGE }, body: icons });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.results[0].name, 'lucide:search');
});

t.test('and nowhere else', async () => {
    const session = userToken('openvibe.network');
    const bare = await request(h.base, 'POST', '/v1/search/icons', { tok: session, body: icons });
    assert.notEqual(bare.status, 200, 'without Exchange\'s Origin');
    const other = await request(h.base, 'POST', '/v1/search/icons', { tok: session, headers: { Origin: 'https://evil.example' }, body: icons });
    assert.notEqual(other.status, 200, 'from another origin');
    const crossSite = await request(h.base, 'POST', '/v1/search/icons', { tok: session, headers: { Origin: EXCHANGE, 'Sec-Fetch-Site': 'cross-site' }, body: icons });
    assert.notEqual(crossSite.status, 200, 'a cross-site browser fetch');
    const runs = await request(h.base, 'POST', '/api/v1/runs', { tok: session, headers: { Origin: EXCHANGE }, body: { workflow: 'ai.complete', input: { messages: [{ role: 'user', content: 'hi' }] } } });
    assert.ok(runs.status === 401 || runs.status === 403, `a route that did not opt in still refuses it (${runs.status})`);
});

t.test('an AI-audience person token searches as before', async () => {
    const r = await request(h.base, 'POST', '/v1/search/icons', { tok: userToken('openvibe.ai'), body: icons });
    assert.equal(r.status, 200, JSON.stringify(r.body));
});

t.test('stop', async () => { await h.stop(); });

t.run();
