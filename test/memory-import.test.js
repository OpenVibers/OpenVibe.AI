'use strict';
/**
 * Memory M3: the guided cloud import. Synthetic exports only (test/fixtures/zip.js builds them in memory): the
 * preview redacts and stores no note, the draft is sealed, the commit keeps only the ticked cells, and a service
 * token can neither preview nor commit. No test reaches the network.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, request, suite, privateKey, ISSUER } = require('./helpers');
const { makeZip } = require('./fixtures/zip');

const t = suite('memory-import');
const KEY = 'b'.repeat(64);
const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';
const SECRET = `ghp_${'A'.repeat(36)}`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function userToken(subject, expiresIn = 3600) {
    const now = Math.floor(Date.now() / 1000);
    const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: ISSUER, sub: subject, subject_id: subject, aud: ['openvibe.network'], iat: now, exp: now + expiresIn, jti: `tok_${crypto.randomBytes(8).toString('hex')}` })}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

/** A raw-body request: an export zip goes up as application/zip, a paste as JSON through the normal helper. */
async function upload(base, path, tok, body, contentType = 'application/zip') {
    const res = await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': contentType }, body });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, text };
}

/** One multipart form, exactly what the Codes page forwards to this route. */
function multipartBody(fields, file) {
    const boundary = '----ai-memory-test';
    const parts = [];
    for (const [name, value] of Object.entries(fields || {})) {
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    }
    if (file) {
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/zip\r\n\r\n`);
        parts.push(file.data);
        parts.push('\r\n');
    }
    parts.push(`--${boundary}--\r\n`);
    return { boundary, body: Buffer.concat(parts.map((x) => Buffer.isBuffer(x) ? x : Buffer.from(x, 'utf8'))) };
}

const chatgptExport = () => makeZip({
    'conversations.json': JSON.stringify([{
        title: 'How I like to work', create_time: 1700000000, current_node: 'b',
        mapping: {
            a: { parent: null, message: { author: { role: 'user' }, content: { parts: [`Please remember that I prefer short answers and my deploy token is ${SECRET}.`] }, create_time: 1700000001 } },
            b: { parent: 'a', message: { author: { role: 'assistant' }, content: { parts: ['Noted.'] }, create_time: 1700000002 } },
        },
    }, {
        title: 'Lunch', create_time: 1700000100, current_node: 'x',
        mapping: { x: { parent: null, message: { author: { role: 'user' }, content: { parts: ['What should I eat?'] }, create_time: 1700000101 } } },
    }]),
    'user.json': JSON.stringify({ id: 'user-1' }),
});

const claudeExport = () => makeZip({
    'memories.json': JSON.stringify([
        { content: 'I work as a staff engineer at a small company. I prefer British spelling.', created_at: '2026-01-10T08:00:00Z' },
    ]),
    'conversations.json': JSON.stringify([{
        name: 'Deploy notes', created_at: '2026-01-11T09:00:00Z',
        chat_messages: [
            { sender: 'human', content: [{ type: 'text', text: 'Remember that I always deploy on Thursdays.' }], created_at: '2026-01-11T09:01:00Z' },
            { sender: 'assistant', content: [{ type: 'text', text: 'I will remember that.' }], created_at: '2026-01-11T09:02:00Z' },
        ],
    }]),
    'projects.json': JSON.stringify([{ name: 'Demo' }]),
});

const geminiExport = () => makeZip({
    'Takeout/My Activity/Gemini Apps/My Activity.json': JSON.stringify([
        { title: 'Said "Remember that I like my answers with sources."', time: '2026-03-05T10:30:00Z' },
        { title: 'What is the weather?', time: '2026-03-05T11:00:00Z' },
    ]),
});

t.test('the walkthroughs are person-only and carry the three providers and the prompt', async () => {
    const h = await boot({ env: { AI_MEMORY_KEY: KEY } });
    try {
        const r = await request(h.base, 'GET', '/api/v1/memory/import/providers', { tok: userToken(A) });
        assert.equal(r.status, 200);
        assert.deepStrictEqual(r.body.providers.map((p) => p.id), ['chatgpt', 'claude-ai', 'gemini-apps']);
        assert.ok(r.body.providers.every((p) => p.url && p.steps.length && p.time && p.arrives), 'each walkthrough is complete');
        assert.match(r.body.prompt, /remember about me/i);
        const service = await request(h.base, 'GET', '/api/v1/memory/import/providers', { tok: require('./helpers').token('codes', ['ai.memory.read']) });
        assert.equal(service.status, 403);
    } finally { await h.stop(); }
});

t.test('the multipart form Codes forwards is parsed here: a zip with its provider, and a pasted answer', async () => {
    const h = await boot({ env: { AI_MEMORY_KEY: KEY } });
    try {
        const who = userToken(A);
        const zip = multipartBody({ provider: 'chatgpt' }, { name: 'export.zip', data: chatgptExport() });
        const file = await upload(h.base, '/api/v1/memory/import/preview', who, zip.body, `multipart/form-data; boundary=${zip.boundary}`);
        assert.equal(file.status, 200);
        assert.equal(file.body.import.provider, 'chatgpt');
        assert.equal(file.body.import.items.length, 1);

        const paste = multipartBody({ provider: 'claude-ai', text: '- I prefer British spelling. [preference]' });
        const text = await upload(h.base, '/api/v1/memory/import/preview', who, paste.body, `multipart/form-data; boundary=${paste.boundary}`);
        assert.equal(text.status, 200);
        assert.equal(text.body.import.items.length, 1);
        assert.equal(text.body.import.items[0].source, 'claude-ai');
    } finally { await h.stop(); }
});

t.test('a ChatGPT zip previews redacted candidates, stores no note, and seals the draft', async () => {
    const h = await boot({ env: { AI_MEMORY_KEY: KEY } });
    try {
        const who = userToken(A);
        const before = await h.db.prepare('SELECT COUNT(*) AS n FROM memory_items WHERE owner = ?').get(`user:${A}`);
        assert.equal(Number(before.n), 0);
        const out = await upload(h.base, '/api/v1/memory/import/preview', who, chatgptExport());
        assert.equal(out.status, 200);
        const draft = out.body.import;
        assert.match(draft.id, /^mimp_/);
        assert.equal(draft.provider, 'chatgpt');
        assert.equal(draft.items.length, 1, 'only the sentence that looks like a memory');
        assert.ok(!draft.items[0].text.includes('ghp_'), 'the token is gone before the preview');
        assert.ok(draft.items[0].text.includes('[redacted]'));
        assert.equal(draft.items[0].source, 'chatgpt');
        assert.equal(draft.items[0].source_ref.heading, 'How I like to work');
        assert.equal(draft.summary.conversations, 2);
        assert.equal(draft.summary.secrets_removed, 1);
        const notes = await h.db.prepare('SELECT COUNT(*) AS n FROM memory_items WHERE owner = ?').get(`user:${A}`);
        assert.equal(Number(notes.n), 0, 'a preview is not an import');
        const row = await h.db.prepare('SELECT * FROM memory_imports WHERE owner = ?').get(`user:${A}`);
        assert.match(row.payload_enc, /^m1:/, 'the draft is sealed');
        assert.ok(!row.payload_enc.includes('short answers'), 'no plaintext draft');
    } finally { await h.stop(); }
});

t.test('the commit keeps only the ticked cells, and the left-out ones are not stored', async () => {
    const h = await boot({ env: { AI_MEMORY_KEY: KEY } });
    try {
        const who = userToken(A);
        const zip = makeZip({
            'conversations.json': JSON.stringify([{
                title: 'Two memories', create_time: 1700000000, current_node: 'b',
                mapping: {
                    a: { parent: null, message: { author: { role: 'user' }, content: { parts: ['Remember that I prefer tabs. Remember that I use vim every day.'] }, create_time: 1700000001 } },
                    b: { parent: 'a', message: { author: { role: 'assistant' }, content: { parts: ['ok'] } } },
                },
            }]),
        });
        const preview = await upload(h.base, '/api/v1/memory/import/preview', who, zip);
        assert.equal(preview.status, 200);
        const { id, items } = preview.body.import;
        assert.equal(items.length, 2);
        const commit = await request(h.base, 'POST', `/api/v1/memory/import/${id}/commit`, { tok: who, body: { keep: [items[0].key] } });
        assert.deepStrictEqual([commit.status, commit.body.kept, commit.body.left_out], [200, 1, 1]);
        const rows = await h.db.prepare('SELECT source, status FROM memory_items WHERE owner = ?').all(`user:${A}`);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].source, 'chatgpt');
        assert.equal(rows[0].status, 'active', 'the person chose it, so it is not a suggestion');
        const drafts = await h.db.prepare('SELECT COUNT(*) AS n FROM memory_imports WHERE owner = ?').get(`user:${A}`);
        assert.equal(Number(drafts.n), 0, 'the draft is gone');
    } finally { await h.stop(); }
});

t.test('Claude saved memories come first, and a Gemini Takeout activity file is found on its own', async () => {
    const h = await boot({ env: { AI_MEMORY_KEY: KEY } });
    try {
        const who = userToken(A);
        const claude = await upload(h.base, '/api/v1/memory/import/preview', who, claudeExport());
        assert.equal(claude.status, 200);
        assert.equal(claude.body.import.provider, 'claude-ai');
        assert.equal(claude.body.import.items.length, 2);
        assert.ok(claude.body.import.items.some((i) => i.confidence === 0.9 && /staff engineer/.test(i.text)), 'memories.json is read directly');
        assert.ok(claude.body.import.items.some((i) => /Thursdays/.test(i.text)), 'and the conversation marker too');

        const gemini = await upload(h.base, '/api/v1/memory/import/preview', who, geminiExport());
        assert.equal(gemini.status, 200);
        assert.equal(gemini.body.import.provider, 'gemini-apps');
        assert.equal(gemini.body.import.items.length, 1);
        assert.match(gemini.body.import.items[0].text, /answers with sources/);
        assert.equal(gemini.body.import.items[0].source, 'gemini-apps');
    } finally { await h.stop(); }
});

t.test('a pasted extraction answer is parsed by its bullets and labels', async () => {
    const h = await boot({ env: { AI_MEMORY_KEY: KEY } });
    try {
        const who = userToken(A);
        const out = await request(h.base, 'POST', '/api/v1/memory/import/preview', {
            tok: who,
            body: { provider: 'claude-ai', text: '- I prefer long walks. [preference]\n- Project rule: always run the tests before shipping. [project rule]\n- **Preference:** I prefer evening work.\n- Just some chatter' },
        });
        assert.equal(out.status, 200);
        assert.equal(out.body.import.items.length, 3);
        assert.deepStrictEqual(out.body.import.items.map((i) => i.kind).sort(), ['preference', 'preference', 'project_rule']);
        assert.ok(!out.body.import.items.some((i) => /chatter/.test(i.text)), 'unlabelled chatter is not a memory');
        const commit = await request(h.base, 'POST', `/api/v1/memory/import/${out.body.import.id}/commit`, { tok: who, body: { keep: out.body.import.items.map((i) => i.key) } });
        assert.equal(commit.body.kept, 3);
    } finally { await h.stop(); }
});

t.test('a service token cannot preview or commit, another person cannot open the draft, and expiry is a 410', async () => {
    let now = Date.now();
    const h = await boot({ env: { AI_MEMORY_KEY: KEY }, clock: { now: () => now } });
    try {
        const who = userToken(A, 5 * 3600);
        const service = require('./helpers').token('codes', ['ai.memory.write']);
        const denied = await upload(h.base, '/api/v1/memory/import/preview', service, chatgptExport());
        assert.equal(denied.status, 403);
        const preview = await upload(h.base, '/api/v1/memory/import/preview', who, chatgptExport());
        const id = preview.body.import.id;
        const other = await request(h.base, 'POST', `/api/v1/memory/import/${id}/commit`, { tok: userToken(B), body: { keep: ['k1'] } });
        assert.deepStrictEqual([other.status, other.body.code], [404, 'import.not_found']);
        now += 3 * 60 * 60 * 1000;
        const late = await request(h.base, 'POST', `/api/v1/memory/import/${id}/commit`, { tok: who, body: { keep: ['k1'] } });
        assert.deepStrictEqual([late.status, late.body.code], [410, 'import.expired']);
    } finally { await h.stop(); }
});

t.test('the maintenance loop sweeps a draft that expired while its person was away', async () => {
    let now = Date.now();
    const h = await boot({ env: { AI_MEMORY_KEY: KEY, AI_MEMORY_JOBS: 'true' }, clock: { now: () => now } });
    try {
        const preview = await upload(h.base, '/api/v1/memory/import/preview', userToken(A), chatgptExport());
        assert.equal(preview.status, 200);
        now += 3 * 60 * 60 * 1000;
        const run = await h.memoryJobs.runOnce();
        assert.equal(run.drafts, 1, 'the sweep counted the draft');
        const rows = await h.db.prepare('SELECT COUNT(*) AS n FROM memory_imports WHERE owner = ?').get(`user:${A}`);
        assert.equal(Number(rows.n), 0, 'the expired draft is gone');
    } finally { await h.stop(); }
});

t.test('a file that is not a zip is a 422, never a 500, and an unsupported zip says what is missing', async () => {
    const h = await boot({ env: { AI_MEMORY_KEY: KEY } });
    try {
        const who = userToken(A);
        const bad = await upload(h.base, '/api/v1/memory/import/preview', who, Buffer.from('not a zip at all'));
        assert.deepStrictEqual([bad.status, bad.body.code], [422, 'import.bad_zip']);
        const empty = await upload(h.base, '/api/v1/memory/import/preview', who, makeZip({ 'notes.txt': 'hello' }));
        assert.deepStrictEqual([empty.status, empty.body.code], [422, 'import.invalid']);
        const noMemory = await upload(h.base, '/api/v1/memory/import/preview', who, makeZip({ 'conversations.json': JSON.stringify([{ title: 'x', mapping: {} }]) }));
        assert.equal(noMemory.status, 200, 'a valid export with no candidate is a preview that says so');
        assert.equal(noMemory.body.import.items.length, 0);
        assert.equal(noMemory.body.import.id, null);
    } finally { await h.stop(); }
});

t.run();
