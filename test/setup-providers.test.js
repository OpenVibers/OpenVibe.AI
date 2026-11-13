'use strict';
/**
 * The researched providers of 2026-11-13 in the guided setup (OpenVibe.Network /admin/ai/setup):
 * fal.ai, Black Forest Labs (FLUX), Recraft, Ideogram, ElevenLabs, Deepgram and Voyage AI.
 *
 * No test reaches the network: every provider's own shape is replayed against a local seam. What this proves:
 *
 *   - the catalogue's offers carry the provider's own list price, the page it was read on and the day it was
 *     read, and every offer says why in six words at most;
 *   - Recraft and Ideogram say they answer in SVG, and Voyage says it reranks;
 *   - each adapter sends the request its provider documents and reads the answer in the shape the pool meters;
 *   - the setup page's own test path runs a new provider end to end: a key, a model, a route and one answer;
 *   - Altare is no longer recommended: its free plan carries no inference credit any more.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const nodeHttp = require('http');
const { suite, seamServer, boot, request, token, tmpDir } = require('./helpers');
const catalog = require('../server/setup/catalog');
const { createFalProvider } = require('../server/providers/fal');
const { createBflProvider } = require('../server/providers/bfl');
const { createRecraftProvider } = require('../server/providers/recraft');
const { createIdeogramProvider } = require('../server/providers/ideogram');
const { createDeepgramProvider } = require('../server/providers/deepgram');
const { createVoyageProvider } = require('../server/providers/voyage');
const { createSpeechProvider, ELEVEN_PRICE } = require('../server/providers/speech');

const t = suite('setup-providers');

/** A server that keeps the raw request, for the providers that post multipart or binary bodies. */
async function rawServer(handler) {
    const seen = [];
    const server = nodeHttp.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
            const raw = Buffer.concat(chunks);
            seen.push({ method: req.method, url: req.url, headers: req.headers, raw });
            const out = await handler({ raw, req });
            res.writeHead(out.status || 200, { 'Content-Type': out.contentType || 'application/json' });
            res.end(out.raw === undefined ? JSON.stringify(out.body === undefined ? {} : out.body) : out.raw);
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {
        seen, url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
    };
}

/** The offer of a step for one provider. */
const offerOf = (stepId, provider) => catalog.offersOf(catalog.stepById(stepId)).find((o) => o.provider === provider);

t.test('every offer names the provider\'s own price page and the day it was read', () => {
    for (const step of catalog.STEPS) {
        for (const offer of catalog.offersOf(step)) {
            assert.ok(offer.source, `${step.id}/${offer.model} has a price page`);
            assert.match(offer.checked, /^2026-11-\d{2}$/, `${step.id}/${offer.model} has the day it was read`);
            assert.ok(offer.price && offer.price.text, `${step.id}/${offer.model} has a price`);
            if (offer.why) assert.ok(offer.why.split(/\s+/).length <= 6, `${step.id}/${offer.model} why is six words at most: ${offer.why}`);
        }
    }
});

t.test('the researched providers sit on their steps with the prices their own pages published', () => {
    const fal = offerOf('image', 'fal');
    assert.ok(fal, 'fal.ai is on the Images step');
    assert.strictEqual(fal.price.per_image_usd, 0.003, 'FLUX.1 [schnell] is $0.003 per megapixel');
    assert.strictEqual(fal.checked, '2026-11-13');
    assert.strictEqual(fal.source, 'https://fal.ai/models/fal-ai/flux/schnell');
    assert.ok(fal.key_page && fal.key_page.url.startsWith('https://fal.ai/'), 'fal has a key page');

    const bfl = offerOf('image', 'bfl');
    assert.ok(bfl, 'BFL is on the Images step');
    assert.strictEqual(bfl.price.per_image_usd, 0.048, 'FLUX 3 Image is $0.048 at 1K');
    assert.strictEqual(bfl.source, 'https://bfl.ai/pricing');
    assert.strictEqual(bfl.checked, '2026-11-13');

    const recraft = offerOf('image', 'recraft');
    assert.ok(recraft, 'Recraft is on the Images step');
    assert.strictEqual(recraft.price.per_image_usd, 0.08, 'recraftv4_1_vector is $0.08 a picture');
    assert.strictEqual(recraft.source, 'https://www.recraft.ai/docs/api-reference/models/recraft-v4-1');

    const ideogram = offerOf('image', 'ideogram');
    assert.ok(ideogram, 'Ideogram is on the Images step');
    assert.strictEqual(ideogram.price.per_credit_usd, 0.01, 'Ideogram\'s API is $0.01 a credit');
    assert.strictEqual(ideogram.source, 'https://ideogram.ai/pricing');
    assert.strictEqual(ideogram.checked, '2026-11-13');

    const eleven = offerOf('speech', 'elevenlabs');
    assert.ok(eleven, 'ElevenLabs is on the Voices step');
    assert.strictEqual(eleven.price.per_million_chars_usd, 80, '$0.08 per 1,000 characters');
    assert.strictEqual(eleven.source, 'https://elevenlabs.io/pricing/api');

    const deepgram = offerOf('stt', 'deepgram');
    assert.ok(deepgram, 'Deepgram is on the Speech to text step');
    assert.strictEqual(deepgram.price.per_minute_usd, 0.0077, 'Nova-3 monolingual is $0.0077 a minute');
    assert.strictEqual(deepgram.source, 'https://deepgram.com/pricing');

    const voyage = offerOf('embedding', 'voyage');
    assert.ok(voyage, 'Voyage AI is on the Embeddings step');
    assert.strictEqual(voyage.price.in_per_mtok, 0.02, 'voyage-4-lite is $0.02 per 1M tokens');
    assert.strictEqual(voyage.source, 'https://docs.voyageai.com/docs/pricing');
});

