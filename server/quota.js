'use strict';
/**
 * Quotas and usage.
 *
 * A quota limits requests, tokens and/or cost for one scope in one fixed window:
 *   scope_type  global (scope_id '*') | service (live) | actor (user:usr_…) | attribution (live:user:42)
 *   window      minute | hour | day (UTC-aligned)
 *   workflow_prefix (optional) narrows it to workflows whose key starts with the prefix
 *
 * reserve() runs BEFORE any provider call: in one transaction it checks every applicable quota and,
 * only if all pass, counts the request against each. A refusal throws AiError 429 quota.exceeded
 * with retry_after_seconds (the end of the tightest exceeded window), so the caller can back off.
 * account() adds the real tokens and cost afterwards (tokens/cost limits therefore bound the NEXT
 * request once a window's spend has reached them, the same way Live's daily USD cap worked).
 */
const { AiError, iso } = require('./util');
const usageSamples = require('./usage-samples');
const { subjectOf } = require('./free-allowance');

const WINDOWS = { minute: 60, hour: 3600, day: 86400 };

/**
 * T6 provider router, phase 0 (nothing reads these yet). Every finished provider attempt is rolled up
 * into provider_stats_daily and per-route placement_state in the SAME transaction as usage_daily, so
 * the rollup can never drift from the accounting and a failed rollup write rolls the accounting back.
 *
 * Latency p50/p95 come from a fixed-bucket histogram (LATENCY_BUCKETS_MS = the inclusive upper bound of
 * each bucket; the last array slot is the overflow), never from a scan of the requests table. The estimate
 * is the bucket's upper bound — the smallest bucket whose cumulative count reaches the quantile.
 */
const EWMA_ALPHA = 0.2;                                   // documented: 20 % of the new sample, 80 % of the history
const LATENCY_BUCKETS_MS = [50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600];

function latencyBucket(ms) {
    const i = LATENCY_BUCKETS_MS.findIndex((b) => ms <= b);
    return i === -1 ? LATENCY_BUCKETS_MS.length : i;      // -1 → the overflow bucket
}
function estimatePercentile(hist, q) {
    let total = 0;
    for (const n of hist) total += n;
    if (!total) return null;
    const target = Math.ceil(q * total);
    let cum = 0;
    for (let i = 0; i < hist.length; i++) {
        cum += hist[i];
        if (cum >= target) return i < LATENCY_BUCKETS_MS.length ? LATENCY_BUCKETS_MS[i] : LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1];
    }
    return LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1];
}

