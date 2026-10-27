'use strict';
// A person's own machine as their model (AI on your own machines; contracts 0.219.0 kind ai, 0.220.0 credential
// provider node):
//   - a service holding ai.credential.manage stores provider node with the machine; no key, no hint, nothing sealed;
//   - a run naming it goes to that machine through OpenVibe.Bot as the person (server/machines.js), text only, nothing
//     spent, logged under byo:<owner>:<subject>, its explain saying where it ran; never cached, never another provider;
//   - Bot's refusal (the owner's switch off) is the run's error; a picture is refused before anything is sent.
const assert = require('assert');
const { boot, request, token, suite, ALL } = require('./helpers');
const { AiError } = require('../server/util');

const t = suite('machine-credential');
const FRAN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP4';
const MACHINE = 'dev_01M5YGM39VC2RRGDQPRD6D4SHD';
const chat = token('chat', [...ALL, 'ai.credential.manage']);
const sent = [];
let refuse = false;
const machineModels = {
    enabled: true,
    async chat(args) {
        sent.push(args);
        if (refuse) throw new AiError(403, 'bot.agent_not_allowed', 'the owner has not let their AI use this computer\'s models');
        return { text: 'A lock that one thread holds at a time.', model: args.model, usage: { input: 30, output: 9, cached: 0 } };
    },
};
let h;

t.test('boot', async () => {
    h = await boot({ env: { AI_CREDENTIALS_KEY: 'cd'.repeat(32) }, machineModels });
});

t.test('store a node credential: the machine, no key', async () => {
    let r = await request(h.base, 'PUT', `/api/v1/credentials/${FRAN}`, { tok: chat, body: { provider: 'node', machine: MACHINE, api_key: 'sk-not-for-a-machine' } });
    assert.strictEqual(r.status, 422, 'no key for a machine');
    r = await request(h.base, 'PUT', `/api/v1/credentials/${FRAN}`, { tok: chat, body: { provider: 'node', models: { chat: 'llama3.1:8b' } } });
    assert.strictEqual(r.status, 422, 'a node credential names its machine');
    r = await request(h.base, 'PUT', `/api/v1/credentials/${FRAN}`, { tok: chat, body: { provider: 'node', machine: MACHINE, models: { chat: 'llama3.1:8b' } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.provider, r.body.machine, r.body.key_hint, r.body.models.chat], ['node', MACHINE, undefined, 'llama3.1:8b']);
    const { validate } = require('openvibe-contracts');
    assert.ok(validate('ai.credential@1', r.body).valid, JSON.stringify(validate('ai.credential@1', r.body).errors));
    const row = await h.db.prepare('SELECT key_enc, machine FROM subject_credentials WHERE owner = ? AND subject = ?').get('chat', FRAN);
    assert.deepStrictEqual([row.key_enc, row.machine], ['', MACHINE], 'nothing sealed');
    // Any of their machines (contracts 0.221.0), kept for another person: never "anyone".
    const OTHER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP5';
    assert.strictEqual((await request(h.base, 'PUT', `/api/v1/credentials/${OTHER}`, { tok: chat, body: { provider: 'node', machine: 'anyone', models: { chat: 'llama3.1:8b' } } })).status, 422);
    r = await request(h.base, 'PUT', `/api/v1/credentials/${OTHER}`, { tok: chat, body: { provider: 'node', machine: 'any', models: { chat: 'llama3.1:8b' } } });
    assert.deepStrictEqual([r.status, r.body.machine], [200, 'any'], r.text);
    assert.ok(validate('ai.credential@1', r.body).valid);
    assert.strictEqual((await request(h.base, 'DELETE', `/api/v1/credentials/${OTHER}`, { tok: chat })).status < 300, true);
});

t.test('a run with it goes to that machine as the person, costs nothing, and says where it ran', async () => {
    const run = async () => await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: chat, body: { workflow: 'live.viewers.line', input: { role: 'chat', user: 'what is a mutex?' }, credential: { subject: FRAN } } });
    let r = await run();
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.run.status, 'succeeded', JSON.stringify(r.body.run));
    assert.strictEqual(r.body.run.output.text, 'A lock that one thread holds at a time.');
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual([sent[0].machine, sent[0].subject, sent[0].model], [MACHINE, FRAN, 'llama3.1:8b']);
    assert.ok(sent[0].messages.some((m) => m.role === 'user' && /what is a mutex/.test(m.content)), 'the question goes to the machine');
    const reqs = await h.db.prepare('SELECT provider_key, status, cost_usd FROM requests WHERE run_id = ?').all(r.body.run.id);
    assert.deepStrictEqual(reqs.map((x) => [x.provider_key, x.status, Number(x.cost_usd)]), [[`byo:chat:${FRAN}`, 'ok', 0]]);
    r = await run();
    assert.strictEqual(sent.length, 2, 'never served from the cache');
    // The owner's switch off on Bot: the run fails with Bot's reason, and nothing else answers instead.
    refuse = true;
    r = await run();
    assert.ok(r.body.code === 'bot.agent_not_allowed' || (r.body.run && r.body.run.status === 'failed'), r.text);
    refuse = false;
});

