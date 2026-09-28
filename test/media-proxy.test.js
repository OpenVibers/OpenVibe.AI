'use strict';
// The loopback reader media.analyze streams through (server/media-proxy.js; roadmap WS-O task 2): ffmpeg reads a
// registered token and gets the real URL's bytes, Range requests pass through (206 with Content-Range), HEAD answers
// headers only, an unknown or released token is 404, and a redirect the fetcher's rules refuse (a public host
// sending it to the internal Media origin) never reaches the reader: 403.
const assert = require('assert');
const nodeHttp = require('http');
const { suite } = require('./helpers');
const { load } = require('../server/config');
const { createFetcher } = require('../server/fetcher');
const { createMediaProxy } = require('../server/media-proxy');

const t = suite('media-proxy');
const BODY = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
let upstream; let base; let proxy;

t.test('boot an internal Media stand-in', async () => {
    upstream = nodeHttp.createServer((req, res) => {
        if (req.url === '/redirect-out') { res.writeHead(302, { Location: 'https://evil.example/x' }); return res.end(); }
        const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        if (m) {
            const start = Number(m[1]); const end = m[2] ? Number(m[2]) : BODY.length - 1;
            res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${BODY.length}`, 'Accept-Ranges': 'bytes' });
            return res.end(req.method === 'HEAD' ? undefined : BODY.subarray(start, end + 1));
        }
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': BODY.length, 'Accept-Ranges': 'bytes' });
        res.end(req.method === 'HEAD' ? undefined : BODY);
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${upstream.address().port}`;
    proxy = createMediaProxy({ fetcher: createFetcher(load({ NODE_ENV: 'test', OV_MEDIA_INTERNAL_URL: base })), log: { warn() {} } });
});

t.test('whole reads, ranges, HEAD and unknown tokens', async () => {
    const h = await proxy.register(`${base}/v/1`);
    assert.match(h.url, /^http:\/\/127\.0\.0\.1:\d+\/m\/[0-9a-f]{32}$/);
    let r = await fetch(h.url);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(Buffer.from(await r.arrayBuffer()), BODY);
    r = await fetch(h.url, { headers: { Range: 'bytes=10-19' } });
    assert.deepStrictEqual([r.status, r.headers.get('content-range'), Buffer.from(await r.arrayBuffer()).toString()], [206, 'bytes 10-19/36', 'abcdefghij']);
    r = await fetch(h.url, { method: 'HEAD' });
    assert.deepStrictEqual([r.status, r.headers.get('content-length')], [200, '36']);
    assert.strictEqual((await fetch(h.url.replace(/[0-9a-f]{32}$/, '0'.repeat(32)))).status, 404);
    h.release();
    assert.strictEqual((await fetch(h.url)).status, 404, 'released');
});

t.test('a URL the rules refuse is refused at registration; a refused redirect never reaches the reader', async () => {
    await assert.rejects(proxy.register('http://10.0.0.1/v/1'), (e) => e.code === 'fetch.refused');
    await assert.rejects(proxy.register('https://evil.example/v/1'), (e) => e.code === 'fetch.refused');
    const h = await proxy.register(`${base}/redirect-out`);
    const r = await fetch(h.url);
    assert.ok([403, 502].includes(r.status), `refused: ${r.status}`);
    proxy.close(); upstream.close();
});

t.run();
