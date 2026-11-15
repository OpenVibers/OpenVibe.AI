'use strict';
// A transcript is what people said, not what a model wrote: the floor's finding rides on it (`floor`) for the caller's
// moderation, and it is never dropped (2026-11-15: the minors rule read five minutes of stream speech at a time, a
// child word in one minute and a body word in another, and dropped 17 of 43 Live speech windows in a day). Everything
// a model writes still meets the floor. The three transcription workflows accept the finding in their output.
const assert = require('assert');
const { floorOnResult } = require('../server/providers/index');
const schemas = require('../server/schemas');
const live = require('../server/workflows/live');
const core = require('../server/workflows/core');
const chat = require('../server/workflows/chat');

const speech = "what's up boys, welcome back … later on: the statue in that museum is completely naked, it's a famous one";

// Transcribe: delivered, with the finding on it.
const heard = { text: speech, segments: [{ start: 0, end: 4, text: speech }] };
assert.strictEqual(floorOnResult('transcribe', heard), null, 'a transcript is delivered');
assert.ok(heard.floor && heard.floor.rule, `the finding rides on it (${JSON.stringify(heard.floor)})`);

// The same words written by a model are still refused.
const written = { text: speech };
const refused = floorOnResult('chat', written);
assert.ok(refused && refused.rule, 'a model\'s answer with the same words still meets the floor');
assert.strictEqual(written.floor, undefined, 'and nothing is attached to it');

// A clean transcript is untouched.
const clean = { text: 'good game everyone, see you tomorrow' };
assert.strictEqual(floorOnResult('transcribe', clean), null);
assert.strictEqual(clean.floor, undefined);

// Every workflow whose step is a transcription accepts the finding in its output.
const all = [...(live.workflows || []), ...(core.workflows || []), ...(chat.workflows || [])];
const transcribing = all.filter((w) => Array.isArray(w.steps) && w.steps.some((s) => s.kind === 'transcribe'));
assert.ok(transcribing.length >= 3, `the transcription workflows (${transcribing.map((w) => w.key)})`);
for (const wf of transcribing) {
    const out = { text: speech, language: 'en', segments: [{ start: 0, end: 4, text: speech }], floor: heard.floor };
    const v = schemas.validate(wf.output_schema, out);
    assert.ok(v.valid, `${wf.key} accepts a flagged transcript: ${JSON.stringify(v.errors)}`);
}
console.log(`transcript-floor: a transcript is flagged, never dropped; a model's answer is still refused; ${transcribing.length} workflows accept the flag`);