t.test('Recraft and Ideogram say they answer in SVG; Voyage says it reranks', () => {
    const recraft = offerOf('image', 'recraft');
    assert.strictEqual(recraft.svg, true, 'Recraft answers in SVG');
    assert.strictEqual(recraft.icons, true, 'Recraft has the icon model');
    const ideogram = offerOf('image', 'ideogram');
    assert.strictEqual(ideogram.svg, true, 'Ideogram answers in SVG');
    const voyage = offerOf('embedding', 'voyage');
    assert.strictEqual(voyage.rerank, true, 'Voyage reranks with the same key');
});

t.test('Altare is not recommended any more: its free plan carries no inference credit', () => {
    assert.match(catalog.ALTARE_NOTE, /2026-11-13/, 'the note says when it was read');
    assert.match(catalog.ALTARE_NOTE, /docs\.altare\.gg\/inference\/pricing/, 'the note names the page');
    assert.match(catalog.ALTARE_NOTE, /no Token Plan and no plan credit/, 'the note says the free plan is empty');
    assert.match(catalog.ALTARE_NOTE, /bots, scheduled jobs, CI/, 'the note says what the plan is not for');
    for (const step of catalog.STEPS) {
        for (const offer of catalog.offersOf(step)) {
            assert.notStrictEqual(offer.provider, 'altare', `${step.id} does not recommend Altare`);
        }
    }
});

t.test('fal: the picture request is fal\'s own, and the answer is metered per picture', async () => {
    let seen = null;
    const up = await seamServer((body, req) => { seen = { body, url: req.url, headers: req.headers }; return { images: [{ url: 'https://fal.media/picture.jpg', content_type: 'image/jpeg' }] }; });
    try {
        const a = createFalProvider({ key: 'fal', base_url: up.url }, { apiKey: 'fal-key', fetchImpl: fetch });
        const out = await a.image({ model: 'flux-schnell', prompt: 'a blue square', n: 1, size: '1024x1024', timeoutMs: 3000 });
        assert.strictEqual(seen.url, '/fal-ai/flux/schnell', 'fal\'s own endpoint for the model');
        assert.strictEqual(seen.headers.authorization, 'Key fal-key', 'the key travels as fal wants it');
        assert.deepStrictEqual(seen.body, { prompt: 'a blue square', num_images: 1, image_size: 'square_hd' });
        assert.strictEqual(out.images[0].url, 'https://fal.media/picture.jpg');
        assert.strictEqual(out.usage.output, 1, 'the picture is metered as one picture');
    } finally { await up.close(); }
});

