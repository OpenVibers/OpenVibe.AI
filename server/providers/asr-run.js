'use strict';
/**
 * Parakeet on the shared node (plan §AD.21b item 6): a short WAV piece decoded by the node's `openvibe-asr` Run
 * function (the same parakeet-cli and model) instead of on production's four cores. With AI_ASR_RUN_URL,
 * AI_ASR_RUN_SUBJECT and AI_ASR_RUN_PROJECT set, server/providers/whisper.js sends each piece (at most 10 s, 320 KB:
 * within Run's 512 KB args as base64) as a job for the operator (X-OV-Subject) in their project (X-OV-Project), with
 * AI's Network service token (run.job.submit, run.job.read on openvibe.run). The answer is parakeet-cli's own
 * per-token output, parsed by whisper.js as a local run's.
 *
 * A miss is asked once more; a second miss answers { ok: false } and that piece decodes here, unless
 * AI_ASR_LOCAL_FALLBACK=off (then the transcription fails as unavailable and is tried again later); after a failure the
 * next five minutes stay off the node, so an outage costs one piece's wait, not every piece's.
 *
 *   createAsrRun({ config, env, fetchImpl, tokens, now, sleep, log }) → { configured(), decode(wavPath, { timeoutMs, signal }) }
 *   decode → { ok: true, stderr, ms, job } | { ok: false, error }
 */
const fs = require('fs');
const crypto = require('crypto');

const USER_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_WAV = 360 * 1024;
const PIECE_SEC = 10;
const POLL_MS = 250;
const COOL_MS = 5 * 60 * 1000;
const RETRY_MS = 2000;
const DONE = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

/** May a piece the node missed decode on this host? AI_ASR_LOCAL_FALLBACK=off (production, 11-18: heavy work runs on the
 *  shared node via Link) says no: the transcription fails as unavailable and its caller tries again later. */
const localFallback = (config) => !(config && config.asrRun && config.asrRun.localFallback === false);

function settingsOf(config) {
    const a = (config && config.asrRun) || {};
    const url = String(a.url || '').replace(/\/+$/, '');
    const subject = String(a.subject || '');
    const project = String(a.project || '');
    if (!/^https?:\/\/[^/\s]+$/.test(url) || !USER_RE.test(subject) || !PROJECT_RE.test(project)) return null;
    return { url, subject, project };
}

