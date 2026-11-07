'use strict';
/**
 * What the Exchange catalog measures: uptime, p50/p95 and request counts from the provider attempts
 * that actually happened, never from a rollup keyed by a different model id.
 *
 * A registry model row names the model ("gpt-5-nano"); a run records the id its upstream resolved
 * ("gpt-5-nano-2025-08-07"). A run belongs to the longest registry key it extends by a revision —
 * a date, a version or a tag. `gpt-5` therefore never collects `gpt-5-mini-2025-08-07`; the mini row
 * does, by exact name. Cached answers carry no provider of their own, so they follow the run they
 * reused (`cached_from`).
 *
 * Uptime is per real provider attempt, not per run status. A failed run counts against an offer only
 * when an attempt row names that provider and model; a run refused before routing, over quota or by
 * validation has no such row and counts against nothing. An attempt is a success only when it produced
 * output: an ok row whose run ended `output.empty`, or a text attempt that spent every output token
 * (tokens_out = 0, e.g. all of max_tokens went to reasoning), is a failure of that provider and model.
 * A skipped or cancelled row was never an answer and is not a sample.
 *
 * The latency of an answer is its time to the first token when the receipt recorded one (a streamed
 * answer), else the total provider latency of the attempt that answered. Uptime and speed need enough
 * samples: 20 real attempts in the window. Below that both are null while `requests_7d` still says how
 * many attempts there were. No samples means null, not 0.
 * Nothing here is per person, and neither a prompt nor an answer is read.
 */
const DAY_MS = 86400000;
const MIN_SAMPLES = 20;
// sha256(''): what the router stores as a request's output_hash when the provider produced no content.
const EMPTY_OUTPUT_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
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
    // One sample per real provider attempt: ok with output is a success; error, timeout, an empty run
    // and a text attempt that spent every token are failures. Skipped and cancelled rows are not samples
    // (no provider was tried, or the caller left). The run's own provider and model are not used here: a
    // fallback run can name several offers, and a failed run keeps none.
    const attemptRows = db.prepare(`SELECT to_char(r.created_at::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            CASE
                WHEN q.status <> 'ok' THEN 'failed'
                WHEN r.error_code = 'output.empty' THEN 'failed'
                WHEN q.operation IN ('chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'complete', 'messages')
                     AND COALESCE(q.tokens_out, 0) = 0
                     AND (q.output_hash IS NULL OR q.output_hash = '${EMPTY_OUTPUT_HASH}') THEN 'failed'
                ELSE 'succeeded'
            END AS status,
            q.provider_key AS provider_key, q.model_key AS model_key,
            COUNT(*)::bigint AS n
        FROM requests q
        JOIN runs r ON r.id = q.run_id
        WHERE q.status IN ('ok', 'error', 'timeout')
          AND r.status IN ('succeeded', 'failed')
          AND r.created_at::timestamptz >= ?::timestamptz AND r.created_at::timestamptz <= ?::timestamptz
        GROUP BY 1, 2, 3, 4`);
    // A cached answer called no provider; it follows the run it reused (`cached_from`).
    const cachedRows = db.prepare(`SELECT to_char(r.created_at::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            'cached' AS status,
            COALESCE(r.provider_key, src.provider_key) AS provider_key,
            COALESCE(r.model_key, src.model_key) AS model_key,
            COUNT(*)::bigint AS n
        FROM runs r
        LEFT JOIN runs src ON src.id = r.cached_from
        WHERE r.status = 'cached'
          AND r.created_at::timestamptz >= ?::timestamptz AND r.created_at::timestamptz <= ?::timestamptz
        GROUP BY 1, 2, 3, 4`);
    const latencyRows = db.prepare(`SELECT q.provider_key AS provider_key,
            q.model_key AS model_key,
            q.latency_ms, rc.body->>'ttft_ms' AS ttft_ms
        FROM requests q
        JOIN runs r ON r.id = q.run_id
        LEFT JOIN ai_receipts rc ON rc.run_id = r.id
        WHERE q.status = 'ok' AND q.latency_ms IS NOT NULL
          AND r.status IN ('succeeded', 'failed')
          AND (r.error_code IS NULL OR r.error_code <> 'output.empty')
          AND NOT (q.operation IN ('chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'complete', 'messages')
                   AND COALESCE(q.tokens_out, 0) = 0
                   AND (q.output_hash IS NULL OR q.output_hash = '${EMPTY_OUTPUT_HASH}'))
          AND r.created_at::timestamptz >= ?::timestamptz AND r.created_at::timestamptz <= ?::timestamptz`);

    /** The real attempts and cached answers of the window, and the UTC day that is "today". */
    async function read({ days = 7 } = {}) {
        const now = clock.now();
        const span = Math.max(1, Number(days) || 7);
        const from = new Date(now - span * DAY_MS).toISOString();
        const to = new Date(now).toISOString();
        const [attempts, cached, latencies] = await Promise.all([
            attemptRows.all(from, to), cachedRows.all(from, to), latencyRows.all(from, to),
        ]);
        return { from, to, today: dayOf(now), runs: [...attempts, ...cached], latencies };
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
        // A measured number needs enough samples to mean something: below 20 real attempts the catalog
        // says "not measured yet" (null) but still reports how many attempts there were.
        const enough = real >= MIN_SAMPLES;
        d.offer.speed = { p50_ms: enough ? s.p50 : null, p95_ms: enough ? s.p95 : null };
        d.offer.uptime = enough ? s.succeeded / real : null;
        d.offer.requests_7d = real;
        d.offer.requests_today = s.succeeded_today + s.failed_today;
        d.offer.cached_7d = s.cached;
        d.offer.cached_today = s.cached_today;
    }
    return stats;
}

module.exports = { createObserved, fold, modelMatches, percentile, MIN_SAMPLES };
