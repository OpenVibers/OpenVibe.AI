'use strict';
/**
 * D11 owner settings: ai.exchange and ai.provider_keys on openvibe-shared/config, the /internal/config admin
 * routes behind ai.config.manage, the vault → provider_keys migration, x-bind against a moved provider origin,
 * secrets that are write-only and never appear in a summary/log/error, env pins and both KEK states.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, request, token, suite } = require('./helpers');

const t = suite('config');
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const KEK = crypto.randomBytes(32).toString('base64');
const VAULT_KEY = crypto.randomBytes(32).toString('hex');
const SECRET = 'made-up-config-key-THIS-MUST-NEVER-BE-SHOWN-7f3a9c2e1b';
const SECRET2 = 'made-up-config-key-ROTATED-THIS-MUST-NOT-SHOW-2b4d6f8a';

const KEK_ENV = { OV_CONFIG_KEKS: `k1:${KEK}`, OV_CONFIG_KEK_CURRENT: 'k1' };
const ALL_CAPS = ['ai.config.manage', 'ai.provider.manage', 'ai.usage.read'];
const cfgTok = token('network', ALL_CAPS);
const opsTok = token('network', ['ai.provider.manage']);
const noCap = token('live', ['ai.run.read']);
const headers = (fresh = true, actor = OWNER) => ({
    ...(actor ? { 'X-OV-Subject': actor } : {}),
    ...(fresh ? { 'X-OV-Fresh': '1' } : {}),
});
const cfgReq = (h, method, path, { tok = cfgTok, body, fresh = true, actor = OWNER } = {}) =>
    request(h.base, method, path, { tok, body, headers: headers(fresh, actor) });

let h;
const logs = [];
const capture = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };

t.test('boot with a KEK and the model-catalogue env pin', async () => {
    h = await boot({
        env: { ...KEK_ENV, AI_CREDENTIALS_KEY: VAULT_KEY, AI_MODEL_CATALOG: '1', AI_USER_MODULES: 'off' },
        log: capture,
    });
    assert.strictEqual(h.settings.exchange.sealed, true);
    assert.strictEqual(h.settings.providerKeys.sealed, true);
});

t.test('the summaries carry the schemas and the owner annotations', async () => {
    const r = await cfgReq(h, 'GET', '/internal/config');
    assert.strictEqual(r.status, 200, r.text);
    const ex = r.body.namespaces.find((n) => n.namespace === 'ai.exchange');
    assert.strictEqual(ex.schema.properties.credits['x-env'], 'AI_CREDITS');
    assert.strictEqual(ex.schema.properties.credits['x-danger'], true);
    assert.strictEqual(ex.schema.properties.model_catalog['x-env'], 'AI_MODEL_CATALOG');
    assert.strictEqual(ex.schema.properties.alpha['x-env'], 'AI_ROUTING_EVIDENCE_ALPHA');
    assert.deepStrictEqual([ex.schema.properties.alpha.minimum, ex.schema.properties.alpha.maximum], [0.01, 1]);
    const keys = r.body.namespaces.find((n) => n.namespace === 'ai.provider_keys');
    assert.strictEqual(keys.schema.properties['shared.origin'].type, 'string');
    assert.strictEqual(keys.schema.properties['shared.key']['x-bind'], 'shared.origin');
});

t.test('a non-capability caller gets 403', async () => {
    const r = await request(h.base, 'GET', '/internal/config', { tok: noCap });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied']);
});

t.test('the env pin wins and a write to it is refused', async () => {
    const r = await cfgReq(h, 'POST', '/internal/config/ai.exchange', { body: { values: { model_catalog: false }, reason: 'pin test' } });
    assert.deepStrictEqual([r.status, r.body.code], [409, 'config.pinned_in_env']);
    assert.strictEqual(h.config.modelCatalog.enabled, true);
});

t.test('a stale x-danger change without X-OV-Fresh gets 403', async () => {
    const r = await cfgReq(h, 'POST', '/internal/config/ai.exchange', { body: { values: { credits: true }, reason: 'stale' }, fresh: false });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'config.fresh_required']);
    assert.strictEqual(h.config.credits.enabled, false, 'nothing turned on');
});

t.test('an owner change applies live and is audited without a value', async () => {
    const r = await cfgReq(h, 'POST', '/internal/config/ai.exchange', { body: { values: { credits: true, routing_evidence: true, alpha: 0.35 }, reason: 'owner change' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(h.config.credits.enabled, true);
    assert.strictEqual(h.credits.enabled, true, 'the Credits facade follows the live flag');
    assert.ok(h.credits.manager, 'the Credits manager is created when the owner turns it on');
    assert.strictEqual(h.config.routingEvidence.enabled, true);
    assert.strictEqual(h.config.routingEvidence.alpha, 0.35);
    assert.ok(h.pool.routingEvidence && h.pool.routingEvidence.enabled(), 'routing evidence follows the live flag');
    const rows = await h.db.prepare("SELECT actor, target_id, metadata FROM audit_log WHERE action = 'config.change' ORDER BY id DESC").all();
    assert.ok(rows.some((row) => row.target_id === 'ai.exchange' && JSON.parse(row.metadata).keys.includes('credits')), 'the change is audited');
    assert.ok(rows.every((row) => !String(row.metadata).includes(SECRET)), 'never a value');
});

t.test('a provider key is write-only, sealed, and never reaches a summary, a log or an error', async () => {
    const created = await request(h.base, 'POST', '/api/v1/providers', {
        tok: opsTok,
        body: {
            key: 'cfgprov', display_name: 'Config provider', kind: 'http', status: 'active', base_url: 'https://cfg.example/v1',
            auth_mode: 'bearer', secret_ref: 'vault:cfgprov', capabilities: ['chat'], timeout_ms: 5000,
        },
    });
    assert.strictEqual(created.status, 201, created.text);
    const put = await cfgReq(h, 'PUT', '/internal/config/ai.provider_keys/secrets/cfgprov.key', { body: { value: SECRET, reason: 'the key' } });
    assert.strictEqual(put.status, 200, put.text);
    assert.strictEqual(put.body.hint, SECRET.slice(-4));
    assert.strictEqual(put.body.bound_to, 'https://cfg.example');
    assert.strictEqual(h.settings.providerKeys.store.get('cfgprov.key'), SECRET);
    assert.strictEqual(require('../server/util').resolveSecret('vault:cfgprov'), SECRET, 'the pool resolves it synchronously');
    const row = await h.db.prepare("SELECT values_json FROM config_snapshots WHERE namespace = 'ai.provider_keys' AND state = 'active'").get();
    assert.match(JSON.parse(row.values_json)['cfgprov.key'], /^v1:k1:/);
    assert.ok(!row.values_json.includes(SECRET), 'values_json holds the envelope, not the key');
    const summary = await cfgReq(h, 'GET', '/internal/config/ai.provider_keys');
    assert.strictEqual(summary.status, 200, summary.text);
    assert.ok(!summary.text.includes(SECRET), 'the summary leaks no key');
    assert.deepStrictEqual(summary.body.secrets['cfgprov.key'].set_by, { type: 'user', id: OWNER });
    const carried = await cfgReq(h, 'POST', '/internal/config/ai.provider_keys', { body: { values: { 'cfgprov.key': SECRET }, reason: 'not here' } });
    assert.deepStrictEqual([carried.status, carried.body.code], [422, 'config.secret_write_only']);
    assert.ok(!carried.text.includes(SECRET), 'the error leaks no key');
    assert.ok(logs.every((line) => !line.includes(SECRET) && !line.includes(SECRET2)), 'no log line leaks a key');
    const history = await cfgReq(h, 'GET', '/internal/config/ai.provider_keys/history');
    assert.strictEqual(history.status, 200);
    assert.ok(!history.text.includes(SECRET), 'the history leaks no key');
});

t.test('x-bind refuses the key after a base_url change, and entering it again binds the new origin', async () => {
    const patched = await request(h.base, 'PATCH', '/api/v1/providers/cfgprov', { tok: opsTok, body: { base_url: 'https://moved.example/v1' } });
    assert.strictEqual(patched.status, 200, patched.text);
    assert.strictEqual(patched.body.key_reentry_required, true);
    assert.match(patched.body.notice, /the key must be entered again for the new origin/);
    assert.strictEqual(h.settings.providerKeys.store.get('cfgprov.key'), undefined, 'the old key no longer opens');
    assert.strictEqual(require('../server/util').resolveSecret('vault:cfgprov'), '', 'the pool gets no key for the new host');
    const locked = await cfgReq(h, 'GET', '/internal/config/ai.provider_keys');
    assert.strictEqual(locked.body.secrets['cfgprov.key'].bound_to, 'https://cfg.example', 'the marker names what it was sealed to');
    assert.ok(!locked.text.includes(SECRET), 'the locked summary leaks no key');
    const again = await cfgReq(h, 'PUT', '/internal/config/ai.provider_keys/secrets/cfgprov.key', { body: { value: SECRET2, reason: 'for the new host' } });
    assert.strictEqual(again.status, 200, again.text);
    assert.strictEqual(again.body.bound_to, 'https://moved.example');
    assert.strictEqual(h.settings.providerKeys.store.get('cfgprov.key'), SECRET2);
});

(async () => {
    await t.run();
})().catch((err) => { console.error(err); process.exit(1); });
