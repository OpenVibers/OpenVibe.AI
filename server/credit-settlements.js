'use strict';
/**
 * Durable Billing Credit settles (AI Exchange F, P7). A settle the service could not deliver — Billing down,
 * slow, or refusing with a 5xx — is written to `credit_settle_queue` (migrations/0025) with its full body and
 * the same idempotency key, and a background loop retries it with exponential backoff until Billing answers 2xx.
 * A 409 or 422 is a decision, not an outage: the row is marked `review` and never retried. The loop is off in
 * test mode (NODE_ENV=test, the way the memory jobs are) and off while a provider is in a drill, so a drill
 * never writes money; a test drives runOnce() directly.
 *
 * The queue never stores a prompt, an answer or a secret: a settle body is token counts, prices and ids.
 */
const QUIET_MS = 5000;
const MAX_MS = 5 * 60 * 1000;
const BATCH = 20;

function createCreditSettlements({ db, clock = { now: () => Date.now() }, log = console, registry = null, send, retryMs = QUIET_MS, maxRetryMs = MAX_MS, batch = BATCH }) {
    const iso = (ms) => new Date(ms).toISOString();
    const base = Math.max(1000, Number(retryMs) || QUIET_MS);
    const ceiling = Math.max(base, Number(maxRetryMs) || MAX_MS);
    let timer = null;
    let running = false;

    const parse = (v, fallback) => {
        if (v == null) return fallback;
        if (typeof v === 'object') return v;
        try { return JSON.parse(v); } catch { return fallback; }
    };

    /** Still a provider drill? Money must not move under one (the same guard the memory jobs use). */
    async function drillActive() {
        if (!registry) return false;
        const providers = await registry.listProviders();
        return providers.some((p) => p && p.metadata && (p.metadata.fail || p.metadata.drill));
    }

    /** Keep a failed settle. The id is its idempotency key, so the later delivery pays it exactly once. */
    async function enqueue({ holdId, requestId = null, body, error = null }) {
        if (!holdId || !body || !body.idempotency_key) return null;
        const now = clock.now();
        // A 409 (the hold is already settled/terminal) or a 422 (Billing refused the body) is a decision, not an
        // outage: keep the row for a person to look at, never retry it.
        const decided = error && (error.status === 409 || error.status === 422);
        await db.prepare(`INSERT INTO credit_settle_queue
            (id, hold_id, request_id, settle_body, attempts, status, tries, next_at, last_error, created_at, updated_at)
            VALUES (?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?::timestamptz, ?, ?::timestamptz, ?::timestamptz)
            ON CONFLICT (id) DO NOTHING`).run(
            body.idempotency_key, holdId, requestId, JSON.stringify(body), JSON.stringify(body.attempts || []),
            decided ? 'review' : 'queued', decided ? 1 : 0, iso(now + base),
            error ? String(error.message || error.code || 'settle failed').slice(0, 500) : null, iso(now), iso(now));
        return body.idempotency_key;
    }

    async function due(limit, force) {
        const now = iso(clock.now());
        return force
            ? db.prepare(`SELECT id, hold_id, request_id, settle_body, attempts, tries FROM credit_settle_queue
                WHERE status = 'queued' ORDER BY next_at, id LIMIT ?`).all(Math.max(1, Math.min(100, limit)))
            : db.prepare(`SELECT id, hold_id, request_id, settle_body, attempts, tries FROM credit_settle_queue
                WHERE status = 'queued' AND next_at <= ?::timestamptz ORDER BY next_at, id LIMIT ?`).all(now, Math.max(1, Math.min(100, limit)));
    }

    async function sent(id, now) {
        await db.prepare("UPDATE credit_settle_queue SET status = 'sent', last_error = NULL, updated_at = ?::timestamptz WHERE id = ?").run(iso(now), id);
    }

    async function review(id, err, now) {
        await db.prepare("UPDATE credit_settle_queue SET status = 'review', tries = tries + 1, last_error = ?, updated_at = ?::timestamptz WHERE id = ?")
            .run(String((err && (err.message || err.code)) || 'refused').slice(0, 500), iso(now), id);
    }

    async function reschedule(row, err, now) {
        const tries = Number(row.tries || 0) + 1;
        const delay = Math.min(ceiling, base * (2 ** Math.min(tries, 10)));
        await db.prepare(`UPDATE credit_settle_queue SET status = 'queued', tries = ?, next_at = ?::timestamptz, last_error = ?, updated_at = ?::timestamptz WHERE id = ?`)
            .run(tries, iso(now + delay), String((err && (err.message || err.code)) || 'settle failed').slice(0, 500), iso(now), row.id);
        return delay;
    }

    /**
     * One pass over the due rows. Never throws: each row's outcome is counted. A successful send is final; a
     * 409/422 is `review`; anything else is queued again with backoff.
     */
    async function runOnce({ force = false } = {}) {
        if (running) return { skipped: 'running' };
        running = true;
        const out = { sent: 0, review: 0, retry: 0, error: null };
        try {
            if (await drillActive()) return { skipped: 'drill' };
            const rows = await due(batch, force);
            for (const row of rows) {
                const now = clock.now();
                try {
                    await send({ ...row, body: parse(row.settle_body, {}) });
                    await sent(row.id, now);
                    out.sent++;
                } catch (err) {
                    const status = err && err.status;
                    if (status === 409 || status === 422) {
                        await review(row.id, err, now);
                        out.review++;
                    } else {
                        await reschedule(row, err, now);
                        out.retry++;
                    }
                }
            }
        } catch (err) {
            out.error = (err && err.code) || 'error';
            log.warn(`[credits] settle queue stopped early: ${out.error}`);
        } finally { running = false; }
        return out;
    }

    function start() {
        if (timer) return timer;
        timer = setInterval(() => { runOnce().catch(() => {}); }, Math.max(1000, Math.min(60000, base)));
        timer.unref?.();
        return timer;
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    /** The queued rows, for the operator and the tests (no body: it carries ids, not text). */
    async function pending() {
        return db.prepare('SELECT id, hold_id, request_id, status, tries, next_at, last_error FROM credit_settle_queue ORDER BY created_at, id').all();
    }

    return { enqueue, runOnce, start, stop, pending };
}

module.exports = { createCreditSettlements };