t.test('bfl: the picture is asked for, then polled until it is ready', async () => {
    const calls = [];
    const up = await seamServer((body, req) => {
        calls.push({ method: req.method, url: req.url, body, headers: req.headers });
        if (req.method === 'POST') return { status: 200, body: { id: 'job-1', polling_url: `${up.url}/v1/get/job-1` } };
        return { status: 200, body: { status: 'Ready', result: { sample: 'https://bfl.example/picture.png' } } };
    });
    try {
        const a = createBflProvider({ key: 'bfl', base_url: up.url }, { apiKey: 'bfl-key', fetchImpl: fetch });
        const out = await a.image({ model: 'flux-3-image', prompt: 'a lighthouse', size: '1024x1024', timeoutMs: 5000 });
        assert.strictEqual(calls[0].method, 'POST');
        assert.strictEqual(calls[0].url, '/v1/flux-3-image', 'bfl\'s own endpoint for FLUX 3 Image');
        assert.strictEqual(calls[0].headers['x-key'], 'bfl-key', 'the key travels as bfl wants it');
        assert.deepStrictEqual(calls[0].body, { prompt: 'a lighthouse', aspect_ratio: '1:1' });
        assert.strictEqual(calls[1].method, 'GET');
        assert.strictEqual(calls[1].url, '/v1/get/job-1', 'the polling address bfl answered with');
        assert.strictEqual(calls[1].headers['x-key'], 'bfl-key');
        assert.strictEqual(out.images[0].url, 'https://bfl.example/picture.png');
        assert.strictEqual(out.usage.output, 1);
    } finally { await up.close(); }
});

t.test('bfl: a polling address on another host is refused, and the key never travels there', async () => {
    const up = await seamServer(() => ({ polling_url: 'https://elsewhere.example/v1/get/job-1' }));
    try {
        const a = createBflProvider({ key: 'bfl', base_url: up.url }, { apiKey: 'bfl-key', fetchImpl: fetch });
        await assert.rejects(() => a.image({ model: 'flux-3-image', prompt: 'x', timeoutMs: 3000 }), (e) => e.code === 'provider.output');
    } finally { await up.close(); }
});

t.test('recraft: one endpoint serves every model, and a vector model answers in SVG', async () => {
    let seen = null;
    const up = await seamServer((body, req) => { seen = { body, url: req.url, headers: req.headers }; return { data: [{ url: 'https://recraft.example/vector.svg' }] }; });
    try {
        const a = createRecraftProvider({ key: 'recraft', base_url: `${up.url}/v1` }, { apiKey: 'recraft-token', fetchImpl: fetch });
        const out = await a.image({ model: 'recraftv4_1_vector', prompt: 'a fox logo', n: 1, size: '1024x1024', timeoutMs: 3000 });
        assert.strictEqual(seen.url, '/v1/images/generations', 'recraft\'s own endpoint');
        assert.strictEqual(seen.headers.authorization, 'Bearer recraft-token');
        assert.deepStrictEqual(seen.body, { prompt: 'a fox logo', model: 'recraftv4_1_vector', size: '1:1' });
        assert.strictEqual(out.images[0].url, 'https://recraft.example/vector.svg');
        assert.strictEqual(out.images[0].format, 'svg', 'the vector model answers in SVG');
        assert.strictEqual(out.usage.output, 1);
    } finally { await up.close(); }
});

t.test('ideogram: the picture is posted as a form, and the vector model is polled', async () => {
    const up = await rawServer(({ req }) => {
        const url = req.url;
        if (url.startsWith('/v2/svg/generate/ideogram-vector-1')) return { body: { generation_id: 'gen-1' } };
        if (url.startsWith('/v2/generations/')) return { body: { generation_id: 'gen-1', status: 'completed', response_type: 'url', data: [{ url: 'https://ideogram.example/vector.svg' }] } };
        return { body: { request_id: 'r-1', created: '2026-11-13T00:00:00Z', data: [{ url: 'https://ideogram.example/picture.png', resolution: '1024x1024' }] } };
    });
    try {
        const a = createIdeogramProvider({ key: 'ideogram', base_url: up.url }, { apiKey: 'ideo-key', fetchImpl: fetch });
        const raster = await a.image({ model: 'ideogram-4-5', prompt: 'a fox', n: 1, size: '1024x1024', timeoutMs: 3000 });
        const form = up.seen[0];
        assert.strictEqual(form.method, 'POST');
        assert.strictEqual(form.url, '/v2/image/generate/ideogram-4-5', 'ideogram\'s own endpoint for the model');
        assert.strictEqual(form.headers['api-key'], 'ideo-key', 'the key travels as ideogram wants it');
        assert.match(form.headers['content-type'], /^multipart\/form-data/, 'the body is the form ideogram asks for');
        assert.match(form.raw.toString(), /name="prompt"\r\n\r\na fox/);
        assert.match(form.raw.toString(), /name="aspect_ratio"\r\n\r\n1:1/);
        assert.strictEqual(raster.images[0].url, 'https://ideogram.example/picture.png');
        assert.strictEqual(raster.usage.output, 1);

        const vector = await a.image({ model: 'ideogram-vector-1', prompt: 'a fox logo', timeoutMs: 3000 });
        assert.strictEqual(up.seen[1].url, '/v2/svg/generate/ideogram-vector-1', 'the SVG endpoint');
        assert.strictEqual(up.seen[2].url, '/v2/generations/gen-1', 'the generation is polled');
        assert.strictEqual(vector.images[0].url, 'https://ideogram.example/vector.svg');
        assert.strictEqual(vector.images[0].format, 'svg');
    } finally { await up.close(); }
});

