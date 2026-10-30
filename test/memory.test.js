'use strict';
/**
 * Memory M2a: the person's store in OpenVibe.AI. Sealing and AAD binding, dedupe, server-side redaction, owner scope,
 * the agent search (active only, at most 8, audited), the profile cache, delete, the 503 without a key, account data
 * and the no-plaintext-in-logs rule.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { uncovered } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, request, suite, token, privateKey, ISSUER } = require('./helpers');
const { TABLES } = require('../server/account-data');
const { createMemory } = require('../server/memory');

const t = suite('memory');
const KEY = 'a'.repeat(64);
const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';
const EXP = 'exp_01JZ0000000000000000000EXP';
const DEL = 'del_01JZ0000000000000000000DEX';
const SECRET = `whsec_${'memory'.repeat(5)}`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A person's Network access token: no actor_type, the subject in subject_id. */
function userToken(subject, { aud = ['openvibe.network'] } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: ISSUER, sub: subject, subject_id: subject, aud, iat: now, exp: now + 3600, jti: `tok_${crypto.randomBytes(8).toString('hex')}` })}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

const serviceWrite = (extra = {}) => token('codes', ['ai.memory.write'], { extra });
const serviceRead = (extra = {}) => token('codes', ['ai.memory.read'], { extra });
const item = (text, extra = {}) => ({ text, ...extra });

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

t.test('without AI_MEMORY_KEY every route answers 503 memory.unavailable', async () => {
    const h = await boot();
    try {
        const r = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: serviceWrite(), body: { items: [item('a note')], on_behalf_of: A } });
        assert.deepStrictEqual([r.status, r.body.code], [503, 'memory.unavailable']);
        const g = await request(h.base, 'GET', '/api/v1/memory/items', { tok: userToken(A) });
        assert.deepStrictEqual([g.status, g.body.code], [503, 'memory.unavailable']);
    } finally { await h.stop(); }
});

t.test('sealing is a round trip and the AAD binds owner, id and scope', async () => {
    const h = await boot({ env: { AI_MEMORY_KEY: KEY } });
    try {
        const aad = h.memory.aadFor(`user:${A}`, 'mem_01JZ0000000000000000000M01', 'project:demo');
        const sealed = h.memory.seal('the note', aad);
        assert.match(sealed, /^m1:/);
        assert.equal(h.memory.open(sealed, aad), 'the note');
        assert.throws(() => h.memory.open(sealed, h.memory.aadFor(`user:${B}`, 'mem_01JZ0000000000000000000M01', 'project:demo')), /does not open/);
        assert.throws(() => h.memory.open(sealed, h.memory.aadFor(`user:${A}`, 'mem_01JZ0000000000000000000M01', 'user')), /does not open/);
        assert.throws(() => h.memory.open(sealed, h.memory.aadFor(`user:${A}`, 'mem_01JZ0000000000000000000M02', 'project:demo')), /does not open/);
    } finally { await h.stop(); }
});

t.test('a batch stores sealed text, dedupes by MAC and redacts a secret again on the server', async () => {
    const h = await boot({ env: { AI_MEMORY_KEY: KEY } });
    try {
        const who = userToken(A);
        const first = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: who, body: { items: [
            item('Prefers short answers.', { source: 'cursor', scope: 'user' }),
            item(`the deploy token is ${'ghp_' + 'A'.repeat(36)}`, { source: 'claude-code' }),
        ] } });
        assert.deepStrictEqual([first.status, first.body.count, first.body.created, first.body.deduped], [200, 2, 2, 0]);
        assert.equal(first.body.items[1].text.includes('ghp_'), false);
        assert.ok(first.body.items[1].text.includes('[redacted]'));
        assert.ok(!('text_enc' in first.body.items[0]) && !('text_mac' in first.body.items[0]), 'sealed fields never leave the module');

        const row = await h.db.prepare('SELECT * FROM memory_items WHERE owner = ? ORDER BY created_at LIMIT 1').get(`user:${A}`);
        assert.match(row.text_enc, /^m1:/);
        assert.match(row.text_mac, /^[0-9a-f]{64}$/);
        assert.ok(!('text' in row), 'there is no plaintext column');

        const again = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: who, body: { items: [item('Prefers short answers.', { source: 'claude-code' })] } });
        assert.deepStrictEqual([again.status, again.body.created, again.body.deduped], [200, 0, 1]);
        const rows = await h.db.prepare('SELECT source FROM memory_items WHERE owner = ? AND scope = ?').all(`user:${A}`, 'user');
        assert.equal(rows.length, 2);
        assert.match(rows.find((r) => r.source.includes('cursor')).source, /cursor,claude-code|claude-code,cursor/);

        const refused = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: who, body: { items: [item('sk-' + 'proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')] } });
        assert.deepStrictEqual([refused.status, refused.body.code], [422, 'memory.secret_only']);
        assert.equal(Number(await h.db.value('SELECT count(*)::int FROM memory_items WHERE owner = $1', [`user:${A}`])), 2);
    } finally { await h.stop(); }
});

