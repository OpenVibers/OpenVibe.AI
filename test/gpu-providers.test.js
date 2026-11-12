'use strict';
/**
 * The marketplace adapters, against fakes written from each provider's own API documentation.
 * No test reaches a provider: every request is answered here and every request shape is asserted.
 */
const assert = require('node:assert/strict');
const { vastAdapter } = require('../server/gpu/vast');
const { saladAdapter, saladQueueAdapter } = require('../server/gpu/salad');
const { tensordockAdapter } = require('../server/gpu/tensordock');
const { shadeformAdapter } = require('../server/gpu/shadeform');
const { verdaAdapter } = require('../server/gpu/verda');
const { thunderAdapter } = require('../server/gpu/thunder');
const { runpodServerlessAdapter } = require('../server/gpu/runpod-serverless');
const { reservedAdapter } = require('../server/gpu/reserved');
const { createAdapter } = require('../server/gpu/adapters');

function fake(handler) {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        const call = { url: String(url), method: String(opts.method || 'GET'), headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null };
        calls.push(call);
        const out = handler(call) || {};
        const status = out.status == null ? 200 : out.status;
        return { ok: status >= 200 && status < 300, status, text: async () => (out.body === undefined ? '' : JSON.stringify(out.body)) };
    };
    return { fetchImpl, calls };
}
const spec = { key: 'deepseek-r1-32b', model_key: 'deepseek-r1-32b', runtime: { image: 'vllm/vllm-openai:latest' }, requirements: { disk_gb: 100, vram_mb: 24000, num_gpus: 1 } };

