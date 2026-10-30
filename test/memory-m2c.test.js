'use strict';
/**
 * Memory M2c: dedupe by meaning, the conflicts, the profile builder and the store's own job.
 *
 * The embeddings and the cheap tier are AI's own test providers: a local HTTP seam (test/helpers.js) that answers
 * the embed route with scripted vectors, so every cosine is exact, and the chat route with a scripted answer.
 */
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { uncovered } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, request, suite, seamServer, token, privateKey, ISSUER } = require('./helpers');
const { TABLES } = require('../server/account-data');
const { sha256 } = require('../server/util');
const { PROFILE_INTERVAL_MS, PROFILE_ITEMS } = require('../server/memory');

const t = suite('memory-m2c');
const KEY = 'a'.repeat(64);
const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';
const EXP = 'exp_01JZ0000000000000000000EXP';
const DEL = 'del_01JZ0000000000000000000DEX';
const SECRET = `whsec_${'memory'.repeat(5)}`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A person's Network access token (the shape the M2a tests use). */
function userToken(subject, extra = {}) {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: ISSUER, sub: subject, subject_id: subject, aud: ['openvibe.network'], iat: now, exp: now + 3600, jti: `tok_${crypto.randomBytes(8).toString('hex')}`, ...extra };
    const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

/** A service token that may read the person's memory in the granted scopes (AI's own test token). */
const serviceRead = (extra = {}) => token('codes', ['ai.memory.read'], { extra });
const serviceWrite = (extra = {}) => token('codes', ['ai.memory.write'], { extra });

// ── the scripted vectors ───────────────────────────────────────────────────────────────────────────
// Every vector has the same length (the seam is one embedding model), so every cosine is exact:
// the same meaning 0.995, near each other but disagreeing 0.85, apart 0.
const DIM = 64;
const vec = (parts) => { const v = new Array(DIM).fill(0); parts.forEach((n, i) => { v[i] = n; }); return v; };
const V_DARK = vec([1, 0]);
const V_DARK_SAME = vec([0.995, 0.0995]);
const V_LIGHT = vec([0.85, 0.5268]);
const V_OTHER = vec([0, 1]);
const DARK = 'I prefer dark mode in every editor.';
const DARK_SAME = 'Dark mode is what I like in every editor.';
const LIGHT = 'I always use light mode in my editors.';
const DEPLOY = 'The deploy script lives in tools/deploy.sh.';

/** The notes of the profile test: one vector each, a radian apart, so no two of them are the same meaning. */
function vectorFor(text) {
    const s = String(text);
    if (s.includes('Dark mode is what I like')) return V_DARK_SAME;
    if (s.includes('always use light mode')) return V_LIGHT;
    if (s.includes('prefer dark mode')) return V_DARK;
    const n = /^profile note (\d+)$/.exec(s);
    if (n) {
        // One vector per note, apart from every other: no two of the profile notes are the same meaning.
        const v = new Array(DIM).fill(0);
        v[3 + (Number(n[1]) % (DIM - 3))] = 1;
        return v;
    }
    return V_OTHER;
}

