'use strict';

/**
 * Real-traffic share (plan 2026-11-09, stage B8).
 *
 * Which models real requests and tokens actually carried, per model and per app category, from the
 * Exchange receipts. It is an aggregate or it is nothing: no prompt, no answer, no person, no app's
 * name. Every cell needs at least k requests before it is published; a smaller cell is withheld and
 * counted only in the withheld total, so a category with one user cannot be read back from the shares.
 *
 * The week is a completed UTC week (Monday 00:00 to the next Monday). The answer is stored once per
 * week: receipts are pruned with their runs, and the stored row is the durable public record. The
 * last completed week is computed on first read; a past week is only recomputed while its receipts are
 * still in the retention window (never a silent empty week after they aged out).
 *
 * "Category" is the first-party service whose run answered (a product), or `apps` for every developer
 * app together. Named developer apps would be per-app data, so they are never named; the network's
 * own moderation requests are not Exchange traffic and are not counted.
 */
const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const K_DEFAULT = 20;
const RETENTION_DAYS = 30;
const SCHEMA = 'exchange.traffic-share@1';

class ShareError extends Error {
    constructor(status, code, detail) {
        super(detail);
        this.name = 'ShareError';
        this.status = status;
        this.code = code;
        this.detail = detail;
    }
}

const round = (v) => Math.round(Number(v) * 1e6) / 1e6;
const int = (v) => Math.max(0, Math.round(Number(v) || 0));
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayString = (v) => (v instanceof Date ? isoDay(v.getTime()) : String(v || '').slice(0, 10));

/** The Monday 00:00 UTC of the week a moment is in. */
function mondayOf(ms) {
    const d = new Date(ms);
    const offset = (d.getUTCDay() + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset);
}

/** The last completed week: this week's Monday minus seven days. */
function lastCompleteWeek(ms) {
    return mondayOf(ms) - WEEK_MS;
}

