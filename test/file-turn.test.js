'use strict';
// A turn carries files by Media reference: the provider gets their text (or image), the run does not.
const assert = require('node:assert/strict');
const nodeHttp = require('node:http');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');

const t = suite('file-turn');
const ID = 'med_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ZIP_ID = 'med_01ARZ3NDEKTSV4RRFFQ69G5FAW';
let h; let seam; let media; let service;

function codeZip() {
    const name = Buffer.from('src/answer.js');
    const data = Buffer.from('export const answer = 42;');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const directory = Buffer.concat([central, name]);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(local.length + name.length + data.length, 16);
    return Buffer.concat([local, name, data, directory, end]);
}

t.test('a Media server and a counting OpenAI-shaped provider', async () => {
    media = nodeHttp.createServer((req, res) => {
        if (req.url === `/o/${ID}`) { res.writeHead(200, { 'Content-Type': 'text/csv' }); return res.end('name,score\nAda,10\n'); }
        if (req.url === `/o/${ZIP_ID}`) { res.writeHead(200, { 'Content-Type': 'application/zip' }); return res.end(codeZip()); }
        res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"Not found"}');
    });
    await new Promise((r) => media.listen(0, '127.0.0.1', r));
    const mediaUrl = `http://127.0.0.1:${media.address().port}`;
    seam = await seamServer(() => ({ choices: [{ index: 0, message: { role: 'assistant', content: 'It has two rows.' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', OV_MEDIA_URL: mediaUrl, OV_MEDIA_INTERNAL_URL: mediaUrl } });
    service = token('chat', ALL);
    let r = await request(h.base, 'POST', '/api/v1/providers', { tok: service, body: { key: 'seam', kind: 'openai', base_url: `${seam.url}/v1`, auth_mode: 'none', capabilities: ['chat', 'complete'], default_model: 'm1' } });
    assert.equal(r.status, 201, r.text);
    r = await request(h.base, 'POST', '/api/v1/models', { tok: service, body: { provider_key: 'seam', model_key: 'm1', cost: { in_per_mtok: 1, out_per_mtok: 1 } } });
    assert.equal(r.status, 201, r.text);
    r = await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: service, body: { primary: { provider: 'seam', model: 'm1' }, fallbacks: [] } });
    assert.equal(r.status, 201, r.text);
});

t.test('POST /v1/chat/completions reads a ZIP code file into the turn', async () => {
    const r = await request(h.base, 'POST', '/v1/chat/completions', {
        tok: service,
        body: { model: 'openvibe', messages: [{ role: 'user', content: 'What does this code return?' }], files: [{ id: ZIP_ID, name: 'code.zip', size: codeZip().length }] },
    });
    assert.equal(r.status, 200, r.text);
    assert.match(JSON.stringify(seam.last.messages), /src\/answer\.js[\s\S]*answer = 42/);
    const stored = await h.db.prepare('SELECT input FROM runs ORDER BY created_at DESC LIMIT 1').get();
    assert.ok(!JSON.stringify(stored.input).includes('export const answer'), 'archive content is never kept in the run');
});

t.test('POST /v1/chat/completions reads the file into the provider request, not the run', async () => {
    const before = seam.calls;
    const r = await request(h.base, 'POST', '/v1/chat/completions', {
        tok: service,
        body: {
            model: 'openvibe', messages: [{ role: 'user', content: 'Count the rows' }],
            files: [{ id: ID, name: 'scores.csv', media_type: 'text/csv', size: 20, storage: { provider: 'media', key: ID }, access: { readers: ['usr_01ARZ3NDEKTSV4RRFFQ69G5FAV'] } }],
        },
    });
    assert.equal(r.status, 200, r.text);
    const sent = JSON.stringify(seam.last.messages);
    assert.match(sent, /Attached file: scores\.csv/);
    assert.match(sent, /name,score/);
    assert.equal(seam.calls, before + 1);
    const stored = await h.db.prepare('SELECT input FROM runs ORDER BY created_at DESC LIMIT 1').get();
    const raw = typeof stored.input === 'string' ? stored.input : JSON.stringify(stored.input);
    assert.ok(!raw.includes('Ada,10'), 'the file bytes are not in the run input');
});

t.test('an unreadable Media reference is refused before the provider is called', async () => {
    const before = seam.calls;
    const r = await request(h.base, 'POST', '/v1/chat/completions', {
        tok: service,
        body: { model: 'openvibe', messages: [{ role: 'user', content: 'x' }], files: [{ id: 'med_01ARZ3NDEKTSV4RRFFQ69G5FZZ', name: 'gone.txt', size: 1 }] },
    });
    assert.equal(r.status, 503, r.text);   // the run failed at the file; the provider was never called
    assert.equal(r.body.error.code, 'files.unreadable');
    assert.equal(seam.calls, before);
});

t.test('close', async () => {
    await h.stop();
    await seam.close();
    await new Promise((r) => media.close(r));
});

t.run();
