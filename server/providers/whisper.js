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
 *   - NVIDIA Parakeet TDT 0.6B v3 (parakeet-cli from the same build) for English and 24 European
 *     languages when PARAKEET_MODEL is set, as Live does since 10-16: on a 2-minute stream sample it
 *     heard more words than large-v3-turbo (394 vs 369, punctuated) in a quarter of the time (31 s vs
 *     121 s). Audio over 45 s goes in 30 s pieces (a 300 s window needed 3.1 GB in one run). Any
 *     Parakeet failure falls back to whisper on the same audio; ASR_ENGINE=whisper forces whisper.
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

// ffmpeg's own words for an input it cannot read: the media's fault (gone, not media, no audio), not the decoder's.
const UNREADABLE = /Server returned 4\d\d|HTTP error 4\d\d|Invalid data found when processing input|No such file or directory|does not contain any stream|Output file does not contain any stream|Stream map .* matches no streams|moov atom not found|could not find codec parameters|End of file/i;
const lastLine = (t) => String(t || '').trim().split('\n').filter(Boolean).pop().slice(0, 200) || '';

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

// ── Parakeet output → timed sentences (Live's parseParakeet) ──
// `parakeet-cli -ps` prints every token on stderr with its start and end in centiseconds and whether it starts a word
// ("▁For"). A sentence ends at . ? or !, at a pause of 1.5 s, or after 20 s. Fillers ("uh", "um") are dropped.
const PARAKEET_LANGS = new Set(['bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk']);
const TOKEN_LINE = /t0=\s*(-?\d+)\s+t1=\s*(-?\d+)\s+word_start=(true|false)\s+"(.*)"\s*$/;
const FILLER_RE = /(^|[\s,])(?:uh+|um+|uhm|erm|mm+)(?=[\s,.!?]|$)[,]?/gi;
function parseParakeet(stderr, offsetSec = 0) {
    const out = [];
    let cur = null;
    const close = () => {
        if (!cur) return;
        const text = cur.text.replace(FILLER_RE, '$1').replace(/\s+([,.!?])/g, '$1').replace(/\s+/g, ' ').replace(/^[,\s]+/, '').trim();
        if (text) out.push({ start: offsetSec + cur.t0 / 100, end: offsetSec + cur.t1 / 100, text });
        cur = null;
    };
    for (const line of String(stderr || '').split('\n')) {
        const m = TOKEN_LINE.exec(line);
        if (!m) continue;
        const t0 = Number(m[1]), t1 = Number(m[2]);
        const wordStart = m[3] === 'true';
        const raw = m[4];
        if (/^<.*>$/.test(raw)) continue;                      // <unk>, <|…|> control tokens
        const piece = raw.replace(/\u2581/g, ' ');
        if (cur && wordStart && (t0 - cur.t1 > 150 || t0 - cur.t0 > 2000)) close();
        if (!cur) cur = { t0, t1, text: '' };
        cur.text += wordStart && !piece.startsWith(' ') ? ` ${piece}` : piece;
        cur.t1 = Math.max(cur.t1, t1);
        if (/[.!?]["')\]]?$/.test(piece.trim())) close();
    }
    close();
    return out;
}
const CHUNK_SEC = 30;
const CHUNK_MAX_SEC = 45;
const wavSeconds = (p) => { try { return Math.max(0, (fs.statSync(p).size - 44) / 32000); } catch { return 0; } };   // 16 kHz mono s16le

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
    const parakeetBin = () => [w.parakeetBin, bin() && path.join(path.dirname(bin()), 'parakeet-cli')].find(exists) || null;
    const parakeetOn = () => w.engine !== 'whisper' && exists(w.parakeetModel) && Boolean(parakeetBin());
    const engineFor = (language) => (parakeetOn() && PARAKEET_LANGS.has(String(language || 'en').slice(0, 2).toLowerCase()) ? 'parakeet' : 'whisper');

    const lanes = { live: { max: 1, running: 0, waiters: [] }, batch: { max: w.maxConcurrent, running: 0, waiters: [] } };
    const acquire = (lane) => { const L = lanes[lane]; if (L.running < L.max) { L.running++; return Promise.resolve(); } return new Promise(r => L.waiters.push(r)); };
    const release = (lane) => { const L = lanes[lane]; const n = L.waiters.shift(); if (n) n(); else L.running = Math.max(0, L.running - 1); };
    const active = new Set();

    function spawnTracked(cmd, args, { stderr = false } = {}) {
        const ch = spawn(cmd, args, { stdio: ['ignore', 'ignore', stderr ? 'pipe' : 'ignore'] });
        active.add(ch);
        const drop = () => active.delete(ch);
        ch.on('close', drop); ch.on('error', drop);
        return ch;
    }

    function toWav(src, seconds, signal, timeoutMs, startSec = 0, normalize = false) {
        return new Promise((resolve, reject) => {
            const wav = path.join(os.tmpdir(), `openvibe-ai-tx-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`);
            // startSec: one window of a long recording (media.analyze), decoded from there only.
            const args = ['-y', '-nostdin', ...(startSec > 0 ? ['-ss', String(startSec)] : []), '-i', src];
            if (seconds > 0) args.push('-t', String(seconds));
            args.push('-vn', '-ac', '1', '-ar', '16000');
            // Recordings are loudness-normalised first, as Live's VOD transcripts were: a quiet streamer is still heard.
            if (normalize) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
            args.push('-f', 'wav', wav);
            let ff;
            try { ff = spawnTracked('ffmpeg', args, { stderr: true }); } catch (e) { return reject(new ProviderError(`ffmpeg: ${e.message}`, { code: 'provider.unavailable' })); }
            let errTail = '';
            if (ff.stderr) ff.stderr.on('data', (c) => { errTail = (errTail + c).slice(-4000); });
            const kill = () => { try { ff.kill('SIGKILL'); } catch { /* */ } };
            const timer = setTimeout(kill, timeoutMs);
            if (signal) signal.addEventListener('abort', kill, { once: true });
            ff.on('close', (code) => {
                clearTimeout(timer);
                if (signal && signal.aborted) { try { fs.unlinkSync(wav); } catch { /* */ } return reject(new ProviderError('cancelled', { code: 'provider.cancelled' })); }
                if (code !== 0) {
                    try { fs.unlinkSync(wav); } catch { /* */ }
                    // The input itself could not be read (a 4xx from Media, not media, no audio): the caller's media, not
                    // whisper's health, so it is a 422 media.unreadable and does not open the circuit for everyone.
                    if (UNREADABLE.test(errTail)) return reject(new ProviderError(`ffmpeg could not read the media (exit ${code}): ${lastLine(errTail)}`, { status: 422, code: 'media.unreadable' }));
                    return reject(new ProviderError(`ffmpeg exited ${code}`, { code: 'provider.error' }));
                }
                resolve(wav);
            });
            ff.on('error', (e) => { clearTimeout(timer); reject(new ProviderError(`ffmpeg: ${e.message}`, { code: 'provider.unavailable' })); });
        });
    }

    function decode(wavPath, { language = 'en', live = false, lowPower = false, offsetSec = 0, signal, timeoutMs }) {
        return new Promise((resolve, reject) => {
            const lang = language && language !== 'en' && multi() ? String(language) : 'en';
            const model = lang !== 'en' ? multi() : (live && exists(MODEL_LIVE) ? MODEL_LIVE : MODEL);
            // Live segments, and batch work while the caller says streams are live (low power), use at most 2 threads.
            const threads = live || lowPower ? Math.max(1, Math.min(2, w.threads)) : w.threads;
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
                // With -l auto, whisper.cpp names the language it detected in result.language.
                const detected = parsed && parsed.result && /^[a-z]{2,3}$/.test(String(parsed.result.language || '')) ? parsed.result.language : null;
                done(() => resolve({ text: segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim(), segments, language: lang === 'auto' && detected ? detected : lang, model: path.basename(model) }));
            });
            ch.on('error', (e) => done(() => reject(new ProviderError(e.message, { code: 'provider.unavailable' }))));
        });
    }

    // One parakeet-cli run on a short WAV: the tokens on stderr become timed sentences.
    function parakeetOnce(wavPath, { threads, offsetSec, signal, deadline }) {
        return new Promise((resolve, reject) => {
            let ch;
            try { ch = spawnTracked('nice', ['-n', '15', parakeetBin(), '-t', String(threads), '-ps', '-np', '-m', w.parakeetModel, '-f', wavPath], { stderr: true }); }
            catch (e) { return reject(new ProviderError(e.message, { code: 'provider.unavailable' })); }
            const chunks = []; let size = 0;
            if (ch.stderr) ch.stderr.on('data', (d) => { if (size < 64 * 1024 * 1024) { chunks.push(d); size += d.length; } });
            const kill = () => { try { ch.kill('SIGKILL'); } catch { /* */ } };
            const timer = setTimeout(kill, Math.max(1000, deadline - Date.now()));
            if (signal) signal.addEventListener('abort', kill, { once: true });
            ch.on('close', (code) => {
                clearTimeout(timer);
                if (signal && signal.aborted) return reject(new ProviderError('cancelled', { code: 'provider.cancelled' }));
                if (code !== 0) return reject(new ProviderError(`parakeet exited ${code}`, { code: 'provider.error' }));
                resolve(parseParakeet(Buffer.concat(chunks).toString('utf8'), offsetSec));
            });
            ch.on('error', (e) => { clearTimeout(timer); reject(new ProviderError(e.message, { code: 'provider.unavailable' })); });
        });
    }
    // Parakeet on a whole WAV: in 30 s pieces past 45 s (PCM cut exactly, so a piece's times shift only by its start).
    async function decodeParakeet(wavPath, { language = 'en', live = false, lowPower = false, offsetSec = 0, signal, timeoutMs }) {
        const threads = live || lowPower ? Math.max(1, Math.min(2, w.threads)) : w.threads;
        const deadline = Date.now() + timeoutMs;
        let pieces = [wavPath], dir = null;
        if (wavSeconds(wavPath) > CHUNK_MAX_SEC) {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openvibe-ai-pk-'));
            await new Promise((resolve, reject) => {
                const ff = spawnTracked('nice', ['-n', '15', 'ffmpeg', '-nostdin', '-loglevel', 'error', '-y', '-i', wavPath, '-f', 'segment', '-segment_time', String(CHUNK_SEC), '-c', 'copy', path.join(dir, 'p%04d.wav')]);
                ff.on('close', (code) => (code === 0 ? resolve() : reject(new ProviderError(`ffmpeg split exited ${code}`, { code: 'provider.error' }))));
                ff.on('error', (e) => reject(new ProviderError(e.message, { code: 'provider.unavailable' })));
            });
            pieces = fs.readdirSync(dir).filter((n) => /^p\d{4}\.wav$/.test(n)).sort().map((n) => path.join(dir, n));
        }
        try {
            const raw = [];
            for (let i = 0; i < pieces.length; i++) {
                if (Date.now() >= deadline) throw new ProviderError('parakeet timed out', { code: 'provider.error' });
                raw.push(...await parakeetOnce(pieces[i], { threads, offsetSec: offsetSec + i * CHUNK_SEC, signal, deadline }));
            }
            const segments = cleanSegments(raw, true);
            return { text: segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim(), segments, language: String(language || 'en'), model: path.basename(w.parakeetModel) };
        } finally {
            if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
        }
    }

    async function transcribe(req) {
        if (!available()) throw new ProviderError('whisper.cpp is not installed on this host', { code: 'provider.unavailable' });
        const lane = req.live ? 'live' : 'batch';
        const timeoutMs = req.timeoutMs || 300000;
        const wav = await toWav(req.filePath, req.seconds || 0, req.signal, timeoutMs, req.startSec || 0, !req.live);
        try {
            await acquire(lane);
            try {
                const opts = { language: req.language, live: req.live, lowPower: req.lowPower === true, offsetSec: req.offsetSec || 0, signal: req.signal, timeoutMs };
                let r = null;
                if (engineFor(req.language) === 'parakeet') {
                    try { r = await decodeParakeet(wav, opts); }
                    catch (e) {
                        if (e && e.code === 'provider.cancelled') throw e;
                        // A Parakeet failure (a crash, a bad model file) must not leave a hole: whisper takes the same audio.
                        console.warn(`[whisper] parakeet failed (${e.message}); whisper takes this audio`);
                    }
                }
                if (!r) r = await decode(wav, opts);
                return { ...r, usage: { input: 0, output: 0, cached: 0 } };
            } finally { release(lane); }
        } finally { try { fs.unlinkSync(wav); } catch { /* */ } }
    }

    return {
        key: record.key,
        kind: 'whisper',
        supports: (f) => f === 'transcribe' && available(),
        transcribe,
        describe: () => ({ available: available(), model: path.basename(MODEL), parakeet: parakeetOn() ? path.basename(w.parakeetModel) : null, multilingual: Boolean(multi()), vad: Boolean(vadModel()), lanes: Object.fromEntries(Object.entries(lanes).map(([k, L]) => [k, { running: L.running, queued: L.waiters.length }])) }),
        killActive() { for (const ch of active) { try { ch.kill('SIGKILL'); } catch { /* */ } } active.clear(); },
    };
}

module.exports = { createWhisperProvider, cleanSegments, isNoise, parseParakeet };
