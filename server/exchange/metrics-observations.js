'use strict';
const { publicOffers, quantile, DAY, MIN_SAMPLES } = require('./metrics-rollup');
const { modelMatches } = require('./observed');
const { latencyOf } = require('./timing');
const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const numeric = (value) => value == null || !Number.isFinite(Number(value)) || Number(value) < 0 ? null : Number(value);

function healthCells(rows, offers) {
    const matches = new Map(), cells = new Map();
    for (const row of rows) {
        const identity = `${row.provider}\0${row.model}`;
        if (!matches.has(identity)) matches.set(identity, offers.find((o) => o.key === row.provider && modelMatches(o.keyModel, row.model)) || null);
        const offer = matches.get(identity);
        if (!offer) continue;
        const key = `${row.hour}\0${offer.provider}`;
        const cell = cells.get(key) || { hour: row.hour, provider: offer.provider, runs: 0, successes: 0, latency: [] };
        cell.runs++;
        if (row.status === 'succeeded') {
            cell.successes++;
            const latency = latencyOf(row);
            if (latency != null) cell.latency.push(latency);
        }
        cells.set(key, cell);
    }
    return [...cells.values()].filter((c) => c.runs >= MIN_SAMPLES).map((c) => ({ hour: c.hour, provider: c.provider, runs: c.runs,
        success_rate: c.successes / c.runs, latency_p50_ms: quantile(c.latency, 0.5), latency_samples: c.latency.length >= MIN_SAMPLES ? c.latency.length : null }));
}

function createObservations({ db, registry, catalog, clock = { now: () => Date.now() }, log = console, enabled = true }) {
    let timer, pending, stopped = true;
    async function tick() {
        if (!enabled) return { skipped: 'disabled' };
        const now = clock.now(), end = Math.floor(now / HOUR) * HOUR;
        return db.tx(async () => {
            const state = await db.prepare('SELECT * FROM exchange_observations_job WHERE id = 1 AND (next_due <= ?::timestamptz OR algorithm_version < 2) FOR UPDATE SKIP LOCKED').get(iso(now));
            if (!state) return { skipped: 'not_due' };
            const providers = await registry.listProviders();
            if (providers.some((p) => p.metadata?.drill || p.metadata?.fail)) return { skipped: 'drill' };
            const offers = publicOffers(providers, await registry.listModels());
            const oldest = end - 7 * DAY;
            const from = state.completed_hour && state.algorithm_version >= 2 ? Math.max(oldest, Date.parse(state.completed_hour) - HOUR) : oldest;
            const rows = await db.prepare(`SELECT to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:00:00"Z"') AS hour,
                c.body->'offer'->>'provider' AS provider, c.body->'offer'->>'model' AS model,
                r.status, r.started_at, r.finished_at, c.body->>'latency_ms' AS latency_ms FROM ai_receipts c JOIN runs r ON r.id = c.run_id
                WHERE c.created_at >= ?::timestamptz AND c.created_at < ?::timestamptz
                AND r.synthetic = 0 AND r.cached_from IS NULL AND r.status IN ('succeeded', 'failed')`).all(iso(from), iso(end));
            const cells = healthCells(rows, offers);
            await db.prepare('DELETE FROM exchange_provider_hours WHERE hour < ?::timestamptz OR hour >= ?::timestamptz').run(iso(oldest), iso(from));
            for (const c of cells) await db.prepare(`INSERT INTO exchange_provider_hours
                (hour, provider, runs, success_rate, latency_p50_ms, latency_samples, computed_at) VALUES (?::timestamptz, ?, ?, ?, ?, ?, ?::timestamptz)`)
                .run(c.hour, c.provider, c.runs, c.success_rate, c.latency_p50_ms, c.latency_samples, iso(now));
            const day = iso(now).slice(0, 10);
            const snapshot = await catalog.models();
            let prices = 0;
            for (const model of snapshot.models || []) {
                if (model.uncensored) continue;
                for (const offer of model.offers || []) {
                    const out = await db.prepare(`INSERT INTO exchange_prices_daily
                        (day, model, provider, offer, price_in, price_out, price_cached, source, captured_at)
                        VALUES (?::date, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz) ON CONFLICT DO NOTHING`)
                        .run(day, model.slug, offer.provider, offer.id || offer.model, numeric(offer.price?.in), numeric(offer.price?.out), numeric(offer.price?.cached), offer.price_source || null, iso(now));
                    prices += out.changes;
                }
            }
            await db.prepare('UPDATE exchange_observations_job SET algorithm_version = 2, next_due = ?::timestamptz, completed_hour = ?::timestamptz WHERE id = 1')
                .run(iso(end + HOUR + 5 * 60000), iso(end - HOUR));
            return { hours: cells.length, prices };
        });
    }
    function start() {
        if (!enabled || !stopped) return;
        stopped = false;
        const run = () => { pending = tick().catch((err) => log.warn(`[ai] observations failed: ${err.message}`)).finally(() => {
            pending = null;
            if (!stopped) { timer = setTimeout(run, 60000); timer.unref?.(); }
        }); };
        timer = setTimeout(run, 5000); timer.unref?.();
    }
    async function stop() { stopped = true; clearTimeout(timer); if (pending) await pending; }
    return { tick, start, stop };
}
module.exports = { createObservations, healthCells };
