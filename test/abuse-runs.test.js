'use strict';
// Plan E5 end to end through the run API: the daily allowance is refused at admission, and the anonymous Try it
// needs one proof of work. The module's own behaviour is in test/abuse.test.js.
const assert = require('assert');
const { boot, request, token, suite, ALL } = require('./helpers');
const { solve } = require('../server/abuse/pow');

const t = suite('abuse-runs');
const PERSON = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
let h;

t.test('boot: the stub is the free source, Network signals off, a tiny allowance', async () => {
    h = await boot({
        env: {
            AI_FREE_PROVIDERS: 'stub', AI_STUB_FALLBACK: 'true', AI_FREE_DAILY_TOKENS: '4',
            AI_ABUSE_NETWORK: '0', AI_ABUSE_SALT: 'runs-test-salt', AI_ABUSE_RATE_PER_MIN: '1000',
            AI_POW_REQUIRED: '0', AI_PROVIDER_RETRIES: '0',
        },
    });
});

t.test('a free run spends the day\'s allowance; the next one is refused with 402', async () => {
    const acting = token('exchange', ALL, { extra: { on_behalf_of: PERSON } });
    const body = { workflow: 'ai.complete', input: { messages: [{ role: 'user', content: 'hello on my allowance' }] } };
    const first = await request(h.base, 'POST', '/api/v1/runs?wait=8000', { tok: acting, body });
    assert.strictEqual(first.status, 201, first.text);
    assert.strictEqual(first.body.run.status, 'succeeded', first.text);
    const row = await h.db.prepare('SELECT tokens FROM abuse_daily_usage WHERE subject = ?').get(`user:${PERSON}`);
    assert.ok(row && Number(row.tokens) > 0, 'the run recorded its free tokens');
    const second = await request(h.base, 'POST', '/api/v1/runs?wait=8000', { tok: acting, body });
    assert.strictEqual(second.status, 402, second.text);
    assert.strictEqual(second.body.code, 'ai.allowance_spent');
    assert.ok(second.headers.get('retry-after'), 'the refusal says when the UTC day resets');
});

t.test('stop', async () => { await h.stop(); });

t.test('boot for the anonymous Try it: proof of work required', async () => {
    h = await boot({
        env: {
            AI_FREE_PROVIDERS: 'stub', AI_STUB_FALLBACK: 'true', AI_FREE_DAILY_TOKENS: '1000',
            AI_ABUSE_NETWORK: '0', AI_ABUSE_SALT: 'pow-test-salt', AI_ABUSE_RATE_PER_MIN: '1000',
            AI_POW_REQUIRED: '1', AI_POW_BITS: '4', AI_PROVIDER_RETRIES: '0',
        },
    });
});

t.test('without a proof of work the anonymous run is refused; a solved challenge runs once', async () => {
    const exchange = token('exchange', ALL);
    const body = { workflow: 'ai.complete', input: { messages: [{ role: 'user', content: 'hello anonymously' }] } };
    const noPow = await request(h.base, 'POST', '/api/v1/runs?wait=8000', { tok: exchange, body });
    assert.strictEqual(noPow.status, 403, noPow.text);
    assert.strictEqual(noPow.body.code, 'ai.pow_required');

    const challenge = await request(h.base, 'POST', '/api/v1/exchange/tryit/challenge', { tok: exchange, body: {} });
    assert.strictEqual(challenge.status, 200, challenge.text);
    assert.strictEqual(challenge.body.bits, 8);
    const cookie = (challenge.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(/^ovai_device=/.test(cookie), 'the challenge sets the signed device cookie');
    const proof = `${challenge.body.challenge}:${solve(challenge.body.challenge, challenge.body.bits)}`;
    const run = await request(h.base, 'POST', '/api/v1/runs?wait=8000', { tok: exchange, body, headers: { cookie, 'x-ov-pow': proof } });
    assert.strictEqual(run.status, 201, run.text);
    assert.strictEqual(run.body.run.status, 'succeeded', run.text);
    const replay = await request(h.base, 'POST', '/api/v1/runs?wait=8000', { tok: exchange, body, headers: { cookie, 'x-ov-pow': proof } });
    assert.strictEqual(replay.status, 403, replay.text);
    assert.strictEqual(replay.body.code, 'ai.pow_invalid');
});

t.test('stop anonymous', async () => { await h.stop(); });

t.run();