t.test('text only: a picture is refused before anything is sent', async () => {
    const before = sent.length;
    const r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: chat, body: { workflow: 'live.viewers.line', input: { role: 'vision', user: 'what is this?', image_url: 'data:image/png;base64,iVBORw0KGgo=' }, credential: { subject: FRAN } } });
    assert.ok(r.status >= 400 || (r.body.run && r.body.run.status === 'failed'), r.text);
    assert.strictEqual(sent.length, before, 'nothing reached the machine');
});

t.test('server/machines.js: one POST to Bot as the person with a service token; Bot\'s answers become the run\'s', async () => {
    const { createMachineModels } = require('../server/machines');
    const calls = [];
    let answer = { status: 200, body: { result: 'ack', data: { model: 'llama3.1:8b', message: { role: 'assistant', content: ' Hi. ' }, usage: { prompt_tokens: 12, completion_tokens: 3 } } } };
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        if (answer === 'down') throw new Error('connect ECONNREFUSED');
        return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
    };
    const tokens = { getToken: async ({ audience }) => `svc-${audience}` };
    const off = createMachineModels({ config: { bot: { url: '' } }, env: {}, fetchImpl, tokens });
    assert.strictEqual(off.enabled, false);
    await assert.rejects(off.chat({ machine: MACHINE, subject: FRAN, model: 'm', messages: [] }), (e) => e.code === 'machine.unavailable' && e.status === 503);
    const m = createMachineModels({ config: { bot: { url: 'http://bot.test/' } }, env: {}, fetchImpl, tokens });
    assert.strictEqual(m.enabled, true);
    await assert.rejects(m.chat({ machine: 'dev_nope', subject: FRAN, model: 'm', messages: [] }), (e) => e.status === 422);
    const out = await m.chat({ machine: MACHINE, subject: FRAN, model: 'llama3.1:8b', messages: [{ role: 'user', content: 'hi' }], maxTokens: 99999, temperature: 5, timeoutMs: 1000 });
    assert.deepStrictEqual(out, { text: 'Hi.', model: 'llama3.1:8b', usage: { input: 12, output: 3, cached: 0 }, machine: MACHINE, tried: [] });
    assert.strictEqual(calls[0].url, `http://bot.test/api/v1/machines/${MACHINE}/commands`);
    assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer svc-openvibe.bot');
    assert.strictEqual(calls[0].init.headers['X-OV-Subject'], FRAN);
    const body = JSON.parse(calls[0].init.body);
    assert.deepStrictEqual([body.kind, body.value.max_tokens, body.value.temperature, body.ms], ['ai', 32768, 2, 5000], 'clamped');
    answer = { status: 403, body: { code: 'bot.agent_not_allowed', detail: 'switched off' } };
    await assert.rejects(m.chat({ machine: MACHINE, subject: FRAN, model: 'm', messages: [] }), (e) => e.status === 403 && e.code === 'bot.agent_not_allowed');
    answer = { status: 200, body: { result: 'nack', reason: 'no model server answered' } };
    await assert.rejects(m.chat({ machine: MACHINE, subject: FRAN, model: 'm', messages: [] }), (e) => e.status === 502 && e.code === 'machine.failed' && /no model server/.test(e.message));
    answer = 'down';
    await assert.rejects(m.chat({ machine: MACHINE, subject: FRAN, model: 'm', messages: [] }), (e) => e.status === 503 && e.code === 'machine.unreachable');
});

