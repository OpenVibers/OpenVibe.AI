'use strict';
/**
 * The Exchange's routing presets, receipts, BYOK label, privacy label and hard max_price
 * (the plan of 2026-11-06, "Product lines and features", item 1).
 *
 *   - the five built-in presets are listed, and a caller stores and deletes their own;
 *   - a preset named as the model ("@preset/cheapest") or beside it (preset: "…") is applied by the router;
 *   - the rules of a preset (floor, ceiling, quantization, region, data policy, community) take the offers out,
 *     each with its reason, and the fallbacks it would have used are on the receipt;
 *   - a hard max_price that no offer fits is refused before the call, with a problem+json, and no provider is called;
 *   - every answer carries a receipt: in the headers (x-openvibe-receipt, compact) and its id, and at GET /v1/receipts/:id;
 *   - the receipt says who paid: a person's own key is BYOK at 0 %, and the privacy label of every answer.
 *
 * The upstreams replay recorded answers (test/fixtures/exchange-receipts/offers.json).
 */
const assert = require('assert');
const http = require('http');
const { boot, request, token, suite, ALL } = require('./helpers');
const offers = require('./fixtures/exchange-receipts/offers.json');

const t = suite('exchange-presets-receipts');
const service = token('live', ALL);
const keeper = token('live', [...ALL, 'ai.credential.manage']);
const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const app = token('app', ['ai.app.run'], { sub: `app:app_${PRJ.slice(4)}`, actorType: 'app', ns: [PRJ, `app.${PRJ}.*`], extra: { project_id: PRJ, env: 'production' } });
const DANA = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP1';
const KEY = 'ab'.repeat(32);

let h;
const upstreams = {};

/** A fake upstream that replays one recorded answer (and its recorded stream) and counts its calls. */
async function fakeUpstream(name) {
    const offer = offers.offers[name];
    const state = { calls: [], url: null };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
            state.calls.push({ url: req.url, body });
            if (body.stream) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                for (const frame of offer.stream) {
                    if (frame.type && frame.type !== 'message_start' && frame.type !== 'message_stop') res.write(`event: ${frame.type}\n`);
                    res.write(`data: ${JSON.stringify(frame)}\n\n`);
                }
                return res.end();
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(offer.response));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    state.url = `http://127.0.0.1:${server.address().port}`;
    state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    upstreams[name] = state;
    return state;
}

async function makeProvider(name) {
    const offer = offers.offers[name];
    const upstream = await fakeUpstream(name);
    const anthropic = offer.kind === 'anthropic';
    const made = await request(h.base, 'POST', '/api/v1/providers', {
        tok: service,
        body: {
            key: name, status: 'active', kind: offer.kind, base_url: `${upstream.url}/v1`, auth_mode: 'none',
            capabilities: anthropic ? ['chat', 'messages', 'tools', 'json'] : ['chat', 'complete', 'tools', 'json'],
            default_model: offer.model,
            provider_access: 'OWN_DEPLOYMENT', metadata: { data_policy: offer.data_policy },
        },
    });
    assert.strictEqual(made.status, 201, made.text);
    const model = await request(h.base, 'POST', '/api/v1/models', {
        tok: service,
        body: {
            provider_key: name, model_key: offer.model, type: 'chat', status: 'active',
            context_window: 32768, max_output: 4096, supports: { json: true, tools: true, streaming: true, vision: false },
            cost: { in_per_mtok: offer.price.in_per_mtok, out_per_mtok: offer.price.out_per_mtok, cached_per_mtok: offer.price.in_per_mtok / 10, source: 'https://example.com/pricing', verified_at: '2026-11-01' },
            metadata: { org: 'acme', model: offer.model, quant: offer.quant, revision: 'rev1', tier: 'balanced', listed: true, synced_at: '2026-11-01T00:00:00.000Z' },
        },
    });
    assert.strictEqual(model.status, 201, model.text);
    return upstream;
}

const post = (body, tok = service, headers = {}) => request(h.base, 'POST', '/v1/chat/completions', { tok, body, headers });
const callsOf = (name) => upstreams[name].calls.length;

