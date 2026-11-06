'use strict';
/**
 * The price change log: what a price was, what it became, the provider's own listing it was read from and the
 * day it was read.
 *
 * This is a log, not a second list of prices: the live price stays in the model row the router reads, and this
 * table says how it got there. A change over the threshold waits here as pending until the owner approves it on
 * the operator console; a smaller one is applied at once and lands here as applied.
 */
const { ids } = require('openvibe-contracts');

const FIELDS = ['in_per_mtok', 'cached_per_mtok', 'out_per_mtok'];

/** The field of a model row the log talks about, and the parser's name for it. */
const FIELD_NAMES = { in_per_mtok: 'in', cached_per_mtok: 'cached', out_per_mtok: 'out' };

function createPriceStore({ db, clock = { now: () => Date.now() } }) {
    const iso = () => new Date(clock.now()).toISOString();

    /** Write one change into the log. */
    async function record({ provider_key, model_key, field, old_price = null, new_price, change_pct = null, source, checked_at, status, note = null, actor = null }) {
        const id = 'pc_' + ids.ulid();
        await db.prepare(`INSERT INTO price_changes
            (id, provider_key, model_key, field, old_price, new_price, change_pct, source, checked_at, status, created_at, decided_at, decided_by, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, provider_key, model_key, field, old_price === null || old_price === undefined ? null : old_price,
                new_price, change_pct === null || change_pct === undefined ? null : change_pct,
                source, checked_at, status, iso(), null, actor, note);
        return id;
    }

    /** The changes of the log, newest first. */
    async function list({ status = null, provider = null, model = null, limit = 100 } = {}) {
        const where = [];
        const args = [];
        if (status) { where.push('status = ?'); args.push(status); }
        if (provider) { where.push('provider_key = ?'); args.push(provider); }
        if (model) { where.push('model_key = ?'); args.push(model); }
        const sql = 'SELECT * FROM price_changes' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC LIMIT ?';
        const rows = await db.prepare(sql).all(...args, limit);
        return rows || [];
    }

    /** One change by its id. */
    async function get(id) {
        return db.prepare('SELECT * FROM price_changes WHERE id = ?').get(id);
    }

    /** The changes that wait for the owner's approval. */
    async function pending(limit = 100) {
        return list({ status: 'pending', limit });
    }

    /** The changes the catalog and the Exchange changelog show: the ones that are live. */
    async function live({ limit = 100, provider = null } = {}) {
        const where = `status IN ('applied', 'approved')`;
        const args = [];
        if (provider) { args.push(provider); }
        const sql = `SELECT * FROM price_changes WHERE ${where}` + (provider ? ' AND provider_key = ?' : '') + ' ORDER BY created_at DESC LIMIT ?';
        const rows = await db.prepare(sql).all(...args, limit);
        return rows || [];
    }

    /**
     * Decide a pending change. Approving it hands the price to the job, which writes it into the model row;
     * rejecting it leaves the live price alone and the log keeps the story.
     */
    async function decide(id, { status, actor, note = null }) {
        const row = await get(id);
        if (!row) return null;
        if (row.status !== 'pending') return row;
        await db.prepare('UPDATE price_changes SET status = ?, decided_at = ?, decided_by = ?, note = COALESCE(?, note) WHERE id = ?')
            .run(status, iso(), actor, note, id);
        return get(id);
    }

    /** Mark the pending changes of one model and field as superseded: a newer reading replaced them. */
    async function supersede({ provider_key, model_key, field, except = null }) {
        await db.prepare(`UPDATE price_changes SET status = 'superseded', decided_at = ? WHERE status = 'pending' AND provider_key = ? AND model_key = ? AND field = ? AND id <> ?`)
            .run(iso(), provider_key, model_key, field, except || '');
    }

    return { record, list, get, pending, live, decide, supersede, FIELDS, FIELD_NAMES };
}

module.exports = { createPriceStore, FIELDS, FIELD_NAMES };
