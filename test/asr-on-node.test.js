'use strict';
// Parakeet on the shared node (server/providers/asr-run.js, plan §AD.21b item 6): with AI_ASR_RUN_* set, a VOD's audio
// is cut into 10 s pieces and each goes to OpenVibe.Run as an openvibe-asr job, three at a time; the node's
// parakeet-cli output is parsed as a local run's, each piece shifted by its start. A piece the node does not decode
// is decoded here, one at a time, and a failure keeps the next five minutes here. A fake Run and a fake parakeet-cli
// stand in. Needs ffmpeg; skipped without it.
//   node test/asr-on-node.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createWhisperProvider } = require('../server/providers/whisper');
const { createAsrRun, settingsOf } = require('../server/providers/asr-run');

const SUBJECT = 'usr_01KKT9AC60KM7CRTB3WN1Z8P56';
const PROJECT = 'prj_01M7A6T4Y2ZNWTMM8VR6HW5T17';
const ASR = { url: 'http://127.0.0.1:4920', subject: SUBJECT, project: PROJECT };
const tokens = { getToken: async () => 'tok-run', invalidate() {} };
const quiet = { warn() {} };

/** A fake Run: each submitted piece gets a job; its answer names the piece by the order it was submitted. */
function fakeRun({ failPiece = -1, failWhen = null } = {}) {
    const calls = [];
    const jobs = new Map();
    let n = 0;
    const fetchImpl = async (url, o = {}) => {
        if (o.method === 'POST' && url.endsWith('/api/v1/jobs')) {
            const body = JSON.parse(o.body);
            calls.push({ headers: o.headers, body });
            const id = `job_${n}`;
            const wav = Buffer.from(body.args.audio_b64, 'base64');
            jobs.set(id, { n: n++, bytes: wav.length });
            return { status: 201, json: async () => ({ job: { id, state: 'queued' } }) };
        }
        const m = /\/api\/v1\/jobs\/(job_\d+)$/.exec(url);
        if (m && jobs.has(m[1])) {
            const j = jobs.get(m[1]);
            if (j.n === failPiece || (failWhen && failWhen(j.n))) return { status: 200, json: async () => ({ id: m[1], state: 'failed', error: { code: 'run.job.exit_nonzero' } }) };
            const stderr = `tok t0=  10 t1=  40 word_start=true "▁Node${j.n}."`;
            return { status: 200, json: async () => ({ id: m[1], state: 'succeeded', result: { code: 0, stderr, ms: 900 } }) };
        }
        return { status: 404, json: async () => ({}) };
    };
    return { calls, fetchImpl };
}

if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    console.log('asr-on-node: skipped (no ffmpeg)');
    process.exit(0);
}

