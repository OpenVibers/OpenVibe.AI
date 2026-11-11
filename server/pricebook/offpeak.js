'use strict';
/**
 * The price book's off-peak windows: what a provider's own price is when it is at least half lower than
 * the price the router charges, and when that is.
 *
 * A provider's own listing sometimes says so: DeepSeek's pricing page publishes an OFF-PEAK rate beside
 * the PEAK one and the hours the off-peak rate applies (UTC). The price book job reads it (the parser in
 * server/pricebook/parsers.js) and writes it here; a batch reads it to know when a paid route is cheap
 * enough to answer a half-price batch (server/batch/capacity.js), and a background run reads it to know
 * when a provider is at its off-peak price.
 *
 * Two shapes are stored, and both are read:
 *
 *   price_book_offpeak          one daily window per (provider, model, field): the hours it applies on
 *                               every day of the week. The rows the price book has always written.
 *   price_book_offpeak_blocks   blocks: a set of weekdays and the hours inside them, so a rule like
 *                               DeepSeek's (peak 01:00-04:00 and 06:00-10:00 UTC Monday to Friday, every
 *                               other hour off-peak, weekends in full) can be written down.
 *
 * A provider the price book has no window for is not eligible for a batch. The network does not guess a
 * price it has not read: a route whose real cost is unknown is a route the network cannot afford.
 */
const FIELDS = ['in_per_mtok', 'out_per_mtok', 'cached_per_mtok'];
/** The ISO weekday of a moment: 1 = Monday ... 7 = Sunday. */
const isoWeekday = (at) => ((new Date(at).getUTCDay() + 6) % 7) + 1;

/** The weekday list of a block: '1,2,3,4,5' -> [1,2,3,4,5]. An empty list means every day. */
function parseWeekdays(text) {
    const out = [];
    for (const part of String(text == null ? '' : text).split(',')) {
        const n = Number(part.trim());
        if (Number.isInteger(n) && n >= 1 && n <= 7) out.push(n);
    }
    return [...new Set(out)].sort((a, b) => a - b);
}

/** The list as it is stored: '1,2,3,4,5'. */
const formatWeekdays = (days) => (Array.isArray(days) ? days : []).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort((a, b) => a - b).join(',');

/**
 * Is `at` inside a window? A window that wraps the midnight (23-02) is handled. A window with weekdays
 * (a block) is only inside on those days; a window without them (the old single window) is inside every day.
 */
function insideWindow(window, at) {
    if (!window) return false;
    const hour = new Date(at).getUTCHours();
    const start = Number(window.start_hour);
    const end = Number(window.end_hour);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    const days = Array.isArray(window.weekdays) ? window.weekdays : [];
    if (days.length && !days.includes(isoWeekday(at))) return false;
    return start <= end ? (hour >= start && hour < end) : (hour >= start || hour < end);
}

/**
 * The next moment at or after `from` that is inside the window, or null when the window has no usable
 * hours. The weekday blocks are honoured; a bounded search (eight days) never loops.
 */
