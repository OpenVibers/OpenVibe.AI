'use strict';
/**
 * fetch() for a base URL a person chose (their own provider key, server/credentials.js): https only, no
 * credentials in the URL, no IP-literal hosts, and the connection goes only to public unicast addresses, checked
 * at connect time (fetcher.js safeLookup), so a DNS answer cannot point it inside the network. No redirects; a
 * response is capped at 8 MB. Returns a standard Response, which is all the provider adapters use.
 */
const https = require('https');
const net = require('net');
const { safeLookup } = require('../fetcher');

const MAX_BYTES = 8 * 1024 * 1024;

function refuse(message) {
    const e = new Error(message);
    e.code = 'EADDRNOTPUBLIC';
    return e;
}

function guardedFetch(input, init = {}) {
    return new Promise((resolve, reject) => {
        let url;
        try { url = new URL(String(input)); } catch { return reject(refuse('not a valid URL')); }
        if (url.protocol !== 'https:') return reject(refuse('only https endpoints are called with a person\'s own key'));
        if (url.username || url.password) return reject(refuse('credentials in URLs are not allowed'));
        if (net.isIP(url.hostname.replace(/^\[|\]$/g, ''))) return reject(refuse('IP-literal hosts are not called'));
        if (typeof init.body !== 'string' && init.body != null) return reject(refuse('only JSON bodies are sent with a person\'s own key'));
        const headers = { ...(init.headers || {}) };
        if (init.body != null) headers['Content-Length'] = Buffer.byteLength(init.body);
        const req = https.request(url, { method: init.method || 'GET', headers, lookup: safeLookup });
        const signal = init.signal;
        const onAbort = () => { req.destroy(); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
        if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
        req.on('error', (err) => { if (signal) signal.removeEventListener('abort', onAbort); reject(err); });
        req.on('response', (res) => {
            const chunks = []; let bytes = 0;
            res.on('data', (c) => { bytes += c.length; if (bytes > MAX_BYTES) { res.destroy(); req.destroy(); reject(new Error('response too large')); } else chunks.push(c); });
            res.on('error', reject);
            res.on('end', () => {
                if (signal) signal.removeEventListener('abort', onAbort);
                const h = new Headers();
                for (const [k, v] of Object.entries(res.headers)) if (v != null) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
                resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode, headers: h }));
            });
        });
        if (init.body != null) req.write(init.body);
        req.end();
    });
}

module.exports = { guardedFetch, MAX_BYTES };
