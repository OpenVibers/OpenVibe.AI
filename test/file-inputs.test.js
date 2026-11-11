'use strict';
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { attachFiles, readFile, pdfText, setScanner, MAX_FILES, MAX_FILE_BYTES } = require('../server/file-inputs');
const { suite } = require('./helpers');

const t = suite('file-inputs');
const ID = (n = 1) => `med_01ARZ3NDEKTSV4RRFFQ69G5F${String(n).padStart(2, '0').slice(-2)}`;

/** A PDF whose one content stream shows `text` (uncompressed, so the extractor is what is tested). */
function pdf(text) {
    const stream = `BT /F1 12 Tf 72 720 Td (${String(text).replace(/[()\\]/g, '\\$&')}) Tj ET`;
    return Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/Contents 4 0 R>>endobj\n4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream\nendobj\n%%EOF`, 'latin1');
}

function fetcherOf(files) {
    return {
        mediaRefUrl: ({ media_id }) => `https://openvibe.media/o/${media_id}`,
        fetchUrl: async (url) => {
            const id = String(url).split('/').pop();
            const f = files[id];
            if (!f) { const e = new Error('not found'); e.status = 404; throw e; }
            return { buffer: Buffer.from(f.body), contentType: f.type };
        },
    };
}

const csv = { body: 'name,score\nAda,10\nGrace,9\n', type: 'text/csv' };
const pdfFile = { body: pdf('Quarterly report: revenue up 12%'), type: 'application/pdf' };
const png = { body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), type: 'image/png' };
const zip = { body: Buffer.from([0x50, 0x4b, 3, 4, 5]), type: 'application/zip' };

function zipOf(name, text) {
    const data = Buffer.from(text);
    const packed = zlib.deflateRawSync(data);
    const label = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(label.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(label.length, 28);
    const directory = Buffer.concat([central, label]);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(local.length + label.length + packed.length, 16);
    return Buffer.concat([local, label, packed, directory, end]);
}

function tarOf(name, text) {
    const data = Buffer.from(text);
    const head = Buffer.alloc(512);
    head.write(name, 0, 100);
    head.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    head[156] = 48;
    return Buffer.concat([head, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length + 1024)]);
}

t.test('CSV, PDF, image and unknown types become model content by type; references never carry bytes', async () => {
    const fetcher = fetcherOf({ [ID(1)]: csv, [ID(2)]: pdfFile, [ID(3)]: png, [ID(4)]: zip });
    const out = await attachFiles({
        messages: [{ role: 'user', content: 'Read these' }],
        files: [
            { id: ID(1), name: 'scores.csv', media_type: 'text/csv', size: 28 },
            { id: ID(2), name: 'report.pdf', media_type: 'application/pdf', size: 300 },
            { id: ID(3), name: 'shot.png', media_type: 'image/png', size: 8 },
            { id: ID(4), name: 'bundle.zip', media_type: 'application/zip', size: 5 },
        ],
    }, fetcher);
    const parts = out.messages[0].content;
    assert.ok(Array.isArray(parts));
    const texts = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    assert.match(texts, /name,score/);
    assert.match(texts, /Quarterly report: revenue up 12%/);
    assert.match(texts, /bundle\.zip \(application\/zip\); the ZIP directory is missing/);
    assert.ok(parts.some((p) => p.type === 'image_url' && /^data:image\/png;base64,/.test(p.image_url.url)), 'the picture goes to a vision model');
    assert.equal(out.files.length, 4);
    assert.deepEqual(out.files.map((f) => f.read.method), ['text', 'pages', 'image', 'not_readable']);
    for (const f of out.files) {
        assert.equal(f.storage.provider, 'media');
        assert.equal('content' in f.read, false, 'extracted text is not kept in the reference');
        assert.equal('pages' in f.read, false, 'PDF pages are not kept in the reference');
    }
    assert.equal(out.hasImage, true);
});

t.test('ZIP and compressed TAR expose bounded text entries with paths and keep bytes out of references', async () => {
    const bundle = zipOf('src/app.js', 'export const answer = 42;');
    const archive = zlib.gzipSync(tarOf('notes/readme.md', 'A useful note.'));
    const fetcher = fetcherOf({
        [ID(5)]: { body: bundle, type: 'application/zip' },
        [ID(6)]: { body: archive, type: 'application/gzip' },
    });
    const out = await attachFiles({ messages: [{ role: 'user', content: 'Summarize the files' }], files: [
        { id: ID(5), name: 'code.zip', size: bundle.length },
        { id: ID(6), name: 'docs.tar.gz', size: archive.length },
    ] }, fetcher);
    const text = out.messages[0].content.map((part) => part.text).join('\n');
    assert.match(text, /src\/app\.js[\s\S]*answer = 42/);
    assert.match(text, /notes\/readme\.md[\s\S]*A useful note/);
    assert.deepEqual(out.files.map((file) => file.read.method), ['text', 'text']);
    assert.ok(!JSON.stringify(out.files).includes('useful note'));
});

t.test('unsafe archive paths and overlarge expanded entries are skipped', async () => {
    const unsafe = zipOf('../private.txt', 'do not show this');
    const large = zipOf('large.txt', 'A'.repeat(600000));
    const fetcher = fetcherOf({ [ID(7)]: { body: unsafe, type: 'application/zip' }, [ID(8)]: { body: large, type: 'application/zip' } });
    for (const [id, name, size] of [[ID(7), 'unsafe.zip', unsafe.length], [ID(8), 'large.zip', large.length]]) {
        const out = await attachFiles({ messages: [{ role: 'user', content: 'Read' }], files: [{ id, name, size }] }, fetcher);
        assert.equal(out.files[0].read.method, 'not_readable');
        assert.ok(!JSON.stringify(out.messages).includes('do not show this'));
        assert.ok(!JSON.stringify(out.messages).includes('AAAAAA'));
    }
});

