'use strict';
// The Exchange speech route: POST /v1/audio/speech speaks Chat's cloud voices through AI's own
// Google Cloud TTS and Amazon Polly providers, metered per character like the providers bill.
//
//   - a Google voice and a Polly voice answer audio bytes against local fake provider hosts, with the
//     run and receipt ids in the headers; the other provider is never called for that voice;
//   - metering: the receipt's cost is characters / 1M × the voice's list price, and the receipt carries
//     the character count;
//   - an unknown voice is refused before any provider is called;
//   - an over-quota call is refused before any provider is called;
//   - the full receipt is at GET /v1/receipts/:id.
//
// No test reaches the internet: the providers' own hosts are replaced by local fakes through
// AI_GOOGLE_TTS_BASE_URL / AI_POLLY_BASE_URL. The keys are dummies.
const assert = require('assert');
const http = require('http');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('exchange-speech');
const service = token('exchange', ALL);
const FAKE_MP3 = Buffer.from('ID3\x04fake-mp3-bytes');

let h;
let google;
let polly;

async function fakeGoogle() {
    const state = { calls: [], bodies: [] };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            state.calls.push(req.url);
            try { state.bodies.push(JSON.parse(raw || '{}')); } catch { state.bodies.push({}); }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ audioContent: FAKE_MP3.toString('base64') }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    state.url = `http://127.0.0.1:${server.address().port}`;
    state.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
    return state;
}

async function fakePolly() {
    const state = { calls: [], bodies: [] };
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => { chunks.push(c); });
        req.on('end', () => {
            state.calls.push(req.url);
            try { state.bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { state.bodies.push({}); }
            res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
            res.end(FAKE_MP3);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    state.url = `http://127.0.0.1:${server.address().port}`;
    state.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
    return state;
}

const speak = (body) => request(h.base, 'POST', '/v1/audio/speech', { tok: service, body });

t.test('boot with fake Google and Polly hosts', async () => {
    google = await fakeGoogle();
    polly = await fakePolly();
    h = await boot({ env: {
        AI_STUB_FALLBACK: 'false',
        AI_GOOGLE_TTS_API_KEY: 'test-google-key',
        AI_GOOGLE_TTS_BASE_URL: google.url,
        AI_POLLY_ACCESS_KEY_ID: 'test-polly-key',
        AI_POLLY_SECRET_ACCESS_KEY: 'test-polly-secret',
        AI_POLLY_REGION: 'us-east-1',
        AI_POLLY_BASE_URL: polly.url,
    } });
    const providers = await request(h.base, 'GET', '/api/v1/providers', { tok: service });
    assert.strictEqual(providers.status, 200, providers.text);
    for (const key of ['google-tts', 'polly']) {
        const p = providers.body.providers.find((x) => x.key === key);
        assert.ok(p, `${key} is registered`);
        assert.strictEqual(p.status, 'active', `${key} is active with its key: ${p.status}`);
    }
});

t.test('a Google voice answers MP3 through the Google adapter only', async () => {
    const r = await speak({ model: 'tts-1', input: 'hello world', voice: 'gc_neural_chad' });
    assert.strictEqual(r.status, 200, r.text.slice(0, 300));
    assert.strictEqual(r.headers.get('content-type'), 'audio/mpeg');
    assert.ok(r.headers.get('x-openvibe-run-id'), 'the run id is in the headers');
    assert.match(String(r.headers.get('x-openvibe-receipt-id') || ''), /^rcpt_/, 'the receipt id is in the headers');
    assert.strictEqual(google.calls.length, 1, 'google was called once');
    assert.strictEqual(google.bodies[0].voice.name, 'en-US-Neural2-D', 'the provider voice, not the Chat id');
    assert.strictEqual(google.bodies[0].input.text, 'hello world');
    assert.strictEqual(polly.calls.length, 0, 'polly was never called');
});

t.test('a Polly voice answers through the Polly adapter only', async () => {
    const r = await speak({ model: 'tts-1', input: 'hi', voice: 'pl_ruth_neural', response_format: 'mp3' });
    assert.strictEqual(r.status, 200, r.text.slice(0, 300));
    assert.strictEqual(polly.calls.length, 1, 'polly was called once');
    assert.strictEqual(polly.bodies[0].VoiceId, 'Ruth');
    assert.strictEqual(polly.bodies[0].Engine, 'neural');
    assert.strictEqual(google.calls.length, 1, 'google was not called again');
});

t.test('metering is per character, and the receipt carries the count and the cost', async () => {
    const text = 'hello world'; // 11 characters at Neural2's $16 per million
    const r = await speak({ model: 'tts-1', input: text, voice: 'gc_neural_chad' });
    assert.strictEqual(r.status, 200, r.text.slice(0, 300));
    const id = r.headers.get('x-openvibe-receipt-id');
    const header = JSON.parse(r.headers.get('x-openvibe-receipt'));
    assert.strictEqual(header.offer, 'google-tts/gc_neural_chad');
    assert.strictEqual(header.tokens.characters, text.length);
    const expected = (text.length / 1e6) * 16;
    assert.ok(Math.abs(header.cost_usd - expected) < 1e-9, `cost is ${text.length} chars at $16/M: ${header.cost_usd}`);
    const full = await request(h.base, 'GET', `/v1/receipts/${id}`, { tok: service });
    assert.strictEqual(full.status, 200, full.text);
    const receipt = full.body.receipt;
    assert.strictEqual(receipt.workflow, 'ai.speak');
    assert.deepStrictEqual([receipt.offer.provider, receipt.offer.model], ['google-tts', 'gc_neural_chad']);
    assert.strictEqual(receipt.usage.characters, text.length);
    assert.ok(Math.abs(receipt.cost_usd - expected) < 1e-9);
});

t.test('an unknown voice is refused before any provider is called', async () => {
    const calls = google.calls.length + polly.calls.length;
    const r = await speak({ model: 'tts-1', input: 'hello', voice: 'no-such-voice' });
    assert.strictEqual(r.status, 404, r.text);
    assert.strictEqual(r.body.error.code, 'ai.model_not_found');
    assert.strictEqual(google.calls.length + polly.calls.length, calls, 'no provider was called');
});

t.test('validation refuses a bad format, a bad speed and an empty input', async () => {
    for (const [body, code] of [
        [{ model: 'tts-1', input: 'hello', voice: 'gc_neural_chad', response_format: 'flac' }, 400],
        [{ model: 'tts-1', input: 'hello', voice: 'gc_neural_chad', speed: 9 }, 400],
        [{ model: 'tts-1', input: '   ', voice: 'gc_neural_chad' }, 400],
        [{ model: 'tts-1', voice: 'gc_neural_chad' }, 400],
    ]) {
        const r = await speak(body);
        assert.strictEqual(r.status, code, JSON.stringify(body));
    }
});

t.test('an over-quota call is refused before any provider is called', async () => {
    const q = await request(h.base, 'POST', '/api/v1/quotas', { tok: service, body: { scope_type: 'service', scope_id: '*', window: 'minute', max_requests: 1 } });
    assert.ok([200, 201].includes(q.status), q.text);
    const calls = google.calls.length + polly.calls.length;
    const r = await speak({ model: 'tts-1', input: 'over the cap', voice: 'gc_neural_chad' });
    assert.strictEqual(r.status, 429, r.text);
    assert.strictEqual(r.body.error.code, 'quota.exceeded');
    assert.strictEqual(google.calls.length + polly.calls.length, calls, 'no provider was called');
});

t.test('shutdown', async () => { await h.stop(); await google.close(); await polly.close(); });

t.run();
