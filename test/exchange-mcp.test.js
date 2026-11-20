'use strict';
// The Exchange MCP server (the design's "For builders", item 7): list live models, run a completion on the person's
// own account, read their usage, and refuse a call without a token (or with a token the Exchange refuses) before it
// can spend anything. The transport is a local fake Exchange; no test reaches the network.
const assert = require('assert');
const http = require('node:http');
const { suite } = require('./helpers');
const { createExchangeMcp } = require('../server/mcp/exchange');

const t = suite('exchange-mcp');
const TOKEN = 'ovk_test_person_token_0123456789';
const PERSON = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1';

function fakeExchange() {
    const calls = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            let body = null;
            try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
            calls.push({ method: req.method, url: req.url, headers: req.headers, body });
            const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
            if (req.url.startsWith('/api/v1/exchange/catalog')) {
                return send(200, {
                    generated_at: '2026-11-07T12:00:00Z', window_days: 7, count: 1, free_available: true,
                    models: [{
                        slug: 'deepseek/deepseek-flash', name: 'DeepSeek Flash', family: 'DeepSeek', kind: 'chat',
                        uncensored: false, context: 128000, free_now: true,
                        offers: [{ provider: 'deepseek', model: 'deepseek-chat', status: 'up', trust: 'first-party',
                            price: { in: 0.14, out: 0.42, cached: 0.014, per: '1M tokens', currency: 'USD' },
                            speed: { p50_ms: 320, p95_ms: 900 }, uptime: 0.997, requests_7d: 1200, free_tier: true,
                            privacy: { label: 'private' } }],
                    }],
                });
            }
            if (req.url.startsWith('/v1/chat/completions')) {
                if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { detail: 'bad token' });
                return send(200, {
                    id: 'chatcmpl_1', object: 'chat.completion', model: body.model,
                    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from the Exchange' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 4, completion_tokens: 3 },
                    x_openvibe: { run_id: 'run_1', cost_usd: 0, receipt_id: 'rcpt_1' },
                });
            }
            if (req.url === '/v1/search') {
                if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { detail: 'bad token' });
                return send(200, {
                    results: [
                        { title: 'Museum hours', url: 'https://museum.example/hours', snippet: 'Open 10-18', excerpt: 'The museum opens at 10:00 every day.', engines: ['brave', 'exa'], engine: 'brave', score: 0.03 },
                        { title: 'Visit', url: 'https://city.example/visit', snippet: 'Plan a visit', engines: ['brave'], engine: 'brave', score: 0.01 },
                    ],
                    answer: { text: 'It opens at 10:00 [1].', citations: [{ n: 1, title: 'Museum hours', url: 'https://museum.example/hours' }] },
                    queries: { asked: [body.q], variants: [], follow_ups: [], sites: [] },
                    receipt: { id: 'rcpt_s1', engine: 'multi', depth: body.depth, output: body.output, cost_usd: 0.0009, time_ms: 1800, engines: ['brave', 'exa'], found: 14, duplicates_removed: 5,
                        calls: [{ engine: 'brave', status: 'ok' }, { engine: 'exa', status: 'ok' }, { engine: 'tavily', status: 'skipped', reason: 'budget' }] },
                });
            }
            if (req.url === '/v1/fetch') {
                if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { detail: 'bad token' });
                return send(200, { url: body.url, text: 'x'.repeat(70000), receipt: { id: 'rcpt_f1', cost_usd: 0 } });
            }
            if (req.url.startsWith('/api/v1/exchange/me/usage')) {
                if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { detail: 'bad token' });
                return send(200, { requester: `user:${PERSON}`, usage: [{ day: '2026-11-07', requests: 2, tokens_in: 10, tokens_out: 5, cost_usd: 0.000004 }] });
            }
            return send(404, { detail: 'not found' });
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
        });
    });
}

let fake;
let mcp;
const call = (id, name, args) => mcp.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

