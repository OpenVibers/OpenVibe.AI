'use strict';
/**
 * Verda (formerly DataCrunch): on-demand and spot datacenter GPUs.
 *
 * From Verda's public OpenAPI (https://api.datacrunch.io/v1/openapi.json, documented at
 * docs.verda.com/api):
 *   GET  /v1/instance-types              the types, their GPUs, VRAM and hourly + spot prices
 *   POST /v1/instances                   deploy an instance (is_spot true for spot)
 *   GET  /v1/instances/{id}              the instance and its status/ip
 *   PUT  /v1/instances                   {action:"delete", id} gives the instance back
 *
 * The key is a bearer token. Spot instances may be evicted by Verda at any time without warning.
 */
const { apiJson } = require('./http');

const BASE_URL = 'https://api.datacrunch.io';

function modelMatch(name, wanted) {
    const text = String(name || '').toLowerCase();
    return !wanted.length || wanted.some((w) => text.includes(String(w).toLowerCase()) || String(w).toLowerCase().includes(text));
}

/** A Verda adapter: searchOffers, createInstance, showInstance, destroyInstance. */
function verdaAdapter({ fetchImpl = globalThis.fetch, key = null, image = '', location = '', baseUrl = BASE_URL } = {}) {
    const auth = { key, label: 'Verda' };

    return {
        id: 'verda',
        label: 'Verda',
        baseUrl,

        async searchOffers(req = {}) {
            const out = await apiJson(fetchImpl, baseUrl + '/v1/instance-types', auth);
            const types = Array.isArray(out) ? out : ((out && (out.instance_types || out.data)) || []);
            const wanted = req.gpuNames || [];
            const offers = [];
            for (const type of types) {
                if (!type || !type.instance_type) continue;
                const gpu = type.gpu || {};
                const memory = type.gpu_memory || {};
                const name = String(type.name || type.model || type.instance_type);
                if (!modelMatch(name, wanted)) continue;
                const vramMb = Number(memory.size_in_gigabytes || type.vram_gb || 0) * 1024;
                if (req.vramMb && vramMb && vramMb < Number(req.vramMb)) continue;
                const numGpus = Number(gpu.number_of_gpus) || 1;
                if (numGpus < Number(req.numGpus || 1)) continue;
                const spot = type.spot_price != null && Number(type.spot_price) > 0 ? String(type.spot_price) : '';
                const onDemand = type.price_per_hour != null ? String(type.price_per_hour) : '';
                const price = req.interruptible ? spot : onDemand;
                if (!(Number(price) > 0)) continue;
                if (req.maxPricePerHour && Number(price) > Number(req.maxPricePerHour)) continue;
                const locationCode = location || String((type.locations && type.locations[0] && (type.locations[0].code || type.locations[0].location_code)) || type.location_code || '');
                offers.push({
                    id: String(type.instance_type),
                    marketplace: 'verda',
                    gpu_name: name,
                    gpu_ram_mb: vramMb,
                    num_gpus: numGpus,
                    disk_gb: Number(type.storage || req.diskGb || 0),
                    price_per_hour: price,
                    reliability: 0.99,
                    region: locationCode,
                    location_code: locationCode,
                    interruptible: Boolean(req.interruptible),
                });
            }
            return offers;
        },

        async createInstance(offer, spec, opts = {}) {
            const disk = Math.max(50, Number(spec.requirements && spec.requirements.disk_gb) || 50);
            const body = {
                instance_type: String(offer.id),
                image: String((spec.runtime && spec.runtime.image) || image || 'ubuntu-22.04-cuda-12.4-docker'),
                is_spot: Boolean(offer.interruptible || opts.interruptible),
                description: String(opts.label || ('openvibe-' + spec.key)),
                hostname: String(opts.label || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) || undefined,
                os_volume: { name: String(opts.label || spec.key), size: disk },
            };
            if (offer.location_code || location) body.location_code = offer.location_code || location;
            const out = await apiJson(fetchImpl, baseUrl + '/v1/instances', { ...auth, method: 'POST', body });
            return { remote_id: String((out && out.id) || ''), endpoint: '', state: 'starting', raw: out };
        },

        async showInstance(remoteId) {
            const out = await apiJson(fetchImpl, baseUrl + '/v1/instances/' + encodeURIComponent(remoteId), { ...auth, allowMissing: true });
            if (!out || out.missing) return { remote_id: remoteId, state: 'deleted', deleted: true, endpoint: '' };
            const state = String(out.status || 'unknown').toLowerCase();
            const ip = out.ip || out.main_ip || out.hostname || '';
            return {
                remote_id: remoteId,
                state: state === 'running' ? 'running' : (['provisioning', 'starting', 'pending'].includes(state) ? 'starting' : state),
                endpoint: ip ? 'http://' + ip + ':8000' : '',
                raw: out,
            };
        },

        async destroyInstance(remoteId) {
            const out = await apiJson(fetchImpl, baseUrl + '/v1/instances', {
                ...auth, method: 'PUT', body: { action: 'delete', id: String(remoteId) }, allowMissing: true,
            });
            return Boolean(out === null || out.deleted !== false);
        },
    };
}

module.exports = { verdaAdapter, BASE_URL };
