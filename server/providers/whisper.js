'use strict';
/**
 * Local speech-to-text through whisper.cpp — ported from OpenVibe.Live server/ai/transcribe.js with
 * its hard-won behaviour intact:
 *   - JSON output (-oj) for per-segment timestamps; greedy decoding unless WHISPER_BEAM > 1
 *   - Silero VAD when the model is installed (decode only regions with a voice)
 *   - the hallucination filter (stock phrases over silence, subtitle boilerplate, URL lines,
 *     filler words when there is no VAD) and collapsing of looped repeats
 *   - a multilingual model (WHISPER_MODEL_MULTI) for non-English audio, a faster live model
 *     (WHISPER_MODEL_LIVE), two independent lanes (live never waits on batch), nice -n 15
 * Same environment names as Live, so the same install works on either host.
 *
 * Input is a local media file the engine already fetched through the SSRF-safe fetcher; ffmpeg
 * turns it into 16 kHz mono WAV first.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ProviderError } = require('./common');

const HALLUCINATIONS = new Set([
    'thank you', 'thank you.', 'thanks for watching', 'thanks for watching!', 'thanks for watching.', 'please subscribe', 'subscribe',
    'like and subscribe', 'thank you for watching', 'thank you very much', 'thank you so much', 'silence', 'music', 'applause',
]);
const FILLER_WORDS = new Set(['you', 'bye', 'bye.', 'bye bye', 'okay', 'ok', 'oh', 'uh', 'um', 'hmm', 'mm', 'mhm', 'the', 'so', 'yeah', 'i\'m sorry']);

function isNoise(t, hasVad) {
    const s = (t || '').replace(/\s+/g, ' ').trim();
    if (!s) return true;
    if (/^[\s.\-–—_*]+$/.test(s)) return true;
    if (/^[[(♪].*[\])♪]?$/.test(s)) return true;
    if (/^♪/.test(s) || /♪$/.test(s)) return true;
    const norm = s.toLowerCase().replace(/[.!?,…]+$/g, '').trim();
    if (HALLUCINATIONS.has(norm)) return true;
    if (/\b(?:www\.|https?:\/\/)\S+/i.test(norm) && norm.split(/\s+/).length <= 12) return true;
    if (/subtitle[sd]?\s+(?:by|from)|amara\.org|subscribe to|closed caption/i.test(norm)) return true;
    if (/^(?:for more info(?:rmation)?|visit our website|see you (?:next time|in the next video))/i.test(norm)) return true;
    if (!hasVad && FILLER_WORDS.has(norm)) return true;
    return false;
}

function cleanSegments(segsRaw, hasVad) {
    const out = [];
    let last = '';
    for (const seg of segsRaw) {
        const text = (seg.text || '').replace(/\s+/g, ' ').trim();
        if (isNoise(text, hasVad)) continue;
        const norm = text.toLowerCase();
        if (norm === last) continue;
        last = norm;
        out.push({ start: Math.round(seg.start * 100) / 100, end: Math.round(seg.end * 100) / 100, text });
    }
    return out;
}

function createWhisperProvider(record, { config }) {
    const HOME = os.homedir();
    const w = config.whisper;
    const bins = [w.bin, path.join(HOME, 'whisper.cpp/build/bin/whisper-cli'), path.join(HOME, 'whisper.cpp/build/bin/main'), path.join(HOME, 'whisper.cpp/main')].filter(Boolean);
    const MODEL = w.model || path.join(HOME, 'whisper.cpp/models/ggml-base.en.bin');
    const MODEL_LIVE = w.modelLive || MODEL;
    const MODEL_MULTI = w.modelMulti || path.join(HOME, 'whisper.cpp/models/ggml-base.bin');
    const VAD_MODEL = w.vadModel || path.join(HOME, 'whisper.cpp/models/ggml-silero-v5.1.2.bin');
    const exists = (p) => { try { return Boolean(p) && fs.existsSync(p); } catch { return false; } };
    const bin = () => bins.find(exists) || null;
    const vadModel = () => (w.vad && exists(VAD_MODEL) ? VAD_MODEL : null);
    const multi = () => (exists(MODEL_MULTI) ? MODEL_MULTI : null);
    const available = () => Boolean(bin()) && exists(MODEL);

    const lanes = { live: { max: 1, running: 0, waiters: [] }, batch: { max: w.maxConcurrent, running: 0, waiters: [] } };
    const acquire = (lane) => { const L = lanes[lane]; if (L.running < L.max) { L.running++; return Promise.resolve(); } return new Promise(r => L.waiters.push(r)); };
    const release = (lane) => { const L = lanes[lane]; const n = L.waiters.shift(); if (n) n(); else L.running = Math.max(0, L.running - 1); };
    const active = new Set();

    function spawnTracked(cmd, args) {
        const ch = spawn(cmd, args, { stdio: 'ignore' });
        active.add(ch);
        const drop = () => active.delete(ch);
        ch.on('close', drop); ch.on('error', drop);
        return ch;
    }

    function toWav(src, seconds, signal, timeoutMs) {
        return new Promise((resolve, reject) => {
            const wav = path.join(os.tmpdir(), `openvibe-ai-tx-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`);
            const args = ['-y', '-nostdin', '-i', src];
            if (seconds > 0) args.push('-t', String(seconds));
            args.push('-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav);
            let ff;
            try { ff = spawnTracked('ffmpeg', args); } catch (e) { return reject(new ProviderError(`ffmpeg: ${e.message}`, { code: 'provider.unavailable' })); }
            const kill = () => { try { ff.kill('SIGKILL'); } catch { /* */ } };
            const timer = setTimeout(kill, timeoutMs);
            if (signal) signal.addEventListener('abort', kill, { once: true });
            ff.on('close', (code) => {
                clearTimeout(timer);
                if (signal && signal.aborted) { try { fs.unlinkSync(wav); } catch { /* */ } return reject(new ProviderError('cancelled', { code: 'provider.cancelled' })); }
                if (code !== 0) { try { fs.unlinkSync(wav); } catch { /* */ } return reject(new ProviderError(`ffmpeg exited ${code}`, { code: 'provider.error' })); }
                resolve(wav);
            });
            ff.on('error', (e) => { clearTimeout(timer); reject(new ProviderError(`ffmpeg: ${e.message}`, { code: 'provider.unavailable' })); });
        });
    }

    function decode(wavPath, { language = 'en', live = false, offsetSec = 0, signal, timeoutMs }) {
        return new Promise((resolve, reject) => {
            const lang = language && language !== 'en' && multi() ? String(language) : 'en';
            const model = lang !== 'en' ? multi() : (live && exists(MODEL_LIVE) ? MODEL_LIVE : MODEL);
            const threads = live ? Math.max(1, Math.min(2, w.threads)) : w.threads;
            const outBase = `${wavPath}.out`;
            const jsonPath = `${outBase}.json`;
            const args = ['-m', model, '-f', wavPath, '-oj', '-of', outBase, '-t', String(threads), '-l', lang];
            if (w.beam > 1) args.push('-bs', String(w.beam));
            const vm = vadModel();
            if (vm) args.push('--vad', '-vm', vm);
            let ch;
            try { ch = spawnTracked('nice', ['-n', '15', bin(), ...args]); } catch (e) { return reject(new ProviderError(e.message, { code: 'provider.unavailable' })); }
            const kill = () => { try { ch.kill('SIGKILL'); } catch { /* */ } };
            const timer = setTimeout(kill, timeoutMs);
            if (signal) signal.addEventListener('abort', kill, { once: true });
            const done = (fn) => { clearTimeout(timer); try { fs.existsSync(jsonPath) && fs.unlinkSync(jsonPath); } catch { /* */ } fn(); };
            ch.on('close', (code) => {
                if (signal && signal.aborted) return done(() => reject(new ProviderError('cancelled', { code: 'provider.cancelled' })));
                if (code !== 0) return done(() => reject(new ProviderError(`whisper exited ${code}`, { code: 'provider.error' })));
                let parsed;
                try { parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) { return done(() => reject(new ProviderError(`parse: ${e.message}`, { code: 'provider.error' }))); }
                const items = Array.isArray(parsed && parsed.transcription) ? parsed.transcription : [];
                const segments = cleanSegments(items.map(it => ({
                    start: offsetSec + ((it.offsets && it.offsets.from) || 0) / 1000,
                    end: offsetSec + ((it.offsets && it.offsets.to) || 0) / 1000,
                    text: it.text || '',
                })), Boolean(vm));
                done(() => resolve({ text: segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim(), segments, language: lang, model: path.basename(model) }));
            });
            ch.on('error', (e) => done(() => reject(new ProviderError(e.message, { code: 'provider.unavailable' }))));
        });
    }

    async function transcribe(req) {
        if (!available()) throw new ProviderError('whisper.cpp is not installed on this host', { code: 'provider.unavailable' });
        const lane = req.live ? 'live' : 'batch';
        const timeoutMs = req.timeoutMs || 300000;
        const wav = await toWav(req.filePath, req.seconds || 0, req.signal, timeoutMs);
        try {
            await acquire(lane);
            try {
                const r = await decode(wav, { language: req.language, live: req.live, offsetSec: req.offsetSec || 0, signal: req.signal, timeoutMs });
                return { ...r, usage: { input: 0, output: 0, cached: 0 } };
            } finally { release(lane); }
        } finally { try { fs.unlinkSync(wav); } catch { /* */ } }
    }

    return {
        key: record.key,
        kind: 'whisper',
        supports: (f) => f === 'transcribe' && available(),
        transcribe,
        describe: () => ({ available: available(), model: path.basename(MODEL), multilingual: Boolean(multi()), vad: Boolean(vadModel()), lanes: Object.fromEntries(Object.entries(lanes).map(([k, L]) => [k, { running: L.running, queued: L.waiters.length }])) }),
        killActive() { for (const ch of active) { try { ch.kill('SIGKILL'); } catch { /* */ } } active.clear(); },
    };
}

module.exports = { createWhisperProvider, cleanSegments, isNoise };
