'use strict';
// The floor's first line reads a child and a bare body (or a sex act) near each other, within MINOR_NEAR characters,
// the way the second line reads its cues near a sexual word (2026-11-15: read over a whole text, "what's up boys" in
// one minute of a stream and an adult body word in another refused 261 of 261 stream summaries in a day). Everything
// that was refused close together is still refused; a short text is read whole, as before.
const assert = require('assert');
const floor = require('../server/policy/floor');

const refused = (t) => { const r = floor.check([t]); return !r.ok && r.rule === 'minors'; };
const filler = (n) => ' and then we kept playing the next round'.repeat(Math.ceil(n / 40)).slice(0, n);

// Still refused: a child with a bare body or a sex act, close together, in a short text or the middle of a long one.
const close = ['a naked child', 'nude photos of kids', 'the kids were having sex', 'he undressed the little girl',
    'child porn', `${filler(5000)} a toddler, naked, in the video ${filler(5000)}`];
close.forEach((t) => assert.ok(refused(t), `still refused: ${t.slice(0, 60)}`));
assert.strictEqual(floor.checkRequest({ messages: [{ role: 'user', content: `${filler(3000)} nude pictures of schoolgirls ${filler(3000)}` }] }).ok, false,
    'a request with it close together, in the person\'s words');

// Not refused any more: the two far apart in a long stream's speech.
const stream = `what's up boys, welcome back to the stream${filler(1600)}that statue in the museum is completely naked, it's famous`;
assert.ok(!refused(stream), 'a child word and a body word far apart in a stream are not this line');
assert.ok(floor.checkRequest({ messages: [{ role: 'user', content: stream }] }).ok, 'a summary of that stream is asked for');
assert.ok(floor.checkResult({ text: stream }).ok, 'and answered');

// The distance: within MINOR_NEAR characters is refused, past it is not.
const at = (gap) => `the kids${' '.repeat(gap)}naked`;
assert.ok(refused(at(floor.MINOR_NEAR)), `${floor.MINOR_NEAR} characters apart is near`);
assert.ok(!refused(at(floor.MINOR_NEAR + 40)), `${floor.MINOR_NEAR + 40} characters apart is not`);

// What was never refused still is not: a body compound that is not a body, and an ordinary sentence.
assert.ok(!refused('chicken breast recipes the kids will like'), 'chicken breast');
assert.ok(!refused('the kids loved the breaststroke lesson'), 'breaststroke');
assert.ok(floor.check(['how do I kill a stuck process']).ok);
console.log(`floor-minors-near: close together still refused; far apart in a long text is not (MINOR_NEAR ${floor.MINOR_NEAR})`);
