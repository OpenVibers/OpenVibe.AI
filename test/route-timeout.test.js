'use strict';
// A route that says so (options.outlast_provider_timeout) outlasts the shared provider's chat timeout: space.build
// (the space builder writes a whole app, 180 s) outlasts a provider timeout of 1 s, as image generation always did;
// an explicit shorter request timeout still ends the call, and other routes keep the provider's timeout strict.
const assert = require('assert');
const { boot, suite, seamServer } = require('./helpers');

const t = suite('route-timeout');
const ENV = { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_BREAKER_FAILURES: '50', AI_PROVIDER: 'openai', AI_MODEL: 'gpt-4o-mini' };

t.test('space.build outlasts the provider\'s 1 s chat timeout; a 1 s request timeout does not', async () => {
    const up = await seamServer(async () => { await new Promise((r) => setTimeout(r, 1500)); return { choices: [{ message: { role: 'assistant', content: 'built' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; });
    const h = await boot({ env: { ...ENV, AI_BASE_URL: `${up.url}/v1`, AI_PROVIDER_TIMEOUT_MS: '1000' } });
    try {
        assert.strictEqual((await h.registry.getProvider('shared')).timeout_ms, 1000);
        const route = await h.registry.resolveRoute('space.build');
        assert.ok(route.timeout_ms >= 180000, `space.build asks for ${route.timeout_ms} ms`);
        const ok = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'build it' }], maxTokens: 50 }, { routeKey: route.key });
        assert.strictEqual(ok.result.text, 'built');
        let err = null;
        try { await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'build it' }], maxTokens: 50, timeoutMs: 1000 }, { routeKey: route.key }); } catch (e) { err = e; }
        assert.ok(err, 'an explicit 1 s request timeout still ends the call');
        const chat = await h.registry.resolveRoute('default.chat');
        let strict = null;
        try { await h.pool.execute(chat, 'chat', { messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 }, { routeKey: chat.key }); } catch (e) { strict = e; }
        assert.ok(strict, 'default.chat keeps the provider\'s 1 s timeout');
    } finally { await h.stop(); await up.close(); }
});

t.run();
