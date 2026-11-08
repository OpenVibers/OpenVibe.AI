'use strict';
/**
 * The GPU provisioner: the cheapest offer that fits the model, the monthly cap it never passes, the
 * idle instance that scales to zero and the instance that dies. The marketplace answers are recorded
 * (test/fixtures/gpu/vast.json) and the clock is a fake one, so no test reaches the network and no
 * test waits for real time.
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');
const { createGpuFetch } = require('./fixtures/gpu-fetch');

const T0 = Date.parse('2026-11-06T12:00:00Z');
const OWNER = { type: 'user', id: 'usr_' + 'A'.repeat(26) };

/** The owner's GPU settings: the marketplace key (a secret) and the monthly cap (money). */
async function settings(h, { key = 'vast-test-key', cap = '50000000000', idle = null, maxRuntime = null } = {}) {
    const store = h.settings.gpus.store;
    const values = { monthly_cap: Number(cap), costs_bounded: true, extra_hourly_nano: 0 };
    if (idle != null) values.idle_minutes = idle;
    if (maxRuntime != null) values.max_runtime_minutes = maxRuntime;
    await store.apply(values, { merge: true, actor: OWNER, reason: 'the test' });
    if (key) await store.setSecret('vast.key', key, { actor: OWNER, reason: 'the test' });
}


/**
 * The row a crash between the marketplace's answer and the row's update leaves behind: the row is
 * there (it was written before the rental) but it does not know the marketplace id yet.
 */
async function crashedRow(h, id, at) {
    const iso = (ms) => new Date(ms).toISOString();
    await h.db.prepare(`INSERT INTO gpu_instances (id, model_key, provider_key, marketplace, offer_id, remote_id, status, endpoint, month,
            gpu_name, gpu_ram_mb, num_gpus, disk_gb, reliability, region, price_per_hour, hourly_nano, reserved_nano, spent_nano,
            max_runtime_minutes, started_at, charged_at, destroy_failures, label, cold_start_ms, health_failures, created_at, updated_at)
        VALUES (?, ?, ?, 'vast', '111', NULL, 'starting', NULL, ?, 'RTX 3090', 24576, 1, 100, 0.998, 'US', '0.1348', '134800000', '134800000', 0,
            720, ?, ?, 0, ?, NULL, 0, ?, ?)`)
        .run(id, 'deepseek-r1-32b', 'gpu.deepseek-r1-32b', '2026-11', iso(at), iso(at), id, iso(at), iso(at));
}

const t = suite('gpu');

t.test('the provisioner is off without a key and without a cap', async () => {
    const api = createGpuFetch();
    let now = T0;
    const h = await boot({ clock: { now: () => now }, fetchImpl: api.fetchImpl });
    try {
        let res = await h.gpus.launch('deepseek-r1-32b');
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.code, 'gpu.off');
        assert.match(res.reason, /API key/);
        assert.strictEqual(api.calls.search, 0);
        // a key, but no cap: still off
        await settings(h, { cap: '0' });
        res = await h.gpus.launch('deepseek-r1-32b');
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.code, 'gpu.off');
        assert.strictEqual(api.calls.create.length, 0);
        const st = await h.gpus.state();
        assert.strictEqual(st.enabled, false);
    } finally { await h.stop(); }
});

t.test('the cheapest offer that fits is rented, registered as an offer and health-checked', async () => {
    const api = createGpuFetch();
    let now = T0;
    const h = await boot({ clock: { now: () => now }, fetchImpl: api.fetchImpl });
    try {
        await settings(h, { cap: '50000000000' });   // $50
        const res = await h.gpus.launch('deepseek-r1-32b');
        assert.ok(res.ok, res.reason);
        // offer 111 (0.1348/h) is the cheapest of the three that fit
        assert.strictEqual(api.calls.create.length, 1);
        assert.ok(api.calls.create[0].url.includes('/asks/111/'), api.calls.create[0].url);
        const st = await h.gpus.state();
        assert.strictEqual(st.instances.length, 1);
        assert.strictEqual(st.instances[0].offer_id, '111');
        assert.strictEqual(st.instances[0].hourly_nano, '134800000');
        assert.strictEqual(st.instances[0].status, 'starting');
        assert.ok(BigInt(st.committed_nano) <= BigInt(st.cap_nano), 'the reservation is inside the cap');

        // the next pass finds the endpoint, checks it and registers the offer for the router
        now += 60_000;
        await h.gpus.tick();
        assert.ok(api.calls.health >= 1, 'the endpoint was health-checked');
        const provider = await h.registry.getProvider('gpu.deepseek-r1-32b');
        assert.ok(provider, 'the offer is registered');
        assert.strictEqual(provider.status, 'active');
        assert.strictEqual(provider.base_url, 'https://gw.vast.ai:12345/v1');
        assert.strictEqual(provider.provider_access, 'OWN_DEPLOYMENT');
        const model = await h.registry.getModel('gpu.deepseek-r1-32b', 'deepseek-r1-32b');
        assert.ok(model, 'the model is registered');
        assert.ok(model.cost.out_per_mtok > 0, 'the offer is priced');
    } finally { await h.stop(); }
});

