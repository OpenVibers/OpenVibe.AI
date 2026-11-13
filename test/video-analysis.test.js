'use strict';
// video.analyze: the AI reads a video (plan Z.9 step 4).
//
//   - the frame times: the scene cuts and one frame every 30 s, spread over the video and capped by the depth
//   - the words keep the times the speech provider gave them
//   - a name is kept only when the video shows or says it
//   - the explicit rule: nudity is fine, sex acts and a child with nudity are not
//   - a whole run on a stubbed ffprobe and ffmpeg: the seven steps in order, the output that matches
//     ai.video-analysis@1, and the receipt
//   - a video without sound: no transcript, and the run says so
//   - a URL that Media does not host is refused before a run is made
//   - a video Media may not read: Media decides, and the run fails with that reason
//   - the price: per minute of video and per depth
//   - a real run on the real ffprobe and ffmpeg (skipped without them)
//
// No test reaches the internet: the model that reads the frames and writes the analysis is a local HTTP
// seam, the speech route is answered by the deterministic stub, and ffprobe and ffmpeg are stubbed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeHttp = require('http');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');
const schemas = require('../server/schemas');
const va = require('../server/video-analysis');
const { classifyText } = require('../server/video-analysis/explicit');
const { REPORT, FRAME_CAPS, DEPTHS } = require('../server/video-analysis/schema');

const HAS_FFMPEG = spawnSync('ffprobe', ['-version']).status === 0 && spawnSync('ffmpeg', ['-version']).status === 0;
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'media-analysis.mp4'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** A ffprobe and ffmpeg that answer without a video: the facts, the cuts, and the files they were asked for. */
function fakeTools({ duration = 60, cuts = [], audio = true, probeFails = false } = {}) {
    const calls = [];
    const spawnImpl = (bin, args) => {
        calls.push({ bin: String(bin), args: args.map(String) });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        setImmediate(() => {
            if (probeFails) { child.emit('close', 1); return; }
            if (String(bin).includes('ffprobe')) {
                const streams = [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '30000/1001', side_data_list: [{ rotation: 90 }] }];
                if (audio) streams.push({ codec_type: 'audio', codec_name: 'aac', sample_rate: 48000, channels: 2 });
                child.stdout.emit('data', JSON.stringify({ format: { duration: String(duration), size: '123456' }, streams }));
            } else if (args.includes('-filter:v')) {
                child.stderr.emit('data', cuts.map((t) => 'frame:0 pts:0 pts_time:' + t).join('\n'));
            } else {
                // A frame or an audio window: the file it was asked for.
                const out = args[args.length - 1];
                try { fs.writeFileSync(out, PNG); } catch (e) { /* the run notices the missing file */ }
            }
            child.emit('close', 0);
        });
        return child;
    };
    return { spawnImpl, calls };
}

/** Every word of the request, so the seam knows which call it is answering. */
const allText = (body) => [].concat(body.system || [], body.messages || [])
    .map((m) => (typeof m === 'string' ? m : (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || m.text || '')))).join('\n');

const t = suite('video-analysis');
const tok = token('live', ALL);

