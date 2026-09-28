'use strict';
// live.moments.pick moved from a prompt Live rendered to a versioned template (roadmap WS-O task 2): the prepare
// hook formats the timeline, transcript and sounds as [m:ss] lines like Live did, names clip and chat signals, adds the
// flavor hint, and writes the "already used" line only when there is something to avoid; nothing to work from is no
// run; the postprocess reads the model's JSON and refuses anything without a time.
const assert = require('assert');
const { suite } = require('./helpers');
const { PREPARE, POSTPROCESS } = require('../server/workflows/hooks');
const { render } = require('../server/templates');
const live = require('../server/workflows/live');

const t = suite('moments-template');
const tpl = (live.templates || []).find((x) => x.key === 'live.moments.pick');

t.test('the prompt renders as Live rendered it', () => {
    assert.ok(tpl, 'the template exists');
    const prep = PREPARE['live.moments.pick']({ title: 'Rust night', flavor: 'clip', timeline: [{ t: 95, text: 'streamer   jumps up' }], transcript: [{ t: 94, text: 'IT COMPILES' }], sounds: [{ t: 96, label: 'Cheering' }], clipped: [95, 3605], spikes: [96], avoid: [300, 60] });
    const out = render(tpl.user_prompt, prep.vars);
    assert.match(out, /titled "Rust night"/);
    assert.match(out, /TIMELINE:\n\[1:35\] streamer jumps up/);
    assert.match(out, /TRANSCRIPT:\n\[1:34\] IT COMPILES/);
    assert.match(out, /\[1:36\] Cheering/);
    assert.match(out, /CLIPPED these timestamps .*: 1:35, 60:05/);
    assert.match(out, /25-SECOND VIDEO CLIP/);
    assert.match(out, /ALREADY USED .*: 1:00, 5:00\. Find a DIFFERENT moment\./);
    const none = render(tpl.user_prompt, PREPARE['live.moments.pick']({ title: 'x', timeline: [{ t: 1, text: 'a' }] }).vars);
    assert.ok(!/ALREADY USED/.test(none), 'no avoid line without anything to avoid');
    assert.match(none, /SCREENSHOT paste/, 'paste is the default flavor');
    assert.match(none, /TRANSCRIPT:\n\(none\)/);
    assert.deepStrictEqual(PREPARE['live.moments.pick']({ title: 'x' }), { output: null }, 'nothing to work from: no run');
});

t.test('the answer is read like Live read it', () => {
    const post = POSTPROCESS['live.moments.pick'];
    assert.deepStrictEqual(post({ text: 'Sure! {"t": 95.7, "title": "\\"It Compiles\\"", "desc": "He  jumps."}' }), { t: 95, title: 'It Compiles', desc: 'He jumps.' });
    assert.strictEqual(post({ text: '{"title": "no time"}' }), null);
    assert.strictEqual(post({ text: 'no json at all' }), null);
});

t.run();