function parseWeek(day) {
    const s = String(day || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ShareError(422, 'traffic_share.week_invalid', 'week must be a YYYY-MM-DD Monday');
    const ms = Date.parse(`${s}T00:00:00.000Z`);
    if (!Number.isFinite(ms) || new Date(ms).getUTCDay() !== 1) throw new ShareError(422, 'traffic_share.week_invalid', 'week must be a Monday 00:00 UTC');
    return ms;
}

/** A first-party service keeps its product name; every developer app folds into one public category. */
function categoryOf(row) {
    if (row.requester_type === 'app') return 'apps';
    if (row.requester_type === 'service' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(String(row.requester_id || ''))) return String(row.requester_id);
    return 'other';
}

const shareOf = (n, total) => (total > 0 ? round(n / total) : null);

function aggregate(cells, keyFields, keyOf) {
    const map = new Map();
    for (const cell of cells) {
        const key = keyOf(cell);
        const row = map.get(key) || { ...Object.fromEntries(keyFields.map((f) => [f, cell[f]])), requests: 0, tokens_in: 0, tokens_out: 0 };
        row.requests += cell.requests;
        row.tokens_in += cell.tokens_in;
        row.tokens_out += cell.tokens_out;
        map.set(key, row);
    }
    return [...map.values()];
}

/**
 * Read the receipts of one completed week and publish what meets the k rule. Pure over the rows passed
 * to it, so a test can replay a small fixture without a database or a paid call.
 */
function aggregateWeek({ rows = [], weekStart, k = K_DEFAULT, generatedAt = new Date().toISOString() } = {}) {
    const start = typeof weekStart === 'number' ? weekStart : parseWeek(weekStart);
    const cells = new Map();
    let allRequests = 0;
    let allTokens = 0;
    for (const row of rows) {
        const provider = String(row.provider || '').trim();
        const model = String(row.model || '').trim();
        if (!provider || !model) continue;
        const category = categoryOf(row);
        const key = `${category}\0${provider}\0${model}`;
        const cell = cells.get(key) || { category, provider, model, requests: 0, tokens_in: 0, tokens_out: 0 };
        cell.requests += int(row.requests);
        cell.tokens_in += int(row.tokens_in);
        cell.tokens_out += int(row.tokens_out);
        cells.set(key, cell);
        allRequests += int(row.requests);
        allTokens += int(row.tokens_in) + int(row.tokens_out);
    }
    const all = [...cells.values()];
    const published = all.filter((c) => c.requests >= Math.max(1, Number(k) || K_DEFAULT));
    const withheld = all.filter((c) => c.requests < Math.max(1, Number(k) || K_DEFAULT));
    const requests = published.reduce((n, c) => n + c.requests, 0);
    const tokens = published.reduce((n, c) => n + c.tokens_in + c.tokens_out, 0);
    const tokensIn = published.reduce((n, c) => n + c.tokens_in, 0);
    for (const cell of published) cell.tokens = cell.tokens_in + cell.tokens_out;
    const offers = aggregate(published, ['provider', 'model'], (c) => `${c.provider}\0${c.model}`)
        .map((r) => ({
            provider: r.provider, model: r.model, requests: r.requests,
            tokens_in: r.tokens_in, tokens_out: r.tokens_out, tokens: r.tokens_in + r.tokens_out,
            request_share: shareOf(r.requests, requests), token_share: shareOf(r.tokens_in + r.tokens_out, tokens),
        }))
        .sort((a, b) => b.requests - a.requests || b.tokens - a.tokens || a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider));
    const models = aggregate(published, ['model'], (c) => c.model)
        .map((r) => {
            const providers = new Set(published.filter((c) => c.model === r.model).map((c) => c.provider)).size;
            return { model: r.model, providers, requests: r.requests, tokens_in: r.tokens_in, tokens_out: r.tokens_out,
                tokens: r.tokens_in + r.tokens_out, request_share: shareOf(r.requests, requests), token_share: shareOf(r.tokens_in + r.tokens_out, tokens) };
        })
        .sort((a, b) => b.requests - a.requests || b.tokens - a.tokens || a.model.localeCompare(b.model));
    const categories = aggregate(published, ['category'], (c) => c.category)
        .map((r) => ({ category: r.category, requests: r.requests, tokens_in: r.tokens_in, tokens_out: r.tokens_out,
            tokens: r.tokens_in + r.tokens_out, request_share: shareOf(r.requests, requests), token_share: shareOf(r.tokens_in + r.tokens_out, tokens) }))
        .sort((a, b) => b.requests - a.requests || b.tokens - a.tokens || a.category.localeCompare(b.category));
    const withheldRequests = withheld.reduce((n, c) => n + c.requests, 0);
    const withheldTokens = withheld.reduce((n, c) => n + c.tokens_in + c.tokens_out, 0);
    return {
        $schema: SCHEMA,
        week_start: isoDay(start),
        week_end: isoDay(start + WEEK_MS),
        generated_at: generatedAt,
        k: Math.max(1, Number(k) || K_DEFAULT),
        totals: { requests, tokens_in: tokensIn, tokens_out: tokens - tokensIn, tokens },
        offers,
        models,
        categories,
        withheld: { cells: withheld.length, requests: withheldRequests, tokens: withheldTokens, share_of_requests: shareOf(withheldRequests, allRequests) },
        source: 'Exchange receipts: succeeded, non-synthetic requests that a provider answered.',
        note: published.length
            ? 'Only cells with at least k requests are published. Every developer app is the single category apps.'
            : 'No model and category reached k requests this week, so nothing is published.',
    };
}

