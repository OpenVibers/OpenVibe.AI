'use strict';
/**
 * OpenVibe.AI's side of the capture worker.
 *
 * With AI_CAPTURE_URL set (production: http://127.0.0.1:4710, the openvibe-ai-capture unit) a capture is a POST
 * to the worker, so Chrome runs and dies in its own MemoryMax'ed process. Unset (tests, a small install) the same
 * module runs in this process. Either way the answer is one shape: { url, title, final_url, combos, warnings,
 * skipped, reason, ms }.
 */
function createCaptureClient({ config = {}, env = process.env, fetchImpl = globalThis.fetch, log = console, local = null } = {}) {
    const url = String((config.capture && config.capture.url) || '').replace(/\/+$/, '');
    const timeoutMs = (config.capture && config.capture.timeoutMs) || 300000;
    const token = String(env.AI_CAPTURE_TOKEN || '');
    const done = (p) => p.then((r) => (r && typeof r.json === 'function' ? r.json() : r));

    async function captureSite(args = {}) {
        if (url) {
            const res = await fetchImpl(`${url}/capture`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { 'x-ov-capture-token': token } : {}) },
                body: JSON.stringify({ url: args.url, runId: args.runId || null, owner: args.owner || null, extras: args.extras === true }),
                signal: args.signal ? AbortSignal.any([args.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
            });
            const body = await res.json().catch(() => null);
            if (res.status === 401 || res.status === 403) throw Object.assign(new Error('the capture worker refused this service'), { code: 'capture.unauthorized', status: 503 });
            if (res.status === 503 && body && body.code === 'capture.drill') return { url: args.url, combos: [], warnings: [body.detail], skipped: 'drill', reason: body.detail, ms: 0 };
            if (!res.ok || !body) throw Object.assign(new Error((body && body.detail) || `the capture worker answered ${res.status}`), { code: (body && body.code) || 'capture.failed', status: 502 });
            return body;
        }
        if (!local) throw Object.assign(new Error('capture is not configured'), { code: 'capture.unavailable', status: 503 });
        return local.captureSite(args);
    }

    async function health() {
        if (!url) return { configured: false, enabled: Boolean(local && local.available && local.available()) };
        try {
            const res = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(3000), headers: { Accept: 'application/json' } });
            const body = await res.json().catch(() => null);
            return { configured: true, ...(body || {}), ok: res.ok };
        } catch (err) {
            return { configured: true, ok: false, error: String((err && err.message) || err).slice(0, 160) };
        }
    }

    return { captureSite, health, remote: Boolean(url) };
}

module.exports = { createCaptureClient };
