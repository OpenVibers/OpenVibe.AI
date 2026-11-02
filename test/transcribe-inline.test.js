'use strict';
// chat.vibe.listen (Chat's Dock voice): inline audio is written to a private temp file for the existing
// transcribe step, deleted in the same call, and the run record keeps only the data URL's digest.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('transcribe-inline');
const tok = token('chat', ALL);
const audioFiles = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('openvibe-ai-audio-')).sort();
let h;

t.test('boot', async () => { h = await boot(); });

t.test('a short recording is transcribed, and neither the run record nor a file keeps it', async () => {
    const marker = 'OV-INLINE-AUDIO-MARKER';
    const bytes = Buffer.concat([Buffer.from('OggS'), Buffer.from(marker)]);
    const dataUrl = `data:audio/ogg;base64,${bytes.toString('base64')}`;
    const before = audioFiles();
    const r = await request(h.base, 'POST', '/api/v1/runs?wait=10000', { tok, body: { workflow: 'chat.vibe.listen', input: { audio: { data_url: dataUrl, mime: 'audio/ogg' }, language: 'en' } } });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.run.status, 'succeeded', JSON.stringify(r.body.run.error));
    assert.ok(r.body.run.output.text, 'the transcribe step answered');
    const row = await h.db.prepare('SELECT input FROM runs WHERE id = ?').get(r.body.run.id);
    assert.ok(!row.input.includes(marker), 'the audio bytes are not on the run record');
    assert.ok(row.input.includes('not_retained'), 'the audio input is not retained at all, only its hash');
    assert.deepStrictEqual(audioFiles(), before, 'the temp file was deleted in the same call');
});

t.test('Chat\'s chat.* grant reaches chat.vibe.listen, and nothing outside it', async () => {
    const chatTok = token('chat', ALL, { ns: ['chat.*'] });
    const ok = await request(h.base, 'POST', '/api/v1/runs?wait=10000', { tok: chatTok, body: { workflow: 'chat.vibe.listen', input: { audio: { data_url: 'data:audio/ogg;base64,T2dnUw==', mime: 'audio/ogg' } } } });
    assert.strictEqual(ok.status, 201, ok.text);
    assert.strictEqual(ok.body.run.status, 'succeeded', JSON.stringify(ok.body.run.error));
    const no = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: chatTok, body: { workflow: 'live.media.transcribe', input: { media_url: 'https://openvibe.media/o/med_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3' } } });
    assert.strictEqual(no.status, 403, no.text);
    assert.strictEqual(no.body.code, 'capability.namespace_denied');
});

t.test('done', async () => { await h.close(); });

t.run();
