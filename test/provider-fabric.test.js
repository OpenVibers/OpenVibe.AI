'use strict';
// Every upstream capability can advance from a failing placed offer to the next real offer.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, seamServer, suite } = require('./helpers');

const t = suite('provider-fabric');

t.test('seeded upstream routes use placement and keep media budgets separate', async () => {
    const h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_LOCAL_LLM_URL: 'http://127.0.0.1:1/v1' } });
    try {
        for (const [key, capability, scope] of [
            ['live.stt', 'transcribe', undefined],
            ['default.embedding', 'embed', undefined],
            ['media.local', 'summarize', 'local'],
            ['media.paid', 'summarize', 'paid'],
        ]) {
            const r = await h.registry.resolveRoute(key);
            assert.strictEqual(r.capability, capability, key);
            assert.strictEqual(r.constraints.provider_scope, scope, key);
            assert.deepStrictEqual(r.fallbacks, [], key);
        }
        const embed = await h.pool.candidates(await h.registry.resolveRoute('default.embedding'), ['embed'], 'embed');
        assert.ok(embed.explain.candidates.some(c => c.provider === 'shared' && c.model === 'text-embedding-3-small'));
        assert.ok(!embed.explain.candidates.some(c => c.model === 'gpt-4o-mini'), 'chat model cannot serve embeddings');
    } finally { await h.stop(); }
});

t.test('primary upstream fails; next offer serves chat, summarize, embed and transcribe with explain', async () => {
    const failed = await seamServer((body, req) => {
        if (req.url.endsWith('/embeddings')) return { data: [] };
        if (req.url.endsWith('/audio/transcriptions')) return {};
        return { status: 503, body: { error: { message: 'forced failure' } } };
    });
    const answered = await seamServer((body, req) => {
        if (req.url.endsWith('/embeddings')) return { data: [{ index: 0, embedding: [0.1, 0.2] }], model: 'embed-good' };
        if (req.url.endsWith('/audio/transcriptions')) return { text: 'spoken answer', segments: [{ start: 0, end: 1, text: 'spoken answer' }] };
        return { choices: [{ message: { content: 'real answer' } }], model: body.model || 'chat-good' };
    });
    const h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_BREAKER_FAILURES: '50' } });
    const audio = path.join(h.dir, 'audio.wav');
    fs.writeFileSync(audio, 'test audio');
    try {
        for (const [key, url] of [['dead', failed.url], ['good', answered.url]]) {
            await h.registry.upsertProvider({ key, kind: 'openai', status: 'active', auth_mode: 'none', base_url: url,
                default_model: `chat-${key}`, capabilities: ['chat', 'summarize', 'embed', 'transcribe'], timeout_ms: 3000,
                metadata: { paid: true } });
            for (const [name, type] of [['chat', 'chat'], ['embed', 'embedding'], ['speech', 'stt']]) {
                await h.registry.upsertModel({ provider_key: key, model_key: `${name}-${key}`, type,
                    cost: { in_per_mtok: key === 'dead' ? 1 : 20, out_per_mtok: key === 'dead' ? 1 : 20 } });
            }
        }
        for (const [key, url] of [['localdead', failed.url], ['localgood', answered.url]]) {
            await h.registry.upsertProvider({ key, kind: 'openai', status: 'active', auth_mode: 'none', base_url: url,
                default_model: `chat-${key}`, capabilities: ['chat', 'summarize'], timeout_ms: 3000,
                metadata: { local: true, paid: false } });
            await h.registry.upsertModel({ provider_key: key, model_key: `chat-${key}`, type: 'chat' });
        }
        await h.registry.upsertProvider({ key: 'whisper', status: 'disabled' });
        for (const [name, capability, operation, model, req, scope, primary, next] of [
            ['chat', 'chat', 'chat', 'chat', { messages: [{ role: 'user', content: 'hi' }] }, 'paid', 'dead', 'good'],
            ['summary', 'summarize', 'summarize', 'chat', { messages: [{ role: 'user', content: 'hi' }] }, 'paid', 'dead', 'good'],
            ['local', 'summarize', 'summarize', 'chat', { messages: [{ role: 'user', content: 'hi' }] }, 'local', 'localdead', 'localgood'],
            ['embedding', 'embed', 'embed', 'embed', { input: ['hi'] }, undefined, 'dead', 'good'],
            ['speech', 'transcribe', 'transcribe', 'speech', { filePath: audio }, undefined, 'dead', 'good'],
        ]) {
            const route = await h.registry.createRouteVersion(`test.fabric.${name}`, {
                capability, constraints: { objective: 'correctness', authority: `${primary}:${model}-${primary}`, ...(scope ? { provider_scope: scope } : {}) }, timeout_ms: 3000,
            });
            const logs = [];
            const exec = await h.pool.execute(route, operation, { ...req, timeoutMs: 3000 }, { routeKey: route.key, routeVersion: route.version, logRequest: e => logs.push(e) });
            assert.strictEqual(exec.provider, next, name);
            assert.strictEqual(exec.fallbackUsed, true, name);
            assert.strictEqual(exec.explain.selected, next, name);
            assert.ok(exec.explain.candidates.some(c => c.provider === primary), `${name}: primary is explained`);
            if (scope === 'paid') assert.ok(!exec.explain.candidates.some(c => c.provider.startsWith('local')), 'paid media excludes local offers');
            if (scope === 'local') assert.ok(!exec.explain.candidates.some(c => c.provider === 'dead' || c.provider === 'good'), 'local media excludes paid offers');
            assert.ok(logs.some(e => e.provider_key === primary && e.status === 'error'), `${name}: primary failed`);
            assert.ok(logs.some(e => e.provider_key === next && e.status === 'ok' && e.fallback === 1), `${name}: fallback served`);
        }
    } finally { await h.stop(); await failed.close(); await answered.close(); }
});

t.run();
