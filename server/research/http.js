'use strict';
/**
 * HTTPS for the research providers: a descriptive User-Agent with a contact (Wikimedia's API policy asks for one), a
 * per-call timeout, the run's cancellation, and the guarded fetch (public addresses only, no redirects, 8 MB cap).
 */
const { guardedFetch } = require('../providers/guarded-fetch');

const USER_AGENT = 'OpenVibeResearch/1.0 (+https://ai.openvibe.services; Contact@OpenVibe.Network)';

class ProviderError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

function createHttp({ fetchImpl = guardedFetch, timeoutMs = 15000, userAgent = USER_AGENT } = {}) {
    let requests = 0;
    async function request(url, { method = 'GET', body = null, headers = {}, signal = null, timeout = timeoutMs } = {}) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        const onAbort = () => ctrl.abort();
        if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
        requests += 1;
        try {
            const res = await fetchImpl(url, {
                method,
                headers: { 'User-Agent': userAgent, Accept: 'application/json', ...(body != null ? { 'Content-Type': 'application/json' } : {}), ...headers },
                body: body == null ? undefined : JSON.stringify(body),
                signal: ctrl.signal,
            });
            const text = await res.text();
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch { /* not JSON: the caller decides */ }
            return { status: res.status, json, text };
        } catch (err) {
            if (ctrl.signal.aborted && !(signal && signal.aborted)) throw new ProviderError(504, `timed out after ${timeout} ms`);
            throw err;
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        }
    }
    /** GET a JSON API; anything but a 200 with JSON is an error. */
    async function getJson(url, opts) {
        const r = await request(url, opts);
        if (r.status !== 200 || !r.json) throw new ProviderError(r.status, `${new URL(url).hostname} answered ${r.status}`);
        return r.json;
    }
    return { request, getJson, count: () => requests };
}

module.exports = { createHttp, ProviderError, USER_AGENT };