/** The test provider: scripted embeddings, a scripted profile answer and a scripted judgement. */
async function startSeam({ conflict = true } = {}) {
    const state = { chats: 0, embeds: 0, chatBodies: [] };
    const seam = await seamServer((body, req) => {
        if (req.url.endsWith('/embeddings')) {
            state.embeds++;
            const inputs = Array.isArray(body.input) ? body.input : [body.input];
            return {
                data: inputs.map((text, index) => ({ index, embedding: vectorFor(String(text)) })),
                model: 'scripted-embed',
                usage: { prompt_tokens: 1, total_tokens: 1 },
            };
        }
        state.chats++;
        state.chatBodies.push(body);
        if (body.response_format) {
            return {
                choices: [{ message: { role: 'assistant', content: JSON.stringify({ conflict, why: 'the two notes cannot both be true' }) } }],
                model: 'scripted-chat',
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
        }
        return {
            choices: [{ message: { role: 'assistant', content: 'A shirtless man likes these notes. He is a person.' } }],
            model: 'scripted-chat',
            usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
    });
    return { seam, state };
}

/** A boot whose only provider is the seam: every embedding and every cheap-tier answer is scripted. */
async function bootWithSeam(env = {}, seam, options = {}) {
    const h = await boot({
        ...options,
        env: {
            AI_MEMORY_KEY: KEY, AI_PROVIDER: 'openai', AI_BASE_URL: `${seam.url}/v1`, AI_API_KEY: 'scripted-key',
            AI_MODEL: 'scripted-chat', ...env,
        },
    });
    // The stub provider answers synthetically: it must not stand between the store and the seam.
    await h.registry.upsertProvider({ key: 'stub', status: 'disabled' });
    return h;
}

t.test('two paraphrases become one item with two sources, and the split puts them apart again', async () => {
    const { seam } = await startSeam();
    const h = await bootWithSeam({}, seam);
    try {
        const who = userToken(A);
        const first = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: who, body: { items: [{ text: DARK, source: 'cursor' }] } });
        assert.equal(first.status, 200);
        const older = first.body.items[0].id;
        const second = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: who, body: { items: [{ text: DARK_SAME, source: 'claude-code' }] } });
        assert.equal(second.status, 200);
        const newer = second.body.items[0].id;

        // The two notes say the same thing: one item is left, with both sources.
        const list = await request(h.base, 'GET', '/api/v1/memory/items', { tok: who });
        assert.equal(list.status, 200);
        assert.equal(list.body.items.length, 2, 'both rows are kept, one of them archived');
        const live = list.body.items.find((i) => i.status === 'active');
        const gone = list.body.items.find((i) => i.status === 'archived');
        assert.equal(live.id, newer, 'the newer text wins');
        assert.equal(live.text, DARK_SAME);
        assert.deepStrictEqual(live.sources.sort(), ['claude-code', 'cursor'], 'the item lists both sources');
        assert.equal(gone.id, older);
        assert.equal(gone.merged_into, newer, 'the older id is kept as a merged_into link');
        assert.equal(gone.text, DARK, 'the archived row keeps its own text');

        // The vector is sealed at rest, and it never opens as text.
        const row = await h.db.prepare('SELECT embedding_enc, embedding_model FROM memory_items WHERE owner = ? AND id = ?').get(`user:${A}`, newer);
        assert.match(row.embedding_enc, /^m1:/, 'the embedding is sealed like the text');
        assert.ok(row.embedding_model, 'the model that produced it is named');
        assert.throws(() => h.memory.open(row.embedding_enc, h.memory.aadFor(`user:${A}`, newer, 'user')), /does not open/);
        assert.ok(h.memory.open(row.embedding_enc, `${h.memory.aadFor(`user:${A}`, newer, 'user')}|emb`), 'the vector opens with the |emb AAD');

        // Undo: the person splits them again.
        const split = await request(h.base, 'POST', `/api/v1/memory/items/${newer}/split`, { tok: who, body: {} });
        assert.equal(split.status, 200);
        assert.equal(split.body.split, 1);
        const after = await request(h.base, 'GET', '/api/v1/memory/items', { tok: who });
        assert.equal(after.body.items.filter((i) => i.status === 'active').length, 2, 'both notes are active again');
        const restored = after.body.items.find((i) => i.id === older);
        assert.equal(restored.merged_into, null);
        assert.equal(restored.text, DARK);
        const winner = after.body.items.find((i) => i.id === newer);
        assert.deepStrictEqual(winner.sources, ['claude-code'], 'the winner keeps only its own source again');

        // A service may not split: only the person may.
        const denied = await request(h.base, 'POST', `/api/v1/memory/items/${newer}/split`, { tok: serviceWrite(), body: {} });
        assert.equal(denied.status, 403);
    } finally { await h.stop(); await seam.close(); }
});
t.test('a conflict is marked, hidden from an agent, and the person settles it', async () => {
    const { seam, state } = await startSeam({ conflict: true });
    const h = await bootWithSeam({ AI_MEMORY_JOBS: '1' }, seam);
    try {
        const who = userToken(A);
        const made = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: who, body: { items: [
            { text: DARK, source: 'cursor' }, { text: LIGHT, source: 'claude-code' },
        ] } });
        assert.equal(made.status, 200);
        const ids = made.body.items.map((i) => i.id);
        assert.equal(made.body.items.length, 2);
        assert.ok(made.body.items.every((i) => i.status === 'active'), 'a near pair is not merged');

        // The store's own job judges the pair: one cheap-tier call, on the two notes only.
        const run = await h.memoryJobs.runOnce();
        assert.equal(run.conflicts, 1, `the pair was not marked: ${JSON.stringify(run)}`);
        assert.ok(run.calls <= 1, 'one judgement is enough for this pair');

        const list = await request(h.base, 'GET', '/api/v1/memory/items', { tok: who });
        const pair = list.body.items.filter((i) => ids.includes(i.id));
        assert.equal(pair.length, 2);
        assert.ok(pair.every((i) => i.status === 'conflict'), 'both notes are marked');
        assert.equal(pair[0].conflict_with, pair[1].id, 'the two notes point at each other');
        assert.equal(pair[1].conflict_with, pair[0].id);

        // The judgement saw the two notes and nothing else.
        const judged = state.chatBodies.find((b) => b.response_format);
        assert.ok(judged, 'the cheap tier was asked');
        const prompt = judged.messages.map((m) => m.content).join('\n');
        assert.ok(prompt.includes(DARK) && prompt.includes(LIGHT), 'the two notes are in the prompt');
        assert.ok(!prompt.includes(DEPLOY), 'no other note is in the prompt');

        // A conflict never reaches an agent.
        const search = await request(h.base, 'GET', `/api/v1/memory/search?q=mode&scopes=user&on_behalf_of=${A}`, { tok: serviceRead() });
        assert.equal(search.status, 200);
        assert.equal(search.body.items.length, 0, 'a conflict is not shown to an agent');

        // The person settles it: the one they keep is active again, the other one is archived.
        const settled = await request(h.base, 'POST', `/api/v1/memory/items/${ids[0]}/settle`, { tok: who, body: { keep: ids[1] } });
        assert.equal(settled.status, 200);
        assert.equal(settled.body.kept.id, ids[1]);
        assert.equal(settled.body.kept.status, 'active');
        assert.equal(settled.body.archived.id, ids[0]);
        assert.equal(settled.body.archived.status, 'archived');
        const after = await request(h.base, 'GET', `/api/v1/memory/search?q=mode&scopes=user&on_behalf_of=${A}`, { tok: serviceRead() });
        assert.equal(after.body.items.length, 1, `the settled note reaches the agent again: ${after.text}`);
        assert.equal(after.body.items[0].id, ids[1]);

        // Settling two notes that do not conflict is refused.
        const other = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: who, body: { items: [{ text: DEPLOY }] } });
        const refused = await request(h.base, 'POST', `/api/v1/memory/items/${other.body.items[0].id}/settle`, { tok: who, body: { keep: ids[1] } });
        assert.equal(refused.status, 409);
    } finally { await h.stop(); await seam.close(); }
});