t.test('machine any (contracts 0.221.0): the fastest of the person\'s own machines that is on with the model, then the next', async () => {
    const { createMachineModels } = require('../server/machines');
    const id = (c) => `dev_01M5YGM39VC2RRGDQPRD6D4S${c}`;
    const list = [
        { id: id('AA'), online: false, ai_models: true, computer: { ai: { models: ['llama3.1:8b'], ready: true } } },
        { id: id('BB'), online: true, ai_models: true, computer: { ai: { models: ['qwen2.5:7b'], ready: true } } },
        { id: id('CC'), online: true, ai_models: true, computer: { ai: { models: ['llama3.1:8b'], ready: true }, ai_speed: { model: 'llama3.1:8b', tokens_per_s: 6 } } },
        { id: id('DD'), online: true, ai_models: true, computer: { ai: { models: ['llama3.1:8b'], ready: true }, ai_speed: { model: 'llama3.1:8b', tokens_per_s: 31 } } },
    ];
    const asked = [];
    let busy = new Set([id('DD')]);
    let listed = list;
    const fetchImpl = async (url, init = {}) => {
        if (url === 'http://bot.test/api/v1/machines') {
            assert.strictEqual(init.headers['X-OV-Subject'], FRAN, 'as the person');
            return { ok: true, status: 200, json: async () => ({ machines: listed }) };
        }
        const dev = /machines\/([^/]+)\/commands$/.exec(url)[1];
        asked.push(dev);
        const body = busy.has(dev) ? { result: 'nack', reason: 'the model is answering another request on this machine' }
            : { result: 'ack', data: { model: 'llama3.1:8b', message: { content: `from ${dev}` }, usage: { prompt_tokens: 3, completion_tokens: 2 } } };
        return { ok: true, status: 200, json: async () => body };
    };
    const m = createMachineModels({ config: { bot: { url: 'http://bot.test' } }, env: {}, fetchImpl, tokens: { getToken: async () => 'svc' } });
    const out = await m.chat({ machine: 'any', subject: FRAN, model: 'llama3.1:8b', messages: [{ role: 'user', content: 'hi' }] });
    assert.deepStrictEqual(asked, [id('DD'), id('CC')], 'the fastest first, the next when it is busy; never one that is off or lacks the model');
    assert.deepStrictEqual([out.text, out.machine, out.tried.map((x) => x.machine)], [`from ${id('CC')}`, id('CC'), [id('DD')]]);
    busy = new Set([id('DD'), id('CC')]);
    await assert.rejects(m.chat({ machine: 'any', subject: FRAN, model: 'llama3.1:8b', messages: [] }), (e) => e.status === 503 && e.code === 'machine.none' && /answered/.test(e.message));
    listed = [];
    await assert.rejects(m.chat({ machine: 'any', subject: FRAN, model: 'llama3.1:8b', messages: [] }), (e) => e.status === 503 && e.code === 'machine.none' && /is on with/.test(e.message));
    await assert.rejects(m.chat({ machine: 'anyone', subject: FRAN, model: 'm', messages: [] }), (e) => e.status === 422);
});

t.test('close', async () => { await h.close(); });

t.run();
