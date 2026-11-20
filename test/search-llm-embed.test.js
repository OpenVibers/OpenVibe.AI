'use strict';
// The search model helper's embeddings (server/deep-dive/llm.js embed, used by search v2's rerank): the platform's
// default.embedding route through the pool, every text as a string, a short timeout, and the cost and model returned.
const assert = require('node:assert/strict');
const { createLlm } = require('../server/deep-dive/llm');

(async () => {
    const calls = [];
    const registry = { resolveRoute: async (key) => (key === 'default.embedding' ? { key, version: 3, timeout_ms: 30000 } : null) };
    const pool = { execute: async (route, op, req, ctx) => { calls.push({ route: route.key, op, req, ctx }); return { result: { vectors: req.input.map((_, i) => [i, 1]) }, model: 'fake/embed', provider: 'fake', cost: 0.00003 }; } };
    const llm = createLlm({ registry, pool, clock: { now: () => 1000 } });
    const out = await llm.embed(['question', 42, null]);
    assert.deepEqual(out.vectors, [[0, 1], [1, 1], [2, 1]]);
    assert.equal(out.model, 'fake/embed');
    assert.equal(out.cost_usd, 0.00003);
    assert.equal(calls[0].route, 'default.embedding');
    assert.equal(calls[0].op, 'embed');
    assert.deepEqual(calls[0].req.input, ['question', '42', ''], 'every text a string');
    assert.equal(calls[0].req.timeoutMs, 8000, 'a late ranking is skipped, not waited for');
    assert.equal(calls[0].ctx.routeVersion, 3);
    const none = createLlm({ registry: { resolveRoute: async () => null }, pool });
    await assert.rejects(none.embed(['x']), (err) => err.code === 'route.unavailable');
    // A soft model preference reaches the pool's request, on the retry too.
    const chats = [];
    const chatPool = { execute: async (route, op, req) => { chats.push(req); return { result: { json: chats.length === 1 ? { wrong: true } : { answer: 'ok' } }, model: 'fake', cost: 0 }; } };
    const chatter = createLlm({ registry: { resolveRoute: async (key) => ({ key, version: 1 }) }, pool: chatPool, clock: { now: () => 1 } });
    const got = await chatter.call({ user: 'q', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, prefer: 'deepseek/deepseek-flash' });
    assert.equal(got.json.answer, 'ok');
    assert.deepEqual(chats.map((r) => r.prefer), ['deepseek/deepseek-flash', 'deepseek/deepseek-flash'], 'asked on the first try and the retry');
    const plain = []; await createLlm({ registry: { resolveRoute: async (key) => ({ key, version: 1 }) }, pool: { execute: async (r, o, req) => { plain.push(req); return { result: { json: { answer: 'x' } } }; } } }).call({ user: 'q' });
    assert.equal('prefer' in plain[0], false, 'no preference unless asked');
    console.log('search-llm-embed: 3 checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