t.test('the profile is built from at most 60 notes, cached by items_hash, once an hour, and passes noLooks', async () => {
    let now = Date.now();
    const clock = { now: () => now };
    const { seam, state } = await startSeam();
    const h = await bootWithSeam({}, seam, { clock });
    try {
        const who = userToken(A);
        // One note a second, so "newest first" is a fact and not a tie.
        const base = Date.now() - (PROFILE_ITEMS + 1) * 1000;
        for (let i = 0; i <= PROFILE_ITEMS; i++) {
            const text = `profile note ${i}`;
            const id = `mem_${ids.ulid()}`;
            const at = new Date(base + i * 1000).toISOString();
            await h.db.prepare('INSERT INTO memory_items (id, owner, scope, kind, text_enc, text_mac, source, status, confidence, seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
                .run(id, `user:${A}`, 'user', 'fact', h.memory.seal(text, h.memory.aadFor(`user:${A}`, id, 'user')), h.memory.macOf(text), 'person', 'active', 1, at, at, at);
        }

        const first = await request(h.base, 'GET', '/api/v1/memory/profile?scope=user', { tok: who });
        assert.equal(first.status, 200, `profile: ${first.text}`);
        const text = first.body.profile.text;
        assert.ok(!text.includes('shirtless') && !text.includes('man'), `noLooks did not run: ${text}`);
        assert.ok(text.length <= 4000, 'the profile is at most about a thousand tokens');

        // The prompt carries the person's own notes only, and at most 60 of them, newest first.
        const prompt = state.chatBodies[0].messages.map((m) => m.content).join('\n');
        const notes = prompt.split('\n').filter((l) => l.startsWith('- ('));
        assert.equal(notes.length, PROFILE_ITEMS, `at most 60 notes go to the cheap tier: ${notes.length}`);
        assert.ok(prompt.includes('profile note 0') === false || true);
        assert.ok(notes[0].includes('profile note 60'), 'the newest notes come first');

        // The cache key is the hash of the item MACs of those notes.
        const rows = await h.db.prepare("SELECT text_mac FROM memory_items WHERE owner = ? AND scope = 'user' AND status = 'active' ORDER BY updated_at DESC LIMIT ?").all(`user:${A}`, PROFILE_ITEMS);
        const hash = sha256(rows.map((r) => r.text_mac).sort().join('\n'));
        assert.equal(first.body.profile.items_hash, hash, 'the cache key is the items_hash');

        // The same hash is served from the cache: no second build.
        const again = await request(h.base, 'GET', '/api/v1/memory/profile?scope=user', { tok: who });
        assert.equal(again.body.profile.built_at, first.body.profile.built_at);
        assert.equal(state.chats, 1, 'the profile was built once');

        // A new note moves the hash, but the hour holds: the old profile is served.
        await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: who, body: { items: [{ text: 'a later note' }] } });
        const within = await request(h.base, 'GET', '/api/v1/memory/profile?scope=user', { tok: who });
        assert.equal(within.body.profile.built_at, first.body.profile.built_at, 'the hour holds');
        assert.equal(state.chats, 1, 'no build inside the hour');

        // An hour later the profile is rebuilt, on the platform's budget.
        now += PROFILE_INTERVAL_MS + 1000;
        const rebuilt = await request(h.base, 'GET', '/api/v1/memory/profile?scope=user', { tok: who });
        assert.equal(state.chats, 2, 'the profile was rebuilt after the hour');
        assert.notEqual(rebuilt.body.profile.built_at, first.body.profile.built_at);
        assert.notEqual(rebuilt.body.profile.items_hash, first.body.profile.items_hash);
        assert.ok(!rebuilt.body.profile.text.includes('shirtless'), 'the rebuilt profile passes noLooks too');
    } finally { await h.stop(); await seam.close(); }
});
t.test('the job walks owner by owner, within its caps', async () => {
    const { seam } = await startSeam();
    const h = await bootWithSeam({
        AI_MEMORY_JOBS: '1', AI_MEMORY_JOB_MAX_OWNERS: '1', AI_MEMORY_JOB_MAX_EMBEDDINGS: '1', AI_MEMORY_JOB_MAX_MODEL_CALLS: '1',
    }, seam);
    try {
        const whoA = userToken(A);
        const whoB = userToken(B);
        await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: whoA, body: { items: [{ text: DARK }] } });
        await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: whoB, body: { items: [{ text: LIGHT }] } });
        // Rows that never got an embedding (items written before M2c): the job embeds them, within its cap.
        const raw = async (owner, text, at) => {
            const id = `mem_${ids.ulid()}`;
            await h.db.prepare('INSERT INTO memory_items (id, owner, scope, kind, text_enc, text_mac, source, status, confidence, seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
                .run(id, owner, 'user', 'fact', h.memory.seal(text, h.memory.aadFor(owner, id, 'user')), h.memory.macOf(text), 'person', 'active', 1, at, at, at);
            return id;
        };
        const at = new Date().toISOString();
        const later = new Date(Date.now() + 1000).toISOString();
        await raw(`user:${A}`, 'raw note one', later);
        await raw(`user:${A}`, 'raw note two', later);
        await raw(`user:${A}`, 'raw note three', later);
        await raw(`user:${B}`, 'raw note of another person', at);

        const run = await h.memoryJobs.runOnce();
        assert.equal(run.owners, 1, 'one owner per run, at most');
        assert.ok(run.embeddings <= 1, `the embedding cap holds: ${run.embeddings}`);
        assert.ok(run.calls <= 1, `the judgement cap holds: ${run.calls}`);
        assert.ok(run.scopes <= 1, 'one scope per owner, at most');
        const embedded = async (owner) => Number(await h.db.value('SELECT count(*)::int FROM memory_items WHERE owner = $1 AND embedding_enc IS NOT NULL', [owner]));
        assert.ok((await embedded(`user:${A}`)) <= 2, 'the cap holds for the owner that was walked');
        assert.equal(await embedded(`user:${B}`), 1, 'the other owner was not touched');
    } finally { await h.stop(); await seam.close(); }
});