t.test('one person cannot read, change or delete another person\'s item, and every query is owner-scoped', async () => {
    const h = await boot({ env: { AI_MEMORY_KEY: KEY } });
    try {
        const made = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: userToken(A), body: { items: [item('A private note')] } });
        const id = made.body.items[0].id;
        const asB = userToken(B);
        assert.equal((await request(h.base, 'GET', `/api/v1/memory/items/${id}`, { tok: asB })).status, 404);
        assert.equal((await request(h.base, 'PATCH', `/api/v1/memory/items/${id}`, { tok: asB, body: { text: 'hijacked' } })).status, 404);
        assert.equal((await request(h.base, 'DELETE', `/api/v1/memory/items/${id}`, { tok: asB })).status, 404);
        const list = await request(h.base, 'GET', '/api/v1/memory/items', { tok: asB });
        assert.deepStrictEqual([list.status, list.body.items.length], [200, 0]);

        const dir = path.join(__dirname, '..', 'server', 'memory');
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
        const problems = [];
        for (const f of files) {
            const src = fs.readFileSync(path.join(dir, f), 'utf8');
            for (const m of src.matchAll(/(['"`])((?:(?!\1)[\s\S])*?(?:memory_items|memory_profiles|memory_reads)[\s\S]*?)\1/g)) {
                const sql = m[2].trim();
                if (!/^(SELECT|UPDATE|DELETE)\b/i.test(sql)) continue;
                if (!/owner = \$/.test(sql)) problems.push(`${f}: ${sql.split('\n')[0]}`);
            }
        }
        assert.deepStrictEqual(problems, [], `a memory query is not owner-scoped: ${problems.join(' | ')}`);
    } finally { await h.stop(); }
});

t.test('an agent sees active items only, at most 8, in its granted scopes, and the read is audited with ids only', async () => {
    const h = await boot({ env: { AI_MEMORY_KEY: KEY } });
    try {
        const items = [];
        for (let i = 0; i < 10; i++) items.push(item(`active note ${i}`, { scope: 'user' }));
        items.push(item('suggested note', { scope: 'user', status: 'suggested' }));
        items.push(item('archived note', { scope: 'user', status: 'archived' }));
        items.push(item('project note', { scope: 'project:demo' }));
        const made = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: userToken(A), body: { items } });
        assert.equal(made.status, 200);

        const grant = { memory_scopes: ['user', 'project:demo'] };
        const search = await request(h.base, 'GET', `/api/v1/memory/search?q=note&scopes=user&purpose=task-9&on_behalf_of=${A}`, { tok: serviceRead(grant) });
        assert.equal(search.status, 200);
        assert.equal(search.body.items.length, 8);
        assert.ok(search.body.items.every((i) => i.status === 'active' && i.scope === 'user'));
        assert.ok(!search.text.includes('suggested note') && !search.text.includes('archived note'));

        const audit = await h.db.prepare('SELECT * FROM memory_reads WHERE owner = ?').get(`user:${A}`);
        assert.equal(audit.actor, 'svc:codes');
        assert.equal(audit.purpose, 'task-9');
        const ids = JSON.parse(audit.item_ids);
        assert.equal(ids.length, 8);
        assert.ok(ids.every((id) => id.startsWith('mem_')));
        assert.ok(!audit.item_ids.includes('active note'), 'the audit holds ids, never text');

        const project = await request(h.base, 'GET', `/api/v1/memory/search?q=project&scopes=project:demo&on_behalf_of=${A}`, { tok: serviceRead(grant) });
        assert.deepStrictEqual([project.status, project.body.items.length], [200, 1]);
        const denied = await request(h.base, 'GET', `/api/v1/memory/search?q=project&scopes=project:demo&on_behalf_of=${A}`, { tok: serviceRead() });
        assert.deepStrictEqual([denied.status, denied.body.code], [403, 'memory.scope_denied']);

        const mismatch = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: serviceWrite({ on_behalf_of: A }), body: { items: [item('x')], on_behalf_of: B } });
        assert.deepStrictEqual([mismatch.status, mismatch.body.code], [403, 'capability.denied']);
    } finally { await h.stop(); }
});

