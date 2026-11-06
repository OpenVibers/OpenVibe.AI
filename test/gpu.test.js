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
    const values = { monthly_cap: Number(cap) };
    if (idle != null) values.idle_minutes = idle;
    if (maxRuntime != null) values.max_runtime_minutes = maxRuntime;
    await store.apply(values, { merge: true, actor: OWNER, reason: 'the test' });
    if (key) await store.setSecret('vast.key', key, { actor: OWNER, reason: 'the test' });
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

if (require.main === module) t.run();
module.exports = { suite: t };
