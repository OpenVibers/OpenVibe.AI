'use strict';
/**
 * Thunder Compute: on-demand GPU instances billed per minute, never preempted.
 *
 * From Thunder's OpenAPI (https://api.thundercompute.com:8443/openapi.json, documented at
 * thundercompute.com/docs/api-reference):
 *   GET  /v2/specs                 every GPU type/count with its VRAM and storage range
 *   POST /v1/instances/create      create; the answer carries the instance uuid
 *   GET  /v1/instances/list        every instance and its status/ip
 *   POST /v1/instances/{id}/delete delete it
 *
 * The key is a bearer token. Thunder's public price list is per GPU-hour; the rates below are the
 * ones the provider publishes (thundercompute.com/pricing, checked 2026-11-11). A card without a
 * published rate is not offered rather than guessed at.
 */
const { apiJson } = require('./http');

const BASE_URL = 'https://api.thundercompute.com:8443';
const PRICES = Object.freeze({ H100: '3.20', A100: '1.09' });
const VRAM_MB = Object.freeze({ H100: 81920, A100: 81920, A6000: 49152, L40: 49152 });

/** The card and count from a spec key such as "H100_1x" or "A100_80GB_2x". */
function parseSpec(key, spec) {
    const text = String(key || '');
    const count = Number(spec && spec.gpuCount) || Number((/_(\d+)x$/i.exec(text) || [])[1]) || 1;
    const name = String((spec && spec.displayName) || text.split('_')[0] || '').trim();
    const type = Object.keys(PRICES).find((p) => name.toUpperCase().includes(p)) || name.toUpperCase();
    return { type, count, name: name || type };
}

/** A Thunder Compute adapter: searchOffers, createInstance, showInstance, destroyInstance. */
function thunderAdapter({ fetchImpl = globalThis.fetch, key = null, template = 'ubuntu-22.04', baseUrl = BASE_URL } = {}) {
    const auth = { key, label: 'Thunder Compute' };

    return {
        id: 'thunder',
        label: 'Thunder Compute',
        baseUrl,
        billing: 'per minute',

        async searchOffers(req = {}) {
            const out = await apiJson(fetchImpl, baseUrl + '/v2/specs', auth);
            const specs = (out && out.specs) || {};
            const wanted = (req.gpuNames || []).map((n) => String(n).toUpperCase());
            const offers = [];
            for (const [specKey, spec] of Object.entries(specs)) {
                const parsed = parseSpec(specKey, spec);
                const price = PRICES[parsed.type];
                if (!price) continue;
                if (wanted.length && !wanted.some((w) => parsed.type.toUpperCase().includes(w) || w.includes(parsed.type.toUpperCase()))) continue;
                if (Number(spec.gpuCount) < Number(req.numGpus || 1)) continue;
                const vram = VRAM_MB[parsed.type] || 0;
                if (req.vramMb && vram && vram < Number(req.vramMb)) continue;
                if (req.maxPricePerHour && Number(price) > Number(req.maxPricePerHour)) continue;
                offers.push({
                    id: specKey,
                    marketplace: 'thunder',
                    gpu_name: parsed.name,
                    gpu_type: parsed.type,
                    gpu_ram_mb: vram,
                    num_gpus: parsed.count,
                    disk_gb: Number(req.diskGb) || 0,
                    price_per_hour: price,
                    reliability: 0.99,
                    region: 'US',
                    interruptible: false,
                });
            }
            return offers;
        },

        async createInstance(offer, spec, opts = {}) {
            const body = {
                gpu_type: String(offer.gpu_type || offer.gpu_name || '').split(' ')[0],
                num_gpus: Number(offer.num_gpus) || 1,
                cpu_cores: 4,
                disk_size_gb: Math.max(50, Number(spec.requirements && spec.requirements.disk_gb) || 50),
                template: String(opts.template || template),
            };
            const out = await apiJson(fetchImpl, baseUrl + '/v1/instances/create', { ...auth, method: 'POST', body });
            return { remote_id: String((out && (out.uuid || out.id)) || ''), endpoint: '', state: 'starting', raw: out };
        },

        async showInstance(remoteId) {
            const out = await apiJson(fetchImpl, baseUrl + '/v1/instances/list', { ...auth, allowMissing: true });
            const list = (out && (out.instances || out)) || {};
            const found = Array.isArray(list) ? list.find((x) => String(x.uuid || x.id) === String(remoteId)) : list[remoteId];
            if (!found) return { remote_id: remoteId, state: 'deleted', deleted: true, endpoint: '' };
            const state = String(found.status || 'unknown').toLowerCase();
            const host = found.ip || '';
            const port = Number(found.port) || 8000;
            return {
                remote_id: remoteId,
                state: state === 'running' ? 'running' : (['provisioning', 'starting', 'pending', 'creating'].includes(state) ? 'starting' : state),
                endpoint: host ? 'http://' + host + ':' + port : '',
                raw: found,
            };
        },

        async destroyInstance(remoteId) {
            const out = await apiJson(fetchImpl, baseUrl + '/v1/instances/' + encodeURIComponent(remoteId) + '/delete', { ...auth, method: 'POST', allowMissing: true });
            return Boolean(out === null || out.missing || out.message || out.deleted !== false);
        },
    };
}

module.exports = { thunderAdapter, BASE_URL, PRICES };
