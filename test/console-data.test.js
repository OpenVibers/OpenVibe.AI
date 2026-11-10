'use strict';

const assert = require('assert');
const express = require('express');
const { createServer } = require('http');
const { consoleDataRouter } = require('../server/api/console-data');

const secret = 'sk-console-secret-not-in-json';
const saved = [];
const audit = [];
const app = express();
const auth = { requireCap: () => (req, _res, next) => { req.principal = { sub: 'svc:exchange' }; req.ov = { traceId: 'trace-test' }; next(); } };
app.use(consoleDataRouter({
    db: {}, registry: {
        async listProviders() { return [{ key: 'openai', secret_ref: 'vault:openai' }]; },
        async listModels() { return []; },
        async getProvider(key) { return key === 'openai' ? { key, base_url: 'https://api.openai.com/v1' } : null; },
        async upsertProvider(provider) { return provider; }, async audit(...args) { audit.push(args); },
    }, pool: {}, quotas: {}, cache: {}, runs: {}, auth,
        ops: { async providerView(p) { return { key: p.key, credentials: 'configured', secret_ref: p.secret_ref }; } },
    vault: { async put(key, value) { saved.push([key, value]); } },
    settings: { providerKeys: { async setOrigin() {} } },
    fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
}));

(async () => {
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const read = await fetch(`${base}/api/v1/admin/console/providers`);
        const body = await read.text();
        assert.strictEqual(read.status, 200);
        assert.ok(!body.includes(secret));
        const providerData = JSON.parse(body);
        assert.strictEqual(providerData.presets.length, require('../server/providers/pool-providers').PROVIDERS.length);
        assert.strictEqual(providerData.providers[0].key_present, true);
        const added = providerData.presets.filter((p) => ['venice', 'abliteratedmodels', 'uplinkswitch', 'chutes', 'siliconflow', 'nebius', 'together', 'fireworks', 'groq', 'cerebras', 'sambanova', 'baseten', 'hyperbolic'].includes(p.key));
        assert.ok(added.filter((p) => p.key !== 'together').every((p) => p.provider_access === 'UNVERIFIED'));
        assert.strictEqual(providerData.presets.find((p) => p.key === 'together').provider_access, 'RESTRICTED');
        const models = await fetch(`${base}/api/v1/admin/console/models`);
        assert.deepStrictEqual(await models.json(), { models: [], provider: null, sync_log: [] });
        const book = await fetch(`${base}/api/v1/admin/console/pricebook`);
        assert.ok(Array.isArray((await book.json()).pending));
        const write = await fetch(`${base}/api/v1/admin/console/providers/openai/key`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: secret }),
        });
        const answer = await write.text();
        assert.strictEqual(write.status, 200, answer);
        assert.ok(!answer.includes(secret));
        assert.deepStrictEqual(saved, [['openai', secret]]);
        assert.strictEqual(audit[0][1], 'provider.key_replaced');
        const created = await fetch(`${base}/api/v1/admin/console/providers`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ preset: 'custom', key: 'custom-ai', base_url: 'https://api.example.test/v1', api_key: secret }),
        });
        const createdText = await created.text();
        assert.strictEqual(created.status, 200, createdText);
        assert.ok(!createdText.includes(secret));
        assert.deepStrictEqual(saved[1], ['custom-ai', secret]);
    } finally { await new Promise((resolve) => server.close(resolve)); }
    process.stdout.write('console-data: metadata reads and secret-safe key writes passed\n');
})().catch((err) => { process.stderr.write(`${err.stack || err}\n`); process.exitCode = 1; });
