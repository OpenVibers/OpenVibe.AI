'use strict';
// A person's free allowance today (plan §AD.17: the route and "Your AI" show what is left): GET /api/v1/me/allowance
// answers the tier's tokens, what today used, what is left and when it resets, for the person themselves (their own
// token or a site session); a service, even one acting for them, is refused. A free run moves "used".
const assert = require('assert');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('me allowance');
let h;
const PERSON = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const person = token('dana', ALL, { sub: PERSON, actorType: 'user' });
const siteSession = token('dana-site', ALL, { sub: PERSON, actorType: 'user', extra: { aud: ['openvibe.network', 'openvibe.design'] } });
const service = token('exchange', ALL);
const acting = token('exchange', ALL, { extra: { on_behalf_of: PERSON } });

t.test('boot: the stub is the free source, a 50-token day', async () => {
    h = await boot({ env: { AI_FREE_PROVIDERS: 'stub', AI_STUB_FALLBACK: 'true', AI_FREE_DAILY_TOKENS: '50', AI_ABUSE_NETWORK: '0', AI_ABUSE_SALT: 'allowance-test-salt',
        AI_ABUSE_RATE_PER_MIN: '1000', AI_POW_REQUIRED: '0', AI_PROVIDER_RETRIES: '0' } });
});

t.test('the person reads what is left; a service cannot', async () => {
    const r = await request(h.base, 'GET', '/api/v1/me/allowance', { tok: person });
    assert.strictEqual(r.status, 200, r.text);
    const a = r.body.allowance;
    assert.ok(a && typeof a.tier === 'string', r.text);
    assert.strictEqual(a.used, 0);
    assert.ok(a.tokens > 0 && a.left === a.tokens, `a full day (${JSON.stringify(a)})`);
    assert.ok(Date.parse(a.resets_at) > Date.now(), 'resets at the next UTC midnight');
    assert.strictEqual((await request(h.base, 'GET', '/api/v1/me/allowance', { tok: siteSession })).status, 200, 'a site session may read it');
    for (const tok of [service, acting]) {
        const no = await request(h.base, 'GET', '/api/v1/me/allowance', { tok });
        assert.strictEqual(no.status, 403, no.text);
    }
});

t.test('a free run moves what is used', async () => {
    const body = { workflow: 'ai.complete', input: { messages: [{ role: 'user', content: 'hello on my allowance' }] } };
    const run = await request(h.base, 'POST', '/api/v1/runs?wait=8000', { tok: acting, body });
    assert.strictEqual(run.status, 201, run.text);
    const a = (await request(h.base, 'GET', '/api/v1/me/allowance', { tok: person })).body.allowance;
    assert.ok(a.used > 0, `used ${a.used}`);
    assert.strictEqual(a.left, Math.max(0, a.tokens - a.used));
});

t.test('stop', async () => { await h.stop(); });
t.run();
