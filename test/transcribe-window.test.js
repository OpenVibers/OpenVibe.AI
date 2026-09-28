'use strict';
// live.media.transcribe by window (roadmap WS-O task 2: Live's VOD and clip transcripts run here). start_sec seeks
// (the loopback reader streams the recording; nothing is downloaded) and offsets the timestamps unless offset_sec
// says otherwise; low_power is accepted; a URL outside the rules is refused before anything runs.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const nodeHttp = require('http');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('transcribe-window');
const tok = token('live', ALL);
let h; let media; let base; let hits = 0;

t.test('boot with an internal Media stand-in', async () => {
    media = nodeHttp.createServer((req, res) => { hits++; res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' }); res.end(Buffer.alloc(4096, 1)); });
    await new Promise((r) => media.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${media.address().port}`;
    h = await boot({ env: { OV_MEDIA_INTERNAL_URL: base } });
});

t.test('a window starts at start_sec and its timestamps follow', async () => {
    const run = (input) => request(h.base, 'POST', '/api/v1/runs?wait=20000', { tok, body: { workflow: 'live.media.transcribe', input: { media_url: `${base}/v/7`, language: 'en', ...input } } });
    let r = await run({ start_sec: 300, seconds: 60, low_power: true });
    assert.strictEqual(r.body.run.status, 'succeeded', JSON.stringify(r.body.run.error || r.body));
    const segs = r.body.run.output.segments;
    assert.ok(segs.length && segs.every((s) => s.start >= 300 && s.start < 360), JSON.stringify(segs));
    r = await run({ start_sec: 300, seconds: 60, offset_sec: 0 });
    assert.ok(r.body.run.output.segments.every((s) => s.start < 60), 'offset_sec overrides');
    const work = path.join(h.dir, 'media-tmp');
    assert.deepStrictEqual(fs.existsSync(work) ? fs.readdirSync(work) : [], [], 'nothing downloaded');
    r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok, body: { workflow: 'live.media.transcribe', input: { media_url: 'https://evil.example/x.mp4' } } });
    assert.strictEqual(r.body.run ? r.body.run.error.code : r.body.code, 'fetch.refused');
    await h.stop(); media.close();
});

t.run();
