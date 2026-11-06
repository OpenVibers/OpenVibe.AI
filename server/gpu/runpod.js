'use strict';
/**
 * RunPod: the marketplace for bigger cards (the H100 that fits a large model).
 *
 * The calls are the ones the RunPod v2 API documents:
 *   GET    /v2/gpu-types            the catalogue of cards and their prices
 *   POST   /v2/pods                 rent a pod
 *   GET    /v2/pods/{id}            the pod
 *   DELETE /v2/pods/{id}            give the pod back
 *
 * The API key goes in the Authorization header and nowhere else.
 */
const { apiJson } = require('./http');

const BASE_URL = 'https://api.runpod.io';

/** A RunPod adapter: searchOffers, createInstance, showInstance, destroyInstance. */
function runpodAdapter({ fetchImpl = globalThis.fetch, key = null, baseUrl = BASE_URL } = {}) {
    const auth = { key };

    /** The endpoint of a running pod: its proxy URL, or the documented proxy address. */
    function endpointOf(pod, port) {
        const ports = (pod && pod.ports) || {};
        const p = ports[port] || ports[String(port)];
        if (p) {
            if (p.proxyUrl) return String(p.proxyUrl);
            if (p.publicPort && pod.ip) return 'https://' + pod.ip + ':' + p.publicPort;
        }
        if (pod && pod.id && port) return 'https://' + pod.id + '-' + port + '.proxy.runpod.io';
        return '';
    }

    /** The card's price: the secure price when there is one, else the community price. */
    function priceOf(gpu) {
        const price = (gpu && gpu.price) || {};
        const secure = Number(price.secure);
        const community = Number(price.community);
        if (Number.isFinite(secure) && secure > 0) return String(secure);
        if (Number.isFinite(community) && community > 0) return String(community);
        return '0';
    }

    return {
        id: 'runpod',
        label: 'RunPod',
        baseUrl,

        async searchOffers(req) {
            const out = await apiJson(fetchImpl, baseUrl + '/v2/gpu-types', { ...auth, label: 'RunPod' });
            const gpus = (out && out.gpus) || [];
            const wanted = (req.gpuNames || []).map((n) => String(n).toLowerCase());
            const offers = [];
            for (const gpu of gpus) {
                const name = String(gpu.name || '');
                const lower = name.toLowerCase();
                if (wanted.length && !wanted.some((w) => lower.includes(w.toLowerCase()))) continue;
                if (Number(gpu.memory) < Number(req.vramMb)) continue;
                if (Number(gpu.maxCount || 0) < Number(req.numGpus || 1)) continue;
                const price = priceOf(gpu);
                if (Number(price) > Number(req.maxPricePerHour)) continue;
                for (const dc of (gpu.dataCenters || [])) {
                    if (dc.availability !== undefined && !dc.availability) continue;
                    offers.push({
                        id: String(gpu.id) + ':' + String(dc.id),
                        marketplace: 'runpod',
                        gpu_type_id: String(gpu.id),
                        data_center_id: String(dc.id),
                        gpu_name: name,
                        gpu_ram_mb: Number(gpu.memory) || 0,
                        num_gpus: Number(req.numGpus || 1),
                        disk_gb: Number(req.diskGb || 0),
                        price_per_hour: price,
                        reliability: 1,
                        region: String(dc.name || dc.id || ''),
                    });
                }
            }
            return offers;
        },

        async createInstance(offer, spec, opts = {}) {
            const r = spec.runtime;
            const body = {
                name: 'openvibe-' + spec.key,
                image: r.image,
                gpu: { id: offer.gpu_type_id, count: spec.requirements.num_gpus },
                disk: { size: spec.requirements.disk_gb, type: 'volume' },
                ports: [String(r.port || 8000) + '/http'],
                env: [
                    'MODEL_FILE=' + ((r.weights && r.weights.file) || ''),
                    'MODEL_URL=' + (opts.weights_url || ''),
                    'MODEL_ALIAS=' + spec.model_key,
                ],
                start: true,
            };
            if (offer.data_center_id) body.dataCenterId = offer.data_center_id;
            const out = await apiJson(fetchImpl, baseUrl + '/v2/pods', { method: 'POST', body, ...auth, label: 'RunPod' });
            const remoteId = String((out && out.id) || '');
            if (!remoteId) {
                const err = new Error('RunPod answered without a pod id');
                err.status = 502;
                throw err;
            }
            return { remote_id: remoteId, endpoint: '', state: String((out && out.status) || 'PROVISIONING').toLowerCase() };
        },

        async showInstance(remoteId) {
            const out = await apiJson(fetchImpl, baseUrl + '/v2/pods/' + encodeURIComponent(remoteId), { ...auth, label: 'RunPod' });
            const status = String((out && out.status) || 'unknown').toLowerCase();
            return {
                remote_id: remoteId,
                state: status,
                endpoint: endpointOf(out, 8000),
                raw: out,
            };
        },

        async destroyInstance(remoteId) {
            const out = await apiJson(fetchImpl, baseUrl + '/v2/pods/' + encodeURIComponent(remoteId), { method: 'DELETE', ...auth, label: 'RunPod' });
            return Boolean(out);
        },
    };
}

module.exports = { runpodAdapter, BASE_URL };
