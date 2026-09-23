'use strict';
// Media/image inputs are fetched only from allow-listed OpenVibe hosts over https, never from IP
// literals, internal addresses (checked at connect time, so DNS answers pointing inside are refused),
// or via redirects to anything else. The operator-configured Media internal origin is the only
// exception. Refusals fail the run explicitly (fetch.refused) — nothing is fabricated in its place.

const assert = require('assert');
const nodeHttp = require('http');
const { boot, request, token, suite, ALL } = require('./helpers');
const { createFetcher, isPublicAddress } = require('../server/fetcher');
const { load } = require('../server/config');

const t = suite('ssrf');
const tok = token('live', ALL);
let h;
let media;
let mediaBase;

const refused = async (fetcher, url) => {
    try { await fetcher.fetchUrl(url); } catch (e) { return e.code; }
    return 'fetched';
};

t.test('address policy: internal, loopback, link-local, mapped IPv6 are not public', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'fe80::1', 'fc00::1', '100.64.0.1']) {
        assert.strictEqual(isPublicAddress(ip), false, ip);
    }
    for (const ip of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) assert.strictEqual(isPublicAddress(ip), true, ip);
});

t.test('URL rules: https + allow-listed host only', async () => {
    const f = createFetcher(load({ NODE_ENV: 'test' }));
    const bad = ['http://openvibe.media/v/1', 'https://evil.example/x', 'https://openvibe.media.evil.example/x', 'https://evilopenvibe.media/x', 'https://127.0.0.1/x',
        'https://[::1]/x', 'https://user:pw@openvibe.media/x', 'file:///etc/passwd', 'gopher://openvibe.media/x', 'not a url'];
    for (const u of bad) {
        try { f.judge(u); assert.fail(`judged ok: ${u}`); } catch (e) { assert.strictEqual(e.code, 'fetch.refused', u); }
    }
    assert.ok(f.judge('https://openvibe.media/v/1'));
    assert.ok(f.judge('https://ai.openvibe.network/x'), '*.openvibe.network');
    assert.strictEqual(f.mediaRefUrl({ media_id: 'legacy:live:vod:42' }), 'https://openvibe.media/v/42');
    assert.throws(() => f.mediaRefUrl({ media_id: 'med_01JAB2C3D4E5F6G7H8J9K0MNPA' }), e => e.code === 'media.unresolvable');
});

t.test('an allow-listed NAME that resolves to an internal address is refused at connect time', async () => {
    const f = createFetcher(load({ NODE_ENV: 'test', AI_FETCH_ALLOW_HOSTS: 'localhost' }));
    assert.ok(f.judge('https://localhost/x'), 'the name itself is on the list');
    assert.strictEqual(await refused(f, 'https://localhost/x'), 'fetch.refused');
});

t.test('the internal Media origin is fetched; its redirect elsewhere is refused; size is capped', async () => {
    media = nodeHttp.createServer((req, res) => {
        if (req.url === '/redir') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' }); return res.end(); }
        if (req.url === '/redir-ok') { res.writeHead(302, { Location: '/img' }); return res.end(); }
        if (req.url === '/big') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(Buffer.alloc(4096)); }
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    });
    await new Promise(r => media.listen(0, '127.0.0.1', r));
    mediaBase = `http://127.0.0.1:${media.address().port}`;
    const f = createFetcher(load({ NODE_ENV: 'test', OV_MEDIA_INTERNAL_URL: mediaBase, AI_FETCH_MAX_IMAGE_BYTES: '1000' }));
    const ok = await f.fetchUrl(`${mediaBase}/img`);
    assert.ok(ok.bytes > 0);
    assert.ok((await f.fetchUrl(`${mediaBase}/redir-ok`)).bytes > 0, 'same-origin redirect ok');
    assert.strictEqual(await refused(f, `${mediaBase}/redir`), 'fetch.refused');
    try { await f.loadImage({ url: `${mediaBase}/big` }); assert.fail('big image fetched'); } catch (e) { assert.strictEqual(e.code, 'source.too_large'); }
    const other = `http://127.0.0.1:${media.address().port + 1}/x`;
    assert.strictEqual(await refused(f, other), 'fetch.refused', 'another port on loopback is not the internal origin');
});

t.test('a run whose image URL is not allowed fails with fetch.refused and no provider call', async () => {
    h = await boot({ env: { OV_MEDIA_INTERNAL_URL: mediaBase } });
    const before = h.pool.stats.stub ? h.pool.stats.stub.calls : 0;
    for (const url of ['http://169.254.169.254/latest/meta-data', 'https://internal.example/x', 'http://127.0.0.1:22/']) {
        const r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok, body: { workflow: 'live.stream.describe_frame', input: { image: { url } } } });
        assert.strictEqual(r.body.run.status, 'failed', url);
        assert.strictEqual(r.body.run.error.code, 'fetch.refused', url);
        assert.strictEqual(r.body.run.output, null);
    }
    assert.strictEqual(h.pool.stats.stub ? h.pool.stats.stub.calls : 0, before);
    const good = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok, body: { workflow: 'live.stream.describe_frame', input: { image: { url: `${mediaBase}/img` } } } });
    assert.strictEqual(good.body.run.status, 'succeeded');
    const tx = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok, body: { workflow: 'live.media.transcribe', input: { media_url: 'https://evil.example/a.mp4' } } });
    assert.strictEqual(tx.body.run.error.code, 'fetch.refused');
});

t.test('shutdown', async () => { await h.stop(); media.close(); });

t.run();
