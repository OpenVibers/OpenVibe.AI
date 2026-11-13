'use strict';
/**
 * Deepgram (server/providers/deepgram.js): hosted speech to text.
 *
 * POST https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true with the key in
 * `Authorization: Token <key>` and the recording as the body (Deepgram's own guide, read 2026-11-13).
 * The answer carries the transcript and, with smart formatting, the words with their times.
 *
 * Price: Nova-3 monolingual is $0.0077 a minute and multilingual $0.0092, pay as you go; the Growth
 * tier is $0.0065 (deepgram.com/pricing, read 2026-11-13). A new account starts with $200 of credit,
 * no card. The transcript is metered the way every other transcription is: the minutes come from the
 * model's own price, not from a token count.
 */
const fs = require('fs');
const path = require('path');
const { ProviderError, deadline, describeAbort } = require('./common');

const DEFAULT_BASE_URL = 'https://api.deepgram.com';

/** The content type of the recording, by its name; Deepgram reads the bytes, this only names them. */
const CONTENT_TYPES = Object.freeze({
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4',
    '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.mpeg': 'audio/mpeg',
});

function createDeepgramProvider(record, { apiKey = '', fetchImpl = globalThis.fetch } = {}) {
    const baseUrl = String(record.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');

    /**
     * One recording into words. req: { model, filePath, language, signal, timeoutMs }.
     * → { text, segments, model, usage: { input: 0, output: 0, cached: 0 } }
     */
    async function transcribe(req) {
        const file = req.filePath;
        if (!file || !fs.existsSync(file)) throw new ProviderError('transcription audio file missing', { code: 'provider.input' });
        const model = String(req.model || 'nova-3');
        const query = new URLSearchParams({ model, smart_format: 'true', punctuate: 'true' });
        if (req.language && req.language !== 'auto') query.set('language', String(req.language));
        const contentType = CONTENT_TYPES[path.extname(String(file)).toLowerCase()] || 'audio/wav';
        let res;
        try {
            res = await fetchImpl(`${baseUrl}/v1/listen?${query.toString()}`, {
                method: 'POST',
                headers: { Authorization: `Token ${apiKey}`, 'Content-Type': contentType, accept: 'application/json' },
                body: fs.readFileSync(file),
                signal: deadline(req.signal, req.timeoutMs),
            });
        } catch (err) {
            throw describeAbort(err, req.signal, req.timeoutMs) || new ProviderError(`connection failed: ${err.message}`, { code: 'provider.unreachable' });
        }
        const raw = await res.text().catch(() => '');
        if (!res.ok) throw new ProviderError(`deepgram HTTP ${res.status}: ${raw.slice(0, 300)}`, { status: res.status, code: res.status === 401 || res.status === 403 ? 'provider.auth' : 'provider.http' });
        let j = {};
        try { j = raw ? JSON.parse(raw) : {}; } catch { throw new ProviderError('deepgram answer is not json', { code: 'provider.output' }); }
        const channel = j.results && j.results.channels && j.results.channels[0];
        const alternative = channel && channel.alternatives && channel.alternatives[0];
        if (!alternative || typeof alternative.transcript !== 'string') throw new ProviderError('deepgram returned no transcript', { code: 'provider.output' });
        const segments = (Array.isArray(alternative.words) ? alternative.words : [])
            .map((w) => ({ start: Number(w.start) || 0, end: Number(w.end) || 0, text: String(w.punctuated_word || w.word || '').trim() }))
            .filter((s) => s.text);
        return { text: alternative.transcript.trim(), segments, model, usage: { input: 0, output: 0, cached: 0 } };
    }

    return { key: record.key, kind: 'deepgram', synthetic: false, transcribe, supports: (f) => f === 'transcribe' };
}

module.exports = { createDeepgramProvider, CONTENT_TYPES };
