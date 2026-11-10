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

/**
 * The provider's own answer that its account is out of money: DeepSeek answers HTTP 402 with
 * `{ "error": { "message": "Insufficient Balance" } }`; OpenAI-shaped gateways use 429/403 with
 * `insufficient_quota`, or name a credit balance. This is not the caller's fault and not a transient
 * failure: the provider is exhausted until someone tops it up (server/providers/index.js opens its
 * circuit for the long cooldown and never retries into it).
 */
const BALANCE_RE = /insufficient[\s_-]+(balance|quota|credit|credits|funds)|out\s+of\s+(balance|credit|credits|funds)|credit\s+balance\s+is\s+too\s+low|balance\s+(is\s+)?(too\s+)?low|exceeded\s+your\s+current\s+quota|billing\s+(hard\s+)?limit/i;
function insufficientBalance(err) {
    if (!err) return false;
    if (err.status === 402) return true;
    const body = err.body && typeof err.body === 'object' ? err.body : {};
    const inner = body.error && typeof body.error === 'object' ? body.error : body;
    const code = String((inner && (inner.code || inner.type)) || err.code || '');
    const message = String((inner && inner.message) || body.message || err.message || '');
    if ((err.status === 403 || err.status === 429) && /insufficient_quota|billing/i.test(`${code} ${message}`)) return true;
    return BALANCE_RE.test(`${code} ${message}`);
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

/**
 * The output schema as an instruction, for a request that cannot carry it as structured output (a gateway or a schema
 * that refuses json_schema steps down to json_object or prose, and the model would otherwise guess the shape).
 */
function schemaInstruction(json) {
    if (!json || !json.schema) return '';
    let text;
    try { text = JSON.stringify(json.schema); } catch { return ''; }
    if (text.length > 12000) text = text.slice(0, 12000);
    return `Answer with one JSON object that matches this JSON Schema exactly: every required property present, no other properties, and the types and limits it gives.\n${text}`;
}

module.exports = {
    schemaInstruction, ProviderError, deadline, describeAbort, postJson, retryable, approxTokens, estimateUsage, sleep, insufficientBalance };
