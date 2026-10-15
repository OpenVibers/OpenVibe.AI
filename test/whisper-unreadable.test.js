'use strict';
// Media whisper cannot read (Media answering 404 for a recording, a file that is not media) is the caller's media, not
// whisper's ill health: the provider answers a 422 media.unreadable, which the router passes on as the run's error and
// never counts toward opening whisper's circuit (2026-10-14: one unreadable recording opened it, and every other
// recording's windows answered provider.unavailable). Needs ffmpeg; skipped without it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { createWhisperProvider } = require('../server/providers/whisper');

if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    console.log('whisper unreadable media: skipped (no ffmpeg)');
    process.exit(0);
}

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-ai-unreadable-'));
    // whisper.cpp itself is never reached: the input fails first. A placeholder binary and model make it "installed".
    const bin = path.join(tmp, 'whisper-cli');
    const model = path.join(tmp, 'model.bin');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(model, 'x');
    const notMedia = path.join(tmp, 'notes.txt');
    fs.writeFileSync(notMedia, 'this is not audio\n'.repeat(50));
    const server = http.createServer((req, res) => { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('gone'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const whisper = createWhisperProvider({ key: 'whisper' }, { config: { whisper: { bin, model, threads: 2, beam: 1, maxConcurrent: 1, vad: false } } });
    try {
        for (const [what, src] of [['a 404 from Media', `http://127.0.0.1:${server.address().port}/v/1`], ['a file that is not media', notMedia]]) {
            await assert.rejects(whisper.transcribe({ filePath: src, seconds: 5, timeoutMs: 20000 }), (e) => {
                assert.deepStrictEqual([e.code, e.status], ['media.unreadable', 422], `${what}: ${e.code} ${e.message}`);
                assert.match(e.message, /could not read the media/);
                return true;
            });
        }
        console.log('✓ unreadable input: a 422 media.unreadable from the provider (a 404, and not media)');

        // Through the app: live.media.transcribe on a recording Media answers 404 for. Each run fails with
        // media.unreadable, and whisper's circuit stays closed (two failures would open it).
        const { boot, request, token, ALL } = require('./helpers');
        const h = await boot({ env: { OV_MEDIA_INTERNAL_URL: `http://127.0.0.1:${server.address().port}`, WHISPER_BIN: bin, WHISPER_MODEL: model, WHISPER_VAD: '0', AI_STUB_FALLBACK: 'false', AI_BREAKER_FAILURES: '2', AI_BREAKER_COOLDOWN_MS: '600000' } });
        try {
            const tok = token('live', ALL);
            for (let i = 0; i < 3; i++) {
                const r = await request(h.base, 'POST', '/api/v1/runs?wait=20000', { tok, body: { workflow: 'live.media.transcribe', input: { media_url: `http://127.0.0.1:${server.address().port}/v/${i}`, language: 'en', start_sec: 0, seconds: 30 } } });
                const run = r.body.run || {};
                assert.deepStrictEqual([run.status, run.error && run.error.code], ['failed', 'media.unreadable'], JSON.stringify(run.error));
            }
            assert.strictEqual((await h.pool.health('whisper')).state, 'closed', 'unreadable media never opens whisper\'s circuit');
        } finally { await h.stop(); }
        console.log('✓ through the app: each run fails media.unreadable and whisper\'s circuit stays closed');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('whisper unreadable media: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