t.test('the monthly cap is never passed: the launch is refused and says why', async () => {
    const api = createGpuFetch();
    let now = T0;
    const h = await boot({ clock: { now: () => now }, fetchImpl: api.fetchImpl });
    try {
        await settings(h, { cap: '1000000' });   // $0.001: less than an hour of a 0.1348/h GPU
        const res = await h.gpus.launch('deepseek-r1-32b');
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.code, 'gpu.cap');
        assert.match(res.reason, /cap/);
        assert.strictEqual(api.calls.create.length, 0, 'nothing was rented');
        const st = await h.gpus.state();
        assert.strictEqual(st.instances.length, 0);
        assert.strictEqual(st.spent_nano, '0');
    } finally { await h.stop(); }
});

t.test('an idle instance scales to zero and the money is settled', async () => {
    const api = createGpuFetch();
    let now = T0;
    const h = await boot({ clock: { now: () => now }, fetchImpl: api.fetchImpl });
    try {
        await settings(h, { cap: '50000000000', idle: 1 });
        await h.gpus.launch('deepseek-r1-32b');
        now += 60_000;
        await h.gpus.tick();     // the instance comes up
        assert.strictEqual((await h.gpus.state()).instances[0].status, 'running');
        now += 90_000;           // it has served nobody for more than an idle minute
        await h.gpus.tick();
        assert.strictEqual(api.calls.destroy.length, 1, 'the instance was given back');
        const st = await h.gpus.state();
        assert.strictEqual(st.instances[0].status, 'destroyed');
        assert.ok(BigInt(st.spent_nano) > 0n, 'the money it cost is on the ledger');
        assert.ok(BigInt(st.committed_nano) <= BigInt(st.cap_nano), 'the money is inside the cap');
        const provider = await h.registry.getProvider('gpu.deepseek-r1-32b');
        assert.strictEqual(provider.status, 'disabled', 'the offer leaves the pool');
    } finally { await h.stop(); }
});

t.test('an instance that dies is replaced and the router gets the new endpoint', async () => {
    const api = createGpuFetch();
    let now = T0;
    const h = await boot({ clock: { now: () => now }, fetchImpl: api.fetchImpl });
    try {
        await settings(h, { cap: '50000000000' });
        await h.gpus.launch('deepseek-r1-32b');
        now += 60_000;
        await h.gpus.tick();
        assert.strictEqual((await h.gpus.state()).instances[0].status, 'running');

        api.dead = true;         // the endpoint stops answering
        now += 60_000;
        await h.gpus.tick();     // the first failed check
        now += 60_000;
        await h.gpus.tick();     // the second: the instance is dead
        assert.strictEqual(api.calls.destroy.length, 1, 'the dead instance was given back');
        assert.strictEqual((await h.registry.getProvider('gpu.deepseek-r1-32b')).status, 'disabled');

        now += 60_000;
        await h.gpus.tick();     // a new instance is rented
        assert.strictEqual(api.calls.create.length, 2, 'a second instance was rented');
        now += 60_000;
        await h.gpus.tick();     // and comes up
        const provider = await h.registry.getProvider('gpu.deepseek-r1-32b');
        assert.strictEqual(provider.status, 'active');
        assert.strictEqual(provider.base_url, 'https://gw.vast.ai:12346/v1', 'the router got the new endpoint');
        const st = await h.gpus.state();
        assert.ok(BigInt(st.committed_nano) <= BigInt(st.cap_nano), 'the money is inside the cap');
    } finally { await h.stop(); }
});


t.test('an instance the marketplace accepted before the row knew its id is recovered, not thrown away', async () => {
    const api = createGpuFetch();
    let now = T0;
    const h = await boot({ clock: { now: () => now }, fetchImpl: api.fetchImpl });
    try {
        await settings(h, { cap: '50000000000' });
        // the crash: the marketplace accepted the instance, the row never learned its id
        const id = 'openvibe-abc123def456';
        api.extra.push({ id: 'inst-crash', label: id, state: 'running' });
        await crashedRow(h, id, now);
        now += 60_000;
        await h.gpus.tick();
        const row = await h.db.prepare('SELECT * FROM gpu_instances WHERE id = ?').get(id);
        assert.strictEqual(row.remote_id, 'inst-crash', 'the row knows its instance again');
        assert.strictEqual(row.status, 'running', 'and the instance serves');
        assert.strictEqual(api.calls.destroy.length, 0, 'a paid instance of ours is never thrown away');
        const audit = await h.registry.listAudit({ action: 'gpu.instance.recovered', targetId: id });
        assert.strictEqual(audit.length, 1, 'the recovery is on the audit log');
    } finally { await h.stop(); }
});

