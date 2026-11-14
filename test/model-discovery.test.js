'use strict';
const assert = require('node:assert/strict');
const { boot, request, token, suite } = require('./helpers');
const { createModelDiscovery, findings } = require('../server/providers/model-discovery');
const t = suite('model-discovery');
const owner = token('exchange', ['ai.provider.manage', 'ai.usage.read']);
const denied = token('chat', ['ai.run.read']);
let h;
t.test('official source adapters extract exact model ids without treating them as available', () => {
    const at = '2026-11-11T00:00:00Z';
    assert.deepEqual(findings({ provider: 'gemini', kind: 'text', url: 'https://example.com' }, 'Gemini gemini-3.5-flash and gemini-3.5-flash', at).map(x => x.model), ['gemini-3.5-flash']);
    assert.deepEqual(findings({ provider: 'openrouter', kind: 'openrouter' }, JSON.stringify({ data: [{ id: 'google/gemini-4', created: 1794355200 }] }), at).map(x => x.id), ['openrouter/google/gemini-4']);
    assert.deepEqual(findings({ provider: 'huggingface', kind: 'huggingface' }, JSON.stringify([{ id: 'google/gemma-4', createdAt: at }]), at).map(x => x.id), ['huggingface/google/gemma-4']);
});

t.test('the hourly refresh dedupes sightings, keeps sources and never adds a routable model', async () => {
    h = await boot({ env: { AI_USER_MODULES: 'off' } });
    const sources = [{ id: 'official', provider: 'gemini', kind: 'text', url: 'https://example.com/notes' },
        { id: 'sdk', provider: 'gemini', kind: 'text', url: 'https://example.com/sdk' }];
    let now = Date.parse('2026-11-11T00:00:00Z');
    const discovery = createModelDiscovery({ db: h.db, registry: h.registry, sources, clock: { now: () => now },
        fetchImpl: async () => new Response('gemini-9-pro gemini-9-pro'), log: { warn() {} } });
    const first = await discovery.run();
    assert.equal(first.status, 'succeeded');
    assert.equal(first.spotted, 1);
    assert.equal(first.entries[0].sources.length, 2);
    assert.equal(await h.registry.getModel('gemini', 'gemini-9-pro'), null);
    await discovery.tick();
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM model_discovery_runs').get()).n, 1, 'not again within the hour');
    now += 3_600_001;
    await discovery.tick();
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM model_discovery_runs').get()).n, 2, 'again an hour later (plan §AB.37)');
    now += 86_400_001;
    assert.equal((await discovery.run()).spotted, 0);
    assert.equal((await discovery.list()).length, 1);
    assert.equal(await discovery.setStatus('gemini/gemini-9-pro', 'promoted'), true);
    assert.equal((await discovery.list())[0].promoted, true);
    assert.equal(await discovery.setStatus('gemini/gemini-9-pro', 'dismissed'), true);
    assert.equal((await discovery.list()).length, 0);
});

t.test('public spots and owner promotion are capability gated', async () => {
    const publicRead = await request(h.base, 'GET', '/api/v1/exchange/spotted');
    assert.equal(publicRead.status, 200, publicRead.text);
    const path = '/api/v1/admin/console/model-spots/gemini%2Fgemini-9-pro/status';
    assert.equal((await request(h.base, 'POST', path, { tok: denied, body: { status: 'promoted' } })).status, 403);
    const changed = await request(h.base, 'POST', path, { tok: owner, body: { status: 'promoted' } });
    assert.equal(changed.status, 200, changed.text);
    assert.equal((await request(h.base, 'GET', '/api/v1/exchange/spotted')).body.models[0].promoted, true);
    await h.close();
});

t.run();
