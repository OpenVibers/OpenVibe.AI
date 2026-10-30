'use strict';
// The hard spend cap of a Codes run token (Codes C3): the budget is a row in AI, keyed by the token's jti,
// and every request of that token is counted against it. The request that crosses the line still completes;
// the next one is refused with 402 ai.run_budget_reached. A token without a budget is never capped, and a
// holder of a token can neither raise the budget nor name another run's budget.
const assert = require('assert');
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');
const { boot, request, token, suite, ALL, privateKey, ISSUER } = require('./helpers');

const t = suite('run-budgets');
const KEY = 'cd'.repeat(32);
const PERSON = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP7';
const PERSON_KEY = 'sk-openai-test-person-0123456789';
const service = token('live', ALL);
const manager = token('codes', [...ALL, 'ai.credential.manage'], { extra: { on_behalf_of: PERSON } });

// A run token of its own, with a jti we know: Codes registers the budget under that jti.
function runToken(jti, extra = {}) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({
        iss: ISSUER, sub: 'svc:codes', actor_type: 'service', aud: ['openvibe.ai'], cap: ALL, ns: ['*'],
        iat: now, exp: now + 600, jti, ...extra,
    }, privateKey);
}

const credentialFetch = async () => new Response(JSON.stringify({
    id: 'chatcmpl_person', object: 'chat.completion', model: 'gpt-person',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
}), { status: 200, headers: { 'content-type': 'application/json' } });

let h;
const chat = (tok, headers = {}) => request(h.base, 'POST', '/v1/chat/completions', {
    tok, body: { model: 'openvibe', messages: [{ role: 'user', content: 'Say hello' }] }, headers: { 'x-openvibe-credential': 'openai', ...headers },
});
const budgetOf = (jti) => request(h.base, 'GET', `/api/v1/run-budgets/${jti}`, { tok: manager });
const setBudget = (jti, body) => request(h.base, 'PUT', `/api/v1/run-budgets/${jti}`, { tok: manager, body });

t.test('boot with the credentials key set', async () => {
    h = await boot({
        env: {
            AI_CREDENTIALS_KEY: KEY, AI_STUB_FALLBACK: 'false',
            // The person's own key is priced here, so a run really costs something (per Mtok).
            AI_PRICING_JSON: JSON.stringify({ 'gpt-person': { in: 1000, out: 2000 } }),
        },
        credentialFetch,
    });
});

t.test("the person's own key is stored", async () => {
    const r = await request(h.base, 'PUT', `/api/v1/credentials/${PERSON}/openai`, { tok: manager, body: { key: PERSON_KEY, models: { chat: 'gpt-person' } } });
    assert.strictEqual(r.status, 200, r.text);
});

t.test('a budget is registered for a run token', async () => {
    const jti = 'tok_budget_1';
    const r = await setBudget(jti, { budget_usd: 5, budget_tokens: 1000, expires_at: Math.floor(Date.now() / 1000) + 600 });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.budget_usd, 5);
    assert.strictEqual(r.body.budget_tokens, 1000);
});

t.test('the counter adds up across the requests of the run', async () => {
    const jti = 'tok_budget_1';
    const tok = runToken(jti, { on_behalf_of: PERSON });
    const first = await chat(tok);
    assert.strictEqual(first.status, 200, first.text);
    const after = await budgetOf(jti);
    assert.strictEqual(after.status, 200, after.text);
    assert.ok(after.body.spent_tokens >= 7, `the tokens of the first request are counted (${after.body.spent_tokens})`);
    assert.ok(after.body.spent_usd > 0, `the cost of the first request is counted (${after.body.spent_usd})`);
    const second = await chat(tok);
    assert.strictEqual(second.status, 200, second.text);
    const after2 = await budgetOf(jti);
    assert.ok(after2.body.spent_tokens > after.body.spent_tokens, 'the second request is counted too');
    assert.ok(after2.body.spent_usd > after.body.spent_usd, 'the cost adds up');
});

