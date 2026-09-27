'use strict';
/**
 * Local-first media analysis (roadmap WS-O task 5): the `media_analysis` step behind the workflow media.analyze.
 *
 *   1. Signals: one FFmpeg pass over the fetched file (nice 15; video decoded at keyframes only and scaled small):
 *      scene changes (scdet), black and frozen picture (blackdetect, freezedetect), silence (silencedetect) and
 *      loudness (ebur128: the programme's integrated level and range, the momentary level per second).
 *   2. Scenes: the scene changes, as scenes with a start and an end.
 *   3. Speech: whisper.cpp on this host (route live.stt), when it is installed.
 *   4. Highlights: 30-second windows scored by loudness above the programme's typical level (the median second: one
 *      loud burst would drag the gated integrated level up with it), scene changes and speech.
 *      Each carries its reasons and its transcript excerpt: nothing is asserted without the evidence for it.
 *   5. Overview: a local model (route media.local, AI_LOCAL_LLM_URL) when one is configured, else extractive (the
 *      signals and the transcript, no model). A paid provider (route media.paid) only when the caller allows it
 *      (allow_paid) AND a quota gives it a daily cost budget (workflow_prefix `media.paid`, max_cost_usd > 0) that
 *      today's media.* spend has not used up. The output says which one wrote the overview, and lists what is missing.
 *
 * One analysis runs at a time on this host; the others wait their turn.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { AiError } = require('../util');
const { render } = require('../templates');

const WINDOW = 30;             // highlight window, seconds
const LOUD_LU = 6;             // "loud": the momentary level this far above the programme's typical (median) level
const LIMIT = { changes: 300, scenes: 300, black: 200, frozen: 200, silence: 500, peaks: 50, minutes: 600, highlights: 10, segments: 5000, text: 200000 };
const r2 = (n) => Math.round(n * 100) / 100;
const clock = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + `:${String(x).padStart(2, '0')}`; };

/** A line-by-line parser of the filters' log (a long VOD logs tens of MB, so it is never buffered whole). */
function createSignalParser() {
    const out = { scene_changes: [], black: [], frozen: [], silence: [], integrated: null, range: null };
    const perSecond = new Map();   // second -> the loudest momentary level in it
    let silenceStart = null; let freezeStart = null; let summary = false;
    function line(l) {
        let m;
        if ((m = /lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*([\d.]+)/.exec(l))) out.scene_changes.push({ t: r2(+m[2]), score: r2(+m[1]) });
        else if ((m = /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/.exec(l))) out.black.push({ start: r2(+m[1]), end: r2(+m[2]) });
        else if ((m = /freezedetect\.freeze_start:\s*([\d.]+)/.exec(l))) freezeStart = +m[1];
        else if ((m = /freezedetect\.freeze_end:\s*([\d.]+)/.exec(l))) { if (freezeStart != null) out.frozen.push({ start: r2(freezeStart), end: r2(+m[1]) }); freezeStart = null; }
        else if ((m = /silence_start:\s*(-?[\d.]+)/.exec(l))) silenceStart = Math.max(0, +m[1]);
        else if ((m = /silence_end:\s*([\d.]+)/.exec(l))) { out.silence.push({ start: r2(silenceStart == null ? 0 : silenceStart), end: r2(+m[1]) }); silenceStart = null; }
        else if ((m = /\bt:\s*([\d.]+)\s+TARGET:.*?\bM:\s*(-?[\d.]+)/.exec(l))) {
            const sec = Math.floor(+m[1]); const v = +m[2];
            if (v > -70) perSecond.set(sec, Math.max(perSecond.has(sec) ? perSecond.get(sec) : -Infinity, v));
        } else if (/ebur128/.test(l) && /Summary:/.test(l)) summary = true;
        else if (summary && (m = /^\s*I:\s*(-?[\d.]+)\s*LUFS/.exec(l))) out.integrated = +m[1];
        else if (summary && (m = /^\s*LRA:\s*([\d.]+)\s*LU\b/.exec(l))) { out.range = +m[1]; summary = false; }
    }
    /** duration: what was analysed; an open silence or freeze runs to its end. */
    function finish(duration) {
        if (silenceStart != null && duration > silenceStart) out.silence.push({ start: r2(silenceStart), end: r2(duration) });
        if (freezeStart != null && duration > freezeStart) out.frozen.push({ start: r2(freezeStart), end: r2(duration) });
        const seconds = [...perSecond.entries()].sort((a, b) => a[0] - b[0]);
        const integrated = out.integrated != null && out.integrated > -70 ? out.integrated : null;
        const levels = seconds.map(([, v]) => v).filter((v) => v > -55).sort((a, b) => a - b);   // audible seconds only
        const typical = levels.length ? levels[Math.floor(levels.length / 2)] : null;
        // Loud moments: seconds well above the programme's typical level, merged when under 3 s apart.
        const peaks = [];
        if (typical != null) {
            for (const [s, v] of seconds) {
                if (v < typical + LOUD_LU || v < -40) continue;
                const last = peaks[peaks.length - 1];
                if (last && s - last.end <= 3) { last.end = s + 1; last.lufs = Math.max(last.lufs, v); } else peaks.push({ start: s, end: s + 1, lufs: v });
            }
        }
        const minutes = [];
        for (const [s, v] of seconds) { const i = Math.floor(s / 60); if (i < LIMIT.minutes) minutes[i] = minutes[i] == null ? v : Math.max(minutes[i], v); }
        for (let i = 0; i < minutes.length; i++) if (minutes[i] === undefined) minutes[i] = null;
        return {
            scene_changes: out.scene_changes.slice(0, 20000),
            black: out.black.slice(0, LIMIT.black), frozen: out.frozen.slice(0, LIMIT.frozen), silence: out.silence.slice(0, LIMIT.silence),
            loudness: {
                integrated_lufs: integrated, range_lu: integrated != null ? out.range : null, typical_lufs: typical == null ? null : r2(typical),
                peaks: peaks.sort((a, b) => b.lufs - a.lufs).slice(0, LIMIT.peaks).sort((a, b) => a.start - b.start).map((p) => ({ start: p.start, end: p.end, lufs: r2(p.lufs) })),
                per_minute: minutes.map((v) => (v == null ? null : r2(v))),
            },
            _perSecond: perSecond,
        };
    }
    return { line, finish };
}

