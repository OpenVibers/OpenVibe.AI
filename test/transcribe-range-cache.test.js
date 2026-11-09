'use strict';
// The range cache (item 151, C12): the same seconds of the same recording are transcribed once. live.media.transcribe's
// cache key leaves out what does not change the words: the signed URL's exp and sig (new on every call) and low_power
// (only how fast whisper runs). The recording, the range, the language and whether words were asked for still count.
// In the week to 11-03, 30 of 317 transcriptions repeated a range they had already done.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { CACHE_INPUT } = require('../server/workflows/hooks');
const { sha256, stableStringify } = require('../server/util');
const live = require('../server/workflows/live');

const key = (input) => sha256(stableStringify(CACHE_INPUT['live.media.transcribe'](input)));
const base = { media_url: 'https://openvibe.media/v/6146?exp=1762146000&sig=aa11', language: 'en', start_sec: 300, seconds: 300, low_power: false };

assert.strictEqual(key(base), key({ ...base, media_url: 'https://openvibe.media/v/6146?exp=1762149999&sig=bb22', low_power: true }), 'a new signature and low power: the same range');
assert.strictEqual(key({ ...base, media_url: 'https://openvibe.media/v/6146?sig=x&exp=1' }), key({ ...base, media_url: 'https://openvibe.media/v/6146' }), 'the order of the query and its absence do not matter');
assert.notStrictEqual(key(base), key({ ...base, start_sec: 600 }), 'another range');
assert.notStrictEqual(key(base), key({ ...base, seconds: 200 }));
assert.notStrictEqual(key(base), key({ ...base, media_url: 'https://openvibe.media/v/6147?exp=1&sig=2' }), 'another recording');
assert.notStrictEqual(key(base), key({ ...base, language: 'ja' }), 'another language');
assert.notStrictEqual(key(base), key({ ...base, words: true }), 'words asked for');
assert.notStrictEqual(key({ ...base, media_url: 'https://openvibe.media/c/9?part=1&sig=z' }), key({ ...base, media_url: 'https://openvibe.media/c/9?part=2&sig=z' }), 'other query parameters still count');
assert.doesNotThrow(() => key({ ...base, media_url: 'not a url' }));
const kept = CACHE_INPUT['live.media.transcribe'](base);
assert.ok(!('low_power' in kept));
assert.strictEqual(base.low_power, false, 'the run\'s own input is not changed');

// The run cache keys on it; a recording's words are kept two weeks.
const runs = fs.readFileSync(path.join(__dirname, '..', 'server', 'runs.js'), 'utf8');
assert.match(runs, /const keyInput = CACHE_INPUT\[wf\.key\] \? sha256\(\{ input: CACHE_INPUT\[wf\.key\]\(input\), effortPolicy \}\) : inputHash;/);
assert.match(runs, /cache\.keyFor\(\{[^}]*inputHash: keyInput \}\)/);
const wf = live.workflows.find((w) => w.key === 'live.media.transcribe');
assert.strictEqual(wf.cache_mode, 'private', 'still scoped to the requester');
assert.strictEqual(wf.cache_ttl_sec, 14 * 86400);
console.log('transcribe range cache: all checks passed');
