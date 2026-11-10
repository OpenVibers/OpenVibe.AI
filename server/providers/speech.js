'use strict';
/**
 * Speech synthesis providers (the Exchange speech route, `POST /v1/audio/speech`).
 *
 * Two paid providers, each a pool record of its own kind (server/providers/pool-providers.js):
 *
 *   google-tts   Google Cloud Text-to-Speech (`texttospeech.googleapis.com/v1/text:synthesize`).
 *                Auth is the service account (`AI_GOOGLE_TTS_SERVICE_ACCOUNT_JSON`, a JWT minted here)
 *                else the API key (`AI_GOOGLE_TTS_API_KEY`, the record's secret_ref).
 *   polly        Amazon Polly (`POST polly.{region}.amazonaws.com/v1/speech`, SigV4-signed).
 *                Auth is the access key id (`AI_POLLY_ACCESS_KEY_ID`, the record's secret_ref) plus
 *                `AI_POLLY_SECRET_ACCESS_KEY` and `AI_POLLY_REGION` (default `us-east-1`).
 *
 * Voices are Chat's voice ids, one to one (so Chat can switch without anyone hearing a difference):
 * `voice` names the entry below, and the entry names the provider, the provider's own voice and the
 * list price per million characters. Prices were read on the providers' own pages on 2026-11-10:
 *
 *   Google (https://cloud.google.com/text-to-speech/pricing): Standard $4, WaveNet $4,
 *     Neural2 $16, Studio $160. Journey has no row on the current page; it is priced at the
 *     Neural2 SKU ($16) until Google publishes one for it.
 *   Polly (https://aws.amazon.com/polly/pricing/): standard $4, neural $16, long-form $100,
 *     generative $30.
 *
 * Metering is per character, like the providers bill: usage.input carries the characters (the rate
 * cards price `in_per_mtok` as dollars per million characters for these models, with the unit named
 * in the model metadata), and `usage.characters` carries the same count for receipts.
 */
const crypto = require('crypto');
const { ProviderError } = require('./common');

const GOOGLE_ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// List price, USD per million characters, per provider voice tier (read 2026-11-10, see above).
const GOOGLE_PRICE = { standard: 4, wavenet: 4, neural2: 16, studio: 160, journey: 16 };
const POLLY_PRICE = { standard: 4, neural: 16, 'long-form': 100, generative: 30 };

const googleTierOf = (name) => {
    const n = String(name || '');
    if (/-Studio-/i.test(n)) return 'studio';
    if (/-Journey-/i.test(n)) return 'journey';
    if (/-Neural2-/i.test(n)) return 'neural2';
    if (/-Wavenet-/i.test(n)) return 'wavenet';
    return 'standard';
};

/**
 * Chat's cloud voices, one to one: id → the provider, the provider's own voice, the locale and the
 * list price per million characters. Pitch and speaking rate are Chat's own values (only Vegas and
 * Bass Boss set them); the request's `speed` multiplies the speaking rate.
 */
