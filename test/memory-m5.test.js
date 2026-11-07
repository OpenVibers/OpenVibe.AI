'use strict';
/**
 * Memory M5: the memory-service adapters (mem0, Letta, Zep) against a stub of each HTTP API, the sealed key, the one
 * portable file and its round trip, and a shared store that only its members can read.
 *
 * Nothing here calls a real provider: every adapter reaches a local stub that checks the auth header the service
 * documents. The key is asserted to be sealed in the database, absent from every answer and absent from every log line.
 */
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { boot, request, suite, privateKey, ISSUER } = require('./helpers');

const t = suite('memory-m5');
const KEY = 'a'.repeat(64);
const CRED = 'b'.repeat(64);
const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';
const C = 'usr_01JZ0000000000000000000CCC';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A person's Network access token: no actor_type, the subject in subject_id. */
function userToken(subject) {
    const now = Math.floor(Date.now() / 1000);
    const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: ISSUER, sub: subject, subject_id: subject, aud: ['openvibe.network'], iat: now, exp: now + 3600, jti: `tok_${crypto.randomBytes(8).toString('hex')}` })}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

const MEM0 = 'mem0-key-0123456789';
const LETTA = 'letta-key-0123456789';
const ZEP = 'zep-key-0123456789';
// A secret-shaped fixture, built from parts so a source scanner does not read it as a real Stripe key.
const FAKE_STRIPE = ['sk_live', 'abcdef0123456789'].join('_');

const PUBLIC = '93.184.216.34';

/**
 * The test seam the guarded transport exposes: a scripted answer instead of a socket. It records the exact request
 * (URL, headers, timeout and cap) so a test can prove a refused host never saw the key.
 */
function fakeServiceTransport(handler) {
    const calls = [];
    const transport = async (send) => {
        const call = { method: send.method, url: send.url, headers: { ...send.headers }, timeoutMs: send.timeoutMs, maxBytes: send.maxBytes };
        calls.push(call);
        const u = new URL(send.url);
        const res = await handler(u, call);
        return res || { status: 404, headers: {}, body: '{"detail":"no route"}' };
    };
    transport.calls = calls;
    return transport;
}

const jsonRes = (status, obj) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });

/** The happy answers of the three services: enough for a probe and a sync. */
function happyService(u) {
    if (u.pathname === '/v1/memories/') {
        return jsonRes(200, { results: [
            { id: 'm1', memory: 'Prefers small pull requests.', created_at: '2026-11-01T10:00:00Z' },
            { id: 'm2', memory: 'The API key is ' + FAKE_STRIPE + ' and it must not survive redaction.', created_at: '2026-11-02T10:00:00Z' },
        ], next: null });
    }
    if (u.pathname === '/v1/agents/') return jsonRes(200, [{ id: 'agent_1', name: 'Ada' }]);
    if (u.pathname === '/v1/agents/agent_1/core-memory/blocks') {
        return jsonRes(200, [{ label: 'human', value: 'Ada works in UTC+1.' }, { label: 'persona', value: 'A careful assistant.' }]);
    }
    if (u.pathname === '/v1/agents/agent_1/archival-memory') return jsonRes(200, [{ id: 'passage_1', text: 'Ships on Fridays only with the owner’s Go.', created_at: '2026-10-30T08:00:00Z' }]);
    if (u.pathname === '/users') return jsonRes(200, [{ user_id: 'zep_user' }]);
    if (u.pathname === '/users/zep_user/sessions') return jsonRes(200, [{ session_id: 's1' }]);
    if (u.pathname === '/users/zep_user/sessions/s1/memory') return jsonRes(200, { memory: { facts: [{ uuid: 'f1', fact: 'Prefers TypeScript for new services.', created_at: '2026-11-03T09:00:00Z' }] } });
    return jsonRes(404, { detail: 'no route' });
}

