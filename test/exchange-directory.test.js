'use strict';
const assert = require('node:assert/strict');
const { directoryModels } = require('../server/exchange/directory');
const { boot, request, suite } = require('./helpers');

const t = suite('exchange-directory');
t.test('public model directory includes listed, preview and retired rows without provider credentials', async () => {
    const provider = { key: 'gemini', display_name: 'Google', kind: 'openai', status: 'active', secret_ref: 'vault:gemini',
        metadata: { models_endpoint: 'https://example.com/models', private_key: 'must-not-appear' } };
    const rows = [
        { provider_key: 'gemini', model_key: 'gemini-live', status: 'disabled', display_name: 'Gemini Live', type: 'chat', context_window: 1000,
            cost: { in_per_mtok: 1, out_per_mtok: 2, source: 'https://generativelanguage.googleapis.com/v1beta/models', verified_at: '2026-11-11' },
            supports: { vision: true, tools: true }, metadata: { listed: true, version: '1' } },
        { provider_key: 'gemini', model_key: 'gemini-preview', status: 'disabled', type: 'chat', supports: {}, metadata: { listed: true } },
        { provider_key: 'gemini', model_key: 'gemini-old', status: 'disabled', type: 'chat', supports: {}, metadata: { listed: false, missing_since: '2026-11-10T00:00:00Z' } },
    ];
    const out = await directoryModels({ listProviders: async () => [provider], listModels: async () => rows });
    assert.deepEqual(out.models.map(m => m.status), ['available', 'preview', 'retired']);
    assert.equal(out.models[0].routing_enabled, false);
    assert.equal(out.models[0].price.source, 'https://generativelanguage.googleapis.com/v1beta/models');
    assert.equal(out.models[2].retired_at, '2026-11-10T00:00:00Z');
    assert.ok(!JSON.stringify(out).includes('must-not-appear'));
    assert.ok(!JSON.stringify(out).includes('secret_ref'));
});
t.test('the complete registry reader is public', async () => {
    const h = await boot({ env: { AI_USER_MODULES: 'off' } });
    try {
        const r = await request(h.base, 'GET', '/api/v1/exchange/directory');
        assert.equal(r.status, 200, r.text);
        assert.ok(Array.isArray(r.body.models));
        assert.ok(!r.text.includes('secret_ref'));
    } finally { await h.close(); }
});
