'use strict';
/**
 * Reading a provider's own price listing, through the egress guard.
 *
 * The price book reads the open internet, so it reads it the way the rest of the platform reads it: https only,
 * the ports a public site serves, a host that resolves to a public address and nothing else, a timeout, a size
 * cap and redirects followed by hand so every hop is judged on its own.
 *
 * An IP literal is refused before the socket is opened. Node never calls the lookup hook for an IP literal, so
 * the literal itself is the check (the same lesson as Actor #297): https://127.0.0.1/ must not be readable
 * because the guard never gets a chance to look it up.
 *
 * The transport is a seam: the tests replay the recorded listings through it and never open a socket.
 */
const https = require('https');
const net = require('net');
const egress = require('openvibe-shared/egress');

const PORTS = [443, 8443];
const MAX_REDIRECTS = 2;

const refuse = (message) => {
    const err = new Error(message);
    err.code = 'EGRESS_DENIED';
    return err;
};

/**
 * Is this a URL the price book may read? An https page on a public host, no credentials in the URL.
 * → the parsed URL, or an error that says why not.
 */
function judge(url) {
    let parsed;
    try { parsed = new URL(String(url)); } catch { throw refuse('that is not a URL'); }
    if (parsed.protocol !== 'https:') throw refuse('only an https listing is read');
    if (parsed.username || parsed.password) throw refuse('a URL with credentials is never read');
    const host = egress.normalizeHost(parsed.hostname);
    // Node never calls the lookup hook for an IP literal, so the literal is the check (Actor #297).
    if (net.isIP(host)) throw refuse('an IP-literal host is never read');
    if (egress.isInternalName(host)) throw refuse('that is not a public host name');
    if (parsed.port && !PORTS.includes(Number(parsed.port))) throw refuse('that port is not read');
    return parsed;
}

/** The one request: https, a guarded lookup, a timeout and a cap on the bytes. */
function defaultTransport({ method, url, headers, lookup, timeoutMs, maxBytes }) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers, lookup, timeout: timeoutMs }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > maxBytes) { req.destroy(new Error('the listing is larger than the cap')); return; }
                chunks.push(chunk);
            });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('the listing took too long')));
        req.on('error', reject);
        req.end();
    });
}

/**
 * Read a listing, following the redirects by hand so each hop is judged on its own.
 * → { ok, status, body, final_url, error }
 */
async function readListing(url, { transport = null, lookup = null, timeoutMs = 20000, maxBytes = 8 * 1024 * 1024 } = {}) {
    // A caller that has no transport or lookup of its own passes null (the job does, outside tests): null means the
    // default here. A default parameter only replaces undefined, so a null transport failed every read in production
    // ("checked 0 listings", 2026-11-06) and a null lookup would have skipped the egress guard.
    transport = transport || defaultTransport;
    lookup = lookup || egress.createSafeLookup();
    let current = String(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let parsed;
        try { parsed = judge(current); } catch (err) { return { ok: false, error: err.message, url: current }; }
        let res;
        try {
            res = await transport({ method: 'GET', url: parsed.toString(), headers: { accept: '*/*' }, lookup, timeoutMs, maxBytes });
        } catch (err) {
            return { ok: false, error: err.message, url: current };
        }
        const status = Number(res.status || 0);
        if (status === 307 || status === 308) {
            const location = res.headers && res.headers.location;
            if (!location) return { ok: false, error: 'the listing redirects without saying where', url: current };
            current = new URL(location, parsed).toString();
            continue;                                       // the next hop is judged on its own
        }
        if (status < 200 || status >= 300) return { ok: false, error: 'the listing answered ' + status, url: current };
        return { ok: true, status, body: res.body, final_url: current };
    }
    return { ok: false, error: 'the listing redirected too often', url: current };
}

module.exports = { readListing, judge, defaultTransport, PORTS, MAX_REDIRECTS };