/** The Network and Events stub the sharing test needs; service traffic never reaches it (it is the injected transport). */
async function startStub() {
    const calls = [];
    const people = {
        [A]: { subject: { type: 'user', id: A }, username: 'ada', display_name: 'Ada' },
        [B]: { subject: { type: 'user', id: B }, username: 'bo', display_name: 'Bo' },
        [C]: { subject: { type: 'user', id: C }, username: 'cy', display_name: 'Cy' },
    };
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString();
            let body = null;
            try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
            calls.push({ url: req.url, method: req.method, auth: req.headers.authorization || '', body });
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_service', token_type: 'Bearer', expires_in: 300 });
            if (req.url === '/internal/identity/resolve-batch') {
                const results = {};
                for (const id of (body && body.subject_ids) || []) if (people[id]) results[id] = people[id];
                return json(200, { results });
            }
            if (req.url && req.url.startsWith('/internal/identity/resolve')) {
                const name = new URL(req.url, 'http://x').searchParams.get('username');
                const found = Object.values(people).find((p) => p.username === name) || null;
                return json(200, { person: found });
            }
            if (req.url === '/internal/notifications/push') return json(201, {});
            if (req.url === '/events') return json(202, {});
            return json(404, { detail: 'no route' });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

t.test('mem0, Letta and Zep: each adapter reads its stub API, and the key never leaves the sealed row', async () => {
    const logs = [];
    const capture = (...args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    const transport = fakeServiceTransport(async (u) => happyService(u));
    const lookup = (host, opts, cb) => cb(null, [{ address: PUBLIC, family: 4 }]);
    const h = await boot({
        env: { AI_MEMORY_KEY: KEY, AI_CREDENTIALS_KEY: CRED },
        log: { log: capture, warn: capture, error: capture },
        memoryTransport: transport,
        memoryLookup: lookup,
    });
    try {
        const put = async (provider, key, base) => {
            const r = await request(h.base, 'PUT', `/api/v1/memory/services/${provider}`, { tok: userToken(A), body: { key, base_url: base } });
            assert.strictEqual(r.status, 200, r.text);
            assert.ok(!r.text.includes(key), `the ${provider} answer carries the key`);
            assert.strictEqual(r.body.service.hint, key.slice(-4));
            assert.strictEqual(r.body.service.status, 'ok', r.text);
            const row = await h.db.maybe('SELECT key_enc, key_hint FROM memory_service_connections WHERE subject = $1 AND provider = $2', [A, provider]);
            assert.ok(row && row.key_enc.startsWith('v1:'), `${provider} key is sealed`);
            assert.ok(!row.key_enc.includes(key), `${provider} key is not in the ciphertext`);
            return r;
        };
        await put('mem0', MEM0, 'https://mem0.example');
        await put('letta', LETTA, 'https://letta.example');
        await put('zep', ZEP, 'https://zep.example');
        const call = (host, header) => transport.calls.find((c) => new URL(c.url).hostname === host && c.headers.Authorization === header);
        assert.ok(call('mem0.example', `Token ${MEM0}`), 'mem0 was called with its documented header');
        assert.ok(call('letta.example', `Bearer ${LETTA}`), 'Letta was called with its bearer');
        assert.ok(call('zep.example', `Api-Key ${ZEP}`), 'Zep was called with its Api-Key header');
        assert.ok(transport.calls.every((c) => c.url.startsWith('https://')), 'every adapter call is https');
        assert.ok(transport.calls.every((c) => c.timeoutMs === 15000 && c.maxBytes === 1024 * 1024), 'every call has the 15 s timeout and the 1 MB cap');

        const list = await request(h.base, 'GET', '/api/v1/memory/services', { tok: userToken(A) });
        assert.strictEqual(list.status, 200);
        assert.ok(!JSON.stringify(list.body).includes(MEM0) && !JSON.stringify(list.body).includes(LETTA) && !JSON.stringify(list.body).includes(ZEP), 'the list carries no key');

        const sync = async (provider) => {
            const r = await request(h.base, 'POST', `/api/v1/memory/services/${provider}/sync`, { tok: userToken(A) });
            assert.strictEqual(r.status, 200, r.text);
            assert.ok(r.body.found >= 1, `${provider} found something: ${r.text}`);
            return r.body;
        };
        await sync('mem0');
        await sync('letta');
        await sync('zep');
        const items = await request(h.base, 'GET', '/api/v1/memory/items', { tok: userToken(A) });
        assert.strictEqual(items.status, 200);
        const texts = items.body.items.map((i) => i.text).join('\n');
        assert.ok(texts.includes('Prefers small pull requests.'), texts);
        assert.ok(texts.includes('Ada works in UTC+1.'), texts);
        assert.ok(texts.includes('Prefers TypeScript for new services.'), texts);
        assert.ok(!texts.includes(FAKE_STRIPE), 'a secret from a service was redacted before it was stored');
        assert.ok(items.body.items.some((i) => i.source === 'mem0') && items.body.items.some((i) => i.source === 'letta') && items.body.items.some((i) => i.source === 'zep'));
        assert.ok(!logs.join('\n').includes(MEM0) && !logs.join('\n').includes(LETTA) && !logs.join('\n').includes(ZEP), 'a key reached the log');
        assert.ok(!logs.join('\n').includes(FAKE_STRIPE), 'a secret reached the log');
    } finally { await h.stop(); }
});

t.test('a private or malformed base_url is refused at save and at sync, and the key is never sent there', async () => {
    const { createServiceKeys } = require('../server/memory/services/keys');
    const state = { address: PUBLIC, redirect: false };
    const transport = fakeServiceTransport(async (u) => {
        if (u.hostname === 'redirect.example' || (state.redirect && u.hostname === 'redir.example')) {
            return { status: 302, headers: { location: 'https://10.0.0.5/steal' }, body: '' };
        }
        return happyService(u);
    });
    const lookup = (host, opts, cb) => cb(null, [{ address: state.address, family: 4 }]);
    const h = await boot({
        env: { AI_MEMORY_KEY: KEY, AI_CREDENTIALS_KEY: CRED },
        memoryTransport: transport,
        memoryLookup: lookup,
    });
    try {
        const refusedSave = async (url) => {
            const before = transport.calls.length;
            const r = await request(h.base, 'PUT', '/api/v1/memory/services/mem0', { tok: userToken(A), body: { key: MEM0, base_url: url } });
            assert.strictEqual(r.status, 422, `${url}: ${r.text}`);
            assert.strictEqual(transport.calls.length, before, `${url} reached the transport`);
            assert.ok(!JSON.stringify(transport.calls).includes(MEM0), `${url} sent the key`);
        };
        state.address = PUBLIC;
        await refusedSave('https://127.0.0.1');
        await refusedSave('https://10.0.0.5');
        await refusedSave('http://mem0.example');
        await refusedSave('https://localhost');
        await refusedSave('https://example.com:3000');
        await refusedSave('https://user:pass@mem0.example');
        state.address = '192.168.1.2';
        await refusedSave('https://private.example');
        state.address = PUBLIC;
        const rows = await h.db.maybe("SELECT COUNT(*)::int AS n FROM memory_service_connections WHERE subject = $1", [A]);
        assert.strictEqual(Number(rows.n), 0, 'no refused host left a key row');

        // At sync: a row that exists (a legacy row, or one written before this guard) is refused before its key is opened.
        const keys = createServiceKeys({ db: h.db, config: h.config });
        const refusedSync = async (base) => {
            await keys.put(A, 'zep', { key: ZEP, base_url: base });
            const before = transport.calls.length;
            const r = await request(h.base, 'POST', '/api/v1/memory/services/zep/sync', { tok: userToken(A) });
            assert.strictEqual(r.status, 422, `${base}: ${r.text}`);
            assert.strictEqual(transport.calls.length, before, `${base} reached the transport at sync`);
            assert.ok(!JSON.stringify(transport.calls).includes('zep-key-0123456789'), `${base} sent the key at sync`);
        };
        state.address = PUBLIC;
        await refusedSync('https://127.0.0.1');
        await refusedSync('https://10.0.0.5');
        await refusedSync('http://mem0.example');
        await refusedSync('https://localhost');
        await refusedSync('https://example.com:3000');
        await refusedSync('https://user:pass@mem0.example');
        state.address = '192.168.1.2';
        await refusedSync('https://private.example');

        // A redirect is never followed. At save it refuses the connection; at sync it refuses the read.
        state.address = PUBLIC;
        const beforeRedirect = transport.calls.length;
        const redirectSave = await request(h.base, 'PUT', '/api/v1/memory/services/letta', { tok: userToken(A), body: { key: LETTA, base_url: 'https://redirect.example' } });
        assert.strictEqual(redirectSave.status, 422, redirectSave.text);
        assert.ok(redirectSave.text.includes('the service answered with a redirect'), redirectSave.text);
        const afterRedirect = transport.calls.slice(beforeRedirect);
        assert.ok(afterRedirect.length >= 1 && afterRedirect.every((c) => new URL(c.url).hostname === 'redirect.example'), 'only the allowed host was tried');
        assert.ok(!afterRedirect.some((c) => c.url.includes('10.0.0.5')), 'the redirect target was never fetched');

        await keys.put(A, 'mem0', { key: MEM0, base_url: 'https://redir.example' });
        state.redirect = true;
        const beforeSyncRedirect = transport.calls.length;
        const syncRedirect = await request(h.base, 'POST', '/api/v1/memory/services/mem0/sync', { tok: userToken(A) });
        assert.strictEqual(syncRedirect.status, 502, syncRedirect.text);
        assert.strictEqual(syncRedirect.body.code, 'memory.service_redirect');
        assert.ok(String(syncRedirect.body.detail).includes('the service answered with a redirect'), syncRedirect.text);
        const syncCalls = transport.calls.slice(beforeSyncRedirect);
        assert.ok(syncCalls.length >= 1 && syncCalls.every((c) => new URL(c.url).hostname === 'redir.example'), 'the sync tried only the allowed host');
        assert.ok(!syncCalls.some((c) => c.url.includes('10.0.0.5')), 'the sync followed the redirect');
    } finally { await h.stop(); }
});

t.test('the portable file exports decrypted items, imports into another account, and round-trips', async () => {
    const h = await boot({ env: { AI_MEMORY_KEY: KEY, AI_CREDENTIALS_KEY: CRED } });
    try {
        const made = await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: userToken(A), body: { items: [
            { text: 'Prefers short answers.', kind: 'preference', source: 'claude-code', scope: 'user' },
            { text: 'Never rewrite history on main.', kind: 'project_rule', source: 'agents', scope: 'project:openvibe' },
        ] } });
        assert.strictEqual(made.status, 200, made.text);
        const exp = await request(h.base, 'GET', '/api/v1/memory/export', { tok: userToken(A) });
        assert.strictEqual(exp.status, 200, exp.text);
        assert.strictEqual(exp.headers.get('cache-control'), 'no-store');
        assert.strictEqual(exp.body.format, 'openvibe.memory-export@1');
        assert.strictEqual(exp.body.version, 1);
        assert.strictEqual(exp.body.items.length, 2);
        for (const item of exp.body.items) {
            assert.ok(item.text && item.kind && item.scope && item.source, JSON.stringify(item));
            assert.ok(!('owner' in item) && !('id' in item), 'the portable item carries no identity');
        }
        // Imported into B's store: the same text, kind, scope and source, under a different person.
        const imp = await request(h.base, 'POST', '/api/v1/memory/import', { tok: userToken(B), body: exp.body });
        assert.strictEqual(imp.status, 200, imp.text);
        assert.deepStrictEqual([imp.body.created, imp.body.deduped], [2, 0], imp.text);
        const b = await request(h.base, 'GET', '/api/v1/memory/items', { tok: userToken(B) });
        const got = b.body.items.map((i) => `${i.text}|${i.kind}|${i.scope}|${i.source}`).sort();
        const want = exp.body.items.map((i) => `${i.text}|${i.kind}|${i.scope}|${i.source}`).sort();
        assert.deepStrictEqual(got, want, 'the round trip kept text, kind, scope and source');
        // The same file again is a dedupe, not a second copy.
        const again = await request(h.base, 'POST', '/api/v1/memory/import', { tok: userToken(B), body: exp.body });
        assert.strictEqual(again.status, 200, again.text);
        assert.deepStrictEqual([again.body.created, again.body.deduped], [0, 2], again.text);
        // A file that is not the format is refused.
        const bad = await request(h.base, 'POST', '/api/v1/memory/import', { tok: userToken(B), body: { format: 'openvibe.memory-export@2', version: 2, items: [] } });
        assert.strictEqual(bad.status, 422, bad.text);
    } finally { await h.stop(); }
});

