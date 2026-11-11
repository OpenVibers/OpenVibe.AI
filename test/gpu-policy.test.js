'use strict';

const assert = require('assert');
const express = require('express');
const { createServer } = require('http');
const { boot, suite } = require('./helpers');
const { createGpuPolicy } = require('../server/gpu/policy');
const { GPU_SCHEMA } = require('../server/settings');
const { consoleDataRouter } = require('../server/api/console-data');

const t = suite('gpu-policy');
const owner = 'usr_' + 'A'.repeat(26);

t.test('owner policy saves every changed field with an old and new audit value and keeps keys sealed', async () => {
    const h = await boot();
    try {
        const policy = createGpuPolicy({ db: h.db, settings: h.settings, clock: { now: () => Date.parse('2026-11-11T12:00:00Z') } });
        const first = await policy.read();
        assert.ok(GPU_SCHEMA.properties['salad.key'] && GPU_SCHEMA.properties['thunder.key'], 'new provider keys use the sealed config schema');
        assert.strictEqual(first.global.quote_only, true);
        assert.strictEqual(first.providers.find(p => p.key === 'salad').max_replicas, 3);
        assert.strictEqual(first.providers.find(p => p.key === 'vast').enabled, false);
        await policy.save('global', { monthly_cap_nano: '50000000000', interactive_cap_nano: '20000000000', batch_cap_nano: '30000000000' }, owner);
        await policy.save('global', { quote_only: false }, owner);
        assert.strictEqual(h.settings.gpus.values().dry_run, false);
        await policy.save('vast', { enabled: true, order: 3, classes: ['batch'], interruptible_allowed: true,
            max_hourly_nano: '500000000', max_replicas: 2, regions: ['US'], monthly_cap_share_percent: 40 }, owner);
        const marker = await policy.setKey('vast', 'test-provider-key-4321', owner);
        assert.strictEqual(marker.last_four, '4321');
        const after = await policy.read();
        assert.strictEqual(after.global.monthly_cap_nano, '50000000000');
        assert.strictEqual(after.providers.find(p => p.key === 'vast').key_state.last_four, '4321');
        assert.strictEqual(JSON.stringify(after).includes('test-provider-key-4321'), false);
        const rows = await h.db.prepare("SELECT actor,at,metadata FROM audit_log WHERE action = 'gpu.policy.change' ORDER BY id").all();
        assert.ok(rows.length >= 12);
        assert.ok(rows.every(r => r.actor === owner && r.at === '2026-11-11T12:00:00.000Z'));
        assert.ok(rows.some(r => JSON.parse(r.metadata).setting === 'vast.order' && JSON.parse(r.metadata).old === 50 && JSON.parse(r.metadata).new === 3));
        assert.strictEqual(JSON.stringify(rows).includes('test-provider-key-4321'), false);
        await assert.rejects(() => policy.save('salad', { classes: ['interactive'] }, owner), /batch only/);
    } finally { await h.stop(); }
});

t.test('AI rejects non-owner roles and other service principals', async () => {
    const app = express();
    const auth = { requireCap: () => (req, _res, next) => { req.principal = { sub: req.get('x-test-service') || 'svc:exchange' }; req.ov = { traceId: 'test' }; next(); } };
    app.use(consoleDataRouter({ db: {}, registry: {}, pool: {}, quotas: {}, cache: {}, runs: {}, ops: {}, auth }));
    const server = createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        for (const role of ['admin', 'global_mod', 'user', '']) {
            const res = await fetch(base + '/api/v1/admin/console/gpu-policy/vast', { method: 'POST', headers: {
                'content-type': 'application/json', 'x-ov-subject': owner, 'x-ov-role': role,
            }, body: JSON.stringify({ enabled: true }) });
            assert.strictEqual(res.status, 403, role);
        }
        const other = await fetch(base + '/api/v1/admin/console/gpu-policy/vast', { method: 'POST', headers: {
            'content-type': 'application/json', 'x-ov-subject': owner, 'x-ov-role': 'owner', 'x-test-service': 'svc:other',
        }, body: JSON.stringify({ enabled: true }) });
        assert.strictEqual(other.status, 403);
    } finally { await new Promise(resolve => server.close(resolve)); }
});

t.run();