/** The local OpenVibe.Media: the video it holds, and 404 for anything else. */
async function mediaServer(bytes = FIXTURE) {
    const server = nodeHttp.createServer((req, res) => {
        if (req.url === '/video.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end(bytes); return; }
        res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {
        url: 'http://127.0.0.1:' + server.address().port,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
    };
}

/** A seam that answers the two model calls with fixed JSON. */
async function modelSeam() {
    return await seamServer((body) => {
        const text = allText(body);
        if (text.includes('describe one frame')) {
            return { json: { caption: 'A desk with a keyboard and a coffee cup.', text: 'README.md', people: [], objects: ['keyboard'], places: [], explicit: 'fine' } };
        }
        return { json: {
            summary: 'A short screen recording of a developer editing a README file.',
            chapters: [{ start: 0, end: 30, title: 'The README' }],
            entities: [{ name: 'README.md', kind: 'object', evidence: [{ t: 5, from: 'frame' }] }, { name: 'Nobody', kind: 'person', evidence: [{ t: 7, from: 'speech' }] }],
            tags: ['screen recording', 'developer'],
            answer: 'It shows a README file being edited.',
        } };
    });
}

/** A service with the stubbed tools, the model on the seam and Media on the local server. */
async function service({ tools = null, media, seam, env = {} } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-ai-video-'));
    const h = await boot({
        ...(tools ? { spawnImpl: tools.spawnImpl } : {}),
        env: {
            OV_MEDIA_INTERNAL_URL: media.url, OV_MEDIA_URL: media.url,
            AI_HTTP_SEAM_URL: seam.url, AI_FREE_PROVIDERS: 'http-seam', AI_FREE_DAILY_TOKENS: '100000',
            AI_VIDEO_ANALYSIS_DIR: dir, AI_VIDEO_ANALYSIS_DISK_RESERVE_BYTES: '0',
            ...env,
        },
    });
    // The seam is the model that reads the frames and writes the analysis; the stub still hears the audio.
    await h.registry.upsertProvider({ key: 'http-seam', capabilities: ['chat', 'generate', 'json', 'summarize', 'classify', 'extract', 'enrich', 'vision'], default_model: 'video-fake', billing_profile: 'free', provider_access: 'OWN_DEPLOYMENT' }, { actor: 'test' });
    await h.registry.upsertModel({ provider_key: 'http-seam', model_key: 'video-fake', type: 'chat', status: 'active', supports: { json: true, vision: true }, cost: { in_per_mtok: 0, out_per_mtok: 0, cached_per_mtok: 0 } }, { actor: 'test' });
    return { ...h, dir };
}

async function waitFor(base, id, ms = 60000) {
    const started = Date.now();
    for (;;) {
        const r = await request(base, 'GET', '/api/v1/video-analyses/' + id + '/state', { tok });
        const st = r.body && r.body.video_analysis;
        if (st && ['succeeded', 'failed', 'cancelled'].includes(st.status)) return st;
        if (Date.now() - started > ms) return st || null;
        await new Promise((r) => setTimeout(r, 40));
    }
}

t.test('the frame times: the cuts and one every 30 s, capped by the depth', () => {
    const times = va.pickTimes({ sceneTimes: [8, 16, 24], duration: 60, everySec: 30, cap: 12 });
    assert.deepStrictEqual(times, [0, 8, 16, 24, 30]);
    const many = va.pickTimes({ sceneTimes: Array.from({ length: 300 }, (_, i) => i * 2 + 1), duration: 600, everySec: 30, cap: 12 });
    assert.strictEqual(many.length, 12, 'at most 12 frames for a quick run');
    assert.strictEqual(many[0], 0, 'the first frame is kept');
    assert.ok(many[many.length - 1] <= 600);
    assert.deepStrictEqual(FRAME_CAPS, { quick: 12, standard: 32, deep: 96 });
});

t.test('the words keep the times the speech provider gave them', () => {
    const w = va.wordsOf([{ start: 0, end: 2, text: 'hello there', words: [{ start: 0, end: 1, text: 'hello' }, { start: 1, end: 2, text: 'there' }] }], 60);
    assert.deepStrictEqual(w, [{ t0: 60, t1: 61, w: 'hello' }, { t0: 61, t1: 62, w: 'there' }], 'a window\'s words carry the window\'s offset');
    const whole = va.wordsOf([{ start: 3, end: 5, text: 'a sentence' }], 0);
    assert.deepStrictEqual(whole, [{ t0: 3, t1: 5, w: 'a sentence' }], 'a provider with no word times keeps its own times; nothing is invented');
});

t.test('a name is kept only when the video shows or says it', () => {
    const frames = [{ caption: 'A desk with a keyboard.', text: 'README.md' }];
    const transcriptText = 'we open the readme file';
    const kept = va.verifyEntities([
        { name: 'README.md', kind: 'object', evidence: [{ t: 5, from: 'frame' }] },
        { name: 'keyboard', kind: 'object', evidence: [{ t: 6, from: 'frame' }] },
        { name: 'Nobody', kind: 'person', evidence: [{ t: 7, from: 'speech' }] },
        { name: 'readme', kind: 'object', evidence: [{ t: 9, from: 'speech' }] },
        { name: 'README.md', kind: 'object', evidence: [{ t: 900, from: 'frame' }] },
    ], { frames, transcriptText, duration: 60 });
    assert.deepStrictEqual(kept.entities.map((e) => e.name), ['README.md', 'keyboard', 'readme']);
    assert.deepStrictEqual(kept.dropped, ['Nobody (not shown or said)', 'README.md (no time in the video)']);
    const chapters = va.verifyChapters([{ start: 0, end: 30, title: 'One' }, { start: 40, end: 20, title: 'Backwards' }, { start: 100, end: 120, title: 'Past the end' }], 60);
    assert.deepStrictEqual(chapters, [{ start: 0, end: 30, title: 'One' }]);
});

t.test('the explicit rule: nudity is fine, sex acts and a child with nudity are not', () => {
    assert.strictEqual(classifyText('A person stands in the light.').category, 'fine');
    assert.strictEqual(classifyText('A nude body is shown.').category, 'fine', 'nudity is allowed');
    assert.strictEqual(classifyText('The scene shows sexual activity.').category, 'sex_acts');
    assert.strictEqual(classifyText('A child is naked in the same picture.').category, 'minor_sexual');
    assert.strictEqual(classifyText('Kids in swimsuits at the beach.').category, 'fine');
});

t.test('the price: per minute of video and per depth', async () => {
    const media = await mediaServer();
    const seam = await modelSeam();
    const tools = fakeTools();
    const h = await service({ tools, media, seam });
    try {
        const r = await request(h.base, 'GET', '/api/v1/video-analyses/pricing', {});
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.strictEqual(r.body.workflow, 'video.analyze');
        assert.strictEqual(r.body.schema, 'ai.video-analysis@1');
        const byDepth = Object.fromEntries(r.body.depths.map((d) => [d.key, d]));
        assert.deepStrictEqual(Object.keys(byDepth).sort(), [...DEPTHS].sort());
        assert.strictEqual(byDepth.quick.frames, 12);
        assert.strictEqual(byDepth.standard.frames, 32);
        assert.strictEqual(byDepth.deep.frames, 96);
        assert.ok(byDepth.quick.price_usd_per_minute > 0 && byDepth.deep.price_usd_per_minute > byDepth.quick.price_usd_per_minute);
        // A ten minute video: the price is the rate times the minutes, and never under the floor.
        const ten = await request(h.base, 'POST', '/api/v1/video-analyses', { tok, body: { url: media.url + '/video.mp4', depth: 'quick', duration_s: 600 } });
        assert.strictEqual(ten.status, 202, ten.text.slice(0, 300));
        assert.strictEqual(ten.body.price_usd, Math.round(byDepth.quick.price_usd_per_minute * 10 * 1e6) / 1e6);
        const short = await request(h.base, 'POST', '/api/v1/video-analyses', { tok, body: { url: media.url + '/video.mp4', depth: 'quick', duration_s: 5 } });
        assert.strictEqual(short.body.price_usd, byDepth.quick.price_usd_min, 'a short video pays the floor');
    } finally { await h.stop(); await media.close(); await seam.close(); }
});

t.test('a URL that Media does not host is refused before a run is made', async () => {
    const media = await mediaServer();
    const seam = await modelSeam();
    const tools = fakeTools();
    const h = await service({ tools, media, seam });
    try {
        const r = await request(h.base, 'POST', '/api/v1/video-analyses', { tok, body: { url: 'https://example.org/video.mp4', depth: 'quick' } });
        assert.strictEqual(r.status, 422, r.text.slice(0, 300));
        assert.strictEqual(r.body.code, 'input.invalid');
        assert.ok(!tools.calls.length, 'nothing was fetched and no tool ran');
    } finally { await h.stop(); await media.close(); await seam.close(); }
});

t.test('a run: the seven steps, the schema, and the receipt', async () => {
    const media = await mediaServer();
    const seam = await modelSeam();
    const tools = fakeTools({ duration: 60, cuts: [8, 16, 24] });
    const h = await service({ tools, media, seam });
    try {
        const created = await request(h.base, 'POST', '/api/v1/video-analyses', { tok, body: { url: media.url + '/video.mp4', depth: 'quick', ask: 'What is on the screen?' } });
        assert.strictEqual(created.status, 202, created.text.slice(0, 400));
        const id = created.body.video_analysis.id;
        const state = await waitFor(h.base, id);
        assert.strictEqual(state.status, 'succeeded', JSON.stringify(state.error));
        const done = await request(h.base, 'GET', '/api/v1/video-analyses/' + id, { tok });
        const out = done.body.video_analysis.report;
        assert.ok(out, 'the report is stored');
        // The output matches the published document.
        const v = schemas.validate(REPORT, out);
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.strictEqual(out.duration_s, 60);
        assert.strictEqual(out.probe.video.width, 1280);
        assert.strictEqual(out.probe.video.fps, 29.97);
        assert.strictEqual(out.probe.video.rotation, 90);
        assert.strictEqual(out.probe.audio.codec, 'aac');
        // The steps, in order, each one in the receipt.
        assert.deepStrictEqual(out.receipt.steps.map((s) => s.key), ['probe', 'keyframes', 'transcript', 'describe', 'analyse', 'explicit']);
        assert.ok(out.receipt.steps.every((s) => ['done', 'skipped', 'failed'].includes(s.status)));
        assert.ok(out.receipt.steps.find((s) => s.key === 'probe').detail.includes('60 s'));
        assert.ok(typeof out.receipt.cost_usd === 'number' && out.receipt.cost_usd >= 0);
        assert.ok(out.receipt.models.length >= 2, 'the frames were read and the video was written up');
        assert.ok(out.receipt.models.every((m) => ['describe', 'analyse', 'explicit'].includes(m.step)));
        // The frames: at most the cap for the depth, each with what was shown and the text on screen.
        assert.ok(out.keyframes.length > 0 && out.keyframes.length <= 12, 'at most 12 frames for a quick run');
        assert.ok(out.keyframes.every((f) => typeof f.t === 'number' && f.url.includes('/frames/') && f.caption));
        assert.ok(out.keyframes.every((f) => f.text === 'README.md'));
        // The transcript: the words with their times.
        assert.ok(out.transcript.words.length > 0, 'the speech route answered');
        assert.ok(out.transcript.words.every((x) => x.t0 <= x.t1 && typeof x.w === 'string' && x.w));
        assert.ok(out.transcript.text.length > 0);
        // The chapters, the summary, the names that were shown, the tags and the answer.
        assert.ok(out.summary.includes('README'));
        assert.deepStrictEqual(out.chapters, [{ start: 0, end: 30, title: 'The README' }]);
        assert.deepStrictEqual(out.entities.map((e) => e.name), ['README.md'], 'a name the video does not show or say is not kept');
        assert.deepStrictEqual(out.entities[0].evidence, [{ t: 5, from: 'frame' }]);
        assert.deepStrictEqual(out.tags, ['screen recording', 'developer']);
        assert.strictEqual(out.answer, 'It shows a README file being edited.');
        assert.strictEqual(out.explicit.category, 'fine');
        // The tools really ran: ffprobe read the facts and ffmpeg took the frames.
        assert.ok(tools.calls.some((c) => c.bin.includes('ffprobe')));
        assert.strictEqual(tools.calls.filter((c) => c.bin.includes('ffmpeg') && c.args.includes('-frames:v')).length, out.keyframes.length);
        // The frame is served back to the owner alone.
        const frame = await request(h.base, 'GET', '/api/v1/video-analyses/' + id + '/frames/0', { tok });
        assert.strictEqual(frame.status, 200, frame.text.slice(0, 200));
        assert.strictEqual(frame.headers.get('content-type'), 'image/jpeg');
        assert.ok(frame.headers.get('cache-control').includes('no-store'));
        // The run's own receipt is on the run row too.
        const run = await request(h.base, 'GET', '/api/v1/runs/' + id, { tok });
        assert.strictEqual(run.body.run.status, 'succeeded');
        assert.ok(run.body.run.usage, 'the run kept its usage');
    } finally { await h.stop(); await media.close(); await seam.close(); }
});

t.test('the caps per depth: a long video is read at most 12 frames at quick', async () => {
    const media = await mediaServer();
    const seam = await modelSeam();
    const tools = fakeTools({ duration: 600, cuts: Array.from({ length: 200 }, (_, i) => i * 3 + 1) });
    const h = await service({ tools, media, seam });
    try {
        const created = await request(h.base, 'POST', '/api/v1/video-analyses', { tok, body: { url: media.url + '/video.mp4', depth: 'quick' } });
        const state = await waitFor(h.base, created.body.video_analysis.id);
        assert.strictEqual(state.status, 'succeeded', JSON.stringify(state.error));
        const done = await request(h.base, 'GET', '/api/v1/video-analyses/' + created.body.video_analysis.id, { tok });
        const out = done.body.video_analysis.report;
        assert.strictEqual(out.keyframes.length, 12, 'twelve frames for a quick run, whatever the length of the video');
        assert.strictEqual(out.keyframes[0].t, 0);
        assert.strictEqual(out.duration_s, 600);
    } finally { await h.stop(); await media.close(); await seam.close(); }
});

t.test('a video without sound: no transcript, and the run says so', async () => {
    const media = await mediaServer();
    const seam = await modelSeam();
    const tools = fakeTools({ duration: 30, cuts: [5], audio: false });
    const h = await service({ tools, media, seam });
    try {
        const created = await request(h.base, 'POST', '/api/v1/video-analyses', { tok, body: { url: media.url + '/video.mp4', depth: 'quick' } });
        const state = await waitFor(h.base, created.body.video_analysis.id);
        assert.strictEqual(state.status, 'succeeded', JSON.stringify(state.error));
        const done = await request(h.base, 'GET', '/api/v1/video-analyses/' + created.body.video_analysis.id, { tok });
        const out = done.body.video_analysis.report;
        assert.deepStrictEqual(out.transcript, { lang: 'und', words: [], text: '' });
        assert.strictEqual(out.probe.audio, null);
        const step = out.receipt.steps.find((s) => s.key === 'transcript');
        assert.strictEqual(step.status, 'skipped');
        assert.ok(state.gaps.some((g) => g.includes('no sound')), JSON.stringify(state.gaps));
    } finally { await h.stop(); await media.close(); await seam.close(); }
});

t.test('a video the requester may not read: Media decides, and the run fails with that reason', async () => {
    const media = await mediaServer();
    const seam = await modelSeam();
    const tools = fakeTools();
    const h = await service({ tools, media, seam });
    try {
        const created = await request(h.base, 'POST', '/api/v1/video-analyses', { tok, body: { url: media.url + '/missing.mp4', depth: 'quick' } });
        assert.strictEqual(created.status, 202, created.text.slice(0, 300));
        const state = await waitFor(h.base, created.body.video_analysis.id);
        assert.strictEqual(state.status, 'failed');
        assert.strictEqual(state.error.code, 'media.not_readable');
    } finally { await h.stop(); await media.close(); await seam.close(); }
});

t.test('a host without ffprobe, and a video it cannot read: the run says why', async () => {
    const media = await mediaServer();
    const seam = await modelSeam();
    // A host where ffprobe is not installed: the child process cannot even start.
    const missing = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        setImmediate(() => child.emit('error', Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' })));
        return child;
    };
    const h = await service({ tools: { spawnImpl: missing }, media, seam });
    try {
        const created = await request(h.base, 'POST', '/api/v1/video-analyses', { tok, body: { url: media.url + '/video.mp4', depth: 'quick' } });
        const state = await waitFor(h.base, created.body.video_analysis.id);
        assert.strictEqual(state.status, 'failed');
        assert.strictEqual(state.error.code, 'video_analysis.tool_unavailable', 'a named reason, never run.internal');
        assert.ok(!/internal error/i.test(String(state.error.detail || '')), JSON.stringify(state.error));
    } finally { await h.stop(); await media.close(); await seam.close(); }
    // A file ffprobe cannot read: media.unreadable, and named too.
    const media2 = await mediaServer();
    const seam2 = await modelSeam();
    const tools = fakeTools({ probeFails: true });
    const h2 = await service({ tools, media: media2, seam: seam2 });
    try {
        const created = await request(h2.base, 'POST', '/api/v1/video-analyses', { tok, body: { url: media2.url + '/video.mp4', depth: 'quick' } });
        const state = await waitFor(h2.base, created.body.video_analysis.id);
        assert.strictEqual(state.status, 'failed');
        assert.strictEqual(state.error.code, 'media.unreadable');
    } finally { await h2.stop(); await media2.close(); await seam2.close(); }
});

t.test('a real run on the real ffprobe and ffmpeg', async () => {
    if (!HAS_FFMPEG) return console.log('video-analysis real run: skipped (no ffmpeg/ffprobe)');
    const media = await mediaServer();
    const seam = await modelSeam();
    const h = await service({ media, seam });
    try {
        const created = await request(h.base, 'POST', '/api/v1/video-analyses', { tok, body: { url: media.url + '/video.mp4', depth: 'quick' } });
        const state = await waitFor(h.base, created.body.video_analysis.id, 180000);
        assert.strictEqual(state.status, 'succeeded', JSON.stringify(state.error));
        const done = await request(h.base, 'GET', '/api/v1/video-analyses/' + created.body.video_analysis.id, { tok });
        const out = done.body.video_analysis.report;
        assert.ok(Math.abs(out.duration_s - 28) < 1, 'the real length of the fixture: ' + out.duration_s);
        assert.strictEqual(out.probe.video.codec, 'h264');
        assert.ok(out.keyframes.length > 0 && out.keyframes.length <= 12);
        const v = schemas.validate(REPORT, out);
        assert.ok(v.valid, JSON.stringify(v.errors));
    } finally { await h.stop(); await media.close(); await seam.close(); }
});

t.run();