function createShare({ db, clock = { now: () => Date.now() }, k = K_DEFAULT, log = console } = {}) {
    const minimum = Math.max(1, Number(k) || K_DEFAULT);
    const byCell = db.prepare(`SELECT r.requester_type, r.requester_id,
            COALESCE(r.body -> 'offer' ->> 'provider', '') AS provider,
            COALESCE(r.body -> 'offer' ->> 'model', '') AS model,
            COUNT(*)::bigint AS requests,
            COALESCE(SUM(NULLIF(r.body -> 'usage' ->> 'tokens_in', '')::bigint), 0) AS tokens_in,
            COALESCE(SUM(NULLIF(r.body -> 'usage' ->> 'tokens_out', '')::bigint), 0) AS tokens_out
        FROM ai_receipts r
        JOIN runs u ON u.id = r.run_id
        WHERE r.created_at >= ?::timestamptz AND r.created_at < ?::timestamptz
            AND r.requester_type IN ('service', 'app')
            AND u.status = 'succeeded' AND u.synthetic = 0 AND u.provider_key IS NOT NULL
            AND COALESCE(u.options::jsonb ->> 'history', 'true') <> 'false'
            AND NULLIF(r.body -> 'offer' ->> 'provider', '') IS NOT NULL
            AND NULLIF(r.body -> 'offer' ->> 'model', '') IS NOT NULL
        GROUP BY 1, 2, 3, 4`);
    const insert = db.prepare(`INSERT INTO exchange_traffic_share
        (week_start, week_end, k, payload, cells, published_cells, withheld_cells, computed_at)
        VALUES (?::date, ?::date, ?, ?::jsonb, ?, ?, ?, now())
        ON CONFLICT (week_start) DO UPDATE SET
            k = EXCLUDED.k, payload = EXCLUDED.payload, cells = EXCLUDED.cells,
            published_cells = EXCLUDED.published_cells, withheld_cells = EXCLUDED.withheld_cells,
            recomputed_at = now()`);
    const stored = db.prepare('SELECT week_start, payload, computed_at, recomputed_at FROM exchange_traffic_share WHERE week_start = ?::date');
    const latest = db.prepare('SELECT week_start, payload, computed_at, recomputed_at FROM exchange_traffic_share ORDER BY week_start DESC LIMIT 1');

    const decode = (row) => ({
        ...(row.payload && typeof row.payload === 'object' ? row.payload : JSON.parse(row.payload || '{}')),
        week_start: dayString(row.week_start),
        computed_at: row.computed_at instanceof Date ? row.computed_at.toISOString() : String(row.computed_at || ''),
        recomputed_at: row.recomputed_at ? (row.recomputed_at instanceof Date ? row.recomputed_at.toISOString() : String(row.recomputed_at)) : null,
        stored: true,
    });

    async function compute(weekStart) {
        const start = isoDay(weekStart);
        const end = isoDay(weekStart + WEEK_MS);
        const rows = await byCell.all(`${start}T00:00:00.000Z`, `${end}T00:00:00.000Z`);
        return aggregateWeek({ rows, weekStart, k: minimum, generatedAt: new Date(clock.now()).toISOString() });
    }

    async function store(payload) {
        const withheld = payload.withheld ? payload.withheld.cells : 0;
        const published = payload.offers.length;
        const allCells = published + withheld;
        await insert.run(payload.week_start, payload.week_end, payload.k, JSON.stringify(payload), allCells, published, withheld);
    }

    async function storedWeek(weekStart) {
        const row = await stored.get(isoDay(weekStart));
        return row ? decode(row) : null;
    }

    /**
     * The public answer. With no week: the last completed week (computed and stored on first read, so the
     * publication exists without a timer). With a week: that week, while its receipts are still kept.
     */
    async function read({ week = null } = {}) {
        const now = clock.now();
        const current = mondayOf(now);
        if (week) {
            const start = parseWeek(week);
            if (start >= current) throw new ShareError(422, 'traffic_share.week_future', 'that week has not finished yet');
            const known = await storedWeek(start);
            if (known) return known;
            if (now - start > RETENTION_DAYS * DAY_MS) throw new ShareError(404, 'traffic_share.expired', 'the receipts for that week are no longer kept; only the weeks already stored are available');
            const payload = await compute(start);
            await store(payload);
            return { ...payload, computed_at: new Date(clock.now()).toISOString(), recomputed_at: null, stored: true };
        }
        const target = lastCompleteWeek(now);
        const row = await latest.get();
        if (row && dayString(row.week_start) === isoDay(target)) return decode(row);
        const payload = await compute(target);
        await store(payload);
        return { ...payload, computed_at: new Date(clock.now()).toISOString(), recomputed_at: null, stored: true };
    }

    /** The hourly housekeeping pass: publish the last completed week even when nobody has read it. */
    async function ensure() {
        const out = await read();
        return { week_start: out.week_start, stored: Boolean(out.stored) };
    }

    return { read, ensure, compute, store, aggregateWeek };
}

module.exports = { createShare, aggregateWeek, categoryOf, mondayOf, lastCompleteWeek, parseWeek, ShareError, SCHEMA, K_DEFAULT, RETENTION_DAYS };
