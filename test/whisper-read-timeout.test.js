'use strict';
// A recording read over HTTP gives up on a stalled read and reconnects instead of holding whisper until the 10-minute
// kill (2026-11-15: five Live windows a day ended "ffmpeg exited null" after 600 s). ffmpeg is stubbed: the test reads
// the arguments whisper gives it, and a kill is reported as a timeout, not "exited null".
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const cp = require('child_process');

const spawned = [];
cp.spawn = (cmd, args) => {
    const ch = new EventEmitter();
    ch.stderr = new EventEmitter();
    ch.kill = () => { setImmediate(() => ch.emit('close', null)); };
    spawned.push({ cmd, args, ch });
    return ch;
};
const { createWhisperProvider } = require('../server/providers/whisper');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-ai-readtimeout-'));
    const bin = path.join(tmp, 'whisper-cli');
    const model = path.join(tmp, 'model.bin');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(model, 'x');
    const whisper = createWhisperProvider({ key: 'whisper' }, { config: { whisper: { bin, model, threads: 2, beam: 1, maxConcurrent: 1, vad: false } } });

    // Over HTTP: the read timeout and reconnects come before the input; a stall the kill ends says so.
    const pending = whisper.transcribe({ filePath: 'https://media.openvibe.live/vods/1/vod.mp4', seconds: 300, startSec: 600, timeoutMs: 50 });
    await new Promise((r) => setTimeout(r, 20));
    const ff = spawned.find((s) => s.cmd === 'ffmpeg');
    assert.ok(ff, 'ffmpeg was started');
    const at = (flag) => ff.args.indexOf(flag);
    assert.strictEqual(ff.args[at('-rw_timeout') + 1], '15000000', 'a stalled read gives up after 15 s');
    assert.strictEqual(ff.args[at('-reconnect') + 1], '1');
    assert.strictEqual(ff.args[at('-reconnect_on_network_error') + 1], '1');
    assert.ok(at('-rw_timeout') < at('-i') && at('-reconnect') < at('-i'), 'input options, before -i');
    assert.ok(at('-ss') < at('-i'), 'the window still starts where it was asked');
    await assert.rejects(pending, (e) => { assert.match(e.message, /stopped after 0 s reading the media/); assert.strictEqual(e.code, 'provider.timeout'); return true; });

    // A local file: no network options.
    spawned.length = 0;
    const local = path.join(tmp, 'a.wav');
    fs.writeFileSync(local, 'x');
    const p2 = whisper.transcribe({ filePath: local, seconds: 5, timeoutMs: 50 });
    await new Promise((r) => setTimeout(r, 20));
    const ff2 = spawned.find((s) => s.cmd === 'ffmpeg');
    assert.ok(ff2 && !ff2.args.includes('-rw_timeout'), 'a local file gets no network options');
    await p2.catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('whisper-read-timeout: an HTTP recording gives up on a stall after 15 s and reconnects; a kill says it timed out');
})().catch((e) => { console.error(e); process.exit(1); });