t.test('elevenlabs: the voice comes from the account\'s own list, then the line is spoken', async () => {
    const up = await rawServer(({ req }) => {
        if (req.url.startsWith('/v2/voices')) return { body: { voices: [{ voice_id: 'v-123', name: 'Rachel', category: 'premade' }] } };
        return { contentType: 'audio/mpeg', raw: Buffer.from('ID3-audio-bytes') };
    });
    try {
        const a = createSpeechProvider({ key: 'elevenlabs', base_url: up.url }, { apiKey: 'xi-key', fetchImpl: fetch });
        const out = await a.speak({ voice: 'eleven_voice', text: 'OpenVibe is ready.', format: 'mp3', timeoutMs: 3000 });
        const voices = up.seen.find((s) => s.url.startsWith('/v2/voices'));
        const spoke = up.seen.find((s) => s.url.startsWith('/v1/text-to-speech'));
        assert.ok(voices, 'the account\'s own voice list is read');
        assert.strictEqual(voices.headers['xi-api-key'], 'xi-key');
        assert.match(spoke.url, /^\/v1\/text-to-speech\/v-123\?output_format=mp3_44100_128$/, 'the account\'s voice id is the one spoken');
        assert.deepStrictEqual(JSON.parse(spoke.raw.toString()), { text: 'OpenVibe is ready.', model_id: 'eleven_multilingual_v2' });
        assert.strictEqual(out.mimeType, 'audio/mpeg');
        assert.strictEqual(out.usage.characters, 'OpenVibe is ready.'.length, 'the characters are metered, like the other voices');
        assert.strictEqual(ELEVEN_PRICE['multilingual-v2'], 80, '$0.08 per 1,000 characters');
    } finally { await up.close(); }
});

t.test('deepgram: the recording is posted as it is, and the words come back with their times', async () => {
    const wav = Buffer.alloc(44 + 320);
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + 320, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(320, 40);
    const file = path.join(tmpDir(), 'ready.wav');
    fs.writeFileSync(file, wav);
    const up = await rawServer(() => ({ body: { results: { channels: [{ alternatives: [{ transcript: 'OpenVibe is ready.', words: [{ start: 0, end: 1.2, word: 'OpenVibe', punctuated_word: 'OpenVibe,' }] }] }] } } }));
    try {
        const a = createDeepgramProvider({ key: 'deepgram', base_url: up.url }, { apiKey: 'dg-key', fetchImpl: fetch });
        const out = await a.transcribe({ model: 'nova-3', filePath: file, language: 'en', timeoutMs: 3000 });
        const call = up.seen[0];
        assert.match(call.url, /^\/v1\/listen\?/, 'deepgram\'s own endpoint');
        assert.match(call.url, /model=nova-3/, 'the model is named in the address');
        assert.strictEqual(call.headers.authorization, 'Token dg-key', 'the key travels as deepgram wants it');
        assert.strictEqual(call.headers['content-type'], 'audio/wav');
        assert.strictEqual(call.raw.length, wav.length, 'the recording travels as it is');
        assert.strictEqual(out.text, 'OpenVibe is ready.');
        assert.deepStrictEqual(out.segments, [{ start: 0, end: 1.2, text: 'OpenVibe,' }]);
    } finally { await up.close(); }
});

