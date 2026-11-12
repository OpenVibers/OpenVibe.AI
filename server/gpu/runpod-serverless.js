'use strict';
/**
 * RunPod Serverless: flex workers that scale to zero, with RunPod's OpenAI-compatible vLLM endpoint.
 *
 * From RunPod's REST v2 API and docs (docs.runpod.io/api-reference-v2/serverless):
 *   POST   /v2/serverless          create an endpoint {name, templateId, type:"QUEUE", gpu:{pools},
 *                                  workers:{min,max,idleTimeout}, scaling}
 *   GET    /v2/serverless/{id}     the endpoint and its worker/status settings
 *   DELETE /v2/serverless/{id}     delete the endpoint and terminate its workers
 *
 * The inference URL is https://api.runpod.ai/v2/{id}/openai/v1 (docs.runpod.io/serverless/vllm/overview).
 * Flex prices are per second; the table is RunPod's own (runpod.io/pricing via
 * docs.runpod.io/serverless/endpoints/endpoint-configurations, checked 2026-11-11).
 *
 * Nothing here creates an endpoint until the owner has a template and a key. min workers stays 0 so an
 * idle endpoint costs nothing; the provisioner scales nothing by itself except through create/destroy.
 */
const { apiJson } = require('./http');

const BASE_URL = 'https://api.runpod.io';
const INFERENCE_URL = 'https://api.runpod.ai';
// Flex rates per GPU-hour, by the pools RunPod publishes. The 24 GB pool is the L4/A5000/3090 class.
const POOLS = Object.freeze([
    { pool: 'ADA_24', gpu_name: 'RTX 4090', hourly: '1.10', vram_mb: 24576 },
    { pool: 'AMPERE_24', gpu_name: 'L4 / A5000 / RTX 3090', hourly: '0.69', vram_mb: 24576 },
    { pool: 'AMPERE_48', gpu_name: 'A6000 / A40', hourly: '1.22', vram_mb: 49152 },
    { pool: 'ADA_48_PRO', gpu_name: 'L40 / L40S / 6000 Ada', hourly: '1.75', vram_mb: 49152 },
    { pool: 'AMPERE_80', gpu_name: 'A100 80GB', hourly: '2.72', vram_mb: 81920 },
    { pool: 'HOPPER_80', gpu_name: 'H100 80GB', hourly: '4.79', vram_mb: 81920 },
    { pool: 'HOPPER_141', gpu_name: 'H200 141GB', hourly: '5.93', vram_mb: 141312 },
]);

/** A RunPod Serverless adapter: searchOffers, createInstance, showInstance, destroyInstance. */
function runpodServerlessAdapter({ fetchImpl = globalThis.fetch, key = null, templateId = '', pools = [], maxWorkers = 3, baseUrl = BASE_URL } = {}) {
    const auth = { key, label: 'RunPod Serverless' };
    const openaiBaseUrl = (id) => INFERENCE_URL + '/v2/' + encodeURIComponent(id) + '/openai/v1';
    const adapter = {
        id: 'runpod_serverless',
        label: 'RunPod Serverless',
        baseUrl,
        inferenceUrl: INFERENCE_URL,
        billing: 'per second, rounded up from worker start to stop',

        /** The OpenAI-compatible vLLM base URL of an endpoint. */
        openaiBaseUrl,

        async searchOffers(req = {}) {
            if (!templateId) return [];
            const wanted = (req.gpuNames || []).map((n) => String(n).toUpperCase());
            return POOLS.filter((p) => !pools.length || pools.includes(p.pool))
                .filter((p) => !wanted.length || wanted.some((w) => p.gpu_name.toUpperCase().includes(w) || w.includes(p.gpu_name.toUpperCase())))
                .filter((p) => !req.vramMb || p.vram_mb >= Number(req.vramMb))
                .filter((p) => !req.maxPricePerHour || Number(p.hourly) <= Number(req.maxPricePerHour))
                .map((p) => ({
                    id: p.pool,
                    marketplace: 'runpod_serverless',
                    gpu_name: p.gpu_name,
                    gpu_ram_mb: p.vram_mb,
                    num_gpus: 1,
                    disk_gb: Number(req.diskGb) || 0,
                    price_per_hour: p.hourly,
                    reliability: 0.99,
                    region: '',
                    interruptible: false,
                    template_id: templateId,
                }));
        },

        async createInstance(offer, spec, opts = {}) {
            const body = {
                name: String(opts.label || ('openvibe-' + spec.key)).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50),
                templateId: String(offer.template_id || templateId),
                type: 'QUEUE',
                gpu: { pools: [String(offer.id)] },
                // Scale to zero: no idle worker is paid for; a request brings one up.
                workers: { min: 0, max: Math.max(1, Math.min(10, Number(maxWorkers) || 3)), idleTimeout: 5 },
                scaling: { type: 'QUEUE_DELAY', queueDelay: 4 },
            };
            const out = await apiJson(fetchImpl, baseUrl + '/v2/serverless', { ...auth, method: 'POST', body });
            const id = String((out && out.id) || '');
            return { remote_id: id, endpoint: id ? openaiBaseUrl(id) : '', state: String((out && out.status) || 'starting'), raw: out };
        },

        async showInstance(remoteId) {
            const out = await apiJson(fetchImpl, baseUrl + '/v2/serverless/' + encodeURIComponent(remoteId), { ...auth, allowMissing: true });
            if (!out || out.missing) return { remote_id: remoteId, state: 'deleted', deleted: true, endpoint: '' };
            const workers = out.workers || {};
            return {
                remote_id: remoteId,
                state: 'running',
                endpoint: openaiBaseUrl(remoteId),
                workers: { min: Number(workers.min) || 0, max: Number(workers.max) || 0 },
                raw: out,
            };
        },

        async destroyInstance(remoteId) {
            const out = await apiJson(fetchImpl, baseUrl + '/v2/serverless/' + encodeURIComponent(remoteId), { ...auth, method: 'DELETE', allowMissing: true });
            return Boolean(out === null || out.missing || out.deleted !== false);
        },
    };
    return adapter;
}

module.exports = { runpodServerlessAdapter, BASE_URL, POOLS };
