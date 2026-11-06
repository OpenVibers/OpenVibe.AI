'use strict';
/**
 * Private AI (the plan of 2026-11-06, "Product lines and features", item 2):
 *
 *   - the privacy label comes from the facts: zero retention and no training is private, a community machine is
 *     community, an undeclared policy is anonymized, and the host's own deployment (metadata.local) is private;
 *   - the catalog offers carry that label, so the Exchange shows the same one the router uses;
 *   - a preset that asks for private and finds no offer refuses with a plain message, before any provider is
 *     called, and never falls back to an offer that keeps or trains on the prompt;
 *   - a developer key's saved "default" preset applies to requests that name none (the strict-privacy switch on
 *     a key), and a service may set and read a person's presets with on_behalf_of.
 *
 * The upstreams replay an answer; their calls are counted, so a refusal that still called one would fail.
 */
const assert = require('assert');
const http = require('http');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('exchange-private');
const service = token('exchange', [...ALL]);
const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const key = token('key', ['ai.app.run', 'ai.run.create'], { sub: 'app:app_01JAB2C3D4E5F6G7H8J9K0MNPQ', actorType: 'app', ns: [PRJ, `app.${PRJ}.*`], extra: { project_id: PRJ, env: 'production' } });
const DANA = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP1';

const upstreams = {};
const calls = (name) => upstreams[name].calls.length;

function answer(text) {
    return {
        id: 'chatcmpl-test', object: 'chat.completion', created: 1762400000, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
}

async function fakeUpstream(name) {
    const state = { calls: [], url: null };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            state.calls.push({ url: req.url, body: raw });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(answer(`${name} answered`)));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    state.url = `http://127.0.0.1:${server.address().port}`;
    state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    upstreams[name] = state;
    return state;
}

async function makeProvider({ key: k, upstream, metadata = {}, data_policy = null, cost = [0.2, 0.6] } = {}) {
    const made = await request(h.base, 'POST', '/api/v1/providers', {
        tok: service,
        body: {
            key: k, kind: 'openai', base_url: `${upstream.url}/v1`, auth_mode: 'none',
            capabilities: ['chat', 'complete', 'tools', 'json'], default_model: 'm',
            provider_access: 'OWN_DEPLOYMENT', metadata: { ...(data_policy ? { data_policy } : {}), ...metadata },
        },
    });
    assert.strictEqual(made.status, 201, made.text);
    const model = await request(h.base, 'POST', '/api/v1/models', {
        tok: service,
        body: {
            provider_key: k, model_key: 'm', type: 'chat', status: 'active', context_window: 32768, max_output: 4096,
            supports: { json: true, tools: true, streaming: true, vision: false },
            cost: { in_per_mtok: cost[0], out_per_mtok: cost[1], cached_per_mtok: cost[0] / 10, source: 'https://example.com/pricing', verified_at: '2026-11-01' },
            metadata: { org: 'acme', model: 'm', tier: 'balanced', listed: true, synced_at: '2026-11-01T00:00:00.000Z' },
        },
    });
    assert.strictEqual(model.status, 201, model.text);
}

const post = (body) => request(h.base, 'POST', '/v1/chat/completions', { tok: service, body });

let h;

t.test('boot: a provider that declares nothing, a private one, a community machine and the host’s own deployment', async () => {
    h = await boot({ env: { AI_MODEL_CATALOG: '1', AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_LOCAL_LLM_URL: '', AI_FREE_PROVIDERS: 'open,private', AI_FREE_MAX_OUTPUT_PRICE_USD_PER_MTOK: '5' } });
    for (const name of ['open', 'private', 'community']) await fakeUpstream(name);
    await makeProvider({ key: 'open', upstream: upstreams.open });
    await makeProvider({
        key: 'private', upstream: upstreams.private,
        data_policy: { trains: false, training: false, retention: 'none', trust: 'first-party' },
        cost: [0.5, 1.5],
    });
    // A community machine: a person's hardware, prepaid, which sees the prompt.
    await makeProvider({
        key: 'community', upstream: upstreams.community, cost: [0, 0],
        metadata: { community: true, paid: false },
        data_policy: { trains: null, retention: null, trust: 'community' },
    });
});

t.test('the catalog offers carry the privacy label, from the same facts the router uses', async () => {
    const res = await request(h.base, 'GET', '/api/v1/exchange/catalog', { tok: service });
    assert.strictEqual(res.status, 200, res.text);
    const offers = res.body.models.flatMap((m) => m.offers);
    const labelOf = (provider) => {
        const o = offers.find((x) => x.provider === provider);
        return o && o.privacy && o.privacy.label;
    };
    assert.strictEqual(labelOf('private'), 'private', 'zero retention and no training is private');
    const privacy = require('../server/exchange/privacy');
    assert.strictEqual(privacy.labelFor({ record: { metadata: { local: true } } }).label, 'private', 'the host’s own deployment is private');
    assert.strictEqual(labelOf('community'), 'community', 'a person’s machine is community');
    assert.strictEqual(labelOf('open'), 'anonymized', 'a provider that declares nothing is anonymized');
});

t.test('strict privacy answers from a private offer, and the community machine is never used', async () => {
    const before = { open: calls('open'), community: calls('community') };
    const r = await post({ model: 'openvibe/auto', preset: 'private', messages: [{ role: 'user', content: 'hello' }] });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.x_openvibe.provider, 'private', 'the private offer answered');
    assert.strictEqual(r.body.x_openvibe.privacy, 'private');
    assert.deepStrictEqual({ open: calls('open'), community: calls('community') }, before, 'neither the community machine nor the provider that declares nothing was called');
});