(async () => {
    // ── Vast.ai interruptible bids: search type bid, a bid price at create, the outbid case ──
    {
        const f = fake((c) => {
            if (c.url.includes('/api/v0/bundles')) return { body: { offers: [{ id: 7, gpu_name: 'RTX 4090', gpu_ram: 24576, num_gpus: 1, disk_space: 100, min_bid: 0.14, reliability: 0.99, geolocation: 'US' }] } };
            if (c.url.includes('/api/v0/asks/')) return { body: { success: true, new_contract: 'inst-7' } };
            if (c.url.includes('/api/v0/instances/')) return { body: { id: 'inst-7', actual_status: 'exited', status_msg: 'Your bid is below the market price; the instance was outbid' } };
            return { status: 404, body: {} };
        });
        const a = vastAdapter({ fetchImpl: f.fetchImpl, key: 'k' });
        const offers = await a.searchOffers({ gpuNames: ['RTX 4090'], vramMb: 24000, numGpus: 1, diskGb: 100, region: 'US', maxPricePerHour: 1, interruptible: true });
        assert.equal(offers.length, 1);
        assert.equal(offers[0].interruptible, true);
        assert.equal(offers[0].bid_price, '0.14');
        assert.equal(f.calls[0].body.type, 'bid');
        await a.createInstance(offers[0], spec, { label: 'openvibe-abcdef123456', interruptible: true });
        const rent = f.calls.find((c) => c.url.includes('/api/v0/asks/'));
        assert.equal(rent.body.type, 'bid');
        assert.equal(rent.body.price, '0.14');
        const shown = await a.showInstance('inst-7');
        assert.equal(shown.outbid, true);
        assert.equal(shown.state, 'preempted');
    }

    // ── SaladCloud: a container group at the batch tier and three replicas, its queue adapter ──
    {
        const f = fake((c) => {
            if (c.url.endsWith('/gpu-classes')) return { body: { items: [{ id: 'gpu-1', name: 'RTX 4090', gpu_count: 1, prices: [{ priority: 'batch', price: '$0.16/hr' }, { priority: 'high', price: '$0.44/hr' }] }] } };
            if (c.url.endsWith('/containers') && c.method === 'POST') return { status: 201, body: { name: 'openvibe-a1', networking: { dns: 'openvibe-a1.salad.com' } } };
            if (c.url.includes('/containers/') && c.method === 'GET') return { body: { current_state: { status: 'running' }, networking: { dns: 'openvibe-a1.salad.com' } } };
            if (c.url.includes('/containers/') && c.method === 'DELETE') return { body: { removed: true } };
            if (c.url.includes('/queues/q/jobs') && c.method === 'POST') return { status: 201, body: { id: 'job-1', status: 'pending' } };
            if (c.url.includes('/queues/q/jobs/job-1') && c.method === 'GET') return { body: { id: 'job-1', status: 'succeeded', output: { text: 'ok' } } };
            if (c.url.includes('/queues/q/jobs/job-1') && c.method === 'DELETE') return { body: { ok: true } };
            return { status: 404, body: {} };
        });
        const a = saladAdapter({ fetchImpl: f.fetchImpl, key: 'salad-key', organization: 'org', project: 'proj' });
        const offers = await a.searchOffers({ gpuNames: ['RTX 4090'], vramMb: 24000, diskGb: 100, interruptible: true });
        assert.equal(offers.length, 1);
        assert.equal(offers[0].price_per_hour, '0.16');
        assert.equal(offers[0].interruptible, true);
        const created = await a.createInstance(offers[0], spec, { label: 'openvibe-a1', interruptible: true });
        assert.equal(created.remote_id, 'openvibe-a1');
        const create = f.calls.find((c) => c.url.endsWith('/containers') && c.method === 'POST');
        assert.equal(create.headers['Salad-Api-Key'], 'salad-key');
        assert.equal(create.body.replicas, 3, 'the owner default for batch is three replicas');
        assert.equal(create.body.container.priority, 'batch');
        assert.deepEqual(create.body.container.resources.gpu_classes, ['gpu-1']);
        const shown = await a.showInstance('openvibe-a1');
        assert.equal(shown.state, 'running');
        assert.equal(shown.endpoint, 'openvibe-a1.salad.com');
        assert.equal(await a.destroyInstance('openvibe-a1'), true);
        const queue = saladQueueAdapter({ fetchImpl: f.fetchImpl, key: 'salad-key', organization: 'org', project: 'proj', queue: 'q' });
        const submitted = await queue.submitJob({ prompt: 'x' });
        assert.equal(submitted.id, 'job-1');
        assert.equal((await queue.showJob('job-1')).status, 'succeeded');
        assert.equal(await queue.cancelJob('job-1'), true);
    }

    // ── Shadeform: one key, type + cloud + region + rental type ──
    {
        const f = fake((c) => {
            if (c.url.includes('/v1/instances/types')) return { body: { instance_types: [{ shade_instance_type: 'A6000', cloud: 'hyperstack', gpu_type: 'A6000', num_gpus: 1, storage_in_gb: 500, hourly_price: 210, availability: [
                { region: 'canada-1', rental_type: 'on_demand', available: true, hourly_price: '2.10' },
                { region: 'canada-1', rental_type: 'spot', available: true, hourly_price: '1.10' },
            ] }] } };
            if (c.url.endsWith('/v1/instances/create')) return { body: { id: 'sh-1', status: 'creating' } };
            if (c.url.includes('/v1/instances/sh-1/info')) return { body: { id: 'sh-1', status: 'active', ip: '1.2.3.4', details: { http_port: 8000 } } };
            if (c.url.includes('/v1/instances/sh-1/delete')) return { body: {} };
            return { status: 404, body: {} };
        });
        const a = shadeformAdapter({ fetchImpl: f.fetchImpl, key: 'shade-key' });
        const onDemand = await a.searchOffers({ gpuNames: ['A6000'], numGpus: 1, diskGb: 100, region: 'canada-1' });
        assert.equal(onDemand.length, 1);
        assert.equal(onDemand[0].price_per_hour, '2.10');
        assert.equal(onDemand[0].interruptible, false);
        const spot = await a.searchOffers({ gpuNames: ['A6000'], numGpus: 1, diskGb: 100, region: 'canada-1', interruptible: true });
        assert.equal(spot[0].price_per_hour, '1.10');
        assert.equal(spot[0].interruptible, true);
        assert.equal(f.calls[0].headers['X-API-KEY'], 'shade-key');
        const created = await a.createInstance(onDemand[0], spec, { command: 'serve' });
        assert.equal(created.remote_id, 'sh-1');
        const create = f.calls.find((c) => c.url.endsWith('/create'));
        assert.equal(create.body.shade_instance_type, 'A6000');
        assert.equal(create.body.cloud, 'hyperstack');
        assert.equal(create.body.region, 'canada-1');
        assert.equal(create.body.rental_type, 'on_demand');
        assert.equal((await a.showInstance('sh-1')).endpoint, 'http://1.2.3.4:8000');
        assert.equal(await a.destroyInstance('sh-1'), true);
    }

    // ── Verda: on demand and spot, delete through the action endpoint ──
    {
        const f = fake((c) => {
            if (c.url.endsWith('/v1/instance-types')) return { body: [{ instance_type: '1H100.80S.30V', name: 'H100 SXM5 80GB', gpu: { number_of_gpus: 1 }, gpu_memory: { size_in_gigabytes: 80 }, price_per_hour: '3.17', spot_price: '1.29' }] };
            if (c.url.endsWith('/v1/instances') && c.method === 'POST') return { body: { id: 'v-1', status: 'provisioning' } };
            if (c.url.endsWith('/v1/instances/v-1')) return { body: { id: 'v-1', status: 'running', ip: '5.6.7.8' } };
            if (c.url.endsWith('/v1/instances') && c.method === 'PUT') return { body: { deleted: true } };
            return { status: 404, body: {} };
        });
        const a = verdaAdapter({ fetchImpl: f.fetchImpl, key: 'verda-key' });
        const spot = await a.searchOffers({ gpuNames: ['H100'], vramMb: 80000, numGpus: 1, interruptible: true });
        assert.equal(spot[0].price_per_hour, '1.29');
        assert.equal(spot[0].interruptible, true);
        const created = await a.createInstance(spot[0], spec, { label: 'openvibe-v1' });
        assert.equal(created.remote_id, 'v-1');
        assert.equal(f.calls.find((c) => c.url.endsWith('/v1/instances') && c.method === 'POST').body.is_spot, true);
        assert.equal((await a.showInstance('v-1')).endpoint, 'http://5.6.7.8:8000');
        assert.equal(await a.destroyInstance('v-1'), true);
        assert.equal(f.calls.find((c) => c.method === 'PUT').body.action, 'delete');
    }

    // ── Thunder Compute: on demand, per-minute billing, only published rates ──
    {
        const f = fake((c) => {
            if (c.url.endsWith('/v2/specs')) return { body: { specs: { H100_1x: { displayName: 'H100', gpuCount: 1, vramGB: 80 }, A6000_1x: { displayName: 'RTX A6000', gpuCount: 1, vramGB: 48 } } } };
            if (c.url.endsWith('/v1/instances/create')) return { status: 201, body: { uuid: 't-1', identifier: 1 } };
            if (c.url.endsWith('/v1/instances/list')) return { body: { 't-1': { id: 't-1', uuid: 't-1', status: 'running', ip: '9.9.9.9', port: 8000 } } };
            if (c.url.includes('/v1/instances/t-1/delete')) return { body: { message: 'Success' } };
            return { status: 404, body: {} };
        });
        const a = thunderAdapter({ fetchImpl: f.fetchImpl, key: 'thunder-key' });
        const offers = await a.searchOffers({ gpuNames: ['H100'], vramMb: 80000, numGpus: 1 });
        assert.equal(offers.length, 1, 'a card without a published rate is not offered');
        assert.equal(offers[0].price_per_hour, '3.20');
        assert.equal(offers[0].interruptible, false);
        const created = await a.createInstance(offers[0], spec, { label: 'openvibe-t1' });
        assert.equal(created.remote_id, 't-1');
        assert.equal(f.calls.find((c) => c.url.endsWith('/create')).body.num_gpus, 1);
        assert.equal((await a.showInstance('t-1')).endpoint, 'http://9.9.9.9:8000');
        assert.equal(await a.destroyInstance('t-1'), true);
    }

    // ── TensorDock: a spot VM is a bid; the delete is the deploy delete ──
    {
        const f = fake((c) => {
            if (c.url.endsWith('/client/list_gpus')) return { body: { gpus: [{ id: 'g-1', model: 'RTX 4090', num_gpus: 1, vram_gb: 24, price_per_hour: '0.37', spot_price: '0.20', location: 'us-east-1' }] } };
            if (c.url.endsWith('/client/deploy/single')) return { body: { vm_id: 'td-1', success: true } };
            if (c.url.endsWith('/client/list_instances')) return { body: { instances: [{ id: 'td-1', status: 'running', ip: '4.4.4.4', port_forwards: [{ external_port: 8000 }] }] } };
            if (c.url.includes('/client/deploy/td-1/delete')) return { body: { success: true } };
            return { status: 404, body: {} };
        });
        const a = tensordockAdapter({ fetchImpl: f.fetchImpl, key: 'td-key' });
        const spot = await a.searchOffers({ gpuNames: ['RTX 4090'], vramMb: 24000, numGpus: 1, interruptible: true });
        assert.equal(spot[0].price_per_hour, '0.20');
        const created = await a.createInstance(spot[0], spec, { label: 'openvibe-td1' });
        assert.equal(created.remote_id, 'td-1');
        const deploy = f.calls.find((c) => c.url.endsWith('/client/deploy/single')).body;
        assert.equal(deploy.price_type, 'spot');
        assert.equal(deploy.price, '0.20');
        assert.equal((await a.showInstance('td-1')).endpoint, 'http://4.4.4.4:8000');
        assert.equal(await a.destroyInstance('td-1'), true);
    }

    // ── RunPod Serverless: scale to zero and the OpenAI-compatible vLLM URL ──
    {
        const f = fake((c) => {
            if (c.url.endsWith('/v2/serverless') && c.method === 'POST') return { body: { id: 'ep-1', status: 'creating' } };
            if (c.url.endsWith('/v2/serverless/ep-1') && c.method === 'GET') return { body: { id: 'ep-1', workers: { min: 0, max: 3 } } };
            if (c.url.endsWith('/v2/serverless/ep-1') && c.method === 'DELETE') return { body: { deleted: true } };
            return { status: 404, body: {} };
        });
        const a = runpodServerlessAdapter({ fetchImpl: f.fetchImpl, key: 'rp-key', templateId: 'tpl-1' });
        const offers = await a.searchOffers({ gpuNames: ['L40S'], vramMb: 48000, numGpus: 1 });
        assert.equal(offers.length, 1);
        assert.equal(offers[0].price_per_hour, '1.75');
        const created = await a.createInstance(offers[0], spec, { label: 'openvibe-rp1' });
        assert.equal(created.remote_id, 'ep-1');
        assert.equal(created.endpoint, 'https://api.runpod.ai/v2/ep-1/openai/v1');
        const body = f.calls.find((c) => c.url.endsWith('/v2/serverless') && c.method === 'POST').body;
        assert.equal(body.templateId, 'tpl-1');
        assert.equal(body.workers.min, 0, 'scale to zero');
        assert.deepEqual(body.gpu.pools, ['ADA_48_PRO']);
        assert.equal((await a.showInstance('ep-1')).workers.min, 0);
        assert.equal(await a.destroyInstance('ep-1'), true);
    }

    // ── the reserved server: hourly = monthly ÷ 730 and nothing is rented ──
    {
        let called = 0;
        const a = reservedAdapter({ endpoint: 'https://box.example/v1', monthlyNano: '730000000000', name: 'hetzner-gex44' });
        assert.equal((await a.searchOffers({}))[0].price_per_hour, '1');
        const created = await a.createInstance({ id: 'reserved:hetzner-gex44' }, spec, {});
        assert.equal(created.endpoint, 'https://box.example/v1');
        assert.equal(created.state, 'running');
        assert.equal((await a.showInstance(created.remote_id)).state, 'running');
        assert.equal(await a.destroyInstance(created.remote_id), true);
        assert.equal(called, 0);
    }

    // ── the registry builds nothing without a key and needs the reserved box's own settings ──
    {
        assert.equal(createAdapter('salad', { key: null, options: {} }), null);
        assert.equal(createAdapter('reserved', { options: {} }), null);
        assert.ok(createAdapter('reserved', { options: { endpoint: 'https://box.example/v1', monthly_nano: '1' } }));
        assert.ok(createAdapter('runpod_serverless', { key: 'k', options: { template_id: 'tpl' } }));
    }

    console.log('GPU provider adapters: Vast bids/outbid, Salad groups and queue, TensorDock spot, Shadeform on-demand, Verda spot, Thunder per-minute, RunPod Serverless scale-to-zero, reserved monthly: passed');
})().catch((err) => { console.error(err); process.exit(1); });
