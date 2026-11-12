'use strict';
/**
 * TensorDock: marketplace VMs, on demand and spot.
 *
 * Calls follow TensorDock's public client API (dashboard.tensordock.com/api/docs):
 *   GET  /api/v0/client/list_gpus          the cards hosts offer
 *   POST /api/v0/client/deploy/single      deploy one VM; spot uses price_type "spot" and a bid
 *   GET  /api/v0/client/list_instances     the VMs on the account and their state
 *   POST /api/v0/client/deploy/{id}/delete delete a VM
 *
 * TensorDock spot instances are bids: the spot price is per virtual machine, not per GPU, and an
 * outbid VM is stopped while its storage keeps billing (docs.tensordock.com/virtual-machines/spot-instances).
 * The key goes in the Authorization header; no request carries the key in a URL.
 */
const { apiJson } = require('./http');

const BASE_URL = 'https://dashboard.tensordock.com/api/v0';

function vramOf(gpu) {
    const explicit = Number(gpu && (gpu.vram_gb || gpu.ram_gb));
    if (Number.isFinite(explicit) && explicit > 0) return explicit * 1024;
    const text = String((gpu && (gpu.model || gpu.name)) || '').toLowerCase();
    const m = /(\d{2})\s*gb/.exec(text);
    return m ? Number(m[1]) * 1024 : 0;
}

/** A TensorDock adapter: searchOffers, createInstance, showInstance, destroyInstance. */
function tensordockAdapter({ fetchImpl = globalThis.fetch, key = null, image = 'ubuntu22.04', location = '', baseUrl = BASE_URL } = {}) {
    const auth = { key, label: 'TensorDock' };

    return {
        id: 'tensordock',
        label: 'TensorDock',
        baseUrl,

        async searchOffers(req = {}) {
            const out = await apiJson(fetchImpl, baseUrl + '/client/list_gpus', auth);
            const gpus = Array.isArray(out) ? out : ((out && (out.gpus || out.data)) || []);
            const wanted = (req.gpuNames || []).map((n) => String(n).toLowerCase());
            const offers = [];
            for (const gpu of gpus) {
                const name = String(gpu.model || gpu.name || gpu.gpu || '');
                const lower = name.toLowerCase();
                if (wanted.length && !wanted.some((w) => lower.includes(w) || w.includes(lower))) continue;
                const vram = vramOf(gpu);
                if (req.vramMb && vram && vram < Number(req.vramMb)) continue;
                const count = Number(gpu.num_gpus || gpu.count || 1);
                if (count < Number(req.numGpus || 1)) continue;
                const onDemand = gpu.price_per_hour != null ? String(gpu.price_per_hour) : (gpu.price != null ? String(gpu.price) : '');
                const spot = gpu.spot_price != null ? String(gpu.spot_price) : '';
                const price = req.interruptible ? spot : onDemand;
                if (!(Number(price) > 0)) continue;
                if (req.maxPricePerHour && Number(price) > Number(req.maxPricePerHour)) continue;
                offers.push({
                    id: String(gpu.id || gpu.gpu_id || name),
                    marketplace: 'tensordock',
                    gpu_name: name,
                    gpu_ram_mb: vram,
                    num_gpus: count,
                    disk_gb: Number(gpu.storage || req.diskGb || 0),
                    price_per_hour: price,
                    reliability: 0.98,
                    region: String(gpu.location || gpu.location_code || location || ''),
                    location_code: String(gpu.location || gpu.location_code || location || ''),
                    interruptible: Boolean(req.interruptible),
                });
            }
            return offers;
        },

        async createInstance(offer, spec, opts = {}) {
            const body = {
                gpu_model: String(offer.gpu_name),
                gpu_count: Number(offer.num_gpus) || 1,
                gpu_ram: Number(offer.gpu_ram_mb) || 0,
                cpu_cores: 4,
                ram: 16,
                storage: Math.max(50, Number(spec.requirements && spec.requirements.disk_gb) || 50),
                operating_system: String((spec.runtime && spec.runtime.image) || image),
                price_type: offer.interruptible || opts.interruptible ? 'spot' : 'ondemand',
                // A spot deployment sets its bid; on-demand pays the host's price.
                ...(offer.interruptible || opts.interruptible ? { price: String(offer.price_per_hour) } : {}),
                location: offer.location_code || location || undefined,
                name: String(opts.label || ('openvibe-' + spec.key)),
                port_forwards: [{ internal_port: 8000, external_port: 8000, protocol: 'http' }],
            };
            const out = await apiJson(fetchImpl, baseUrl + '/client/deploy/single', { ...auth, method: 'POST', body });
            const remoteId = String((out && (out.vm_id || out.id || (out.data && (out.data.vm_id || out.data.id)))) || '');
            return { remote_id: remoteId, endpoint: '', state: 'starting', raw: out };
        },

        async showInstance(remoteId) {
            const out = await apiJson(fetchImpl, baseUrl + '/client/list_instances', { ...auth, allowMissing: true });
            const list = (out && (out.instances || out.data)) || [];
            const found = (Array.isArray(list) ? list : Object.values(list)).find((x) => String(x.id || x.vm_id) === String(remoteId));
            if (!found) return { remote_id: remoteId, state: 'deleted', deleted: true, endpoint: '' };
            const state = String(found.status || found.state || 'unknown').toLowerCase();
            const host = found.ip || found.host || (found.port_forwards && found.port_forwards[0] && found.port_forwards[0].host);
            const port = Number(found.port || (found.port_forwards && found.port_forwards[0] && found.port_forwards[0].external_port)) || 8000;
            return {
                remote_id: remoteId,
                state: state === 'running' ? 'running' : (['deploying', 'starting', 'pending', 'provisioning'].includes(state) ? 'starting' : state),
                endpoint: host ? 'http://' + host + ':' + port : '',
                outbid: /outbid|preempt|spot.*(stopped|evicted)/.test(String(found.status || found.state || '') + ' ' + String(found.message || '')),
                raw: found,
            };
        },

        async destroyInstance(remoteId) {
            const out = await apiJson(fetchImpl, baseUrl + '/client/deploy/' + encodeURIComponent(remoteId) + '/delete', { ...auth, method: 'POST', allowMissing: true });
            return Boolean(out === null || out.missing || out.success !== false);
        },
    };
}

module.exports = { tensordockAdapter, BASE_URL };