const VOICES = {
    gc_smooth_operator: { provider: 'google-tts', voice: 'en-US-Standard-D', locale: 'en-US', gender: 'MALE' },
    gc_silicon_sally: { provider: 'google-tts', voice: 'en-US-Standard-C', locale: 'en-US', gender: 'FEMALE' },
    gc_brit_butler: { provider: 'google-tts', voice: 'en-GB-Standard-B', locale: 'en-GB', gender: 'MALE' },
    gc_lady_london: { provider: 'google-tts', voice: 'en-GB-Standard-A', locale: 'en-GB', gender: 'FEMALE' },
    gc_down_under: { provider: 'google-tts', voice: 'en-AU-Standard-B', locale: 'en-AU', gender: 'MALE' },
    gc_sheila: { provider: 'google-tts', voice: 'en-AU-Standard-A', locale: 'en-AU', gender: 'FEMALE' },
    gc_mumbai_mike: { provider: 'google-tts', voice: 'en-IN-Standard-B', locale: 'en-IN', gender: 'MALE' },
    gc_news_anchor: { provider: 'google-tts', voice: 'en-US-Standard-J', locale: 'en-US', gender: 'MALE' },
    gc_podcast_girl: { provider: 'google-tts', voice: 'en-US-Standard-H', locale: 'en-US', gender: 'FEMALE' },
    gc_wave_daddy: { provider: 'google-tts', voice: 'en-US-Wavenet-D', locale: 'en-US', gender: 'MALE' },
    gc_wave_queen: { provider: 'google-tts', voice: 'en-US-Wavenet-F', locale: 'en-US', gender: 'FEMALE' },
    gc_wave_brit: { provider: 'google-tts', voice: 'en-GB-Wavenet-B', locale: 'en-GB', gender: 'MALE' },
    gc_wave_aussie: { provider: 'google-tts', voice: 'en-AU-Wavenet-B', locale: 'en-AU', gender: 'MALE' },
    gc_neural_chad: { provider: 'google-tts', voice: 'en-US-Neural2-D', locale: 'en-US', gender: 'MALE' },
    gc_neural_diva: { provider: 'google-tts', voice: 'en-US-Neural2-F', locale: 'en-US', gender: 'FEMALE' },
    gc_neural_brit_f: { provider: 'google-tts', voice: 'en-GB-Neural2-A', locale: 'en-GB', gender: 'FEMALE' },
    gc_neural_aussie_f: { provider: 'google-tts', voice: 'en-AU-Neural2-A', locale: 'en-AU', gender: 'FEMALE' },
    gc_studio_m: { provider: 'google-tts', voice: 'en-US-Studio-Q', locale: 'en-US', gender: 'MALE' },
    gc_studio_f: { provider: 'google-tts', voice: 'en-US-Studio-O', locale: 'en-US', gender: 'FEMALE' },
    gc_journey_sage: { provider: 'google-tts', voice: 'en-US-Journey-D', locale: 'en-US', gender: 'MALE' },
    gc_journey_oracle: { provider: 'google-tts', voice: 'en-US-Journey-F', locale: 'en-US', gender: 'FEMALE' },
    voice_vegas: { provider: 'google-tts', voice: 'en-US-Neural2-J', locale: 'en-US', gender: 'MALE', pitch: -4.0, speakingRate: 0.9 },
    voice_twofat: { provider: 'google-tts', voice: 'en-US-Neural2-D', locale: 'en-US', gender: 'MALE', pitch: -8.0, speakingRate: 1.0 },
    gc_journey_whisper: { provider: 'google-tts', voice: 'en-US-Journey-O', locale: 'en-US', gender: 'FEMALE' },
    pl_joanna_std: { provider: 'polly', voiceId: 'Joanna', engine: 'standard', locale: 'en-US' },
    pl_matthew_std: { provider: 'polly', voiceId: 'Matthew', engine: 'standard', locale: 'en-US' },
    pl_amy_std: { provider: 'polly', voiceId: 'Amy', engine: 'standard', locale: 'en-GB' },
    pl_brian_std: { provider: 'polly', voiceId: 'Brian', engine: 'standard', locale: 'en-GB' },
    pl_olivia_std: { provider: 'polly', voiceId: 'Olivia', engine: 'standard', locale: 'en-AU' },
    pl_ivy_std: { provider: 'polly', voiceId: 'Ivy', engine: 'standard', locale: 'en-US' },
    pl_joey_std: { provider: 'polly', voiceId: 'Joey', engine: 'standard', locale: 'en-US' },
    pl_kendra_std: { provider: 'polly', voiceId: 'Kendra', engine: 'standard', locale: 'en-US' },
    pl_joanna_neural: { provider: 'polly', voiceId: 'Joanna', engine: 'neural', locale: 'en-US' },
    pl_matthew_neural: { provider: 'polly', voiceId: 'Matthew', engine: 'neural', locale: 'en-US' },
    pl_ruth_neural: { provider: 'polly', voiceId: 'Ruth', engine: 'neural', locale: 'en-US' },
    pl_stephen_neural: { provider: 'polly', voiceId: 'Stephen', engine: 'neural', locale: 'en-US' },
    pl_amy_neural: { provider: 'polly', voiceId: 'Amy', engine: 'neural', locale: 'en-GB' },
    pl_arthur_neural: { provider: 'polly', voiceId: 'Arthur', engine: 'neural', locale: 'en-GB' },
    pl_danielle_neural: { provider: 'polly', voiceId: 'Danielle', engine: 'neural', locale: 'en-US' },
    pl_gregory_neural: { provider: 'polly', voiceId: 'Gregory', engine: 'neural', locale: 'en-US' },
    pl_kevin_neural: { provider: 'polly', voiceId: 'Kevin', engine: 'neural', locale: 'en-US' },
    pl_danielle_long: { provider: 'polly', voiceId: 'Danielle', engine: 'long-form', locale: 'en-US' },
    pl_gregory_long: { provider: 'polly', voiceId: 'Gregory', engine: 'long-form', locale: 'en-US' },
    pl_ruth_long: { provider: 'polly', voiceId: 'Ruth', engine: 'long-form', locale: 'en-US' },
    pl_matthew_gen: { provider: 'polly', voiceId: 'Matthew', engine: 'generative', locale: 'en-US' },
    pl_ruth_gen: { provider: 'polly', voiceId: 'Ruth', engine: 'generative', locale: 'en-US' },
};
for (const [id, v] of Object.entries(VOICES)) {
    v.id = id;
    v.price_per_million_chars_usd = v.provider === 'google-tts' ? GOOGLE_PRICE[googleTierOf(v.voice)] : POLLY_PRICE[v.engine];
}

