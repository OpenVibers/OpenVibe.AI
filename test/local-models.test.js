'use strict';
// Two local chat servers are two offered models: `local` and `local2`. A first-party generate run can pin
// one local offer for each side of an AI-vs-AI match, and neither pin reaches the other side's server.
const assert = require('assert');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');

const t = suite('local-models');
const firstParty = token('games', ['ai.run.create', 'ai.run.read'], { ns: ['ai.*'] });
const answer = (model) => ({ model, choices: [{ message: { content: model } }], usage: { prompt_tokens: 3, completion_tokens: 2 } });

let h; let qwen; let llama;
const calls = { qwen: 0, llama: 0 };

t.test('boot with two local chat servers', async () => {
    qwen = await seamServer(() => { calls.qwen++; return answer('qwen-test'); });
    llama = await seamServer(() => { calls.llama++; return answer('llama-test'); });
    h = await boot({ env: {
        AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0',
        AI_LOCAL_LLM_URL: `${qwen.url}/v1`, AI_LOCAL_LLM_MODEL: 'qwen-test',
        AI_LOCAL_LLM2_URL: `${llama.url}/v1`, AI_LOCAL_LLM2_MODEL: 'llama-test',
    } });
});

t.test('GET /api/v1/routes offers both local models', async () => {
    const r = await request(h.base, 'GET', '/api/v1/routes?operation=generate', { tok: firstParty });
    assert.strictEqual(r.status, 200, r.text);
    const ids = (r.body.offers || []).map((o) => `${o.provider}:${o.model}`);
    assert.ok(ids.includes('local:qwen-test'), `local offer missing from ${ids.join(', ')}`);
    assert.ok(ids.includes('local2:llama-test'), `local2 offer missing from ${ids.join(', ')}`);
});

t.test('a pin to each local offer calls only that model', async () => {
    for (const [provider, model, other] of [['local2', 'llama-test', 'qwen'], ['local', 'qwen-test', 'llama']]) {
        const before = { qwen: calls.qwen, llama: calls.llama };
        const r = await request(h.base, 'POST', '/api/v1/generate?wait=5000', { tok: firstParty, body: {
            prompt: 'pick a hero', route: { provider, model }, max_tokens: 30, options: { cache: false },
        } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.body.run.provenance.provider, provider);
        assert.strictEqual(r.body.run.provenance.model, model);
        assert.strictEqual(r.body.run.provenance.fallback_used, false);
        assert.match(r.body.run.explain.reasons.join(' '), new RegExp(`pinned to ${provider}/${model}`));
        assert.strictEqual(calls[other], before[other], `the ${other} server was not called`);
    }
});

t.test('shutdown', async () => {
    await h.stop();
    await qwen.close();
    await llama.close();
});

t.run();
