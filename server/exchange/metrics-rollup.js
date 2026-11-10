'use strict';

const { canonicalOf, slugOf } = require('./catalog');
const { modelMatches } = require('./observed');
const { upstreamOf } = require('../providers/upstream');
const { latencyOf } = require('./timing');
const DAY = 86400000;
const MIN_SAMPLES = 20;
const TASK_KINDS = ['chat', 'code', 'design', 'search', 'vision', 'speech', 'embedding', 'image', 'video', 'other'];
const iso = (ms) => new Date(ms).toISOString();
const dayOf = (ms) => iso(ms).slice(0, 10);
const number = (value) => value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0 ? null : Number(value);

// Only fixed public categories leave the run store; never a private workflow or template name.
function taskKind(kind, workflow) {
    if (TASK_KINDS.includes(kind)) return kind;
    const name = String(kind || workflow || '').toLowerCase();
    for (const [pattern, task] of [[/^(?:codes?|agent)\./, 'code'], [/^design\./, 'design'], [/^(?:search|research)\./, 'search'],
        [/^(?:vision|image\.analy)/, 'vision'], [/^(?:speech|audio|ai\.transcrib)/, 'speech'], [/^(?:image|ai\.image)/, 'image'],
        [/^(?:video|ai\.video)/, 'video'], [/^(?:embed|ai\.embed)/, 'embedding'], [/^(?:chat|text|ai\.(?:chat|complete|generate|summarize|classify|extract|enrich))/, 'chat']]) {
        if (pattern.test(name)) return task;
    }
    return 'other';
}

function quantile(values, p) {
    if (values.length < MIN_SAMPLES) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const i = (sorted.length - 1) * p;
    return sorted[Math.floor(i)] + (sorted[Math.ceil(i)] - sorted[Math.floor(i)]) * (i % 1);
}

function publicOffers(providers, models) {
    const byKey = new Map(providers.filter((p) => p.kind !== 'stub' && !p.metadata?.synthetic && !p.metadata?.hidden
        && !['CUSTOMER_BYOK', 'RESTRICTED'].includes(p.provider_access) && !/^(?:byo:|community:)/.test(p.key)).map((p) => [p.key, p]));
    return models.flatMap((m) => {
        const provider = byKey.get(m.provider_key);
        const upstream = provider && upstreamOf(provider);
        if (!upstream) return [];
        const canonical = canonicalOf(m, { key: upstream.key });
        if (m.metadata?.hidden || m.metadata?.uncensored || /uncensor|abliterat/i.test(`${m.model_key} ${canonical} ${m.metadata?.variant || ''}`)) return [];
        return [{ key: provider.key, provider: upstream.key, keyModel: m.model_key, model: slugOf(canonical) }];
    }).sort((a, b) => b.keyModel.length - a.keyModel.length);
}

function aggregate(rows, offers) {
    const groups = new Map();
    const matches = new Map();
    for (const row of rows) {
        const lookup = `${row.provider}\0${row.model}`;
        if (!matches.has(lookup)) matches.set(lookup, offers.find((o) => o.key === row.provider && modelMatches(o.keyModel, row.model)) || null);
        const offer = matches.get(lookup);
        if (!offer) continue;
        const task = taskKind(row.kind, row.workflow);
        const key = `${offer.model}\0${offer.provider}\0${task}`;
        let cell = groups.get(key);
        if (!cell) {
            cell = { model: offer.model, provider: offer.provider, task_kind: task, runs: 0, successes: 0, latency: [], ttft: [], tps: [], cost: [], tokens: [] };
            groups.set(key, cell);
        }
        cell.runs++;
        const success = row.status === 'succeeded';
        if (success) cell.successes++;
        const latency = latencyOf(row), ttft = number(row.ttft_ms), out = number(row.tokens_out), cost = number(row.cost_usd);
        if (success && latency != null) cell.latency.push(latency);
        if (success && ttft != null && (latency == null || ttft <= latency)) cell.ttft.push(ttft);
        if (success && latency > ttft && ttft != null && out > 0) cell.tps.push(out * 1000 / (latency - ttft));
        if (cost != null) cell.cost.push(cost);
        if (cost != null && out != null) cell.tokens.push({ cost, out });
    }
    return [...groups.values()].filter((c) => c.runs >= MIN_SAMPLES).map((c) => {
        const totalCost = c.cost.reduce((s, v) => s + v, 0);
        const tokens = c.tokens.reduce((s, v) => s + v.out, 0);
        return { model: c.model, provider: c.provider, task_kind: c.task_kind, runs: c.runs, metrics: {
            success_rate: c.successes / c.runs,
            latency_p50_ms: quantile(c.latency, 0.5), latency_p95_ms: quantile(c.latency, 0.95),
            ttft_p50_ms: quantile(c.ttft, 0.5), tokens_per_second_p50: quantile(c.tps, 0.5),
            cost_per_run_usd: c.cost.length >= MIN_SAMPLES ? totalCost / c.cost.length : null,
            cost_per_1k_output_tokens_usd: c.tokens.length >= MIN_SAMPLES && tokens > 0 ? c.tokens.reduce((s, v) => s + v.cost, 0) * 1000 / tokens : null,
            samples: { latency: c.latency.length >= MIN_SAMPLES ? c.latency.length : null,
                ttft: c.ttft.length >= MIN_SAMPLES ? c.ttft.length : null, throughput: c.tps.length >= MIN_SAMPLES ? c.tps.length : null,
                cost: c.cost.length >= MIN_SAMPLES ? c.cost.length : null },
        } };
    });
}