const FORMATS = {
    mp3: { google: 'MP3', polly: 'mp3', mime: 'audio/mpeg' },
    ogg_opus: { google: 'OGG_OPUS', polly: 'ogg_vorbis', mime: 'audio/ogg' },
    wav: { google: 'LINEAR16', polly: 'pcm', mime: 'audio/wav' },
};

const payoffOf = (err, def) => { throw err instanceof ProviderError ? err : new ProviderError(def, { code: 'provider.unreachable' }); };

async function postJson(url, headers, body, { fetchImpl, timeoutMs, signal }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Number(timeoutMs) || 60000));
    try {
        const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body),
            signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal });
        const text = await res.text();
        if (!res.ok) throw new ProviderError(`speech HTTP ${res.status}: ${text.slice(0, 300)}`,
            { status: res.status, code: res.status === 429 ? 'provider.rate_limited' : res.status === 401 || res.status === 403 ? 'provider.auth' : 'provider.http' });
        return JSON.parse(text);
    } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new ProviderError(`speech request failed: ${String((err && err.message) || err).slice(0, 200)}`,
            { code: err && err.name === 'AbortError' ? 'provider.timeout' : 'provider.unreachable' });
    } finally {
        clearTimeout(timer);
    }
}

/** A Google service-account JWT → an OAuth access token (the server-to-server flow Chat uses). */
async function googleAccessToken(sa, fetchImpl) {
    const now = Math.floor(Date.now() / 1000);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const sig = crypto.createSign('RSA-SHA256').update(`${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
        iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 })}`).sign(sa.private_key, 'base64url');
    const form = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
        iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 })}.${sig}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
        const res = await fetchImpl(GOOGLE_TOKEN_URL, { method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: ctrl.signal });
        const j = await res.json();
        if (!res.ok || !j.access_token) throw new Error('token refused');
        return j.access_token;
    } catch (err) {
        throw new ProviderError(`google auth failed: ${String((err && err.message) || err).slice(0, 160)}`, { code: 'provider.auth' });
    } finally {
        clearTimeout(timer);
    }
}

/** SigV4 for `POST polly.{region}.amazonaws.com/v1/speech` (the same signing Chat uses). */
function pollyHeaders({ region, accessKey, secretKey, body }) {
    const now = new Date();
    const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 8);
    const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const host = `polly.${region}.amazonaws.com`;
    const headers = { host, 'x-amz-date': amz, 'content-type': 'application/json' };
    const signed = Object.keys(headers).map((k) => k.toLowerCase()).sort().join(';');
    const canonical = ['POST', '/v1/speech', '', ...Object.keys(headers).map((k) => `${k.toLowerCase()}:${String(headers[k]).trim()}`).sort(), '',
        crypto.createHash('sha256').update(body).digest('hex')].join('\n');
    const scope = `${date}/${region}/polly/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amz, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
    const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
    const signing = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), 'polly'), 'aws4_request');
    return { host, headers: { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed}, Signature=${crypto.createHmac('sha256', signing).update(toSign).digest('hex')}` } };
}

