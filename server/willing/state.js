'use strict';

/**
 * The due/claim state of the two measurement jobs (server/willing/).
 *
 * AI is deployed several times a day, so a weekly interval that lives in the process is reset every
 * time. The last finished run is a row in job_state and the due check reads it. A run is claimed
 * before it starts, so several workers never measure the same set at once; the claim expires on its
 * own if a worker dies.
 */

function createJobState({ db, id, clock = { now: () => Date.now() } }) {
    const iso = () => new Date(clock.now()).toISOString();

    async function lastRunAt() {
        const row = await db.prepare('SELECT last_run_at FROM job_state WHERE id = ?').get(id).catch(() => null);
        if (!row || !row.last_run_at) return null;
        const at = new Date(row.last_run_at).getTime();
        return Number.isFinite(at) ? at : null;
    }

    async function read() {
        const row = await db.prepare('SELECT * FROM job_state WHERE id = ?').get(id).catch(() => null);
        if (!row) return null;
        const isoOrNull = (v) => (v ? new Date(v).toISOString() : null);
        return { ...row, last_run_at: isoOrNull(row.last_run_at), claimed_until: isoOrNull(row.claimed_until) };
    }

    async function claim({ ttlMs, who }) {
        const until = new Date(clock.now() + Math.max(1000, Number(ttlMs) || 0)).toISOString();
        const at = iso();
        const row = await db.prepare(`INSERT INTO job_state (id, last_run_at, claimed_until, claimed_by, updated_at)
            VALUES (?, NULL, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET claimed_until = EXCLUDED.claimed_until, claimed_by = EXCLUDED.claimed_by, updated_at = EXCLUDED.updated_at
            WHERE job_state.claimed_until IS NULL OR job_state.claimed_until <= ?::timestamptz
            RETURNING claimed_by`)
            .get(id, until, who, at, at).catch(() => null);
        return Boolean(row && row.claimed_by);
    }

    async function release({ who }) {
        await db.prepare('UPDATE job_state SET claimed_until = NULL, claimed_by = NULL, updated_at = ? WHERE id = ? AND claimed_by = ?')
            .run(iso(), id, who).catch(() => null);
    }

    async function markRun() {
        const at = iso();
        await db.prepare(`INSERT INTO job_state (id, last_run_at, claimed_until, claimed_by, updated_at)
            VALUES (?, ?, NULL, NULL, ?)
            ON CONFLICT (id) DO UPDATE SET last_run_at = EXCLUDED.last_run_at, updated_at = EXCLUDED.updated_at`)
            .run(id, at, at).catch(() => null);
    }

    return { lastRunAt, read, claim, release, markRun, id };
}

module.exports = { createJobState };