t.test('a shared store is readable only by its members, and the answer is never shared-cacheable', async () => {
    const stub = await startStub();
    const h = await boot({
        env: { AI_MEMORY_KEY: KEY, AI_CREDENTIALS_KEY: CRED, OV_OAUTH_CLIENT_SECRET: 'ai-secret', OV_NETWORK_INTERNAL_URL: stub.url, AI_EVENTS_URL: `${stub.url}/events`, AI_EVENTS_SUBSCRIBE: '0' },
    });
    try {
        assert.ok(h.memorySharing, 'sharing is wired when the Network client and Events are configured');
        await request(h.base, 'POST', '/api/v1/memory/items:batch', { tok: userToken(A), body: { items: [{ text: 'Team remembers the deploy order.', kind: 'procedure' }] } });
        const notYet = await request(h.base, 'GET', `/api/v1/memory/stores/${A}`, { tok: userToken(B) });
        assert.deepStrictEqual([notYet.status, notYet.body.code], [404, 'memory.not_found']);
        const own = await request(h.base, 'GET', `/api/v1/memory-store/${A}/share`, { tok: userToken(A) });
        assert.strictEqual(own.status, 200, own.text);
        assert.strictEqual(own.body.audience, 'private');
        assert.deepStrictEqual(own.body.audiences, ['public', 'link', 'people', 'private']);
        assert.match(own.headers.get('cache-control') || '', /no-store/);
        // The owner adds B as a viewer, through the same library the routes use.
        await h.memorySharing.shares.addMembers({ subject: { type: 'user', id: A } }, h.memorySharing.refOf(A), [{ subject: { type: 'user', id: B }, role: 'viewer' }]);
        await h.memorySharing.shares.setAudience({ subject: { type: 'user', id: A } }, h.memorySharing.refOf(A), 'people');
        const shared = await request(h.base, 'GET', `/api/v1/memory/stores/${A}`, { tok: userToken(B) });
        assert.strictEqual(shared.status, 200, shared.text);
        assert.deepStrictEqual(shared.body.items.map((i) => i.text), ['Team remembers the deploy order.']);
        assert.strictEqual(shared.headers.get('cache-control'), 'no-store');
        const stranger = await request(h.base, 'GET', `/api/v1/memory/stores/${A}`, { tok: userToken(C) });
        assert.deepStrictEqual([stranger.status, stranger.body.code], [404, 'memory.not_found']);
        const mine = await request(h.base, 'GET', '/api/v1/memory/shared', { tok: userToken(B) });
        assert.strictEqual(mine.status, 200, mine.text);
        assert.ok(mine.body.stores.some((s) => s.owner === A && s.role === 'viewer'), mine.text);
        // Only the owner's token can see the settings for somebody else's store as a member, and the notes never
        // appear in the shared-with-me listing.
        assert.ok(!JSON.stringify(mine.body).includes('Team remembers'), 'the listing carries no note');
        // The settings sheet belongs to the owner; a member reads the store, never its ACL.
        const asB = await request(h.base, 'GET', `/api/v1/memory-store/${A}/share`, { tok: userToken(B) });
        assert.deepStrictEqual([asB.status, asB.body.code], [404, 'share.not_found']);
        // Back to Only me: B loses the store at once.
        await h.memorySharing.shares.setAudience({ subject: { type: 'user', id: A } }, h.memorySharing.refOf(A), 'private');
        const after = await request(h.base, 'GET', `/api/v1/memory/stores/${A}`, { tok: userToken(B) });
        assert.deepStrictEqual([after.status, after.body.code], [404, 'memory.not_found']);
    } finally { await h.stop(); await stub.close(); }
});