t.test('a service may only search and suggest: every other memory route is person-only', async () => {
    const h = await boot({ env: { AI_MEMORY_KEY: KEY } });
    try {
        const who = userToken(A);
        const made = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: who, body: { items: [item("the person's active note")] } });
        const id = made.body.items[0].id;
        const read = serviceRead({ memory_scopes: ['user'] });
        const denied = (r) => {
            assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied']);
            assert.match(r.body.detail, /person's own token/);
        };
        denied(await request(h.base, 'GET', `/api/v1/memory/items?on_behalf_of=${A}`, { tok: read }));
        denied(await request(h.base, 'GET', `/api/v1/memory/items/${id}?on_behalf_of=${A}`, { tok: read }));
        denied(await request(h.base, 'GET', `/api/v1/memory/profile?scope=user&on_behalf_of=${A}`, { tok: read }));
        denied(await request(h.base, 'PATCH', `/api/v1/memory/items/${id}`, { tok: serviceWrite(), body: { text: 'hijacked', on_behalf_of: A } }));
        denied(await request(h.base, 'DELETE', `/api/v1/memory/items/${id}?on_behalf_of=${A}`, { tok: serviceWrite() }));
        denied(await request(h.base, 'DELETE', `/api/v1/memory/items?source=person&on_behalf_of=${A}`, { tok: serviceWrite() }));
        // None of the refusals touched the person's row.
        const still = await request(h.base, 'GET', `/api/v1/memory/items/${id}`, { tok: who });
        assert.deepStrictEqual([still.status, still.body.item.text, still.body.item.status], [200, "the person's active note", 'active']);

        // A service's write is a suggestion under its own name, whatever the body says.
        const suggested = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: serviceWrite(), body: { items: [
            item('a service suggestion', { status: 'active', source: 'person', confidence: 0.9 }),
        ], on_behalf_of: A } });
        assert.deepStrictEqual([suggested.status, suggested.body.items[0].status, suggested.body.items[0].source], [200, 'suggested', 'codes']);
        assert.ok(suggested.body.items[0].confidence <= 0.5, `confidence ${suggested.body.items[0].confidence} > 0.5`);
        const row = await h.db.prepare('SELECT status, source, confidence FROM memory_items WHERE owner = ? AND id = ?').get(`user:${A}`, suggested.body.items[0].id);
        assert.deepStrictEqual([row.status, row.source, Number(row.confidence)], ['suggested', 'codes', 0.5]);

        // Search still works for a service, and it is audited.
        const search = await request(h.base, 'GET', `/api/v1/memory/search?q=active&scopes=user&on_behalf_of=${A}`, { tok: read });
        assert.deepStrictEqual([search.status, search.body.items.length], [200, 1]);
        const audit = await h.db.prepare('SELECT actor, item_ids FROM memory_reads WHERE owner = ?').get(`user:${A}`);
        assert.equal(audit.actor, 'svc:codes');
        assert.ok(!audit.item_ids.includes('active note'));
    } finally { await h.stop(); }
});

t.test('a person token still writes active items, and still reads, changes and deletes them', async () => {
    const h = await boot({ env: { AI_MEMORY_KEY: KEY } });
    try {
        const who = userToken(A);
        const made = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: who, body: { items: [
            item('a person item', { status: 'active', source: 'claude-code', confidence: 1 }),
        ] } });
        assert.deepStrictEqual([made.status, made.body.items[0].status, made.body.items[0].source, made.body.items[0].confidence], [200, 'active', 'claude-code', 1]);
        const id = made.body.items[0].id;
        const list = await request(h.base, 'GET', '/api/v1/memory/items', { tok: who });
        assert.deepStrictEqual([list.body.items.length, (await request(h.base, 'GET', `/api/v1/memory/items/${id}`, { tok: who })).status], [1, 200]);
        const patched = await request(h.base, 'PATCH', `/api/v1/memory/items/${id}`, { tok: who, body: { text: 'a person edit' } });
        assert.deepStrictEqual([patched.status, patched.body.item.text], [200, 'a person edit']);
        assert.equal((await request(h.base, 'GET', '/api/v1/memory/profile?scope=project:empty', { tok: who })).status, 200);
        const removed = await request(h.base, 'DELETE', `/api/v1/memory/items/${id}`, { tok: who });
        assert.deepStrictEqual([removed.status, removed.body.deleted], [200, 1]);
    } finally { await h.stop(); }
});

