'use strict';
// D11: a secret stored while no KEK was configured is resealed as an envelope at the next boot with OV_CONFIG_KEKS,
// and stays readable (the store's reseal() runs once at boot).
const assert = require('assert');
const crypto = require('crypto');
const { boot, request, token, suite, tmpDir } = require('./helpers');

const t = suite('config-reseal');
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const KEK = crypto.randomBytes(32).toString('base64');
const KEK_ENV = { OV_CONFIG_KEKS: `k1:${KEK}`, OV_CONFIG_KEK_CURRENT: 'k1' };
const SECRET = 'made-up-config-key-THIS-MUST-NEVER-BE-SHOWN-7f3a9c2e1b';
const cfgTok = token('network', ['ai.config.manage', 'ai.provider.manage']);
const cfgReq = (h, method, path, { body } = {}) => request(h.base, method, path, { tok: cfgTok, body, headers: { 'X-OV-Subject': OWNER, 'X-OV-Fresh': '1' } });

t.test('a plaintext row from a no-KEK boot is resealed at the next boot with a KEK', async () => {
    const dir = tmpDir();
    const first = await boot({ dir, env: { AI_USER_MODULES: 'off' } });
    try {
        await first.registry.upsertProvider({ key: 'resealprov', display_name: 'Reseal', kind: 'http', status: 'active', base_url: 'https://reseal.example/v1', auth_mode: 'bearer', secret_ref: 'vault:resealprov', capabilities: ['chat'], timeout_ms: 5000 });
        const summary = await cfgReq(first, 'GET', '/internal/config');
        assert.strictEqual(summary.status, 200, summary.text);
        assert.strictEqual(summary.body.namespaces.find((n) => n.namespace === 'ai.provider_keys').sealed, false, 'no KEK: the store still works and says so');
        const put = await cfgReq(first, 'PUT', '/internal/config/ai.provider_keys/secrets/resealprov.key', { body: { value: SECRET, reason: 'unsealed' } });
        assert.strictEqual(put.status, 200, put.text);
        assert.strictEqual(first.settings.providerKeys.store.get('resealprov.key'), SECRET);
        const row = await first.db.prepare("SELECT values_json FROM config_snapshots WHERE namespace = 'ai.provider_keys' AND state = 'active'").get();
        assert.strictEqual(JSON.parse(row.values_json)['resealprov.key'], SECRET, 'no KEK: the store keeps the value as it is');
    } finally {
        await first.stop();
    }
    const second = await boot({ dir, env: { ...KEK_ENV, AI_USER_MODULES: 'off' } });
    try {
        assert.strictEqual(second.settings.providerKeys.store.get('resealprov.key'), SECRET, 'reseal kept the value readable');
        const row = await second.db.prepare("SELECT values_json FROM config_snapshots WHERE namespace = 'ai.provider_keys' AND state = 'active'").get();
        assert.match(JSON.parse(row.values_json)['resealprov.key'], /^v1:k1:/, 'reseal made it an envelope');
        assert.ok(!row.values_json.includes(SECRET));
        assert.strictEqual((await second.settings.providerKeys.store.summary()).sealed, true);
    } finally {
        await second.stop();
    }
});

(async () => {
    await t.run();
})().catch((err) => { console.error(err); process.exit(1); });
