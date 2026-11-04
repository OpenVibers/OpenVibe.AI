'use strict';
// D11: the one-time, idempotent vault (provider_secrets) -> ai.provider_keys migration. AI_CREDENTIALS_KEY and
// OV_CONFIG_KEKS are both set; every row is opened, sealed as <provider>.key bound to its origin, read back, and only
// then deleted. An env:NAME key is left alone. Logs carry counts only.
const assert = require('assert');
const crypto = require('crypto');
const { boot, request, token, suite, tmpDir } = require('./helpers');

const t = suite('config-migration');
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const KEK = crypto.randomBytes(32).toString('base64');
const VAULT_KEY = crypto.randomBytes(32).toString('hex');
const PLAIN = 'made-up-migrated-key-9c1d3e5f';
const ENV_KEY_VALUE = 'env-sourced-provider-key-4a6b8c0d';
const KEK_ENV = { OV_CONFIG_KEKS: `k1:${KEK}`, OV_CONFIG_KEK_CURRENT: 'k1' };
const cfgTok = token('network', ['ai.config.manage', 'ai.provider.manage']);
const logs = [];
const capture = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
const cfgReq = (h, method, path, { body } = {}) => request(h.base, method, path, { tok: cfgTok, body, headers: { 'X-OV-Subject': OWNER, 'X-OV-Fresh': '1' } });

t.test('vault rows migrate once, sealed and bound to the origin; env-sourced keys are untouched', async () => {
    const dir = tmpDir();
    let first = await boot({ dir, env: { AI_CREDENTIALS_KEY: VAULT_KEY, CONFIG_TEST_KEY: ENV_KEY_VALUE, AI_USER_MODULES: 'off' } });
    try {
        await first.registry.upsertProvider({ key: 'oldprov', display_name: 'Old vault provider', kind: 'http', status: 'active', base_url: 'https://old.example/v1', auth_mode: 'bearer', secret_ref: 'vault:oldprov', capabilities: ['chat'], timeout_ms: 5000 });
        await first.registry.upsertProvider({ key: 'envprov', display_name: 'Env provider', kind: 'http', status: 'active', base_url: 'https://env.example/v1', auth_mode: 'bearer', secret_ref: 'env:CONFIG_TEST_KEY', capabilities: ['chat'], timeout_ms: 5000 });
        const vault = require('../server/vault');
        await first.db.prepare('INSERT INTO provider_secrets (provider_key, sealed, hint, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('oldprov', vault._seal(first.config, PLAIN, 'oldprov'), `…${PLAIN.slice(-4)}`, 'usr:owner', new Date().toISOString());
    } finally {
        await first.stop();
    }
    const env = { ...KEK_ENV, AI_CREDENTIALS_KEY: VAULT_KEY, CONFIG_TEST_KEY: ENV_KEY_VALUE, AI_USER_MODULES: 'off' };
    let second = await boot({ dir, env, log: capture });
    let revision;
    try {
        assert.strictEqual(second.settings.providerKeys.store.get('oldprov.key'), PLAIN, 'the migrated key opens');
        assert.strictEqual(require('../server/util').resolveSecret('vault:oldprov'), PLAIN, 'the pool resolves the migrated key');
        const left = await second.db.prepare('SELECT COUNT(*) AS n FROM provider_secrets').get();
        assert.strictEqual(Number(left.n), 0, 'the vault rows are deleted after the read-back');
        const row = await second.db.prepare("SELECT values_json FROM config_snapshots WHERE namespace = 'ai.provider_keys' AND state = 'active'").get();
        assert.match(JSON.parse(row.values_json)['oldprov.key'], /^v1:k1:/);
        assert.ok(!row.values_json.includes(PLAIN));
        const summary = await cfgReq(second, 'GET', '/internal/config/ai.provider_keys');
        assert.strictEqual(summary.body.secrets['oldprov.key'].bound_to, 'https://old.example');
        assert.strictEqual(second.settings.providerKeys.store.get('envprov.key'), undefined, 'an env: key is not copied into the store');
        assert.strictEqual(require('../server/util').resolveSecret('env:CONFIG_TEST_KEY', second.env), ENV_KEY_VALUE);
        revision = second.settings.providerKeys.store.revision();
        assert.ok(!logs.some((line) => line.includes(PLAIN)), 'the migration logs counts only');
    } finally {
        await second.stop();
    }
    const third = await boot({ dir, env, log: capture });
    try {
        assert.strictEqual(third.settings.providerKeys.store.get('oldprov.key'), PLAIN, 'a restart reads the same sealed key');
        assert.strictEqual(third.settings.providerKeys.store.revision(), revision, 'the second boot writes nothing (idempotent)');
        assert.strictEqual(Number((await third.db.prepare('SELECT COUNT(*) AS n FROM provider_secrets').get()).n), 0);
        assert.strictEqual(require('../server/util').resolveSecret('env:CONFIG_TEST_KEY', third.env), ENV_KEY_VALUE);
    } finally {
        await third.stop();
    }
});

(async () => {
    await t.run();
})().catch((err) => { console.error(err); process.exit(1); });