t.test('delete removes the row and the profile built from it', async () => {
    const h = await boot({ env: { AI_MEMORY_KEY: KEY } });
    try {
        const who = userToken(A);
        const made = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: who, body: { items: [item('a note to remove')] } });
        const id = made.body.items[0].id;
        // No items: the profile route writes an empty cache row without spending a model call.
        const empty = await request(h.base, 'GET', '/api/v1/memory/profile?scope=project:gone', { tok: who });
        assert.equal(empty.status, 200);
        assert.equal(Number(await h.db.value('SELECT count(*)::int FROM memory_profiles WHERE owner = $1 AND scope = $2', [`user:${A}`, 'project:gone'])), 1);
        const prof = await request(h.base, 'GET', '/api/v1/memory/profile?scope=user', { tok: who });
        assert.equal(prof.status, 200);
        assert.equal(Number(await h.db.value('SELECT count(*)::int FROM memory_profiles WHERE owner = $1 AND scope = $2', [`user:${A}`, 'user'])), 1);
        const del = await request(h.base, 'DELETE', `/api/v1/memory/items/${id}`, { tok: who });
        assert.deepStrictEqual([del.status, del.body.deleted], [200, 1]);
        assert.equal(Number(await h.db.value('SELECT count(*)::int FROM memory_items WHERE owner = $1 AND id = $2', [`user:${A}`, id])), 0);
        assert.equal(Number(await h.db.value('SELECT count(*)::int FROM memory_profiles WHERE owner = $1 AND scope = $2', [`user:${A}`, 'user'])), 0);
        const gone = await request(h.base, 'GET', `/api/v1/memory/items/${id}`, { tok: who });
        assert.deepStrictEqual([gone.status, gone.body.code], [404, 'memory.not_found']);
    } finally { await h.stop(); }
});

t.test('a scope change re-seals the text, and deleting one source leaves the others', async () => {
    const h = await boot({ env: { AI_MEMORY_KEY: KEY } });
    try {
        const who = userToken(A);
        const made = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: who, body: { items: [
            item('a cursor note', { source: 'cursor' }),
            item('a claude note', { source: 'claude-code' }),
        ] } });
        const id = made.body.items[0].id;
        const patched = await request(h.base, 'PATCH', `/api/v1/memory/items/${id}`, { tok: who, body: { scope: 'project:demo', text: 'moved note' } });
        assert.deepStrictEqual([patched.status, patched.body.item.scope, patched.body.item.text], [200, 'project:demo', 'moved note']);
        const row = await h.db.prepare('SELECT * FROM memory_items WHERE owner = ? AND id = ?').get(`user:${A}`, id);
        assert.equal(h.memory.open(row.text_enc, h.memory.aadFor(`user:${A}`, id, 'project:demo')), 'moved note');
        assert.throws(() => h.memory.open(row.text_enc, h.memory.aadFor(`user:${A}`, id, 'user')), /does not open/);
        const searched = await request(h.base, 'GET', `/api/v1/memory/items?q=moved`, { tok: who });
        assert.deepStrictEqual([searched.status, searched.body.items.length], [200, 1]);
        const removed = await request(h.base, 'DELETE', '/api/v1/memory/items?source=cursor', { tok: who });
        assert.deepStrictEqual([removed.status, removed.body.deleted], [200, 1]);
        const left = await request(h.base, 'GET', '/api/v1/memory/items', { tok: who });
        assert.deepStrictEqual(left.body.items.map((i) => i.source), ['claude-code']);
    } finally { await h.stop(); }
});

t.test('the profile is cached, rebuilt only when items_hash moves and at most once an hour, and passes noLooks', async () => {
    const h = await boot({ env: { AI_MEMORY_KEY: KEY } });
    try {
        let now = Date.parse('2026-10-30T09:00:00.000Z');
        let calls = 0;
        const m = createMemory({ db: h.db, config: h.config, clock: { now: () => now }, log: h.log || console,
            buildProfile: async ({ items }) => { calls++; return `A shirtless man likes ${items.length} notes. He is a person.`; } });
        const req = { principal: { kind: 'user', subject: { type: 'user', id: A } }, query: { scope: 'user' }, body: {}, ov: {} };
        const owner = `user:${A}`;
        await m.batch({ principal: req.principal, body: { items: [item('one note'), item('two notes')] } }, owner);
        const first = await m.profile(req, owner);
        assert.equal(calls, 1);
        assert.ok(!first.profile.text.includes('shirtless') && !first.profile.text.includes('man'), `noLooks did not run: ${first.profile.text}`);
        assert.equal(first.profile.text.includes('[redacted]'), false);
        const second = await m.profile(req, owner);
        assert.equal(calls, 1, 'the same items_hash is served from the cache');
        assert.equal(second.profile.built_at, first.profile.built_at);

        await m.batch({ principal: req.principal, body: { items: [item('a third note')] } }, owner);
        const withinHour = await m.profile(req, owner);
        assert.equal(calls, 1, 'a changed hash within the hour waits');
        assert.equal(withinHour.profile.built_at, first.profile.built_at);

        now += 61 * 60 * 1000;
        const rebuilt = await m.profile(req, owner);
        assert.equal(calls, 2);
        assert.notEqual(rebuilt.profile.items_hash, first.profile.items_hash);
        assert.notEqual(rebuilt.profile.built_at, first.profile.built_at);
    } finally { await h.stop(); }
});

