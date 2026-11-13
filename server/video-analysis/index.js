'use strict';
/**
 * video.analyze: the AI reads a video (the owner's 11-13, plan Z.9 step 4).
 *
 * One run, seven steps, each one recorded with what it cost:
 *
 *   probe       ffprobe: the duration, the size, the codecs, the frame rate, the rotation
 *   keyframes   ffmpeg: the scene cuts (a threshold over the picture changes) plus one frame every
 *               30 s, at most 12 (quick), 32 (standard) or 96 (deep); each frame is a small JPEG kept
 *               as the run's artifact
 *   transcript  the speech route (Deepgram, Parakeet or whisper.cpp, the router picks): the audio is
 *               cut to 16 kHz mono and read in windows of ten minutes, so a long video is read in
 *               chunks and one failed window costs that window only. A video without sound has no
 *               transcript, and the run says so
 *   describe    the vision route reads every keyframe: what is shown in it and the text on screen
 *   analyse     one model writes the chapters, the summary, the people, objects and places that were
 *               named (only what was shown or said, with the time it was seen or heard), the tags and
 *               the answer to the question that was asked
 *   explicit    the house rule on explicit content (the same one Live keeps for clips): fine, sex acts
 *               or sexual content involving a minor
 *   report      ai.video-analysis@1, assembled here from what the tools found, with the receipt
 *
 * A step that fails leaves a named gap; nothing is ever made up. A video without sound, a video whose
 * frames could not be taken, a model that did not answer: each is said, and the rest of the run goes on.
 */
const fs = require('fs');
const path = require('path');
const { AiError } = require('../util');
const schemas = require('../schemas');
const events = require('../events');
const { createVideoAnalysisStore } = require('./store');
const { createLlm } = require('./llm');
const { createFfmpeg } = require('./ffmpeg');
const { createSource } = require('./source');
const { classifyText } = require('./explicit');
const prompts = require('./prompts');
const { STEPS, REPORT, FRAME_OUTPUT, ANALYSIS_OUTPUT } = require('./schema');

const r2 = (n) => Math.round(n * 100) / 100;
const iso = (v) => (v ? new Date(v).toISOString() : null);
const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

/** The person the run acts for: the row keeps it as JSON. */
function ownerOf(run) {
    if (!run) return null;
    const raw = run.on_behalf_of;
    if (!raw) return null;
    try { const o = typeof raw === 'string' ? JSON.parse(raw) : raw; return o && o.id ? { type: o.type || 'user', id: String(o.id) } : null; } catch { return null; }
}

/**
 * The frames to take: every scene cut, plus one frame every 30 s, spread over the video when there are
 * more of them than the depth allows. The first and the last frame are kept.
 */
function pickTimes({ sceneTimes = [], duration = 0, everySec = 30, cap = 12 }) {
    const set = new Set();
    const add = (t) => { const v = r2(Number(t)); if (Number.isFinite(v) && v >= 0 && v < duration) set.add(v); };
    add(0);
    for (let t = everySec; t < duration; t += everySec) add(t);
    for (const t of sceneTimes) add(t);
    let times = [...set].sort((a, b) => a - b);
    if (times.length > cap) {
        const out = [];
        const last = times.length - 1;
        for (let i = 0; i < cap; i++) out.push(times[Math.round((i * last) / (cap - 1))]);
        times = [...new Set(out)];
    }
    return times;
}

/** The words of one window: the provider's own word times when it has them, its segment times otherwise. */
function wordsOf(segments, offsetSec = 0) {
    const out = [];
    for (const seg of segments || []) {
        const list = Array.isArray(seg.words) && seg.words.length ? seg.words : [seg];
        for (const w of list) {
            const t0 = Number(w.start); const t1 = Number(w.end);
            const text = String(w.text == null ? w.word : w.text).trim();
            if (!text || !Number.isFinite(t0) || !Number.isFinite(t1)) continue;
            out.push({ t0: r2(t0 + offsetSec), t1: r2(t1 + offsetSec), w: text.slice(0, 200) });
        }
    }
    return out.sort((a, b) => a.t0 - b.t0);
}

