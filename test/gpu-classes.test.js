'use strict';
/**
 * GPU job classes (2026-11-11): a job is interactive or batch, interruptible capacity needs a batch
 * job with a checkpoint, and the choice is class, then cost, then the owner's provider order.
 * The offers here are synthetic; the marketplace is the recorded fake, so no test reaches the network.
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');
const { createGpuFetch } = require('./fixtures/gpu-fetch');
const { classOf, checkpointOf, pickOffer } = require('../server/gpu/classes');
const { createGpuPolicy } = require('../server/gpu/policy');

const T0 = Date.parse('2026-11-06T12:00:00Z');
const OWNER = 'usr_' + 'A'.repeat(26);
const offer = (marketplace, id, price, extra = {}) => ({ marketplace, id: String(id), price_per_hour: String(price), gpu_ram_mb: 24576, num_gpus: 1, disk_gb: 100, reliability: 0.99, region: 'US', ...extra });
const policy = (extra = {}) => ({ enabled: true, configured: true, order: 50, classes: ['interactive', 'batch'], interruptible_allowed: false, max_hourly_nano: null, max_replicas: 10, regions: [], monthly_cap_share_percent: 100, ...extra });

async function settings(h, { cap = '50000000000' } = {}) {
    const store = h.settings.gpus.store;
    await store.apply({ monthly_cap: Number(cap), costs_bounded: true, extra_hourly_nano: 0 }, { merge: true, actor: { type: 'user', id: OWNER }, reason: 'the test' });
    await store.setSecret('vast.key', 'vast-test-key', { actor: { type: 'user', id: OWNER }, reason: 'the test' });
}

const t = suite('gpu-classes');

t.test('a class is interactive or batch; a checkpoint is a bounded printable reference', () => {
    assert.strictEqual(classOf(undefined), 'interactive');
    assert.strictEqual(classOf('BATCH'), 'batch');
    assert.throws(() => classOf('interruptible'), /interactive or batch/);
    assert.strictEqual(checkpointOf(null), null);
    assert.strictEqual(checkpointOf('  s3://bucket/job-1/ckpt  '), 's3://bucket/job-1/ckpt');
    assert.throws(() => checkpointOf('x'), /3-500/);
    assert.throws(() => checkpointOf('a\nb'), /printable/);
});

t.test('the picker filters by class and interruptible rule, then costs, then the owner order', () => {
    const offers = [offer('vast', 'a', 0.30, { interruptible: true }), offer('runpod', 'b', 0.20), offer('shadeform', 'c', 0.10)];
    const policies = { vast: policy({ order: 1, interruptible_allowed: true }), runpod: policy({ order: 9 }), shadeform: policy({ order: 30 }) };
    // Batch without a checkpoint: the interruptible Vast offer is out; the cheapest on-demand wins.
    let picked = pickOffer(offers, { policies, jobClass: 'batch', checkpoint: null });
    assert.strictEqual(picked.selected.id, 'c');
    assert.ok(picked.reasons.some((r) => /interruptible capacity needs a checkpoint/.test(r)), picked.reasons.join('; '));
    // Batch with a checkpoint: the Vast bid is allowed and still not cheapest, so cost still wins.
    picked = pickOffer(offers, { policies, jobClass: 'batch', checkpoint: 's3://bucket/ckpt' });
    assert.strictEqual(picked.selected.id, 'c');
    // Equal price: the owner's order breaks the tie, then the id.
    const tied = offer('runpod', 'b', 0.10);
    const tied2 = offer('shadeform', 'c', 0.10);
    picked = pickOffer([tied2, tied], { policies, jobClass: 'batch', checkpoint: 's3://x/y' });
    assert.strictEqual(picked.selected.marketplace, 'runpod');
    // Interactive never takes interruptible capacity.
    picked = pickOffer([offer('vast', 'a', 0.01, { interruptible: true }), offer('runpod', 'b', 0.20)], { policies, jobClass: 'interactive' });
    assert.strictEqual(picked.selected.id, 'b');
    // A provider the owner disabled is out, and a provider that serves only interactive is out of batch.
    picked = pickOffer(offers, { policies: { ...policies, shadeform: policy({ enabled: false }), runpod: policy({ classes: ['interactive'] }) }, jobClass: 'batch', checkpoint: 's3://x/y' });
    assert.strictEqual(picked.selected.id, 'a');
});

t.test('a launch records its class and checkpoint, and a batch cap refuses before renting', async () => {
    const api = createGpuFetch();
    const h = await boot({ clock: { now: () => T0 }, fetchImpl: api.fetchImpl });
    try {
        await settings(h);
        const p = createGpuPolicy({ db: h.db, settings: h.settings, clock: { now: () => T0 } });
        await p.save('global', { monthly_cap_nano: '50000000000' }, OWNER);
        await p.save('vast', { enabled: true, classes: ['batch'], interruptible_allowed: true, max_replicas: 5 }, OWNER);
        const res = await h.gpus.launch('deepseek-r1-32b', { jobClass: 'batch', checkpoint: 's3://bucket/job-1/ckpt' });
        assert.ok(res.ok, res.reason);
        const row = await h.db.prepare('SELECT job_class, checkpoint, interruptible FROM gpu_instances WHERE id = ?').get(res.instance.id);
        assert.strictEqual(row.job_class, 'batch');
        assert.strictEqual(row.checkpoint, 's3://bucket/job-1/ckpt');
        assert.strictEqual(row.interruptible, false, 'the recorded on-demand offer is not interruptible');
        assert.strictEqual((await h.gpus.state()).instances[0].job_class, 'batch');
        const audit = await h.db.prepare("SELECT metadata FROM audit_log WHERE action = 'gpu.placement' ORDER BY id DESC LIMIT 1").get();
        assert.strictEqual(JSON.parse(audit.metadata).job_class, 'batch');
        assert.strictEqual(api.calls.create.length, 1);
    } finally { await h.stop(); }
});

t.test('the interactive and batch class caps are enforced on the reservation', async () => {
    const api = createGpuFetch();
    const h = await boot({ clock: { now: () => T0 }, fetchImpl: api.fetchImpl });
    try {
        await settings(h);
        const p = createGpuPolicy({ db: h.db, settings: h.settings, clock: { now: () => T0 } });
        await p.save('global', { interactive_cap_nano: '50000000000', batch_cap_nano: '10000000' }, OWNER);
        await p.save('vast', { enabled: true, classes: ['interactive', 'batch'] }, OWNER);
        const batch = await h.gpus.launch('deepseek-r1-32b', { jobClass: 'batch', checkpoint: 's3://bucket/ckpt' });
        assert.strictEqual(batch.ok, false);
        assert.strictEqual(batch.code, 'gpu.class_cap');
        assert.strictEqual(api.calls.create.length, 0);
        // The interactive cap is large enough for the same offer.
        const interactive = await h.gpus.launch('deepseek-r1-32b', { jobClass: 'interactive' });
        assert.ok(interactive.ok, interactive.reason);
    } finally { await h.stop(); }
});

t.test('the owner’s provider share of the monthly cap is enforced', async () => {
    const api = createGpuFetch();
    const h = await boot({ clock: { now: () => T0 }, fetchImpl: api.fetchImpl });
    try {
        await settings(h);
        const p = createGpuPolicy({ db: h.db, settings: h.settings, clock: { now: () => T0 } });
        await p.save('global', { monthly_cap_nano: '50000000000' }, OWNER);
        await p.save('vast', { enabled: true, monthly_cap_share_percent: 0 }, OWNER);
        const res = await h.gpus.launch('deepseek-r1-32b', { jobClass: 'interactive' });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.code, 'gpu.provider_cap');
        assert.strictEqual(api.calls.create.length, 0);
    } finally { await h.stop(); }
});

t.test('a request keeps the class and checkpoint for the reconciler', async () => {
    const h = await boot({ clock: { now: () => T0 }, fetchImpl: createGpuFetch().fetchImpl });
    try {
        await h.gpus.request('deepseek-r1-32b', 'launch', OWNER, { jobClass: 'batch', checkpoint: 's3://bucket/ckpt' });
        const row = await h.db.prepare("SELECT job_class, checkpoint FROM gpu_requests WHERE model_key = 'deepseek-r1-32b' ORDER BY id DESC LIMIT 1").get();
        assert.strictEqual(row.job_class, 'batch');
        assert.strictEqual(row.checkpoint, 's3://bucket/ckpt');
        await assert.rejects(() => h.gpus.request('deepseek-r1-32b', 'launch', OWNER, { jobClass: 'soon' }), /interactive or batch/);
    } finally { await h.stop(); }
});

t.run();
