'use strict';
/**
 * Your own endpoint (the Exchange remake, product line 6 / build order 7).
 *
 * A person picks one of the GPU provisioner's models or brings their own Hugging Face weights (and an
 * optional LoRA), and gets a private OpenAI-compatible endpoint on a rented GPU. The rent is the
 * existing gpu_instances row: the same cheapest-fit search, the same owner monthly cap, the same
 * marketplace and the same scale-to-zero sweep (server/gpu/provisioner.js). What this module adds:
 *
 *   - the endpoint row (migration 0039) and its owner;
 *   - a Billing hold before the marketplace is called, of the worst case the rent may cost, and a
 *     settle of the exact seconds when it stops. Billing is the only ledger: no money is written here;
 *   - privacy: a private rent is never registered as an offer, so the router and the catalogue never
 *     see it. Its owner reaches it through AI's proxy, and only with their own Network token;
 *   - the public status the Exchange page reads, with the plain reason the feature is off.
 *
 * The feature is off while ANY of these is true, and every one of them is an owner setting:
 *
 *   1. no GPU marketplace key (ai.gpus vast.key / runpod.key),
 *   2. no monthly GPU cap (ai.gpus monthly_cap),
 *   3. Balance billing is not on (AI_CREDITS + Billing), because an endpoint must be paid for.
 *
 * Nothing here reaches a GPU provider in a test: the marketplace calls go through the provisioner's
 * injected fetch (the recorded answers in test/fixtures/gpu), and Billing through the Credits manager's.
 */
const { ids } = require('openvibe-contracts');
const { AiError, sha256, iso } = require('../util');
const money = require('./money');
const catalog = require('./catalog');

const ACTIVE = ['requested', 'starting', 'running', 'stopping'];
const LIVE = ['starting', 'running', 'stopping'];
const MAX_ACTIVE = 2;
const MAX_IDLE_MINUTES = 120;
const MAX_RUNTIME_MINUTES = 120;
const WEIGHTS_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const WEIGHTS_FILE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,180}\.gguf$/;
const BILLING_OFF = 'Balance billing is not on yet, so an endpoint cannot be paid for. The owner must turn on Balance first.';

function plainGpuReason(reason) {
    if (reason === 'no Vast.ai or RunPod API key') return 'The owner has not added a GPU provider key (Vast.ai or RunPod) yet, so no endpoint can start.';
    if (reason === 'no monthly cap') return 'The owner has not set a monthly GPU cap yet, so no endpoint can start.';
    return 'The GPU provider is not set up yet, so no endpoint can start.';
}

/** A short, plain sentence for why a rent stopped. The status line is a sentence, never a code. */
function reasonText(reason) {
    const r = String(reason || '');
    if (r === 'idle') return 'Stopped after it sat idle; it scales to zero when nobody uses it.';
    if (r === 'the owner stopped it') return 'Stopped.';
    if (r === 'the reservation ran out') return 'Stopped: the time it was paid for ran out.';
    if (r === 'the endpoint stopped answering' || r === 'the endpoint never answered') return 'Stopped because the GPU stopped answering.';
    if (/^the instance /.test(r)) return 'Stopped because the GPU instance ' + r.slice('the instance '.length) + '.';
    return 'Stopped.';
}