/** The person's own key: answered in-process (the guarded fetch is tested elsewhere). */
const credentialFetch = async () => new Response(JSON.stringify({
    model: 'gpt-4o-mini', choices: [{ message: { role: 'assistant', content: "dana's own key" } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
}), { status: 200, headers: { 'content-type': 'application/json' } });

t.test('boot: the catalog is on, with the recorded offers', async () => {
    h = await boot({ env: { AI_MODEL_CATALOG: '1', AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_CREDENTIALS_KEY: KEY }, credentialFetch });
    for (const name of ['swift', 'crowd', 'dear', 'anthropic']) await makeProvider(name);
});

t.test('the five built-in presets are listed, and a caller stores and deletes their own', async () => {
    const list = await request(h.base, 'GET', '/api/v1/presets', { tok: service });
    assert.strictEqual(list.status, 200, list.text);
    const names = list.body.presets.filter((p) => p.builtin).map((p) => p.name);
    assert.deepStrictEqual(names.sort(), ['cheapest', 'eu-only', 'fastest', 'private', 'uncensored']);
    const made = await request(h.base, 'POST', '/api/v1/presets', { tok: service, body: { name: 'my-cheap', policy: { ceiling: 0.5, objective: 'cheapest' } } });
    assert.strictEqual(made.status, 201, made.text);
    assert.deepStrictEqual(made.body.preset.policy, { objective: 'cheapest', ceiling: 0.5 });
    assert.strictEqual(made.body.preset.scope, 'owner');
    const again = await request(h.base, 'GET', '/api/v1/presets', { tok: service });
    assert.ok(again.body.presets.some((p) => p.name === 'my-cheap' && p.policy.ceiling === 0.5));
    // A built-in name is not the caller's to write.
    const over = await request(h.base, 'POST', '/api/v1/presets', { tok: service, body: { name: 'cheapest', policy: { ceiling: 0.1 } } });
    assert.deepStrictEqual([over.status, over.body.code], [409, 'ai.preset_builtin']);
    // A policy that names a rule nobody knows is refused.
    const bad = await request(h.base, 'POST', '/api/v1/presets', { tok: service, body: { name: 'odd', policy: { objective: 'fastest-ish' } } });
    assert.strictEqual(bad.status, 422, bad.text);
    const removed = await request(h.base, 'DELETE', '/api/v1/presets/my-cheap', { tok: service });
    assert.strictEqual(removed.status, 200, removed.text);
    assert.strictEqual(removed.body.removed, true);
});

t.test('an app\'s preset belongs to its project; a person\'s to their account', async () => {
    const stored = await request(h.base, 'POST', '/api/v1/presets', { tok: app, body: { name: 'project-fast', policy: { objective: 'fastest' } } });
    assert.strictEqual(stored.status, 201, stored.text);
    assert.strictEqual(stored.body.preset.owner.type, 'project');
    assert.strictEqual(stored.body.preset.owner.id, PRJ);
    // The owners a request may look a preset up under: the project, then the person the token acts for.
    const owners = require('../server/exchange/presets').ownersOf({ kind: 'app', projectId: PRJ, onBehalfOf: DANA });
    assert.deepStrictEqual(owners.slice(0, 2), [{ type: 'project', id: PRJ }, { type: 'user', id: DANA }]);
    // The other caller's preset is not the caller's.
    const theirs = await request(h.base, 'GET', '/api/v1/presets', { tok: service });
    assert.ok(!theirs.body.presets.some((p) => p.name === 'project-fast'), 'a project\'s preset is not in a service\'s list');
    const mine = await request(h.base, 'GET', '/api/v1/presets', { tok: app });
    assert.ok(mine.body.presets.some((p) => p.name === 'project-fast'), 'and it is in the project\'s own list');
});

t.test('a preset named as the model is applied: the cheapest offer answers', async () => {
    const before = callsOf('crowd');
    const r = await post({ model: '@preset/cheapest', messages: [{ role: 'user', content: 'hello' }] });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(callsOf('crowd') > before, 'the cheapest offer answered');
    assert.strictEqual(callsOf('swift'), 0);
    // The receipt says which preset was in force.
    const receipt = await request(h.base, 'GET', `/v1/receipts/${r.headers.get('x-openvibe-receipt-id')}`, { tok: service });
    assert.strictEqual(receipt.status, 200, receipt.text);
    assert.strictEqual(receipt.body.receipt.preset.name, 'cheapest');
    assert.strictEqual(receipt.body.receipt.preset.policy.objective, 'cheapest');
});

t.test('a preset beside the model is applied too, and an unknown preset is refused', async () => {
    const r = await post({ model: 'openvibe/auto', preset: 'cheapest', messages: [{ role: 'user', content: 'hello' }] });
    assert.strictEqual(r.status, 200, r.text);
    const unknown = await post({ model: 'openvibe/auto', preset: 'no-such-preset', messages: [{ role: 'user', content: 'hello' }] });
    assert.strictEqual(unknown.status, 404, unknown.text);
    assert.strictEqual(unknown.body.error.code, 'ai.preset_not_found');
});

t.test('the rules of a preset take the offers out, each with its reason', async () => {
    // The community offer is the cheapest; a private profile must not use it.
    const community = await post({ model: 'openvibe/auto', messages: [{ role: 'user', content: 'hello' }] });
    assert.strictEqual(community.status, 200, community.text);
    assert.strictEqual(community.body.x_openvibe.provider, 'crowd', 'the cheapest offer answers by default');

    const priv = await post({ model: 'openvibe/auto', preset: 'private', messages: [{ role: 'user', content: 'hello' }] });
    assert.strictEqual(priv.status, 200, priv.text);
    assert.strictEqual(priv.body.x_openvibe.provider, 'swift', 'only the offer that keeps nothing answers');
    assert.strictEqual(priv.body.x_openvibe.privacy, 'private', 'the answer is labelled private');

    // A quantization the catalogue knows: only the community offer is q8_0.
    const quant = await post({ model: 'openvibe/auto', preset: { name: 'q8', policy: { quantization: ['q8_0'] } }, messages: [{ role: 'user', content: 'hello' }] });
    assert.strictEqual(quant.status, 200, quant.text);
    assert.strictEqual(quant.body.x_openvibe.provider, 'crowd');
    // A region: only the first-party offer runs in the EU.
    const eu = await post({ model: 'openvibe/auto', preset: 'eu-only', messages: [{ role: 'user', content: 'hello' }] });
    assert.strictEqual(eu.status, 200, eu.text);
    assert.strictEqual(eu.body.x_openvibe.provider, 'swift');
});

t.test('a hard max_price that no offer fits is refused before the call', async () => {
    const before = { swift: callsOf('swift'), crowd: callsOf('crowd'), dear: callsOf('dear') };
    const r = await post({ model: 'openvibe/auto', max_price: 0.1, messages: [{ role: 'user', content: 'hello' }] });
    assert.strictEqual(r.status, 400, r.text);
    assert.strictEqual(r.body.error.code, 'ai.max_price_exceeded');
    assert.match(r.body.error.message, /max_price/);
    assert.deepStrictEqual({ swift: callsOf('swift'), crowd: callsOf('crowd'), dear: callsOf('dear') }, before, 'no provider was called');
});

t.test('a max_price that fits keeps the expensive offer out, and the ceiling is not a refusal', async () => {
    const capped = await post({ model: 'openvibe/auto', max_price: 1, messages: [{ role: 'user', content: 'hello' }] });
    assert.strictEqual(capped.status, 200, capped.text);
    assert.strictEqual(capped.body.x_openvibe.provider, 'crowd', 'only the offer under the cap answers');
    const id = capped.headers.get('x-openvibe-receipt-id');
    const receipt = await request(h.base, 'GET', `/v1/receipts/${id}`, { tok: service });
    assert.strictEqual(receipt.status, 200, receipt.text);
    assert.ok(receipt.body.receipt.fallbacks.some((f) => f.provider === 'swift' && /over_max_price/.test(f.reason || '')), 'the offer over the cap is named with its reason');
    // A ceiling under the cheapest offer leaves nothing, and the run fails rather than breaking the cap.
    const ceil = await post({ model: 'openvibe/auto', preset: { name: 'tight', policy: { ceiling: 0.1 } }, messages: [{ role: 'user', content: 'hello' }] });
    assert.notStrictEqual(ceil.status, 200, 'the ceiling is not answered over');
});

t.test('every answer carries a receipt: the headers, the id, and GET /v1/receipts/:id', async () => {
    const r = await post({ model: 'openvibe/auto', messages: [{ role: 'user', content: 'hello' }] });
    assert.strictEqual(r.status, 200, r.text);
    const id = r.headers.get('x-openvibe-receipt-id');
    assert.match(String(id), /^rcpt_/);
    const header = r.headers.get('x-openvibe-receipt');
    assert.ok(header, 'the compact receipt is in the headers');
    const compact = JSON.parse(header);
    assert.strictEqual(compact.id, id);
    assert.strictEqual(compact.offer, 'crowd/crowd-m');
    assert.deepStrictEqual([compact.price.in, compact.price.out], [0.2, 0.6]);
    assert.deepStrictEqual([compact.tokens.in, compact.tokens.out, compact.tokens.cached], [120, 30, 40]);
    assert.strictEqual(typeof compact.latency_ms, 'number', 'ordinary runs record latency rather than null');
    assert.ok(compact.latency_ms >= 0);
    assert.strictEqual(compact.privacy, 'community', 'a community machine is labelled as one');
    assert.ok(Array.isArray(compact.fallbacks) && compact.fallbacks.length, 'the fallbacks it would have used are named');

    const full = await request(h.base, 'GET', `/v1/receipts/${id}`, { tok: service });
    assert.strictEqual(full.status, 200, full.text);
    const receipt = full.body.receipt;
    assert.strictEqual(receipt.id, id);
    assert.strictEqual(receipt.run_id, r.body.x_openvibe.run_id);
    assert.deepStrictEqual([receipt.offer.provider, receipt.offer.model], ['crowd', 'crowd-m']);
    assert.deepStrictEqual([receipt.price.in_per_mtok, receipt.price.out_per_mtok], [0.2, 0.6]);
    assert.deepStrictEqual([receipt.usage.tokens_in, receipt.usage.tokens_out, receipt.usage.tokens_cached], [120, 30, 40]);
    assert.ok(receipt.why.length, 'the receipt says why the router chose it');
    assert.ok(receipt.fallbacks.length, 'and the fallbacks it would have used');
    assert.strictEqual(receipt.privacy.label, 'community');
    assert.strictEqual(receipt.paid_by, 'openvibe_key');
    assert.strictEqual(receipt.byok, false);
    // The receipt never carries the prompt or the answer.
    assert.ok(!JSON.stringify(receipt).includes('hello'), 'the receipt keeps no prompt');
    // A receipt nobody may read is a 404, not a leak.
    const other = token('other', ['ai.run.create']);
    const hidden = await request(h.base, 'GET', `/v1/receipts/${id}`, { tok: other });
    assert.strictEqual(hidden.status, 404, hidden.text);
});

t.test('a person\'s own key is BYOK: the receipt says so, at no fee', async () => {
    const put = await request(h.base, 'PUT', `/api/v1/credentials/${DANA}`, {
        tok: keeper, body: { provider: 'openai', base_url: 'https://llm.example.com/v1', api_key: 'fake-openai-key-for-the-receipt', models: { chat: 'gpt-4o-mini' }, budget_usd_per_day: 1 },
    });
    assert.strictEqual(put.status, 200, put.text);
    const r = await request(h.base, 'POST', '/v1/chat/completions', { tok: service, body: { model: 'openvibe/auto', messages: [{ role: 'user', content: 'hello' }] }, headers: { 'x-openvibe-credential': `openai:${DANA}` } });
    assert.strictEqual(r.status, 200, r.text);
    const id = r.headers.get('x-openvibe-receipt-id');
    const receipt = await request(h.base, 'GET', `/v1/receipts/${id}`, { tok: service });
    assert.strictEqual(receipt.status, 200, receipt.text);
    const body = receipt.body.receipt;
    assert.strictEqual(body.byok, true, 'the receipt says the answer came from their own key');
    assert.strictEqual(body.paid_by, 'own_key');
    assert.strictEqual(body.fee_usd, 0, 'their own key is never charged');
    assert.strictEqual(body.fee_rate, 0);
    assert.strictEqual(body.offer.provider, 'byo:live:' + DANA);
});

t.test('the Anthropic-compatible endpoint carries the same receipt', async () => {
    const r = await request(h.base, 'POST', '/v1/messages', {
        tok: service, headers: { 'anthropic-version': '2023-06-01' },
        body: { model: 'openvibe/auto', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] },
    });
    assert.strictEqual(r.status, 200, r.text);
    const id = r.headers.get('x-openvibe-receipt-id');
    assert.match(String(id), /^rcpt_/);
    const compact = JSON.parse(r.headers.get('x-openvibe-receipt'));
    assert.strictEqual(compact.id, id);
    assert.ok(compact.privacy, 'the privacy label travels with it');
});

t.test('a streamed answer names its receipt in the headers and carries it in the last chunk', async () => {
    const res = await fetch(`${h.base}/v1/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openvibe/auto', stream: true, messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.strictEqual(res.status, 200);
    const id = res.headers.get('x-openvibe-receipt-id');
    assert.match(String(id), /^rcpt_/);
    const text = await res.text();
    const chunks = text.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => b.slice(6)).filter((b) => b !== '[DONE]').map((b) => JSON.parse(b));
    const last = chunks[chunks.length - 1];
    assert.ok(last.receipt, 'the last chunk carries the receipt');
    assert.strictEqual(last.receipt.id, id);
    const full = await request(h.base, 'GET', `/v1/receipts/${id}`, { tok: service });
    assert.strictEqual(typeof full.body.receipt.latency_ms, 'number');
    assert.strictEqual(typeof full.body.receipt.ttft_ms, 'number', 'the first content delta is timed at the run boundary');
    assert.ok(full.body.receipt.ttft_ms <= full.body.receipt.latency_ms);
});

t.test('a preset is refused when nobody has it, and the receipt route needs a token', async () => {
    const none = await request(h.base, 'GET', '/v1/receipts/rcpt_nope', { tok: service });
    assert.strictEqual(none.status, 404, none.text);
    const anon = await request(h.base, 'GET', '/v1/receipts/rcpt_nope');
    assert.strictEqual(anon.status, 401, anon.text);
});

t.test('shutdown', async () => {
    await h.stop();
    for (const name of Object.keys(upstreams)) await upstreams[name].close();
});

if (require.main === module) t.run();