t.test('the transport itself refuses a private DNS answer, and the URL rules are the ones the route uses', async () => {
    const { createServiceTransport, judgeBaseUrl, judgeRequestUrl } = require('../server/memory/services/transport');
    const bad = (url) => assert.throws(() => judgeBaseUrl(url), (e) => e.status === 422, url);
    bad('https://127.0.0.1');
    bad('https://10.0.0.5');
    bad('http://mem0.example');
    bad('https://localhost');
    bad('https://example.com:3000');
    bad('https://user:pass@mem0.example');
    bad('https://example.com/?x=1');
    assert.strictEqual(judgeBaseUrl('https://api.getzep.com/api/v2').toString(), 'https://api.getzep.com/api/v2');
    assert.strictEqual(judgeRequestUrl('https://api.mem0.ai/v1/memories/?page=1').toString(), 'https://api.mem0.ai/v1/memories/?page=1');
    const guarded = createServiceTransport({ lookup: (host, opts, cb) => cb(null, [{ address: '192.168.1.2', family: 4 }]) });
    await assert.rejects(
        guarded.get('https://private.example/v1/memories/', { Authorization: 'Token a-key-that-must-not-leave' }),
        (e) => e.code === 'memory.service_blocked' && e.status === 502,
    );
});

t.run();