function parseSignals(text, duration) {
    const p = createSignalParser();
    String(text).split('\n').forEach(p.line);
    return p.finish(duration);
}

/** Scene changes -> scenes. More changes than the limit: the strongest become the boundaries. */
function scenesOf(changes, duration) {
    let cuts = changes.filter((c) => c.t > 0.5 && c.t < duration - 0.5);
    if (cuts.length > LIMIT.scenes - 1) cuts = cuts.slice().sort((a, b) => b.score - a.score).slice(0, LIMIT.scenes - 1);
    const at = [0, ...cuts.map((c) => c.t).sort((a, b) => a - b), duration];
    const out = [];
    for (let i = 0; i < at.length - 1; i++) if (at[i + 1] - at[i] >= 1 || !out.length) out.push({ start: r2(at[i]), end: r2(at[i + 1]) });
    return out;
}

function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

/** Overlapping spans merged, so a second that is both black and silent counts once. */
function union(spans) {
    const out = [];
    for (const x of spans.slice().sort((a, b) => a.start - b.start)) {
        const last = out[out.length - 1];
        if (last && x.start <= last.end) last.end = Math.max(last.end, x.end); else out.push({ start: x.start, end: x.end });
    }
    return out;
}

/** Windows (30 s, or a quarter of a short clip; every half window) scored by loudness, scene changes and speech; the best that do not overlap. */
function highlightsOf({ duration, signals, perSecond, segments }) {
    const I = signals.loudness.typical_lufs;
    const dead = union([...signals.black, ...signals.frozen, ...signals.silence]);
    const W = Math.max(5, Math.min(WINDOW, duration / 4));
    const cands = [];
    for (let s = 0; s < Math.max(duration - W / 2, 0.001); s += W / 2) {
        const e = Math.min(duration, s + W);
        const len = e - s;
        if (len < Math.min(5, W)) break;
        const reasons = []; let score = 0;
        if (I != null && perSecond) {
            let max = -Infinity;
            for (let t = Math.floor(s); t < e; t++) if (perSecond.has(t)) max = Math.max(max, perSecond.get(t));
            if (max >= I + LOUD_LU && max > -40) { score += Math.min(3, (max - I) / LOUD_LU); reasons.push('loud'); }
        }
        const cuts = signals.scene_changes.filter((c) => c.t >= s && c.t < e).length;
        if (cuts >= 2) { score += Math.min(2, cuts * 0.5); reasons.push('scene changes'); }
        const words = segments.reduce((n, g) => n + (overlap(s, e, g.start, g.end) > 0 ? g.text.split(/\s+/).filter(Boolean).length : 0), 0);
        if (words / len >= 1.5) { score += 1; reasons.push('speech'); }
        const still = dead.reduce((n, d) => n + overlap(s, e, d.start, d.end), 0);
        if (still / len > 0.5 || !score) continue;
        const excerpt = segments.filter((g) => overlap(s, e, g.start, g.end) > 0).map((g) => g.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 300);
        cands.push({ start: r2(s), end: r2(e), score: r2(score), reasons, excerpt });
    }
    const picked = [];
    for (const c of cands.sort((a, b) => b.score - a.score || a.start - b.start)) {
        if (picked.length >= LIMIT.highlights) break;
        if (!picked.some((p) => overlap(p.start, p.end, c.start, c.end) > 0)) picked.push(c);
    }
    return picked.sort((a, b) => a.start - b.start);
}

