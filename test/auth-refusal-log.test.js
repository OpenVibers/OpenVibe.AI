'use strict';
/**
 * A refused token says why in the log (11-28: ten outside callers were answered 401 on /api/v1/allowed-keys and
 * /v1/chat/completions, and nothing in AI's log said why): the error code and the token's unverified issuer, audience,
 * kind of subject and expiry, once a minute per code and route; never the token, never a person's id.
 */
const assert = require('assert');
const { boot, request, token, suite } = require('./helpers');

const t = suite('auth-refusal-log');
const PERSON = 'usr_01M8G2WPKTZ39XRWA3CW4CQCTK';
const lines = [];
const log = { info: () => {}, debug: () => {}, warn: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')), log: () => {} };
let h;

t.test('boot', async () => { h = await boot({ log }); });

t.test('a token for another audience is refused, and the log says why without the token or the person', async () => {
    const wrong = token('someone', ['ai.run.create'], { aud: 'openvibe.wrong' });
    const r = await request(h.base, 'GET', `/api/v1/allowed-keys/${PERSON}`, { tok: wrong });
    assert.strictEqual(r.status, 401, r.text);
    const line = lines.find((l) => l.includes('[auth] refused GET /api/v1/allowed-keys/usr_…'));
    assert.ok(line, `a refusal line in: ${lines.slice(-5).join(' | ')}`);
    assert.match(line, /token\.[a-z_]+ \(iss=\S+ aud=openvibe\.wrong sub=svc:someone exp=\d{4}-/);
    const all = lines.join('\n');
    assert.ok(!all.includes(PERSON), 'no person id');
    assert.ok(!all.includes(wrong) && !all.includes(wrong.split('.')[2]), 'never the token');
    const count = lines.filter((l) => l.includes('[auth] refused')).length;
    await request(h.base, 'GET', `/api/v1/allowed-keys/${PERSON}`, { tok: wrong });
    assert.strictEqual(lines.filter((l) => l.includes('[auth] refused')).length, count, 'once a minute per code and route');
});

t.test('something that is not a JWT is refused and said to be one', async () => {
    const r = await request(h.base, 'GET', '/api/v1/allowed-keys/somebody', { tok: 'not-a-jwt-at-all' });
    assert.ok([401, 403].includes(r.status), r.text);
    if (r.status === 401) assert.ok(lines.some((l) => /\[auth\] refused GET \/api\/v1\/allowed-keys\/somebody: \S+ \(not a JWT\)/.test(l)), lines.slice(-5).join(' | '));
});

t.test('done', async () => { await h.close(); });
t.run();
