'use strict';
/**
 * SaladCloud: consumer GPUs for interruptible batch work.
 *
 * From SaladCloud's public API (docs.salad.com/reference/api-usage; the OpenAPI lives at
 * github.com/SaladTechnologies/salad-cloud-docs/tree/main/api-specs):
 *   GET    /organizations/{org}/gpu-classes                 the cards and their prices per priority
 *   POST   /organizations/{org}/projects/{project}/containers        create a container group
 *   GET    /organizations/{org}/projects/{project}/containers/{name} the group and its state
 *   DELETE /organizations/{org}/projects/{project}/containers/{name} delete it
 *   POST   /organizations/{org}/projects/{project}/queues/{queue}/jobs   submit a batch job
 *   GET    /organizations/{org}/projects/{project}/queues/{queue}/jobs/{id}
 *   DELETE /organizations/{org}/projects/{project}/queues/{queue}/jobs/{id}
 *
 * The key goes in the `Salad-Api-Key` header and nowhere else. Salad's own guidance is three
 * replicas for availability; that is the owner's default for batch (three at $0.16 is $0.48/hour).
 */
const { apiJson } = require('./http');

const BASE_URL = 'https://api.salad.com/api/public';
const AUTH = { keyHeader: 'Salad-Api-Key', keyPrefix: '' };
// The GPU class name is the only identity Salad returns for a card; this is the VRAM floor used to
// match a model's requirement. Unknown cards get 0 and are filtered by the caller's own check.
const VRAM_MB = Object.freeze({ '3090': 24576, '4090': 24576, '5090': 32768, 'l40': 49152, 'l40s': 49152, 'a100': 81920, 'h100': 81920 });

function vramOf(name) {
    const text = String(name || '').toLowerCase();
    for (const [needle, mb] of Object.entries(VRAM_MB)) if (text.includes(needle)) return mb;
    return 0;
}

function moneyOf(value) {
    const m = /([0-9]+(?:\.[0-9]+)?)/.exec(String(value == null ? '' : value));
    return m ? m[1] : '0';
}

