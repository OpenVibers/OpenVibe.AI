'use strict';
// Parakeet in the speech-to-text provider (as Live has had since 10-16): with PARAKEET_MODEL set, English and the 24
// European languages go to parakeet-cli, audio over 45 s in 30 s pieces whose times shift by the piece's start, fillers
// dropped; Japanese stays on whisper; a Parakeet failure falls back to whisper on the same audio; ASR_ENGINE=whisper
// forces whisper. Fake parakeet-cli and whisper-cli stand in for the real ones. Needs ffmpeg; skipped without it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createWhisperProvider, parseParakeet } = require('../server/providers/whisper');

if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    console.log('parakeet: skipped (no ffmpeg)');
    process.exit(0);
}

(async () => {
    console.warn = () => {};
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-ai-parakeet-'));
    const whisperBin = path.join(tmp, 'whisper-cli');
    fs.writeFileSync(whisperBin, [
        '#!/bin/sh',
        'of=""',
        'while [ $# -gt 0 ]; do if [ "$1" = "-of" ]; then of="$2"; fi; shift; done',
        'printf \'{"transcription":[{"offsets":{"from":0,"to":1000},"text":" from whisper"}],"result":{"language":"en"}}\' > "$of.json"',
    ].join('\n') + '\n', { mode: 0o755 });
    // The fake parakeet-cli sits next to whisper-cli (where the provider looks without PARAKEET_BIN) and names the piece
    // it decoded in its last word, so every piece's sentence is different.
    const log = path.join(tmp, 'pk.log');
    fs.writeFileSync(path.join(tmp, 'parakeet-cli'), [
        '#!/bin/sh',
        'f=""',
        'while [ $# -gt 0 ]; do if [ "$1" = "-f" ]; then f="$2"; fi; shift; done',
        `echo "$f" >> ${log}`,
        'if [ -n "$PK_FAIL" ]; then exit 1; fi',
        'b=$(basename "$f" .wav)',
        'echo \'tok t0=  10 t1=  40 word_start=true "\u2581Hello"\' >&2',
        'echo \'tok t0=  45 t1=  60 word_start=true "\u2581um"\' >&2',
        'echo "tok t0=  62 t1=  80 word_start=true \\"\u2581$b.\\"" >&2',
    ].join('\n') + '\n', { mode: 0o755 });
    const model = path.join(tmp, 'model.bin'), pk = path.join(tmp, 'parakeet.bin');
    fs.writeFileSync(model, 'x'); fs.writeFileSync(pk, 'x');
    const media = path.join(tmp, 'talk.wav');
    assert.strictEqual(spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '70', media]).status, 0);

    const make = (extra = {}) => createWhisperProvider({ key: 'whisper' }, { config: { whisper: { bin: whisperBin, model, threads: 2, beam: 1, maxConcurrent: 1, vad: false, parakeetModel: pk, ...extra } } });
    const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
    try {
        let w = make();
        let r = await w.transcribe({ filePath: media, language: 'en', timeoutMs: 60000 });
        assert.strictEqual(r.model, 'parakeet.bin');
        assert.strictEqual(lines().length, 3, '70 s goes to Parakeet in three pieces');
        assert.deepStrictEqual(r.segments.map((s) => [s.start, s.text]), [[0.1, 'Hello p0000.'], [30.1, 'Hello p0001.'], [60.1, 'Hello p0002.']]);
        assert.strictEqual(r.text, 'Hello p0000. Hello p0001. Hello p0002.');
        assert.strictEqual(w.describe().parakeet, 'parakeet.bin');
        console.log('✓ English: Parakeet in 30 s pieces, times shifted by each piece, fillers dropped');

        r = await w.transcribe({ filePath: media, language: 'ja', timeoutMs: 60000 });
        assert.deepStrictEqual([r.model, r.text, lines().length], ['model.bin', 'from whisper', 3], 'Japanese stays on whisper');
        r = await w.transcribe({ filePath: media, language: 'el', seconds: 20, timeoutMs: 60000 });
        assert.deepStrictEqual([r.model, lines().length], ['parakeet.bin', 4], 'Greek is one of Parakeet\'s languages; 20 s is one piece');
        console.log('✓ Japanese on whisper; Greek on Parakeet');

        process.env.PK_FAIL = '1';
        r = await w.transcribe({ filePath: media, language: 'en', seconds: 20, timeoutMs: 60000 });
        delete process.env.PK_FAIL;
        assert.deepStrictEqual([r.model, r.text], ['model.bin', 'from whisper'], 'a Parakeet failure: whisper takes the audio');
        console.log('✓ a Parakeet failure falls back to whisper');

        w = make({ engine: 'whisper' });
        r = await w.transcribe({ filePath: media, language: 'en', seconds: 20, timeoutMs: 60000 });
        assert.strictEqual(r.model, 'model.bin');
        w = make({ parakeetModel: null });
        assert.strictEqual(w.describe().parakeet, null, 'no PARAKEET_MODEL: whisper only');
        console.log('✓ ASR_ENGINE=whisper and no PARAKEET_MODEL: whisper');

        // A pause of 1.5 s or 20 s of talk ends a sentence; control tokens are skipped.
        const out = parseParakeet([
            'x t0=   0 t1=  20 word_start=true "\u2581so"', 'x t0=  20 t1=  30 word_start=false "<unk>"',
            'x t0= 300 t1= 320 word_start=true "\u2581anyway"', 'x t0= 320 t1= 340 word_start=false "!"',
        ].join('\n'), 100);
        assert.deepStrictEqual(out, [{ start: 100, end: 100.2, text: 'so' }, { start: 103, end: 103.4, text: 'anyway!' }]);
        console.log('✓ parseParakeet: pauses split sentences, control tokens skipped');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('parakeet: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
