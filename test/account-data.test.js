'use strict';
/**
 * ADR-033: AI's part of an account export and deletion, through the signed POST /internal/events route with a
 * stand-in Network. Ada's console/person sessions and provider credentials go in her export, without the key; her
 * deletion erases them, keeps the free-allowance ledger and the staff-owned catalogues, and leaves Bo's rows. The
 * guard fails when a new table with a person column is neither covered nor exempted with a reason.
 */
const assert = require('assert');
const http = require('http');
const { uncovered, createNetworkSender } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, suite } = require('./helpers');
const { TABLES } = require('../server/account-data');

const t = suite('account-data');
const SECRET = `whsec_${'fixture'.repeat(6)}`;
const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';
const EXP = 'exp_01JZ0000000000000000000EXP';
const DEL = 'del_01JZ0000000000000000000DEX';

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

const ev = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), payload });

t.test('every table that names a person is covered or exempted with a reason', async () => {
    const stub = await startNetworkStub();
    const h = await boot({ env: { AI_EVENTS_SECRET: SECRET, AI_EVENTS_SUBSCRIBE: '0', OV_NETWORK_INTERNAL_URL: stub.url, OV_OAUTH_CLIENT_SECRET: 'ai-secret' } });
    try {
        const missing = await uncovered(h.db, { tables: TABLES, exempt: { account_data_events: 'the ledger of requests itself: which export and deletion AI applied' } });
        assert.deepStrictEqual(missing, [], `a table with a person column is neither covered nor exempted: ${missing.join(', ')}`);
    } finally { await h.stop(); await stub.close(); }
});

