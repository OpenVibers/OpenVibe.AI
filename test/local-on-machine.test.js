'use strict';
/**
 * The host's local models answered by a Link machine (plan §AD.23 step 2, server/providers/machine-backed.js): with
 * AI_LOCAL_LLM_MACHINE the `local` provider's chat goes to that machine through Bot as its owner; the host's own server
 * answers when the machine cannot; pictures, JSON and tools stay on the host.
 */
const assert = require('assert');
const t = require('node:test');
process.env.AI_LOCAL_LLM_MACHINE_RETRY_MS = '0';   // the second ask, at once
const { machineBacked } = require('../server/providers/machine-backed');
const { boot } = require('./helpers');

const MACHINE = 'dev_01M78BBJ86HVWY7Y66DJ394GZC';
const OWNER = 'usr_01KKT9AC60KM7CRTB3WN1Z8P56';

function fakes({ fail = false, failTimes = 0 } = {}) {
    let misses = failTimes;
    const asked = [];
    const host = [];
    const machines = { chat: async (a) => { asked.push(a); if (fail || misses-- > 0) throw Object.assign(new Error('the machine did not answer: away'), { code: 'machine.failed' }); return { text: 'Paris.', model: a.model, machine: a.machine, usage: { input: 9, output: 2, cached: 0 } }; } };
    const adapter = { key: 'local', kind: 'openai', supports: () => true, chat: async (req) => { host.push(req); return { text: 'from the host', json: null, model: 'qwen2.5-1.5b-instruct', usage: { input: 1, output: 1, cached: 0 } }; }, embed: async () => ({ vectors: [] }) };
    return { asked, host, machines, adapter };
}

t.test('chat goes to the machine as its owner, with the system and the messages as text', async () => {
    const f = fakes();
    const a = machineBacked(f.adapter, { machines: f.machines, machine: MACHINE, subject: OWNER, model: 'qwen2.5:1.5b', log: { warn() {} } });
    const out = await a.chat({ system: [{ text: 'Answer briefly.' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'Capital of France?' }] }], maxTokens: 60, temperature: 0.2 });
    assert.deepStrictEqual([out.text, out.model, out.machine], ['Paris.', 'qwen2.5:1.5b', MACHINE]);
    assert.deepStrictEqual(f.asked[0].messages, [{ role: 'system', content: 'Answer briefly.' }, { role: 'user', content: 'Capital of France?' }]);
    assert.deepStrictEqual([f.asked[0].machine, f.asked[0].subject, f.asked[0].model, f.asked[0].maxTokens], [MACHINE, OWNER, 'qwen2.5:1.5b', 60]);
    assert.strictEqual(f.host.length, 0);
    assert.strictEqual(typeof a.embed, 'function', 'the rest of the adapter is the host\'s');
});