t.test('the request after the cap is refused with 402 and the problem code', async () => {
    const jti = 'tok_budget_2';
    const tok = runToken(jti, { on_behalf_of: PERSON });
    await setBudget(jti, { budget_tokens: 7, expires_at: Math.floor(Date.now() / 1000) + 600 });
    const first = await chat(tok);
    assert.strictEqual(first.status, 200, first.text);   // the request that crosses the line still completes
    const second = await chat(tok);
    assert.strictEqual(second.status, 402, second.text);
    assert.strictEqual(second.body.error.code, 'ai.run_budget_reached');
    assert.ok(/token/i.test(second.body.error.message), `the message says which budget: ${second.body.error.message}`);
    assert.ok(/7 tokens/.test(second.body.error.message), `the message says how much was spent: ${second.body.error.message}`);
});

t.test('the dollars of a run are capped too', async () => {
    const jti = 'tok_budget_3';
    const tok = runToken(jti, { on_behalf_of: PERSON });
    await setBudget(jti, { budget_usd: 0.001, expires_at: Math.floor(Date.now() / 1000) + 600 });
    const first = await chat(tok);
    assert.strictEqual(first.status, 200, first.text);
    const second = await chat(tok);
    assert.strictEqual(second.status, 402, second.text);
    assert.strictEqual(second.body.error.code, 'ai.run_budget_reached');
    assert.ok(/dollar/i.test(second.body.error.message), second.body.error.message);
});

t.test('a token without a budget is not capped', async () => {
    const tok = runToken('tok_budget_none', { on_behalf_of: PERSON });
    for (let i = 0; i < 3; i++) {
        const r = await chat(tok);
        assert.strictEqual(r.status, 200, r.text);
    }
    const seen = await budgetOf('tok_budget_none');
    assert.strictEqual(seen.status, 200);
    assert.strictEqual(seen.body.budget_usd, null);
    assert.strictEqual(seen.body.spent_usd, 0);
});

t.test('a budget in the request is ignored: there is nothing to forge', async () => {
    const jti = 'tok_budget_4';
    const tok = runToken(jti, { on_behalf_of: PERSON });
    await setBudget(jti, { budget_tokens: 7, expires_at: Math.floor(Date.now() / 1000) + 600 });
    const first = await chat(tok, { 'x-openvibe-budget': 'usd=100000,tokens=1000000' });
    assert.strictEqual(first.status, 200, first.text);
    const second = await chat(tok, { 'x-openvibe-budget': 'usd=100000,tokens=1000000' });
    assert.strictEqual(second.status, 402, second.text);
});

t.test('an edited token is refused: its signature does not hold', async () => {
    const jti = 'tok_budget_5';
    const tok = runToken(jti, { on_behalf_of: PERSON });
    await setBudget(jti, { budget_tokens: 7, expires_at: Math.floor(Date.now() / 1000) + 600 });
    const parts = tok.split('.');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    claims.budget_usd = 100000;                 // the holder raises the budget in the token
    claims.cap = [...claims.cap, 'ai.workflow.manage'];
    const edited = `${parts[0]}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${parts[2]}`;
    const r = await chat(edited);
    assert.strictEqual(r.status, 401, r.text);
});

t.test('another run\'s budget does not cover this token', async () => {
    const tok = runToken('tok_budget_other', { on_behalf_of: PERSON });
    const r = await chat(tok);
    assert.strictEqual(r.status, 200, r.text);
});

t.test('a budget that expired with its token is no budget', async () => {
    const jti = 'tok_budget_6';
    const tok = runToken(jti, { on_behalf_of: PERSON });
    const r = await setBudget(jti, { budget_tokens: 1, expires_at: Math.floor(Date.now() / 1000) - 10 });
    assert.strictEqual(r.status, 200, r.text);
    const run = await chat(tok);
    assert.strictEqual(run.status, 200, run.text);   // the budget is gone with the token
    const again = await chat(tok);
    assert.strictEqual(again.status, 200, again.text);   // and it stays gone
    const seen = await budgetOf(jti);
    assert.ok(seen.body.expires_at <= Math.floor(Date.now() / 1000), 'the budget expired with its token');
});

t.test('stop', async () => { await h.stop(); });

t.run();