function createSpeechProvider(record, { apiKey = '', fetchImpl = globalThis.fetch, env = process.env } = {}) {
    const kind = record.key;
    // The test seam may point these at a local fake (AI_GOOGLE_TTS_BASE_URL / AI_POLLY_BASE_URL);
    // production calls the providers' own hosts.
    const googleBase = String(env.AI_GOOGLE_TTS_BASE_URL || 'https://texttospeech.googleapis.com').replace(/\/+$/, '');
    const pollyBase = String(env.AI_POLLY_BASE_URL || '').replace(/\/+$/, '');
    const svcAccount = () => {
        const raw = env.AI_GOOGLE_TTS_SERVICE_ACCOUNT_JSON || '';
        if (!raw) return null;
        try { return JSON.parse(raw); } catch { try { return JSON.parse(require('fs').readFileSync(raw, 'utf8')); } catch { return null; } }
    };

    async function speakGoogle(entry, { text, format, speed, timeoutMs, signal }) {
        const f = FORMATS[format] || FORMATS.mp3;
        const body = {
            input: { text },
            voice: { languageCode: entry.locale, name: entry.voice, ssmlGender: entry.gender },
            audioConfig: { audioEncoding: f.google,
                speakingRate: Math.max(0.25, Math.min(4, (entry.speakingRate || 1) * (speed || 1))),
                pitch: Number(entry.pitch) || 0 },
        };
        const sa = svcAccount();
        let url = `${googleBase}/v1/text:synthesize`, headers = { 'Content-Type': 'application/json' };
        if (sa && sa.client_email && sa.private_key) headers.Authorization = `Bearer ${await googleAccessToken(sa, fetchImpl)}`;
        else if (apiKey) url += `?key=${encodeURIComponent(apiKey)}`;
        else throw new ProviderError('google Cloud TTS is not configured', { code: 'provider.auth' });
        const j = await postJson(url, headers, body, { fetchImpl, timeoutMs, signal });
        if (!j.audioContent) throw new ProviderError('google TTS returned no audio', { code: 'provider.output' });
        return { audio: Buffer.from(j.audioContent, 'base64'), mimeType: f.mime };
    }

    async function speakPolly(entry, { text, format, speed, timeoutMs, signal }) {
        const f = FORMATS[format] || FORMATS.mp3;
        const secret = env.AI_POLLY_SECRET_ACCESS_KEY || '';
        const region = env.AI_POLLY_REGION || 'us-east-1';
        if (!apiKey || !secret) throw new ProviderError('amazon Polly is not configured', { code: 'provider.auth' });
        const body = JSON.stringify({ OutputFormat: f.polly, Text: text, TextType: 'text',
            VoiceId: entry.voiceId, Engine: entry.engine, ...(entry.locale ? { LanguageCode: entry.locale } : {}) });
        const { host, headers } = pollyHeaders({ region, accessKey: apiKey, secretKey: secret, body });
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Number(timeoutMs) || 60000));
        try {
            const url = pollyBase ? `${pollyBase}/v1/speech` : `https://${host}/v1/speech`;
            const res = await fetchImpl(url, { method: 'POST', headers,
                body, signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal });
            const buf = Buffer.from(await res.arrayBuffer());
            if (!res.ok) throw new ProviderError(`polly HTTP ${res.status}: ${buf.toString('utf8').slice(0, 300)}`,
                { status: res.status, code: res.status === 429 ? 'provider.rate_limited' : res.status === 401 || res.status === 403 ? 'provider.auth' : 'provider.http' });
            return { audio: buf, mimeType: f.mime };
        } catch (err) {
            if (err instanceof ProviderError) throw err;
            payoffOf(err, `polly request failed: ${String((err && err.message) || err).slice(0, 200)}`);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Synthesize one line. req: { voice (a VOICES id), text, format, speed, model, timeoutMs, signal }.
     * → { audio (Buffer), mimeType, model, usage }. usage.input carries the characters (the rate
     * cards price these models' `in_per_mtok` as dollars per million characters), and
     * usage.characters carries the same count for the receipt.
     */
    async function speak(req) {
        const entry = VOICES[req.voice];
        if (!entry) throw new ProviderError(`unknown voice ${String(req.voice || '').slice(0, 80)}`, { code: 'provider.model' });
        if (entry.provider !== kind) throw new ProviderError(`voice ${entry.id} is not a ${kind} voice`, { code: 'provider.model' });
        const text = String(req.text || '');
        if (!text.trim()) throw new ProviderError('speech needs text', { code: 'provider.input' });
        const out = entry.provider === 'google-tts' ? await speakGoogle(entry, req) : await speakPolly(entry, req);
        const characters = text.length;
        return { ...out, model: entry.id, usage: { input: characters, output: 0, cached: 0, characters } };
    }

    return { key: record.key, kind: 'speech', synthetic: false, speak, supports: (f) => f === 'speak' };
}

module.exports = { createSpeechProvider, VOICES, FORMATS, googleTierOf, GOOGLE_PRICE, POLLY_PRICE, GOOGLE_ENDPOINT };
