'use strict';
/**
 * Vast.ai: the marketplace for consumer GPUs (the RTX 3090/4090 that fit a 32B Q4 distill).
 *
 * The calls are the ones the Vast API documents:
 *   POST   /api/v0/bundles          search the offers
 *   POST   /api/v0/asks/{id}/       rent an offer (the answer's new_contract is the instance id)
 *   GET    /api/v0/instances/{id}   the instance (its actual_status and its ports)
 *   DELETE /api/v0/instances/{id}   give the instance back
 *
 * The API key goes in the Authorization header and nowhere else.
 */
const { apiJson } = require('./http');

const BASE_URL = 'https://console.vast.ai';

/** A Vast adapter: searchOffers, createInstance, showInstance, destroyInstance. */
function vastAdapter({ fetchImpl = globalThis.fetch, key = null, baseUrl = BASE_URL } = {}) {
    const auth = { key };

    /** The endpoint of a running instance: its proxy URL, or the direct address. */
    function endpointOf(instance, port) {
        const ports = (instance && instance.ports) || {};
        const p = ports[port] || ports[String(port)];
        if (p && p.proxy) return String(p.proxy);
        const host = instance.ssh_node || instance.ssh_host || instance.public_ip || instance.ip;
        const pr = p && p.port ? p.port : port;
        if (host && pr) return 'http://' + host + ':' + pr;
        return '';
    }

    return {
        id: 'vast',
        label: 'Vast.ai',
        baseUrl,

        async searchOffers(req) {
            const body = {
                type: 'ondemand',
                verified: { eq: true },
                rentable: { eq: true },
                gpu_name: { in: req.gpuNames },
                reliability: { gte: req.minReliability },
                num_gpus: { gte: req.numGpus },
                gpu_ram: { gte: req.vramMb },
                disk_space: { gte: req.diskGb },
                dph_total: { lte: req.maxPricePerHour },
                geolocation: { in: [req.region] },
                limit: req.limit || 50,
            };
            const out = await apiJson(fetchImpl, baseUrl + '/api/v0/bundles', { method: 'POST', body, ...auth, label: 'Vast.ai' });
            const offers = (out && out.offers) || [];
            return offers.map((o) => ({
                id: String(o.id),
                marketplace: 'vast',
                gpu_name: String(o.gpu_name || ''),
                gpu_ram_mb: Number(o.gpu_ram) || 0,
                num_gpus: Number(o.num_gpus) || 1,
                disk_gb: Number(o.disk_space) || 0,
                price_per_hour: String(o.dph_total == null ? '0' : o.dph_total),
                reliability: Number(o.reliability) || 0,
                region: String(o.geolocation || ''),
            }));
        },

        /**
         * The instances of this account that carry our label. Vast lists them at GET /api/v1/instances
         * (25 per page, keyset pagination); the sweep reads them to find the ones no live row owns.
         */
        async listInstances() {
            const out = [];
            let after = null;
            for (let page = 0; page < 20; page++) {
                const url = baseUrl + '/api/v1/instances?limit=25&select_cols=id,label,actual_status,dph_total'
                    + (after ? '&after_token=' + encodeURIComponent(after) : '');
                const body = await apiJson(fetchImpl, url, { ...auth, label: 'Vast.ai' });
                const list = (body && (body.instances || body.results || body.data)) || [];
                for (const inst of list) {
                    out.push({
                        id: String(inst.id == null ? '' : inst.id),
                        label: String(inst.label || ''),
                        state: String(inst.actual_status || inst.status || 'unknown').toLowerCase(),
                        price_per_hour: inst.dph_total == null ? '' : String(inst.dph_total),
                    });
                }
                after = body && body.next_token;
                if (!after) break;
            }
            return out;
        },

        async createInstance(offer, spec, opts = {}) {
            const r = spec.runtime;
            const body = {
                image: r.image,
                args: opts.command || '',
                env: {
                    MODEL_FILE: (r.weights && r.weights.file) || '',
                    MODEL_URL: opts.weights_url || '',
                    MODEL_ALIAS: spec.model_key,
                },
                disk: spec.requirements.disk_gb,
                runtype: 'args',
                // the label carries our row id: the sweep finds the instance again and gives it back
                // when no live row of ours owns it.
                label: String(opts.label || ('openvibe-' + spec.key)),
            };
            const out = await apiJson(fetchImpl, baseUrl + '/api/v0/asks/' + offer.id + '/', { method: 'PUT', body, ...auth, label: 'Vast.ai' });
            if (!out || out.success === false) {
                const err = new Error('Vast.ai did not rent the offer');
                err.status = 502;
                throw err;
            }
            const remoteId = String(out.new_contract || out.id || '');
            if (!remoteId) {
                const err = new Error('Vast.ai answered without an instance id');
                err.status = 502;
                throw err;
            }
            return { remote_id: remoteId, endpoint: '', state: 'starting' };
        },

        async showInstance(remoteId) {
            const out = await apiJson(fetchImpl, baseUrl + '/api/v0/instances/' + encodeURIComponent(remoteId), { ...auth, label: 'Vast.ai' });
            const instance = out && out.instances ? out.instances : out;
            const status = String((instance && (instance.actual_status || instance.status)) || 'unknown');
            return {
                remote_id: remoteId,
                state: status,
                endpoint: endpointOf(instance, (opts_port(instance))),
                raw: out,
            };
        },

        async destroyInstance(remoteId) {
            const out = await apiJson(fetchImpl, baseUrl + '/api/v0/instances/' + encodeURIComponent(remoteId), { method: 'DELETE', ...auth, label: 'Vast.ai' });
            return Boolean(out && out.success !== false);
        },
    };
}

// The port a Vast instance serves on is in its ports map; the first one that is not SSH is the app.
function opts_port(instance) {
    const ports = (instance && instance.ports) || {};
    for (const key of Object.keys(ports)) {
        const n = Number(key);
        if (Number.isFinite(n) && n >= 8000) return n;
    }
    return 8000;
}

module.exports = { vastAdapter, BASE_URL };