function nextWindowAt(window, from = Date.now()) {
    if (!window) return null;
    const start = Number(window.start_hour);
    const end = Number(window.end_hour);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return null;
    const days = Array.isArray(window.weekdays) ? window.weekdays : [];
    for (let step = 0; step <= 8 * 24; step += 1) {
        const at = Number(from) + step * 60 * 60 * 1000;
        if (insideWindow(window, at)) return new Date(at).toISOString();
    }
    return null;
}

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

    // ── The weekday blocks ──────────────────────────────────

    /**
     * Write one block: the provider's own price inside the hours it applies on the days it applies.
     * The block replaces any block with the same (provider, model, field, weekdays, hours).
     */
    async function recordBlock({ provider_key, model_key, field, price, weekdays, start_hour, end_hour, source, checked_at }) {
        if (!FIELDS.includes(field)) return null;
        const days = formatWeekdays(weekdays);
        if (!days) return null;
        const at = iso();
        await db.prepare(`INSERT INTO price_book_offpeak_blocks
            (provider_key, model_key, field, price, weekdays, start_hour, end_hour, source, checked_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (provider_key, model_key, field, weekdays, start_hour, end_hour) DO UPDATE SET price = EXCLUDED.price,
                source = EXCLUDED.source, checked_at = EXCLUDED.checked_at, updated_at = EXCLUDED.updated_at`)
            .run(provider_key, model_key, field, price, days, Math.trunc(start_hour), Math.trunc(end_hour), source, checked_at, at, at);
        return { provider_key, model_key, field, weekdays: days };
    }

    /** Forget the blocks of one model (the listing no longer publishes them). */
    async function clearBlocks(provider_key, model_key) {
        await db.prepare('DELETE FROM price_book_offpeak_blocks WHERE provider_key = ? AND model_key = ?').run(provider_key, model_key);
    }

    /** Every block the price book has read, grouped by (provider, model, weekdays, hours). */
    async function offPeakBlocks() {
        const rows = await db.prepare(`SELECT provider_key, model_key, field, price, weekdays, start_hour, end_hour, source, checked_at
            FROM price_book_offpeak_blocks`).all().catch(() => []);
        const byBlock = new Map();
        for (const row of rows || []) {
            const key = `${row.provider_key}/${row.model_key}/${row.weekdays}/${row.start_hour}-${row.end_hour}`;
            if (!byBlock.has(key)) {
                byBlock.set(key, {
                    provider_key: row.provider_key, model_key: row.model_key, weekdays: parseWeekdays(row.weekdays),
                    start_hour: Number(row.start_hour), end_hour: Number(row.end_hour), source: row.source,
                    checked_at: row.checked_at, input: null, output: null, cached_read: null,
                });
            }
            const entry = byBlock.get(key);
            if (row.field === 'in_per_mtok') entry.input = Number(row.price);
            if (row.field === 'out_per_mtok') entry.output = Number(row.price);
            if (row.field === 'cached_per_mtok') entry.cached_read = Number(row.price);
        }
        return [...byBlock.values()];
    }

    /**
     * Every window of every model: the old single windows (every day) and the weekday blocks.
     * A model with both is read twice: the block is the more precise one, and the single window is kept
     * because the price book wrote it before the blocks existed.
     */
    async function windows() {
        const legacy = (await offPeakRows()).map((w) => ({ ...w, weekdays: [] }));
        const blocks = await offPeakBlocks();
        return [...legacy, ...blocks];
    }

    /**
     * The provider's own off-peak price for one model at one moment, or null when the model is not at its
     * off-peak price then (or the price book has never read its price). The prices are the provider's own:
     * the input, the cached read and the output, per million tokens.
     */
    async function priceAt(provider_key, model_key, at) {
        const rows = await db.prepare(`SELECT provider_key, model_key, field, price, weekdays, start_hour, end_hour
            FROM price_book_offpeak_blocks WHERE provider_key = ? AND model_key = ?`).all(provider_key, model_key).catch(() => []);
        const byBlock = new Map();
        for (const row of rows || []) {
            const key = `${row.weekdays}/${row.start_hour}-${row.end_hour}`;
            if (!byBlock.has(key)) {
                byBlock.set(key, {
                    weekdays: parseWeekdays(row.weekdays), start_hour: Number(row.start_hour), end_hour: Number(row.end_hour),
                    input: null, output: null, cached_read: null,
                });
            }
            const entry = byBlock.get(key);
            if (row.field === 'in_per_mtok') entry.input = Number(row.price);
            if (row.field === 'out_per_mtok') entry.output = Number(row.price);
            if (row.field === 'cached_per_mtok') entry.cached_read = Number(row.price);
        }
        for (const entry of byBlock.values()) {
            if (!insideWindow(entry, at)) continue;
            if (entry.input == null && entry.output == null && entry.cached_read == null) continue;
            return entry;
        }
        // The old single window still counts: a provider the price book read before the blocks existed.
        const legacy = await db.prepare(`SELECT field, price, start_hour, end_hour FROM price_book_offpeak WHERE provider_key = ? AND model_key = ?`).all(provider_key, model_key).catch(() => []);
        if (legacy && legacy.length) {
            const entry = { weekdays: [], start_hour: Number(legacy[0].start_hour), end_hour: Number(legacy[0].end_hour), input: null, output: null, cached_read: null };
            for (const row of legacy) {
                if (row.field === 'in_per_mtok') entry.input = Number(row.price);
                if (row.field === 'out_per_mtok') entry.output = Number(row.price);
                if (row.field === 'cached_per_mtok') entry.cached_read = Number(row.price);
            }
            if (insideWindow(entry, at)) return entry;
        }
        return null;
    }

    return { record, clear, offPeakRows, recordBlock, clearBlocks, offPeakBlocks, windows, priceAt };
}

module.exports = { nextWindowAt, createOffPeak, FIELDS, insideWindow, isoWeekday, parseWeekdays, formatWeekdays };
