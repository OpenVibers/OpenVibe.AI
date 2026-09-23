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

const WINDOWS = { minute: 60, hour: 3600, day: 86400 };

function createQuotas(db, { clock = { now: () => Date.now() }, registry } = {}) {
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
    function applicable(ctx) {
        const scopes = scopesFor(ctx);
        const rows = db.prepare("SELECT * FROM quotas WHERE status = 'active'").all();
        const out = [];
        for (const q of rows) {
            if (q.workflow_prefix && !String(ctx.workflowKey || '').startsWith(q.workflow_prefix)) continue;
            const hit = scopes.find(([t, id]) => q.scope_type === t && (q.scope_id === id || (q.scope_id === '*' && t !== 'global')));
            if (hit) out.push({ q, cid: q.scope_id === '*' && q.scope_type !== 'global' ? hit[1] : q.scope_id });
        }
        return out;
    }

    const getCounter = db.prepare('SELECT * FROM usage_counters WHERE scope_type = ? AND scope_id = ? AND window = ? AND window_start = ? AND workflow_prefix = ?');
    const bump = db.prepare(`INSERT INTO usage_counters (scope_type, scope_id, window, window_start, workflow_prefix, requests, tokens, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_type, scope_id, window, window_start, workflow_prefix)
        DO UPDATE SET requests = requests + excluded.requests, tokens = tokens + excluded.tokens, cost_usd = cost_usd + excluded.cost_usd`);

    const reserveTx = db.transaction((ctx) => {
        const qs = applicable(ctx);
        const t = nowSec();
        let worst = null;
        for (const { q, cid } of qs) {
            const ws = windowStart(q.window, t);
            const c = getCounter.get(q.scope_type, cid, q.window, ws, q.workflow_prefix || '') || { requests: 0, tokens: 0, cost_usd: 0 };
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
        for (const k of counted) bump.run(k.scope_type, k.scope_id, k.window, k.ws, k.workflow_prefix, 1, 0, 0);
        return { ok: true, quotas: counted };
    });

    /** Check + count one request. Throws 429 quota.exceeded before any provider is touched. */
    function reserve(ctx) {
        const r = reserveTx(ctx);
        if (!r.ok) {
            throw new AiError(429, 'quota.exceeded', `quota exceeded for ${r.q.scope_type} ${r.cid}: ${r.reason}`, {
                retry_after_seconds: Math.max(1, r.retryAfter), quota: { id: r.q.id, scope_type: r.q.scope_type, scope_id: r.cid, window: r.q.window },
            });
        }
        return r.quotas;
    }

    const insDaily = db.prepare(`INSERT INTO usage_daily (day, requester, attribution, workflow_key, provider_key, model_key, requests, tokens_in, tokens_out, tokens_cached, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(day, requester, attribution, workflow_key, provider_key, model_key) DO UPDATE SET requests = requests + 1,
          tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out, tokens_cached = tokens_cached + excluded.tokens_cached, cost_usd = cost_usd + excluded.cost_usd`);

    /** Add real usage to the reserved windows and the daily usage table. */
    function account(ctx, reserved, { provider, model, tokensIn = 0, tokensOut = 0, tokensCached = 0, cost = 0 }) {
        const tokens = tokensIn + tokensOut;
        db.transaction(() => {
            for (const r of reserved || []) bump.run(r.scope_type, r.scope_id, r.window, r.ws, r.workflow_prefix, 0, tokens, cost);
            insDaily.run(iso(clock.now()).slice(0, 10), `${ctx.requesterType}:${ctx.requesterId}`, ctx.attributionKey || '', ctx.workflowKey, provider || '', model || '', tokensIn, tokensOut, tokensCached, cost);
        })();
    }

    // ── Admin ──
    function list() { return db.prepare('SELECT * FROM quotas ORDER BY scope_type, scope_id, window').all(); }
    function upsert(q, { actor = 'system', origin = 'admin', trace = null } = {}) {
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
        const prev = db.prepare("SELECT * FROM quotas WHERE scope_type = ? AND scope_id = ? AND window = ? AND COALESCE(workflow_prefix, '') = ?").get(q.scope_type, scopeId, q.window, prefix || '');
        if (prev) {
            db.prepare('UPDATE quotas SET max_requests = ?, max_tokens = ?, max_cost_usd = ?, status = ?, updated_at = ? WHERE id = ?')
                .run(num(q.max_requests), num(q.max_tokens), num(q.max_cost_usd), status, t, prev.id);
        } else {
            db.prepare('INSERT INTO quotas (scope_type, scope_id, window, max_requests, max_tokens, max_cost_usd, workflow_prefix, status, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .run(q.scope_type, scopeId, q.window, num(q.max_requests), num(q.max_tokens), num(q.max_cost_usd), prefix, status, origin, t, t);
        }
        const row = db.prepare("SELECT * FROM quotas WHERE scope_type = ? AND scope_id = ? AND window = ? AND COALESCE(workflow_prefix, '') = ?").get(q.scope_type, scopeId, q.window, prefix || '');
        if (registry) registry.audit(actor, prev ? 'quota.update' : 'quota.create', 'quota', row.id, { trace, metadata: { scope_type: row.scope_type, scope_id: row.scope_id, window: row.window, max_requests: row.max_requests, max_tokens: row.max_tokens, max_cost_usd: row.max_cost_usd, status: row.status, origin } });
        return row;
    }

    function usage({ from, to, requester } = {}) {
        const where = [];
        const args = [];
        if (from) { where.push('day >= ?'); args.push(from); }
        if (to) { where.push('day <= ?'); args.push(to); }
        if (requester) { where.push('requester = ?'); args.push(requester); }
        return db.prepare(`SELECT * FROM usage_daily ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY day DESC, cost_usd DESC LIMIT 1000`).all(...args);
    }

    function counters(ctxLike) {
        const qs = ctxLike ? applicable(ctxLike) : list().filter(q => q.status === 'active' && (q.scope_type === 'global' || q.scope_id !== '*')).map(q => ({ q, cid: q.scope_id }));
        const t = nowSec();
        return qs.map(({ q, cid }) => {
            const ws = windowStart(q.window, t);
            const c = getCounter.get(q.scope_type, cid, q.window, ws, q.workflow_prefix || '') || { requests: 0, tokens: 0, cost_usd: 0 };
            return { quota: q, scope_id: cid, window_start: iso(ws * 1000), resets_in_seconds: ws + WINDOWS[q.window] - t, used: { requests: c.requests, tokens: c.tokens, cost_usd: c.cost_usd } };
        });
    }

    return { reserve, account, list, upsert, usage, counters, WINDOWS };
}

module.exports = { createQuotas, WINDOWS };
