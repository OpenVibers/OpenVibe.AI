'use strict';
// media.analyze, local-first media analysis (roadmap WS-O task 5), on test/fixtures/media-analysis.mp4: 28 s with cuts
// at 8, 16 and 20 s, black picture 16-20 s, a still picture 8-16 s, silence 10-16 s, and a loud burst at 16-18 s over
// a quiet tone.
//   - the log parser reads scdet, blackdetect, freezedetect, silencedetect and ebur128 lines (no FFmpeg needed);
//   - a real run: signals, scenes, loud moments measured against the typical level, highlights with their evidence,
//     and the overview from the local model (media.local), which sees only the measured facts and the transcript;
//   - the local model down: an extractive overview that says so; paid only with allow_paid AND a media.paid budget,
//     never past it; the paid call is the run's provider;
//   - too little free disk refuses before downloading;
//   - a quiet stream's talking is not dead air; whisper names the language it detected.
// The runs need ffprobe/ffmpeg on PATH; without them those parts are skipped (the parser part always runs).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const nodeHttp = require('http');
const { spawnSync } = require('child_process');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');
const ma = require('../server/workflows/media-analysis');

const HAS_FFMPEG = spawnSync('ffprobe', ['-version']).status === 0 && spawnSync('ffmpeg', ['-version']).status === 0;
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'media-analysis.mp4'));
const LOG = [
    '[scdet @ 0x1] lavfi.scd.score: 20.854, lavfi.scd.time: 8',
    '[silencedetect @ 0x2] silence_start: 9.99975',
    '[freezedetect @ 0x3] lavfi.freezedetect.freeze_start: 9',
    '[silencedetect @ 0x2] silence_end: 16.0001 | silence_duration: 6.00031',
    '[freezedetect @ 0x3] lavfi.freezedetect.freeze_end: 16',
    '[blackdetect @ 0x4] black_start:16 black_end:20 black_duration:4',
    ...Array.from({ length: 30 }, (_, i) => `[Parsed_ebur128_5 @ 0x5] t: ${(i + 0.5).toFixed(1)}    TARGET:-23 LUFS    M: ${i === 17 ? '-9.5' : i >= 10 && i < 16 ? '-120.7' : '-35.6'} S: -35.7     I: -35.7 LUFS       LRA:  20.0 LU`),
    '[silencedetect @ 0x2] silence_start: 25.9999',
    '[Parsed_ebur128_5 @ 0x5] Summary:',
    '  Integrated loudness:',
    '    I:         -10.1 LUFS',
    '    Threshold: -20.2 LUFS',
    '  Loudness range:',
    '    LRA:        25.7 LU',
];