t.test('account data: the table guard passes, the export is decrypted, and a deletion erases the person\'s memory', async () => {
    const stub = await startNetworkStub();
    const h = await boot({ env: { AI_MEMORY_KEY: KEY, AI_EVENTS_SECRET: SECRET, AI_EVENTS_SUBSCRIBE: '0', OV_NETWORK_INTERNAL_URL: stub.url, OV_OAUTH_CLIENT_SECRET: 'ai-secret' } });
    try {
        const missing = await uncovered(h.db, { tables: TABLES, exempt: { account_data_events: 'the ledger of requests itself: which export and deletion AI applied' } });
        assert.deepStrictEqual(missing, []);
        await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: userToken(A), body: { items: [item('Ada exports this note')] } });
        await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: userToken(B), body: { items: [item('Bo keeps this note')] } });
        const deliver = async (event) => {
            const body = JSON.stringify({ event, seq: 1 });
            const res = await fetch(`${h.base}/internal/events`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
            return { status: res.status, json: await res.json().catch(() => null) };
        };
        const ev = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), payload });
        const r = await deliver(ev('evt_01JZ0000000000000000000E01', 'network.account.export_requested', { export_id: EXP, subject: A }));
        assert.deepStrictEqual([r.status, r.json.outcome], [200, 'exported']);
        const part = stub.calls.find((c) => c.url === `/internal/account-exports/${EXP}/parts`);
        assert.ok(part, 'the memory export part was pushed');
        const files = Object.fromEntries(part.body.files.map((f) => [f.name, f.content]));
        assert.ok(files['memory-items.json'].some((i) => i.text === 'Ada exports this note'));
        assert.ok(!JSON.stringify(part.body).includes('Bo keeps this note'), 'nobody else\'s memory');
        assert.ok(!JSON.stringify(part.body).includes('m1:'), 'the export is decrypted, not sealed');

        const d = await deliver(ev('evt_01JZ0000000000000000000D01', 'network.account.deleted', { deletion_id: DEL, subject: A, aliases: [] }));
        assert.deepStrictEqual([d.status, d.json.outcome], [200, 'erased']);
        assert.equal(Number(await h.db.value('SELECT count(*)::int FROM memory_items WHERE owner = $1', [`user:${A}`])), 0);
        assert.equal(Number(await h.db.value('SELECT count(*)::int FROM memory_items WHERE owner = $1', [`user:${B}`])), 1);
    } finally { await h.stop(); await stub.close(); }
});

t.test('no item text reaches the logger during a full flow', async () => {
    const lines = [];
    const log = { log: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
    const h = await boot({ env: { AI_MEMORY_KEY: KEY }, log });
    try {
        const who = userToken(A);
        const marker = 'a-very-distinctive-note-that-must-not-be-logged';
        const secret = ['correct', 'horse', 'battery', 'staple'].join(' ');
        const made = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: who, body: { items: [item(marker), item(`password: "${secret}"`)] } });
        assert.equal(made.status, 200);
        const id = made.body.items[0].id;
        await request(h.base, 'GET', '/api/v1/memory/items', { tok: who });
        await request(h.base, 'GET', `/api/v1/memory/items/${id}`, { tok: who });
        await request(h.base, 'GET', `/api/v1/memory/search?q=${encodeURIComponent(marker)}&scopes=user&on_behalf_of=${A}`, { tok: serviceRead({ memory_scopes: ['user'] }) });
        await request(h.base, 'PATCH', `/api/v1/memory/items/${id}`, { tok: who, body: { text: `${marker} edited` } });
        await request(h.base, 'DELETE', `/api/v1/memory/items/${id}`, { tok: who });
        const all = lines.join('\n');
        assert.ok(!all.includes(marker), `the logger saw the item text: ${all}`);
        assert.ok(!all.includes(secret), 'the logger saw the secret');
        assert.ok(!all.includes(['correct', 'horse'].join(' ')), 'the logger saw part of the secret');
    } finally { await h.stop(); }
});

t.run();
