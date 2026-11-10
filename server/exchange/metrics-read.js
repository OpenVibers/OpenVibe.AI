'use strict';
const { AiError } = require('../util');
const { TASK_KINDS, DAY } = require('./metrics-rollup');
const MEASURES = ['success_rate', 'latency_p50_ms', 'latency_p95_ms', 'ttft_p50_ms', 'tokens_per_second_p50', 'cost_per_run_usd', 'cost_per_1k_output_tokens_usd'];
const HIGHER = new Set(['success_rate', 'tokens_per_second_p50']);
const date = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const fail = (detail) => { throw new AiError(422, 'metrics.invalid', detail); };
function modelId(v) { if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(v)) fail('model must be a catalogue model slug'); return v; }
function daysOf(v) { if (v == null) return 30; if (!['30', '90'].includes(String(v))) fail('days must be 30 or 90'); return Number(v); }
function kindOf(v) { if (v == null || v === '') return null; if (!TASK_KINDS.includes(v)) fail('unknown task kind'); return v; }
function measuresOf(v) {
    if (v == null) return MEASURES;
    if (typeof v !== 'string') fail('measures must be comma-separated names');
    const values = [...new Set(v.split(','))];
    if (!values.length || values.some((m) => !MEASURES.includes(m))) fail('unknown measure');
    return values;
}
function wire(row, measures = MEASURES) {
    const metrics = typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics;
    return { day: date(row.day), model: row.model, provider: row.provider, task_kind: row.task_kind, runs: Number(row.runs),
        ...Object.fromEntries(measures.map((m) => [m, metrics[m] ?? null])), samples: metrics.samples, computed_at: row.computed_at };
}
function createMetricsRead({ db, clock = { now: () => Date.now() } }) {
    const base = () => ({ schema: 'exchange.metrics@1', minimum_samples: 20, source: 'OpenVibe.AI run receipts',
        methodology: 'Complete UTC days; real uncached runs; successful total latency; decode throughput excludes first-token time. Workloads vary. Sparse measures are null.', measures: MEASURES, task_kinds: TASK_KINDS });
    async function dayOf(value) {
        if (value == null || value === '') {
            const row = await db.prepare('SELECT MAX(day) AS day FROM exchange_metrics_daily WHERE runs >= 20').get();
            return row.day ? date(row.day) : new Date(clock.now() - DAY).toISOString().slice(0, 10);
        }
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || date(new Date(value)) !== value
            || value >= new Date(clock.now()).toISOString().slice(0, 10)) fail('day must be a completed UTC date');
        return value;
    }
    async function series(model, query = {}) {
        modelId(model); const days = daysOf(query.days), kind = kindOf(query.kind);
        const to = new Date(clock.now()).toISOString().slice(0, 10), from = new Date(Date.parse(to) - days * DAY).toISOString().slice(0, 10);
        const rows = await db.prepare(`SELECT * FROM exchange_metrics_daily WHERE model = ? AND runs >= 20 AND day >= ?::date AND day < ?::date
            AND (?::text IS NULL OR task_kind = ?) ORDER BY day, provider, task_kind`).all(model, from, to, kind, kind);
        return { ...base(), model, days, from, to, kind, series: rows.map((r) => wire(r)), missing: 'No published cell means fewer than twenty retained observations or no observations.' };
    }
    async function compare(query = {}) {
        if (typeof query.models !== 'string') fail('models must be one to six comma-separated catalogue slugs');
        const models = [...new Set(query.models.split(','))];
        if (models.length < 1 || models.length > 6) fail('choose at most six models');
        models.forEach(modelId);
        const measures = measuresOf(query.measures), kind = kindOf(query.kind), day = await dayOf(query.day);
        const rows = await db.prepare(`SELECT * FROM exchange_metrics_daily WHERE model = ANY(?::text[]) AND day = ?::date AND runs >= 20
            AND (?::text IS NULL OR task_kind = ?) ORDER BY model, provider, task_kind`).all(models, day, kind, kind);
        return { ...base(), day, kind, measures, models: models.map((model) => ({ model, cells: rows.filter((r) => r.model === model).map((r) => wire(r, measures)) })) };
    }
    async function leaderboard(query = {}) {
        const kind = kindOf(query.kind) || 'chat', measure = query.measure || 'latency_p50_ms';
        if (!MEASURES.includes(measure)) fail('unknown measure');
        const day = await dayOf(query.day);
        const records = await db.prepare(`SELECT * FROM exchange_metrics_daily WHERE day = ?::date AND task_kind = ? AND runs >= 20`).all(day, kind);
        const rows = records.map((r) => wire(r)).filter((r) => r[measure] != null);
        rows.sort((a, b) => (HIGHER.has(measure) ? -1 : 1) * (a[measure] - b[measure]) || a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider));
        return { ...base(), day, kind, measure, direction: HIGHER.has(measure) ? 'higher' : 'lower', rows: rows.slice(0, 100) };
    }
    async function prices(model, query = {}) {
        modelId(model); const days = daysOf(query.days);
        const from = new Date(clock.now() - (days - 1) * DAY).toISOString().slice(0, 10);
        const rows = await db.prepare('SELECT * FROM exchange_prices_daily WHERE model = ? AND day >= ?::date ORDER BY day, provider, offer').all(model, from);
        return { schema: 'exchange.prices@1', model, days, source: 'Daily catalogue-listed prices; not measured run costs', currency: 'USD', per: '1M tokens', series: rows.map((r) => ({ ...r, day: date(r.day) })) };
    }
    async function health(provider) {
        if (typeof provider !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(provider)) fail('invalid provider');
        const to = new Date(Math.floor(clock.now() / 3600000) * 3600000).toISOString(), from = new Date(Date.parse(to) - 7 * DAY).toISOString();
        const rows = await db.prepare('SELECT * FROM exchange_provider_hours WHERE provider = ? AND hour >= ?::timestamptz AND hour < ?::timestamptz AND runs >= 20 ORDER BY hour').all(provider, from, to);
        return { ...base(), provider, days: 7, interval: 'hour', from, to, series: rows };
    }
    return { series, compare, leaderboard, prices, health };
}
module.exports = { createMetricsRead, MEASURES, modelId, daysOf, kindOf };