t.test('strict privacy refuses with a plain message when no private offer can answer', async () => {
    // Neither private offer runs in the EU: the strict profile has nothing to answer with, and it is refused
    // rather than answered by an offer that keeps or trains on the prompt.
    const before = { open: calls('open'), private: calls('private'), community: calls('community') };
    const r = await post({
        model: 'openvibe/auto',
        preset: { name: 'strict-eu', policy: { data_policy: 'private', community: false, region: ['eu'] } },
        messages: [{ role: 'user', content: 'a secret' }],
    });
    assert.strictEqual(r.status, 503, r.text);
    assert.strictEqual(r.body.error.code, 'policy.privacy_unavailable');
    assert.match(r.body.error.message, /Strict privacy is on/);
    assert.match(r.body.error.message, /does not fall back/);
    assert.deepStrictEqual({ open: calls('open'), private: calls('private'), community: calls('community') }, before, 'no provider was called');
});

t.test('a run names the preset by name and the router resolves the one policy', async () => {
    const r = await request(h.base, 'POST', '/api/v1/runs?wait=10000', {
        tok: service,
        body: { workflow: 'ai.complete', input: { messages: [{ role: 'user', content: 'hello' }] }, options: { preset: { name: 'private' } } },
    });
    assert.strictEqual(r.status, 201, r.text);
    const run = r.body.run;
    assert.strictEqual(run.status, 'succeeded', JSON.stringify(run.error));
    assert.strictEqual(run.provenance.provider, 'private', 'the private offer answered');
    assert.strictEqual(run.explain.privacy.label, 'private', 'the run’s own explain carries the label');
});

t.test('a developer key’s default preset is strict privacy for every request that names none', async () => {
    // With no default, the key's free run uses the community machine (the only free offer that answers a
    // long-enough answer; the host's short-text model is not offered above 800 tokens).
    const before = calls('community');
    const plain = await request(h.base, 'POST', '/v1/chat/completions', { tok: key, body: { model: 'openvibe/auto', max_tokens: 2000, messages: [{ role: 'user', content: 'hello' }] } });
    assert.strictEqual(plain.status, 200, plain.text);
    assert.strictEqual(plain.body.x_openvibe.provider, 'community');
    assert.strictEqual(plain.body.x_openvibe.privacy, 'community');

    const stored = await request(h.base, 'POST', '/api/v1/presets', {
        tok: key, body: { name: 'default', policy: { data_policy: 'private', community: false } },
    });
    assert.strictEqual(stored.status, 201, stored.text);
    assert.strictEqual(stored.body.preset.owner.type, 'project', 'a key writes its project’s preset');
    // The key now asks for nothing, and its request is refused rather than answered by the community machine.
    const r = await request(h.base, 'POST', '/v1/chat/completions', { tok: key, body: { model: 'openvibe/auto', max_tokens: 2000, messages: [{ role: 'user', content: 'hello' }] } });
    assert.strictEqual(r.status, 503, r.text);
    assert.strictEqual(r.body.error.code, 'policy.privacy_unavailable');

    // The service token has no default of its own: its requests are not made strict by the key's choice.
    const svc = await post({ model: 'openvibe/auto', messages: [{ role: 'user', content: 'hello' }] });
    assert.strictEqual(svc.status, 200, svc.text);
    assert.ok(svc.body.x_openvibe.provider, 'the service still answers');
});

t.test('a service sets and reads a person’s presets with on_behalf_of (the Exchange’s key switch)', async () => {
    const stored = await request(h.base, 'POST', '/api/v1/presets', {
        tok: service, body: { on_behalf_of: DANA, name: 'default', policy: { data_policy: 'private', community: false } },
    });
    assert.strictEqual(stored.status, 201, stored.text);
    assert.deepStrictEqual(stored.body.preset.owner, { type: 'user', id: DANA });
    const read = await request(h.base, 'GET', `/api/v1/presets?on_behalf_of=${DANA}`, { tok: service });
    assert.strictEqual(read.status, 200, read.text);
    assert.ok(read.body.presets.some((p) => p.name === 'default' && p.policy.data_policy === 'private'));
    const removed = await request(h.base, 'DELETE', '/api/v1/presets/default', { tok: service, body: { on_behalf_of: DANA } });
    assert.strictEqual(removed.status, 200, removed.text);
    assert.strictEqual(removed.body.removed, true);
});

t.test('the same switch reaches a project’s keys (a project acts as itself, not as a person)', async () => {
    const stored = await request(h.base, 'POST', '/api/v1/presets', {
        tok: service, body: { on_behalf_of: { type: 'project', id: PRJ }, name: 'default', policy: { data_policy: 'private', community: false } },
    });
    assert.strictEqual(stored.status, 201, stored.text);
    assert.deepStrictEqual(stored.body.preset.owner, { type: 'project', id: PRJ });
    const read = await request(h.base, 'GET', `/api/v1/presets?on_behalf_of=${PRJ}`, { tok: service });
    assert.strictEqual(read.status, 200, read.text);
    assert.ok(read.body.presets.some((p) => p.name === 'default' && p.scope === 'owner'));
    // A project's request that names nothing is strict from now on: the community machine is refused.
    const refused = await request(h.base, 'POST', '/v1/chat/completions', { tok: key, body: { model: 'openvibe/auto', max_tokens: 2000, messages: [{ role: 'user', content: 'hello' }] } });
    assert.strictEqual(refused.status, 503, refused.text);
    assert.strictEqual(refused.body.error.code, 'policy.privacy_unavailable');
    await request(h.base, 'DELETE', '/api/v1/presets/default', { tok: service, body: { on_behalf_of: { type: 'project', id: PRJ } } });
});

t.test('shutdown', async () => {
    await h.stop();
    for (const name of Object.keys(upstreams)) await upstreams[name].close();
});

if (require.main === module) t.run();
