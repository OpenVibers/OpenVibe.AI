'use strict';
/**
 * Shadeform: one key for the underlying clouds it aggregates, on demand (and spot where a cloud
 * offers it).
 *
 * From Shadeform's OpenAPI (https://api.shadeform.ai/v1/openapi.json, also linked from
 * docs.shadeform.ai/api-reference):
 *   GET  /v1/instances/types                    every type, its specs and its per-region availability
 *   POST /v1/instances/create                   create; the answer is {id,status} while it is "creating"
 *   GET  /v1/instances/{id}/info                the instance, its status and its ip/http port
 *   POST /v1/instances/{id}/delete              delete; billing stops at "deleting"
 *
 * The key goes in the X-API-KEY header. Shadeform charges the cloud's own rate: the marketplace
 * itself adds no fee (docs.shadeform.ai/getting-started/faq, 2026-11-08).
 */
const { apiJson } = require('./http');

const BASE_URL = 'https://api.shadeform.ai';
const AUTH = { keyHeader: 'X-API-KEY', keyPrefix: ' ' };

function cleanKey(value) {
    return String(value || '').trim();
}

// The type's own name is the only VRAM identity Shadeform returns; this is the matching floor.
const VRAM_MB = Object.freeze({ A4000: 16384, A5000: 24576, A6000: 49152, '3090': 24576, '4090': 24576, L4: 24576, L40: 49152, L40S: 49152, A100: 81920, H100: 81920, H200: 141312, B200: 196608 });

function vramOf(gpuType, numGpus) {
    const text = String(gpuType || '').toUpperCase();
    for (const [needle, mb] of Object.entries(VRAM_MB)) if (text.includes(needle.toUpperCase())) return mb * Math.max(1, Number(numGpus) || 1);
    return 0;
}

/** A Shadeform adapter: searchOffers, createInstance, showInstance, destroyInstance. */
function shadeformAdapter({ fetchImpl = globalThis.fetch, key = null, baseUrl = BASE_URL } = {}) {
    const auth = { key: cleanKey(key), label: 'Shadeform', ...AUTH, keyPrefix: '' };

    async function typePage(query) {
        const qs = Object.entries(query).filter(([, v]) => v != null && v !== '').map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
        return apiJson(fetchImpl, baseUrl + '/v1/instances/types' + (qs ? '?' + qs : ''), auth);
    }

    function offerOf(type, availability, region) {
        const hourly = availability.hourly_price != null && Number(availability.hourly_price) > 0
            ? String(availability.hourly_price)
            : String(Number(type.hourly_price) / 100);
        return {
            // The rental is identified by type + cloud + region + rental type; the create call needs all
            // four, so the id carries them and the adapter reads them back out.
            id: [type.shade_instance_type, type.cloud, region, availability.rental_type || 'on_demand'].join('|'),
            cloud: String(type.cloud || ''),
            shade_instance_type: String(type.shade_instance_type || ''),
            rental_type: String(availability.rental_type || 'on_demand'),
            region: String(region || ''),
            marketplace: 'shadeform',
            gpu_name: String(type.gpu_type || ''),
            gpu_ram_mb: vramOf(type.gpu_type, type.num_gpus),
            num_gpus: Number(type.num_gpus) || 1,
            disk_gb: Number(type.storage_in_gb) || 0,
            price_per_hour: hourly,
            reliability: 0.99,
            interruptible: String(availability.rental_type) === 'spot',
        };
    }

    return {
        id: 'shadeform',
        label: 'Shadeform',
        baseUrl,

        async searchOffers(req = {}) {
            const params = {
                gpu_type: (req.gpuNames || [])[0] || '',
                num_gpus: req.numGpus && Number(req.numGpus) > 1 ? req.numGpus : '',
                region: req.region || '',
                available: 'true',
                shade_cloud: 'true',
                sort: 'price',
            };
            const out = await typePage(params);
            const offers = [];
            for (const type of (out && out.instance_types) || []) {
                for (const availability of (type.availability || [])) {
                    if (availability.available !== true) continue;
                    const region = String(availability.region || '');
                    if (req.region && region.toLowerCase() !== String(req.region).toLowerCase()) continue;
                    const rental = String(availability.rental_type || 'on_demand');
                    if (req.interruptible ? rental !== 'spot' : rental !== 'on_demand') continue;
                    if (Number(type.num_gpus) < Number(req.numGpus || 1)) continue;
                    if (req.diskGb && Number(type.storage_in_gb) < Number(req.diskGb)) continue;
                    const offer = offerOf(type, availability, region);
                    if (req.maxPricePerHour && Number(offer.price_per_hour) > Number(req.maxPricePerHour)) continue;
                    offers.push(offer);
                }
            }
            return offers;
        },

        async createInstance(offer, spec, opts = {}) {
            const parts = String(offer.id || '').split('|');
            const body = {
                cloud: offer.cloud || parts[1],
                region: offer.region || parts[2],
                shade_instance_type: offer.shade_instance_type || parts[0],
                rental_type: offer.rental_type || parts[3] || 'on_demand',
                shade_cloud: true,
                name: String(opts.label || ('openvibe-' + spec.key)).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 50),
                launch_configuration: {
                    type: 'docker',
                    docker_configuration: {
                        image: String((spec.runtime && spec.runtime.image) || (opts.image || '')),
                        args: String(opts.command || ''),
                        port_mappings: [{ internal_port: 8000, external_port: 8000 }],
                    },
                },
            };
            const out = await apiJson(fetchImpl, baseUrl + '/v1/instances/create', { ...auth, method: 'POST', body });
            return { remote_id: String((out && out.id) || ''), endpoint: '', state: String((out && out.status) || 'creating') };
        },

        async showInstance(remoteId) {
            const out = await apiJson(fetchImpl, baseUrl + '/v1/instances/' + encodeURIComponent(remoteId) + '/info', { ...auth, allowMissing: true });
            if (!out || out.missing) return { remote_id: remoteId, state: 'deleted', deleted: true, endpoint: '' };
            const status = String(out.status || 'unknown').toLowerCase();
            const details = out.details || {};
            const port = Number(details.http_port) || 8000;
            const host = out.ip || out.internal_hostname || '';
            return {
                remote_id: remoteId,
                state: status === 'active' ? 'running' : (status === 'pending' ? 'starting' : status),
                endpoint: host ? 'http://' + host + ':' + port : '',
                raw: out,
            };
        },

        async destroyInstance(remoteId) {
            const out = await apiJson(fetchImpl, baseUrl + '/v1/instances/' + encodeURIComponent(remoteId) + '/delete', { ...auth, method: 'POST', allowMissing: true });
            return Boolean(out === null || out.missing || out.deleted !== false);
        },
    };
}

module.exports = { shadeformAdapter, BASE_URL };