t.test('initialize and tools/list', async () => {
    fake = await fakeExchange();
    mcp = createExchangeMcp({ token: TOKEN, baseUrl: fake.url });
    const init = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } } });
    assert.strictEqual(init.result.protocolVersion, '2024-11-05');
    assert.strictEqual(init.result.serverInfo.name, 'openvibe-exchange');
    const list = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepStrictEqual(list.result.tools.map((x) => x.name).sort(), ['exchange_chat', 'exchange_fetch', 'exchange_models', 'exchange_search', 'exchange_usage']);
    assert.strictEqual(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.strictEqual((await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'nope' })).error.code, -32601);
});

t.test('models: live prices, speed and uptime, without a token', async () => {
    const before = fake.calls.length;
    const out = await call(4, 'exchange_models', { query: 'deepseek' });
    assert.ok(!out.result.isError, JSON.stringify(out));
    const data = JSON.parse(out.result.content[0].text);
    assert.strictEqual(data.models.length, 1);
    const offer = data.models[0].offers[0];
    assert.deepStrictEqual(offer.price, { in: 0.14, out: 0.42, cached: 0.014, per: '1M tokens' });
    assert.deepStrictEqual(offer.speed, { p50_ms: 320, p95_ms: 900 });
    assert.strictEqual(offer.uptime, 0.997);
    assert.strictEqual(fake.calls.length, before + 1);
    assert.strictEqual(fake.calls[before].headers.authorization, `Bearer ${TOKEN}`, 'the token rides along when there is one');
    const anonCatalog = await createExchangeMcp({ token: '', baseUrl: fake.url }).handle({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'exchange_models', arguments: {} } });
    assert.ok(!anonCatalog.result.isError, 'the public catalog answers without a token too');
});

t.test('chat: the person\'s allowance, or their own stored provider key, with their token', async () => {
    const before = fake.calls.length;
    const out = await call(5, 'exchange_chat', { model: 'openvibe/auto', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32, credential: 'deepseek' });
    assert.ok(!out.result.isError, JSON.stringify(out));
    const answer = JSON.parse(out.result.content[0].text);
    assert.strictEqual(answer.choices[0].message.content, 'Hello from the Exchange');
    assert.strictEqual(answer.x_openvibe.run_id, 'run_1');
    const sent = fake.calls[before];
    assert.strictEqual(sent.url, '/v1/chat/completions');
    assert.strictEqual(sent.method, 'POST');
    assert.strictEqual(sent.headers.authorization, `Bearer ${TOKEN}`);
    assert.strictEqual(sent.headers['x-openvibe-credential'], 'deepseek');
    assert.deepStrictEqual(sent.body, { model: 'openvibe/auto', messages: [{ role: 'user', content: 'hi' }], stream: false, max_tokens: 32 });
});

t.test('usage: the person\'s own rows', async () => {
    const out = await call(6, 'exchange_usage', { days: 7 });
    assert.ok(!out.result.isError, JSON.stringify(out));
    const data = JSON.parse(out.result.content[0].text);
    assert.strictEqual(data.requester, `user:${PERSON}`);
    assert.strictEqual(data.usage[0].requests, 2);
    const sent = fake.calls[fake.calls.length - 1];
    assert.match(sent.url, /^\/api\/v1\/exchange\/me\/usage\?days=7$/);
    assert.strictEqual(sent.headers.authorization, `Bearer ${TOKEN}`);
});

t.test('auth refusal: no token is refused before any request; a 401 is refused back', async () => {
    const anon = createExchangeMcp({ token: '', baseUrl: fake.url });
    const before = fake.calls.length;
    const noToken = await anon.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'exchange_chat', arguments: { model: 'openvibe', messages: [{ role: 'user', content: 'hi' }] } } });
    assert.strictEqual(noToken.result.isError, true);
    assert.match(noToken.result.content[0].text, /not signed in/);
    assert.strictEqual(fake.calls.length, before, 'nothing was attempted');

    const wrong = createExchangeMcp({ token: 'ovk_wrong', baseUrl: fake.url });
    const refused = await wrong.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'exchange_chat', arguments: { model: 'openvibe', messages: [{ role: 'user', content: 'hi' }] } } });
    assert.strictEqual(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /refused the token \(401\)/);
    assert.ok(!refused.result.content[0].text.includes('ovk_wrong'), 'the token is never echoed');
});

