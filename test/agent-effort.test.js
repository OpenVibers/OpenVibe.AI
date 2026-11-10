'use strict';
const assert = require('assert');
const { suite, boot, request, token, ALL } = require('./helpers');
const { createOpenAiProvider } = require('../server/providers/openai');
const { createAnthropicProvider } = require('../server/providers/anthropic');
const { createGeminiProvider } = require('../server/providers/gemini');
const { createDefaults, resolve } = require('../server/effort/defaults');
const { createAnalytics } = require('../server/effort/analytics');
const { createReceipts } = require('../server/exchange/receipts');
const cases = require('./fixtures/effort/requests.json');
const t = suite('agent-effort');
const factories = { openai: createOpenAiProvider, anthropic: createAnthropicProvider, gemini: createGeminiProvider, responses: require('../server/providers/responses').createResponsesProvider };
const answer = { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 }, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], candidates: [{ content: { parts: [{ text: 'ok' }] } }] };

t.test('native request fixtures cover chat and compatible routes without network calls', async () => {
    for (const c of cases) for (const op of c.kind === 'openai' ? ['chat', 'complete'] : c.kind === 'anthropic' ? ['chat', 'messages'] : ['chat']) {
        let sent;
        const adapter = factories[c.kind]({ key: c.provider, base_url: 'https://fixture.invalid/v1' }, { fetchImpl: async (_url, opts) => { sent = JSON.parse(opts.body); return new Response(JSON.stringify(answer), { status: 200 }); } });
        const result = await adapter[op]({ model: c.model, effort: c.effort, system: [], messages: [{ role: 'user', content: 'hello' }], openai: { messages: [{ role: 'user', content: 'hello' }] }, maxTokens: 128 });
        for (const [key, value] of Object.entries(c.fields)) {
            if (key === 'generationConfig') assert.deepStrictEqual(sent[key].thinkingConfig, value.thinkingConfig);
            else assert.deepStrictEqual(sent[key], value, `${c.provider}/${op}/${key}`);
        }
        if (c.applied === null) for (const k of ['effort', 'reasoning_effort', 'thinking', 'enable_thinking', 'thinking_budget']) assert.ok(!(k in sent), k);
        assert.strictEqual(result.effortApplied, c.applied, `${c.provider}/${op} receipt`);
    }
});
t.test('role choice order uses eligible models and preserves explicit model pins', async () => {
    let seen;
    const wrapped = require('../server/effort/pool').wrapPool({
        offers: async () => [{ provider: 'openai', model: 'gpt-5.5' }],
        execute: async (_route, _op, req, ctx) => { seen = { req, ctx }; return { result: { effortApplied: req.effort } }; },
    });
    const ctx = { effortPolicy: { effort_resolved: 'high', role_default: { choice_order: ['deepseek/unavailable', 'openai/gpt-5.5'] } } };
    await wrapped.execute({}, 'complete', {}, ctx);
    assert.strictEqual(seen.ctx.exact.id, 'openai/gpt-5.5');
    assert.strictEqual(seen.req.effort, 'high');
    await wrapped.execute({}, 'complete', {}, { ...ctx, exact: { id: 'caller/model' } });
    assert.strictEqual(seen.ctx.exact.id, 'caller/model');
    await assert.rejects(() => wrapped.execute({}, 'chat', {}, { effortPolicy: { effort_resolved: 'low', role_default: { model: 'other/no-model' } } }), /no model/);
});
t.test('streamed OpenAI and Anthropic calls carry the same effort controls', async () => {
    for (const kind of ['openai', 'anthropic']) {
        let sent;
        const text = kind === 'openai'
            ? 'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n'
            : 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":2}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"ok"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
        const a = factories[kind]({ key: kind }, { fetchImpl: async (_url, opts) => { sent = JSON.parse(opts.body); return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } }); } });
        const result = await a[kind === 'openai' ? 'complete' : 'messages']({ model: kind === 'openai' ? 'gpt-5.5' : 'claude-sonnet-5-5', effort: 'high', messages: [{ role: 'user', content: 'hi' }], openai: { messages: [{ role: 'user', content: 'hi' }] }, maxTokens: 128, timeoutMs: 3000, onDelta: () => {} });
        assert.strictEqual(sent.stream, true);
        assert.strictEqual(kind === 'openai' ? sent.reasoning_effort : sent.output_config.effort, 'high');
        assert.strictEqual(result.effortApplied, 'high');
    }
});
t.test('adaptive Claude rejects legacy thinking budgets before fetch', async () => {
    const adapter = createAnthropicProvider({ key: 'anthropic' }, { fetchImpl: () => { throw new Error('must not fetch'); } });
    await assert.rejects(() => adapter.messages({ model: 'claude-opus-5-5', effort: 'high', messages: [], thinking: { type: 'enabled', budget_tokens: 1000 } }), /budget_tokens is refused/);
});
t.test('routes retain requested effort and ladder; invalid effort never creates a run', async () => {
    const h = await boot();
    const tok = token('live', ALL);
    try {
        for (const [path, input] of [
            ['/api/v1/generate', { prompt: 'hello' }],
            ['/api/v1/chat', { messages: [{ role: 'user', content: 'hello' }] }],
            ['/v1/chat/completions', { messages: [{ role: 'user', content: 'hello' }] }],
            ['/v1/messages', { messages: [{ role: 'user', content: 'hello' }], max_tokens: 64 }],
        ]) {
            const res = await request(h.base, 'POST', path, { tok, body: { ...input, effort: 'high', ladder_id: 'test-ladder', rung: 2, kind: 'codes.ticket' } });
            assert.ok([200, 201].includes(res.status), `${path}: ${res.status} ${res.text}`);
            const row = await h.db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT 1').get();
            const policy = JSON.parse(row.options).effort_policy;
            assert.strictEqual(policy.effort_requested, 'high');
            const receipt = await createReceipts({ db: h.db }).forRun(row.id);
            assert.strictEqual(receipt.effort_applied, null, 'stub ignores effort');
            assert.strictEqual(receipt.effort_rung, 2);
            assert.strictEqual(receipt.kind, 'codes.ticket');
        }
        const totals = await request(h.base, 'GET', '/api/v1/me/ladders/test-ladder', { tok });
        assert.strictEqual(totals.status, 200, totals.text);
        assert.strictEqual(totals.body.rungs[0].n, 4);
        assert.strictEqual((await request(h.base, 'GET', '/api/v1/me/ladders/test-ladder', { tok: token('other', ALL) })).status, 404);
        assert.strictEqual((await request(h.base, 'POST', '/api/v1/generate', { tok, body: { prompt: 'hello', effort: 'huge' } })).status, 422);
        assert.strictEqual((await request(h.base, 'POST', '/v1/messages', { tok, body: { model: 'claude-sonnet-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], thinking: { budget_tokens: 1000 } } })).status, 400);
    } finally { await h.stop(); }
});
t.test('owner role policy is audited; reviewer stays in a different family; auto reads defaults', async () => {
    const h = await boot();
    try {
        const initial = await createDefaults({ db: h.db, registry: h.registry }).get();
        assert.strictEqual(initial.worker.model, 'deepseek/deepseek-flash');
        assert.strictEqual(initial.worker.model, `deepseek/${(await h.registry.getProvider('deepseek')).default_model}`, 'worker default matches the seeded provider even while it is disabled');
        const admin = token('network', ['ai.config.manage']);
        assert.strictEqual((await request(h.base, 'GET', '/api/v1/agent-role-defaults', { tok: token('live', ALL) })).status, 403);
        const put = await request(h.base, 'PUT', '/api/v1/agent-role-defaults/worker', { tok: admin, body: { model: 'anthropic/claude-opus-5-5', effort: 'high' } });
        assert.strictEqual(put.status, 200, put.text);
        const defs = createDefaults({ db: h.db, registry: h.registry });
        const roles = await defs.get();
        assert.strictEqual(roles.reviewer.model, 'openai/gpt-5.5');
        assert.strictEqual((await resolve({ effort: 'auto', agent_role: 'worker' }, {}, defs)).effort_resolved, 'high');
        assert.strictEqual((await resolve({ effort: 'auto' }, { metadata: { effort: 'low' } }, defs)).effort_resolved, 'low');
        const defaultsValue = require('../server/choices').defaultValue({ signed_out: { model: 'openvibe/auto', source: 'openvibe' }, signed_in: { model: 'openvibe/auto', source: 'openvibe' }, effort: 'low' });
        await h.db.prepare('INSERT INTO ai_task_defaults (task, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(task) DO UPDATE SET value = excluded.value').run('design.icon', JSON.stringify(defaultsValue), 'test', new Date().toISOString());
        const created = await h.runs.create({ task: 'design.icon', input: { messages: [{ role: 'user', content: 'Draw an icon' }] }, effort: 'auto' }, { sub: 'svc:live', subject: { type: 'service', id: 'live' } });
        await created.promise;
        const saved = await h.db.prepare('SELECT options FROM runs WHERE id = ?').get(created.run.id);
        assert.strictEqual(JSON.parse(saved.options).effort_policy.effort_resolved, 'low');
        const audits = await h.registry.listAudit({ action: 'agent.role-default.update' });
        assert.strictEqual(audits.length, 1);
        const invalid = await request(h.base, 'PUT', '/api/v1/agent-role-defaults/reviewer', { tok: admin, body: { model: 'anthropic/claude-sonnet-5-5', effort: 'high' } });
        assert.strictEqual(invalid.status, 422, invalid.text);
        assert.strictEqual((await h.registry.listAudit({ action: 'agent.role-default.update' })).length, 1);
    } finally { await h.stop(); }
});
t.test('estimate has a 20-receipt floor, current prices, token scaling, kind and date filters', async () => {
    const h = await boot();
    try {
        const created = await h.runs.create({ workflow: 'ai.generate', input: { prompt: 'sample' }, effort: 'high' }, { sub: 'svc:live', subject: { type: 'service', id: 'live' }, caps: new Set(ALL) });
        await created.promise;
        const row = await h.db.prepare('SELECT * FROM runs WHERE id = ?').get(created.run.id);
        await h.db.prepare("UPDATE runs SET synthetic = 0, status = 'succeeded' WHERE id = ?").run(row.id);
        const receipts = createReceipts({ db: h.db });
        let now = Date.now();
        const clock = { now: () => now };
        const catalog = { models: async () => ({ models: [{ slug: 'openai/gpt-5.5', offers: [{ provider: 'openai', model: 'gpt-5.5', price: { in: 2, out: 8, cached: 1 } }] }] }) };
        const analytics = createAnalytics({ db: h.db, catalog, clock });
        const q = { model: 'gpt-5.5', effort: 'high', kind: 'codes.ticket', input_tokens: '200' };
        const existing = await receipts.forRun(row.id);
        if (existing) await h.db.prepare('DELETE FROM ai_receipts WHERE id = ?').run(existing.id);
        for (let i = 0; i < 20; i++) {
            const id = `run_estimate_${i}`;
            await h.db.prepare('INSERT INTO runs SELECT (jsonb_populate_record(NULL::runs, ?::jsonb)).*').run(JSON.stringify({ ...row, id, synthetic: 0, status: 'succeeded', idempotency_key: null, receipt_id: null }));
            await receipts.record({ id: `rcpt_sample_${i}`, run_id: id, created_at: new Date(now).toISOString(), offer: { provider: 'openai', model: 'gpt-5.5' }, effort_applied: 'high', kind: 'codes.ticket', usage: { tokens_in: 100, tokens_out: 20, tokens_reasoning: 10, tokens_cached: 50 }, cost_usd: 99 });
            if (i === 18) { const result = await analytics.estimate(q); assert.strictEqual(result.n, 19); assert.strictEqual(result.low_usd, null); now += 31000; }
        }
        const result = await analytics.estimate(q);
        assert.strictEqual(result.n, 20);
        assert.strictEqual(result.low_usd, 0.00078);
        assert.strictEqual(result.high_usd, 0.00078);
        assert.strictEqual((await analytics.estimate({ ...q, kind: 'other' })).n, 0);
        now += 31 * 86400000;
        assert.strictEqual((await analytics.estimate(q)).n, 0);
        const qrow = await h.db.prepare("SELECT id FROM requests WHERE run_id = ? AND status = 'ok' LIMIT 1").get(row.id);
        assert.ok(qrow);
        await h.db.prepare('UPDATE requests SET tokens_in = 100, tokens_cached = 25 WHERE id = ?').run(qrow.id);
        const shares = await require('../server/effort/analytics').cacheShares(h.db, { now: () => Date.now() });
        assert.strictEqual(shares.get(`${row.provider_key}/${row.model_key}`), 0.25);
        const publicResult = await request(h.base, 'GET', '/api/v1/exchange/estimate?model=gpt-5.5&effort=high');
        assert.strictEqual(publicResult.status, 200, publicResult.text);
        assert.ok(publicResult.headers.get('cache-control').includes('public'));
    } finally { await h.stop(); }
});
t.run();