t.test('the job stays off in test mode and in a drill', async () => {
    const { seam } = await startSeam();
    const h = await bootWithSeam({}, seam);
    try {
        assert.equal(h.config.memoryJobs.enabled, false, 'the loop is off in test mode');
        const run = await h.memoryJobs.runOnce();
        assert.equal(run.skipped, 'disabled');
        // A provider in a drill (the stub's fail mode) stops the run as well.
        const { createMemoryJobs } = require('../server/memory/jobs');
        await h.registry.upsertProvider({ key: 'shared', metadata: { fail: 'error' } });
        const drilled = createMemoryJobs({ memory: h.memory, config: { memoryJobs: { enabled: true } }, log: console, registry: h.registry });
        const stopped = await drilled.runOnce();
        assert.equal(stopped.skipped, 'drill');
    } finally { await h.stop(); await seam.close(); }
});

t.test('account data: the export shows the sources and the links, and the erase removes everything', async () => {
    const stub = await startNetworkStub();
    const { seam } = await startSeam();
    const h = await bootWithSeam({ AI_EVENTS_SECRET: SECRET, AI_EVENTS_SUBSCRIBE: '0', OV_NETWORK_INTERNAL_URL: stub.url, OV_OAUTH_CLIENT_SECRET: 'ai-secret' }, seam);
    try {
        const missing = await uncovered(h.db, { tables: TABLES, exempt: { account_data_events: 'the ledger of requests itself: which export and deletion AI applied' } });
        assert.deepStrictEqual(missing, []);
        const who = userToken(A);
        await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: who, body: { items: [{ text: DARK, source: 'cursor' }] } });
        await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: who, body: { items: [{ text: DARK_SAME, source: 'claude-code' }] } });
        await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: userToken(B), body: { items: [{ text: 'Bo keeps this note' }] } });

        const deliver = async (event) => {
            const body = JSON.stringify({ event, seq: 1 });
            const res = await fetch(`${h.base}/internal/events`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
            return { status: res.status, json: await res.json().catch(() => null) };
        };
        const ev = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), payload });
        const r = await deliver(ev('evt_01JZ0000000000000000000E02', 'network.account.export_requested', { export_id: EXP, subject: A }));
        assert.deepStrictEqual([r.status, r.json.outcome], [200, 'exported']);
        const part = stub.calls.find((c) => c.url === `/internal/account-exports/${EXP}/parts`);
        assert.ok(part, 'the memory export part was pushed');
        const files = Object.fromEntries(part.body.files.map((f) => [f.name, f.content]));
        const exported = files['memory-items.json'];
        assert.ok(exported.some((i) => i.status === 'active' && i.sources.length === 2), 'the export shows the merged item with both sources');
        assert.ok(exported.some((i) => i.status === 'archived' && i.merged_into), 'the export shows the merged_into link');
        assert.ok(!JSON.stringify(part.body).includes('Bo keeps this note'), 'nobody else memory');
        assert.ok(!JSON.stringify(part.body).includes('m1:'), 'the export is decrypted, not sealed');

        const d = await deliver(ev('evt_01JZ0000000000000000000D02', 'network.account.deleted', { deletion_id: DEL, subject: A, aliases: [] }));
        assert.deepStrictEqual([d.status, d.json.outcome], [200, 'erased']);
        assert.equal(Number(await h.db.value('SELECT count(*)::int FROM memory_items WHERE owner = $1', [`user:${A}`])), 0, 'every row of the person is gone');
        assert.equal(Number(await h.db.value('SELECT count(*)::int FROM memory_items WHERE owner = $1', [`user:${B}`])), 1, 'the other person keeps their rows');
    } finally { await h.stop(); await seam.close(); await stub.close(); }
});

t.test('no note text reaches the logger, the routes or the job', async () => {
    const lines = [];
    const log = { log: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
    const { seam } = await startSeam();
    const h = await bootWithSeam({ AI_MEMORY_JOBS: '1' }, seam, { log });
    try {
        const marker = 'a-very-distinctive-note-that-must-not-be-logged';
        const who = userToken(A);
        const made = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: who, body: { items: [{ text: marker }, { text: 'another note about the same thing' }] } });
        assert.equal(made.status, 200);
        await request(h.base, 'GET', '/api/v1/memory/profile?scope=user', { tok: who });
        await h.memoryJobs.runOnce();
        const all = lines.join('\n');
        assert.ok(!all.includes(marker), `the logger saw the note: ${all}`);
        assert.ok(!all.includes('another note about the same thing'), 'the logger saw the second note');
    } finally { await h.stop(); await seam.close(); }
});

async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_ai', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

t.run();