function createMetricsRollup({ db, registry, clock = { now: () => Date.now() }, log = console, retentionDays = 30, enabled = true }) {
    let timer = null, pending = null, stopped = true;
    const receipts = db.prepare(`SELECT c.body->'offer'->>'provider' AS provider, c.body->'offer'->>'model' AS model,
        c.body->>'kind' AS kind, c.body->>'workflow' AS workflow, r.status, r.started_at, r.finished_at,
        c.body->>'latency_ms' AS latency_ms, c.body->>'ttft_ms' AS ttft_ms,
        c.body->'usage'->>'tokens_out' AS tokens_out, c.body->>'cost_usd' AS cost_usd
        FROM ai_receipts c JOIN runs r ON r.id = c.run_id
        WHERE c.created_at >= ?::timestamptz AND c.created_at < ?::timestamptz
          AND r.synthetic = 0 AND r.status IN ('succeeded', 'failed') AND r.cached_from IS NULL`);
    async function tick() {
        if (!enabled) return { skipped: 'disabled' };
        const now = clock.now(), today = Date.parse(`${dayOf(now)}T00:00:00Z`);
        return db.tx(async () => {
            const state = await db.prepare('SELECT * FROM exchange_metrics_job WHERE id = 1 AND (next_due <= ?::timestamptz OR algorithm_version < 2) FOR UPDATE SKIP LOCKED').get(iso(now));
            if (!state) return { skipped: 'not_due' };
            const providers = await registry.listProviders();
            if (providers.some((p) => p.metadata?.drill || p.metadata?.fail)) return { skipped: 'drill' };
            const offers = publicOffers(providers, await registry.listModels());
            // Resume after downtime; never overwrite durable dates whose receipts were already pruned.
            const retainedFrom = today - Math.max(1, Math.min(90, retentionDays - 1)) * DAY;
            const savedDay = state.completed_through instanceof Date ? dayOf(state.completed_through.getTime()) : String(state.completed_through || '').slice(0, 10);
            const through = savedDay ? Date.parse(savedDay + 'T00:00:00Z') : null;
            const from = through == null || state.algorithm_version < 2 ? retainedFrom : Math.max(retainedFrom, through - DAY);
            let days = 0, cells = 0;
            for (let start = from; start < today; start += DAY) {
                const day = dayOf(start);
                const values = aggregate(await receipts.all(iso(start), iso(start + DAY)), offers);
                await db.prepare('DELETE FROM exchange_metrics_daily WHERE day = ?::date').run(day);
                for (const cell of values) {
                    await db.prepare('INSERT INTO exchange_metrics_daily (day, model, provider, task_kind, runs, metrics, computed_at) VALUES (?::date, ?, ?, ?, ?, ?::jsonb, ?::timestamptz)')
                        .run(day, cell.model, cell.provider, cell.task_kind, cell.runs, JSON.stringify(cell.metrics), iso(now));
                }
                days++; cells += values.length;
            }
            await db.prepare('UPDATE exchange_metrics_job SET algorithm_version = 2, next_due = ?::timestamptz, completed_through = ?::date, completed_at = ?::timestamptz WHERE id = 1')
                .run(iso(today + DAY + 5 * 60000), dayOf(today - DAY), iso(now));
            return { days, cells, completed_through: dayOf(today - DAY) };
        });
    }
    function start() {
        if (!enabled || !stopped) return;
        stopped = false;
        const schedule = (delay) => { timer = setTimeout(run, delay); timer.unref?.(); };
        const run = () => {
            pending = tick().catch((err) => log.warn(`[ai] metrics rollup failed: ${err.message}`)).finally(() => {
                pending = null;
                if (!stopped) schedule(60000);
            });
        };
        schedule(5000);
    }
    async function stop() { stopped = true; clearTimeout(timer); if (pending) await pending; }
    return { tick, start, stop };
}

module.exports = { createMetricsRollup, aggregate, publicOffers, taskKind, quantile, MIN_SAMPLES, TASK_KINDS, DAY };