/** A SaladCloud adapter: searchOffers, createInstance, showInstance, destroyInstance. */
function saladAdapter({ fetchImpl = globalThis.fetch, key = null, organization = '', project = '', image = '', replicas = 3, baseUrl = BASE_URL } = {}) {
    const auth = { ...AUTH, key, label: 'SaladCloud' };
    const orgPath = `${baseUrl}/organizations/${encodeURIComponent(organization)}`;
    const projectPath = `${orgPath}/projects/${encodeURIComponent(project)}`;

    function requireNames() {
        if (!organization || !project) {
            const err = new Error('SaladCloud needs the owner\'s organization and project names');
            err.status = 422;
            throw err;
        }
    }

    return {
        id: 'salad',
        label: 'SaladCloud',
        baseUrl,
        // SaladCloud is batch only: its lower tiers are preemptible and it documents itself as
        // unsuitable for real-time user requests.
        batchOnly: true,

        async searchOffers(req = {}) {
            requireNames();
            const out = await apiJson(fetchImpl, orgPath + '/gpu-classes', auth);
            const wanted = (req.gpuNames || []).map((n) => String(n).toLowerCase());
            const offers = [];
            for (const gpu of (out && out.items) || []) {
                const name = String(gpu.name || '');
                const vram = vramOf(name);
                if (req.vramMb && vram && vram < Number(req.vramMb)) continue;
                if (wanted.length && !wanted.some((w) => name.toLowerCase().includes(w) || w.includes(name.toLowerCase()))) continue;
                const prices = Array.isArray(gpu.prices) ? gpu.prices : [];
                // The owner's cheapest (batch/lowest) tier for interruptible jobs; the high tier when
                // the job may not be interrupted. Salad keeps serving an existing group at its tier.
                const preferred = req.interruptible ? ['batch', 'low', 'medium', 'high'] : ['high', 'medium', 'low', 'batch'];
                const priceRow = preferred.map((p) => prices.find((x) => x.priority === p)).find(Boolean) || prices[0];
                if (!priceRow) continue;
                const price = moneyOf(priceRow.price);
                if (!(Number(price) > 0)) continue;
                offers.push({
                    id: String(gpu.id || name),
                    marketplace: 'salad',
                    gpu_name: name,
                    gpu_ram_mb: vram,
                    num_gpus: Number(gpu.gpu_count) || 1,
                    disk_gb: Number(req.diskGb) || 0,
                    price_per_hour: price,
                    reliability: 0.95,
                    region: '',
                    interruptible: Boolean(req.interruptible),
                    priority: priceRow.priority,
                    replicas: Number(gpu.gpu_count) > 1 ? replicas : replicas,
                });
            }
            return offers;
        },

        async createInstance(offer, spec, opts = {}) {
            requireNames();
            const name = String(opts.label || ('openvibe-' + spec.key)).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63);
            const imageName = String(image || (spec.runtime && spec.runtime.image) || '');
            if (!imageName) throw Object.assign(new Error('SaladCloud needs a container image for the model'), { status: 422 });
            const ports = [8000, 8080, 5000, 8888];
            const body = {
                name,
                display_name: name,
                replicas: Math.max(1, Math.min(10, Number(opts.replicas || offer.replicas || replicas) || 3)),
                autostart_policy: true,
                restart_policy: 'always',
                container: {
                    image: imageName,
                    priority: offer.interruptible ? 'batch' : 'high',
                    command: opts.command ? ['sh', '-lc', String(opts.command)] : undefined,
                    environment_variables: {
                        MODEL_ALIAS: String(spec.model_key || spec.key || ''),
                        MODEL_URL: String(opts.weights_url || ''),
                    },
                    resources: {
                        cpu: 4,
                        memory: 8192,
                        gpu_classes: [String(offer.id)],
                        storage_amount: Math.max(1073741824, (Number(spec.requirements && spec.requirements.disk_gb) || 50) * 1073741824),
                    },
                },
                // A readiness probe on a few common ports is harmless; the caller health-checks the
                // endpoint it actually reached after create.
                networking: { protocol: 'http', port: 8000, auth: false },
            };
            const created = await apiJson(fetchImpl, projectPath + '/containers', { ...auth, method: 'POST', body });
            return {
                remote_id: String((created && created.name) || name),
                endpoint: String((created && created.networking && created.networking.dns) || (created && created.endpoint) || ''),
                state: 'starting',
            };
        },

        async showInstance(remoteId) {
            requireNames();
            const out = await apiJson(fetchImpl, projectPath + '/containers/' + encodeURIComponent(remoteId), { ...auth, allowMissing: true });
            if (!out || out.missing) return { remote_id: remoteId, state: 'deleted', deleted: true, endpoint: '' };
            const state = String((out.current_state && out.current_state.status) || out.status || 'unknown');
            const networking = out.networking || {};
            return {
                remote_id: remoteId,
                state: state === 'running' ? 'running' : (state === 'failed' ? 'failed' : state),
                endpoint: String(networking.dns || networking.url || ''),
                raw: out,
            };
        },

        async destroyInstance(remoteId) {
            requireNames();
            const out = await apiJson(fetchImpl, projectPath + '/containers/' + encodeURIComponent(remoteId), { ...auth, method: 'DELETE', allowMissing: true });
            return Boolean(out === null || out.missing || out.removed === undefined || out.removed !== false);
        },
    };
}

/**
 * SaladCloud's job queue: the batch adapter for work its container groups pick up. A job is the
 * provider's own unit (input, status, output); nothing here rents a container.
 */
function saladQueueAdapter({ fetchImpl = globalThis.fetch, key = null, organization = '', project = '', queue = '', baseUrl = BASE_URL } = {}) {
    const auth = { ...AUTH, key, label: 'SaladCloud queue' };
    const path = `${baseUrl}/organizations/${encodeURIComponent(organization)}/projects/${encodeURIComponent(project)}/queues/${encodeURIComponent(queue)}/jobs`;
    return {
        id: 'salad_queue',
        label: 'SaladCloud queue',
        async submitJob(input, { webhook = null, metadata = null } = {}) {
            const out = await apiJson(fetchImpl, path, { ...auth, method: 'POST', body: { input, ...(webhook ? { webhook } : {}), ...(metadata ? { metadata } : {}) } });
            return { id: String((out && out.id) || ''), status: String((out && out.status) || 'pending') };
        },
        async showJob(id) {
            const out = await apiJson(fetchImpl, path + '/' + encodeURIComponent(id), { ...auth, allowMissing: true });
            if (!out || out.missing) return { id, status: 'missing' };
            return { id: String(out.id), status: String(out.status || 'unknown'), output: out.output || null, events: out.events || [] };
        },
        async cancelJob(id) {
            const out = await apiJson(fetchImpl, path + '/' + encodeURIComponent(id), { ...auth, method: 'DELETE', allowMissing: true });
            return Boolean(out === null || out.missing || out.status !== 'failed');
        },
    };
}

module.exports = { saladAdapter, saladQueueAdapter, BASE_URL };
