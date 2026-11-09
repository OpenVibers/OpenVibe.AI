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
                    : reseller !== null && rental < reseller
                      ? 'would_rent'
                      : 'use_reseller',
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
function createSupply({ db, registry, clock = { now: () => Date.now() } }) {
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
        const value = Object.fromEntries(
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
        );
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
        return { settings: value, dry_run: true };
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
        return {
            dry_run: true,
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
                return decide({
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
            }),
            settings: rows.map((r) => JSON.parse(r.settings)),
        };
    }
    return { save, report };
}
module.exports = { adapter, decide, createSupply };