t.test('an export carries the person\'s sessions and credential hints, and a deletion erases them, keeps the ledger, and confirms once', async () => {
    const stub = await startNetworkStub();
    const h = await boot({ env: { AI_EVENTS_SECRET: SECRET, AI_EVENTS_SUBSCRIBE: '0', OV_NETWORK_INTERNAL_URL: stub.url, OV_OAUTH_CLIENT_SECRET: 'ai-secret' } });
    try {
        for (const [subject, name] of [[A, 'ada'], [B, 'bo']]) {
            await h.db.exec("INSERT INTO console_sessions (id_hash, subject, username, staff, csrf, created_at, expires_at) VALUES ($1, $2, $3, '{}', 'c', '2026-10-01', '2027-10-01')", [`h_${name}`, subject, name]);
            await h.db.exec("INSERT INTO person_sessions (id_hash, subject, username, created_at, expires_at) VALUES ($1, $2, $3, '2026-10-01', '2027-10-01')", [`p_${name}`, subject, name]);
            await h.db.exec("INSERT INTO subject_credentials (owner, subject, provider, key_enc, key_hint, models, created_at, updated_at) VALUES ('proj_1', $1, 'openai', 'v1:secret', $2, '{}', '2026-10-01', '2026-10-02')", [subject, `hint-${name}`]);
            await h.db.exec("INSERT INTO free_allowance_usage (subject, provider, metric, period_start, period_end, free_used, updated_at) VALUES ($1, 'openai', 'input-tokens', 1, 2, 10, '2026-10-01')", [subject]);
            await h.db.exec("INSERT INTO routes (key, version, primary_provider, created_by, created_at) VALUES ($1, 1, 'openai', $2, '2026-10-01')", [`route-${name}`, subject]);
        }
        const deliver = async (event) => {
            const body = JSON.stringify({ event, seq: 1 });
            const res = await fetch(`${h.base}/internal/events`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
            return { status: res.status, json: await res.json().catch(() => null) };
        };

        const r = await deliver(ev('evt_01JZ0000000000000000000E01', 'network.account.export_requested', { export_id: EXP, subject: A }));
        assert.deepStrictEqual([r.status, r.json.outcome], [200, 'exported']);
        const part = stub.calls.find((c) => c.url === `/internal/account-exports/${EXP}/parts`);
        assert.ok(part, 'the part was pushed to Network');
        const files = Object.fromEntries(part.body.files.map((f) => [f.name, f.content]));
        assert.strictEqual(files['console-sessions.json'].length, 1);
        assert.strictEqual(files['person-sessions.json'].length, 1);
        assert.strictEqual(files['provider-credentials.json'].length, 1);
        assert.strictEqual(files['provider-credentials.json'][0].key_hint, 'hint-ada');
        assert.ok(!JSON.stringify(part.body).includes('v1:secret'), 'the encrypted key is never exported');
        assert.ok(!JSON.stringify(part.body).includes(B), 'nobody else\'s rows');

        const d = await deliver(ev('evt_01JZ0000000000000000000D01', 'network.account.deleted', { deletion_id: DEL, subject: A, aliases: [] }));
        assert.deepStrictEqual([d.status, d.json.outcome], [200, 'erased']);
        assert.strictEqual(Number(await h.db.value('SELECT count(*)::int FROM console_sessions WHERE subject = $1', [A])), 0);
        assert.strictEqual(Number(await h.db.value('SELECT count(*)::int FROM person_sessions WHERE subject = $1', [A])), 0);
        assert.strictEqual(Number(await h.db.value('SELECT count(*)::int FROM subject_credentials WHERE subject = $1', [A])), 0);
        assert.strictEqual(Number(await h.db.value('SELECT count(*)::int FROM free_allowance_usage WHERE subject = $1', [A])), 1, 'the allowance ledger stays');
        assert.strictEqual(Number(await h.db.value('SELECT count(*)::int FROM routes WHERE created_by = $1', [A])), 1, 'the staff catalogue stays');
        assert.strictEqual(Number(await h.db.value('SELECT count(*)::int FROM console_sessions WHERE subject = $1', [B])), 1, 'Bo stays');
        const confirmation = stub.calls.find((c) => c.url === `/internal/account-deletions/${DEL}/confirmations`);
        assert.ok(confirmation, 'the confirmation was sent');
        assert.ok(confirmation.body.erased.console_sessions >= 1);
    } finally { await h.stop(); await stub.close(); }
});

t.test('their runs, quota and module marker go; the spend ledger and the audit trail stay', async () => {
    const stub = await startNetworkStub();
    const h = await boot({ env: { AI_EVENTS_SECRET: SECRET, AI_EVENTS_SUBSCRIBE: '0', OV_NETWORK_INTERNAL_URL: stub.url, OV_OAUTH_CLIENT_SECRET: 'ai-secret' } });
    try {
        for (const [subject, name] of [[A, 'ada'], [B, 'bo']]) {
            await h.db.exec(`INSERT INTO runs (id, workflow_key, workflow_version, status, requester_type, requester_id, on_behalf_of, input, input_hash, output, created_at)
                VALUES ($1, 'chat', 1, 'succeeded', 'service', 'live', $2, $3, $4, 'answer', '2026-10-01')`,
                [`run_${name}`, JSON.stringify({ type: 'user', id: subject }), `hello ${name}`, `h-${name}`]);
            await h.db.exec("INSERT INTO requests (run_id, operation, provider_key, status, created_at) VALUES ($1, 'chat', 'openai', 'ok', '2026-10-01')", [`run_${name}`]);
            await h.db.exec("INSERT INTO citations (run_id, source_type, title, created_at) VALUES ($1, 'web', 'a source', '2026-10-01')", [`run_${name}`]);
            await h.db.exec("INSERT INTO cache_entries (cache_key, scope, workflow_key, workflow_version, input_hash, privacy, output, run_id, created_at, expires_at) VALUES ($1, 'private', 'chat', 1, $2, 'private', 'cached', $3, '2026-10-01', 1)", [`ck_${name}`, `h-${name}`, `run_${name}`]);
            await h.db.exec("INSERT INTO quotas (scope_type, scope_id, \"window\", max_requests, created_at, updated_at) VALUES ('actor', $1, 'minute', 10, '2026-10-01', '2026-10-01')", [`user:${subject}`]);
            await h.db.exec("INSERT INTO usage_counters (scope_type, scope_id, \"window\", window_start, requests, tokens, cost_usd) VALUES ('actor', $1, 'minute', 1, 2, 30, 0.5)", [`user:${subject}`]);
            await h.db.exec("INSERT INTO audit_log (at, actor, action, target_type, target_id) VALUES ('2026-10-01', $1, 'credential.put', 'credential', 'x')", [subject]);
            await h.db.exec("INSERT INTO ai_module_pushes (subject_id, hash, pushed_at) VALUES ($1, 'hash', '2026-10-01')", [subject]);
        }

        const deliver = async (event) => {
            const body = JSON.stringify({ event, seq: 1 });
            const res = await fetch(`${h.base}/internal/events`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
            return { status: res.status, json: await res.json().catch(() => null) };
        };

        const r = await deliver(ev('evt_01JZ0000000000000000000E02', 'network.account.export_requested', { export_id: EXP, subject: A }));
        assert.deepStrictEqual([r.status, r.json.outcome], [200, 'exported']);
        const part = stub.calls.find((c) => c.url === `/internal/account-exports/${EXP}/parts`);
        const runs = part.body.files.find((f) => f.name === 'runs.json');
        assert.ok(runs, 'runs.json is in the part');
        assert.deepStrictEqual(runs.content.map((x) => x.id), ['run_ada']);
        assert.strictEqual(runs.content[0].input, 'hello ada');

        const d = await deliver(ev('evt_01JZ0000000000000000000D02', 'network.account.deleted', { deletion_id: DEL, subject: A, aliases: [] }));
        assert.deepStrictEqual([d.status, d.json.outcome], [200, 'erased']);
        assert.strictEqual(Number(await h.db.value('SELECT count(*)::int FROM runs WHERE id = $1', ['run_ada'])), 0, 'her run is gone');
        assert.strictEqual(Number(await h.db.value('SELECT count(*)::int FROM requests WHERE run_id = $1', ['run_ada'])), 0, 'the request under it is gone');
        assert.strictEqual(Number(await h.db.value('SELECT count(*)::int FROM citations WHERE run_id = $1', ['run_ada'])), 0, 'the citation under it is gone');
        assert.strictEqual(Number(await h.db.value('SELECT count(*)::int FROM cache_entries WHERE run_id = $1', ['run_ada'])), 0, 'the cached answer is gone');
        assert.strictEqual(Number(await h.db.value('SELECT count(*)::int FROM quotas WHERE scope_id = $1', [`user:${A}`])), 0, 'her quota is gone');
        assert.strictEqual(Number(await h.db.value('SELECT count(*)::int FROM ai_module_pushes WHERE subject_id = $1', [A])), 0, 'her module marker is gone');
        assert.strictEqual(Number(await h.db.value('SELECT count(*)::int FROM usage_counters WHERE scope_id = $1', [`user:${A}`])), 1, 'the spend ledger stays');
        assert.strictEqual(Number(await h.db.value('SELECT count(*)::int FROM audit_log WHERE actor = $1', [A])), 1, 'the audit trail stays');
        assert.strictEqual(Number(await h.db.value('SELECT count(*)::int FROM runs WHERE id = $1', ['run_bo'])), 1, 'Bo\'s run stays');
        const confirmation = stub.calls.find((c) => c.url === `/internal/account-deletions/${DEL}/confirmations`);
        assert.ok(confirmation, 'the confirmation was sent');
        assert.strictEqual(confirmation.body.erased.runs, 1);
        assert.ok(confirmation.body.retained.usage_counters >= 1, 'the kept ledger is counted as retained');
    } finally { await h.stop(); await stub.close(); }
});

t.test('L36: the person\'s self credentials export without the key, and deletion erases them with their preferences', async () => {
    const stub = await startNetworkStub();
    const h = await boot({ env: { AI_EVENTS_SECRET: SECRET, AI_EVENTS_SUBSCRIBE: '0', OV_NETWORK_INTERNAL_URL: stub.url, OV_OAUTH_CLIENT_SECRET: 'ai-secret' } });
    try {
        const SECRET_KEY = 'sk-self-ada-0123456789LEAK';
        const sealed = `v2:${Buffer.alloc(12).toString('base64')}:${Buffer.alloc(16).toString('base64')}:${Buffer.from(SECRET_KEY).toString('base64')}`;
        await h.db.exec(`INSERT INTO subject_credentials (owner, subject, provider, key_enc, key_hint, models, status, checked_at, last_error, models_count, created_at, updated_at)
            VALUES ('self', $1, 'anthropic', $2, '…LEAK', '{"chat":"m"}', 'ok', '2026-10-31T09:00:00.000Z', NULL, 3, '2026-10-01', '2026-10-02')`, [A, sealed]);
        await h.db.exec(`INSERT INTO ai_person_preferences (subject, preferences, created_at, updated_at)
            VALUES ($1, '{"only_my_keys":true,"free_first":false,"price_ceiling_usd_per_mtok":5,"defaults":{"text":"auto","code":"auto","vision":"auto","image":"auto"}}', '2026-10-01', '2026-10-02')`, [A]);
        const deliver = async (event) => {
            const body = JSON.stringify({ event, seq: 1 });
            const res = await fetch(`${h.base}/internal/events`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
            return { status: res.status, json: await res.json().catch(() => null) };
        };

        const r = await deliver(ev('evt_01JZ0000000000000000000E03', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX3', subject: A }));
        assert.deepStrictEqual([r.status, r.json.outcome], [200, 'exported']);
        const part = stub.calls.find((c) => c.url === '/internal/account-exports/exp_01JZ0000000000000000000EX3/parts');
        const files = Object.fromEntries(part.body.files.map((f) => [f.name, f.content]));
        const cred = files['provider-credentials.json'].find((c) => c.owner === 'self');
        assert.deepStrictEqual([cred.provider, cred.key_hint, cred.status, cred.models_count, cred.checked_at], ['anthropic', '…LEAK', 'ok', 3, '2026-10-31T09:00:00.000Z']);
        assert.ok(!('key_enc' in cred) && !JSON.stringify(part.body).includes(SECRET_KEY), 'the key is never exported');
        assert.strictEqual(files['ai-preferences.json'][0].preferences.includes('only_my_keys'), true, 'the preferences export');

        const d = await deliver(ev('evt_01JZ0000000000000000000D03', 'network.account.deleted', { deletion_id: 'del_01JZ0000000000000000000DX3', subject: A, aliases: [] }));
        assert.deepStrictEqual([d.status, d.json.outcome], [200, 'erased']);
        assert.strictEqual(Number(await h.db.value("SELECT count(*)::int FROM subject_credentials WHERE owner = 'self' AND subject = $1", [A])), 0, 'the self key is erased');
        assert.strictEqual(Number(await h.db.value('SELECT count(*)::int FROM ai_person_preferences WHERE subject = $1', [A])), 0, 'the preferences are erased');
    } finally { await h.stop(); await stub.close(); }
});

t.run();