t.test('voyage: the texts are embedded as documents, and the reranker ranks the documents', async () => {
    const seen = [];
    const up = await seamServer((body, req) => {
        seen.push({ url: req.url, body, headers: req.headers });
        if (req.url.endsWith('/v1/embeddings')) return { data: [{ embedding: [0.1, 0.2], index: 0 }], usage: { total_tokens: 7 } };
        return { data: [{ index: 1, relevance_score: 0.87 }], usage: { total_tokens: 21 } };
    });
    try {
        const a = createVoyageProvider({ key: 'voyage', base_url: up.url }, { apiKey: 'voyage-key', fetchImpl: fetch });
        const emb = await a.embed({ model: 'voyage-4-lite', input: ['OpenVibe answers by meaning.'], timeoutMs: 3000 });
        assert.strictEqual(seen[0].url, '/v1/embeddings', 'voyage\'s own endpoint');
        assert.strictEqual(seen[0].headers.authorization, 'Bearer voyage-key');
        assert.deepStrictEqual(seen[0].body, { model: 'voyage-4-lite', input: ['OpenVibe answers by meaning.'], input_type: 'document' });
        assert.deepStrictEqual(emb.vectors, [[0.1, 0.2]]);
        assert.strictEqual(emb.usage.input, 7, 'the tokens are metered');
        const ranked = await a.rerank({ model: 'rerank-3', query: 'what is openvibe', documents: ['a goose', 'a lighthouse'], topK: 1, timeoutMs: 3000 });
        assert.strictEqual(seen[1].url, '/v1/rerank');
        assert.deepStrictEqual(seen[1].body, { model: 'rerank-3', query: 'what is openvibe', documents: ['a goose', 'a lighthouse'], top_k: 1 });
        assert.deepStrictEqual(ranked.results, [{ index: 1, relevance_score: 0.87 }]);
    } finally { await up.close(); }
});

t.test('the setup page runs a new provider end to end: a key, a model, a route and one answer', async () => {
    const up = await seamServer(() => ({ images: [{ url: 'https://fal.media/picture.jpg' }] }));
    const h = await boot({ env: { AI_STUB_FALLBACK: 'false' } });
    try {
        const owner = token('network', ['ai.provider.manage']);
        // The provider's own record, pointed at the seam: the catalogue never overwrites an owner edit.
        await h.registry.upsertProvider({ key: 'fal', base_url: up.url }, { actor: 'test', origin: 'admin' });
        const saved = await request(h.base, 'PUT', '/api/v1/setup/providers/fal/key', { tok: owner, body: { key: 'fal-secret-key' } });
        assert.strictEqual(saved.status, 200, saved.text);
        assert.ok(!saved.text.includes('fal-secret-key'), 'the key is never echoed');
        const test = await request(h.base, 'POST', '/api/v1/setup/test/image', { tok: owner, body: { provider: 'fal', model: 'flux-schnell' } });
        assert.strictEqual(test.status, 200, test.text);
        assert.strictEqual(test.body.provider, 'fal');
        assert.strictEqual(test.body.answer.count, 1);
        assert.strictEqual(test.body.answer.image, 'https://fal.media/picture.jpg');
        assert.ok(Math.abs(test.body.cost_usd - 0.003) < 1e-9, `the picture costs its own price: ${test.body.cost_usd}`);
        const model = await h.registry.getModel('fal', 'flux-schnell');
        assert.ok(model, 'the model the test used is registered');
        assert.strictEqual(model.type, 'image');
        assert.strictEqual(model.metadata.price_per_image_usd, 0.003, 'the model carries the price the catalogue published');
        const page = await request(h.base, 'GET', '/api/v1/setup', { tok: owner });
        const images = page.body.steps.find((s) => s.id === 'image');
        const falOffer = images.options.find((o) => o.provider === 'fal');
        assert.ok(falOffer, 'the page shows the fal offer');
        assert.strictEqual(falOffer.price_text, '$0.003 per picture');
        assert.strictEqual(falOffer.checked, '2026-11-13');
    } finally { await h.stop(); await up.close(); }
});

t.test('the setup page runs a new transcription provider end to end', async () => {
    const up = await seamServer(() => ({ results: { channels: [{ alternatives: [{ transcript: 'OpenVibe is ready.', words: [] }] }] } }));
    const h = await boot({ env: { AI_STUB_FALLBACK: 'false' } });
    try {
        const owner = token('network', ['ai.provider.manage']);
        await h.registry.upsertProvider({ key: 'deepgram', base_url: up.url }, { actor: 'test', origin: 'admin' });
        const saved = await request(h.base, 'PUT', '/api/v1/setup/providers/deepgram/key', { tok: owner, body: { key: 'deepgram-secret-key' } });
        assert.strictEqual(saved.status, 200, saved.text);
        const test = await request(h.base, 'POST', '/api/v1/setup/test/stt', { tok: owner, body: { provider: 'deepgram', model: 'nova-3' } });
        assert.strictEqual(test.status, 200, test.text);
        assert.strictEqual(test.body.provider, 'deepgram');
        assert.strictEqual(test.body.answer.text, 'OpenVibe is ready.');
        const model = await h.registry.getModel('deepgram', 'nova-3');
        assert.strictEqual(model.type, 'stt');
        assert.strictEqual(model.metadata.price_per_minute_usd, 0.0077, 'the model carries the price the catalogue published');
    } finally { await h.stop(); await up.close(); }
});

t.run();