const t = suite('media-analysis');
let media; let mediaBase;
const tok = token('live', ALL);
const run = (h, input) => request(h.base, 'POST', '/api/v1/runs?wait=60000', { tok, body: { workflow: 'media.analyze', input: { media_url: `${mediaBase}/fixture.mp4`, language: 'en', ...input } } });
const completion = (content) => ({ id: 'x', object: 'chat.completion', model: 'fake-model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 20 } });

t.test('the parser reads every filter\'s lines; loud means well above the typical second', async () => {
    const s = ma.parseSignals(LOG.join('\n'), 28);
    assert.deepStrictEqual(s.scene_changes, [{ t: 8, score: 20.85 }]);
    assert.deepStrictEqual(s.black, [{ start: 16, end: 20 }]);
    assert.deepStrictEqual(s.frozen, [{ start: 9, end: 16 }]);
    assert.deepStrictEqual(s.silence, [{ start: 10, end: 16 }, { start: 26, end: 28 }], 'an open silence runs to the end');
    assert.strictEqual(s.loudness.integrated_lufs, -10.1);
    assert.strictEqual(s.loudness.range_lu, 25.7);
    assert.strictEqual(s.loudness.typical_lufs, -35.6, 'the median audible second, not the gated integrated level one burst dragged up');
    assert.deepStrictEqual(s.loudness.peaks, [{ start: 17, end: 18, lufs: -9.5 }]);
    assert.deepStrictEqual(ma.scenesOf([{ t: 8, score: 20 }, { t: 16, score: 31 }, { t: 20, score: 50 }], 28), [{ start: 0, end: 8 }, { start: 8, end: 16 }, { start: 16, end: 20 }, { start: 20, end: 28 }]);
    const many = Array.from({ length: 400 }, (_, i) => ({ t: i * 10 + 5, score: i % 7 }));
    assert.strictEqual(ma.scenesOf(many, 4010).length, 300, 'at most 300 scenes; the strongest changes are the boundaries');
    assert.strictEqual(ma.speechRatio([{ start: 0, end: 10, text: 'a' }, { start: 5, end: 12, text: 'b' }], 24), 0.5, 'overlapping speech counts once');
    assert.strictEqual(ma.clock(3725), '1:02:05');
    // A quiet stream: someone talking over a still picture is a highlight, not dead air; a silent black stretch is.
    const talk = { scene_changes: [], black: [{ start: 60, end: 90 }], frozen: [{ start: 0, end: 60 }], silence: [{ start: 60, end: 90 }], loudness: { typical_lufs: -41, integrated_lufs: -39, peaks: [] } };
    const segs = Array.from({ length: 12 }, (_, i) => ({ start: i * 5, end: i * 5 + 5, text: 'and then we go over there and look at this one more time okay' }));
    const hl = ma.highlightsOf({ duration: 90, signals: talk, perSecond: new Map(), segments: segs });
    assert.ok(hl.length && hl.every((x) => x.reasons.includes('speech') && x.start < 60), JSON.stringify(hl));
});

t.test('whisper reports the language it detected, not "auto"', async () => {
    if (!HAS_FFMPEG) return console.log('    (skipped: no ffmpeg/ffprobe)');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ov-ai-whisper-'));
    try {
        const bin = path.join(dir, 'whisper-cli');
        fs.writeFileSync(bin, `#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -of) OUT="$2"; shift;; -l) L="$2"; shift;; esac; shift; done\n[ "$L" = auto ] && LANG_OUT=ja || LANG_OUT="$L"\nprintf '{"result":{"language":"%s"},"transcription":[{"offsets":{"from":0,"to":1500},"text":"こんにちは、みなさん"}]}' "$LANG_OUT" > "$OUT.json"\n`, { mode: 0o755 });
        for (const f of ['base.bin', 'multi.bin']) fs.writeFileSync(path.join(dir, f), 'x');
        const { createWhisperProvider } = require('../server/providers/whisper');
        const w = createWhisperProvider({ key: 'whisper' }, { config: { whisper: { bin, model: path.join(dir, 'base.bin'), modelMulti: path.join(dir, 'multi.bin'), vad: false, threads: 1, beam: 1, maxConcurrent: 1 } } });
        const clip = path.join(dir, 'clip.mp4');
        fs.writeFileSync(clip, FIXTURE);
        const r = await w.transcribe({ filePath: clip, language: 'auto', seconds: 3, timeoutMs: 30000 });
        assert.deepStrictEqual([r.language, r.text], ['ja', 'こんにちは、みなさん']);
        assert.strictEqual((await w.transcribe({ filePath: clip, language: 'en', seconds: 3, timeoutMs: 30000 })).language, 'en');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t.test('a real run: signals, scenes, highlights with evidence, and the local model\'s overview', async () => {
    if (!HAS_FFMPEG) return console.log('    (skipped: no ffmpeg/ffprobe)');
    media = nodeHttp.createServer((req, res) => { res.writeHead(req.url === '/fixture.mp4' ? 200 : 404, { 'Content-Type': 'video/mp4' }); res.end(req.url === '/fixture.mp4' ? FIXTURE : ''); });
    await new Promise((r) => media.listen(0, '127.0.0.1', r));
    mediaBase = `http://127.0.0.1:${media.address().port}`;
    const local = await seamServer(() => completion('A short test recording: a quiet tone, a pause, then a loud burst at 0:16.'));
    const h = await boot({ env: { OV_MEDIA_INTERNAL_URL: mediaBase, AI_LOCAL_LLM_URL: `${local.url}/v1`, AI_LOCAL_LLM_MODEL: 'qwen-test' } });
    try {
        const r = await run(h, {});
        assert.strictEqual(r.status, 201, r.text.slice(0, 300));
        const out = r.body.run.output;
        assert.strictEqual(r.body.run.status, 'succeeded', JSON.stringify(r.body.run.error));
        assert.ok(Math.abs(out.duration_seconds - 28) < 0.2);
        assert.deepStrictEqual(out.streams, { video: true, audio: true });
        assert.deepStrictEqual(out.signals.scene_changes.map((c) => c.t), [8, 16, 20]);
        assert.deepStrictEqual(out.signals.black, [{ start: 16, end: 20 }]);
        assert.deepStrictEqual(out.scenes.map((s) => [s.start, Math.round(s.end)]), [[0, 8], [8, 16], [16, 20], [20, 28]]);
        assert.ok(out.signals.silence.some((s) => Math.round(s.start) === 10 && Math.round(s.end) === 16));
        assert.ok(out.signals.loudness.typical_lufs < -30 && out.signals.loudness.integrated_lufs > -15, 'one burst lifts the integrated level, not the typical one');
        assert.ok(out.signals.loudness.peaks.some((p) => p.start >= 16 && p.start <= 18), 'the burst is a loud moment');
        assert.ok(out.highlights.some((x) => x.reasons.includes('loud') && x.start <= 18 && x.end >= 17), JSON.stringify(out.highlights));
        // The model is what the server says it ran; the request asked for the configured one.
        assert.deepStrictEqual(out.overview, { text: 'A short test recording: a quiet tone, a pause, then a loud burst at 0:16.', source: 'local_model', provider: 'local', model: 'fake-model' });
        assert.strictEqual(r.body.run.provenance.model, 'fake-model');
        const prompt = JSON.stringify(local.last.messages);
        assert.match(prompt, /Scenes: 4/, 'the model sees the measured facts');
        assert.match(prompt, /Loudest moments: 0:1[6-8]/);
        assert.strictEqual(local.last.model, 'qwen-test');
        assert.ok(!r.body.run.output.gaps.some((g) => /local model/.test(g)));
        const work = path.join(h.dir, 'media-tmp');
        assert.ok(fs.existsSync(work), 'the work directory is beside the database (not a tmpfs /tmp)');
        assert.deepStrictEqual(fs.readdirSync(work).filter((f) => f.startsWith('openvibe-ai-media-')), [], 'the downloaded file is removed');
    } finally { await h.stop(); await local.close(); }
});

t.test('local model down: extractive, and it says so; paid only with allow_paid and a budget, never past it', async () => {
    if (!HAS_FFMPEG) return console.log('    (skipped: no ffmpeg/ffprobe)');
    const local = await seamServer(() => ({ status: 500, body: { error: 'model not loaded' } }));
    const paid = await seamServer(() => completion('Paid overview of the recording.'));
    const h = await boot({ env: {
        OV_MEDIA_INTERNAL_URL: mediaBase, AI_LOCAL_LLM_URL: `${local.url}/v1`, AI_STUB_FALLBACK: '0',
        AI_PROVIDER: 'openai', AI_BASE_URL: `${paid.url}/v1`, AI_API_KEY: 'paid-key', AI_MODEL: 'paid-model', AI_PROVIDER_RETRIES: '0',
    } });
    try {
        let r = await run(h, {});
        let out = r.body.run.output;
        assert.strictEqual(r.body.run.status, 'succeeded', JSON.stringify(r.body.run.error));
        assert.strictEqual(out.overview.source, 'extractive');
        assert.match(out.overview.text, /Length analysed: 0:28\. Streams: video and audio\. Scenes: 4/);
        assert.ok(out.gaps.some((g) => /The local model did not answer/.test(g)), JSON.stringify(out.gaps));
        assert.ok(out.gaps.some((g) => /Speech-to-text did not run/.test(g)), 'no whisper here, and no stub standing in for it');
        assert.strictEqual(out.transcript.available, false);
        assert.strictEqual(paid.calls, 0, 'no paid call without allow_paid');

        r = await run(h, { allow_paid: true });
        out = r.body.run.output;
        assert.strictEqual(out.overview.source, 'extractive');
        assert.ok(out.gaps.some((g) => /no quota gives media\.paid a cost budget/.test(g)));
        assert.strictEqual(paid.calls, 0, 'no paid call without a budget');

        h.quotas.upsert({ scope_type: 'global', scope_id: '*', window: 'day', max_cost_usd: 0.5, workflow_prefix: 'media.paid' }, { actor: 'test' });
        r = await run(h, { allow_paid: true });
        out = r.body.run.output;
        assert.deepStrictEqual([out.overview.source, out.overview.text], ['paid', 'Paid overview of the recording.'], JSON.stringify(out.gaps));
        assert.strictEqual(paid.calls, 1);
        assert.strictEqual(paid.last.model, 'paid-model');
        assert.strictEqual(r.body.run.provenance.model, 'fake-model', 'the paid call is the run\'s provider');
        const other = await request(h.base, 'POST', '/api/v1/runs?wait=10000', { tok, body: { workflow: 'ai.summarize', input: { text: 'SQLite is small.', max_words: 20 } } });
        assert.strictEqual(other.status, 201, `the media.paid budget does not gate other workflows: ${other.text.slice(0, 300)}`);

        const day = new Date().toISOString().slice(0, 10);
        const callsBefore = paid.calls;
        h.db.prepare("INSERT INTO usage_daily (day, requester, attribution, workflow_key, provider_key, model_key, requests, cost_usd) VALUES (?, 'service:live', '', 'media.analyze', 'shared', 'paid-model', 1, 0.75)").run(day);
        r = await run(h, { allow_paid: true });
        out = r.body.run.output;
        assert.strictEqual(r.body.run.status, 'succeeded', 'a spent budget refuses the paid call, not the analysis');
        assert.strictEqual(out.overview.source, 'extractive');
        assert.ok(out.gaps.some((g) => /paid budget for media analysis \(\$0\.5\) is spent/.test(g)));
        assert.strictEqual(paid.calls, callsBefore, 'nothing paid past the budget');
    } finally { await h.stop(); await local.close(); await paid.close(); }
});

t.test('too little free disk refuses before downloading', async () => {
    if (!HAS_FFMPEG) return console.log('    (skipped: no ffmpeg/ffprobe)');
    let fetched = 0;
    const counting = nodeHttp.createServer((req, res) => { fetched++; res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end(FIXTURE); });
    await new Promise((r) => counting.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${counting.address().port}`;
    const h = await boot({ env: { OV_MEDIA_INTERNAL_URL: base, AI_MEDIA_ANALYSIS_DISK_RESERVE_BYTES: String(1024 ** 5) } });
    try {
        const r = await request(h.base, 'POST', '/api/v1/runs?wait=20000', { tok, body: { workflow: 'media.analyze', input: { media_url: `${base}/fixture.mp4` } } });
        assert.strictEqual(r.body.run.status, 'failed');
        assert.strictEqual(r.body.run.error.code, 'media.no_space');
        assert.strictEqual(fetched, 0);
    } finally { await h.stop(); counting.closeAllConnections?.(); counting.close(); if (media) { media.closeAllConnections?.(); media.close(); } }
});

t.run();
