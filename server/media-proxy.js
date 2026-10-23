'use strict';
/**
 * A loopback reader for media the analysis streams instead of downloading (roadmap WS-O tasks 2 and 5). ffprobe and
 * ffmpeg read `http://127.0.0.1:<port>/m/<token>`; this server answers each request (GET or HEAD, with any Range) by
 * asking the real URL through the fetcher's rules (fetcher.openStream: the allow-list, public addresses checked at
 * connect time, redirects judged here and never shown to ffmpeg). So a long recording is read where it lies: the
 * signal pass streams it once, and each speech-to-text window seeks to its start with a range request. Nothing is
 * written to disk.
 *
 * An HLS playlist (Media's virtual clips are one: `/c/<id>` redirects to `/o/<object>/master.m3u8`) is rewritten on
 * the way through. Every URI in it, resolved against where the playlist really came from, becomes a part of the same
 * token, `/m/<token>/<n>/<file name>` (the name keeps the extension ffmpeg's HLS reader checks), judged by the same
 * rules when it is read. Without that, ffmpeg resolved `source/index.m3u8` against the loopback URL and got a 404.
 *
 *   const handle = proxy.register(url)   // judged now; valid until release() or 6 hours
 *   handle.url                           // what ffmpeg reads
 *   handle.release()
 *
 * The server listens on 127.0.0.1 only, on a random port, from the first registration, and serves only registered
 * tokens (128 random bits each).
 */
const http = require('http');
const crypto = require('crypto');

const TTL_MS = 6 * 3600 * 1000;
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;
const MAX_PARTS = 200000;   // URIs one token's playlists may name (an 8-hour recording in 2 s segments is 14,400)
const PLAYLIST_TYPE = /^\s*(application\/(vnd\.apple\.mpegurl|x-mpegurl)|audio\/(x-)?mpegurl)\b/i;

function isPlaylist(contentType, url) {
    if (PLAYLIST_TYPE.test(String(contentType || ''))) return true;
    try { return /\.m3u8?$/i.test(new URL(url).pathname); } catch { return false; }
}

/** Each URI line and URI="…" attribute of an HLS playlist, resolved against `base` and replaced by `local(url)`. */
function rewritePlaylist(text, base, local) {
    return text.split('\n').map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) return line.replace(/URI="([^"]*)"/g, (all, u) => `URI="${local(new URL(u, base).toString())}"`);
        return local(new URL(t, base).toString());
    }).join('\n');
}

function createMediaProxy({ fetcher, log = console, clock = { now: () => Date.now() } }) {
    const entries = new Map();   // token -> { url, expires, parts: [url…], index: Map(url -> n) }
    let server = null;
    let ready = null;
    let port = null;

    /** The local URL of `url` as part of token `token`'s entry: judged now, numbered once per URL. As with a redirect,
     *  a playlist from a public host may not name the internal Media origin. */
    function partUrl(token, e, url, fromInternal) {
        if (fetcher.judge(url).internal && !fromInternal) {
            throw Object.assign(new Error('a playlist from a public host may not name the internal Media origin'), { code: 'fetch.refused' });
        }
        let n = e.index.get(url);
        if (n == null) {
            if (e.parts.length >= MAX_PARTS) throw Object.assign(new Error(`a playlist names more than ${MAX_PARTS} URIs`), { code: 'playlist.too_large' });
            n = e.parts.push(url) - 1;
            e.index.set(url, n);
        }
        const name = (new URL(url).pathname.split('/').pop() || 'part').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
        return `http://127.0.0.1:${port}/m/${token}/${n}/${name}`;
    }

    function fail(req, res, ac, err) {
        if (ac.signal.aborted) return;
        log.warn && log.warn(`[media-proxy] ${err.code || 'error'}: ${String(err.detail || err.message).slice(0, 200)}`);
        // Media's 4xx (the recording gone, not allowed) is passed on as it was: ffmpeg then says the media cannot be
        // read, which is the caller's media and not whisper's health. Everything else (Media down) stays a 502.
        const gone = err.upstreamStatus >= 400 && err.upstreamStatus < 500 ? err.upstreamStatus : null;
        if (!res.headersSent) res.writeHead(gone || (err.status === 422 || err.code === 'fetch.refused' ? 403 : 502)).end();
        else res.destroy();
    }

    /** Read a playlist (bounded), rewrite it to parts of this token and send it whole. */
    function sendPlaylist(req, res, ac, token, e, up, from) {
        if (req.method === 'HEAD') { up.resume(); res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(); return; }
        const chunks = []; let size = 0;
        up.on('data', (c) => {
            size += c.length;
            if (size > MAX_PLAYLIST_BYTES) { up.destroy(); fail(req, res, ac, Object.assign(new Error('playlist larger than 8 MB'), { code: 'playlist.too_large' })); return; }
            chunks.push(c);
        });
        up.on('error', (err) => fail(req, res, ac, err));
        up.on('end', () => {
            if (res.headersSent || size > MAX_PLAYLIST_BYTES) return;
            let fromInternal = false;
            try { fromInternal = fetcher.judge(from).internal; } catch { /* object storage: public */ }
            let body;
            try { body = Buffer.from(rewritePlaylist(Buffer.concat(chunks).toString('utf8'), from, (u) => partUrl(token, e, u, fromInternal))); } catch (err) { fail(req, res, ac, err); return; }
            res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': body.length });
            res.end(body);
        });
    }

    function start() {
        if (ready) return ready;
        server = http.createServer((req, res) => {
            const m = /^\/m\/([0-9a-f]{32})(?:\/(\d{1,6})(?:\/[A-Za-z0-9._-]*)?)?$/.exec(String(req.url || ''));
            const e = m && entries.get(m[1]);
            const target = e && (m[2] == null ? e.url : e.parts[Number(m[2])]);
            if (!e || e.expires < clock.now() || !target) { res.writeHead(404).end(); return; }
            if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
            const range = typeof req.headers.range === 'string' && /^bytes=\d*-\d*$/.test(req.headers.range) ? req.headers.range : null;
            const ac = new AbortController();
            req.on('close', () => ac.abort());
            fetcher.openStream(target, { method: req.method, range, signal: ac.signal, timeoutMs: 60000 }).then(({ res: up, url: from }) => {
                // A playlist is small and rewritten whole; a range into one (only ever bytes=0- from ffmpeg) gets it all.
                if (isPlaylist(up.headers['content-type'], from || target)) return sendPlaylist(req, res, ac, m[1], e, up, from || target);
                const headers = {};
                for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) if (up.headers[k]) headers[k] = up.headers[k];
                res.writeHead(up.statusCode, headers);
                if (req.method === 'HEAD') { up.resume(); res.end(); return; }
                up.pipe(res);
                up.on('error', () => res.destroy());
            }, (err) => fail(req, res, ac, err));
        });
        server.keepAliveTimeout = 5000;
        ready = new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.unref(); port = server.address().port; resolve(port); }); });
        return ready;
    }

    /** Judge `url` now and return a local URL for it. */
    async function register(url) {
        fetcher.judge(url);
        await start();
        const token = crypto.randomBytes(16).toString('hex');
        entries.set(token, { url, expires: clock.now() + TTL_MS, parts: [], index: new Map() });
        for (const [k, v] of entries) if (v.expires < clock.now()) entries.delete(k);
        return { url: `http://127.0.0.1:${port}/m/${token}`, release: () => entries.delete(token) };
    }

    function close() { entries.clear(); if (server) server.close(); server = null; ready = null; port = null; }

    return { register, close, _entries: entries };
}

module.exports = { createMediaProxy, rewritePlaylist };
