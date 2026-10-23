'use strict';
// The loopback reader media.analyze streams through (server/media-proxy.js; roadmap WS-O task 2): ffmpeg reads a
// registered token and gets the real URL's bytes, Range requests pass through (206 with Content-Range), HEAD answers
// headers only, an unknown or released token is 404, and a redirect the fetcher's rules refuse (a public host
// sending it to the internal Media origin) never reaches the reader: 403. An HLS playlist (Media's virtual clips) is
// rewritten so each URI it names is read through the same token.
const assert = require('assert');
const nodeHttp = require('http');
const { suite } = require('./helpers');
const { load } = require('../server/config');
const { createFetcher } = require('../server/fetcher');
const { createMediaProxy, rewritePlaylist } = require('../server/media-proxy');

const t = suite('media-proxy');
const BODY = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
let upstream; let base; let proxy;
const HLS = {
    '/o/med_1/master.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nsource/index.m3u8\n',
    '/o/med_1/source/index.m3u8': '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.000,\n000001.m4s\n#EXTINF:2.000,\n000002.m4s?t=1\n#EXT-X-ENDLIST\n',
    '/o/med_1/source/init.mp4': 'INIT', '/o/med_1/source/000001.m4s': 'SEG1', '/o/med_1/source/000002.m4s?t=1': 'SEG2',
    '/o/med_2/index.m3u8': '#EXTM3U\n#EXTINF:2.000,\nhttps://evil.example/1.ts\n',
};

t.test('boot an internal Media stand-in', async () => {
    upstream = nodeHttp.createServer((req, res) => {
        if (req.url === '/redirect-out') { res.writeHead(302, { Location: 'https://evil.example/x' }); return res.end(); }
        // A virtual clip: /c/9 redirects to its master playlist, which names a media playlist relative to itself.
        if (req.url === '/c/9') { res.writeHead(302, { Location: '/o/med_1/master.m3u8' }); return res.end(); }
        if (HLS[req.url]) { res.writeHead(200, { 'Content-Type': req.url.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl; charset=utf-8' : 'video/mp4' }); return res.end(HLS[req.url]); }
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

t.test('an HLS playlist is rewritten: every URI, resolved where the playlist came from, is a part of the same token', async () => {
    const h = await proxy.register(`${base}/c/9`);
    let r = await fetch(h.url);
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /mpegurl/);
    const master = await r.text();
    const media = master.split('\n').find((l) => l.startsWith('http'));
    assert.strictEqual(media, `${h.url}/0/index.m3u8`, 'source/index.m3u8 resolved against the redirect target, not the loopback URL');
    const list = await (await fetch(media)).text();
    assert.ok(list.includes(`#EXT-X-MAP:URI="${h.url}/1/init.mp4"`), list);
    const segs = list.split('\n').filter((l) => l.startsWith('http'));
    assert.deepStrictEqual(segs, [`${h.url}/2/000001.m4s`, `${h.url}/3/000002.m4s`], 'the file name keeps the extension ffmpeg checks');
    assert.deepStrictEqual(await Promise.all([`${h.url}/1/init.mp4`, ...segs].map(async (u) => (await fetch(u)).text())), ['INIT', 'SEG1', 'SEG2']);
    // Read again, the same URIs keep their numbers.
    assert.strictEqual(await (await fetch(media)).text(), list);
    assert.strictEqual((await fetch(`${h.url}/99/x.m4s`)).status, 404, 'a part no playlist named');
    // A playlist naming a host the rules refuse is refused whole.
    const bad = await proxy.register(`${base}/o/med_2/index.m3u8`);
    assert.strictEqual((await fetch(bad.url)).status, 403);
    h.release(); bad.release();
    assert.strictEqual((await fetch(segs[0])).status, 404, 'parts go with their token');
});

t.test('rewritePlaylist: URI lines and URI attributes, relative and absolute; tags and blank lines kept', () => {
    const out = rewritePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../k.bin"\n\na.ts\nhttps://cdn.example/b.ts\n', 'https://m.example/x/y/list.m3u8', (u) => `<${u}>`);
    assert.strictEqual(out, '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="<https://m.example/x/k.bin>"\n\n<https://m.example/x/y/a.ts>\n<https://cdn.example/b.ts>\n');
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