(async () => {
    console.warn = () => {};
    assert.strictEqual(settingsOf({}), null);
    assert.strictEqual(settingsOf({ asrRun: { ...ASR, project: 'nope' } }), null);
    assert.ok(settingsOf({ asrRun: ASR }));

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-ai-asr-node-'));
    const whisperBin = path.join(tmp, 'whisper-cli');
    fs.writeFileSync(whisperBin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const log = path.join(tmp, 'pk.log');
    fs.writeFileSync(path.join(tmp, 'parakeet-cli'), [
        '#!/bin/sh',
        'f=""',
        'while [ $# -gt 0 ]; do if [ "$1" = "-f" ]; then f="$2"; fi; shift; done',
        `echo "$f" >> ${log}`,
        'echo \'tok t0=  10 t1=  40 word_start=true "▁Here."\' >&2',
    ].join('\n') + '\n', { mode: 0o755 });
    const model = path.join(tmp, 'model.bin'), pk = path.join(tmp, 'parakeet.bin');
    fs.writeFileSync(model, 'x'); fs.writeFileSync(pk, 'x');
    const media = path.join(tmp, 'talk.wav');
    assert.strictEqual(spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '35', media]).status, 0);
    const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
    const make = (asrRun, extra = {}) => createWhisperProvider({ key: 'whisper' }, { asrRun, config: { asrRun: ASR, whisper: { bin: whisperBin, model, threads: 2, beam: 1, maxConcurrent: 1, vad: false, parakeetModel: pk, ...extra } } });

    try {
        // 35 s of audio: four pieces (10, 10, 10, 5 s), all on the node, in order, each shifted by its start.
        const run = fakeRun();
        const w = make(createAsrRun({ config: { asrRun: ASR }, fetchImpl: run.fetchImpl, tokens, sleep: async () => {}, log: quiet }));
        const r = await w.transcribe({ filePath: media, language: 'en', offsetSec: 100 });
        assert.deepStrictEqual(r.segments.map((s) => s.text).sort(), ['Node0.', 'Node1.', 'Node2.', 'Node3.']);
        assert.deepStrictEqual(r.segments.map((s) => Math.round(s.start)), [100, 110, 120, 130], 'each 10 s piece shifted by its start');
        assert.strictEqual(lines().length, 0, 'nothing decoded here');
        assert.strictEqual(run.calls.length, 4);
        const sub = run.calls[0];
        assert.deepStrictEqual([sub.body.class, sub.body.artifact, sub.body.egress], ['linux', { name: 'openvibe-asr', version: '1.0.0' }, 'none']);
        assert.deepStrictEqual([sub.headers.Authorization, sub.headers['X-OV-Subject'], sub.headers['X-OV-Project']], ['Bearer tok-run', SUBJECT, PROJECT]);
        assert.ok(run.calls.every((c) => Buffer.byteLength(JSON.stringify(c.body)) < 512 * 1024), 'every piece within Run\'s 512 KB args');

        // A piece the node misses once is asked again and answered there (11-18): nothing decoded here.
        const blip = fakeRun({ failPiece: 1 });
        const wb = make(createAsrRun({ config: { asrRun: ASR }, fetchImpl: blip.fetchImpl, tokens, sleep: async () => {}, log: quiet }));
        fs.writeFileSync(log, '');
        const rb = await wb.transcribe({ filePath: media, language: 'en' });
        assert.strictEqual(rb.segments.length, 4, 'four pieces, all from the node');
        assert.strictEqual(lines().length, 0, 'nothing decoded here after one miss');
        assert.strictEqual(blip.calls.length, 5, 'the missed piece asked twice');

        // AI_ASR_LOCAL_FALLBACK=off: a piece the node misses twice fails the transcription as unavailable; nothing here.
        const off = fakeRun({ failWhen: (n) => n >= 1 });
        const wo = createWhisperProvider({ key: 'whisper' }, { asrRun: createAsrRun({ config: { asrRun: ASR }, fetchImpl: off.fetchImpl, tokens, sleep: async () => {}, log: quiet }),
            config: { asrRun: { ...ASR, localFallback: false }, whisper: { bin: whisperBin, model, threads: 2, beam: 1, maxConcurrent: 1, vad: false, parakeetModel: pk } } });
        fs.writeFileSync(log, '');
        await assert.rejects(wo.transcribe({ filePath: media, language: 'en' }), (e) => e.code === 'provider.unavailable' && e.nodeMiss === true);
        assert.strictEqual(lines().length, 0, 'fallback off: no piece decoded here, and no whisper either');
        await assert.rejects(wo.transcribe({ filePath: media, language: 'en' }), (e) => e.code === 'provider.unavailable', 'cooling down: unavailable at once, nothing here');
        assert.strictEqual(lines().length, 0);

        // A piece the node misses twice (every job from the second on fails): decoded here, the rest from the node.
        fs.writeFileSync(log, '');
        const bad = fakeRun({ failWhen: (n) => n >= 1 });
        const w2 = make(createAsrRun({ config: { asrRun: ASR }, fetchImpl: bad.fetchImpl, tokens, sleep: async () => {}, log: quiet }));
        const r2 = await w2.transcribe({ filePath: media, language: 'en' });
        const texts = r2.segments.map((s) => s.text);
        assert.ok(texts.includes('Here.'), `the failed piece is decoded here: ${texts.join(' | ')}`);
        assert.ok(texts.includes('Node0.'), 'the pieces already on the node keep their answers');
        assert.ok(lines().length >= 1, 'parakeet ran here for the failed piece');

        // While cooling down, the next VOD is decoded here in 30 s pieces, without asking Run.
        fs.writeFileSync(log, '');
        const before = bad.calls.length;
        await w2.transcribe({ filePath: media, language: 'en' });
        assert.strictEqual(bad.calls.length, before, 'Run is not asked while cooling down');
        assert.strictEqual(lines().length, 1, '35 s here is one piece (under 45 s), as before');

        // Not configured: the local path, unchanged.
        fs.writeFileSync(log, '');
        const w3 = createWhisperProvider({ key: 'whisper' }, { config: { whisper: { bin: whisperBin, model, threads: 2, beam: 1, maxConcurrent: 1, vad: false, parakeetModel: pk } } });
        await w3.transcribe({ filePath: media, language: 'en' });
        assert.strictEqual(lines().length, 1);
        console.log('asr on the shared node: all checks passed');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
