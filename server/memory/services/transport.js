'use strict';
/**
 * The guarded transport of the memory-service adapters (Memory M5).
 *
 * A person names their own mem0, Letta or Zep address, so every request to it is an untrusted URL. It goes through
 * the same guard OpenVibe.AI already uses for a person's own endpoint (server/community/endpoints.js):
 *
 *   - https only, no credentials in the URL, port 443 or 8443;
 *   - never an IP literal, never an internal name (localhost, *.local, *.internal, a single label);
 *   - the DNS answer is judged inside the connection's own lookup (openvibe-shared/egress), so the socket connects
 *     to the checked address and a second answer cannot swap it (no rebinding);
 *   - a redirect is never followed: a 3xx is the error "the service answered with a redirect";
 *   - a 15 s timeout and a 1 MB response cap on every call.
 *
 * The `transport` and `lookup` seams are for tests only. They are injected by the test helper, never read from config
 * or the environment, so a deployment cannot turn the guard off and a test can script a response without a socket.
 */
const net = require('net');
const https = require('https');
const egress = require('openvibe-shared/egress');
const { AiError } = require('../../util');

const ALLOWED_PORTS = new Set(['', '443', '8443']);
const TIMEOUT_MS = 15000;
const MAX_BYTES = 1024 * 1024;
const DNS_TIMEOUT_MS = 5000;

class ServiceError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

/**
 * The one URL rule for a memory service. Returns the URL (its pathname without a trailing slash), or throws a 422
 * whose words never echo the host: the value came from a person and must not come back in an error.
 */
function judgeUrl(raw, { allowQuery = false } = {}) {
    const text = String(raw == null ? '' : raw);
    if (text.length > 500) throw new AiError(422, 'memory.service_url', 'base_url is too long');
    let u;
    try { u = new URL(text); } catch { throw new AiError(422, 'memory.service_url', 'base_url must be an https URL'); }
    if (u.protocol !== 'https:') throw new AiError(422, 'memory.service_url', 'base_url must be https');
    if (u.username || u.password) throw new AiError(422, 'memory.service_url', 'credentials in base_url are not allowed');
    if (u.hash || (!allowQuery && u.search)) throw new AiError(422, 'memory.service_url', 'base_url carries no query or fragment');
    if (!ALLOWED_PORTS.has(u.port)) throw new AiError(422, 'memory.service_url', 'base_url must use port 443 or 8443');
    const host = egress.normalizeHost(u.hostname);
    // Node never calls the lookup hook for an IP literal, so the literal itself is the check.
    if (net.isIP(host)) throw new AiError(422, 'memory.service_url', 'base_url must name a public host, not an IP address');
    if (egress.isInternalName(host)) throw new AiError(422, 'memory.service_url', 'base_url must be a public host name');
    u.hostname = host;
    // A stored base URL has no trailing slash; a request URL keeps its own path exactly as the service documents it.
    if (!allowQuery) u.pathname = u.pathname.replace(/\/+$/, '') || '';
    return u;
}

/** A base URL: the stored form, no query, no trailing slash. */
function judgeBaseUrl(raw) {
    return judgeUrl(raw, { allowQuery: false });
}

/** A request URL: the base plus its fixed path and (for mem0) paging query, still guarded. */
function judgeRequestUrl(raw) {
    return judgeUrl(raw, { allowQuery: true });
}

/** Resolve a host through the guard, for the save check. A private answer is a 422, and the key is never used. */
function assertPublicBaseUrl(raw, { lookup = null } = {}) {
    const u = judgeBaseUrl(raw);
    const safe = egress.createSafeLookup({ ...(lookup ? { lookup } : {}) });
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (err) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (!err) return resolve(u);
            if (err && err.code === 'EGRESS_DENIED') return reject(new AiError(422, 'memory.service_url', 'base_url must resolve to a public address'));
            return reject(new AiError(422, 'memory.service_url', 'base_url could not be resolved'));
        };
        const timer = setTimeout(() => finish(new Error('dns timeout')), DNS_TIMEOUT_MS);
        if (timer.unref) timer.unref();
        safe(u.hostname, { all: true }, finish);
    });
}

/** One response, without following anything. */
function once(target, headers, safeLookup) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let req;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { if (req) req.destroy(); } catch { /* already gone */ }
            reject(err);
        };
        const ok = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        req = https.request(target, { method: 'GET', headers, lookup: safeLookup, timeout: TIMEOUT_MS, agent: false }, (res) => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400) { res.resume(); return ok({ status, headers: res.headers, body: '' }); }
            const declared = Number(res.headers['content-length']);
            if (Number.isFinite(declared) && declared > MAX_BYTES) {
                res.resume();
                return fail(new ServiceError(413, 'memory.service_too_large', 'the service answered more than 1 MB'));
            }
            let bytes = 0;
            const chunks = [];
            res.on('data', (chunk) => {
                bytes += chunk.length;
                if (bytes > MAX_BYTES) {
                    res.destroy();
                    return fail(new ServiceError(413, 'memory.service_too_large', 'the service answered more than 1 MB'));
                }
                chunks.push(chunk);
            });
            res.on('error', () => fail(new ServiceError(502, 'memory.service_unreachable', 'the service could not be reached')));
            res.on('end', () => ok({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', (err) => fail(new ServiceError(502, err && err.code === 'EGRESS_DENIED' ? 'memory.service_blocked' : 'memory.service_unreachable',
            err && err.code === 'EGRESS_DENIED' ? 'the service resolves to a non-public address' : 'the service could not be reached')));
        req.on('timeout', () => fail(new ServiceError(504, 'memory.service_timeout', 'the service did not answer within 15s')));
        const timer = setTimeout(() => fail(new ServiceError(504, 'memory.service_timeout', 'the service did not answer within 15s')), TIMEOUT_MS);
        req.on('close', () => clearTimeout(timer));
        req.end();
    });
}

/** What an answer means, as the adapter reads it. The body is JSON; any 3xx is a refusal, never a hop. */
async function readJson(res) {
    const status = Number(res && res.status) || 0;
    if (status >= 300 && status < 400) throw new ServiceError(502, 'memory.service_redirect', 'the service answered with a redirect');
    if (status === 401 || status === 403) throw new ServiceError(401, 'memory.service_key_refused', 'the service refused the key');
    if (status === 429) throw new ServiceError(429, 'memory.service_rate_limited', 'the service is rate-limiting the key; try again later');
    if (status < 200 || status >= 300) throw new ServiceError(502, 'memory.service_failed', 'the service did not answer successfully');
    const body = String((res && res.body) || '');
    if (Buffer.byteLength(body) > MAX_BYTES) throw new ServiceError(413, 'memory.service_too_large', 'the service answered more than 1 MB');
    try { return JSON.parse(body || 'null'); } catch { throw new ServiceError(502, 'memory.service_failed', 'the service answered with a body that is not JSON'); }
}

function createServiceTransport({ lookup = null, transport = null } = {}) {
    const safeLookup = egress.createSafeLookup({ ...(lookup ? { lookup } : {}) });
    /** GET one URL with the adapter's headers. The URL is judged here again, on every call. */
    async function get(rawUrl, headers = {}) {
        const target = judgeRequestUrl(rawUrl);
        const res = transport
            ? await transport({ method: 'GET', url: target.toString(), headers, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES })
            : await once(target, headers, safeLookup);
        return await readJson(res);
    }
    return { get };
}

module.exports = {
    createServiceTransport, assertPublicBaseUrl, judgeBaseUrl, judgeRequestUrl,
    ServiceError, TIMEOUT_MS, MAX_BYTES, ALLOWED_PORTS,
};