t.test('the host answers when the machine cannot, and for pictures, JSON and tools', async () => {
    const f = fakes({ fail: true });
    const warned = [];
    const a = machineBacked(f.adapter, { machines: f.machines, machine: MACHINE, subject: OWNER, model: 'qwen2.5:1.5b', log: { warn: (m) => warned.push(m) } });
    assert.strictEqual((await a.chat({ messages: [{ role: 'user', content: 'hi' }] })).text, 'from the host');
    assert.ok(warned.some((m) => /local on dev_.*away; asking again/.test(m)) && warned.some((m) => /local on dev_.*away; the host's own server answers/.test(m)), warned.join(' | '));
    assert.strictEqual(f.asked.length, 2, 'the machine is asked twice before the host');
    const g = fakes();
    const b = machineBacked(g.adapter, { machines: g.machines, machine: MACHINE, subject: OWNER, model: 'qwen2.5:1.5b' });
    for (const req of [{ image: { base64: 'x' } }, { json: { schema: {} } }, { openai: { tools: [{}] } }]) await b.chat({ messages: [{ role: 'user', content: 'x' }], ...req });
    assert.deepStrictEqual([g.asked.length, g.host.length], [0, 3]);
    // Nothing named, or a malformed id: the host's adapter as it was.
    assert.strictEqual(machineBacked(g.adapter, { machines: g.machines, machine: 'nope', subject: OWNER, model: 'm' }), g.adapter);
    assert.strictEqual(machineBacked(g.adapter, { machines: g.machines, machine: MACHINE, subject: '', model: 'm' }), g.adapter);
});

t.test('a machine that drops for a moment is asked again, and answers; the host is not used (11-18)', async () => {
    const f = fakes({ failTimes: 1 });
    const warned = [];
    const a = machineBacked(f.adapter, { machines: f.machines, machine: MACHINE, subject: OWNER, model: 'qwen2.5:1.5b', log: { warn: (m) => warned.push(m) } });
    const out = await a.chat({ messages: [{ role: 'user', content: 'Capital of France?' }] });
    assert.deepStrictEqual([out.text, out.machine, f.asked.length, f.host.length], ['Paris.', MACHINE, 2, 0]);
    assert.ok(warned.length === 1 && /asking again/.test(warned[0]), 'the miss is said once');
});

function embedFakes({ failTimes = 0, fail = false } = {}) {
    let misses = failTimes;
    const asked = [];
    const host = [];
    const vec = (t) => [t.length / 100, 0.5, -0.25];
    const machines = {
        chat: async () => ({ text: 'Paris.' }),
        embed: async (a) => { asked.push(a); if (fail || misses-- > 0) throw Object.assign(new Error('the machine did not answer: away'), { code: 'machine.failed' }); return { vectors: a.input.map(vec), model: a.model, usage: { input: a.input.length * 3, output: 0, cached: 0 } }; },
    };
    const adapter = { key: 'local', kind: 'openai', supports: () => true, chat: async () => ({ text: 'from the host' }), embed: async (req) => { host.push(req); return { vectors: req.input.map(() => [9, 9, 9]), model: req.model, usage: { input: 1, output: 0, cached: 0 } }; } };
    return { asked, host, machines, adapter };
}

t.test('embeddings go to the machine in batches of 32, in order, under the model name asked for (11-18)', async () => {
    const f = embedFakes();
    const a = machineBacked(f.adapter, { machines: f.machines, machine: MACHINE, subject: OWNER, model: 'qwen2.5:1.5b', embedModel: 'bge-small-en-v1.5:q8_0', log: { warn() {} } });
    const input = Array.from({ length: 70 }, (_, i) => 'x'.repeat(i + 1));
    const out = await a.embed({ model: 'bge-small-en-v1.5', input });
    assert.strictEqual(out.vectors.length, 70);
    assert.deepStrictEqual(out.vectors[0], [0.01, 0.5, -0.25]);
    assert.deepStrictEqual(out.vectors[69], [0.7, 0.5, -0.25], 'the order of the input is kept across batches');
    assert.deepStrictEqual(f.asked.map((x) => x.input.length), [32, 32, 6]);
    assert.deepStrictEqual([f.asked[0].machine, f.asked[0].subject, f.asked[0].model], [MACHINE, OWNER, 'bge-small-en-v1.5:q8_0']);
    assert.deepStrictEqual([out.model, out.usage.input, out.machine, f.host.length], ['bge-small-en-v1.5', 210, MACHINE, 0]);
});

t.test('an embedding the machine misses is asked again, then the host answers; no embedModel keeps the host', async () => {
    const once = embedFakes({ failTimes: 1 });
    const a = machineBacked(once.adapter, { machines: once.machines, machine: MACHINE, subject: OWNER, model: 'qwen2.5:1.5b', embedModel: 'bge-small-en-v1.5:q8_0', log: { warn() {} } });
    assert.deepStrictEqual((await a.embed({ model: 'bge-small-en-v1.5', input: ['hello'] })).vectors, [[0.05, 0.5, -0.25]]);
    assert.deepStrictEqual([once.asked.length, once.host.length], [2, 0]);
    const down = embedFakes({ fail: true });
    const warned = [];
    const b = machineBacked(down.adapter, { machines: down.machines, machine: MACHINE, subject: OWNER, model: 'qwen2.5:1.5b', embedModel: 'bge-small-en-v1.5:q8_0', log: { warn: (m) => warned.push(m) } });
    assert.deepStrictEqual((await b.embed({ model: 'bge-small-en-v1.5', input: ['hello'] })).vectors, [[9, 9, 9]]);
    assert.ok(warned.some((m) => /the host's own embedding server answers/.test(m)), warned.join(' | '));
    const plain = embedFakes();
    const c = machineBacked(plain.adapter, { machines: plain.machines, machine: MACHINE, subject: OWNER, model: 'qwen2.5:1.5b' });
    await c.embed({ model: 'bge-small-en-v1.5', input: ['hello'] });
    assert.deepStrictEqual([plain.asked.length, plain.host.length], [0, 1], 'no embedModel: the host embeds');
    // Only an embedding model named: chat stays the host's, embeddings move.
    const onlyEmbed = machineBacked(plain.adapter, { machines: plain.machines, machine: MACHINE, subject: OWNER, embedModel: 'bge-small-en-v1.5:q8_0' });
    assert.strictEqual(onlyEmbed.chat, plain.adapter.chat);
    await onlyEmbed.embed({ input: ['a'] });
    assert.strictEqual(plain.asked.length, 1);
});

t.test('Bot\'s client: an ai command { model, input }, the vectors from the ack, and a short answer refused', async () => {
    const { createMachineModels } = require('../server/machines');
    const sent = [];
    const reply = { result: 'ack', data: { model: 'bge-small-en-v1.5:q8_0', embeddings: [[0.1, 0.2], [0.3, 0.4]], usage: { prompt_tokens: 7 } } };
    const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body), subject: init.headers['X-OV-Subject'] || init.headers['x-ov-subject'] }); return { ok: true, status: 200, json: async () => reply }; };
    const m = createMachineModels({ config: { bot: { url: 'http://127.0.0.1:9' } }, env: {}, fetchImpl, tokens: { getToken: async () => 'tok' } });
    assert.strictEqual(m.enabled, true);
    const out = await m.embed({ machine: MACHINE, subject: OWNER, model: 'bge-small-en-v1.5:q8_0', input: ['a', 'b'] });
    assert.deepStrictEqual([out.vectors, out.model, out.usage.input], [[[0.1, 0.2], [0.3, 0.4]], 'bge-small-en-v1.5:q8_0', 7]);
    assert.ok(sent[0].url.endsWith(`/api/v1/machines/${MACHINE}/commands`));
    assert.deepStrictEqual([sent[0].body.kind, sent[0].body.value], ['ai', { model: 'bge-small-en-v1.5:q8_0', input: ['a', 'b'] }]);
    reply.data.embeddings = [[0.1, 0.2]];
    await assert.rejects(m.embed({ machine: MACHINE, subject: OWNER, model: 'bge-small-en-v1.5:q8_0', input: ['a', 'b'] }), /no embeddings/);
    await assert.rejects(m.embed({ machine: 'nope', subject: OWNER, model: 'x', input: ['a'] }), /dev_ machine/);
});

t.test('in AI: the local provider is machine-backed when AI_LOCAL_LLM_MACHINE is set', async () => {
    const f = fakes();
    const h = await boot({ env: { AI_LOCAL_LLM_URL: 'http://127.0.0.1:9', AI_LOCAL_LLM_MODEL: 'qwen2.5-1.5b-instruct', AI_LOCAL_LLM_MACHINE: MACHINE, AI_LOCAL_LLM_MACHINE_SUBJECT: OWNER, AI_LOCAL_LLM_MACHINE_MODEL: 'qwen2.5:1.5b' }, machineModels: f.machines });
    try {
        const entry = await h.pool.adapter('local');
        const a = entry && entry.adapter ? entry.adapter : entry;
        assert.strictEqual(a.machine, MACHINE);
        assert.strictEqual((await a.chat({ messages: [{ role: 'user', content: 'Capital of France?' }], maxTokens: 20 })).text, 'Paris.');
        assert.strictEqual(f.asked[0].subject, OWNER);
    } finally { await h.stop(); }
});
