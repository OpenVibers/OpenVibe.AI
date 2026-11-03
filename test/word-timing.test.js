'use strict';
// Word timing (item 151, C12): with `words: true`, live.media.transcribe keeps every word's start and end inside its
// segment, so a clip can start and end on a word and a moment's words can be found again. whisper.cpp's -ojf tokens
// (the fixture is what the host's whisper-cli large-v3-turbo printed for a synthetic voice on 2026-11-03) and
// Parakeet's token lines both become words; punctuation joins its word without moving the word's end; control tokens
// and fillers are not words; a language written without spaces gets one unit per token; times shift by the window's
// offset; words go with their segment when a noise segment is dropped; nothing changes when words are not asked for.
const assert = require('assert');
const { wordsFromTokens, parseParakeet, cleanSegments } = require('../server/providers/whisper');
const live = require('../server/workflows/live');

// ── whisper.cpp -ojf ──
const tok = (text, from, to) => ({ text, offsets: { from, to } });
const host = [
    tok('[_BEG_]', 0, 0), tok(' it', 0, 100), tok(' comp', 110, 340), tok('iles', 340, 570), tok('.', 570, 760),
    tok(' Finally', 760, 1360), tok(',', 1360, 1540), tok(' after', 1540, 2020), tok(' three', 2020, 2300),
    tok(' hours', 2300, 2520), tok(' of', 2520, 2610), tok(' trying', 2740, 2990), tok(',', 3000, 3090),
    tok(' Chat', 4570, 4660), tok(',', 5010, 5040), tok(' did', 5040, 5270), tok(' you', 5270, 5500), tok(' see', 5500, 5720),
    tok(' that', 5730, 6030), tok('?', 6040, 6280), tok('[_TT_315]', 6300, 6300),
];
const words = wordsFromTokens(host, 0);
assert.deepStrictEqual(words.map((w) => w.text), ['it', 'compiles.', 'Finally,', 'after', 'three', 'hours', 'of', 'trying,', 'Chat,', 'did', 'you', 'see', 'that?']);
const compiles = words[1];
assert.strictEqual(compiles.start, 0.11);
assert.strictEqual(compiles.end, 0.57, 'the full stop joins the word without stretching it to 0.76');
assert.strictEqual(words[words.length - 1].end, 6.03);
assert.strictEqual(wordsFromTokens(host, 120)[1].start, 120.11, 'a window of a longer recording keeps the recording\'s times');

// Japanese: no spaces to break on, so each token is a unit; 「。」 joins the unit before it. Fillers and control tokens go.
assert.deepStrictEqual(wordsFromTokens([tok(' 今日', 0, 300), tok('は', 300, 420), tok('ね', 420, 600), tok('。', 600, 700), tok('<|endoftext|>', 700, 700)], 0).map((w) => w.text), ['今日', 'は', 'ね。']);
assert.deepStrictEqual(wordsFromTokens([tok(' so', 0, 100), tok(' uh', 100, 300), tok(' yes', 300, 500), tok(' broken', 600, 500), { text: ' x' }], 0).map((w) => w.text), ['so', 'yes'],
    'fillers, backwards and untimed tokens are not words');
assert.deepStrictEqual(wordsFromTokens(null), []);

// ── Parakeet's token lines ──
const pk = [
    'tok t0=  10 t1=  40 word_start=true "▁IT"',
    'tok t0=  41 t1=  60 word_start=true "▁COM"',
    'tok t0=  60 t1=  90 word_start=false "PILES"',
    'tok t0=  90 t1=  95 word_start=false "."',
    'tok t0= 300 t1= 320 word_start=true "▁um"',
    'tok t0= 330 t1= 360 word_start=true "▁Wow"',
    'tok t0= 360 t1= 370 word_start=false "!"',
].join('\n');
const sentences = parseParakeet(pk, 100, { words: true });
assert.deepStrictEqual(sentences.map((s) => s.text), ['IT COMPILES.', 'Wow!']);
assert.deepStrictEqual(sentences[0].words, [{ start: 100.1, end: 100.4, text: 'IT' }, { start: 100.41, end: 100.9, text: 'COMPILES.' }]);
assert.deepStrictEqual(sentences[1].words.map((w) => w.text), ['Wow!'], 'the filler is not a word');
assert.ok(!('words' in parseParakeet(pk, 0)[0]), 'no words unless asked');

// ── cleanSegments keeps words with their segment, and drops them with it ──
const cleaned = cleanSegments([
    { start: 1, end: 2, text: 'IT COMPILES.', words: [{ start: 1.004, end: 1.5, text: 'IT' }, { start: 1.5, end: 1.996, text: 'COMPILES.' }] },
    { start: 3, end: 4, text: 'Thank you for watching!', words: [{ start: 3, end: 4, text: 'Thank' }] },
], false);
assert.strictEqual(cleaned.length, 1, 'whisper\'s invented sign-off is dropped, its words with it');
assert.deepStrictEqual(cleaned[0].words, [{ start: 1, end: 1.5, text: 'IT' }, { start: 1.5, end: 2, text: 'COMPILES.' }]);
assert.ok(!('words' in cleanSegments([{ start: 0, end: 1, text: 'plain' }], true)[0]));

// ── The workflow asks for them and its output allows them ──
const wf = (live.workflows || []).find((x) => x.key === 'live.media.transcribe');
assert.ok(wf, 'live.media.transcribe exists');
assert.deepStrictEqual(wf.input_schema.properties.words, { type: 'boolean' });
assert.ok(wf.output_schema.properties.segments.items.properties.words, 'segments may carry words');

console.log('word timing: all checks passed');
