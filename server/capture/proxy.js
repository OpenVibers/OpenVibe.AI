'use strict';
/**
 * The egress guard the browser itself goes through.
 *
 * Node fetches are judged by server/providers/guarded-fetch.js; a headless Chrome would otherwise resolve a
 * hostname itself, so a public URL that redirects to 127.0.0.1, 10.0.0.1 or a metadata address would be read
 * inside our network. Every browser request (including every redirect and WebSocket) is sent through this
 * loopback HTTP proxy instead, which resolves the destination with the same `safeLookup` rule the rest of AI
 * uses: every answer must be public unicast, and the connection is made to the address that was checked, so a
 * DNS answer cannot change between the check and the connect (no rebinding). Only http/https on 80/443 is
 * tunnelled; an IP literal, a credentials-bearing URL, a private answer or any other port is refused.
 */
const http = require('http');
const net = require('net');
const { safeLookup } = require('../fetcher');

const PORTS = new Set([80, 443]);

function refuse(socket, status = 403, why = 'refused') {
    try { socket.end(`HTTP/1.1 ${status} ${why}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* closed */ }
}

/** host:port from a CONNECT line or an absolute URL; null when it is not a plain http(s) origin on 80/443. */
function targetOf(authority, protocol = 'https:', allowLocal = false) {
    const raw = String(authority || '').trim();
    let host; let port;
    if (raw.startsWith('[')) {
        const end = raw.indexOf(']');
        host = raw.slice(1, end); port = raw.slice(end + 1).replace(/^:/, '') || (protocol === 'https:' ? '443' : '80');
    } else {
        const i = raw.lastIndexOf(':');
        host = i > 0 ? raw.slice(0, i) : raw; port = i > 0 ? raw.slice(i + 1) : (protocol === 'https:' ? '443' : '80');
    }
    if (!host || host.length > 253 || /[^a-z0-9._:-]/i.test(host)) return null;
    if (net.isIP(host) && !(allowLocal && (host === '127.0.0.1' || host === '::1'))) return null;
    const n = Number(port);
    if (!Number.isInteger(n)) return null;
    if (!PORTS.has(n) && !(allowLocal && (host === '127.0.0.1' || host === 'localhost' || host === '::1'))) return null;
    return { host, port: n };
}

function createGuardProxy({ log = console, allowLocal = false } = {}) {
    let server = null;
    let listening = null;
    // Production resolves every answer and refuses a non-public one. A test fixture lives on loopback, so the
    // capture test opts in explicitly (createGuardProxy({ allowLocal: true })); nothing outside /test passes it.
    const localHost = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1';
    const lookup = (host, cb) => (allowLocal && localHost(host)
        ? cb(null, [{ address: '127.0.0.1', family: 4 }])
        : safeLookup(host, { all: true }, cb));

    const server_ = http.createServer((req, res) => {
        // Plain http: the browser sends an absolute URL in the request line.
        let u;
        try { u = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
        const t = u.protocol === 'http:' ? targetOf(u.host, 'http:', allowLocal) : null;
        if (!t) { res.writeHead(403); return res.end(); }
        lookup(t.host, (err, addrs) => {
            if (err || !Array.isArray(addrs) || !addrs.length) { log.warn(`[capture] proxy refused ${t.host}: ${err ? err.message : 'no address'}`); res.writeHead(403); return res.end(); }
            const headers = { ...req.headers, host: t.host + (t.port === 80 ? '' : `:${t.port}`) };
            delete headers['proxy-connection'];
            const up = http.request({ host: addrs[0].address, port: t.port, method: req.method, path: `${u.pathname}${u.search || ''}`, headers }, (upRes) => {
                res.writeHead(upRes.statusCode || 502, upRes.headers);
                upRes.pipe(res);
            });
            up.on('error', () => { try { res.writeHead(502); res.end(); } catch { /* closed */ } });
            res.on('close', () => up.destroy());
            req.pipe(up);
        });
    });

    server_.on('connect', (req, socket, head) => {
        const t = targetOf(req.url, 'https:', allowLocal);
        if (!t) return refuse(socket, 403, 'Forbidden');
        socket.on('error', () => { /* the browser hung up */ });
        lookup(t.host, (err, addrs) => {
            if (err || !Array.isArray(addrs) || !addrs.length) {
                log.warn(`[capture] proxy refused ${t.host}: ${String((err && err.message) || 'no address').slice(0, 160)}`);
                return refuse(socket);
            }
            const up = net.connect(t.port, addrs[0].address, () => {
                socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head && head.length) up.write(head);
                socket.pipe(up); up.pipe(socket);
            });
            up.on('error', () => refuse(socket, 502, 'Bad Gateway'));
            socket.on('close', () => up.destroy());
            up.on('close', () => socket.destroy());
        });
    });
    server_.on('clientError', (_e, socket) => { try { socket.destroy(); } catch { /* closed */ } });

    function start() {
        if (listening) return listening;
        listening = new Promise((resolve, reject) => {
            server_.once('error', reject);
            server_.listen(0, '127.0.0.1', () => {
                server = server_.address();
                resolve({ url: `http://127.0.0.1:${server.port}`, close });
            });
        });
        return listening;
    }
    function close() {
        if (listening) { try { server_.close(); } catch { /* closed */ } }
        listening = null;
    }
    return { start, close, url: () => (server ? `http://127.0.0.1:${server.port}` : null) };
}

module.exports = { createGuardProxy, targetOf };
