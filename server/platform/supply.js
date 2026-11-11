'use strict';
const { AiError } = require('../util');
const { vastAdapter } = require('../gpu/vast');
const { runpodAdapter } = require('../gpu/runpod');
// This manager cannot mutate a marketplace, even when accounts are configured.
function adapter(
    provider,
    { key, hourlyCeiling, monthlyCeiling, fetchImpl } = {},
) {
    const upstream =
        provider === 'vast'
            ? vastAdapter({ key, fetchImpl })
            : provider === 'runpod'
              ? runpodAdapter({ key, fetchImpl })
              : null;
    if (!upstream) throw new Error('Unknown marketplace');
    const refuse = async () => {
        if (!key || !(hourlyCeiling > 0) || !(monthlyCeiling > 0))
            throw new AiError(
                409,
                'gpu.owner_gate',
                'Owner keys and both spend ceilings are required',
            );
        throw new AiError(
            409,
            'gpu.dry_run',
            'The supply manager is dry-run only',
        );
    };
    return { id: provider, rent: refuse, stop: refuse };
}
function decide({ demand, quotes, settings, now = Date.now() }) {
    const input = Number(demand.tokens_in) || 0,
        output = Number(demand.tokens_out) || 0;
    const load = output / 24;
    const fresh = quotes.filter(
        (q) =>
            Number.isFinite(q.hourly_usd) &&
            q.hourly_usd > 0 &&
            q.measured_tokens_per_second > 0 &&
            q.vram_mb >= settings.required_vram_mb &&
            Date.parse(q.observed_at) >= now - 7 * 86400000,
    );
    const ranked = fresh
        .map((q) => ({
            ...q,
            utilisation: load / (q.measured_tokens_per_second * 3600),
            cost_per_million: load > 0 ? (q.hourly_usd * 1e6) / load : null,
        }))
        .filter((q) => q.utilisation <= 1)
        .sort((a, b) => a.hourly_usd - b.hourly_usd);
    const chosen = ranked[0] || null;
    const reseller = Number.isFinite(demand.reseller_cost_usd)
        ? demand.reseller_cost_usd
        : null;
    const rental = chosen ? chosen.hourly_usd * 24 : null;
    const revenue =
        (input * settings.input_per_million +
            output * settings.output_per_million) /
        1e6;
    const capped =
        chosen &&
        chosen.hourly_usd <= settings.hourly_ceiling_usd &&
        chosen.hourly_usd * 24 * 31 <= settings.monthly_ceiling_usd;
    return {
        dry_run: true,
        model: settings.model,
        action:
            !input && !output
                ? 'would_stop'
                : !chosen
                  ? 'needs_measurement'
                  : !capped
                    ? 'ceiling_required'
                    : reseller != null && rental >= reseller
                      ? 'use_reseller'
                      : 'would_rent',
        selected: chosen,
        reseller_cost_usd: reseller,
        rental_cost_usd: rental,
        revenue_usd: revenue,
        margin_usd: rental == null ? null : revenue - rental,
        price: {
            in: settings.input_per_million,
            out: settings.output_per_million,
        },
        runtime: settings.runtime,
        idle_minutes: settings.idle_minutes,
    };
}
function createSupply({ db, registry, clock = { now: () => Date.now() }, gpus = null, log = console }) {
    /**
     * The owner gate of live supply: the provisioner must have the marketplace key, the monthly cap and the
     * explicit cost bound, and quote-only mode must be off. Without all of them a supply plan can be saved and
     * priced, but it never asks for a rental.
     */
    function gate() {
        if (!gpus || typeof gpus.config !== 'function') return { ok: false, reason: 'The GPU provisioner is off on this host.' };
        const cfg = gpus.config();
        if (!cfg.enabled) return { ok: false, reason: cfg.reason === 'no Vast.ai or RunPod API key'
            ? 'Add a Vast.ai or RunPod API key first; nothing was changed.'
            : cfg.reason === 'no monthly cap'
                ? 'Set a positive monthly GPU cap first; nothing was changed.'
                : 'Set ai.gpus.extra_hourly_nano and ai.gpus.costs_bounded=true first; nothing was changed.' };
        if (cfg.dry_run) return { ok: false, reason: 'GPU rentals are in quote-only mode (ai.gpus.dry_run); turn that off first; nothing was changed.' };
        return { ok: true, cfg };
    }
    async function save(b, actor) {
        if (
            typeof b.model !== 'string' ||
            !b.model ||
            !['vllm', 'sglang'].includes(b.runtime) ||
            ![
                'input_per_million',
                'output_per_million',
                'hourly_ceiling_usd',
                'monthly_ceiling_usd',
                'required_vram_mb',
                'idle_minutes',
            ].every((k) => Number.isFinite(b[k]) && b[k] >= 0) ||
            b.required_vram_mb <= 0 ||
            b.idle_minutes < 1
        )
            throw new AiError(
                422,
                'ai.invalid',
                'Model, runtime, prices, ceilings, VRAM and idle timeout are required',
            );
        const enabled = b.enabled === true;
        if (enabled) {
            const g = gate();
            if (!g.ok) throw new AiError(409, 'gpu.owner_gate', g.reason);
        }
        const value = {
            ...Object.fromEntries(
                [
                    'model',
                    'runtime',
                    'input_per_million',
                    'output_per_million',
                    'hourly_ceiling_usd',
                    'monthly_ceiling_usd',
                    'required_vram_mb',
                    'idle_minutes',
                ].map((k) => [k, b[k]]),
            ),
            enabled,
        };
        await db
            .prepare(
                'INSERT INTO exchange_supply_settings(model,settings,updated_at,actor) VALUES(?,?,?,?) ON CONFLICT(model) DO UPDATE SET settings=excluded.settings,updated_at=excluded.updated_at,actor=excluded.actor',
            )
            .run(
                b.model,
                JSON.stringify(value),
                new Date(clock.now()).toISOString(),
                actor,
            );
        for (const m of await registry.listModels())
            if (m.model_key === b.model && m.provider_key.startsWith('gpu.'))
                await registry.upsertModel(
                    {
                        ...m,
                        cost: {
                            in_per_mtok: b.input_per_million,
                            out_per_mtok: b.output_per_million,
                            cached_per_mtok: b.input_per_million,
                            source: 'urn:openvibe:owner-fixed-price',
                            verified_at: new Date(clock.now())
                                .toISOString()
                                .slice(0, 10),
                        },
                        metadata: {
                            ...m.metadata,
                            owner_fixed_price: true,
                            open_weights: true,
                        },
                    },
                    { actor },
                );
        await registry.audit(actor, enabled ? 'supply.open' : 'supply.save', 'gpu_supply', value.model, {
            metadata: {
                enabled,
                input_per_million: value.input_per_million,
                output_per_million: value.output_per_million,
                hourly_ceiling_usd: value.hourly_ceiling_usd,
                monthly_ceiling_usd: value.monthly_ceiling_usd,
                required_vram_mb: value.required_vram_mb,
                idle_minutes: value.idle_minutes,
            },
        });
        return { settings: value, enabled, dry_run: !enabled };
    }
    async function report() {
        const rows = await db
            .prepare(
                'SELECT settings FROM exchange_supply_settings ORDER BY model',
            )
            .all();
        const since = new Date(clock.now() - 86400000).toISOString();
        const demand = await db
            .prepare(
                "SELECT model_key,SUM(tokens_in)::double precision tokens_in,SUM(tokens_out)::double precision tokens_out,SUM(cost_usd)::double precision reseller_cost_usd FROM runs WHERE created_at >= ? AND status='succeeded' AND synthetic=0 GROUP BY model_key",
            )
            .all(since);
        // Quote inputs must be recorded, dated price-book observations with a measured throughput for this model.
        const quotes = await db.prepare('SELECT * FROM gpu_price_book').all();
        const providers = await registry.listProviders();
        const measured = await db
            .prepare(
                "SELECT provider_key,model_key,COUNT(*)::int samples,SUM(tokens_out)*1000.0/NULLIF(SUM(latency_ms),0) tps FROM requests WHERE created_at >= ? AND status='ok' AND tokens_out>0 AND latency_ms>0 GROUP BY provider_key,model_key",
            )
            .all(since);
        const modelRows = await registry.listModels();
        const gpuProviders = new Map(providers.filter((p) => String(p.key).startsWith('gpu.')).map((p) => [p.key, p]));
        const supplyGate = gate();
        const liveSettings = rows.map((r) => JSON.parse(r.settings)).filter((s) => s.enabled === true);
        return {
            // Live supply is the owner's explicit switch plus every owner gate; a plan stays quote-only otherwise.
            dry_run: !(liveSettings.length && supplyGate.ok),
            live: Boolean(liveSettings.length && supplyGate.ok),
            gate: supplyGate,
            price_book: quotes,
            reports: rows.map((r) => {
                const settings = JSON.parse(r.settings);
                const observations = quotes.map((q) => {
                    const provider = providers.find(
                        (p) => p.metadata?.gpu?.gpu_name === q.gpu,
                    );
                    const sample = measured.find(
                        (m) =>
                            m.provider_key === provider?.key &&
                            m.model_key === settings.model &&
                            m.samples >= 20,
                    );
                    return {
                        ...q,
                        vram_mb: Number(q.vram_mb),
                        hourly_usd: Number(q.hourly_usd),
                        measured_tokens_per_second: sample
                            ? Number(sample.tps)
                            : null,
                        sample_count: sample?.samples || 0,
                    };
                });
                const usage =
                    demand.find((d) => d.model_key === settings.model) || {};
                const resale = modelRows
                    .filter(
                        (m) =>
                            m.model_key === settings.model &&
                            !m.provider_key.startsWith('gpu.') &&
                            m.cost?.in_per_mtok != null &&
                            m.cost?.out_per_mtok != null,
                    )
                    .map(
                        (m) =>
                            ((Number(usage.tokens_in) || 0) *
                                Number(m.cost.in_per_mtok) +
                                (Number(usage.tokens_out) || 0) *
                                    Number(m.cost.out_per_mtok)) /
                            1e6,
                    )
                    .filter(Number.isFinite);
                const plan = decide({
                    settings,
                    demand: {
                        ...usage,
                        reseller_cost_usd: resale.length
                            ? Math.min(...resale)
                            : null,
                    },
                    quotes: observations,
                    now: clock.now(),
                });
                // The route the fixed prices would serve: a GPU host registers this model as a normal provider
                // (server/gpu/provisioner.js), so the registry answer is the truth, not a second list.
                const registered = modelRows.filter((m) => m.model_key === settings.model && gpuProviders.has(m.provider_key));
                const row = registered.find((m) => gpuProviders.get(m.provider_key).status === 'active') || registered[0] || null;
                const owner = row ? gpuProviders.get(row.provider_key) : null;
                const route = row ? {
                    registered: true,
                    provider_key: row.provider_key,
                    provider_status: owner.status,
                    model_status: row.status,
                    fixed: row.metadata?.owner_fixed_price === true,
                    price: { in: row.cost?.in_per_mtok ?? null, out: row.cost?.out_per_mtok ?? null },
                    live: owner.status === 'active' && row.status === 'active' && row.cost?.in_per_mtok != null && row.cost?.out_per_mtok != null,
                } : { registered: false, live: false, reason: 'No GPU host has registered this model yet.' };
                return {
                    ...plan,
                    enabled: settings.enabled === true,
                    active: settings.enabled === true && supplyGate.ok,
                    route,
                };
            }),
            settings: rows.map((r) => JSON.parse(r.settings)),
        };
    }

    /**
     * The reconciler half of live supply: when the owner enabled a plan and the plan says renting is cheaper
     * than buying the same tokens, ask the existing GPU reconciler to launch it. It places a request only:
     * the provisioner checks the key, the monthly cap, the reservation and the owner's approved hourly ceiling
     * before it rents anything. One pending request and one live instance per model, however often this ticks.
     */
    async function tick() {
        const g = gate();
        if (!g.ok) return { queued: [], reason: g.reason };
        const plan = await report();
        const queued = [];
        for (const row of plan.reports) {
            if (!row.enabled || row.action !== 'would_rent' || !row.model) continue;
            if (typeof gpus.supports === 'function' && !gpus.supports(row.model)) continue;
            const running = await db.prepare("SELECT 1 FROM gpu_instances WHERE model_key = ? AND status IN ('starting','running','stopping') LIMIT 1").get(row.model);
            if (running) continue;
            const waiting = await db.prepare("SELECT 1 FROM gpu_requests WHERE model_key = ? AND action = 'launch' AND done_at IS NULL LIMIT 1").get(row.model);
            if (waiting) continue;
            try {
                await gpus.request(row.model, 'launch', 'service:supply');
                await registry.audit('service:supply', 'supply.launch_requested', 'gpu_supply', row.model, {
                    metadata: {
                        hourly_usd: row.selected?.hourly_usd ?? null,
                        input_per_million: row.price?.in ?? null,
                        output_per_million: row.price?.out ?? null,
                        rental_cost_usd: row.rental_cost_usd ?? null,
                        reseller_cost_usd: row.reseller_cost_usd ?? null,
                    },
                });
                queued.push(row.model);
            } catch (err) {
                log.warn(`[supply] could not request ${row.model}: ${String((err && err.message) || err).slice(0, 200)}`);
            }
        }
        return { queued, checked: plan.reports.length };
    }

    return { save, report, tick, gate };
}
module.exports = { adapter, decide, createSupply };