/** The named people, objects and places that the frames or the transcript actually show or say. */
function verifyEntities(entities, { frames = [], transcriptText = '', duration = 0 } = {}) {
    const haystack = (frames.map((f) => (f.caption || '') + ' ' + (f.text || '')).join(' \n ') + ' \n ' + (transcriptText || '')).toLowerCase();
    const kept = []; const dropped = [];
    for (const e of entities || []) {
        const name = oneLine(e && e.name, 200);
        if (!name) continue;
        const said = name.length >= 2 && haystack.includes(name.toLowerCase());
        const evidence = (e.evidence || [])
            .filter((x) => x && Number.isFinite(Number(x.t)) && Number(x.t) >= 0 && Number(x.t) <= duration + 1)
            .map((x) => ({ t: r2(Number(x.t)), from: x.from === 'speech' ? 'speech' : 'frame' }));
        if (!said || !evidence.length) { dropped.push(name + (said ? ' (no time in the video)' : ' (not shown or said)')); continue; }
        kept.push({ name, kind: ['person', 'object', 'place', 'organization', 'other'].includes(e.kind) ? e.kind : 'other', evidence: evidence.slice(0, 20) });
    }
    return { entities: kept, dropped };
}

/** The chapters, in order and inside the video. */
function verifyChapters(chapters, duration) {
    const out = [];
    for (const c of chapters || []) {
        if (!c) continue;
        let start = Number(c.start); let end = Number(c.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        start = Math.max(0, Math.min(duration, start));
        end = Math.max(0, Math.min(duration, end));
        const title = oneLine(c.title, 200);
        if (!title || end <= start) continue;
        out.push({ start: r2(start), end: r2(end), title });
    }
    return out.sort((a, b) => a.start - b.start);
}

function createVideoAnalysis({ config = {}, db, clock = { now: () => Date.now() }, log = console, registry, pool, mediaStore = null, fetcher = null, spawnImpl = null, fetchImpl = globalThis.fetch } = {}) {
    const cfg = config.videoAnalysis || {};
    const store = createVideoAnalysisStore({ db, clock, log });
    const llm = createLlm({ registry, pool, config, log, clock });
    const ffmpeg = createFfmpeg({ ffmpeg: cfg.ffmpeg || 'ffmpeg', ffprobe: cfg.ffprobe || 'ffprobe', spawnImpl: spawnImpl || require('child_process').spawn, log });
    const source = createSource({ config, mediaStore, fetchImpl, log });

    const prices = cfg.pricePerMinute || { quick: 0.02, standard: 0.06, deep: 0.2 };
    const floors = cfg.priceMinUsd || { quick: 0.05, standard: 0.2, deep: 0.6 };
    const caps = cfg.frameCaps || { quick: 12, standard: 32, deep: 96 };

    /** What a depth costs: the price per minute of video, with a floor per depth. */
    function priceOf(depth, minutes) {
        const rate = Number(prices[depth]);
        const floor = Number(floors[depth]);
        if (!Number.isFinite(rate)) return 0;
        const max = Number(cfg.priceMaxUsd) || 60;
        const raw = Math.max(Number.isFinite(floor) ? floor : 0, rate * Math.max(0, Number(minutes) || 0));
        return Math.round(Math.min(max, raw) * 1e6) / 1e6;
    }

    /** The three depths, what they read and what they cost. */
    function depths() {
        return Object.keys(caps).map((depth) => ({
            key: depth,
            label: depth.charAt(0).toUpperCase() + depth.slice(1),
            frames: caps[depth],
            price_usd_per_minute: Number(prices[depth]) || 0,
            price_usd_min: Number(floors[depth]) || 0,
            frame_every_sec: Number(cfg.frameEverySec) || 30,
            transcript_window_sec: Number(cfg.sttWindowSec) || 600,
        }));
    }

    async function emit(row, { step = null, status = null, error = null, requester = null } = {}) {
        try {
            await events.videoAnalysisUpdated({
                runId: row.run_id || row.id, analysisId: row.id, status: status || row.status,
                step: step == null ? row.step : step, progress: row.progress, steps: row.steps, depth: row.depth,
                requester: requester || { type: 'service', id: 'ai' },
                on_behalf_of: row.owner || null,
                url: 'https://openvibe.exchange/video-analysis/' + (row.run_id || row.id),
                error,
            });
        } catch (err) { log.warn('[video-analysis] event failed: ' + String((err && err.message) || err).slice(0, 160)); }
    }

    async function startStep(row, key, detail, progress, requester = null) {
        const steps = store.stepsWith(row, { [key]: { status: 'running', detail: oneLine(detail, 300), started_at: iso(clock.now()) } }, STEPS);
        const next = await store.patch(row.id, { steps, step: key, progress, status: row.status === 'queued' ? 'running' : row.status });
        if (next) await emit(next, { step: key, status: next.status, requester });
        return next;
    }

    async function finishStep(row, key, progress, detail = null, status = 'done', requester = null) {
        const steps = store.stepsWith(row, { [key]: { status, detail: detail == null ? null : oneLine(detail, 300), finished_at: iso(clock.now()) } }, STEPS);
        const next = await store.patch(row.id, { steps, step: key, progress });
        if (next) await emit(next, { step: key, status: next.status, requester });
        return next;
    }

    /** Run one video analysis for one run row. */
    async function run({ run, input, ctx = {} }) {
        const depth = ['quick', 'standard', 'deep'].includes(input.depth) ? input.depth : 'standard';
        const runId = run.id;
        const owner = ownerOf(run);
        // Who asked for it: the service that started the run, or the person it acts for.
        const requester = run && run.requester_type ? { type: run.requester_type, id: run.requester_id || 'ai' } : { type: 'service', id: 'ai' };
        const models = [];
        const gaps = [];
        const stepReceipt = [];
        let usage = { input: 0, output: 0 };
        let cost = 0;
        let synthetic = false;
        const addCall = (step, r) => {
            if (!r) return;
            models.push({ step, provider: r.provider || null, model: r.model || null, tokens_in: r.tokens_in || 0, tokens_out: r.tokens_out || 0, cost_usd: Number(r.cost_usd) || 0 });
            if (r.synthetic) synthetic = true;
            usage = { input: usage.input + (r.tokens_in || 0), output: usage.output + (r.tokens_out || 0) };
            cost += Number(r.cost_usd) || 0;
        };
        const check = () => { if (ctx.signal && ctx.signal.aborted) throw new AiError(409, 'run.cancelled', 'cancelled'); };
        const note = (key, status, detail, ms) => { stepReceipt.push({ key, status, detail: detail == null ? null : oneLine(detail, 300), cost_usd: 0, ms: Math.max(0, Math.round(ms || 0)) }); };

        let row = await store.ensure({ runId, input, depth, mediaId: input.media_id || null, owner });
        if (!row) throw new AiError(500, 'video_analysis.not_stored', 'the video analysis row could not be written');

        const dir = source.workDir();
        const runDir = path.join(dir, runId);
        fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
        let file = null;

        try {
            // 1. Probe
            row = await startStep(row, 'probe', 'measuring the video', 0.03, requester);
            check();
            const t0 = clock.now();
            const got = await source.resolve(input, { owner: owner && owner.id, dir: runDir, signal: ctx.signal });
            file = got.file;
            let probe;
            try {
                probe = await ffmpeg.probe(file, { signal: ctx.signal });
            } catch (err) {
                // A host with no ffprobe, or a file ffprobe cannot read: both are named reasons, never an
                // internal error, so the caller knows whether to retry, fix the service or change the video.
                if (err && err.code === 'tool.unavailable') throw new AiError(503, 'video_analysis.tool_unavailable', 'ffprobe is not installed on this service');
                if (err && err.code === 'media.unreadable') throw new AiError(422, 'media.unreadable', 'the video could not be read');
                throw err;
            }
            if (!probe.video && !probe.audio) throw new AiError(422, 'media.unreadable', 'the file has no audio or video stream');
            const duration = probe.duration_s;
            const maxMinutes = Number(cfg.maxMinutes) || 180;
            const analysed = Math.min(duration, maxMinutes * 60);
            if (analysed < duration) gaps.push('The video is longer than ' + maxMinutes + ' minutes; only its first ' + maxMinutes + ' minutes were read.');
            note('probe', 'done', duration + ' s, ' + (probe.video ? probe.video.width + 'x' + probe.video.height + ' ' + probe.video.codec : 'no picture') + ', ' + (probe.audio ? probe.audio.codec + ' audio' : 'no sound'), clock.now() - t0);
            row = await finishStep(row, 'probe', 0.08, duration + ' s', 'done', requester);

            // 2. Keyframes: the scene cuts and one frame every 30 s, capped by the depth.
            row = await startStep(row, 'keyframes', 'taking the frames', 0.1, requester);
            check();
            const cap = Math.max(1, Number(caps[depth]) || 12);
            const every = Math.max(1, Number(cfg.frameEverySec) || 30);
            const frames = [];
            let framesFailed = false;
            const t1 = clock.now();
            try {
                const cuts = await ffmpeg.sceneTimes(file, { threshold: Number(cfg.sceneThreshold) || 0.3, signal: ctx.signal, duration: analysed });
                const times = pickTimes({ sceneTimes: cuts, duration: analysed, everySec: every, cap });
                for (const [i, t] of times.entries()) {
                    check();
                    const out = path.join(runDir, 'frame-' + String(i).padStart(3, '0') + '.jpg');
                    await ffmpeg.frame(file, t, out, { signal: ctx.signal, width: Number(cfg.frameWidth) || 640 });
                    let mediaId = null;
                    if (mediaStore && typeof mediaStore.put === 'function' && mediaStore.configured && mediaStore.configured()) {
                        try {
                            const saved = await mediaStore.put({ bytes: fs.readFileSync(out), mime: 'image/jpeg', filename: 'frame-' + i + '.jpg', owner: owner && owner.id, visibility: 'private', metadata: { origin: 'ai.video-analysis', run_id: runId, t } });
                            mediaId = saved.media_id || null;
                        } catch (err) { gaps.push('The frame at ' + t + ' s could not be kept in Media (' + oneLine(err && err.message, 120) + ').'); }
                    }
                    frames.push({ t, media_id: mediaId, path: out, url: '/api/v1/video-analyses/' + runId + '/frames/' + i });
                    row = await store.patch(row.id, { frames: frames.map((f) => ({ t: f.t, media_id: f.media_id, url: f.url })) });
                }
                note('keyframes', 'done', frames.length + ' frames (at most ' + cap + ')', clock.now() - t1);
            } catch (err) {
                if (err && err.code === 'run.cancelled') throw err;
                gaps.push('The keyframes could not be taken (' + oneLine(err && (err.detail || err.message), 160) + '); no frame was read.');
                note('keyframes', 'failed', err && (err.detail || err.message), clock.now() - t1);
                framesFailed = true;
            }
            row = await finishStep(row, 'keyframes', 0.3, frames.length + ' frames', framesFailed ? 'failed' : 'done', requester);

            // 3. Transcript: the speech route, in windows of ten minutes.
            row = await startStep(row, 'transcript', 'listening to the video', 0.32, requester);
            check();
            const t2 = clock.now();
            const words = [];
            const texts = [];
            const langs = {};
            let transcript = { lang: 'und', words: [], text: '' };
            if (!probe.audio) {
                gaps.push('The video has no sound: there is no transcript.');
                note('transcript', 'skipped', 'no audio stream', clock.now() - t2);
            } else {
                const win = Math.max(30, Number(cfg.sttWindowSec) || 600);
                const route = await registry.resolveRoute(cfg.sttRoute || 'live.stt');
                if (!route || route.disabled) {
                    gaps.push('No speech-to-text route (' + (cfg.sttRoute || 'live.stt') + '): there is no transcript.');
                    note('transcript', 'skipped', 'no speech route', clock.now() - t2);
                } else {
                    const failed = [];
                    for (let start = 0; start < analysed; start += win) {
                        check();
                        const len = Math.min(win, analysed - start);
                        try {
                            const wav = path.join(runDir, 'audio-' + Math.round(start) + '.wav');
                            await ffmpeg.audio(file, wav, { signal: ctx.signal, startSec: start, seconds: len });
                            const exec = await pool.execute(route, 'transcribe', {
                                filePath: wav, language: input.language || 'auto', seconds: len, startSec: 0, offsetSec: 0, words: true, timeoutMs: 900000,
                            }, { ...ctx, routeKey: route.key, routeVersion: route.version, promptHash: null });
                            const res = exec.result || {};
                            if (res.language) langs[res.language] = (langs[res.language] || 0) + 1;
                            const w = wordsOf(res.segments, start);
                            words.push(...w);
                            if (res.text) texts.push(String(res.text));
                            try { fs.unlinkSync(wav); } catch { /* the work directory is cleaned at the end */ }
                        } catch (err) {
                            if (err && err.code === 'run.cancelled') throw err;
                            failed.push(Math.round(start) + '-' + Math.round(start + len) + ' s');
                        }
                    }
                    const lang = Object.keys(langs).sort((a, b) => langs[b] - langs[a])[0] || (input.language && input.language !== 'auto' ? input.language : 'und');
                    if (words.length || texts.length) {
                        transcript = { lang, words: words.slice(0, 20000), text: texts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200000) };
                    }
                    if (failed.length) gaps.push('Speech-to-text failed for ' + failed.slice(0, 5).join(', ') + (failed.length > 5 ? ' and ' + (failed.length - 5) + ' more' : '') + ' s; that part of the video has no words.');
                    if (!transcript.words.length && !failed.length) gaps.push('Nothing was said in the video: there is no transcript.');
                    note('transcript', transcript.words.length || transcript.text ? 'done' : 'failed', transcript.words.length + ' words', clock.now() - t2);
                }
            }
            row = await finishStep(row, 'transcript', 0.55, transcript.words.length + ' words', 'done', requester);

            // 4. Describe: the vision route reads every keyframe.
            row = await startStep(row, 'describe', 'reading the frames', 0.58, requester);
            check();
            const t3 = clock.now();
            const described = [];
            let readFrames = 0;
            for (const [i, f] of frames.entries()) {
                check();
                let caption = ''; let text = ''; let explicit = null;
                try {
                    const bytes = fs.readFileSync(f.path);
                    const image = fetcher && typeof fetcher.loadImage === 'function'
                        ? await fetcher.loadImage({ data_url: 'data:image/jpeg;base64,' + bytes.toString('base64'), max_width: 1024 }, { signal: ctx.signal })
                        : null;
                    const call = await llm.call({ routeKey: cfg.describeRoute || 'background.vision', ...prompts.framePrompt({ t: f.t, index: i + 1, total: frames.length }), image, schema: FRAME_OUTPUT, schemaName: 'video_frame', maxTokens: 600, signal: ctx.signal, ctx });
                    addCall('describe', call);
                    caption = oneLine(call.json && call.json.caption, 1200);
                    text = oneLine(call.json && call.json.text, 1200);
                    explicit = call.json && call.json.explicit ? call.json.explicit : null;
                    readFrames++;
                } catch (err) {
                    if (err && err.code === 'run.cancelled') throw err;
                    gaps.push('The frame at ' + f.t + ' s could not be read (' + oneLine(err && (err.detail || err.message), 160) + ').');
                }
                described.push({ t: f.t, url: f.url, caption, text, media_id: f.media_id || null, explicit });
            }
            note('describe', readFrames ? 'done' : 'failed', readFrames + ' of ' + frames.length + ' frames read', clock.now() - t3);
            row = await finishStep(row, 'describe', 0.82, readFrames + '/' + frames.length + ' frames', 'done', requester);

            // 5. Analyse: one model writes the chapters, the summary, the entities, the tags and the answer.
            row = await startStep(row, 'analyse', 'writing what the video is', 0.84, requester);
            check();
            const t4 = clock.now();
            let summary = ''; let chapters = []; let entities = []; let tags = []; let answer = null;
            try {
                const call = await llm.call({
                    routeKey: cfg.analyseRoute || 'background.json',
                    ...prompts.analysisPrompt({ probe, frames: described, transcript, ask: input.ask || null, duration: analysed }),
                    schema: ANALYSIS_OUTPUT, schemaName: 'video_analysis', maxTokens: Math.min(4000, Number(cfg.maxOutputTokens) || 3000), signal: ctx.signal, ctx,
                });
                addCall('analyse', call);
                const j = call.json || {};
                summary = oneLine(j.summary, 6000);
                chapters = verifyChapters(j.chapters, analysed);
                const checked = verifyEntities(j.entities, { frames: described, transcriptText: transcript.text, duration: analysed });
                entities = checked.entities;
                if (checked.dropped.length) gaps.push('Not named, because the video does not show or say them: ' + checked.dropped.slice(0, 10).join(', ') + '.');
                tags = (Array.isArray(j.tags) ? j.tags : []).map((t) => oneLine(t, 60)).filter(Boolean).slice(0, 40);
                if (input.ask) answer = oneLine(j.answer, 4000) || null;
                note('analyse', 'done', chapters.length + ' chapters, ' + entities.length + ' entities', clock.now() - t4);
            } catch (err) {
                if (err && err.code === 'run.cancelled') throw err;
                gaps.push('The model did not write the analysis (' + oneLine(err && (err.detail || err.message), 200) + '); there is no summary, no chapter and no entity.');
                note('analyse', 'failed', err && (err.detail || err.message), clock.now() - t4);
            }
            row = await finishStep(row, 'analyse', 0.92, summary ? 'written' : 'not written', summary ? 'done' : 'failed', requester);

            // 6. Explicit: the house rule, on what the frames showed and said on screen.
            row = await startStep(row, 'explicit', 'checking the content', 0.94, requester);
            const textsForCheck = described.map((f) => (f.caption || '') + ' ' + (f.text || '')).join('\n');
            const saidExplicit = described.some((f) => f.explicit && f.explicit !== 'fine');
            const verdict = classifyText(textsForCheck);
            const explicit = saidExplicit && verdict.category === 'fine'
                ? { category: 'sex_acts', reason: 'a frame was read as showing sex acts or pornography' }
                : verdict;
            note('explicit', 'done', explicit.category + ': ' + explicit.reason, 0);
            row = await finishStep(row, 'explicit', 0.96, explicit.category, 'done', requester);

            // 7. Report
            row = await startStep(row, 'report', 'assembling the analysis and its receipt', 0.97, requester);
            const nowIso = iso(clock.now());
            const report = {
                media_id: got.mediaId || null,
                duration_s: r2(duration),
                probe,
                keyframes: described.map((f) => ({ t: r2(f.t), url: f.url, caption: f.caption, text: f.text })),
                transcript: { lang: transcript.lang, words: transcript.words, text: transcript.text },
                chapters,
                summary,
                entities,
                tags,
                ...(answer ? { answer } : {}),
                explicit,
                receipt: { steps: stepReceipt, models, cost_usd: Math.round(cost * 1e6) / 1e6 },
            };
            const v = schemas.validate(REPORT, report);
            if (!v.valid) throw new AiError(502, 'output.invalid', 'the video analysis does not match ai.video-analysis@1: ' + v.errors.map((e) => e.path + ' ' + e.message).join('; '), { errors: v.errors });
            const steps = store.stepsWith(row, { report: { status: 'done', finished_at: nowIso } }, STEPS);
            row = await store.patch(row.id, { status: 'succeeded', step: 'report', progress: 1, steps, report, gaps: [...new Set(gaps)].slice(0, 40), finished_at: nowIso });
            await emit(row, { step: 'done', status: 'succeeded', requester });
            return { output: report, usage, cost, models, synthetic };
        } catch (err) {
            const cancelled = (err && err.code === 'run.cancelled') || (ctx.signal && ctx.signal.aborted);
            const code = cancelled ? 'run.cancelled' : ((err && err.code) || 'run.internal');
            const detail = String((err && (err.detail || err.message)) || 'the run failed').slice(0, 500);
            try {
                const steps = store.stepsWith(row, { [row.step || 'probe']: { status: cancelled ? 'skipped' : 'failed', finished_at: iso(clock.now()) } }, STEPS);
                const failed = await store.patch(row.id, { status: cancelled ? 'cancelled' : 'failed', steps, error_code: code, error_detail: detail, gaps: [...new Set(gaps)].slice(0, 40), finished_at: iso(clock.now()) });
                if (failed) await emit(failed, { status: failed.status, error: { code, detail }, requester });
            } catch (e) { log.warn('[video-analysis] could not record the failure: ' + e.message); }
            throw err;
        } finally {
            // The video and the audio windows are large and go now; the keyframes are small and stay, so the
            // frames endpoint can still serve them when Media holds no copy of them.
            try {
                for (const f of fs.readdirSync(runDir)) if (!/\.jpg$/.test(f)) { try { fs.unlinkSync(path.join(runDir, f)); } catch { /* */ } }
            } catch { /* the work directory is cleaned by the operator */ }
        }
    }

    /** Where a frame's JPEG is on this host (the copy Media does not hold). */
    function framePath(runId, index) {
        return path.join(source.workDir(), String(runId), 'frame-' + String(index).padStart(3, '0') + '.jpg');
    }

    return { run, depths, priceOf, store, source, ffmpeg, framePath };
}

module.exports = { createVideoAnalysis, pickTimes, wordsOf, verifyEntities, verifyChapters, ownerOf };
