'use strict';
/**
 * The living price book: a weekly job that reads every catalogued provider's own price listing and keeps the
 * price the router charges in step with it.
 *
 * The rules it lives by:
 *
 *   - A price comes from the provider that sells it, never from a guess and never from an aggregator.
 *   - A price nobody publishes stays unknown. A listing that cannot be read leaves every price alone.
 *   - A live price never changes silently. Every change lands in the price_changes log with the old price, the
 *     new price, the listing it was read from and the day it was read.
 *   - A change of more than the threshold (20%) waits for the owner on the operator console. A smaller one is
 *     applied at once.
 *
 * The job is off under drill mode and off in the tests, and the tests replay the recorded listings through the
 * transport seam, so CI never touches the network.
 *
 * It is due-based rather than timer-based: the last finished run is a row in the database (server/pricebook/
 * state.js), because AI is deployed several times a day and a timer in the process would be reset every time.
 * The service ticks once an hour and reads the listings only when the interval has passed; the first tick after a
 * boot is a few minutes in, so the boot path stays free. Several workers run this service, so a run is claimed
 * before it starts: only one of them reads the listings at a time.
 */
const os = require('os');
const pool = require('../providers/pool-providers');
const { SOURCES } = require('./sources');
const { readListing } = require('./read');
const { createPriceStore, FIELDS, FIELD_NAMES } = require('./store');
const { createPriceState } = require('./state');

/** A price that differs by less than this is the same price: the providers publish floats (0.205999992). */
const EPSILON = 1e-6;
const DEFAULT_THRESHOLD = 0.2;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The sources the catalogue itself names, so a row the catalogue wrote is recognisable. */
function catalogueSources() {
    const set = new Set();
    for (const p of pool.PROVIDERS || []) for (const m of p.models || []) if (m.source) set.add(m.source);
    return set;
}

/**
 * May the price book price this row? A row a person priced by hand keeps its price, and so does a row the price
 * book already owns.
 */
function eligible(row, sources = catalogueSources()) {
    const meta = row.metadata || {};
    if (meta.price_book) return true;
    if (meta.id_source === 'provider-page' || meta.id_source === 'provider-list') return true;
    return Boolean(row.cost && row.cost.source && sources.has(row.cost.source));
}

/** The price a listing publishes for a model: the model's own id first, its leaf name second. */
function findPrice(prices, modelKey) {
    const exact = prices[String(modelKey || '').trim().toLowerCase()];
    if (exact) return { price: exact, via: 'id' };
    const wanted = String(modelKey || '').split('/').pop().trim().toLowerCase();
    for (const [id, price] of Object.entries(prices)) {
        if (id.split('/').pop().trim().toLowerCase() === wanted) return { price, via: 'leaf' };
    }
    return null;
}

const numeric = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