t.test('an invalid tool argument is refused, not sent', async () => {
    const before = fake.calls.length;
    const out = await call(9, 'exchange_chat', { model: 'openvibe', messages: [] });
    assert.strictEqual(out.result.isError, true);
    assert.match(out.result.content[0].text, /messages/);
    assert.strictEqual(fake.calls.length, before);
});

t.test('search: a depth and an answer, merged results with their passages, and what was left out', async () => {
    const before = fake.calls.length;
    const out = await call(10, 'exchange_search', { q: 'tile museum hours', depth: 'standard', output: 'answer', include_domains: ['museum.example'], from: '2026-01-01', max_cost_usd: 0.01 });
    assert.ok(!out.result.isError, JSON.stringify(out));
    const data = JSON.parse(out.result.content[0].text);
    assert.strictEqual(data.answer.text, 'It opens at 10:00 [1].');
    assert.deepStrictEqual(data.results[0], { n: 1, title: 'Museum hours', url: 'https://museum.example/hours', snippet: 'Open 10-18', passage: 'The museum opens at 10:00 every day.', engines: ['brave', 'exa'] });
    assert.strictEqual(data.results[1].engines, undefined, 'one engine is not an agreement');
    assert.strictEqual(data.receipt.duplicates_removed, 5);
    assert.deepStrictEqual(data.receipt.missed, [{ engine: 'tavily', status: 'skipped', reason: 'budget' }]);
    const sent = fake.calls[before];
    assert.strictEqual(sent.url, '/v1/search');
    assert.strictEqual(sent.headers.authorization, `Bearer ${TOKEN}`);
    assert.deepStrictEqual(sent.body, { q: 'tile museum hours', depth: 'standard', output: 'answer', include_domains: ['museum.example'], from: '2026-01-01', max_cost_usd: 0.01 });
});

t.test('search: the default depth is fast, and bad input costs nothing', async () => {
    const before = fake.calls.length;
    const ok = await call(11, 'exchange_search', { queries: ['a', 'b'] });
    assert.ok(!ok.result.isError, JSON.stringify(ok));
    assert.deepStrictEqual(fake.calls[before].body, { queries: ['a', 'b'], depth: 'fast' });
    for (const [args, re] of [
        [{}, /needs q/],
        [{ q: 'x', depth: 'deeper' }, /depth is/],
        [{ q: 'x', output: 'structured' }, /schema/],
        [{ q: 'x', queries: ['1', '2', '3', '4', '5', '6'] }, /at most 5/],
        [{ q: 'x', from: '20 Nov' }, /YYYY-MM-DD/],
        [{ q: 'x', limit: 99 }, /limit/],
    ]) {
        const bad = await call(12, 'exchange_search', args);
        assert.strictEqual(bad.result.isError, true, JSON.stringify(args));
        assert.match(bad.result.content[0].text, re);
    }
    assert.strictEqual(fake.calls.length, before + 1, 'only the good call was sent');
});

t.test('fetch: https only, text cut for the model, the receipt kept', async () => {
    const out = await call(13, 'exchange_fetch', { url: 'https://museum.example/hours' });
    assert.ok(!out.result.isError, JSON.stringify(out));
    const data = JSON.parse(out.result.content[0].text);
    assert.strictEqual(data.text.length, 60000);
    assert.strictEqual(data.cut, true);
    assert.strictEqual(data.receipt.id, 'rcpt_f1');
    const before = fake.calls.length;
    const bad = await call(14, 'exchange_fetch', { url: 'http://museum.example/' });
    assert.strictEqual(bad.result.isError, true);
    assert.strictEqual(fake.calls.length, before);
});

t.test('stop', async () => { await fake.close(); });

t.run();
