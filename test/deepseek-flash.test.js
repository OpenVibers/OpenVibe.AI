'use strict';
// DeepSeek V4.1 Flash is a reasoning model: `max_tokens` is the whole allowance, and reasoning is spent
// from it before content. A 48-token cap can therefore be all thinking, finish_reason 'length', content
// empty and usage output 0. The real response (2026-11-07) keeps the answer in choices[0].message.content
// and the thinking in reasoning_content; usage counts reasoning_tokens inside completion_tokens. The
// adapter must read content, and the registry says how much room this model needs beyond the caller's cap.
const assert = require('assert');
const fixture = require('./fixtures/deepseek-flash.json');
const { boot, suite, seamServer } = require('./helpers');
const { createOpenAiProvider } = require('../server/providers/openai');

const t = suite('deepseek-flash');
const completion = fixture.completion;
const answer = completion.choices[0].message.content;
const MESSAGES = [{ role: 'user', content: 'Pick the one moment worth clipping.' }];
const empty = {
    model: 'deepseek-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: '', reasoning_content: 'Still thinking about the one moment.' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 9556, completion_tokens: 48, total_tokens: 9604, completion_tokens_details: { reasoning_tokens: 48 } },
};
let h;
let srv;
let route;

t.test('the real DeepSeek shape: content is the answer, reasoning is not, output excludes reasoning tokens', async () => {
    const s = await seamServer(() => completion);
    try {
        const a = createOpenAiProvider({ key: 'deepseek', base_url: `${s.url}/v1`, capabilities: ['chat'] }, { apiKey: 'k' });
        const r = await a.chat({ model: 'deepseek-flash', messages: MESSAGES, maxTokens: 300, timeoutMs: 3000 });
        assert.strictEqual(r.text, answer);
        assert.ok(!r.text.includes('repeats the same scene'), 'reasoning_content never becomes the answer');
        assert.strictEqual(r.usage.input, 9556);
        assert.strictEqual(r.usage.output, 28, 'completion_tokens 182 minus 154 reasoning');
        assert.strictEqual(r.usage.reasoning, 154);
    } finally { await s.close(); }
});

t.test('boot a DeepSeek Flash offer', async () => {
    srv = await seamServer((body) => (body.max_tokens >= 1000 ? completion : empty));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0' } });
    await h.registry.upsertProvider({
        key: 'deepseek', display_name: 'DeepSeek', kind: 'openai', status: 'active', base_url: `${srv.url}/v1`,
        auth_mode: 'none', capabilities: ['chat', 'generate', 'json'], default_model: 'deepseek-flash', timeout_ms: 3000,
    }, { actor: 'test', origin: 'admin' });
    await h.registry.upsertModel({
        provider_key: 'deepseek', model_key: 'deepseek-flash', display_name: 'DeepSeek V4.1 Flash', type: 'chat',
        supports: { json: true, tools: true, streaming: true }, cost: { in_per_mtok: 0.3, out_per_mtok: 1.2 },
        metadata: { reasoning: true, reasoning_reserve_tokens: 1536 },
    }, { actor: 'test' });
    route = await h.registry.createRouteVersion('test.deepseek-flash', { capability: 'chat', timeout_ms: 3000 }, { actor: 'test' });
});

t.test('a 48-token caller cap gets the model\'s reasoning room and answers', async () => {
    const out = await h.pool.execute(route, 'chat', { messages: MESSAGES, maxTokens: 48, timeoutMs: 3000 },
        { routeKey: route.key, routeVersion: route.version });
    assert.strictEqual(srv.last.max_tokens, 48 + 1536, 'the caller\'s 48 plus the registry reserve');
    assert.strictEqual(out.provider, 'deepseek');
    assert.strictEqual(out.result.text, answer);
    assert.strictEqual(out.usage.output, 28);
});

t.test('the Exchange chat path (complete) gets the same reasoning room', async () => {
    const out = await h.pool.execute(route, 'complete', { openai: { messages: MESSAGES }, maxTokens: 48, timeoutMs: 3000 },
        { routeKey: route.key, routeVersion: route.version });
    assert.strictEqual(srv.last.max_tokens, 48 + 1536);
    assert.strictEqual(out.result.text, answer);
});

t.test('without the reserve the same 48 tokens are all reasoning: the empty answer is a failed attempt, not a success', async () => {
    await h.registry.upsertModel({
        provider_key: 'deepseek', model_key: 'deepseek-flash', display_name: 'DeepSeek V4.1 Flash', type: 'chat',
        supports: { json: true, tools: true, streaming: true }, cost: { in_per_mtok: 0.3, out_per_mtok: 1.2 },
        metadata: { reasoning: true },
    }, { actor: 'test' });
    // The reproduction of the production run (11-10 to 11-13): the model spends the room on reasoning and answers
    // nothing. The router counts that as a failed attempt (provider.empty), so with no other offer the call fails
    // instead of handing back an empty "success".
    await assert.rejects(
        () => h.pool.execute(route, 'chat', { messages: MESSAGES, maxTokens: 48, timeoutMs: 3000 }, { routeKey: route.key, routeVersion: route.version }),
        (err) => /could answer/.test(err.message),
    );
    assert.strictEqual(srv.last.max_tokens, 48, 'no reserve means no extra room');
});

t.test('the seed puts the reasoning room on the model, not on every provider', async () => {
    const b = await boot({ env: { AI_STUB_FALLBACK: 'false', DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_KEY: 'test-key' } });
    try {
        const m = await b.registry.getModel('deepseek', 'deepseek-flash');
        assert.ok(m, 'the seed creates DeepSeek Flash');
        assert.strictEqual(m.metadata.reasoning_reserve_tokens, 1536);
    } finally { await b.stop(); }
});

t.test('stop', async () => { await h.stop(); await srv.close(); });

t.run();
