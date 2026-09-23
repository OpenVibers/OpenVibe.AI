'use strict';
/**
 * Transport helpers shared by the HTTP provider adapters (ported from OpenVibe.Live
 * server/ai/llm.js): JSON POST with a hard timeout and cancellation, an error type that keeps the
 * HTTP status, the transient-failure test used for the one retry, and the token estimate for
 * self-hosted servers that omit usage.
 */

class ProviderError extends Error {
    constructor(message, { status = null, code = 'provider.error', body = null } = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.body = body;
    }
}

/** An AbortSignal that fires on the caller's signal OR after timeoutMs. */
function deadline(signal, timeoutMs) {
    const t = AbortSignal.timeout(Math.max(1, timeoutMs));
    return signal ? AbortSignal.any([signal, t]) : t;
}

function describeAbort(err, signal, timeoutMs) {
    if (signal && signal.aborted) return new ProviderError('cancelled', { code: 'provider.cancelled' });
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return new ProviderError(`no response within ${Math.round(timeoutMs / 1000)}s`, { code: 'provider.timeout' });
    return null;
}

async function postJson(url, headers, body, { signal, timeoutMs = 30000, fetchImpl = globalThis.fetch } = {}) {
    let res;
    try {
        res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: deadline(signal, timeoutMs) });
    } catch (err) {
        throw describeAbort(err, signal, timeoutMs) || new ProviderError(`connection failed: ${err.message}`, { code: 'provider.unreachable' });
    }
    let text;
    try { text = await res.text(); } catch (err) {
        throw describeAbort(err, signal, timeoutMs) || new ProviderError(`read failed: ${err.message}`, { code: 'provider.unreachable' });
    }
    let j = {};
    try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
    if (!res.ok) {
        const msg = (j.error && (j.error.message || j.error)) || `HTTP ${res.status}: ${String(text).slice(0, 200)}`;
        throw new ProviderError(typeof msg === 'string' ? msg : JSON.stringify(msg), { status: res.status, code: res.status === 401 || res.status === 403 ? 'provider.auth' : 'provider.http', body: j });
    }
    return j;
}

/** Transient failures get one more try on the same provider (Live's rule). */
function retryable(e) {
    if (!e) return false;
    if (e.code === 'provider.cancelled') return false;
    if (e.code === 'provider.timeout' || e.code === 'provider.unreachable') return true;
    if (e.status) return e.status === 429 || e.status >= 500;
    return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket/i.test(e.message || '');
}

const approxTokens = (t) => Math.ceil(String(t || '').length / 4);

/** Self-hosted servers often omit usage — estimate so quotas and budgets still mean something. */
function estimateUsage(req, text) {
    const sys = (req.system || []).map(x => x.text).join('');
    const msgs = (req.messages || []).reduce((n, m) => n + approxTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0);
    return { input: approxTokens(sys) + msgs + (req.image ? 800 : 0), output: approxTokens(text), cached: 0, estimated: true };
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new ProviderError('cancelled', { code: 'provider.cancelled' })); }, { once: true });
    });
}

module.exports = { ProviderError, deadline, describeAbort, postJson, retryable, approxTokens, estimateUsage, sleep };
