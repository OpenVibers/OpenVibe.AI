'use strict';
/**
 * Media and image inputs, fetched SSRF-safely.
 *
 * Workflows take media by URL or MediaRef, and the service fetches ONLY from allow-listed OpenVibe
 * hosts. The rules, all enforced here:
 *   - https only, to a hostname on the allow-list (exact, or '*.suffix'); the one exception is the
 *     operator-configured Media internal base (OV_MEDIA_INTERNAL_URL), matched by exact origin
 *   - the address actually connected to must be public unicast: the DNS answer is checked inside
 *     the connection's own lookup (no second resolution, so no DNS rebinding), and IPv4-mapped
 *     IPv6 spellings of internal addresses are caught too
 *   - redirects are followed by hand (max 3) and every hop is judged by the same rules; the internal
 *     Media origin is reachable by redirect only from the internal origin itself, never from a
 *     public hop (an allow-listed host that redirects must not reach the loopback Media service)
 *   - a byte cap, a timeout and cancellation on every transfer
 * data: URLs (images a caller sends inline) are decoded locally with a size cap — never fetched.
 * A MediaRef resolves to the public Media URL for the legacy kinds; med_ ids are an explicit
 * `media.unresolvable` until the Wave 4 object API exists.
 */
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AiError } = require('./util');

const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
    ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fe80::', 10], ['fec0::', 10], ['fc00::', 7], ['ff00::', 8], ['100::', 64], ['2001:db8::', 32], ['2001::', 23]]) blocked.addSubnet(a, p, 'ipv6');

function isPublicAddress(ip) {
    if (net.isIPv4(ip)) return !blocked.check(ip, 'ipv4');
    if (net.isIPv6(ip)) {
        const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
        if (m) return !blocked.check(m[1], 'ipv4');
        const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
        if (hex) {
            const n = (parseInt(hex[1], 16) << 16) >>> 0 | parseInt(hex[2], 16);
            const v4 = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
            return !blocked.check(v4, 'ipv4');
        }
        return !blocked.check(ip, 'ipv6');
    }
    return false;
}

/** dns.lookup replacement used at connect time: fails when any answer is not public unicast. */
function safeLookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
        if (err) return cb(err);
        const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: options.family || 4 }];
        const bad = list.find(a => !isPublicAddress(a.address));
        if (bad || !list.length) {
            const e = new Error(`refused: ${hostname} resolves to a non-public address`);
            e.code = 'EADDRNOTPUBLIC';
            return cb(e);
        }
        if (options.all) return cb(null, list);
        return cb(null, list[0].address, list[0].family);
    });
}

function hostAllowed(hostname, allowHosts) {
    const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
    return allowHosts.some((pat) => {
        const p = String(pat).toLowerCase();
        if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
        return h === p;
    });
}

