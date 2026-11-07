'use strict';
/**
 * The price book's off-peak windows: what a provider's own price is when it is at least half lower than
 * the price the router charges, and when that is.
 *
 * A provider's own listing sometimes says so: DeepSeek's pricing page publishes an OFF-PEAK rate beside
 * the PEAK one and the hours the off-peak rate applies (UTC). The price book job reads it (the parser in
 * server/pricebook/parsers.js) and writes it here; a batch reads it to know when a paid route is cheap
 * enough to answer a half-price batch (server/batch/capacity.js).
 *
 * A provider the price book has no window for is not eligible for a batch. The network does not guess a
 * price it has not read: a route whose real cost is unknown is a route the network cannot afford.
 */
const FIELDS = ['in_per_mtok', 'out_per_mtok', 'cached_per_mtok'];

function createOffPeak({ db, clock = { now: () => Date.now() } }) {
    const iso = () => new Date(clock.now()).toISOString();

    /** Write one window: the provider's own price inside the hours it applies. */
    async function record({ provider_key, model_key, field, price, start_hour, end_hour, source, checked_at }) {
        if (!FIELDS.includes(field)) return null;
        const at = iso();
        await db.prepare(`INSERT INTO price_book_offpeak
            (provider_key, model_key, field, price, start_hour, end_hour, source, checked_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (provider_key, model_key, field) DO UPDATE SET price = EXCLUDED.price,
                start_hour = EXCLUDED.start_hour, end_hour = EXCLUDED.end_hour, source = EXCLUDED.source,
                checked_at = EXCLUDED.checked_at, updated_at = EXCLUDED.updated_at`)
            .run(provider_key, model_key, field, price, Math.trunc(start_hour), Math.trunc(end_hour), source, checked_at, at, at);
        return { provider_key, model_key, field };
    }

    /** Forget a window the provider's listing no longer publishes. */
    async function clear(provider_key, model_key) {
        await db.prepare('DELETE FROM price_book_offpeak WHERE provider_key = ? AND model_key = ?').run(provider_key, model_key);
    }

    /** Every window the price book has read. */
    async function offPeakRows() {
        const rows = await db.prepare(`SELECT provider_key, model_key, field, price, start_hour, end_hour, source, checked_at
            FROM price_book_offpeak`).all().catch(() => []);
        const byModel = new Map();
        for (const row of rows || []) {
            const key = `${row.provider_key}/${row.model_key}`;
            if (!byModel.has(key)) byModel.set(key, { provider_key: row.provider_key, model_key: row.model_key, start_hour: row.start_hour, end_hour: row.end_hour, source: row.source, checked_at: row.checked_at, input: null, output: null });
            const entry = byModel.get(key);
            if (row.field === 'in_per_mtok') entry.input = Number(row.price);
            if (row.field === 'out_per_mtok') entry.output = Number(row.price);
            if (row.field === 'cached_per_mtok') entry.cached_read = Number(row.price);
        }
        return [...byModel.values()];
    }

    return { record, clear, offPeakRows };
}

module.exports = { createOffPeak, FIELDS };
