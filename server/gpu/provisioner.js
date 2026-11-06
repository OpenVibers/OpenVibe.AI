'use strict';
/**
 * The GPU provisioner (the design's "OpenVibe GPUs").
 *
 * It rents the cheapest marketplace GPU that fits a model, serves the model's weights with vLLM or
 * llama.cpp, registers the endpoint as an offer for the router, health-checks it, scales it to zero
 * when it is idle, and never spends past the owner's monthly cap.
 *
 * The rules it keeps, in the order they matter:
 *
 *   1. It is off until the owner has set a marketplace API key AND a monthly cap. No key or no cap
 *      means no instance, no search and no money.
 *   2. It never passes the monthly cap. Every instance holds a reservation (the budget it may cost)
 *      before it starts, the reservation is part of the month's committed spend, and a new instance
 *      is only started when the reservation still fits under the cap. When an instance's reservation
 *      has run out the instance is given back, so the money stops there.
 *   3. The money is integer nano-USD in BigInt (server/gpu/money.js). Nothing here is a float.
 *   4. It picks the cheapest offer that fits (VRAM, disk, reliability, region) and the choice is
 *      deterministic: the same offers in the same order always give the same instance.
 */
const { randomUUID } = require('node:crypto');
const { AiError } = require('../util');
const money = require('./money');
const catalog = require('./catalog');
const { vastAdapter } = require('./vast');
const { runpodAdapter } = require('./runpod');

const HEALTH_INTERVAL_MS = 30_000;
const HEALTH_FAILURES = 2;
const DEFAULT_IDLE_MINUTES = 10;
const DEFAULT_MAX_RUNTIME_MINUTES = 720;
const DEFAULT_REGION = 'US';
const LIVE = ['starting', 'running', 'stopping'];
const DEAD_STATES = ['exited', 'unknown', 'offline', 'dead', 'terminated', 'stopped', 'error'];
const PRICE_SOURCE = { vast: 'https://vast.ai/pricing', runpod: 'https://www.runpod.io/pricing' };