function speechRatio(segments, duration) {
    if (!duration) return null;
    let t = 0; let last = 0;
    for (const g of segments.slice().sort((a, b) => a.start - b.start)) { const s = Math.max(g.start, last); if (g.end > s) { t += g.end - s; last = g.end; } }
    return r2(Math.min(1, t / duration));
}

/** What the model (or the extractive overview) works from: facts only, in plain lines. */
function factsOf({ duration, streams, signals, scenes, highlights, ratio, transcript }) {
    const lines = [`Length analysed: ${clock(duration)}.`, `Streams: ${[streams.video && 'video', streams.audio && 'audio'].filter(Boolean).join(' and ') || 'none'}.`];
    if (streams.video) lines.push(`Scenes: ${scenes.length}${signals.black.length ? `; black picture ${signals.black.length} time(s)` : ''}${signals.frozen.length ? `; frozen picture ${signals.frozen.length} time(s)` : ''}.`);
    if (streams.audio) {
        const quiet = signals.silence.reduce((n, x) => n + (x.end - x.start), 0);
        lines.push(`Silence: ${Math.round((quiet / Math.max(duration, 1)) * 100)}% of the time.${signals.loudness.integrated_lufs != null ? ` Programme loudness ${signals.loudness.integrated_lufs} LUFS.` : ''}`);
    }
    if (ratio != null) lines.push(`Speech: ${Math.round(ratio * 100)}% of the time (${transcript.language}).`);
    if (signals.loudness.peaks.length) lines.push(`Loudest moments: ${signals.loudness.peaks.slice().sort((a, b) => b.lufs - a.lufs).slice(0, 5).map((p) => clock(p.start)).join(', ')}.`);
    return lines;
}