t.test('audio is transcribed for a text model with local ASR, with an honest note if unavailable', async () => {
    const bytes = Buffer.from('audio fixture bytes');
    const fetcher = fetcherOf({ [ID(9)]: { body: bytes, type: 'audio/ogg' } });
    const input = { messages: [{ role: 'user', content: 'What did I say?' }], files: [{ id: ID(9), name: 'voice.ogg', size: bytes.length }] };
    let called = 0;
    const heard = await attachFiles(input, fetcher, { transcribe: async ({ bytes: got, media_type: type }) => {
        called++;
        assert.equal(type, 'audio/ogg');
        assert.deepEqual(got, bytes);
        return { text: 'A spoken answer.' };
    } });
    assert.equal(called, 1);
    assert.match(heard.messages[0].content[1].text, /Attached audio transcript:[\s\S]*A spoken answer/);
    assert.equal(heard.files[0].read.method, 'text');
    assert.ok(!JSON.stringify(heard.files).includes('spoken answer'));
    const unavailable = await attachFiles(input, fetcher);
    assert.equal(unavailable.files[0].read.method, 'not_readable');
    assert.match(unavailable.messages[0].content[1].text, /local speech recognition is unavailable/);
});

t.test('a text-only model gets an honest note instead of a dropped picture', async () => {
    const fetcher = fetcherOf({ [ID(3)]: png });
    const out = await attachFiles({ messages: [{ role: 'user', content: 'What is this?' }], files: [{ id: ID(3), name: 'shot.png', size: 8 }] }, fetcher, { vision: false });
    const texts = out.messages[0].content.filter((p) => p.type === 'text').map((p) => p.text).join('');
    assert.match(texts, /cannot see images/);
    assert.ok(!out.messages[0].content.some((p) => p.type === 'image_url'));
    assert.equal(out.hasImage, false);
});

t.test('the Anthropic shape gets its own image source and text parts', async () => {
    const fetcher = fetcherOf({ [ID(1)]: csv, [ID(3)]: png });
    const out = await attachFiles({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Look' }] }],
        files: [{ id: ID(1), name: 'scores.csv', size: 28 }, { id: ID(3), name: 'shot.png', size: 8 }],
    }, fetcher, { format: 'anthropic' });
    const parts = out.messages[0].content;
    assert.equal(parts[0].type, 'text');
    assert.ok(parts.some((p) => p.type === 'image' && p.source.type === 'base64' && p.source.media_type === 'image/png'));
    assert.ok(!parts.some((p) => p.type === 'image_url'));
});

t.test('a caller-supplied read is used without fetching Media', async () => {
    const fetcher = fetcherOf({});
    const out = await attachFiles({
        messages: [{ role: 'user', content: 'Summarize' }],
        files: [{ id: ID(1), name: 'notes.txt', size: 11, read: { method: 'text', content: 'hello world' } }],
    }, fetcher);
    assert.match(out.messages[0].content[1].text, /hello world/);
    assert.equal(out.files[0].read.method, 'text');
});

t.test('the PDF extractor reads Tj/TJ text and is honest about a PDF with no text', async () => {
    assert.deepEqual(pdfText(pdf('Hello PDF')).pages, ['Hello PDF']);
    assert.equal(pdfText(Buffer.from('%PDF-1.4\n1 0 obj<</Encrypt 2 0 R>>>>\n%%EOF')).reason.includes('encrypted'), true);
});

t.test('per-turn count and size caps refuse before any fetch', async () => {
    const fetcher = fetcherOf({});
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ id: ID(i + 1), name: `f${i}.txt`, size: 1 }));
    await assert.rejects(() => attachFiles({ messages: [{ role: 'user', content: 'x' }], files: many }, fetcher), /at most 10 files/);
    await assert.rejects(() => attachFiles({
        messages: [{ role: 'user', content: 'x' }],
        files: [{ id: ID(1), name: 'big.bin', size: MAX_FILE_BYTES + 1 }],
    }, fetcher), /up to 10 MiB/);
});

t.test('the virus scan is a named extension point, not a pretend check', async () => {
    const fetcher = fetcherOf({ [ID(1)]: csv });
    let seen = null;
    setScanner(async (info) => { seen = info; throw new Error('infected'); });
    try {
        await assert.rejects(() => attachFiles({ messages: [{ role: 'user', content: 'x' }], files: [{ id: ID(1), name: 'scores.csv', size: 28 }] }, fetcher), /infected/);
        assert.equal(seen.name, 'scores.csv');
        assert.equal(seen.media_id, ID(1));
    } finally { setScanner(null); }
    const out = await attachFiles({ messages: [{ role: 'user', content: 'x' }], files: [{ id: ID(1), name: 'scores.csv', size: 28 }] }, fetcher);
    assert.equal(out.files[0].read.method, 'text');
});

t.test('a file that Media does not serve is a clear 422, not an empty turn', async () => {
    await assert.rejects(() => readFile({ id: ID(9), name: 'gone.txt', size: 1 }, fetcherOf({})), (err) => err.status === 422 && /not a readable Media object/.test(err.detail));
});

t.run();