function clamp(value, min, max, fallback) {
    if (value == null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
}

/**
 * The module. `credits` is AI's Credits facade (server/index.js): `credits.enabled` is the live
 * AI_CREDITS flag and `credits.manager` the client to Billing's hold/settle API.
 */
function createOwnEndpoints({ db, gpus, credits, settings, config = null, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, log = console, models = catalog.list() } = {}) {
    const now = () => clock.now();
    const at = (ms) => new Date(ms).toISOString();
    const byKey = new Map((models || []).map((m) => [m.key, m]));

    function manager() {
        return credits && credits.enabled && credits.manager ? credits.manager : null;
    }

    function gpuConfig() {
        return gpus && typeof gpus.config === 'function' ? gpus.config() : { enabled: false, reason: 'no Vast.ai or RunPod API key', idle_minutes: 10, max_runtime_minutes: 720, vast_key: '', runpod_key: '' };
    }

    /** The public status the Exchange page reads: on, or off with a plain sentence. */
    function status() {
        const cfg = gpuConfig();
        const billing = Boolean(manager());
        const reasons = [];
        if (!cfg.enabled) reasons.push(plainGpuReason(cfg.reason));
        if (!billing) reasons.push(BILLING_OFF);
        const marketplace = cfg.vast_key ? 'vast' : (cfg.runpod_key ? 'runpod' : null);
        return {
            enabled: Boolean(cfg.enabled && billing),
            reason: reasons.join(' '),
            reasons,
            marketplace,
            billing,
            models: (models || []).map((m) => ({
                key: m.key, display_name: m.display_name, context_window: m.context_window,
                vram_mb: m.requirements && m.requirements.vram_mb,
                gpu_names: (m.requirements && m.requirements.gpu_names) || [],
            })),
            idle_minutes: cfg.idle_minutes,
            max_idle_minutes: MAX_IDLE_MINUTES,
            max_runtime_minutes: Math.min(cfg.max_runtime_minutes || MAX_RUNTIME_MINUTES, MAX_RUNTIME_MINUTES),
            public_base: publicBase(),
        };
    }

    function publicBase() {
        const base = String((config && config.baseUrl) || '').replace(/\/+$/, '');
        return (base || 'https://ai.openvibe.services') + '/api/v1/own-endpoints';
    }

    async function rowById(id) {
        return (await db.prepare('SELECT * FROM own_endpoints WHERE id = ?').get(String(id))) || null;
    }

    async function ownedRow(subject, id) {
        const row = await rowById(id);
        if (!row || row.subject !== String(subject)) throw new AiError(404, 'own_endpoint.not_found', 'no such endpoint');
        return row;
    }

    async function liveFor(id, statuses = LIVE) {
        return (await db.prepare(`SELECT * FROM gpu_instances WHERE own_endpoint_id = ? AND status IN (${statuses.map(() => '?').join(', ')}) ORDER BY created_at DESC LIMIT 1`)
            .get(String(id), ...statuses)) || null;
    }

    /** What the Exchange page and its owner see. */
    function describe(row, instance = null) {
        if (!row) return null;
        return {
            id: row.id,
            status: row.status,
            source: row.source,
            display_name: row.display_name,
            catalog_key: row.catalog_key,
            weights: row.source === 'weights' ? { repo: row.weights_repo, file: row.weights_file, lora_repo: row.lora_repo, lora_file: row.lora_file } : null,
            idle_minutes: Number(row.idle_minutes),
            max_runtime_minutes: Number(row.max_runtime_minutes),
            marketplace: row.marketplace,
            price_per_hour: row.price_per_hour,
            hourly_nano: row.hourly_nano == null ? null : String(row.hourly_nano),
            reserved_nano: String(row.reserved_nano == null ? '0' : row.reserved_nano),
            charged_nano: String(row.charged_nano == null ? '0' : row.charged_nano),
            url: row.url || (publicBase() + '/' + row.id + '/v1'),
            model: row.id,
            instance: instance ? {
                status: instance.status, gpu_name: instance.gpu_name, region: instance.region,
                cold_start_ms: instance.cold_start_ms == null ? null : String(instance.cold_start_ms),
                started_at: instance.started_at, ready_at: instance.ready_at,
                last_used_at: instance.last_used_at,
            } : null,
            month: row.month,
            error: row.error,
            reason: row.error || null,
            created_at: row.created_at,
            ready_at: row.ready_at,
            stopped_at: row.stopped_at,
        };
    }

    async function describeWithInstance(row) {
        return describe(row, row.instance_id ? await db.prepare('SELECT * FROM gpu_instances WHERE id = ?').get(row.instance_id) : null);
    }

    async function list(subject) {
        const rows = await db.prepare('SELECT * FROM own_endpoints WHERE subject = ? ORDER BY created_at DESC').all(String(subject));
        const out = [];
        for (const row of rows || []) out.push(await describeWithInstance(row));
        return out;
    }

    async function get(subject, id) {
        return describeWithInstance(await ownedRow(subject, id));
    }

    /** The spec the provisioner serves for this endpoint. A private rent is never registered. */
    function specFor(row) {
        if (!row) return null;
        const cfg = gpuConfig();
        const marketplace = cfg.vast_key ? 'vast' : (cfg.runpod_key ? 'runpod' : 'vast');
        const key = 'own-' + row.id;
        if (row.source === 'catalog') {
            const base = byKey.get(row.catalog_key) || catalog.find(row.catalog_key);
            if (!base) return null;
            return {
                ...base,
                key,
                provider_key: key,
                model_key: key,
                marketplace,
                display_name: 'Your ' + (base.display_name || base.key),
            };
        }
        const weightsUrl = 'https://huggingface.co/' + row.weights_repo + '/resolve/main/' + encodeURIComponent(row.weights_file).replace(/%2F/g, '/');
        const loraUrl = row.lora_repo ? 'https://huggingface.co/' + row.lora_repo + '/resolve/main/' + encodeURIComponent(row.lora_file).replace(/%2F/g, '/') : null;
        const ctx = Number(row.context_window) || 8192;
        const command = 'mkdir -p /models'
            + ' && curl -fL --retry 3 -o /models/' + row.weights_file + ' ' + weightsUrl
            + (loraUrl ? ' && curl -fL --retry 3 -o /models/' + row.lora_file + ' ' + loraUrl : '')
            + ' && exec /app/llama-server --model /models/' + row.weights_file
            + ' --host 0.0.0.0 --port 8000 --alias ' + key
            + ' --ctx-size ' + ctx + ' --n-gpu-layers 999'
            + (loraUrl ? ' --lora /models/' + row.lora_file : '');
        return {
            key,
            provider_key: key,
            model_key: key,
            marketplace,
            display_name: row.display_name || 'Your model',
            context_window: ctx,
            throughput_tokens_per_hour: 180000,
            requirements: { vram_mb: 22000, disk_gb: 60, gpu_names: ['RTX 3090', 'RTX 4090'], num_gpus: 1, min_reliability: 0.98 },
            runtime: { kind: 'llama.cpp', image: 'ghcr.io/ggml-org/llama.cpp:server-cuda', port: 8000, weights: { repo: row.weights_repo, file: row.weights_file }, command },
        };
    }

    /** Validate what a person asked for and write the request row. The reconciler starts it. */
    async function create({ subject, body = {} }) {
        const st = status();
        if (!st.enabled) throw new AiError(409, 'own_endpoint.off', st.reason || 'Your own endpoint is off.');
        const cfg = gpuConfig();
        const active = await db.prepare(`SELECT COUNT(*) AS n FROM own_endpoints WHERE subject = ? AND status IN (${ACTIVE.map(() => '?').join(', ')})`)
            .get(String(subject), ...ACTIVE);
        if (Number(active && active.n) >= MAX_ACTIVE) throw new AiError(409, 'own_endpoint.limit', 'You already have ' + MAX_ACTIVE + ' endpoints running or starting. Stop one first.');

        const wantsCatalog = body.model != null && body.model !== '';
        const wantsWeights = body.weights && typeof body.weights === 'object';
        if (wantsCatalog === wantsWeights) throw new AiError(422, 'input.invalid', 'name one model, or one set of weights');
        let source, spec = null, display = '', weights = null;
        if (wantsCatalog) {
            spec = byKey.get(String(body.model)) || catalog.find(String(body.model));
            if (!spec) throw new AiError(422, 'input.invalid', 'no GPU model is called ' + String(body.model).slice(0, 80));
            source = 'catalog';
            display = spec.display_name;
        } else {
            const repo = String(body.weights.repo || '').trim();
            const file = String(body.weights.file || '').trim();
            const loraRepo = body.weights.lora_repo == null ? '' : String(body.weights.lora_repo).trim();
            const loraFile = body.weights.lora_file == null ? '' : String(body.weights.lora_file).trim();
            if (!WEIGHTS_REPO.test(repo)) throw new AiError(422, 'input.invalid', 'weights.repo must be a Hugging Face repository, like "user/model-GGUF"');
            if (!WEIGHTS_FILE.test(file)) throw new AiError(422, 'input.invalid', 'weights.file must be a .gguf file name from that repository');
            if (Boolean(loraRepo) !== Boolean(loraFile)) throw new AiError(422, 'input.invalid', 'name both the LoRA repository and its .gguf file, or neither');
            if (loraRepo && !WEIGHTS_REPO.test(loraRepo)) throw new AiError(422, 'input.invalid', 'weights.lora_repo must be a Hugging Face repository');
            if (loraFile && !WEIGHTS_FILE.test(loraFile)) throw new AiError(422, 'input.invalid', 'weights.lora_file must be a .gguf file name');
            source = 'weights';
            display = String(body.display_name || repo.split('/').pop() || 'Your model').slice(0, 120);
            weights = { repo, file, loraRepo, loraFile };
        }
        const idleMinutes = clamp(body.idle_minutes, 1, MAX_IDLE_MINUTES, cfg.idle_minutes || 10);
        const maxRuntime = Math.min(cfg.max_runtime_minutes || MAX_RUNTIME_MINUTES, MAX_RUNTIME_MINUTES);
        const t = now();
        const id = 'oep_' + ids.ulid();
        await db.prepare(`INSERT INTO own_endpoints (id, subject, status, source, catalog_key, display_name, weights_repo, weights_file,
                lora_repo, lora_file, context_window, idle_minutes, max_runtime_minutes, month, created_at, updated_at)
            VALUES (?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            id, String(subject), source, spec ? spec.key : null, display,
            weights ? weights.repo : null, weights ? weights.file : null, weights ? weights.loraRepo || null : null, weights ? weights.loraFile || null : null,
            spec ? spec.context_window : 8192, idleMinutes, maxRuntime, at(t).slice(0, 7), at(t), at(t));
        return describe(await rowById(id));
    }

    /** The Billing hold of a start: the worst case the rent may cost, taken before the marketplace. */
    async function takeHold(row, { hourly, reserved, maxMinutes, marketplace, offerPrice }) {
        const mgr = manager();
        if (!mgr) throw new AiError(409, 'own_endpoint.billing_off', BILLING_OFF);
        const key = 'gpu-hold:' + row.id;
        const fingerprint = sha256([row.id, row.subject, String(hourly), String(reserved), String(maxMinutes), marketplace].join(':'));
        const hold = await mgr.hold({
            idempotency_key: key,
            subject: { type: 'user', id: row.subject },
            max_nano_usd: String(reserved),
            rate_version: 'gpu-second@1',
            request_fingerprint: fingerprint,
            service: 'ai',
        }, 'own-' + row.id);
        const holdId = hold && (hold.hold_id || hold.id);
        if (!holdId) throw new AiError(503, 'billing.unavailable', 'Billing did not answer with a hold');
        await db.prepare(`UPDATE own_endpoints SET billing_hold_id = ?, marketplace = ?, price_per_hour = ?, hourly_nano = ?,
                reserved_nano = ?, max_runtime_minutes = ?, updated_at = ? WHERE id = ?`)
            .run(String(holdId), marketplace, String(offerPrice || ''), String(hourly), String(reserved), Number(maxMinutes), at(now()), row.id);
        return holdId;
    }

    /** Start a requested endpoint: the provisioner searches, checks the cap, takes the hold, rents. */
    async function start(row) {
        const cfg = gpuConfig();
        if (!cfg.enabled) {
            await refuse(row.id, plainGpuReason(cfg.reason));
            return { ok: false, reason: cfg.reason };
        }
        if (!manager()) {
            await refuse(row.id, BILLING_OFF);
            return { ok: false, reason: BILLING_OFF };
        }
        const spec = specFor(row);
        if (!spec) {
            await refuse(row.id, 'The model this endpoint asked for is no longer available.');
            return { ok: false, reason: 'no such model' };
        }
        const res = await gpus.launchSpec(spec, {
            actor: 'user:' + row.subject,
            ownEndpointId: row.id,
            idleMinutes: row.idle_minutes,
            maxRuntimeMinutes: row.max_runtime_minutes,
            beforeCreate: async ({ offer, hourly, reserved, maxMinutes, marketplace }) => {
                await takeHold(row, { hourly, reserved, maxMinutes, marketplace, offerPrice: String(offer.price_per_hour || '') });
            },
        });
        if (!res.ok) {
            await db.prepare('UPDATE own_endpoints SET status = ?, error = ?, updated_at = ? WHERE id = ?')
                .run('refused', String(res.reason || 'it could not start').slice(0, 400), at(now()), row.id);
            await releaseHold(row, 'the endpoint did not start');
            return res;
        }
        const inst = res.instance;
        await db.prepare(`UPDATE own_endpoints SET status = 'starting', instance_id = ?, error = NULL, started_at = ?, updated_at = ? WHERE id = ?`)
            .run(String(inst.id), at(now()), at(now()), row.id);
        return res;
    }

    async function refuse(id, reason) {
        await db.prepare("UPDATE own_endpoints SET status = 'refused', error = ?, updated_at = ? WHERE id = ?").run(String(reason).slice(0, 400), at(now()), id);
    }

    async function releaseHold(row, reason) {
        if (!row || !row.billing_hold_id || row.billing_settled_at) return;
        const mgr = manager();
        if (!mgr) return;
        try {
            await mgr.release(row.billing_hold_id, 'own-' + row.id);
            await db.prepare('UPDATE own_endpoints SET billing_settled_at = ?, updated_at = ? WHERE id = ?').run(at(now()), at(now()), row.id);
        } catch (err) {
            log.warn && log.warn('[own-endpoint] releasing the hold of ' + row.id + ' failed: ' + String(err && err.message));
        }
    }

    /**
     * Settle the exact seconds of a finished rent against the person's Balance. Billing's charge is
     * ceil(units x rate / 1e6) + per_request; the seconds go in as milliseconds and the per-request
     * remainder carries the last nano, so the charge equals what the GPU ledger says it cost.
     */
    async function settle(row) {
        if (!row || row.billing_settled_at) return null;
        const inst = row.instance_id ? await db.prepare('SELECT * FROM gpu_instances WHERE id = ?').get(row.instance_id) : null;
        const spent = BigInt((inst && inst.spent_nano) || 0);
        const mgr = manager();
        if (!mgr || !row.billing_hold_id) {
            await db.prepare('UPDATE own_endpoints SET billing_settled_at = ?, updated_at = ? WHERE id = ?').run(at(now()), at(now()), row.id);
            return null;
        }
        if (spent <= 0n) {
            await releaseHold(row, 'it never ran');
            return null;
        }
        const startMs = Date.parse((inst && inst.started_at) || row.started_at || at(now()));
        const endMs = Date.parse((inst && inst.destroyed_at) || at(now()));
        const ms = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, endMs - startMs)) : 0;
        let rate = 0n;
        let perRequest = spent;
        if (ms > 0) {
            rate = (spent * 1000000n) / BigInt(ms);
            const part = (BigInt(ms) * rate + 999999n) / 1000000n;
            perRequest = spent > part ? spent - part : 0n;
        }
        const body = {
            idempotency_key: 'gpu-settle:' + row.id,
            usage: { input_tokens: ms, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 },
            retail: {
                version: 'gpu-second@1',
                nano_usd_per_m: { input: rate.toString(), cached_read: '0', cache_write: '0', output: '0' },
                per_request_nano_usd: perRequest.toString(),
            },
            supply_cost_nano_usd: spent.toString(),
            byok: false,
            attempts: [],
        };
        try {
            await mgr.settle(row.billing_hold_id, body, 'own-' + row.id);
        } catch (err) {
            if (typeof mgr.enqueueSettle === 'function') {
                await mgr.enqueueSettle({ holdId: row.billing_hold_id, requestId: 'own-' + row.id, body, error: err });
            } else {
                throw err;
            }
        }
        await db.prepare('UPDATE own_endpoints SET billing_settled_at = ?, charged_nano = ?, updated_at = ? WHERE id = ?')
            .run(at(now()), spent.toString(), at(now()), row.id);
        return spent.toString();
    }

    /** The provisioner calls this when a rent becomes ready: the public URL is the AI proxy. */
    async function ready(instanceRow, _endpoint) {
        if (!instanceRow || !instanceRow.own_endpoint_id) return;
        const url = publicBase() + '/' + instanceRow.own_endpoint_id + '/v1';
        await db.prepare("UPDATE own_endpoints SET status = 'running', endpoint = ?, url = ?, ready_at = ?, error = NULL, updated_at = ? WHERE id = ? AND status IN ('starting','requested')")
            .run(String(_endpoint || ''), url, at(now()), at(now()), instanceRow.own_endpoint_id);
    }

    /** The provisioner calls this when a private rent is given back (idle, stop, death, time). */
    async function afterDestroy(instanceRow, reason) {
        if (!instanceRow || !instanceRow.own_endpoint_id) return;
        const row = await rowById(instanceRow.own_endpoint_id);
        if (!row) return;
        const fresh = await db.prepare('SELECT * FROM gpu_instances WHERE id = ?').get(instanceRow.id);
        const failed = /answer|died|state|never|dead|error|refused/i.test(String(reason || ''));
        await db.prepare('UPDATE own_endpoints SET status = ?, stopped_at = ?, error = ?, updated_at = ? WHERE id = ?')
            .run(failed ? 'error' : 'stopped', at(now()), reasonText(reason), at(now()), row.id);
        await settle(row).catch((err) => log.warn && log.warn('[own-endpoint] the settle of ' + row.id + ' failed: ' + String(err && err.message)));
        return fresh;
    }

    /** Stop an endpoint: the reconciler gives the rent back, then the hold settles. */
    async function stop(subject, id) {
        const row = await ownedRow(subject, id);
        if (!ACTIVE.includes(row.status)) return describeWithInstance(row);
        if (row.status === 'requested' && !row.instance_id) {
            // it was never started: nothing to give back, and any hold goes with it
            await releaseHold(row, 'it never started');
            await db.prepare("UPDATE own_endpoints SET status = 'stopped', stopped_at = ?, error = NULL, updated_at = ? WHERE id = ?").run(at(now()), at(now()), row.id);
            return describeWithInstance(await rowById(row.id));
        }
        await db.prepare("UPDATE own_endpoints SET status = 'stopping', updated_at = ? WHERE id = ?").run(at(now()), row.id);
        return describeWithInstance(await rowById(row.id));
    }

    /** One pass: start the requested, stop the stopping, and settle a rent whose death the provisioner saw. */
    async function tick() {
        const rows = await db.prepare('SELECT * FROM own_endpoints ORDER BY created_at').all();
        let started = 0;
        let stopped = 0;
        let settled = 0;
        for (const row of rows || []) {
            if (row.status === 'requested') {
                const res = await start(row).catch(async (err) => {
                    await refuse(row.id, String((err && err.message) || err));
                    return { ok: false, reason: String((err && err.message) || err) };
                });
                if (res && res.ok) started += 1;
                continue;
            }
            if (row.status === 'stopping') {
                const inst = await liveFor(row.id);
                if (inst) {
                    await gpus.destroyEndpoint(row.id, 'the owner stopped it', { actor: 'user:' + row.subject }).catch(() => null);
                    stopped += 1;
                }
                const still = await liveFor(row.id);
                if (!still) {
                    await db.prepare("UPDATE own_endpoints SET status = 'stopped', stopped_at = ?, updated_at = ? WHERE id = ?").run(at(now()), at(now()), row.id);
                    await settle(await rowById(row.id)).catch(() => null);
                }
                continue;
            }
            if (row.instance_id && !row.billing_settled_at) {
                const inst = await db.prepare('SELECT * FROM gpu_instances WHERE id = ?').get(row.instance_id);
                if (inst && (inst.status === 'destroyed' || inst.status === 'dead' || inst.status === 'refused')) {
                    await afterDestroy(inst, inst.error || 'the rent ended').catch(() => null);
                    settled += 1;
                }
            }
        }
        return { started, stopped, settled };
    }

    /**
     * Forward one request from an endpoint's owner to the rented GPU. The caller's token, headers and
     * cookies never reach the instance: it gets the body and nothing else. Marking the use is what
     * keeps the scale-to-zero timer honest.
     */
    async function forward({ subject, id, method, path, body, signal = null }) {
        const row = await ownedRow(subject, id);
        if (row.status !== 'running') throw new AiError(409, 'own_endpoint.not_running', row.error || 'This endpoint is not running.');
        if (!['GET', 'POST'].includes(String(method).toUpperCase())) throw new AiError(405, 'own_endpoint.method', 'only GET and POST reach an endpoint');
        if (!/^\/v1\/[A-Za-z0-9/_.-]+$/.test(String(path || '')) || String(path).includes('..')) throw new AiError(422, 'own_endpoint.path', 'that is not an OpenAI-compatible path');
        const inst = await db.prepare('SELECT * FROM gpu_instances WHERE id = ?').get(row.instance_id);
        if (!inst || inst.status !== 'running' || !inst.endpoint) throw new AiError(409, 'own_endpoint.not_running', 'The GPU is not answering yet.');
        await gpus.noteUse(inst.provider_key);
        const url = String(inst.endpoint).replace(/\/+$/, '') + path;
        const headers = { Accept: 'application/json' };
        let payload;
        if (body !== undefined && String(method).toUpperCase() !== 'GET') {
            headers['Content-Type'] = 'application/json';
            payload = typeof body === 'string' ? body : JSON.stringify(body);
        }
        let res;
        try {
            res = await fetchImpl(url, { method: String(method).toUpperCase(), headers, ...(payload !== undefined ? { body: payload } : {}), signal: signal || AbortSignal.timeout(300_000) });
        } catch (err) {
            throw new AiError(502, 'own_endpoint.unreachable', 'The GPU did not answer: ' + String((err && err.message) || err).slice(0, 200));
        }
        return { status: res.status, contentType: res.headers.get('content-type') || 'application/json', body: res.body };
    }

    return { status, create, list, get, stop, tick, specFor, ready, afterDestroy, forward, describe, settle };
}

module.exports = { createOwnEndpoints, MAX_ACTIVE, MAX_IDLE_MINUTES, MAX_RUNTIME_MINUTES, BILLING_OFF, plainGpuReason, reasonText };
