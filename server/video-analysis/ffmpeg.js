'use strict';
/**
 * The tools video.analyze measures with: ffprobe for the facts, ffmpeg for the keyframes and the audio.
 *
 * Everything here is a plain child process, so a test can hand in its own spawn (server/video-analysis/index.js
 * takes one) and never touch a real video. The four jobs:
 *
 *   probe(file)        ffprobe -show_format -show_streams: the duration, the size, the codecs, the frame
 *                      rate and the rotation of the video stream, and the audio stream's codec, sample
 *                      rate and channels. A stream that is not there is null, never a made-up zero.
 *   sceneTimes(file)   one ffmpeg pass over the video with the scene filter and metadata=print: the times
 *                      the picture changes. These are the scene cuts.
 *   frame(file, t)     one ffmpeg call per keyframe: the picture at t, scaled small, as a JPEG.
 *   audio(file, ...)   one ffmpeg call per window: the audio alone, 16 kHz mono, a WAV the speech route
 *                      can read.
 *
 * The rotation of the video stream is applied by ffmpeg itself (its autorotate is on by default), so a
 * keyframe of a phone video is upright.
 */
const fs = require('fs');
const { spawn } = require('child_process');

const r2 = (n) => Math.round(n * 100) / 100;

/** "30000/1001" -> 29.97 */
function parseRate(value) {
    const s = String(value || '').trim();
    if (!s) return null;
    const [a, b] = s.split('/').map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !b) return Number.isFinite(a) ? a : null;
    return r2(a / b);
}

/** The rotation a stream carries: the side data's rotation, else the tags' rotate, else 0. */
function rotationOf(stream) {
    const side = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
    for (const s of side) if (Number.isFinite(Number(s.rotation))) return Math.round(Number(s.rotation));
    const tag = stream.tags && (stream.tags.rotate || stream.tags.ROTATE);
    if (tag != null && Number.isFinite(Number(tag))) return Math.round(Number(tag));
    return 0;
}

/**
 * One child process, resolved with { code, stdout, stderr }. The stderr is the interesting part: ffprobe
 * writes its answer to stdout, ffmpeg writes its log to stderr.
 */
function runProcess(spawnImpl, bin, args, { signal = null, timeoutMs = 120000, maxBytes = 4 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
        let ch;
        try { ch = spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return reject(Object.assign(new Error(bin + ': ' + e.message), { code: 'tool.unavailable' })); }
        let out = ''; let err = '';
        const kill = () => { try { ch.kill('SIGKILL'); } catch { /* */ } };
        const timer = setTimeout(kill, timeoutMs);
        if (signal) signal.addEventListener('abort', kill, { once: true });
        if (ch.stdout && ch.stdout.on) ch.stdout.on('data', (c) => { if (out.length < maxBytes) out += c; });
        if (ch.stderr && ch.stderr.on) ch.stderr.on('data', (c) => { if (err.length < maxBytes) err += c; });
        ch.on('error', (e) => { clearTimeout(timer); reject(Object.assign(new Error(bin + ': ' + e.message), { code: 'tool.unavailable' })); });
        ch.on('close', (code) => {
            clearTimeout(timer);
            if (signal && signal.aborted) return reject(Object.assign(new Error('cancelled'), { code: 'run.cancelled' }));
            resolve({ code, stdout: out, stderr: err });
        });
    });
}

function createFfmpeg({ ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', spawnImpl = spawn, log = console } = {}) {
    /** The facts ffprobe measured. */
    async function probe(file, { signal = null } = {}) {
        const res = await runProcess(spawnImpl, ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { signal, timeoutMs: 60000 });
        if (res.code !== 0) throw Object.assign(new Error('ffprobe could not read the video'), { code: 'media.unreadable' });
        let j;
        try { j = JSON.parse(res.stdout || '{}'); } catch { throw Object.assign(new Error('ffprobe gave no answer'), { code: 'media.unreadable' }); }
        const streams = Array.isArray(j.streams) ? j.streams : [];
        const v = streams.find((s) => s.codec_type === 'video');
        const a = streams.find((s) => s.codec_type === 'audio');
        const format = j.format || {};
        return {
            duration_s: r2(Number(format.duration) || 0),
            size_bytes: Number(format.size) || 0,
            video: v ? {
                codec: String(v.codec_name || ''), width: Number(v.width) || 0, height: Number(v.height) || 0,
                fps: parseRate(v.avg_frame_rate || v.r_frame_rate) || 0, rotation: rotationOf(v),
            } : null,
            audio: a ? {
                codec: String(a.codec_name || ''), sample_rate: Number(a.sample_rate) || 0, channels: Number(a.channels) || 0,
            } : null,
        };
    }

    /** The times the picture changes (the scene cuts), in seconds. */
    async function sceneTimes(file, { threshold = 0.3, signal = null, duration = 0 } = {}) {
        const filter = "select='gt(scene," + threshold + ")',metadata=print";
        const args = ['-hide_banner', '-nostats', '-nostdin', '-i', file, '-an', '-filter:v', filter, '-f', 'null', '-'];
        const res = await runProcess(spawnImpl, ffmpeg, args, { signal, timeoutMs: 900000 });
        if (res.code !== 0) throw Object.assign(new Error('ffmpeg could not read the video'), { code: 'media.unreadable' });
        const out = [];
        const seen = new Set();
        for (const line of String(res.stderr || '').split('\n')) {
            const m = /pts_time:([\d.]+)/.exec(line);
            if (!m) continue;
            const t = r2(Number(m[1]));
            if (!Number.isFinite(t) || t < 0 || (duration && t >= duration)) continue;
            if (seen.has(t)) continue;
            seen.add(t);
            out.push(t);
        }
        return out.sort((a, b) => a - b);
    }

    /** The picture at t, small, as a JPEG at the path it is given. */
    async function frame(file, t, out, { signal = null, width = 640, quality = 5 } = {}) {
        const vf = 'scale=' + width + ':-2';
        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', vf, '-q:v', String(quality), '-f', 'image2', '-y', out];
        const res = await runProcess(spawnImpl, ffmpeg, args, { signal, timeoutMs: 120000 });
        if (res.code !== 0 || !fs.existsSync(out)) throw Object.assign(new Error('ffmpeg could not take the frame at ' + t + 's'), { code: 'media.unreadable' });
        return out;
    }

    /** The audio of one window, 16 kHz mono, a WAV. Nothing else: the speech route wants speech. */
    async function audio(file, out, { signal = null, startSec = 0, seconds = 0 } = {}) {
        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
        if (startSec) args.push('-ss', String(startSec));
        if (seconds) args.push('-t', String(seconds));
        args.push('-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', '-y', out);
        const res = await runProcess(spawnImpl, ffmpeg, args, { signal, timeoutMs: 900000 });
        if (res.code !== 0 || !fs.existsSync(out)) throw Object.assign(new Error('ffmpeg could not extract the audio'), { code: 'media.unreadable' });
        return out;
    }

    return { probe, sceneTimes, frame, audio, run: (bin, args, opts) => runProcess(spawnImpl, bin, args, opts) };
}

module.exports = { createFfmpeg, parseRate, rotationOf, runProcess };