t.test('an instance with our label and no row of ours is found and given back', async () => {
    const api = createGpuFetch();
    let now = T0;
    const h = await boot({ clock: { now: () => now }, fetchImpl: api.fetchImpl });
    try {
        await settings(h, { cap: '50000000000' });
        const label = 'openvibe-111111111111';
        api.extra.push({ id: 'inst-orphan', label, state: 'running' });
        now += 60_000;
        await h.gpus.tick();
        assert.ok(api.calls.destroy.some((u) => u.includes('inst-orphan')), 'the orphan was given back');
        const row = await h.db.prepare('SELECT * FROM gpu_instances WHERE id = ?').get(label);
        assert.strictEqual(row.status, 'destroyed');
        const audit = await h.registry.listAudit({ action: 'gpu.orphan.destroyed' });
        assert.strictEqual(audit.length, 1, 'the orphan is on the audit log');
        assert.deepStrictEqual(await h.gpus.orphanCount(), [], 'no orphan is left waiting');
    } finally { await h.stop(); }
});

t.test('a destroy that keeps failing is tried again every pass and the operator is alerted', async () => {
    const api = createGpuFetch();
    let now = T0;
    const h = await boot({ clock: { now: () => now }, fetchImpl: api.fetchImpl });
    try {
        await settings(h, { cap: '50000000000' });
        api.destroyFails = true;
        const label = 'openvibe-222222222222';
        api.extra.push({ id: 'inst-stuck', label, state: 'running' });
        for (let i = 0; i < 3; i++) {
            now += 60_000;
            await h.gpus.tick();
        }
        const row = await h.db.prepare('SELECT * FROM gpu_instances WHERE id = ?').get(label);
        assert.strictEqual(Number(row.destroy_failures), 3, 'the tries are counted');
        assert.strictEqual(row.status, 'orphan', 'and the instance is still running');
        assert.strictEqual(api.calls.destroy.filter((u) => u.includes('inst-stuck')).length, 3, 'every pass tries again');
        const gauges = await h.gpus.destroyFailures();
        assert.strictEqual(gauges.length, 1);
        assert.strictEqual(gauges[0].labels.marketplace, 'vast');
        assert.strictEqual(gauges[0].value, 3, 'the gauge the operator alert reads');
        const audit = await h.registry.listAudit({ action: 'gpu.orphan.destroy_failed' });
        assert.strictEqual(audit.length, 1, 'the operator alert is on the audit log');
        assert.strictEqual((await h.gpus.launch('deepseek-r1-32b')).code, 'gpu.uncertain', 'an unaccounted orphan blocks new spending');
    } finally { await h.stop(); }
});

t.test('an unknown rental retains its reservation until reconciled', async () => {
    const api = createGpuFetch();
    let now = T0;
    const h = await boot({ clock: { now: () => now }, fetchImpl: api.fetchImpl });
    try {
        await settings(h, { cap: '50000000000' });
        // the crash before the marketplace answered: the row holds a reservation for an instance
        // that does not exist
        const id = 'openvibe-def456abc789';
        await crashedRow(h, id, now);
        const before = await h.gpus.moneySummary();
        assert.ok(BigInt(before.committed_nano) > 0n, 'the row holds its reservation');
        now += 11 * 60_000;      // past the give-up time
        await h.gpus.tick();
        const row = await h.db.prepare('SELECT * FROM gpu_instances WHERE id = ?').get(id);
        assert.strictEqual(row.status, 'starting');
        const after = await h.gpus.moneySummary();
        assert.ok(BigInt(after.committed_nano) >= BigInt(before.committed_nano), 'an empty listing cannot release an uncertain financial commitment');
    } finally { await h.stop(); }
});

t.test('unbounded extras block rentals and the allowance counts against the cap', async () => {
    const api = createGpuFetch();
    const h = await boot({ clock: { now: () => T0 }, fetchImpl: api.fetchImpl });
    try {
        await settings(h, { cap: '1000000000', maxRuntime: 60 });
        await h.settings.gpus.store.apply({ costs_bounded: false }, { merge: true, actor: OWNER });
        const blocked = await h.gpus.launch('deepseek-r1-32b');
        assert.strictEqual(blocked.ok, false);assert.match(blocked.reason, /hourly bound/);
        assert.strictEqual(api.calls.create.length, 0);
        await h.settings.gpus.store.apply({ costs_bounded: true, extra_hourly_nano: 1000000000 }, { merge: true, actor: OWNER });
        assert.strictEqual((await h.gpus.launch('deepseek-r1-32b')).code, 'gpu.cap');
        assert.strictEqual(api.calls.create.length, 0);
        await h.settings.gpus.store.apply({ extra_hourly_nano: 100000000 }, { merge: true, actor: OWNER });
        const rented = await h.gpus.launch('deepseek-r1-32b');
        assert.ok(rented.ok, rented.reason);
        assert.strictEqual(String(rented.hourly_nano), '234800000');
        assert.strictEqual(rented.instance.price_per_hour, '0.2348');
    } finally { await h.stop(); }
});

