'use strict';
/**
 * A loopback reader for media the analysis streams instead of downloading (roadmap WS-O tasks 2 and 5). ffprobe and
 * ffmpeg read `http://127.0.0.1:<port>/m/<token>`; this server answers each request (GET or HEAD, with any Range) by
 * asking the real URL through the fetcher's rules (fetcher.openStream: the allow-list, public addresses checked at
 * connect time, redirects judged here and never shown to ffmpeg). So a long recording is read where it lies: the
 * signal pass streams it once, and each speech-to-text window seeks to its start with a range request. Nothing is
 * written to disk.
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

function createMediaProxy({ fetcher, log = console, clock = { now: () => Date.now() } }) {
    const entries = new Map();   // token -> { url, expires }
    let server = null;
    let ready = null;

    function start() {
        if (ready) return ready;
        server = http.createServer((req, res) => {
            const m = /^\/m\/([0-9a-f]{32})$/.exec(String(req.url || ''));
            const e = m && entries.get(m[1]);
            if (!e || e.expires < clock.now()) { res.writeHead(404).end(); return; }
            if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
            const range = typeof req.headers.range === 'string' && /^bytes=\d*-\d*$/.test(req.headers.range) ? req.headers.range : null;
            const ac = new AbortController();
            req.on('close', () => ac.abort());
            fetcher.openStream(e.url, { method: req.method, range, signal: ac.signal, timeoutMs: 60000 }).then(({ res: up }) => {
                const headers = {};
                for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) if (up.headers[k]) headers[k] = up.headers[k];
                res.writeHead(up.statusCode, headers);
                if (req.method === 'HEAD') { up.resume(); res.end(); return; }
                up.pipe(res);
                up.on('error', () => res.destroy());
            }, (err) => {
                if (ac.signal.aborted) return;
                log.warn && log.warn(`[media-proxy] ${err.code || 'error'}: ${String(err.detail || err.message).slice(0, 200)}`);
                if (!res.headersSent) res.writeHead(err.status === 422 ? 403 : 502).end();
                else res.destroy();
            });
        });
        server.keepAliveTimeout = 5000;
        ready = new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.unref(); resolve(server.address().port); }); });
        return ready;
    }

    /** Judge `url` now and return a local URL for it. */
    async function register(url) {
        fetcher.judge(url);
        const port = await start();
        const token = crypto.randomBytes(16).toString('hex');
        entries.set(token, { url, expires: clock.now() + TTL_MS });
        for (const [k, v] of entries) if (v.expires < clock.now()) entries.delete(k);
        return { url: `http://127.0.0.1:${port}/m/${token}`, release: () => entries.delete(token) };
    }

    function close() { entries.clear(); if (server) server.close(); server = null; ready = null; }

    return { register, close, _entries: entries };
}

module.exports = { createMediaProxy };