function createAsrRun({ config = {}, env = process.env, fetchImpl = globalThis.fetch, tokens = undefined, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console } = {}) {
    let client = tokens;
    let coolUntil = 0;
    let lastNote = '';
    const tokenClient = () => {
        if (client === undefined) {
            const secret = env.OV_OAUTH_CLIENT_SECRET || '';
            if (!secret) { client = null; return client; }
            const { createServiceTokenClient } = require('openvibe-sdk/auth');
            const network = String(config.networkInternalUrl || 'http://127.0.0.1:4000').replace(/\/+$/, '');
            client = createServiceTokenClient({ tokenUrl: `${network}/oauth/token`, clientId: env.OV_OAUTH_CLIENT_ID || 'ai', clientSecret: secret, scope: { 'openvibe.run': 'run.job.submit run.job.read' }, fetch: fetchImpl });
        }
        return client;
    };
    const fail = (error) => {
        coolUntil = now() + COOL_MS;
        if (error !== lastNote) { lastNote = error; if (log && log.warn) log.warn(`[ai] parakeet on the shared node: ${error}; decoding here for 5 minutes`); }
        return { ok: false, error };
    };
    const configured = () => Boolean(settingsOf(config)) && now() >= coolUntil;

    async function decode(wavPath, { timeoutMs = 30000, signal = null } = {}) {
        const s = settingsOf(config);
        if (!s) return { ok: false, error: 'not configured' };
        if (now() < coolUntil) return { ok: false, error: 'cooling down after a failure' };
        const tc = tokenClient();
        if (!tc) return fail('OV_OAUTH_CLIENT_SECRET is not set');
        let wav;
        try { wav = fs.readFileSync(wavPath); } catch (e) { return { ok: false, error: `cannot read the piece: ${e.code || e.message}` }; }
        if (!wav.length || wav.length > MAX_WAV) return { ok: false, error: `the piece is ${wav.length} bytes, over ${MAX_WAV}` };
        const deadline = now() + timeoutMs;
        const call = async (method, path, body) => {
            const headers = { Accept: 'application/json', Authorization: `Bearer ${await tc.getToken({ audience: 'openvibe.run' })}`, 'X-OV-Subject': s.subject, 'X-OV-Project': s.project };
            if (body) headers['Content-Type'] = 'application/json';
            const res = await fetchImpl(`${s.url}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(Math.max(1000, Math.min(10000, deadline - now()))) });
            if (res.status === 401 && tc.invalidate) tc.invalidate();
            return { status: res.status, doc: await res.json().catch(() => null) };
        };
        const t0 = now();
        // One job; its outcome (never the cooldown: decode decides that after a second ask).
        const once = async () => { try {
            const sub = await call('POST', '/api/v1/jobs', {
                class: 'linux', artifact: { name: 'openvibe-asr', version: '1.0.0' },
                args: { audio_b64: wav.toString('base64'), threads: 4 }, egress: 'none',
                requirements: { kind: 'ai.asr', mobility: 'job', latency_class: 'background', objective: 'balanced', trust: ['first-party', 'user-owned'] },
                limits: { wall_ms: 60000, cpu_ms: 240000, mem_bytes: 2 * 1024 * 1024 * 1024 },
                ttl_ms: Math.max(10000, Math.min(120000, timeoutMs)),
                idempotency_key: `ai-asr:${crypto.createHash('sha256').update(wav).digest('hex').slice(0, 32)}`,
            });
            const id = sub.doc && (sub.doc.id || (sub.doc.job && sub.doc.job.id));
            if (!(sub.status === 200 || sub.status === 201) || !id) return { ok: false, error: `Run answered ${sub.status}${sub.doc && sub.doc.code ? ` ${sub.doc.code}` : ''}` };
            for (;;) {
                if (signal && signal.aborted) return { ok: false, error: 'cancelled', final: true };
                if (now() >= deadline) return { ok: false, error: `no answer within ${Math.round(timeoutMs / 1000)} s`, final: true };
                await sleep(POLL_MS);
                const r = await call('GET', `/api/v1/jobs/${encodeURIComponent(id)}`);
                const j = r.doc && (r.doc.state ? r.doc : r.doc.job);
                if (!j || !DONE.has(j.state)) continue;
                const result = j.result && typeof j.result === 'object' ? j.result : null;
                if (j.state !== 'succeeded' || !result || result.code !== 0 || typeof result.stderr !== 'string') {
                    return { ok: false, error: `the job ended ${j.state}${j.error && j.error.code ? ` (${j.error.code})` : ''}${result && result.code ? `, exit ${result.code}` : ''}` };
                }
                return { ok: true, stderr: result.stderr, ms: now() - t0, job: id };
            }
        } catch (e) {
            return { ok: false, error: e && e.name === 'TimeoutError' ? 'Run did not answer in time' : `Run unreachable: ${(e && e.message) || e}` };
        } };
        // A node that misses once (a reconnect, a worker restarting) is asked once more (11-18: the work runs on the shared
        // node, not on production); a second miss is a failure, and the cooldown starts.
        let r = await once();
        if (!r.ok && !r.final && !(signal && signal.aborted) && now() + RETRY_MS < deadline) { await sleep(RETRY_MS); r = await once(); }
        if (r.ok) { lastNote = ''; return r; }
        if (r.error === 'cancelled') return { ok: false, error: 'cancelled' };
        return fail(r.error);
    }

    return { configured, decode };
}

module.exports = { createAsrRun, settingsOf, localFallback, MAX_WAV, PIECE_SEC, COOL_MS };
