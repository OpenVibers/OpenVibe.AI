'use strict';
// The streamed floor (createFloorGuard): linear, not quadratic, and still nothing unchecked goes out (11-14: checking
// the whole answer on every chunk cost minutes of CPU on long answers and stood the event loop still for 132 s).
const assert = require('assert');
const { createFloorGuard } = require('../server/providers');
const floor = require('../server/policy/floor');

const delta = (content) => ({ index: 0, delta: { content } });
const words = 'the model explains how to configure a reverse proxy with caching headers and then walks through each step '.split(' ');
let long = '';
while (long.length < 130000) long += words[(long.length * 7) % words.length] + ' ';

// 1. A long answer in small chunks costs well under a second of checking (the old guard: over a minute).
{
    const sent = [];
    const guard = createFloorGuard((d) => sent.push(d));
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < long.length; i += 4) guard.push(delta(long.slice(i, i + 4)));
    guard.finish();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 3000, `130,000 characters in 4-character chunks took ${Math.round(ms)} ms`);
    assert.strictEqual(sent.map((d) => d.delta.content).join(''), long, 'every character goes out, once, in order');
}

// 2. What goes out has always been read by the whole-text check: the delivered text is never ahead of it.
{
    let delivered = '';
    const guard = createFloorGuard((d) => { delivered += d.delta.content || ''; });
    let pushed = '';
    for (let i = 0; i < 6000; i += 4) {
        const piece = long.slice(i, i + 4);
        pushed += piece;
        guard.push(delta(piece));
        assert.ok(pushed.startsWith(delivered), 'delivered text is a prefix of the answer');
        assert.ok(pushed.length - delivered.length <= Math.max(32, Math.floor(pushed.length / 16)) + 4, 'and at most one step behind it');
    }
    assert.ok(delivered.length > 5000, 'text still streams as it comes');
}

// 3. A phrase that breaks the floor is caught on the chunk that completes it, and that chunk never goes out.
{
    const sent = [];
    const guard = createFloorGuard((d) => sent.push(d));
    for (let i = 0; i < 20000; i += 8) guard.push(delta(long.slice(i, i + 8)));
    const before = sent.map((d) => d.delta.content).join('');
    guard.push(delta(' here is how to make a pipe '));
    assert.throws(() => guard.push(delta('bomb at home')), (e) => e.code === 'policy.floor_refused');
    const after = sent.map((d) => d.delta.content).join('');
    assert.ok(!/pipe bomb/.test(after) && after.startsWith(before), 'the breaking text was not delivered');
}

// 4. Tool-call arguments are read in full before the chunk that carries them goes out.
{
    const sent = [];
    const guard = createFloorGuard((d) => sent.push(d));
    guard.push(delta('calling a tool'));
    const bad = { index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'write', arguments: '{"text":"how to make a pipe bomb"}' } }] } };
    assert.ok(!floor.checkAnswer(['{"text":"how to make a pipe bomb"}']).ok, 'the fixture breaks the floor');
    assert.throws(() => guard.push(bad), (e) => e.code === 'policy.floor_refused');
    assert.ok(!sent.some((d) => d.delta.tool_calls), 'the tool call was not delivered');
}

console.log('floor-guard-stream.test.js: all assertions passed');