function createPriceBook({ db, registry, config = {}, clock = { now: () => Date.now() }, log = console, transport = null, lookup = null, sources = SOURCES, threshold = null }) {
    const settings = {
        threshold: DEFAULT_THRESHOLD,
        timeoutMs: 20000,
        maxBytes: 8 * 1024 * 1024,
        intervalMs: WEEK_MS,
        tickMs: HOUR_MS,
        firstTickMs: 5 * 60 * 1000,
        claimTtlMs: 15 * 60 * 1000,
        ...(config.priceBook || {}),
    };
    const limit = threshold === null || threshold === undefined ? Number(settings.threshold) : Number(threshold);
    const store = createPriceStore({ db, clock });
    // When the book last ran and which instance is running it now (server/pricebook/state.js).
    const state = createPriceState({ db, clock });
    // Who this instance is: the claim says which one holds the run.
    const who = `${os.hostname()}:${process.pid}`;
    // In test mode the book reads nothing from the internet: a test that wants a listing replays a recorded one
    // through the transport seam, and the service's own instance refuses to open a socket at all.
    const reader = transport || (config.nodeEnv === 'test'
        ? async () => ({ ok: false, error: 'the price book does not read the network in test mode' })
        : null);
    let running = false;
    let timer = null;
    let first = null;
    let last = null;

    const iso = () => new Date(clock.now()).toISOString();
    const day = () => iso().slice(0, 10);

    /** A provider in a drill must not move a price: the run waits for the drill to end. */
    async function drillActive() {
        if (!registry) return false;
        const providers = await registry.listProviders();
        return providers.some((p) => p && p.metadata && (p.metadata.fail || p.metadata.drill));
    }

    /** The model's row with a new price (or the same one with a new checked date). */
    async function writeRow({ row, cost, metadata, actor = 'pricebook' }) {
        return registry.upsertModel({
            provider_key: row.provider_key,
            model_key: row.model_key,
            display_name: row.display_name,
            type: row.type,
            status: row.status,
            context_window: row.context_window,
            max_output: row.max_output,
            cost,
            supports: row.supports,
            metadata,
        }, { actor });
    }

    /** The cost of a row with the price book's numbers in it. */
    function costWith(row, { changes = [], source, checkedAt, moved = false }) {
        const cost = { ...(row.cost || {}) };
        for (const change of changes) cost[change.field] = change.next;
        cost.source = source;
        cost.verified_at = checkedAt;
        if (moved) cost.effective_from = checkedAt;
        if (cost.cache_write_per_mtok === undefined) delete cost.cache_write_per_mtok;
        return cost;
    }

    /** The metadata that says the price book owns this price, so the catalogue does not write over it. */
    function metadataWith(row, { source, checkedAt }) {
        return { ...(row.metadata || {}), price_book: { checked_at: checkedAt, source } };
    }

    /**
     * Compare one provider's listing with the prices that are live, and record what changed.
     */
    async function priceProvider(source, prices, report, checkedAt) {
        const rows = await registry.listModels({ provider: source.provider });
        const catalogue = catalogueSources();
        for (const row of rows) {
            if (!eligible(row, catalogue)) { report.owned_by_hand.push(row.model_key); continue; }
            const found = findPrice(prices, row.model_key);
            if (!found) { report.not_listed.push(row.model_key); continue; }
            report.models++;
            const changes = [];
            for (const field of FIELDS) {
                const next = found.price[FIELD_NAMES[field]];
                if (next === null || next === undefined) continue;          // the listing publishes no such price
                const old = numeric(row.cost ? row.cost[field] : null);
                if (old !== null && Math.abs(old - next) <= EPSILON) { report.unchanged++; continue; }
                const pct = old === null || old === 0 ? null : (next - old) / old;
                changes.push({ field, old, next, pct });
            }
            if (!changes.length) {
                // The price stands: only the day it was checked moves, so the catalog can say when it was read.
                if (row.cost && row.cost.verified_at !== checkedAt) {
                    await writeRow({
                        row,
                        cost: costWith(row, { source: source.url, checkedAt }),
                        metadata: metadataWith(row, { source: source.url, checkedAt }),
                    });
                    report.checked.push(row.model_key);
                }
                continue;
            }
            const small = changes.filter((c) => c.pct !== null && Math.abs(c.pct) <= limit);
            const big = changes.filter((c) => !(c.pct !== null && Math.abs(c.pct) <= limit));
            if (small.length) {
                await writeRow({
                    row,
                    cost: costWith(row, { changes: small, source: source.url, checkedAt, moved: true }),
                    metadata: metadataWith(row, { source: source.url, checkedAt }),
                });
                for (const change of small) {
                    await store.record({
                        provider_key: row.provider_key,
                        model_key: row.model_key,
                        field: change.field,
                        old_price: change.old,
                        new_price: change.next,
                        change_pct: change.pct,
                        source: source.url,
                        checked_at: checkedAt,
                        status: 'applied',
                        note: 'applied by the weekly job',
                    });
                    report.applied.push({ model: row.model_key, field: change.field, old: change.old, next: change.next });
                }
            }
            for (const change of big) {
                await store.supersede({ provider_key: row.provider_key, model_key: row.model_key, field: change.field });
                const id = await store.record({
                    provider_key: row.provider_key,
                    model_key: row.model_key,
                    field: change.field,
                    old_price: change.old,
                    new_price: change.next,
                    change_pct: change.pct,
                    source: source.url,
                    checked_at: checkedAt,
                    status: 'pending',
                    note: 'over ' + Math.round(limit * 100) + '%: waiting for the owner',
                });
                report.pending.push({ id, model: row.model_key, field: change.field, old: change.old, next: change.next, pct: change.pct });
            }
        }
    }

    /**
     * The cross-reference: what OpenRouter says about the same models next to what the provider says. It is a
     * second opinion and nothing more: no price comes from it.
     */
    async function crossCheck(reference, readings, report) {
        const out = { models: 0, agree: 0, differ: 0, notes: [] };
        for (const [provider, prices] of Object.entries(readings)) {
            const rows = await registry.listModels({ provider });
            for (const row of rows) {
                const own = findPrice(prices, row.model_key);
                if (!own) continue;
                const other = findPrice(reference, row.model_key);
                if (!other) continue;
                out.models++;
                const a = numeric(own.price.in);
                const b = numeric(other.price.in);
                if (a === null || b === null) continue;
                if (Math.abs(a - b) <= EPSILON) out.agree++;
                else {
                    out.differ++;
                    if (out.notes.length < 20) out.notes.push({ model: row.model_key, provider_price: a, openrouter_price: b });
                }
            }
        }
        report.cross_reference = out;
    }

    /**
     * Is the book due? A run that finished less than an interval ago is not: the service may be deployed several
     * times a day, and the week must not restart with every restart.
     */
    async function due() {
        const last = await state.lastRunAt();
        if (last === null) return true;                       // the book has never run: it is due at once
        return clock.now() - last >= Number(settings.intervalMs);
    }

    /** One run of the book: read every listing, compare, record. */
    async function runOnce({ force = false } = {}) {
        if (running) return { skipped: 'running' };
        if (!force && settings.enabled === false) return { skipped: 'disabled' };
        running = true;
        const checkedAt = day();
        const report = {
            checked_at: checkedAt,
            started_at: iso(),
            sources: [],
            models: 0,
            applied: [],
            pending: [],
            unchanged: 0,
            checked: [],
            not_listed: [],
            owned_by_hand: [],
            unreadable: [],
            cross_reference: null,
        };
        const readings = {};
        try {
            if (await drillActive()) return { skipped: 'drill' };
            // Only one worker reads the listings at a time (the service runs several).
            if (!await state.claim({ ttlMs: Number(settings.claimTtlMs), who })) return { skipped: 'claimed' };
            try {
                for (const source of sources) {
                    const res = await readListing(source.url, {
                        transport: reader,
                        lookup,
                        timeoutMs: Number(settings.timeoutMs),
                        maxBytes: Number(settings.maxBytes),
                    });
                    if (!res.ok) {
                        report.unreadable.push({ source: source.key, url: source.url, error: res.error });
                        continue;
                    }
                    let prices;
                    try {
                        prices = source.parse(source.kind === 'json' ? JSON.parse(res.body) : res.body);
                    } catch {
                        report.unreadable.push({ source: source.key, url: source.url, error: 'the listing could not be read' });
                        continue;
                    }
                    report.sources.push({ source: source.key, url: source.url, role: source.role, listed: Object.keys(prices).length });
                    if (source.role === 'cross-reference') { await crossCheck(prices, readings, report); continue; }
                    readings[source.provider] = prices;
                    await priceProvider(source, prices, report, checkedAt);
                }
            } finally {
                // The claim goes back whatever happened, so the next worker may run.
                await state.release({ who });
            }
            // The run is over: the next one is due when the interval has passed (whether or not a price moved). A run
            // that read no listing at all did not check anything, so the book stays due and the next tick tries again.
            if (report.sources.length || !sources.length) await state.markRun();
        } catch (err) {
            report.error = err && err.code ? err.code : 'error';
            log.warn('[pricebook] the run stopped early: ' + report.error);
        } finally {
            running = false;
        }
        last = report;
        log.log(`[pricebook] checked ${report.sources.length} listings, ${report.models} models, ${report.applied.length} applied, ${report.pending.length} waiting for the owner${report.unreadable.length ? `; unreadable: ${report.unreadable.map((u) => `${u.source} (${u.error})`).join(', ')}` : ''}`);
        return report;
    }

    /** The pending changes, and the ones that are live. */
    const pending = (limit) => store.pending(limit);
    const live = (limit) => store.live(limit);
    const changes = (opts) => store.list(opts);

    /**
     * The owner's decision on a waiting change. Approving it writes the price into the model row; rejecting it
     * leaves the live price alone and the log keeps the story.
     */
    async function decide(id, { decision, actor, note = null }) {
        const row = await store.get(id);
        if (!row) return { ok: false, error: 'no such change' };
        if (row.status !== 'pending') return { ok: false, error: 'that change was already decided', change: row };
        if (decision === 'approve') {
            const model = await registry.getModel(row.provider_key, row.model_key);
            if (!model) return { ok: false, error: 'the model is gone', change: row };
            const changesForRow = [{
                field: row.field,
                old: numeric(row.old_price),
                next: numeric(row.new_price),
                pct: numeric(row.change_pct),
            }];
            const day = row.checked_at instanceof Date ? row.checked_at.toISOString().slice(0, 10) : String(row.checked_at || '').slice(0, 10);
            await writeRow({
                row: model,
                cost: costWith(model, { changes: changesForRow, source: row.source, checkedAt: day, moved: true }),
                metadata: metadataWith(model, { source: row.source, checkedAt: day }),
            });
            const decided = await store.decide(id, { status: 'approved', actor, note });
            return { ok: true, change: decided };
        }
        const decided = await store.decide(id, { status: 'rejected', actor, note });
        return { ok: true, change: decided };
    }

    /**
     * One tick: run the book when it is due. The due check reads the last finished run from the database, so a
     * restart in the middle of the week does not run it again and a restart after it does.
     */
    async function tick() {
        if (running) return { skipped: 'running' };
        if (settings.enabled === false) return { skipped: 'disabled' };
        if (!await due()) return { skipped: 'not due' };
        return await runOnce();
    }

    /**
     * The service ticks once an hour and reads the listings only when the interval has passed. The first tick
     * after a boot is a few minutes in, so the boot path stays free and a restart does not restart the week.
     */
    function start() {
        if (timer) return timer;
        const every = Math.max(60000, Number(settings.tickMs) || HOUR_MS);
        timer = setInterval(() => { tick().catch(() => {}); }, every);
        timer.unref?.();
        first = setTimeout(() => { tick().catch(() => {}); }, Math.max(1000, Number(settings.firstTickMs) || 5 * 60 * 1000));
        first.unref?.();
        return timer;
    }

    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
        if (first) { clearTimeout(first); first = null; }
    }

    return { runOnce, tick, due, start, stop, decide, pending, live, changes, store, state, settings, threshold: limit, get last() { return last; } };
}

module.exports = { createPriceBook, eligible, findPrice, catalogueSources, EPSILON, DEFAULT_THRESHOLD, WEEK_MS };
