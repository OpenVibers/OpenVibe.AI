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
const { choose, STRATEGIES } = require('openvibe-sdk/compute');
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
// Every instance we rent carries our row id as its label (an openvibe- prefix), so the sweep can find
// it again and give it back when no live row of ours owns it.
const LABEL_PREFIX = 'openvibe-';
const LABEL_RE = /^openvibe-[0-9a-f]{12}$/;
// Three failed destroys in a row: the instance is still running and still being paid for, so the
// operator is alerted (the gauge ai_gpu_destroy_failures and the rule in OpenVibe.Host's prometheus rules).
const ALERT_AFTER = 3;
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
    ownEndpoints = null,
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
        let extraHourly = null;
        try { extraHourly = money.nanoCount(v.extra_hourly_nano, 'the hourly storage and network allowance'); } catch {}
        const bounded = v.costs_bounded === true && extraHourly != null && extraHourly >= 0n;
        const vastKey = String(v.vast_key || '');
        const runpodKey = String(v.runpod_key || '');
        let reason = '';
        if (!vastKey && !runpodKey) reason = 'no Vast.ai or RunPod API key';
        else if (cap == null || cap <= 0n) reason = 'no monthly cap';
        else if (!bounded) reason = 'storage and network costs need an explicit hourly bound';
        return {
            strategy: STRATEGIES.includes(v.strategy) ? v.strategy : 'cheapest',
            dry_run: v.dry_run === true,
            vast_key: vastKey,
            runpod_key: runpodKey,
            cap_nano: cap,
            extra_hourly_nano: extraHourly,
            idle_minutes: clampInt(v.idle_minutes, 1, 1440, DEFAULT_IDLE_MINUTES),
            max_runtime_minutes: clampInt(v.max_runtime_minutes, 1, 10080, DEFAULT_MAX_RUNTIME_MINUTES),
            warm_window: String(v.warm_window || '').trim(),
            region: String(v.region || DEFAULT_REGION).trim().toUpperCase() || DEFAULT_REGION,
            enabled: Boolean(vastKey || runpodKey) && cap != null && cap > 0n && bounded,
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
    async function moneySummary(handle = db) {
        const month = monthOf(now());
        const cfg = config();
        const ledger = await handle.prepare('SELECT COALESCE(SUM(nano_usd), 0) AS total FROM gpu_spend WHERE month = ?').get(month);
        const settled = toNano(ledger && ledger.total);
        const rows = await handle.prepare('SELECT * FROM gpu_instances WHERE status IN (?, ?, ?)').all('starting', 'running', 'stopping');
        let reserved = 0n;
        let running = 0n;
        for (const row of rows) {
            const remaining = toNano(row.reserved_nano) > toNano(row.spent_nano) ? toNano(row.reserved_nano) - toNano(row.spent_nano) : 0n;
            const started = toMs(row.started_at);
            const accrued = started == null ? 0n : money.nanoForSeconds(toNano(row.hourly_nano), Math.max(0, now() - Math.max(toMs(row.charged_at) || started, Date.parse(month + '-01T00:00:00Z'))) / 1000);
            running += accrued;
            // Pending deletion may run beyond its reservation. Never make that overspend look like free budget.
            reserved += remaining > accrued ? remaining : accrued;
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
        return db.tx(async (tdb) => {
        row = await tdb.prepare('SELECT * FROM gpu_instances WHERE id = ? FOR UPDATE').get(row.id) || row;
        const hourly = toNano(row.hourly_nano);
        const from = toMs(row.charged_at) || toMs(row.started_at) || until;
        if (until <= from) return 0n;
        let amount = 0n;
        for (let start = from; start < until;) {
            const d = new Date(start);
            const end = Math.min(until, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
            const part = money.nanoForSeconds(hourly, (end - start) / 1000);
            await tdb.prepare('INSERT INTO gpu_spend (at, month, kind, nano_usd, instance_id, detail, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                .run(iso(end), monthOf(start), 'charge', part.toString(), row.id, reason || 'the GPU ran', 'service:ai', iso(now()));
            amount += part; start = end;
        }
        await tdb.prepare('UPDATE gpu_instances SET charged_at = ?, spent_nano = spent_nano + ?, updated_at = ? WHERE id = ?')
            .run(iso(until), amount.toString(), iso(now()), row.id);
        return amount;
        });
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

    /** A quote never creates a request, takes a Billing hold or rents anything. */
    async function preview(modelKey, { strategy = config().strategy, region = config().region, runtimeSpec = null, rentalOnly = false } = {}) {
        const spec = runtimeSpec || models.find(m => m.key === modelKey) || catalog.find(modelKey);
        if (!spec) throw new AiError(404, 'ai.not_found', 'no such GPU model');
        if (!STRATEGIES.includes(strategy)) throw new AiError(422, 'ai.invalid', 'unknown compute strategy');
        if (strategy === 'own' || strategy === 'private') return { dry_run: true, strategy, selected: null, offers: [], reasons: ['rented marketplace GPUs are not own or OpenVibe machines; use a Link endpoint'] };
        const cfg = config();
        const names = ['vast', 'runpod'].filter(name => !rentalOnly || cfg[name + '_key']);
        const offers = [];
        const failures = [];
        // The owner's approved supply plan pins the hourly and monthly ceilings per model (server/platform/supply.js).
        // Enforcing them here, at rent time, is what makes an approved host a bound and not only a comparison: a
        // live marketplace offer above the ceiling is not selected, however good it looks.
        const supplyRow = await db.prepare('SELECT settings FROM exchange_supply_settings WHERE model = ?').get(String(modelKey));
        const approved = supplyRow ? (() => { try { return JSON.parse(supplyRow.settings); } catch { return null; } })() : null;
        const withinApproved = (o) => {
            if (!approved) return true;
            const hourly = Number(o.price_per_hour);
            const hourlyCeiling = Number(approved.hourly_ceiling_usd);
            const monthlyCeiling = Number(approved.monthly_ceiling_usd);
            const vram = Number(approved.required_vram_mb);
            if (Number.isFinite(hourlyCeiling) && hourly > hourlyCeiling) return false;
            if (Number.isFinite(monthlyCeiling) && hourly * 24 * 31 > monthlyCeiling) return false;
            if (Number.isFinite(vram) && vram > 0 && o.gpu_ram_mb < vram) return false;
            return true;
        };
        for (const name of names) {
            const adapter = name === 'vast' ? vastAdapter({ fetchImpl, key: cfg.vast_key || null }) : runpodAdapter({ fetchImpl, key: cfg.runpod_key || null });
            try {
                const found = await adapter.searchOffers({ gpuNames: spec.requirements.gpu_names, vramMb: spec.requirements.vram_mb,
                    diskGb: spec.requirements.disk_gb, numGpus: spec.requirements.num_gpus,
                    minReliability: spec.requirements.min_reliability, region, maxPricePerHour: 10, limit: 50 });
                // Never trust marketplace-side filters alone.
                const fitting = found.filter(o => o.gpu_ram_mb >= spec.requirements.vram_mb && o.num_gpus >= spec.requirements.num_gpus
                    && o.disk_gb >= spec.requirements.disk_gb && o.reliability >= spec.requirements.min_reliability
                    && Number(o.price_per_hour) > 0 && Number.isFinite(Number(o.price_per_hour))
                    && (!region || String(o.region).toUpperCase() === String(region).toUpperCase()));
                const inside = fitting.filter(withinApproved);
                if (approved && inside.length < fitting.length) failures.push('offers above the approved supply ceiling were left out');
                offers.push(...inside);
            } catch { failures.push(name + ': quote API unavailable'); }
        }
        const candidates = offers.map(o => ({ id: o.marketplace + ':' + o.id, tier: 'partner', health: 'up', region: o.region,
            hourly: Number(o.price_per_hour), currency: 'USD', free_ram_mb: 2048, free_slots: 1, gpu_mb: o.gpu_ram_mb,
            latency_ms: o.latency_ms }));
        const decision = choose({ strategy, region }, candidates, { currency: 'USD' }, { now: now() });
        const selected = offers.find(o => o.marketplace + ':' + o.id === decision.selected) || null;
        return { dry_run: true, strategy, selected, offers, reasons: [...decision.reasons, ...(strategy === 'fastest' && !offers.some(o => o.latency_ms != null) ? ['latency unmeasured; choosing by price within the required region'] : []), ...failures], expires_at: iso(now() + 60000) };
    }

    /** May this provisioner serve the model? The supply tick asks before it queues a launch. */
    function supports(modelKey) {
        return Boolean(catalog.find(modelKey) || models.some((m) => m.key === modelKey));
    }

    /** Ask for a model to start or stop. The reconciler does it; nothing here acts directly. */
    async function request(modelKey, action, actor = 'service:ai') {
        if (!supports(modelKey)) throw new AiError(404, 'ai.not_found', 'no such GPU model');
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

    /** The live private rent of an endpoint, if one is still up. */
    async function liveInstanceForEndpoint(ownEndpointId) {
        if (!ownEndpointId) return null;
        const row = await db.prepare('SELECT * FROM gpu_instances WHERE own_endpoint_id = ? AND status IN (?, ?, ?) ORDER BY created_at DESC LIMIT 1')
            .get(String(ownEndpointId), 'starting', 'running', 'stopping');
        return row || null;
    }

    /**
     * Start an instance for a model: the cheapest offer that fits, inside the cap.
     * Returns { ok, reason } - it never throws for the owner's reasons (off, no offer, cap).
     */
    async function launch(modelKey, opts = {}) {
        const spec = models.find((m) => m.key === modelKey) || catalog.find(modelKey);
        if (!spec) throw new AiError(404, 'ai.not_found', 'no such GPU model');
        return launchSpec(spec, opts);
    }

    /**
     * Start an instance for a spec. A shared model offer registers itself with the router; a person's own
     * endpoint (ownEndpointId set) never does: it stays private, and its owner reaches it through AI.
     *
     *   beforeCreate({ offer, hourly, reserved, maxMinutes, marketplace })   the endpoint's Billing hold, if
     *       any, is taken here - before the marketplace is called, so nothing runs that the person cannot pay.
     */
    async function launchSpec(spec, { actor = 'service:ai', ownEndpointId = null, idleMinutes = null, maxRuntimeMinutes = null, beforeCreate = null, strategy = config().strategy, dryRun = false } = {}) {
        const cfg = config();
        if (cfg.dry_run && ownEndpointId) return { ok: false, code: 'gpu.dry_run', reason: 'GPU rentals are in quote-only mode' };
        if (dryRun || cfg.dry_run) return { ok: true, ...await preview(spec.key, { strategy, runtimeSpec: spec }) };
        if (!cfg.enabled) return { ok: false, code: 'gpu.off', reason: cfg.reason };
        if (!STRATEGIES.includes(strategy)) throw new AiError(422, 'ai.invalid', 'unknown compute strategy');
        if (strategy === 'private' || strategy === 'own') return { ok: false, code: 'gpu.no_offer', reason: 'this strategy requires an existing Link or OpenVibe machine' };
        const existing = ownEndpointId ? await liveInstanceForEndpoint(ownEndpointId) : await liveInstance(spec.key);
        if (existing) return { ok: true, instance: describe(existing), note: 'already running' };
        const quote = await preview(spec.key, { strategy, runtimeSpec: spec, rentalOnly: true });
        const offer = quote.selected;
        if (!offer) return { ok: false, code: 'gpu.no_offer', reason: quote.reasons.join('; ') };
        const marketplace = offer.marketplace;
        const adapter = adapterFor(marketplace, cfg);
        if (!adapter) return { ok: false, code: 'gpu.no_key', reason: 'no ' + marketplace + ' API key' };

        // 2. the cap: the reservation has to fit under what is left of it
        const baseHourly = money.nanoUsd(offer.price_per_hour, "the offer's price");
        const hourly = baseHourly == null ? null : baseHourly + cfg.extra_hourly_nano;
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
        const affordableMinutes = Number(affordableHours) * 60;
        const requestedMax = maxRuntimeMinutes == null ? affordableMinutes : Math.max(1, Math.min(affordableMinutes, Math.trunc(Number(maxRuntimeMinutes) || 0)));
        const maxMinutes = Math.min(cfg.max_runtime_minutes, requestedMax);
        const reserved = hourly * BigInt(Math.ceil(maxMinutes / 60));
        if (sum.committed_nano + reserved > cap) {
            return { ok: false, code: 'gpu.cap', reason: 'the monthly cap leaves no room for ' + spec.display_name };
        }

        // 2b. the payer's hold, for a person's own endpoint: taken before the marketplace is called, so an
        //     instance never runs that the person cannot pay for.
        if (beforeCreate) {
            try {
                await beforeCreate({ offer, hourly, reserved, maxMinutes, marketplace });
            } catch (err) {
                return { ok: false, code: (err && err.code) || 'gpu.billing', reason: String((err && err.message) || err).slice(0, 300) };
            }
        }

        // 3. the row comes first. The marketplace is told the label of a row that already exists and
        //    holds the reservation, so an instance we paid for is never an orphan: the sweep finds it by
        //    the label and gives it back when no live row of ours owns it.
        const id = LABEL_PREFIX + randomUUID().replace(/-/g, '').slice(0, 12);
        const t = now();
        try {
            await db.tx(async (tdb) => {
                await tdb.maybe('SELECT id FROM gpu_budget_lock WHERE id=1 FOR UPDATE');
                const latest = await moneySummary(tdb);
                if (latest.committed_nano + reserved > cap) throw new AiError(409, 'gpu.cap', 'the monthly cap has no room for another reservation');
                const unknown = await tdb.prepare("SELECT id FROM gpu_instances WHERE (status='starting' AND remote_id IS NULL AND error IS NOT NULL) OR status='orphan' LIMIT 1").get();
                if (unknown) throw new AiError(409, 'gpu.uncertain', 'an unknown provisioning outcome or orphan must be reconciled first');
        await tdb.prepare(`INSERT INTO gpu_instances (id, model_key, provider_key, marketplace, offer_id, remote_id, status, endpoint, month,
                gpu_name, gpu_ram_mb, num_gpus, disk_gb, reliability, region, price_per_hour, hourly_nano, reserved_nano, spent_nano,
                max_runtime_minutes, started_at, charged_at, destroy_failures, label, cold_start_ms, health_failures, created_at, updated_at,
                own_endpoint_id, idle_minutes)
            VALUES (@id, @model_key, @provider_key, @marketplace, @offer_id, NULL, 'starting', NULL, @month,
                @gpu_name, @gpu_ram_mb, @num_gpus, @disk_gb, @reliability, @region, @price_per_hour, @hourly_nano, @reserved_nano, 0,
                @max_runtime_minutes, @started_at, @charged_at, 0, @label, NULL, 0, @created_at, @updated_at,
                @own_endpoint_id, @idle_minutes)`)
            .run({
                id, model_key: spec.key, provider_key: spec.provider_key, marketplace,
                offer_id: String(offer.id), month: monthOf(t),
                gpu_name: String(offer.gpu_name || ''), gpu_ram_mb: Number(offer.gpu_ram_mb) || 0,
                num_gpus: Number(offer.num_gpus) || 1, disk_gb: Number(offer.disk_gb) || 0,
                reliability: Number(offer.reliability) || 0, region: String(offer.region || ''),
                price_per_hour: money.usdText(hourly).slice(1), hourly_nano: hourly.toString(), reserved_nano: reserved.toString(),
                max_runtime_minutes: maxMinutes, started_at: iso(t), charged_at: iso(t), label: id,
                created_at: iso(t), updated_at: iso(t),
                own_endpoint_id: ownEndpointId, idle_minutes: idleMinutes == null ? null : clampInt(idleMinutes, 1, 1440, cfg.idle_minutes),
            });
            });
        } catch (err) {
            if (err.code === 'gpu.cap' || err.code === 'gpu.uncertain') return { ok: false, code: err.code, reason: err.message };
            throw err;
        }
        await audit(actor, 'gpu.placement', 'gpu_instance', id, { strategy, marketplace, offer_id: offer.id, reasons: quote.reasons, base_hourly_nano: baseHourly.toString(), extra_hourly_nano: cfg.extra_hourly_nano.toString(), hourly_nano: hourly.toString() });
        await audit(actor, 'gpu.instance.requested', 'gpu_instance', id, {
            model: spec.key, marketplace, offer_id: String(offer.id), hourly_nano: hourly.toString(),
            reserved_nano: reserved.toString(), max_runtime_minutes: maxMinutes, label: id,
            ...(ownEndpointId ? { own_endpoint_id: ownEndpointId } : {}),
        });

        // 4. rent it. The marketplace is given the label of the row above, so the instance can always be
        //    found again. If the rental fails the row says so and the reservation is free again.
        let created;
        try {
            created = await adapter.createInstance(offer, spec, {
                command: catalog.commandOf(spec),
                weights_url: catalog.weightsUrl(spec),
                label: id,
            });
        } catch (err) {
            const reason = 'provision outcome unknown; reservation retained for reconciliation';
            await db.prepare("UPDATE gpu_instances SET status = 'starting', error = ?, updated_at = ? WHERE id = ?")
                .run(reason, iso(now()), id);
            await audit(actor, 'gpu.instance.refused', 'gpu_instance', id, { reason });
            const pending = await db.prepare('SELECT * FROM gpu_instances WHERE id = ?').get(id);
            return { ok: true, pending: true, instance: describe(pending), reason };
        }
        await db.prepare('UPDATE gpu_instances SET remote_id = ?, updated_at = ? WHERE id = ?')
            .run(String(created.remote_id || ''), iso(now()), id);
        await audit(actor, 'gpu.instance.create', 'gpu_instance', id, { remote_id: String(created.remote_id || '') });
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
        const fixedRow = await db.prepare('SELECT settings FROM exchange_supply_settings WHERE model = ?').get(spec.model_key);
        const fixed = fixedRow ? JSON.parse(fixedRow.settings) : null;
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
            metadata: { gpu, owner_fixed_price: Boolean(fixed), open_weights: true },
        }, { actor: 'service:ai', origin: 'gpu' });
        await registry.upsertModel({
            provider_key: spec.provider_key,
            model_key: spec.model_key,
            display_name: spec.display_name,
            type: 'chat',
            status: 'active',
            context_window: spec.context_window,
            cost: {
                in_per_mtok: fixed ? fixed.input_per_million : price,
                out_per_mtok: fixed ? fixed.output_per_million : price,
                cached_per_mtok: fixed ? fixed.input_per_million : price,
                source: fixed ? 'urn:openvibe:owner-fixed-price' : PRICE_SOURCE[row.marketplace] || 'urn:openvibe:ai:unverified:gpu',
                verified_at: iso(now()).slice(0, 10),
            },
            supports: { json: false, tools: false, streaming: true, vision: false },
            metadata: { gpu, owner_fixed_price: Boolean(fixed), open_weights: true },
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

    /**
     * Give the instance back and settle what it cost.
     *
     * A destroy that fails leaves the instance running (and being paid for): the row keeps its place,
     * the try is counted, the next pass tries again and after three tries the operator is alerted
     * (the gauge ai_gpu_destroy_failures and the rule in OpenVibe.Host's prometheus rules).
     */
    async function destroy(row, reason, { actor = 'service:ai' } = {}) {
        const cfg = config();
        const adapter = adapterFor(row.marketplace, cfg);
        if (!adapter || !row.remote_id) return { ok: false, reason: 'provider key or remote id missing; reservation retained' };
        if (adapter && row.remote_id) {
            try {
                if (await adapter.destroyInstance(row.remote_id) === false) throw new Error('provider did not accept deletion');
                const afterDelete = await adapter.showInstance(row.remote_id);
                if (!afterDelete.deleted) throw new Error('provider deletion is not yet confirmed');
            } catch (err) {
                const failures = Number(row.destroy_failures || 0) + 1;
                await db.prepare('UPDATE gpu_instances SET destroy_failures = ?, updated_at = ? WHERE id = ?')
                    .run(failures, iso(now()), row.id);
                log.warn && log.warn('[gpu] could not give instance ' + row.id + ' back (' + failures + ' tries): ' + String(err && err.message));
                if (failures >= ALERT_AFTER) {
                    await audit(actor, 'gpu.instance.destroy_failed', 'gpu_instance', row.id, { reason, failures, marketplace: row.marketplace });
                    log.error && log.error('[gpu] an instance could not be given back after ' + failures + ' tries: it is still running and still being paid for');
                }
                return { ok: false, failed: true, reason, failures };
            }
        }
        const t = now();
        // the freshest row: the money already on the ledger is not charged twice
        const fresh = await db.prepare('SELECT * FROM gpu_instances WHERE id = ?').get(row.id);
        await charge(fresh || row, t, reason);
        await db.prepare("UPDATE gpu_instances SET status = 'destroyed', destroyed_at = ?, endpoint = NULL, destroy_failures = 0, updated_at = ? WHERE id = ?")
            .run(iso(t), iso(t), row.id);
        if (row.own_endpoint_id && ownEndpoints && typeof ownEndpoints.afterDestroy === 'function') {
            // the person's endpoint is over: settle what it cost and say why it stopped
            await ownEndpoints.afterDestroy(fresh || row, reason).catch((err) => log.warn && log.warn('[gpu] the endpoint settle failed: ' + String(err && err.message)));
        } else {
            await disableProvider(row.provider_key, reason);
        }
        await audit(actor, 'gpu.instance.destroy', 'gpu_instance', row.id, { reason, model: row.model_key });
        return { ok: true, reason };
    }

    /**
     * Every pass: the marketplace instances that carry our label, and what to do with them.
     *
     *   - one whose label is a live row of ours: left alone, and linked when the row does not know its
     *     marketplace id yet (a crash between the marketplace's answer and the row's update).
     *   - one no live row of ours owns: an orphan. It is given back and the fact is logged.
     *
     * A destroy that fails is tried again on the next pass; after three tries the operator is alerted.
     */
    async function sweepOrphans(cfg) {
        const t = now();
        let seen = 0;
        for (const marketplace of ['vast', 'runpod']) {
            const adapter = adapterFor(marketplace, cfg);
            if (!adapter) continue;
            let instances = [];
            try {
                instances = await adapter.listInstances();
            } catch (err) {
                log.warn && log.warn('[gpu] could not list the ' + marketplace + ' instances: ' + String(err && err.message).slice(0, 200));
                continue;
            }
            for (const inst of instances) {
                const label = String(inst.label || '');
                if (!LABEL_RE.test(label)) continue;    // not ours
                seen += 1;
                const row = await db.prepare('SELECT * FROM gpu_instances WHERE id = ?').get(label);
                if (row && LIVE.includes(row.status)) {
                    // ours and alive: a crash after the marketplace accepted but before the row knew the
                    // id is repaired here, not thrown away.
                    if (!row.remote_id && inst.id) {
                        await db.prepare('UPDATE gpu_instances SET remote_id = ?, updated_at = ? WHERE id = ?')
                            .run(String(inst.id), iso(now()), row.id);
                        await audit('service:ai', 'gpu.instance.recovered', 'gpu_instance', row.id, { marketplace, remote_id: String(inst.id) });
                        log.log && log.log('[gpu] recovered the instance ' + inst.id + ' of the row ' + row.id + ' from the ' + marketplace + ' label');
                    }
                    continue;
                }
                await destroyOrphan({ marketplace, remote_id: String(inst.id), label }, row, cfg);
            }
        }
        // Unknown creation outcomes retain their reservation until the remote instance is recovered.
        // A failed/truncated listing cannot prove that a purchase never happened.
        return seen;
    }

    /** An instance with our label that no live row owns: give it back, and keep the tries. */
    async function destroyOrphan(inst, row, cfg) {
        const adapter = adapterFor(inst.marketplace, cfg);
        const id = row ? row.id : inst.label;
        const t = now();
        if (!row) {
            // the row the orphan needs: its retries and its money need a home of their own
            await db.prepare(`INSERT INTO gpu_instances (id, model_key, provider_key, marketplace, offer_id, remote_id, status, endpoint, month,
                    gpu_name, hourly_nano, reserved_nano, spent_nano, max_runtime_minutes, started_at, charged_at, destroy_failures, label, cold_start_ms, health_failures, created_at, updated_at)
                VALUES (@id, '', '', @marketplace, '', @remote_id, 'orphan', NULL, @month, '', 0, 0, 0, 0, @started_at, @charged_at, 0, @label, NULL, 0, @created_at, @updated_at)`)
                .run({
                    id, marketplace: inst.marketplace, remote_id: inst.remote_id, month: monthOf(t),
                    started_at: iso(t), charged_at: iso(t), label: inst.label, created_at: iso(t), updated_at: iso(t),
                });
            row = await db.prepare('SELECT * FROM gpu_instances WHERE id = ?').get(id);
        }
        // the orphan ran and was paid for: the seconds since the last charge are on the ledger
        await charge(row, t, 'the orphan ran');
        try {
            if (await adapter.destroyInstance(inst.remote_id) === false || !(await adapter.showInstance(inst.remote_id)).deleted) throw new Error('orphan deletion is not confirmed');
        } catch (err) {
            const failures = Number(row.destroy_failures || 0) + 1;
            await db.prepare('UPDATE gpu_instances SET destroy_failures = ?, updated_at = ? WHERE id = ?')
                .run(failures, iso(t), id);
            log.warn && log.warn('[gpu] could not give the orphan ' + inst.remote_id + ' back (' + failures + ' tries): ' + String(err && err.message).slice(0, 200));
            if (failures >= ALERT_AFTER) {
                await audit('service:ai', 'gpu.orphan.destroy_failed', 'gpu_instance', id, { marketplace: inst.marketplace, remote_id: inst.remote_id, failures });
                log.error && log.error('[gpu] an orphan instance could not be given back after ' + failures + ' tries: it is still running and still being paid for');
            }
            return { ok: false, failed: true };
        }
        await db.prepare("UPDATE gpu_instances SET status = 'destroyed', destroyed_at = ?, destroy_failures = 0, updated_at = ? WHERE id = ?")
            .run(iso(t), iso(t), id);
        await audit('service:ai', 'gpu.orphan.destroyed', 'gpu_instance', id, { marketplace: inst.marketplace, remote_id: inst.remote_id });
        log.warn && log.warn('[gpu] gave back an orphan instance ' + inst.remote_id + ' (' + inst.marketplace + '): it carried our label but no live row owned it');
        return { ok: true };
    }

    /** The destroy failures that are still open, per marketplace (the operator alert reads them). */
    async function destroyFailures() {
        const rows = await db.prepare('SELECT marketplace, MAX(destroy_failures) AS failures FROM gpu_instances WHERE destroy_failures > 0 GROUP BY marketplace').all();
        return (rows || []).map((r) => ({ labels: { marketplace: r.marketplace }, value: Number(r.failures) || 0 }));
    }

    /** The instances with our label that no live row owns and that are still waiting to be given back. */
    async function orphanCount() {
        const rows = await db.prepare("SELECT marketplace, COUNT(*) AS n FROM gpu_instances WHERE status = 'orphan' GROUP BY marketplace").all();
        return (rows || []).map((r) => ({ labels: { marketplace: r.marketplace }, value: Number(r.n) || 0 }));
    }

    /** One pass over the live instances: the reservation, the idle timer, the health. */
    async function reconcileInstance(row, cfg) {
        if (!row.remote_id) return { changed: false, reason: 'creation outcome unknown; reservation retained' };
        const priv = Boolean(row.own_endpoint_id);
        const spec = priv
            ? (ownEndpoints && typeof ownEndpoints.specFor === 'function' ? ownEndpoints.specFor(row) : null)
            : (models.find((m) => m.key === row.model_key) || catalog.find(row.model_key));
        if (!spec) return { changed: false };
        const idleMinutes = Number(row.idle_minutes) > 0 ? Number(row.idle_minutes) : cfg.idle_minutes;
        const t = now();
        const started = toMs(row.started_at) || t;

        // the money that ran while we were away
        await charge(row, t, 'the GPU ran');

        // Begin deletion a minute early to allow the reconciliation interval and provider latency.
        // A provider outage can still exceed this allowance; retain the commitment until confirmed gone.
        if (t - started >= Math.max(0, Number(row.max_runtime_minutes) * 60_000 - 60_000)) {
            await destroy({ ...row, charged_at: row.charged_at }, 'the reservation ran out');
            return { changed: true, action: 'destroyed', reason: 'the reservation ran out' };
        }

        // 2. the idle timer: the offer scales to zero (unless it is inside the warm window). The clock runs
        //    from the moment the instance was ready, not from the moment it was rented: an instance that is still
        //    starting is never idle. A person's own endpoint has its own idle timer.
        if (row.status === 'running') {
            const lastUsed = toMs(row.last_used_at) || toMs(row.ready_at) || started;
            if (t - lastUsed >= idleMinutes * 60_000 && !inWarmWindow(cfg.warm_window, t)) {
                await destroy({ ...row, charged_at: row.charged_at }, 'idle');
                return { changed: true, action: 'scaled_to_zero', reason: 'idle for ' + idleMinutes + ' minutes' };
            }
        }

        // 3. the health of the instance
        if (row.status === 'starting') {
            const adapter = adapterFor(row.marketplace, cfg);
            if (!adapter) return { changed: false };
            // a row without a marketplace id: the crash between the rental and the row's update. The
            // sweep finds the instance by the label and links it; until then there is nothing to poll.
            if (!row.remote_id) return { changed: false };
            let info = null;
            try {
                info = await adapter.showInstance(row.remote_id);
            } catch (err) {
                return { changed: false, error: String(err && err.message).slice(0, 200) };
            }
            const state = String((info && info.state) || 'unknown').toLowerCase();
            if (DEAD_STATES.includes(state)) {
                await destroy({ ...row, charged_at: row.charged_at }, 'the instance ' + state);
                if (!priv) await request(spec.key, 'launch', 'service:ai');
                return { changed: true, action: 'died', reason: 'the instance ' + state };
            }
            const endpoint = info && info.endpoint ? String(info.endpoint) : '';
            if (endpoint && !(await healthy(endpoint))) {
                // the endpoint is there but does not answer: the instance is dead, not slow
                const failures = Number(row.health_failures || 0) + 1;
                await db.prepare('UPDATE gpu_instances SET health_failures = ?, last_health_at = ?, updated_at = ? WHERE id = ?')
                    .run(failures, iso(t), iso(t), row.id);
                if (failures >= HEALTH_FAILURES) {
                    await destroy({ ...row, charged_at: row.charged_at }, 'the endpoint never answered');
                    if (!priv) await request(spec.key, 'launch', 'service:ai');
                    return { changed: true, action: 'died', reason: 'the endpoint never answered' };
                }
                return { changed: false, health_failures: failures };
            }
            if (endpoint && await healthy(endpoint)) {
                // the cold start: from the launch to the first answered request
                await db.prepare("UPDATE gpu_instances SET status = 'running', endpoint = ?, ready_at = ?, last_health_at = ?, health_failures = 0, cold_start_ms = ?, updated_at = ? WHERE id = ?")
                    .run(endpoint, iso(t), iso(t), String(Math.max(0, t - started)), iso(t), row.id);
                if (priv) {
                    if (ownEndpoints && typeof ownEndpoints.ready === 'function') await ownEndpoints.ready({ ...row, endpoint }, endpoint);
                } else {
                    await register(spec, { ...row, endpoint });
                }
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
            // the instance died: a shared offer leaves the pool and a new one is rented; a person's own
            // endpoint stops (they can start it again when they want it).
            await destroy({ ...row, charged_at: row.charged_at }, 'the endpoint stopped answering');
            if (!priv) await request(spec.key, 'launch', 'service:ai');
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
            idle_minutes: row.idle_minutes == null ? null : Number(row.idle_minutes),
            own_endpoint_id: row.own_endpoint_id || null,
            label: row.label,
            cold_start_ms: row.cold_start_ms == null ? null : String(row.cold_start_ms),
            destroy_failures: Number(row.destroy_failures || 0),
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
        // Recovery and orphan cleanup also run while new rental spending is disabled.
        await sweepOrphans(cfg);
        if (!cfg.enabled) {
            // Lowering the cap to zero disables new launches, but must not strand paid instances.
            const rows = await db.prepare("SELECT * FROM gpu_instances WHERE status IN ('starting','running','stopping')").all();
            for (const row of rows) if (row.remote_id && adapterFor(row.marketplace, cfg)) await destroy(row, 'GPU budget disabled');
            return { ok: false, reason: cfg.reason, launched: 0, stopped: 0, destroyed: 0 };
        }

        let launched = 0;
        let stopped = 0;
        let destroyed = 0;

        if ((await moneySummary()).committed_nano > cfg.cap_nano) {
            for (const row of await db.prepare("SELECT * FROM gpu_instances WHERE status IN ('starting','running','stopping')").all()) {
                if (row.remote_id && adapterFor(row.marketplace, cfg)) await destroy(row, 'monthly cap lowered');
            }
            return { ok: false, reason: 'monthly cap lowered; paid instances are being released', launched: 0, stopped: 0, destroyed: 0 };
        }


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
                    if (!res.dry_run) launched += 1;
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
            if (res.ok && !res.dry_run) launched += 1;
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
            // the last measured cold start (the rows are newest first)
            const measured = rows.find((r) => r.model_key === spec.key && r.cold_start_ms != null) || null;
            return {
                key: spec.key,
                display_name: spec.display_name,
                marketplace: spec.marketplace,
                runtime: spec.runtime.kind,
                requirements: spec.requirements,
                weights_url: catalog.weightsUrl(spec),
                command: catalog.commandOf(spec),
                cold_start_ms: measured ? String(measured.cold_start_ms) : null,
                instance: describe(live),
            };
        });
        return {
            strategy: cfg.strategy,
            dry_run: cfg.dry_run,
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

    /** The private-endpoint hooks, attached once the endpoint module exists (server/index.js). */
    function attachEndpoints(hooks) {
        ownEndpoints = hooks || null;
        return ownEndpoints;
    }

    /** The live rent of an endpoint (for its owner's proxy and its stop). */
    async function instanceForEndpoint(ownEndpointId) {
        return liveInstanceForEndpoint(ownEndpointId);
    }

    /** A request reached an offer: the idle timer runs from now, not from the moment it became ready. */
    async function noteUse(providerKey) {
        if (!providerKey) return 0;
        const res = await db.prepare("UPDATE gpu_instances SET last_used_at = ?, updated_at = ? WHERE provider_key = ? AND status = 'running'")
            .run(iso(now()), iso(now()), String(providerKey));
        return Number(res && res.changes) || 0;
    }

    /** Give an endpoint's rent back (its owner pressed stop); the afterDestroy hook settles the money. */
    async function destroyEndpoint(ownEndpointId, reason = 'the owner stopped it', { actor = 'service:ai' } = {}) {
        const row = await liveInstanceForEndpoint(ownEndpointId);
        if (!row) return { ok: true, note: 'not running' };
        return destroy(row, reason, { actor });
    }

    return {
        state,
        preview,
        tick,
        launch,
        attachEndpoints,
        launchSpec,
        request,
        supports,
        config,
        moneySummary,
        sweepOrphans,
        destroyFailures,
        orphanCount,
        instanceForEndpoint,
        noteUse,
        destroyEndpoint,
        /** For the tests: the same thing the reconciler does with one instance. */
        reconcileInstance,
        inWarmWindow,
    };
}

module.exports = { createGpuProvisioner, HEALTH_INTERVAL_MS, HEALTH_FAILURES };
