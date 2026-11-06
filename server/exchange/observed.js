'use strict';
/**
 * What the Exchange catalog measures: uptime, p50/p95 and request counts from the runs that actually
 * happened, never from a rollup keyed by a different model id.
 *
 * A registry model row names the model ("gpt-5-nano"); a run records the id its upstream resolved
 * ("gpt-5-nano-2025-08-07"). A run belongs to the longest registry key it extends by a revision —
 * a date, a version or a tag. `gpt-5` therefore never collects `gpt-5-mini-2025-08-07`; the mini row
 * does, by exact name. Cached answers carry no provider of their own, so they follow the run they
 * reused (`cached_from`). A failed run answered nothing, so the provider and model it last tried are
 * read from its request rows.
 *
 * The latency of an answer is its time to the first token when the receipt recorded one (a streamed
 * answer), else the total provider latency of the attempt that answered. No samples means null, not 0.
 * Nothing here is per person, and neither a prompt nor an answer is read.
 */
const DAY_MS = 86400000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// What an upstream appends to a registry name: -2025-08-07, -v3-0324, -4-5-20251001, :free, @rev.
const REVISION = /^(?:-\d{4}-\d{2}-\d{2}(?:[-.][A-Za-z0-9]+)*|-[vV]\d+(?:[.-][A-Za-z0-9]+)*|-\d+(?:[.-]\d+)*(?:-[A-Za-z0-9]+)*|:[A-Za-z0-9._-]+|@[A-Za-z0-9._-]+)$/;

const leafOf = (key) => {
    const s = String(key || '');
    return s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
};

/** Does one registry model key name the model a run records? Exact, or a revision of it. */
function modelMatches(rowModel, runModel) {
    if (!rowModel || !runModel) return false;
    const row = String(rowModel);
    const run = String(runModel);
    if (row === run) return true;
    const rowLeaf = leafOf(row);
    const runLeaf = leafOf(run);
    if (rowLeaf === runLeaf) return true;
    for (const [a, b] of [[rowLeaf, runLeaf], [row, run]]) {
        if (b.startsWith(a) && REVISION.test(b.slice(a.length))) return true;
    }
    return false;
}

/** Linear-interpolated percentile (the same reading as PostgreSQL's percentile_cont), whole ms. */
function percentile(values, p) {
    if (!values || !values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const at = (sorted.length - 1) * p;
    const lo = Math.floor(at);
    const hi = Math.ceil(at);
    const v = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
    return Math.round(v);
}

function createObserved({ db, clock = { now: () => Date.now() } }) {
    // Counted per day, status and effective offer. A cached run's provider is the run it reused; a
    // failed run's is its last attempt (only a provider call can fail an offer — a refused request
    // never reached one).
    const runRows = db.prepare(`SELECT to_char(r.created_at::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, r.status,
            COALESCE(r.provider_key, src.provider_key, a.provider_key) AS provider_key,
            COALESCE(r.model_key, src.model_key, a.model_key) AS model_key,
            COUNT(*)::bigint AS n
        FROM runs r
        LEFT JOIN runs src ON src.id = r.cached_from
        LEFT JOIN LATERAL (
            SELECT q.provider_key, q.model_key FROM requests q
            WHERE q.run_id = r.id AND q.status <> 'skipped'
            ORDER BY q.seq DESC LIMIT 1
        ) a ON r.status = 'failed'
        WHERE r.status IN ('succeeded', 'failed', 'cached')
          AND r.created_at::timestamptz >= ?::timestamptz AND r.created_at::timestamptz <= ?::timestamptz
        GROUP BY 1, 2, 3, 4`);
    const latencyRows = db.prepare(`SELECT COALESCE(r.provider_key, q.provider_key) AS provider_key,
            COALESCE(r.model_key, q.model_key) AS model_key,
            q.latency_ms, rc.body->>'ttft_ms' AS ttft_ms
        FROM runs r
        JOIN requests q ON q.run_id = r.id AND q.status = 'ok'
        LEFT JOIN ai_receipts rc ON rc.run_id = r.id
        WHERE r.status = 'succeeded' AND q.latency_ms IS NOT NULL
          AND r.created_at::timestamptz >= ?::timestamptz AND r.created_at::timestamptz <= ?::timestamptz`);

    /** The real runs and answering attempts of the window, and the UTC day that is "today". */
    async function read({ days = 7 } = {}) {
        const now = clock.now();
        const span = Math.max(1, Number(days) || 7);
        const from = new Date(now - span * DAY_MS).toISOString();
        const to = new Date(now).toISOString();
        const [runs, latencies] = await Promise.all([runRows.all(from, to), latencyRows.all(from, to)]);
        return { from, to, today: dayOf(now), runs, latencies };
    }

    return { read };
}

const EMPTY = () => ({ succeeded: 0, failed: 0, cached: 0, succeeded_today: 0, failed_today: 0, cached_today: 0, p50: null, p95: null });

/**
 * Fold the measured rows into the catalog's offers. `drafts` are `{ providerKey, modelKey, offer }`,
 * where providerKey is the router's record (`shared`) and modelKey is the registry's name; the offer's
 * `provider` stays the real upstream. A row goes to the longest matching model key of its provider.
 */
function fold(observed, drafts) {
    const byProvider = new Map();
    for (const d of drafts) {
        if (!byProvider.has(d.providerKey)) byProvider.set(d.providerKey, []);
        byProvider.get(d.providerKey).push(d);
    }
    const pick = (providerKey, modelKey) => {
        let best = null;
        for (const d of byProvider.get(providerKey) || []) {
            if (!modelMatches(d.modelKey, modelKey)) continue;
            if (!best || d.modelKey.length > best.modelKey.length) best = d;
        }
        return best;
    };
    const stats = new Map(drafts.map((d) => [d, EMPTY()]));
    for (const row of observed.runs) {
        const d = pick(row.provider_key, row.model_key);
        if (!d) continue;
        const s = stats.get(d);
        const n = Number(row.n) || 0;
        if (row.status === 'succeeded') s.succeeded += n;
        else if (row.status === 'failed') s.failed += n;
        else if (row.status === 'cached') s.cached += n;
        if (row.day === observed.today) {
            if (row.status === 'succeeded') s.succeeded_today += n;
            else if (row.status === 'failed') s.failed_today += n;
            else if (row.status === 'cached') s.cached_today += n;
        }
    }
    const samples = new Map(drafts.map((d) => [d, []]));
    for (const row of observed.latencies) {
        const d = pick(row.provider_key, row.model_key);
        if (!d) continue;
        const total = row.latency_ms == null ? null : Number(row.latency_ms);
        const ttft = row.ttft_ms == null || row.ttft_ms === '' ? null : Number(row.ttft_ms);
        const value = Number.isFinite(ttft) && ttft >= 0 ? ttft : (Number.isFinite(total) && total >= 0 ? total : null);
        if (value != null) samples.get(d).push(value);
    }
    for (const [d, values] of samples) {
        const s = stats.get(d);
        s.p50 = percentile(values, 0.5);
        s.p95 = percentile(values, 0.95);
    }
    for (const [d, s] of stats) {
        const real = s.succeeded + s.failed;
        d.offer.speed = { p50_ms: s.p50, p95_ms: s.p95 };
        d.offer.uptime = real > 0 ? s.succeeded / real : null;
        d.offer.requests_7d = real;
        d.offer.requests_today = s.succeeded_today + s.failed_today;
        d.offer.cached_7d = s.cached;
        d.offer.cached_today = s.cached_today;
    }
    return stats;
}

module.exports = { createObserved, fold, modelMatches, percentile };