function clampInt(value, min, max, fallback) {
    if (value == null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** A database value as milliseconds, or null. */
function toMs(value) {
    if (value == null) return null;
    if (value instanceof Date) return value.getTime();
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
}

/** A database value as exact nano-USD. A value that is not an integer is loud, never rounded. */
function toNano(value) {
    if (value == null) return 0n;
    if (typeof value === 'bigint') return value;
    const s = String(value).trim();
    if (/^-?[0-9]+$/.test(s)) return BigInt(s);
    throw new AiError(500, 'gpu.ledger_corrupt', 'the GPU ledger holds a value that is not an integer number of nano-USD');
}

/**
 * The provisioner.
 *
 *   db        the database handle (open vibe sdk db)
 *   registry  the provider registry: the instance is registered there as an offer for the router
 *   settings  AI's settings; settings.gpus.values() is the owner's GPU settings
 *   clock     { now(): number } - a fake clock in the tests
 *   fetchImpl the HTTP client the marketplace calls go through (a fake in the tests)
 */
function createGpuProvisioner({
    db,
    registry,
    settings,
    clock = { now: () => Date.now() },
    fetchImpl = globalThis.fetch,
    env = process.env,
    log = console,
    models = catalog.list(),
} = {}) {
    const now = () => clock.now();
    const iso = (ms) => new Date(ms).toISOString();
    const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

    // ── the owner's settings ──────────────────────────────────────────────

    /** The owner's GPU settings, with the money exact and the defaults applied. */
    function config() {
        const v = (settings && settings.gpus && typeof settings.gpus.values === 'function') ? settings.gpus.values() : {};
        let cap = null;
        try {
            cap = money.nanoCount(v.monthly_cap, 'the monthly GPU cap');
        } catch {
            cap = null;
        }
        const vastKey = String(v.vast_key || '');
        const runpodKey = String(v.runpod_key || '');
        let reason = '';
        if (!vastKey && !runpodKey) reason = 'no Vast.ai or RunPod API key';
        else if (cap == null || cap <= 0n) reason = 'no monthly cap';
        return {
            vast_key: vastKey,
            runpod_key: runpodKey,
            cap_nano: cap,
            idle_minutes: clampInt(v.idle_minutes, 1, 1440, DEFAULT_IDLE_MINUTES),
            max_runtime_minutes: clampInt(v.max_runtime_minutes, 1, 10080, DEFAULT_MAX_RUNTIME_MINUTES),
            warm_window: String(v.warm_window || '').trim(),
            region: String(v.region || DEFAULT_REGION).trim().toUpperCase() || DEFAULT_REGION,
            enabled: Boolean(vastKey || runpodKey) && cap != null && cap > 0n,
            reason,
        };
    }

    /** The adapter of a marketplace, or null when its key is not set. */
    function adapterFor(marketplace, cfg) {
        if (marketplace === 'runpod') {
            if (!cfg.runpod_key) return null;
            return runpodAdapter({ fetchImpl, key: cfg.runpod_key });
        }
        if (!cfg.vast_key) return null;
        return vastAdapter({ fetchImpl, key: cfg.vast_key });
    }

    /** Is the moment inside the owner's warm window (UTC)? Then an idle instance stays up. */
    function inWarmWindow(window, at) {
        const m = /^([0-2]\d):([0-5]\d)-([0-2]\d):([0-5]\d)$/.exec(String(window || '').trim());
        if (!m) return false;
        const minutes = (h, mi) => Number(h) * 60 + Number(mi);
        const start = minutes(m[1], m[2]);
        const end = minutes(m[3], m[4]);
        if (start === end) return false;
        const d = new Date(at);
        const cur = d.getUTCHours() * 60 + d.getUTCMinutes();
        if (start < end) return cur >= start && cur < end;
        return cur >= start || cur < end;
    }

    // ── the money ─────────────────────────────────────────────────────────

    /** The month's money: what was really spent, and what is committed (the worst case). */
    async function moneySummary() {
        const month = monthOf(now());
        const cfg = config();
        const ledger = await db.prepare('SELECT COALESCE(SUM(nano_usd), 0) AS total FROM gpu_spend WHERE month = ?').get(month);
        const settled = toNano(ledger && ledger.total);
        const rows = await db.prepare('SELECT * FROM gpu_instances WHERE month = ? AND status IN (?, ?, ?)').all(month, 'starting', 'running', 'stopping');
        let reserved = 0n;
        let running = 0n;
        for (const row of rows) {
            reserved += toNano(row.reserved_nano);
            const started = toMs(row.started_at);
            if (started != null) running += money.nanoForSeconds(toNano(row.hourly_nano), (now() - started) / 1000);
        }
        return {
            month,
            cap_nano: cfg.cap_nano,
            spent_nano: settled + running,
            committed_nano: settled + reserved,
            reserved_nano: reserved,
            settled_nano: settled,
        };
    }

    /** Write the money an instance has cost since the last charge. */
    async function charge(row, until, reason) {
        const hourly = toNano(row.hourly_nano);
        const from = toMs(row.charged_at) || toMs(row.started_at) || until;
        const seconds = Math.max(0, (until - from) / 1000);
        if (seconds <= 0) return 0n;
        const amount = money.nanoForSeconds(hourly, seconds);
        if (amount <= 0n) return 0n;
        await db.prepare('INSERT INTO gpu_spend (at, month, kind, nano_usd, instance_id, detail, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(iso(until), monthOf(until), 'charge', amount.toString(), row.id, reason || 'the GPU ran', 'service:ai', iso(now()));
        await db.prepare('UPDATE gpu_instances SET charged_at = ?, spent_nano = spent_nano + ?, updated_at = ? WHERE id = ?')
            .run(iso(until), amount.toString(), iso(now()), row.id);
        return amount;
    }

    // ── the instances ─────────────────────────────────────────────────────

    async function liveInstance(modelKey) {
        const row = await db.prepare('SELECT * FROM gpu_instances WHERE model_key = ? AND status IN (?, ?, ?) ORDER BY created_at DESC LIMIT 1')
            .get(String(modelKey), 'starting', 'running', 'stopping');
        return row || null;
    }

    async function instanceRows() {
        const rows = await db.prepare('SELECT * FROM gpu_instances ORDER BY created_at DESC').all();
        return rows || [];
    }

    /** The cheapest offer that fits. The same offers in the same order always give the same one. */
    function cheapest(offers) {
        const usable = (offers || []).filter((o) => o && o.price_per_hour != null && Number(o.price_per_hour) > 0);
        usable.sort((a, b) => {
            const pa = Number(a.price_per_hour);
            const pb = Number(b.price_per_hour);
            if (pa !== pb) return pa - pb;
            return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
        });
        return usable[0] || null;
    }

    /** Ask for a model to start or stop. The reconciler does it; nothing here acts directly. */
    async function request(modelKey, action, actor = 'service:ai') {
        if (!catalog.find(modelKey) && !models.some((m) => m.key === modelKey)) throw new AiError(404, 'ai.not_found', 'no such GPU model');
        if (action !== 'launch' && action !== 'stop') throw new AiError(422, 'ai.invalid', 'the action must be launch or stop');
        await db.prepare('INSERT INTO gpu_requests (model_key, action, at, actor, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(String(modelKey), action, iso(now()), String(actor || '').slice(0, 200), iso(now()));
        return { ok: true, model_key: modelKey, action };
    }

    /** Is the model wanted? It is wanted when the owner asked for it or when it was used recently. */
    async function wanted(spec, cfg) {
        const pending = await db.prepare("SELECT COUNT(*) AS n FROM gpu_requests WHERE model_key = ? AND action = 'launch' AND done_at IS NULL")
            .get(spec.key);
        if (pending && Number(pending.n) > 0) return true;
        const used = await db.prepare('SELECT MAX(created_at) AS last FROM runs WHERE provider_key = ?').get(spec.provider_key);
        const last = toMs(used && used.last);
        if (last != null && now() - last <= cfg.idle_minutes * 60_000) return true;
        return false;
    }

    /**
     * Start an instance for a model: the cheapest offer that fits, inside the cap.
     * Returns { ok, reason } - it never throws for the owner's reasons (off, no offer, cap).
     */
    async function launch(modelKey, { actor = 'service:ai' } = {}) {
        const cfg = config();
        if (!cfg.enabled) return { ok: false, code: 'gpu.off', reason: cfg.reason };
        const spec = models.find((m) => m.key === modelKey) || catalog.find(modelKey);
        if (!spec) throw new AiError(404, 'ai.not_found', 'no such GPU model');
        const existing = await liveInstance(spec.key);
        if (existing) return { ok: true, instance: describe(existing), note: 'already running' };
        const adapter = adapterFor(spec.marketplace, cfg);
        if (!adapter) return { ok: false, code: 'gpu.no_key', reason: 'no ' + spec.marketplace + ' API key' };

        // 1. the cheapest offer that fits the model
        let offers;
        try {
            offers = await adapter.searchOffers({
                gpuNames: spec.requirements.gpu_names,
                vramMb: spec.requirements.vram_mb,
                diskGb: spec.requirements.disk_gb,
                numGpus: spec.requirements.num_gpus,
                minReliability: spec.requirements.min_reliability,
                region: cfg.region,
                maxPricePerHour: 10,
                limit: 50,
            });
        } catch (err) {
            return { ok: false, code: 'gpu.search_failed', reason: String(err && err.message).slice(0, 200) };
        }
        const offer = cheapest(offers);
        if (!offer) {
            return { ok: false, code: 'gpu.no_offer', reason: 'no ' + spec.marketplace + ' offer fits ' + spec.display_name };
        }

        // 2. the cap: the reservation has to fit under what is left of it
        const hourly = money.nanoUsd(offer.price_per_hour, "the offer's price");
        if (hourly == null || hourly <= 0n) {
            return { ok: false, code: 'gpu.bad_price', reason: "the offer has no usable price" };
        }
        const sum = await moneySummary();
        const cap = cfg.cap_nano;
        if (sum.committed_nano >= cap) {
            return { ok: false, code: 'gpu.cap', reason: 'the monthly cap is reached (' + money.usdText(sum.committed_nano) + ' of ' + money.usdText(cap) + ')' };
        }
        const affordableHours = (cap - sum.committed_nano) / hourly;
        if (affordableHours < 1n) {
            return { ok: false, code: 'gpu.cap', reason: 'the monthly cap leaves less than an hour of GPU time (' + money.usdText(cap - sum.committed_nano) + ' left)' };
        }
        const maxMinutes = Math.min(cfg.max_runtime_minutes, Number(affordableHours) * 60);
        const reserved = hourly * BigInt(Math.ceil(maxMinutes / 60));
        if (sum.committed_nano + reserved > cap) {
            return { ok: false, code: 'gpu.cap', reason: 'the monthly cap leaves no room for ' + spec.display_name };
        }

        // 3. rent it
        let created;
        try {
            created = await adapter.createInstance(offer, spec, {
                command: catalog.commandOf(spec),
                weights_url: catalog.weightsUrl(spec),
            });
        } catch (err) {
            return { ok: false, code: 'gpu.create_failed', reason: String(err && err.message).slice(0, 200) };
        }
        const id = 'gpu_' + randomUUID().replace(/-/g, '');
        const t = now();
        await db.prepare(`INSERT INTO gpu_instances (id, model_key, provider_key, marketplace, offer_id, remote_id, status, endpoint, month,
                gpu_name, gpu_ram_mb, num_gpus, disk_gb, reliability, region, price_per_hour, hourly_nano, reserved_nano, spent_nano,
                max_runtime_minutes, started_at, charged_at, health_failures, created_at, updated_at)
            VALUES (@id, @model_key, @provider_key, @marketplace, @offer_id, @remote_id, 'starting', NULL, @month,
                @gpu_name, @gpu_ram_mb, @num_gpus, @disk_gb, @reliability, @region, @price_per_hour, @hourly_nano, @reserved_nano, 0,
                @max_runtime_minutes, @started_at, @charged_at, 0, @created_at, @updated_at)`)
            .run({
                id, model_key: spec.key, provider_key: spec.provider_key, marketplace: spec.marketplace,
                offer_id: String(offer.id), remote_id: String(created.remote_id || ''), month: monthOf(t),
                gpu_name: String(offer.gpu_name || ''), gpu_ram_mb: Number(offer.gpu_ram_mb) || 0,
                num_gpus: Number(offer.num_gpus) || 1, disk_gb: Number(offer.disk_gb) || 0,
                reliability: Number(offer.reliability) || 0, region: String(offer.region || ''),
                price_per_hour: String(offer.price_per_hour), hourly_nano: hourly.toString(), reserved_nano: reserved.toString(),
                max_runtime_minutes: maxMinutes, started_at: iso(t), charged_at: iso(t), created_at: iso(t), updated_at: iso(t),
            });
        await audit(actor, 'gpu.instance.create', 'gpu_instance', id, {
            model: spec.key, marketplace: spec.marketplace, offer_id: String(offer.id), hourly_nano: hourly.toString(),
            reserved_nano: reserved.toString(), max_runtime_minutes: maxMinutes,
        });
        const row = await db.prepare('SELECT * FROM gpu_instances WHERE id = ?').get(id);
        return { ok: true, instance: describe(row), offer, reserved_nano: reserved, hourly_nano: hourly };
    }

    /** The offer leaves the pool: the router fails over to the other providers. */
    async function disableProvider(providerKey, reason) {
        try {
            await registry.upsertProvider({ key: providerKey, status: 'disabled' }, { actor: 'service:ai', origin: 'gpu' });
        } catch (err) {
            log.warn && log.warn('[gpu] could not disable the offer ' + providerKey + ': ' + String(err && err.message));
        }
    }

    /** Register the instance's endpoint as an offer for the router. */
    async function register(spec, row) {
        const base = String(row.endpoint || '').replace(/\/+$/, '') + '/v1';
        if (!/^https?:\/\/\S+$/i.test(base)) throw new AiError(502, 'gpu.no_endpoint', 'the instance has no usable endpoint');
        const price = money.usdPerMillionTokens(toNano(row.hourly_nano), spec.throughput_tokens_per_hour);
        const gpu = {
            marketplace: row.marketplace,
            offer_id: row.offer_id,
            instance_id: row.id,
            gpu_name: row.gpu_name,
            price_per_hour: row.price_per_hour,
            region: row.region,
            runtime: spec.runtime.kind,
            weights: catalog.weightsUrl(spec),
        };
        await registry.upsertProvider({
            key: spec.provider_key,
            display_name: spec.display_name,
            kind: 'openai',
            status: 'active',
            base_url: base,
            auth_mode: 'none',
            secret_ref: null,
            default_model: spec.model_key,
            capabilities: ['chat'],
            timeout_ms: 300000,
            priority: 40,
            billing_profile: 'metered',
            provider_access: 'OWN_DEPLOYMENT',
            metadata: { gpu },
        }, { actor: 'service:ai', origin: 'gpu' });
        await registry.upsertModel({
            provider_key: spec.provider_key,
            model_key: spec.model_key,
            display_name: spec.display_name,
            type: 'chat',
            status: 'active',
            context_window: spec.context_window,
            cost: {
                in_per_mtok: price,
                out_per_mtok: price,
                cached_per_mtok: price,
                source: PRICE_SOURCE[row.marketplace] || 'urn:openvibe:ai:unverified:gpu',
                verified_at: iso(now()).slice(0, 10),
            },
            supports: { json: false, tools: false, streaming: true, vision: false },
            metadata: { gpu },
        }, { actor: 'service:ai' });
        return base;
    }

    /** Is the endpoint answering? The OpenAI-compatible /models is the cheapest honest check. */
    async function healthy(endpoint) {
        if (!endpoint) return false;
        try {
            const res = await fetchImpl(String(endpoint).replace(/\/+$/, '') + '/v1/models', { method: 'GET', headers: { Accept: 'application/json' } });
            return Boolean(res && res.ok);
        } catch {
            return false;
        }
    }

    /** Give the instance back and settle what it cost. */
    async function destroy(row, reason, { actor = 'service:ai' } = {}) {
        const cfg = config();
        const adapter = adapterFor(row.marketplace, cfg);
        if (adapter && row.remote_id) {
            try {
                await adapter.destroyInstance(row.remote_id);
            } catch (err) {
                log.warn && log.warn('[gpu] could not give instance ' + row.id + ' back: ' + String(err && err.message));
            }
        }
        const t = now();
        // the freshest row: the money already on the ledger is not charged twice
        const fresh = await db.prepare('SELECT * FROM gpu_instances WHERE id = ?').get(row.id);
        await charge(fresh || row, t, reason);
        await db.prepare("UPDATE gpu_instances SET status = 'destroyed', destroyed_at = ?, endpoint = NULL, updated_at = ? WHERE id = ?")
            .run(iso(t), iso(t), row.id);
        await disableProvider(row.provider_key, reason);
        await audit(actor, 'gpu.instance.destroy', 'gpu_instance', row.id, { reason, model: row.model_key });
        return { ok: true, reason };
    }

    /** One pass over the live instances: the reservation, the idle timer, the health. */
    async function reconcileInstance(row, cfg) {
        const spec = models.find((m) => m.key === row.model_key) || catalog.find(row.model_key);
        if (!spec) return { changed: false };
        const t = now();
        const started = toMs(row.started_at) || t;

        // the money that ran while we were away
        await charge(row, t, 'the GPU ran');

        // 1. the reservation ran out: the instance goes back, so the money stops there
        if (t - started >= Number(row.max_runtime_minutes) * 60_000) {
            await destroy({ ...row, charged_at: row.charged_at }, 'the reservation ran out');
            return { changed: true, action: 'destroyed', reason: 'the reservation ran out' };
        }

        // 2. the idle timer: the offer scales to zero (unless it is inside the warm window). The clock runs
        //    from the moment the instance was ready, not from the moment it was rented: an instance that is still
        //    starting is never idle.
        if (row.status === 'running') {
            const lastUsed = toMs(row.last_used_at) || toMs(row.ready_at) || started;
            if (t - lastUsed >= cfg.idle_minutes * 60_000 && !inWarmWindow(cfg.warm_window, t)) {
                await destroy({ ...row, charged_at: row.charged_at }, 'idle');
                return { changed: true, action: 'scaled_to_zero', reason: 'idle for ' + cfg.idle_minutes + ' minutes' };
            }
        }

        // 3. the health of the instance
        if (row.status === 'starting') {
            const adapter = adapterFor(row.marketplace, cfg);
            if (!adapter) return { changed: false };
            let info = null;
            try {
                info = await adapter.showInstance(row.remote_id);
            } catch (err) {
                return { changed: false, error: String(err && err.message).slice(0, 200) };
            }
            const state = String((info && info.state) || 'unknown').toLowerCase();
            if (DEAD_STATES.includes(state)) {
                await destroy({ ...row, charged_at: row.charged_at }, 'the instance ' + state);
                await request(spec.key, 'launch', 'service:ai');
                return { changed: true, action: 'died', reason: 'the instance ' + state };
            }
            const endpoint = info && info.endpoint ? String(info.endpoint) : '';
            if (endpoint && await healthy(endpoint)) {
                await db.prepare("UPDATE gpu_instances SET status = 'running', endpoint = ?, ready_at = ?, last_health_at = ?, health_failures = 0, updated_at = ? WHERE id = ?")
                    .run(endpoint, iso(t), iso(t), iso(t), row.id);
                await register(spec, { ...row, endpoint });
                return { changed: true, action: 'ready' };
            }
            return { changed: false };
        }

        if (row.status === 'running') {
            const lastHealth = toMs(row.last_health_at) || 0;
            if (t - lastHealth < HEALTH_INTERVAL_MS) return { changed: false };
            const ok = await healthy(row.endpoint);
            if (ok) {
                await db.prepare('UPDATE gpu_instances SET health_failures = 0, last_health_at = ?, updated_at = ? WHERE id = ?')
                    .run(iso(t), iso(t), row.id);
                return { changed: false };
            }
            const failures = Number(row.health_failures || 0) + 1;
            await db.prepare('UPDATE gpu_instances SET health_failures = ?, last_health_at = ?, updated_at = ? WHERE id = ?')
                .run(failures, iso(t), iso(t), row.id);
            if (failures < HEALTH_FAILURES) return { changed: false, health_failures: failures };
            // the instance died: the offer leaves the pool and a new one is rented
            await destroy({ ...row, charged_at: row.charged_at }, 'the endpoint stopped answering');
            await request(spec.key, 'launch', 'service:ai');
            return { changed: true, action: 'died', reason: 'the endpoint stopped answering' };
        }
        return { changed: false };
    }

    /** The audit row. The registry's audit is used when it is there; the money rows are the record. */
    async function audit(actor, action, kind, key, metadata) {
        try {
            if (registry && typeof registry.audit === 'function') {
                await registry.audit(actor, action, kind, key, { metadata });
                return;
            }
        } catch (err) {
            log.warn && log.warn('[gpu] the audit row failed: ' + String(err && err.message));
        }
    }

    /** A row as the console and the API show it. */
    function describe(row) {
        if (!row) return null;
        return {
            id: row.id,
            model_key: row.model_key,
            provider_key: row.provider_key,
            marketplace: row.marketplace,
            offer_id: row.offer_id,
            remote_id: row.remote_id,
            status: row.status,
            endpoint: row.endpoint,
            month: row.month,
            gpu_name: row.gpu_name,
            gpu_ram_mb: row.gpu_ram_mb,
            num_gpus: row.num_gpus,
            disk_gb: row.disk_gb,
            reliability: row.reliability,
            region: row.region,
            price_per_hour: row.price_per_hour,
            hourly_nano: String(toNano(row.hourly_nano)),
            reserved_nano: String(toNano(row.reserved_nano)),
            spent_nano: String(toNano(row.spent_nano)),
            max_runtime_minutes: row.max_runtime_minutes,
            started_at: row.started_at,
            ready_at: row.ready_at,
            last_used_at: row.last_used_at,
            destroyed_at: row.destroyed_at,
            error: row.error,
        };
    }

    // ── the reconciler ────────────────────────────────────────────────────

    /** One pass: the owner's requests, the live instances, and the models that are wanted. */
    async function tick({ actor = 'service:ai' } = {}) {
        const cfg = config();
        if (!cfg.enabled) return { ok: false, reason: cfg.reason, launched: 0, stopped: 0, destroyed: 0 };

        let launched = 0;
        let stopped = 0;
        let destroyed = 0;

        // 1. the owner's requests
        const requests = await db.prepare('SELECT * FROM gpu_requests WHERE done_at IS NULL ORDER BY id').all();
        for (const req of requests || []) {
            try {
                if (req.action === 'launch') {
                    const res = await launch(req.model_key, { actor: req.actor || actor });
                    if (!res.ok) {
                        await db.prepare('UPDATE gpu_requests SET done_at = ?, error = ? WHERE id = ?')
                            .run(iso(now()), String(res.reason).slice(0, 300), req.id);
                        continue;
                    }
                    launched += 1;
                } else {
                    const row = await liveInstance(req.model_key);
                    if (row) {
                        await destroy(row, 'the owner stopped it', { actor: req.actor || actor });
                        stopped += 1;
                    }
                }
                await db.prepare('UPDATE gpu_requests SET done_at = ?, error = NULL WHERE id = ?').run(iso(now()), req.id);
            } catch (err) {
                await db.prepare('UPDATE gpu_requests SET done_at = ?, error = ? WHERE id = ?')
                    .run(iso(now()), String(err && err.message).slice(0, 300), req.id);
            }
        }

        // 2. the live instances
        const rows = await db.prepare('SELECT * FROM gpu_instances WHERE status IN (?, ?) ORDER BY created_at').all('starting', 'running');
        for (const row of rows || []) {
            const res = await reconcileInstance(row, cfg);
            if (res && (res.action === 'destroyed' || res.action === 'scaled_to_zero' || res.action === 'died')) destroyed += 1;
        }

        // 3. the models that are wanted but have no instance
        for (const spec of models) {
            if (await liveInstance(spec.key)) continue;
            if (!await wanted(spec, cfg)) continue;
            const res = await launch(spec.key, { actor });
            if (res.ok) launched += 1;
        }

        return { ok: true, launched, stopped, destroyed };
    }

    /** The state the console page and the admin API show. */
    async function state() {
        const cfg = config();
        const sum = await moneySummary();
        const rows = await instanceRows();
        const list = models.map((spec) => {
            const live = rows.find((r) => r.model_key === spec.key && LIVE.includes(r.status)) || null;
            return {
                key: spec.key,
                display_name: spec.display_name,
                marketplace: spec.marketplace,
                runtime: spec.runtime.kind,
                requirements: spec.requirements,
                weights_url: catalog.weightsUrl(spec),
                command: catalog.commandOf(spec),
                instance: describe(live),
            };
        });
        return {
            enabled: cfg.enabled,
            reason: cfg.reason,
            month: sum.month,
            cap_nano: cfg.cap_nano == null ? null : String(cfg.cap_nano),
            spent_nano: String(sum.spent_nano),
            committed_nano: String(sum.committed_nano),
            reserved_nano: String(sum.reserved_nano),
            idle_minutes: cfg.idle_minutes,
            max_runtime_minutes: cfg.max_runtime_minutes,
            warm_window: cfg.warm_window,
            region: cfg.region,
            marketplaces: { vast: Boolean(cfg.vast_key), runpod: Boolean(cfg.runpod_key) },
            models: list,
            instances: rows.map(describe),
        };
    }

    return {
        state,
        tick,
        launch,
        request,
        config,
        moneySummary,
        /** For the tests: the same thing the reconciler does with one instance. */
        reconcileInstance,
        inWarmWindow,
    };
}

module.exports = { createGpuProvisioner, HEALTH_INTERVAL_MS, HEALTH_FAILURES };