function createQuotas(db, { clock = { now: () => Date.now() }, registry, freeAllowance = null, tiers = null } = {}) {
    const nowSec = () => Math.floor(clock.now() / 1000);
    const windowStart = (w, t = nowSec()) => Math.floor(t / WINDOWS[w]) * WINDOWS[w];

    function scopesFor(ctx) {
        const s = [['global', '*']];
        if (ctx.requesterType === 'service') s.push(['service', ctx.requesterId]);
        else s.push(['service', `${ctx.requesterType}:${ctx.requesterId}`]);
        if (ctx.actorKey) s.push(['actor', ctx.actorKey]);
        if (ctx.attributionKey) s.push(['attribution', ctx.attributionKey]);
        return s;
    }

    /**
     * Quotas that apply to this request, each with the counter id it counts under. A quota whose
     * scope_id is '*' on a non-global scope applies to EACH principal of that type separately
     * (e.g. service '*' = every service gets its own window).
     */
    async function applicable(ctx) {
        const scopes = scopesFor(ctx);
        const rows = await db.prepare("SELECT * FROM quotas WHERE status = 'active'").all();
        const out = [];
        for (const q of rows) {
            if (q.workflow_prefix && !String(ctx.workflowKey || '').startsWith(q.workflow_prefix)) continue;
            const hit = scopes.find(([t, id]) => q.scope_type === t && (q.scope_id === id || (q.scope_id === '*' && t !== 'global')));
            if (hit) out.push({ q, cid: q.scope_id === '*' && q.scope_type !== 'global' ? hit[1] : q.scope_id });
        }
        return out;
    }

    const getCounter = db.prepare('SELECT * FROM usage_counters WHERE scope_type = ? AND scope_id = ? AND "window" = ? AND window_start = ? AND workflow_prefix = ?');
    const bump = db.prepare(`INSERT INTO usage_counters (scope_type, scope_id, "window", window_start, workflow_prefix, requests, tokens, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_type, scope_id, "window", window_start, workflow_prefix)
        DO UPDATE SET requests = usage_counters.requests + excluded.requests, tokens = usage_counters.tokens + excluded.tokens, cost_usd = usage_counters.cost_usd + excluded.cost_usd`);

    const reserveTx = async (ctx) => await db.tx(async () => {
        const qs = await applicable(ctx);
        const t = nowSec();
        let worst = null;
        for (const { q, cid } of qs) {
            const ws = windowStart(q.window, t);
            const c = await getCounter.get(q.scope_type, cid, q.window, ws, q.workflow_prefix || '') || { requests: 0, tokens: 0, cost_usd: 0 };
            let reason = null;
            if (q.max_requests != null && c.requests + 1 > q.max_requests) reason = `${q.max_requests} requests per ${q.window}`;
            else if (q.max_tokens != null && c.tokens >= q.max_tokens) reason = `${q.max_tokens} tokens per ${q.window}`;
            else if (q.max_cost_usd != null && c.cost_usd >= q.max_cost_usd) reason = `$${q.max_cost_usd} per ${q.window}`;
            if (reason) {
                const retryAfter = ws + WINDOWS[q.window] - t;
                if (!worst || retryAfter > worst.retryAfter) worst = { q, cid, reason, retryAfter };
            }
        }
        if (worst) return { ok: false, ...worst };
        // Count this request in EVERY scope x window (not only where a quota exists today), so a
        // quota added later sees the spend that already happened in its window — Live's daily cap
        // read today's total the same way. Workflow-prefix quotas keep their own counters.
        const keys = new Map();
        for (const [st, sid] of scopesFor(ctx)) {
            for (const w of Object.keys(WINDOWS)) keys.set(`${st}|${sid}|${w}|`, { scope_type: st, scope_id: sid, window: w, workflow_prefix: '', ws: windowStart(w, t) });
        }
        for (const { q, cid } of qs) {
            if (q.workflow_prefix) keys.set(`${q.scope_type}|${cid}|${q.window}|${q.workflow_prefix}`, { scope_type: q.scope_type, scope_id: cid, window: q.window, workflow_prefix: q.workflow_prefix, ws: windowStart(q.window, t) });
        }
        const counted = [...keys.values()];
        for (const k of counted) await bump.run(k.scope_type, k.scope_id, k.window, k.ws, k.workflow_prefix, 1, 0, 0);
        return { ok: true, quotas: counted };
    });

    /** Check + count one request. Throws 429 quota.exceeded before any provider is touched. */
    async function reserve(ctx) {
        const r = await reserveTx(ctx);
        if (!r.ok) {
            throw new AiError(429, 'quota.exceeded', `quota exceeded for ${r.q.scope_type} ${r.cid}: ${r.reason}`, {
                retry_after_seconds: Math.max(1, r.retryAfter), quota: { id: r.q.id, scope_type: r.q.scope_type, scope_id: r.cid, window: r.q.window },
            });
        }
        return r.quotas;
    }

    const insDaily = db.prepare(`INSERT INTO usage_daily (day, requester, attribution, workflow_key, provider_key, model_key, requests, tokens_in, tokens_out, tokens_cached, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(day, requester, attribution, workflow_key, provider_key, model_key) DO UPDATE SET requests = usage_daily.requests + 1,
          tokens_in = usage_daily.tokens_in + excluded.tokens_in, tokens_out = usage_daily.tokens_out + excluded.tokens_out, tokens_cached = usage_daily.tokens_cached + excluded.tokens_cached, cost_usd = usage_daily.cost_usd + excluded.cost_usd`);

    // ── Provider rollup + placement state (T6 phase 0; nothing reads them yet) ──
    const ensStats = db.prepare('INSERT INTO provider_stats_daily (day, provider, model) VALUES (?, ?, ?) ON CONFLICT (day, provider, model) DO NOTHING');
    const getStats = db.prepare('SELECT latency_hist FROM provider_stats_daily WHERE day = ? AND provider = ? AND model = ? FOR UPDATE');
    const bumpStats = db.prepare(`UPDATE provider_stats_daily SET requests = requests + 1, ok = ok + ?, errors = errors + ?, cost_usd_total = cost_usd_total + ?,
        tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, latency_hist = ?::bigint[], latency_p50_ms = ?, latency_p95_ms = ?
        WHERE day = ? AND provider = ? AND model = ?`);
    const putPlacement = db.prepare(`INSERT INTO placement_state (route_key, current_provider, current_model, ewma_latency_ms, ewma_error_rate, quality, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT (route_key) DO UPDATE SET current_provider = excluded.current_provider, current_model = excluded.current_model,
          ewma_latency_ms = excluded.ewma_latency_ms * ? + placement_state.ewma_latency_ms * ?, ewma_error_rate = excluded.ewma_error_rate * ? + placement_state.ewma_error_rate * ?, updated_at = excluded.updated_at`);

    /**
     * One provider_stats_daily upsert and one placement_state EWMA update per finished attempt
     * (ok | error | timeout | cancelled; skips never touched a provider). The first sample for a key
     * initialises its EWMA; later samples move it by EWMA_ALPHA. quality stays null (no signal yet).
     */
    async function recordStats(day, attempts) {
        for (const a of attempts || []) {
            if (!a.provider_key || a.status === 'skipped') continue;
            const model = a.model_key || '';
            const ok = a.status === 'ok' ? 1 : 0;
            const errors = ok ? 0 : 1;
            const latency = Number.isFinite(a.latency_ms) ? Math.max(0, Math.round(a.latency_ms)) : null;
            await ensStats.run(day, a.provider_key, model);
            const cur = await getStats.get(day, a.provider_key, model);
            const hist = Array.from({ length: LATENCY_BUCKETS_MS.length + 1 }, (_, i) => Number((cur && cur.latency_hist && cur.latency_hist[i]) || 0));
            if (latency !== null) hist[latencyBucket(latency)] += 1;
            await bumpStats.run(ok, errors, Number(a.cost_usd) || 0, Number(a.tokens_in) || 0, Number(a.tokens_out) || 0, hist,
                estimatePercentile(hist, 0.5), estimatePercentile(hist, 0.95), day, a.provider_key, model);
            if (a.route_key && latency !== null) {
                const t = iso(clock.now());
                await putPlacement.run(a.route_key, a.provider_key, a.model_key || null, latency, errors, t, EWMA_ALPHA, 1 - EWMA_ALPHA, EWMA_ALPHA, 1 - EWMA_ALPHA);
            }
        }
    }

    /**
     * Add real usage to the reserved windows, the daily usage table and — in the same transaction — the
     * provider rollup, per-route placement state and the run's Billing readings. `attempts` is the run's
     * finished attempts (the same entries logged to `requests`); `writeUsage` is false when a run spent
     * nothing (stats are still kept). `runId`/`traceId` name the run a reading is written for
     * (server/usage-samples.js): with a runId, one platform.usage-sample@1 per attempt per token kind
     * (in excluding cached, cached, out) commits with its usage, under the attempt's provider/model metric.
     * Each attempt's tokens claim the subject's provider free allowance (server/free-allowance.js, §2.1.8) per
     * kind: the free share is that reading's free_allowance_used and its list price is left out of the
     * reading's cost_estimate. Pricing only: the counters above are unchanged. `hold` is the run's tier hold
     * (server/govern.js): once the accounting committed, it is settled with the run's tokens and its priced
     * cost (the free share left out), so a fully free run spends no ai-usd.
     */
    async function account(ctx, reserved, { provider, model, tokensIn = 0, tokensOut = 0, tokensCached = 0, cost = 0, attempts = null, writeUsage = true, runId = null, traceId = null, hold = null }) {
        const tokens = tokensIn + tokensOut;
        const day = iso(clock.now()).slice(0, 10);
        let freeUsd = 0;
        await db.tx(async () => {
            for (const r of reserved || []) await bump.run(r.scope_type, r.scope_id, r.window, r.ws, r.workflow_prefix, 0, tokens, cost);
            if (writeUsage) await insDaily.run(day, `${ctx.requesterType}:${ctx.requesterId}`, ctx.attributionKey || '', ctx.workflowKey, provider || '', model || '', tokensIn, tokensOut, tokensCached, cost);
            // One reading per finished attempt per token kind, for Billing (server/usage-samples.js).
            if (writeUsage && runId) {
                const at = clock.now();
                const readings = [];
                const list = attempts || [];
                for (let attempt = 0; attempt < list.length; attempt++) {
                    const a = list[attempt];
                    if (!a || !a.provider_key || a.status === 'skipped') continue;   // a skipped attempt never touched a provider
                    const attemptModel = a.model_key || null;
                    const qty = { in: Math.max(0, (Number(a.tokens_in) || 0) - (Number(a.tokens_cached) || 0)), cached: Math.max(0, Number(a.tokens_cached) || 0), out: Math.max(0, Number(a.tokens_out) || 0) };
                    const free = freeAllowance ? await freeAllowance.claim(subjectOf(ctx), a.provider_key, attemptModel, qty, at) : null;
                    const byKind = (free && free.byKind) || {};
                    if (free) freeUsd += Number(free.usd) || 0;
                    for (const kind of usageSamples.KINDS) {
                        const f = byKind[kind] || { tokens: 0, usd: 0, cost: 0 };
                        readings.push({ attempt, kind, provider: a.provider_key, model: attemptModel, quantity: qty[kind],
                            cost: Math.max(0, (Number(f.cost) || 0) - (Number(f.usd) || 0)), freeAllowanceUsed: Number(f.tokens) || 0 });
                    }
                }
                await usageSamples.record(db, { runId, workflowKey: ctx.workflowKey, requester: `${ctx.requesterType}:${ctx.requesterId}`, at, traceId, readings });
            }
            await recordStats(day, attempts);
        });
        if (tiers && hold) await tiers.settle(hold, { tokens: (Number(tokensIn) || 0) + (Number(tokensOut) || 0), usd: Math.max(0, (Number(cost) || 0) - freeUsd) });
    }

    /**
     * Per provider/model totals over the last `days` UTC days, from provider_stats_daily only — never the
     * requests table. latency_p50_ms/latency_p95_ms are the worst daily estimate in the window (a day's
     * histogram is not summable in SQL without a custom aggregate); the router and the price/latency page
     * read this. No route yet (T6 phase 0).
     */
    async function statsFor({ days = 7 } = {}) {
        const from = new Date(clock.now() - Math.max(1, days) * 86400000).toISOString().slice(0, 10);
        return await db.prepare(`SELECT provider, model, SUM(requests)::bigint AS requests, SUM(ok)::bigint AS ok, SUM(errors)::bigint AS errors,
            SUM(cost_usd_total)::double precision AS cost_usd_total, SUM(tokens_in)::bigint AS tokens_in, SUM(tokens_out)::bigint AS tokens_out,
            MAX(latency_p50_ms) AS latency_p50_ms, MAX(latency_p95_ms) AS latency_p95_ms
            FROM provider_stats_daily WHERE day >= ? GROUP BY provider, model ORDER BY provider, model`).all(from);
    }

    // ── Admin ──
    async function list() { return await db.prepare('SELECT * FROM quotas ORDER BY scope_type, scope_id, "window"').all(); }
    async function upsert(q, { actor = 'system', origin = 'admin', trace = null } = {}) {
        if (!['global', 'service', 'actor', 'attribution'].includes(q.scope_type)) throw new AiError(422, 'ai.invalid', 'scope_type must be global, service, actor or attribution');
        if (!WINDOWS[q.window]) throw new AiError(422, 'ai.invalid', 'window must be minute, hour or day');
        const scopeId = q.scope_type === 'global' ? '*' : String(q.scope_id || '');   // '*' on other scopes = each one separately
        if (!scopeId || scopeId.length > 200) throw new AiError(422, 'ai.invalid', 'scope_id required');
        const num = (v) => (v == null || v === '' ? null : Number(v));
        for (const k of ['max_requests', 'max_tokens', 'max_cost_usd']) if (q[k] != null && !(Number(q[k]) >= 0)) throw new AiError(422, 'ai.invalid', `${k} must be >= 0`);
        const status = q.status || 'active';
        if (!['active', 'disabled'].includes(status)) throw new AiError(422, 'ai.invalid', 'status must be active or disabled');
        const t = iso(clock.now());
        const prefix = q.workflow_prefix || null;
        const prev = await db.prepare("SELECT * FROM quotas WHERE scope_type = ? AND scope_id = ? AND \"window\" = ? AND COALESCE(workflow_prefix, '') = ?").get(q.scope_type, scopeId, q.window, prefix || '');
        if (prev) {
            await db.prepare('UPDATE quotas SET max_requests = ?, max_tokens = ?, max_cost_usd = ?, status = ?, updated_at = ? WHERE id = ?')
                .run(num(q.max_requests), num(q.max_tokens), num(q.max_cost_usd), status, t, prev.id);
        } else {
            await db.prepare('INSERT INTO quotas (scope_type, scope_id, "window", max_requests, max_tokens, max_cost_usd, workflow_prefix, status, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .run(q.scope_type, scopeId, q.window, num(q.max_requests), num(q.max_tokens), num(q.max_cost_usd), prefix, status, origin, t, t);
        }
        const row = await db.prepare("SELECT * FROM quotas WHERE scope_type = ? AND scope_id = ? AND \"window\" = ? AND COALESCE(workflow_prefix, '') = ?").get(q.scope_type, scopeId, q.window, prefix || '');
        if (registry) await registry.audit(actor, prev ? 'quota.update' : 'quota.create', 'quota', row.id, { trace, metadata: { scope_type: row.scope_type, scope_id: row.scope_id, window: row.window, max_requests: row.max_requests, max_tokens: row.max_tokens, max_cost_usd: row.max_cost_usd, status: row.status, origin } });
        return row;
    }

    async function usage({ from, to, requester } = {}) {
        const where = [];
        const args = [];
        if (from) { where.push('day >= ?'); args.push(from); }
        if (to) { where.push('day <= ?'); args.push(to); }
        if (requester) { where.push('requester = ?'); args.push(requester); }
        return await db.prepare(`SELECT * FROM usage_daily ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY day DESC, cost_usd DESC LIMIT 1000`).all(...args);
    }

    async function counters(ctxLike) {
        const qs = ctxLike ? await applicable(ctxLike) : (await list()).filter(q => q.status === 'active' && (q.scope_type === 'global' || q.scope_id !== '*')).map(q => ({ q, cid: q.scope_id }));
        const t = nowSec();
        return (await Promise.all(qs.map(async ({ q, cid }) => {
            const ws = windowStart(q.window, t);
            const c = await getCounter.get(q.scope_type, cid, q.window, ws, q.workflow_prefix || '') || { requests: 0, tokens: 0, cost_usd: 0 };
            return { quota: q, scope_id: cid, window_start: iso(ws * 1000), resets_in_seconds: ws + WINDOWS[q.window] - t, used: { requests: c.requests, tokens: c.tokens, cost_usd: c.cost_usd } };
        })));
    }

    /**
     * A cost budget that gates one kind of paid call rather than whole runs (media.analyze's paid overview, WS-O task 5):
     * the active quotas whose workflow_prefix is `prefix` (a name no workflow key starts with, so reserve() never
     * applies them) and whose max_cost_usd is above 0. The tightest cap counts, against today's (UTC) spend of the
     * workflows starting with `spendPrefix`. null when there is none: no budget, no paid call.
     */
    async function paidBudget(prefix, spendPrefix) {
        const rows = await db.prepare("SELECT max_cost_usd FROM quotas WHERE status = 'active' AND workflow_prefix = ? AND max_cost_usd > 0").all(prefix);
        if (!rows.length) return null;
        const day = new Date(clock.now()).toISOString().slice(0, 10);
        const spent = (await db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage_daily WHERE day = ? AND substr(workflow_key, 1, ?) = ?").get(day, spendPrefix.length, spendPrefix)).c;
        return { max_cost_usd: Math.min(...rows.map((r) => r.max_cost_usd)), spent, window: 'day' };
    }

    return { reserve, account, statsFor, list, upsert, usage, counters, paidBudget, freeAllowance, WINDOWS };
}

module.exports = { createQuotas, WINDOWS };