/** `transport` replaces the single-hop HTTP request (tests script redirect chains with it). */
function createFetcher(config, { transport = null } = {}) {
    const m = config.media;
    const internalOrigin = m.internalUrl ? new URL(m.internalUrl).origin : null;

    /** Judge one URL. Returns { url, internal } or throws AiError 422 fetch.refused. */
    function judge(raw) {
        let u;
        try { u = new URL(String(raw)); } catch { throw new AiError(422, 'fetch.refused', 'not a valid URL'); }
        if (u.username || u.password) throw new AiError(422, 'fetch.refused', 'credentials in URLs are not allowed');
        if (internalOrigin && u.origin === internalOrigin) return { url: u, internal: true };
        if (u.protocol !== 'https:') throw new AiError(422, 'fetch.refused', `only https URLs on allow-listed OpenVibe hosts are fetched (got ${u.protocol})`);
        if (net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) throw new AiError(422, 'fetch.refused', 'IP-literal hosts are not fetched');
        if (!hostAllowed(u.hostname, m.allowHosts)) throw new AiError(422, 'fetch.refused', `host ${u.hostname} is not on the allow-list`);
        return { url: u, internal: false };
    }

    /** Judge a redirect from `from`: the same rules, and a public hop may not lead to the internal origin. */
    function follow(from, location) {
        const next = judge(location);
        if (next.internal && !from.internal) throw new AiError(422, 'fetch.refused', 'a redirect from a public host may not reach the internal Media origin');
        return next;
    }

    function once(target, { signal, maxBytes, timeoutMs, toFile }) {
        return new Promise((resolve, reject) => {
            const { url, internal } = target;
            const mod = url.protocol === 'https:' ? https : http;
            const req = mod.request(url, {
                method: 'GET',
                headers: { 'User-Agent': 'OpenVibe.AI/0.1 (+https://ai.openvibe.network)', Accept: '*/*' },
                // Internal Media is operator-configured (usually loopback); everything else must be public.
                lookup: internal ? undefined : safeLookup,
                timeout: timeoutMs,
            });
            const fail = (err) => { try { req.destroy(); } catch { /* */ } reject(err); };
            const onAbort = () => fail(new AiError(409, 'run.cancelled', 'cancelled'));
            if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
            const timer = setTimeout(() => fail(new AiError(502, 'source.unavailable', `fetch timed out after ${timeoutMs}ms`)), timeoutMs);
            const done = (fn) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(); };
            req.on('timeout', () => done(() => fail(new AiError(502, 'source.unavailable', 'fetch timed out'))));
            req.on('error', (err) => done(() => reject(err.code === 'EADDRNOTPUBLIC'
                ? new AiError(422, 'fetch.refused', err.message)
                : new AiError(502, 'source.unavailable', `fetch failed: ${err.message}`))));
            req.on('response', (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return done(() => resolve({ redirect: new URL(res.headers.location, url).toString() }));
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return done(() => reject(new AiError(502, 'source.unavailable', `source answered HTTP ${res.statusCode}`)));
                }
                const declared = Number(res.headers['content-length']);
                if (Number.isFinite(declared) && declared > maxBytes) { res.resume(); return done(() => reject(new AiError(413, 'source.too_large', `source is larger than ${maxBytes} bytes`))); }
                let bytes = 0;
                const chunks = [];
                const out = toFile ? fs.createWriteStream(toFile) : null;
                res.on('data', (c) => {
                    bytes += c.length;
                    if (bytes > maxBytes) { res.destroy(); if (out) out.destroy(); return done(() => reject(new AiError(413, 'source.too_large', `source is larger than ${maxBytes} bytes`))); }
                    if (out) out.write(c); else chunks.push(c);
                });
                res.on('error', (err) => done(() => reject(new AiError(502, 'source.unavailable', err.message))));
                res.on('end', () => {
                    const finish = () => done(() => resolve({ contentType: String(res.headers['content-type'] || ''), bytes, buffer: out ? null : Buffer.concat(chunks), file: toFile || null }));
                    if (out) out.end(finish); else finish();
                });
            });
            req.end();
        });
    }

    async function fetchUrl(raw, { signal, maxBytes = m.maxBytes, timeoutMs = m.timeoutMs, toFile = null } = {}) {
        let target = judge(raw);
        for (let hop = 0; hop < 4; hop++) {
            const r = await (transport || once)(target, { signal, maxBytes, timeoutMs, toFile });
            if (!r.redirect) return { ...r, url: target.url.toString() };
            if (hop === 3) throw new AiError(502, 'source.unavailable', 'too many redirects');
            target = follow(target, r.redirect);
        }
        throw new AiError(502, 'source.unavailable', 'too many redirects');
    }

    /** A MediaRef -> the public URL of that object (legacy kinds only for now). */
    function mediaRefUrl(ref) {
        const id = ref && ref.media_id;
        const mm = /^legacy:([a-z][a-z0-9-]{1,39}):(vod|clip|file|paste|thumbnail|avatar):([A-Za-z0-9._/-]{1,200})$/.exec(String(id || ''));
        if (!mm) throw new AiError(422, 'media.unresolvable', `media ${id} cannot be resolved by this service yet`);
        const [, , kind, key] = mm;
        const base = m.publicUrl;
        if (key.includes('..')) throw new AiError(422, 'media.unresolvable', 'bad media key');
        switch (kind) {
            case 'vod': return `${base}/v/${encodeURIComponent(key)}`;
            case 'clip': return `${base}/c/${encodeURIComponent(key)}`;
            case 'thumbnail': return `${base}/t/${encodeURIComponent(key)}`;
            case 'paste': return `${base}/p/${encodeURIComponent(key)}/raw`;
            case 'file': return `${base}/f/${key.split('/').map(encodeURIComponent).join('/')}`;
            default: throw new AiError(422, 'media.unresolvable', `media kind ${kind} is not fetched`);
        }
    }

    /** Image input { url } | { data_url } | { media: MediaRef } -> { mediaType, base64 }. */
    async function loadImage(input, { signal } = {}) {
        if (!input) return null;
        let buf; let type = '';
        if (input.data_url) {
            const mm = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(input.data_url));
            if (!mm) throw new AiError(422, 'input.invalid', 'image.data_url must be a base64 data:image/* URL');
            buf = Buffer.from(mm[2], 'base64');
            type = mm[1];
            if (buf.length > m.maxImageBytes) throw new AiError(413, 'source.too_large', 'inline image too large');
        } else {
            const url = input.url || (input.media ? mediaRefUrl(input.media) : null);
            if (!url) throw new AiError(422, 'input.invalid', 'image needs url, data_url or media');
            const r = await fetchUrl(url, { signal, maxBytes: m.maxImageBytes, timeoutMs: Math.min(m.timeoutMs, 30000) });
            buf = r.buffer;
            type = r.contentType.split(';')[0].trim();
            if (!/^image\//i.test(type)) throw new AiError(422, 'source.invalid', `expected an image, got ${type || 'unknown type'}`);
        }
        return downscale(buf, type, input.max_width || 1024);
    }

    /** Media input -> a temp file path (caller deletes it). */
    async function loadMediaToFile(input, { signal } = {}) {
        const url = input.media_url || (input.media ? mediaRefUrl(input.media) : null);
        if (!url) throw new AiError(422, 'input.invalid', 'media needs media_url or media (MediaRef)');
        const file = path.join(os.tmpdir(), `openvibe-ai-media-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
        try {
            await fetchUrl(url, { signal, toFile: file });
        } catch (e) {
            try { fs.unlinkSync(file); } catch { /* */ }
            throw e;
        }
        return { file, url };
    }

    return { judge, follow, fetchUrl, mediaRefUrl, loadImage, loadMediaToFile, hostAllowed: (h) => hostAllowed(h, m.allowHosts) };
}

/** Any image -> downscaled JPEG (sharp, optional). Falls back to the original bytes. */
async function downscale(buf, type, maxWidth) {
    try {
        const sharp = require('sharp');
        const out = await sharp(buf, { failOn: 'none', animated: false }).rotate()
            .resize({ width: maxWidth, height: maxWidth, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 78 }).toBuffer();
        return { mediaType: 'image/jpeg', base64: out.toString('base64') };
    } catch {
        return { mediaType: type || 'image/jpeg', base64: buf.toString('base64') };
    }
}

module.exports = { createFetcher, isPublicAddress, safeLookup, hostAllowed };
