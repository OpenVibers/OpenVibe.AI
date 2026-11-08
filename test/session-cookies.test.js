'use strict';
const t = require('node:test');
const assert = require('node:assert/strict');
const { READERS, createSessionCookies } = require('../server/session-cookies');

t.test('session-cookie readers are fixed GET endpoints with exact provider hosts', () => {
    for (const [provider, readers] of Object.entries(READERS)) for (const reader of readers) {
        assert.equal(reader.method, 'GET');
        assert.equal(new URL(reader.path({ org_id: 'org-test' }), `https://${reader.host}`).hostname, reader.host);
        assert.ok(['console.anthropic.com', 'api.openai.com'].includes(reader.host));
    }
});

t.test('a rejected cookie reader response falls back without exposing cookie material', async () => {
    const updates = [];
    const row = { id: '1', owner: 'self', subject: 'usr_01ARZ3NDEKTSV4RRFFQ69G5FAV', provider: 'openai', label: 'session', secret_enc: '', created_at: new Date(0).toISOString(), settings_json: '{}', expired: 0, notified_expired: 0 };
    const db = { prepare(sql) { return { get: async () => row, run: async (...args) => { updates.push([sql, args]); if (sql.startsWith('INSERT INTO session_credentials')) { row.secret_enc = args[4]; row.created_at = args[5]; } return { changes: 1 }; }, all: async () => [] }; } };
    const api = createSessionCookies({ db, config: { credentialsKey: 'a'.repeat(64) }, clock: { now: () => 10 }, fetchImpl: async (url, init) => { assert.equal(url.hostname, 'api.openai.com'); assert.equal(url.pathname, '/dashboard/billing/credit_grants'); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.ok(init.headers.Authorization.startsWith('Bearer sess-')); return { status: 403, ok: false }; } });
    // Seed using add, then return the inserted row to the balance reader.
    await api.add('self', row.subject, { provider: 'openai', cookie: 'sess-secret-value-long-enough' });
    const balance = await api.balance('self', row.subject, '1');
    assert.equal(balance.source, 'estimate');
    assert.equal(JSON.stringify(balance).includes('sess-secret'), false);
    assert.equal(updates.length, 2);
});

t.test('an Anthropic organization id must be a UUID, so nothing else reaches a reader path', async () => {
    let wrote = false;
    const db = { prepare() { return { get: async () => null, run: async () => { wrote = true; return { changes: 1 }; } }; } };
    const api = createSessionCookies({ db, config: { credentialsKey: 'a'.repeat(64) }, clock: { now: () => 10 }, fetchImpl: async () => { throw new Error('no fetch expected'); } });
    const subject = 'usr_01ARZ3NDEKTSV4RRFFQ69G5FAV';
    for (const org_id of ['..', '../../v1/x', 'org-test', '']) {
        await assert.rejects(api.add('self', subject, { provider: 'anthropic', cookie: 'sk-ant-sid01-long-enough-value', org_id }), /org_id/);
    }
    assert.equal(wrote, false, 'a refused org id is never stored');
});
