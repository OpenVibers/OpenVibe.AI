'use strict';
/**
 * The price book's own state: when it last ran, and which instance is running it now.
 *
 * The book is due-based, not timer-based. A timer that lives in the process is reset by every deploy, and AI is
 * deployed several times a day, so the week would never come round; the last run is therefore a row in the
 * database and the due check reads it.
 *
 * The row also carries the claim. AI runs several workers and only one of them may read the providers' listings
 * at a time, so a worker claims the row before it starts and releases it when it ends. The claim expires on its
 * own, so a worker that dies mid-run does not block the next one for ever.
 */
const STATE_ID = 'pricebook';

function createPriceState({ db, clock = { now: () => Date.now() } }) {
    const iso = () => new Date(clock.now()).toISOString();

    /** When the last run finished, or null when the book has never run. */
    async function lastRunAt() {
        const row = await db.prepare('SELECT last_run_at FROM price_book_state WHERE id = ?').get(STATE_ID).catch(() => null);
        if (!row || !row.last_run_at) return null;
        const at = new Date(row.last_run_at).getTime();
        return Number.isFinite(at) ? at : null;
    }

    /** The row as it is, for the operator page (the times as ISO strings, not Date objects). */
    async function read() {
        const row = await db.prepare('SELECT * FROM price_book_state WHERE id = ?').get(STATE_ID).catch(() => null);
        if (!row) return null;
        const isoOrNull = (v) => (v ? new Date(v).toISOString() : null);
        return { ...row, last_run_at: isoOrNull(row.last_run_at), claimed_until: isoOrNull(row.claimed_until) };
    }

    /**
     * Claim the run: one instance at a time. The claim is taken by the database, so two workers that tick at the
     * same moment cannot both hold it.
     * → true when this instance holds the run.
     */
    async function claim({ ttlMs, who }) {
        const until = new Date(clock.now() + Math.max(1000, Number(ttlMs) || 0)).toISOString();
        const at = iso();
        const row = await db.prepare(`INSERT INTO price_book_state (id, last_run_at, claimed_until, claimed_by, updated_at)
            VALUES (?, NULL, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET claimed_until = EXCLUDED.claimed_until, claimed_by = EXCLUDED.claimed_by, updated_at = EXCLUDED.updated_at
            WHERE price_book_state.claimed_until IS NULL OR price_book_state.claimed_until <= ?::timestamptz
            RETURNING claimed_by`)
            .get(STATE_ID, until, who, at, at).catch(() => null);
        return Boolean(row && row.claimed_by);
    }

    /** Give the claim back, so the next worker may run. */
    async function release({ who }) {
        await db.prepare('UPDATE price_book_state SET claimed_until = NULL, claimed_by = NULL, updated_at = ? WHERE id = ? AND claimed_by = ?')
            .run(iso(), STATE_ID, who).catch(() => null);
    }

    /** The run is over: the next one is due when the interval has passed. */
    async function markRun() {
        const at = iso();
        await db.prepare(`INSERT INTO price_book_state (id, last_run_at, claimed_until, claimed_by, updated_at)
            VALUES (?, ?, NULL, NULL, ?)
            ON CONFLICT (id) DO UPDATE SET last_run_at = EXCLUDED.last_run_at, updated_at = EXCLUDED.updated_at`)
            .run(STATE_ID, at, at).catch(() => null);
    }

    return { lastRunAt, read, claim, release, markRun, STATE_ID };
}

module.exports = { createPriceState, STATE_ID };
