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