t.test('accepted deletion retains the reservation until the instance is confirmed gone', async () => {
    const api = createGpuFetch();
    let now = T0;
    const h = await boot({ clock: { now: () => now }, fetchImpl: api.fetchImpl });
    try {
        await settings(h);
        const rented = await h.gpus.launch('deepseek-r1-32b');
        api.deletePending = true;
        await settings(h, { cap: '0' });
        await h.gpus.tick();
        let row = await h.db.prepare('SELECT * FROM gpu_instances WHERE id=?').get(rented.instance.id);
        assert.notStrictEqual(row.status, 'destroyed');
        assert.ok(BigInt((await h.gpus.moneySummary()).committed_nano) > 0n);
        now += 24 * 3600000;
        const overdue = await h.gpus.moneySummary();
        assert.ok(BigInt(overdue.committed_nano) >= BigInt(overdue.spent_nano), 'unconfirmed deletion cannot understate the commitment');
        api.deletePending = false;
        await h.gpus.tick();
        row = await h.db.prepare('SELECT * FROM gpu_instances WHERE id=?').get(rented.instance.id);
        assert.strictEqual(row.status, 'destroyed');
    } finally { await h.stop(); }
});

t.test('quotes and dry runs work without a cap and never create an instance', async () => {
    const api = createGpuFetch();
    const h = await boot({ clock: { now: () => T0 }, fetchImpl: api.fetchImpl });
    try {
        const q = await h.gpus.preview('deepseek-r1-32b');
        assert.strictEqual(q.selected.id, '111');
        const dry = await h.gpus.launch('deepseek-r1-32b', { dryRun: true });
        assert.strictEqual(dry.dry_run, true);
        assert.strictEqual(api.calls.create.length, 0);
        for (const strategy of ['own', 'private']) {
            const p = await h.gpus.preview('deepseek-r1-32b', { strategy });
            assert.strictEqual(p.selected, null);
        }
        assert.strictEqual((await h.gpus.state()).instances.length, 0);
    } finally { await h.stop(); }
});

t.test('disabling the cap continues cleanup of paid instances', async () => {
    const api = createGpuFetch();
    const h = await boot({ clock: { now: () => T0 }, fetchImpl: api.fetchImpl });
    try {
        await settings(h);
        await h.gpus.launch('deepseek-r1-32b');
        await settings(h, { cap: '0' });
        await h.gpus.tick();
        assert.ok(api.calls.destroy.length > 0);
    } finally { await h.stop(); }
});

t.test('concurrent models cannot over-reserve the same monthly cap', async () => {
    const api = createGpuFetch();
    const h = await boot({ clock: { now: () => T0 }, fetchImpl: api.fetchImpl });
    try {
        await settings(h, { cap: '150000000', maxRuntime: 60 });
        const results = await Promise.all([h.gpus.launch('deepseek-r1-32b'), h.gpus.launch('deepseek-r1-32b-abliterated')]);
        assert.strictEqual(results.filter(r => r.ok).length, 1);
        assert.strictEqual(api.calls.create.length, 1);
        assert.ok(BigInt((await h.gpus.moneySummary()).committed_nano) <= 150000000n);
    } finally { await h.stop(); }
});

t.test('a lost create response retains its reservation and is recovered by label', async () => {
    const api = createGpuFetch();
    const fetchImpl = async (url, options) => {
        const response = await api.fetchImpl(url, options);
        if (String(url).includes('/asks/')) throw new Error('response lost');
        return response;
    };
    const h = await boot({ clock: { now: () => T0 }, fetchImpl });
    try {
        await settings(h);
        const pending = await h.gpus.launch('deepseek-r1-32b');
        assert.strictEqual(pending.pending, true);
        assert.ok(BigInt((await h.gpus.moneySummary()).committed_nano) > 0n);
        await h.gpus.tick();
        const row = await h.db.prepare('SELECT * FROM gpu_instances WHERE id=?').get(pending.instance.id);
        assert.ok(row.remote_id, 'the label recovers the purchase rather than issuing a second one');
        assert.strictEqual(api.calls.create.length, 1);
    } finally { await h.stop(); }
});

if (require.main === module) t.run();
module.exports = { suite: t };
