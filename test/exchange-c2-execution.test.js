'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { boot, request, token, ALL } = require('./helpers');
const { createKeys } = require('../server/platform/keys');
(async () => {
    const seen = [];
    const upstream = http.createServer((req, res) => {
        let raw = '';
        req.on('data', c => raw += c);
        req.on('end', () => {
            const b = JSON.parse(raw); seen.push(b);
            res.setHeader('Content-Type', 'application/json');
            if (b.model === 'broken') { res.statusCode = 503; return res.end('{"error":{"message":"fixture failure"}}'); }
            if (req.url.endsWith('/messages')) return res.end(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant', model: b.model, content: [{ type: 'text', text: 'fixture message' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } }));
            if (req.url.endsWith('/embeddings')) return res.end(JSON.stringify({ data: b.input.map((_, index) => ({ index, embedding: [1, 2] })), usage: { prompt_tokens: 2, total_tokens: 2 } }));
            if (req.url.endsWith('/images/generations')) return res.end(JSON.stringify({ data: [{ b64_json: 'Zml4dHVyZQ==' }] }));
            res.end(JSON.stringify({ id: 'fixture', model: b.model, choices: [{ index: 0, message: { role: 'assistant', content: 'fixture answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }));
        });
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const h = await boot({ env: { AI_IMAGE_MODEL: 'image', AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_FREE_PROVIDERS: 'fixture,anthfixture', AI_FREE_MAX_OUTPUT_PRICE_USD_PER_MTOK: '5' } });
    try {
        const svc = token('exchange', ALL);
        const added = await request(h.base, 'POST', '/api/v1/providers', { tok: svc, body: {
            key: 'fixture', kind: 'openai', base_url: `http://127.0.0.1:${upstream.address().port}/v1`, auth_mode: 'none',
            capabilities: ['chat', 'complete', 'embed', 'image'], default_model: 'good', provider_access: 'OWN_DEPLOYMENT',
            metadata: { paid: false, data_policy: { training: false, retention: 'none' } },
        } });
        assert.equal(added.status, 201, added.text);
        for (const [model, type] of [['broken', 'chat'], ['good', 'chat'], ['embed', 'embedding'], ['image', 'image']]) {
            const out = await request(h.base, 'POST', '/api/v1/models', { tok: svc, body: {
                provider_key: 'fixture', model_key: model, type, status: 'active', context_window: 8192, max_output: 4096,
                supports: { streaming: true }, cost: { in_per_mtok: 0, out_per_mtok: 0, cached_per_mtok: 0 },
                metadata: { org: 'fixture', model },
            } });
            assert.equal(out.status, 201, out.text);
        }
        assert.equal((await request(h.base, 'POST', '/api/v1/providers', { tok: svc, body: {
            key: 'anthfixture', kind: 'anthropic', base_url: `http://127.0.0.1:${upstream.address().port}`, auth_mode: 'none',
            capabilities: ['chat', 'messages'], default_model: 'claude', provider_access: 'OWN_DEPLOYMENT',
        } })).status, 201);
        assert.equal((await request(h.base, 'POST', '/api/v1/models', { tok: svc, body: {
            provider_key: 'anthfixture', model_key: 'claude', type: 'chat', status: 'active', context_window: 8192,
            supports: {}, cost: { in_per_mtok: 0, out_per_mtok: 0, cached_per_mtok: 0 }, metadata: { org: 'fixture', model: 'claude' },
        } })).status, 201);
        assert.equal((await request(h.base, 'POST', '/api/v1/providers', { tok: svc, body: {
            key: 'paid-image', kind: 'openai', base_url: `http://127.0.0.1:${upstream.address().port}/v1`, auth_mode: 'none',
            capabilities: ['image'], default_model: 'paid-image', provider_access: 'OWN_DEPLOYMENT',
        } })).status, 201);
        assert.equal((await request(h.base, 'POST', '/api/v1/models', { tok: svc, body: {
            provider_key: 'paid-image', model_key: 'paid-image', type: 'image', status: 'active', supports: {},
            cost: { in_per_mtok: 1, out_per_mtok: 1 }, metadata: { org: 'fixture', model: 'paid-image' },
        } })).status, 201);
        const owner = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
        const keys = createKeys({ db: h.db });
        const key = await keys.create(owner, { name: 'fixture', monthly_cap_usd: 2, allowed_models: [] });
        const other = await keys.create('usr_01JAB2C3D4E5F6G7H8J9K0MNP1', { name: 'other', monthly_cap_usd: 2, allowed_models: [] });
        const post = (path, body, id) => request(h.base, 'POST', path, { tok: key.secret, body, headers: id ? { 'idempotency-key': id } : {} });
        const body = { model: 'fixture/broken', models: ['fixture/good'], provider: { only: ['fixture'], data_collection: 'deny', zdr: true }, usage: { include: true }, messages: [{ role: 'user', content: 'hello' }] };
        const result = await post('/v1/chat/completions', body, 'fallback-request-001');
        assert.equal(result.status, 200, result.text);
        assert.equal(result.body.model, 'good');
        assert.equal(result.body.usage.provider, 'fixture');
        assert.equal(result.body.usage.cost, 0);
        assert.equal(seen.length, 2, 'one failed attempt followed by one model fallback');
        const replay = await post('/v1/chat/completions', body, 'fallback-request-001');
        assert.equal(replay.status, 200, replay.text);
        assert.equal(seen.length, 2, 'replay never calls a provider');
        const generation = await request(h.base, 'GET', '/v1/generation?id=' + result.body.id, { tok: key.secret });
        assert.equal(generation.status, 200, generation.text);
        assert.equal(generation.body.data.provider, 'fixture');
        assert.equal((await request(h.base, 'GET', '/v1/generation?id=' + result.body.id, { tok: other.secret })).status, 404);
        const before = seen.length;
        assert.equal((await post('/v1/chat/completions', { ...body, model: 'fixture/good', models: undefined, provider: { ignore: ['fixture'] } })).status, 503);
        assert.equal(seen.length, before, 'hard routing refusal never calls upstream');
        const quality = { model: 'fixture/good', provider: { sort: 'quality' }, messages: body.messages };
        assert.equal((await post('/v1/chat/completions', quality)).status, 503, 'missing Report/Bench evidence refuses quality routing');
        await h.db.prepare(`INSERT INTO bench_evidence(kind_id,category,model,provider,rating,ci_lower,ci_upper,games,provisional,updated_at)
            VALUES('chat.reply','all','good','fixture',1400,1350,1450,20,0,?)`).run(new Date().toISOString());
        assert.equal((await post('/v1/chat/completions', quality)).status, 200, 'the event-fed rating used by Report enables quality routing');
        const presets = require('../server/exchange/compat-presets').createCompatPresets(h.db);
        await presets.put(owner, { name: 'writer', model: 'fixture/good:free', system: 'fixture system', temperature: .2 });
        const preset = await post('/v1/chat/completions', { model: '@preset/writer', messages: body.messages });
        assert.equal(preset.status, 200, preset.text);
        assert.equal(seen.at(-1).messages[0].content, 'fixture system');
        assert.equal(await presets.get('another-owner', 'writer'), null);
        const legacy = await post('/v1/completions', { model: 'fixture/good', prompt: 'hello' }, 'legacy-request-001');
        assert.equal(legacy.status, 200, legacy.text);
        assert.equal(legacy.body.object, 'text_completion');
        assert.equal(legacy.body.choices[0].text, 'fixture answer');
        const embeddings = await post('/v1/embeddings', { model: 'fixture/embed', input: ['hello', 'world'] }, 'embedding-request-001');
        assert.equal(embeddings.status, 200, embeddings.text);
        assert.deepEqual(embeddings.body.data[0].embedding, [1, 2]);
        const images = await post('/v1/images/generations', { model: 'fixture/image', prompt: 'fixture' }, 'image-request-001');
        assert.equal(images.status, 200, images.text);
        assert.equal(images.body.data[0].b64_json, 'Zml4dHVyZQ==');
        const beforePaidImage = seen.length;
        const paidImage = await post('/v1/images/generations', { model: 'fixture/paid-image', prompt: 'must not run' });
        assert.equal(paidImage.status, 503, paidImage.text);
        assert.equal(seen.length, beforePaidImage, 'paid image capacity cannot bypass missing per-image accounting');
        const msgBody = { model: 'fixture/claude', provider: { only: ['anthfixture'] }, max_tokens: 32, messages: body.messages, usage: { include: true } };
        const message = await post('/v1/messages', msgBody, 'messages-request-001');
        assert.equal(message.status, 200, message.text);
        assert.equal(message.body.usage.provider, 'anthfixture');
        const attempts = seen.length;
        for (const [path, input, idem] of [
            ['/v1/messages', msgBody, 'messages-request-001'],
            ['/v1/embeddings', { model: 'fixture/embed', input: ['hello', 'world'] }, 'embedding-request-001'],
            ['/v1/images/generations', { model: 'fixture/image', prompt: 'fixture' }, 'image-request-001'],
            ['/v1/completions', { model: 'fixture/good', prompt: 'hello' }, 'legacy-request-001'],
        ]) {
            const replayed = await post(path, input, idem);
            assert.equal(replayed.status, 200, replayed.text);
            assert.equal(replayed.headers.get('x-openvibe-replayed'), '1');
        }
        assert.equal(seen.length, attempts, 'every new endpoint replays without another provider call');
        const restricted = await keys.create(owner, { name: 'restricted', monthly_cap_usd: 1, allowed_models: ['fixture/good'] });
        const denied = await request(h.base, 'POST', '/v1/chat/completions', { tok: restricted.secret, body });
        assert.equal(denied.status, 403);
        assert.equal((await h.db.prepare('SELECT id FROM exchange_key_usage WHERE key_id = ?').all(restricted.key.id)).length, 0, 'a disallowed fallback is rejected before reserve');
        const failedKey = await keys.create(owner, { name: 'failed attempt', monthly_cap_usd: 1, allowed_models: [] });
        const failed = await request(h.base, 'POST', '/v1/chat/completions', { tok: failedKey.secret,
            body: { model: 'fixture/broken', messages: body.messages } });
        assert.equal(failed.status, 503, failed.text);
        await new Promise(resolve => setTimeout(resolve, 150));
        const failedRows = await h.db.prepare('SELECT * FROM exchange_key_usage WHERE key_id = ?').all(failedKey.key.id);
        assert.equal(failedRows[0].status, 'unresolved', 'unknown failed upstream usage retains conservative settlement');
        const rows = await h.db.prepare('SELECT * FROM exchange_key_usage WHERE key_id = ?').all(key.key.id);
        assert.equal(rows.length, 10, 'fallback and replay share one hold; other calls each have one');
        assert.ok(rows.every(row => row.status === 'settled'));
        assert.equal((await h.db.prepare('SELECT reserved FROM exchange_key_months WHERE key_id = ?').get(key.key.id)).reserved, 0);
        console.log('exchange-c2-execution: ok');
    } finally { await h.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
})().catch(err => { console.error(err); process.exitCode = 1; });
