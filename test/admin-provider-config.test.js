'use strict';

const assert = require('assert');
const express = require('express');
const { createServer } = require('http');
const { adminRouter } = require('../server/api/admin');

const state = {
    provider: { key: 'venice', kind: 'openai', status: 'active', base_url: 'https://api.venice.ai/api/v1', metadata: {}, priority: 40, provider_access: 'UNVERIFIED' },
    model: { provider_key: 'venice', model_key: 'venice-uncensored-1-2', status: 'active', cost: { in_per_mtok: 0.2, out_per_mtok: 0.9 }, metadata: {} },
    audit: [],
};
const registry = {
    async getProvider(key) { return key === state.provider.key ? state.provider : null; },
    async upsertProvider(row, options) { state.provider = { ...state.provider, ...row }; state.audit.push(['provider', row, options]); return state.provider; },
    async getModel(provider, model) { return provider === state.model.provider_key && model === state.model.model_key ? state.model : null; },
    async upsertModel(row, actor) { state.model = { ...state.model, ...row }; state.audit.push(['model', row, actor]); return state.model; },
};
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.principal = { sub: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPX' }; req.ov = { traceId: 'trace-config-test' }; next(); });
const auth = { requireCap: () => (_req, _res, next) => next() };
app.use(adminRouter({ config: {}, db: {}, registry, pool: { stats: {} }, quotas: {}, cache: {}, runs: {}, auth,
    ops: { async providerView(provider) { return provider; } } }));

(async () => {
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        let response = await fetch(`${base}/api/v1/providers/venice`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'disabled', provider_access: 'AUTHORIZED_WHOLESALE', priority: 8, markup_percent: 15, uncensored: true }) });
        assert.strictEqual(response.status, 200, await response.text());
        assert.strictEqual(state.provider.status, 'disabled');
        assert.strictEqual(state.provider.provider_access, 'AUTHORIZED_WHOLESALE');
        assert.strictEqual(state.provider.priority, 8);
        assert.strictEqual(state.provider.metadata.markup_percent, 15);
        assert.strictEqual(state.provider.metadata.uncensored, true);
        assert.strictEqual(state.audit[0][0], 'provider');

        response = await fetch(`${base}/api/v1/models/venice/venice-uncensored-1-2`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ owner_override: { cost: { in_per_mtok: 0.25 }, reason: 'Owner verified negotiated price' } }) });
        assert.strictEqual(response.status, 200, await response.text());
        assert.strictEqual(state.model.cost.in_per_mtok, 0.2, 'base accepted price stays intact');
        assert.strictEqual(state.model.metadata.owner_override.cost.in_per_mtok, 0.25);
        assert.strictEqual(state.model.metadata.owner_override.reason, 'Owner verified negotiated price');
        assert.strictEqual(state.audit[1][0], 'model');

        response = await fetch(`${base}/api/v1/providers/venice`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ markup_percent: 501 }) });
        assert.strictEqual(response.status, 422);
    } finally { await new Promise((resolve) => server.close(resolve)); }
    process.stdout.write('admin-provider-config: audited provider pricing controls passed\n');
})().catch((err) => { process.stderr.write(`${err.stack || err}\n`); process.exitCode = 1; });