function extractive(facts, highlights) {
    const parts = [facts.join(' ')];
    const quoted = highlights.filter((h) => h.excerpt).slice(0, 3);
    if (quoted.length) parts.push(`Highlights: ${quoted.map((h) => `${clock(h.start)}–${clock(h.end)} (${h.reasons.join(', ')}): "${h.excerpt.slice(0, 160)}"`).join('; ')}.`);
    else if (highlights.length) parts.push(`Highlights: ${highlights.slice(0, 5).map((h) => `${clock(h.start)}–${clock(h.end)} (${h.reasons.join(', ')})`).join('; ')}.`);
    return parts.join(' ').slice(0, 1500);
}

function createMediaAnalysis({ registry, pool, fetcher, quotas, config = {}, spawnImpl = spawn, log = console }) {
    const ma = config.mediaAnalysis || {};
    const ffmpeg = ma.ffmpeg || 'ffmpeg';
    const ffprobe = ma.ffprobe || 'ffprobe';
    let turn = Promise.resolve();   // one analysis at a time
    const workDir = ma.workDir || require('os').tmpdir();
    let pruned = false;
    /** The work directory, made on first use; files a crash left behind (older than a day) are removed then. */
    function work() {
        fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
        if (!pruned) {
            pruned = true;
            for (const f of fs.readdirSync(workDir)) {
                if (!f.startsWith('openvibe-ai-media-')) continue;
                const p = path.join(workDir, f);
                try { if (Date.now() - fs.statSync(p).mtimeMs > 86400000) fs.unlinkSync(p); } catch { /* */ }
            }
        }
        return workDir;
    }

    function run(bin, args, { signal, timeoutMs, onLine }) {
        return new Promise((resolve, reject) => {
            let ch; let out = ''; let buf = '';
            try { ch = spawnImpl('nice', ['-n', '15', bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return reject(new AiError(503, 'media.tool_unavailable', `${bin}: ${e.message}`)); }
            const kill = () => { try { ch.kill('SIGKILL'); } catch { /* */ } };
            const timer = setTimeout(kill, timeoutMs);
            if (signal) signal.addEventListener('abort', kill, { once: true });
            ch.stdout.on('data', (c) => { if (out.length < 1e6) out += c; });
            ch.stderr.on('data', (c) => {
                if (!onLine) return;
                buf += c;
                let i;
                while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
            });
            ch.on('error', (e) => { clearTimeout(timer); reject(new AiError(503, 'media.tool_unavailable', `${bin}: ${e.message}`)); });
            ch.on('close', (code) => {
                clearTimeout(timer);
                if (buf && onLine) onLine(buf);
                if (signal && signal.aborted) return reject(new AiError(499, 'run.cancelled', 'cancelled'));
                if (code !== 0) return reject(new AiError(422, 'media.unreadable', `${bin} could not read the media (exit ${code})`));
                resolve(out);
            });
        });
    }

    async function probe(file, signal) {
        const raw = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { signal, timeoutMs: 60000 });
        let j; try { j = JSON.parse(raw); } catch { throw new AiError(422, 'media.unreadable', 'ffprobe gave no answer'); }
        const types = (j.streams || []).map((s) => s.codec_type);
        return { duration: Number(j.format && j.format.duration) || 0, video: types.includes('video'), audio: types.includes('audio') };
    }

    async function signalsOf(file, { duration, streams, seconds, signal }) {
        const graph = [];
        if (streams.video) graph.push(`[0:v:0]scale=160:-2,scdet=threshold=${ma.sceneThreshold || 10},blackdetect=d=1:pix_th=0.10,freezedetect=n=-60dB:d=4[vo]`);
        if (streams.audio) graph.push('[0:a:0]silencedetect=n=-35dB:d=2,ebur128[ao]');
        if (!graph.length) return null;
        const args = ['-hide_banner', '-nostats', '-nostdin'];
        if (seconds) args.push('-t', String(seconds));
        if (streams.video) args.push('-skip_frame', 'nokey');
        args.push('-i', file, '-filter_complex', graph.join(';'));
        if (streams.video) args.push('-map', '[vo]', '-f', 'null', '-');
        if (streams.audio) args.push('-map', '[ao]', '-f', 'null', '-');
        const parser = createSignalParser();
        // Keyframe decoding is quick; allow a minute plus a quarter of the programme, at most 30 minutes.
        await run(ffmpeg, args, { signal, onLine: parser.line, timeoutMs: Math.min(30 * 60000, 60000 + duration * 250) });
        return parser.finish(duration);
    }

    /** A quota with workflow_prefix `media.paid` and a cost cap: today's media.* spend must be under it. */
    function paidBudget() {
        return quotas && quotas.paidBudget ? quotas.paidBudget('media.paid', 'media.') : null;
    }

    /** Refuse before downloading when the temp disk could not hold the file (a full disk stops every service). */
    function roomFor(dir) {
        let free = Infinity;
        try { const st = fs.statfsSync(dir); free = st.bavail * st.bsize; } catch { /* no statfs: trust the byte cap */ }
        const reserve = ma.reserveBytes == null ? 3 * 1024 ** 3 : ma.reserveBytes;
        const room = free - reserve;
        if (room < 64 * 1024 ** 2) throw new AiError(503, 'media.no_space', 'not enough free disk to analyse media right now');
        return Math.min(ma.maxBytes || 4 * 1024 ** 3, room);
    }

    async function overview({ step, input, wf, run: runRow, ctx, facts, highlights, transcript, gaps }) {
        const template = registry.activeTemplate(step.template || 'media.analyze.overview');
        const vars = {
            facts: facts.join('\n'),
            highlights: highlights.map((h) => `${clock(h.start)}–${clock(h.end)} [${h.reasons.join(', ')}] ${h.excerpt}`).join('\n') || '(none)',
            transcript: (transcript.text || '').slice(0, 8000) || '(no transcript)',
        };
        const call = async (routeKey) => {
            const route = registry.resolveRoute(routeKey);
            if (!route || route.disabled) return { missing: true };
            const system = render(template.system_prompt, vars).trim();
            const req = { system: [{ text: system, cache: true }], messages: [{ role: 'user', content: render(template.user_prompt, vars) }], image: null, json: null, maxTokens: 350, temperature: 0.3, timeoutMs: route.timeout_ms || 120000, cacheKey: `${wf.key}:${wf.version}` };
            const exec = await pool.execute(route, 'summarize', req, { ...ctx, routeKey: route.key, routeVersion: route.version, promptHash: null });
            const text = String(exec.result.text || '').trim();
            if (!text) throw new AiError(502, 'output.empty', 'the model answered with nothing');
            return { text: text.slice(0, 1500), exec, route };
        };
        if (template) {
            try {
                const local = await call(step.local_route || 'media.local');
                if (!local.missing) return { overview: { text: local.text, source: 'local_model', provider: local.exec.provider, model: local.exec.model }, exec: local.exec, route: local.route };
                gaps.push('No local model is configured (AI_LOCAL_LLM_URL), so a model did not write this overview.');
            } catch (e) {
                gaps.push(`The local model did not answer (${e.code || e.message}).`);
            }
            if (input.allow_paid) {
                const budget = paidBudget();
                if (!budget) gaps.push('Paid providers are off for media analysis: no quota gives media.paid a cost budget.');
                else if (budget.spent >= budget.max_cost_usd) gaps.push(`Today's paid budget for media analysis ($${budget.max_cost_usd}) is spent.`);
                else {
                    try {
                        const paid = await call(step.paid_route || 'media.paid');
                        if (!paid.missing) return { overview: { text: paid.text, source: 'paid', provider: paid.exec.provider, model: paid.exec.model }, exec: paid.exec, route: paid.route };
                        gaps.push('No paid route (media.paid) is configured.');
                    } catch (e) { gaps.push(`The paid provider did not answer (${e.code || e.message}).`); }
                }
            }
        } else gaps.push('The overview template media.analyze.overview is missing.');
        return { overview: { text: extractive(facts, highlights), source: 'extractive' } };
    }

    async function step(stepDef, input, wf, runRow, ctx) {
        const mine = turn.then(() => analyse(stepDef, input, wf, runRow, ctx));
        turn = mine.catch(() => {});
        return mine;
    }

    async function analyse(stepDef, input, wf, runRow, ctx) {
        const gaps = [];
        const dir = work();
        const { file } = await fetcher.loadMediaToFile(input, { signal: ctx.signal, maxBytes: roomFor(dir), timeoutMs: ma.fetchTimeoutMs, dir });
        try {
            const info = await probe(file, ctx.signal);
            if (!info.video && !info.audio) throw new AiError(422, 'media.unreadable', 'the file has no audio or video stream');
            const seconds = input.seconds ? Math.min(input.seconds, info.duration || input.seconds) : 0;
            const duration = r2(seconds || info.duration);
            const streams = { video: info.video, audio: info.audio };
            const sig = await signalsOf(file, { duration, streams, seconds, signal: ctx.signal });
            const perSecond = sig._perSecond; delete sig._perSecond;
            const signals = { ...sig, scene_changes: sig.scene_changes.slice().sort((a, b) => b.score - a.score).slice(0, LIMIT.changes).sort((a, b) => a.t - b.t) };
            const scenes = streams.video ? scenesOf(sig.scene_changes, duration) : [];
            if (!streams.video) gaps.push('No video stream: no scenes, black or frozen picture.');
            if (!streams.audio) gaps.push('No audio stream: no loudness, silence or speech.');

            let transcript = { available: false, language: input.language || 'en', text: '', segments: [] };
            let sttExec = null;
            if (streams.audio) {
                const route = registry.resolveRoute(stepDef.stt_route || 'live.stt');
                if (!route || route.disabled) gaps.push('No speech-to-text route (live.stt): no transcript.');
                else {
                    try {
                        sttExec = await pool.execute(route, 'transcribe', { filePath: file, language: input.language || 'en', seconds: seconds || 0, offsetSec: 0, timeoutMs: 3600000 }, { ...ctx, routeKey: route.key, routeVersion: route.version, promptHash: null });
                        const r = sttExec.result;
                        const segments = (r.segments || []).slice(0, LIMIT.segments).map((g) => ({ start: r2(g.start), end: r2(g.end), text: String(g.text || '').slice(0, 2000) }));
                        transcript = { available: true, language: r.language || input.language || 'en', text: String(r.text || '').slice(0, LIMIT.text), segments };
                    } catch (e) {
                        if (ctx.signal && ctx.signal.aborted) throw e;
                        gaps.push(`Speech-to-text did not run (${e.code || e.message}): no transcript.`);
                    }
                }
            }
            const ratio = transcript.available ? speechRatio(transcript.segments, duration) : null;
            const highlights = highlightsOf({ duration, signals, perSecond, segments: transcript.segments });
            const facts = factsOf({ duration, streams, signals, scenes, highlights, ratio, transcript });
            const ov = await overview({ step: stepDef, input, wf, run: runRow, ctx, facts, highlights, transcript, gaps });
            const output = {
                duration_seconds: r2(info.duration), analyzed_seconds: duration, streams,
                signals, scenes, transcript, speech_ratio: ratio, highlights, overview: ov.overview, gaps: gaps.slice(0, 20),
            };
            // The run's provider: the model that wrote the overview, else the speech-to-text engine that ran.
            return { output, exec: ov.exec || sttExec || null, route: ov.route || null };
        } finally {
            try { fs.unlinkSync(file); } catch { /* */ }
        }
    }

    return { step };
}

module.exports = { createMediaAnalysis, createSignalParser, parseSignals, scenesOf, highlightsOf, speechRatio, extractive, clock };
