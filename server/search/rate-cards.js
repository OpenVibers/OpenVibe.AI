'use strict';
/**
 * Versioned rate cards for the search engines (plan §W.2 step 3, 11-13).
 *
 * A card says what one unit of an engine costs: the price, the conservative ceiling a hold reserves, the
 * currency, the monthly allowance, the page it was read on and the day it was read. A card is never edited:
 * a new price is a new version, a draft until the owner activates it, and activating it retires the one it
 * replaces. Exactly one ACTIVE card exists per (engine, unit): the table says so with a partial unique index.
 *
 * The money is integer nano-USD, from decimal text, never a float — the same parsing as max_cost_usd
 * (server/credits.js parseCostUsd). A hold is the ceiling × the units a call may use; a settle is the price ×
 * the units it used.
 *
 *   SEED          version 1 of every card: the rows migrations/0089 seeds
 *   active()      the active cards, by engine (the table when there is a database, SEED without one)
 *   list()        every card: active, draft and retired
 *   addDraft()    a new version, as a draft (a draft is never used)
 *   activate()    the owner activates a draft; the card it replaces is retired
 *   estimate()    the hold: ceiling × units
 *   settle()      the settle: price × units
 *
 * A process without a database (a unit test, a tool) reads version 1 as it was seeded; a service with one
 * reads the live table, where the owner's own versions live.
 */
const { ids } = require('openvibe-contracts');
const { AiError } = require('../util');
const { parseCostUsd } = require('../credits');

const NANO_PER_USD = 1000000000n;
const MS_PER_DAY = 86400000;
/** A card older than this says so on the engines list. */
const STALE_AFTER_DAYS = 90;
const UNITS = Object.freeze(['request', 'result', 'page', 'token_in', 'token_out', 'tool_call', 'feature_unit', 'credit']);
const STATUSES = Object.freeze(['draft', 'active', 'retired']);
const USD = 'USD';
// Mojeek publishes in GBP; its card carries the USD price it was converted to, and the rate and the day.
const MOJEEK_CURRENCY = 'USD (Mojeek publishes in GBP: £2.00 per 1,000 requests at 1 GBP = 1.3227 USD, ECB reference rate read 2026-11-13)';

/**
 * Version 1 of every card: the price each adapter carried before the clean cut, its own unit, and the day
 * its page was read. The price is per unit (the adapter's price per 1,000 divided by 1,000, exactly), never a
 * float; the ceiling is what a hold reserves for one unit (the engine's own reserve when it has one).
 */
const SEED = Object.freeze([
    { engine: 'openverse', unit: 'result', price: '0', ceiling: '0', currency: USD, included: null, source_url: 'https://api.openverse.org/', read_on: '2026-11-09' },
    { engine: 'commons', unit: 'result', price: '0', ceiling: '0', currency: USD, included: null, source_url: 'https://www.mediawiki.org/wiki/API:Main_page', read_on: '2026-11-09' },
    { engine: 'searxng', unit: 'request', price: '0', ceiling: '0', currency: USD, included: null, source_url: 'https://docs.searxng.org/', read_on: '2026-11-09' },
    { engine: 'openvibe', unit: 'request', price: '0', ceiling: '0', currency: USD, included: null, source_url: 'https://search.openvibe.network', read_on: '2026-11-12' },
    { engine: 'iconify', unit: 'result', price: '0', ceiling: '0', currency: USD, included: null, source_url: 'https://iconify.design/docs/api/', read_on: '2026-11-09' },
    { engine: 'deepseek', unit: 'request', price: '0.00075', ceiling: '0.00075', currency: USD, included: null, source_url: 'https://api-docs.deepseek.com/guides/search/', read_on: '2026-11-09' },
    { engine: 'brave', unit: 'request', price: '0.005', ceiling: '0.005', currency: USD, included: '$5 monthly credit', source_url: 'https://api-dashboard.search.brave.com/app/plans', read_on: '2026-11-09' },
    { engine: 'exa', unit: 'request', price: '0.007', ceiling: '0.007', currency: USD, included: null, source_url: 'https://exa.ai/docs/admin/pricing', read_on: '2026-11-09' },
    { engine: 'tavily', unit: 'request', price: '0.008', ceiling: '0.008', currency: USD, included: '1,000 credits a month', source_url: 'https://www.tavily.com/pricing', read_on: '2026-11-09' },
    { engine: 'serper', unit: 'request', price: '0.001', ceiling: '0.001', currency: USD, included: null, source_url: 'https://serper.dev/', read_on: '2026-11-09' },
    { engine: 'serpapi', unit: 'request', price: '0.025', ceiling: '0.025', currency: USD, included: '250 searches a month', source_url: 'https://serpapi.com/pricing', read_on: '2026-11-09' },
    { engine: 'jina', unit: 'request', price: '0.0005', ceiling: '0.005', currency: USD, included: null, source_url: 'https://jina.ai/reader/#apiform', read_on: '2026-11-09' },
    { engine: 'openvibe-egress', unit: 'page', price: '0', ceiling: '0', currency: USD, included: null, source_url: 'https://openvibe.exchange', read_on: '2026-11-09' },
    { engine: 'perplexity', unit: 'request', price: '0.0025', ceiling: '0.1', currency: USD, included: null, source_url: 'https://docs.perplexity.ai/docs/getting-started/pricing', read_on: '2026-11-09' },
    { engine: 'kagi', unit: 'request', price: '0.025', ceiling: '0.025', currency: USD, included: null, source_url: 'https://help.kagi.com/kagi/api/search-legacy.html', read_on: '2026-11-09' },
    { engine: 'google', unit: 'request', price: '0.005', ceiling: '0.005', currency: USD, included: null, source_url: 'https://developers.google.com/custom-search/v1/overview', read_on: '2026-11-09' },
    { engine: 'unsplash', unit: 'result', price: '0', ceiling: '0', currency: USD, included: null, source_url: 'https://unsplash.com/documentation#search-photos', read_on: '2026-11-13' },
    { engine: 'pexels', unit: 'result', price: '0', ceiling: '0', currency: USD, included: null, source_url: 'https://www.pexels.com/api/', read_on: '2026-11-09' },
    { engine: 'pixabay', unit: 'result', price: '0', ceiling: '0', currency: USD, included: null, source_url: 'https://pixabay.com/api/docs/', read_on: '2026-11-13' },
    { engine: 'brave-images', unit: 'request', price: '0.005', ceiling: '0.005', currency: USD, included: '$5 monthly credit', source_url: 'https://api-dashboard.search.brave.com/app/plans', read_on: '2026-11-09' },
    { engine: 'meta', unit: 'request', price: '0.0025', ceiling: '4', currency: USD, included: null, source_url: 'https://dev.meta.ai/docs/pricing-rate-limits', read_on: '2026-11-10' },
    { engine: 'serper-images', unit: 'request', price: '0.001', ceiling: '0.001', currency: USD, included: null, source_url: 'https://serper.dev/', read_on: '2026-11-10' },
    { engine: 'serpapi-images', unit: 'request', price: '0.025', ceiling: '0.025', currency: USD, included: '250 searches a month', source_url: 'https://serpapi.com/google-images-api', read_on: '2026-11-13' },
    { engine: 'searchapi-images', unit: 'request', price: '0.004', ceiling: '0.004', currency: USD, included: '100 trial searches', source_url: 'https://www.searchapi.io/docs/google-images', read_on: '2026-11-13' },
    { engine: 'serpapi-reverse', unit: 'request', price: '0.025', ceiling: '0.025', currency: USD, included: '250 searches a month', source_url: 'https://serpapi.com/google-reverse-image', read_on: '2026-11-13' },
    { engine: 'tineye', unit: 'request', price: '0.04', ceiling: '0.04', currency: USD, included: null, source_url: 'https://api.tineye.com/python/docs/', read_on: '2026-11-13' },
    { engine: 'mojeek', unit: 'request', price: '0.00265', ceiling: '0.00265', currency: MOJEEK_CURRENCY, included: 'Free credit on the Startup plan', source_url: 'https://www.mojeek.com/services/search/web-search-api', read_on: '2026-11-13' },
    { engine: 'parallel', unit: 'request', price: '0.001', ceiling: '0.001', currency: USD, included: null, source_url: 'https://docs.parallel.ai/getting-started/pricing', read_on: '2026-11-13' },
    { engine: 'you', unit: 'request', price: '0.005', ceiling: '0.005', currency: USD, included: null, source_url: 'https://you.com/docs/administration/billing', read_on: '2026-11-13' },
    { engine: 'dataforseo', unit: 'request', price: '0.002', ceiling: '0.002', currency: USD, included: null, source_url: 'https://dataforseo.com/pricing/google-serp/google-organic-serp-api', read_on: '2026-11-13' },
    { engine: 'europeana', unit: 'result', price: '0', ceiling: '0', currency: USD, included: null, source_url: 'https://api.europeana.eu/record/v2/search.json', read_on: '2026-11-13' },
    { engine: 'nasa', unit: 'result', price: '0', ceiling: '0', currency: USD, included: null, source_url: 'https://images.nasa.gov/docs/images.nasa.gov_api_docs.pdf', read_on: '2026-11-13' },
    { engine: 'dataforseo-images', unit: 'request', price: '0.002', ceiling: '0.002', currency: USD, included: null, source_url: 'https://dataforseo.com/pricing/google-serp/google-images-serp-api', read_on: '2026-11-13' },
    { engine: 'smithsonian', unit: 'result', price: '0', ceiling: '0', currency: USD, included: null, source_url: 'https://www.si.edu/openaccess/devtools', read_on: '2026-11-13' },
].map((row) => Object.freeze({
    ...row,
    id: `src_${row.engine}_${row.unit}_v1`,
    version: 1,
    status: 'active',
    reviewed_by: 'seed',
})));

/** Decimal text → integer nano-USD. Never a float; the same parsing as max_cost_usd. */
function nanoOf(text, field = 'price') {
    if (text == null) return null;
    return parseCostUsd(String(text).trim(), field);
}

/**
 * What a provider reported as its cost (a float, from the provider's own numbers) as integer nano-USD.
 * Nine digits is the whole of nano-USD, so this is exact to the last nano.
 */
function nanoOfCost(value) {
    if (value == null) return null;
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid engine cost');
    try { return parseCostUsd(value.toFixed(9), 'cost'); } catch { throw new Error('Invalid engine cost'); }
}

/**
 * The price of a thousand units, as decimal text: what the old "price per 1,000" said, kept for the surfaces
 * that still show it. Exact, without a float.
 */
function perThousand(card) {
    if (!card) return null;
    const nano = nanoOf(card.price, 'price');
    if (nano == null) return null;
    const thousand = nano * 1000n;
    const whole = thousand / NANO_PER_USD;
    const frac = thousand % NANO_PER_USD;
    if (frac === 0n) return String(whole);
    return `${whole}.${String(frac).padStart(9, '0').replace(/0+$/, '')}`;
}

/** nano-USD × units, exactly. */
function times(nano, units) {
    if (nano == null) return null;
    const n = BigInt(Math.max(0, Math.trunc(Number(units) || 0)));
    return nano * n;
}

/** The hold a card reserves: its ceiling × the units a call may use. */
function estimate(card, units) {
    return times(nanoOf(card && card.ceiling, 'ceiling'), units);
}

/** The settle a card charges: its price × the units a call used. */
function settle(card, units) {
    return times(nanoOf(card && card.price, 'price'), units);
}

/**
 * The units a call may use (what a hold reserves) and the units it used (what a settle charges):
 * a result-priced engine counts the rows it may return and the rows it returned; a token-priced one counts
 * tokens; every other unit is one call.
 */
function unitsMayUse(card, body = {}, extra = {}) {
    const unit = card && card.unit;
    if (unit === 'result') return Math.max(1, Math.trunc(Number(body.limit) || 10));
    if (unit === 'token_in' || unit === 'token_out') return Math.max(0, Math.trunc(Number(extra.tokens) || 0));
    return 1;
}

function unitsUsed(card, extra = {}) {
    const unit = card && card.unit;
    if (unit === 'result') return Math.max(0, Math.trunc(Number(extra.results) || 0));
    if (unit === 'token_in' || unit === 'token_out') return Math.max(0, Math.trunc(Number(extra.tokens) || 0));
    return 1;
}

/** A day, as YYYY-MM-DD, from a date column or from text. */
function dayOf(value) {
    if (value == null) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
}

/** How old a card is, in days, from the day its page was read. */
function ageDays(card, now = Date.now()) {
    const read = Date.parse(dayOf(card && card.read_on) + 'T00:00:00Z');
    if (!Number.isFinite(read)) return null;
    return Math.max(0, Math.floor((now - read) / MS_PER_DAY));
}

/** A card older than 90 days says so. */
function isStale(card, now = Date.now()) {
    const age = ageDays(card, now);
    return age != null && age > STALE_AFTER_DAYS;
}

/** nano-USD → the number the receipt and the Exchange carry (a float only at this boundary). */
const usdOf = (nano) => (nano == null ? null : Number(nano) / Number(NANO_PER_USD));

/** A row as the API and the receipt see it. */
function view(row, now = Date.now()) {
    return {
        id: row.id,
        engine: row.engine,
        version: Number(row.version),
        unit: row.unit,
        price: String(row.price),
        ceiling: String(row.ceiling),
        currency: row.currency || USD,
        included: row.included == null ? null : String(row.included),
        source_url: row.source_url || null,
        read_on: dayOf(row.read_on),
        status: row.status,
        reviewed_by: row.reviewed_by || null,
        created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
        age_days: ageDays(row, now),
        stale: isStale(row, now),
    };
}

function createRateCards({ db = null, clock = { now: () => Date.now() } } = {}) {
    const now = () => clock.now();
    const at = () => new Date(now()).toISOString();
    const seedRows = () => SEED.map((row) => ({ ...row, created_at: `${row.read_on}T00:00:00.000Z` }));
    const readAll = async (where = '', values = []) => {
        const rows = await db.prepare(`SELECT id, engine, version, unit, price, ceiling, currency, "included", source_url, read_on, status, reviewed_by, created_at FROM search_rate_cards ${where} ORDER BY engine, unit, version`).all(...values);
        return rows;
    };
    const cardOf = (row) => view(row, now());

    /** The active cards, by engine. A process without a database reads version 1 as it was seeded. */
    async function active() {
        const map = new Map();
        const rows = db ? await readAll("WHERE status = 'active'") : seedRows();
        for (const row of rows) {
            if (!map.has(row.engine)) map.set(row.engine, []);
            map.get(row.engine).push(cardOf(row));
        }
        return map;
    }

    /** The active cards of one engine. */
    async function activeFor(engine) {
        const cards = await active();
        return (cards.get(engine) || []).map(cardOf);
    }

    /** Every card: active, draft and retired. */
    async function list() {
        if (!db) return seedRows().map((row) => cardOf(row));
        return (await readAll()).map((row) => cardOf(row));
    }

    /** One card by id. */
    async function get(id) {
        if (!db) {
            const row = seedRows().find((r) => r.id === id);
            return row ? cardOf(row) : null;
        }
        const rows = await db.prepare('SELECT id, engine, version, unit, price, ceiling, currency, "included", source_url, read_on, status, reviewed_by, created_at FROM search_rate_cards WHERE id = ?').all(String(id));
        return rows[0] ? cardOf(rows[0]) : null;
    }

    /** The next version number for an (engine, unit): one more than the highest that exists. */
    async function nextVersion(engine, unit) {
        if (!db) return 1;
        const rows = await db.prepare('SELECT MAX(version) AS version FROM search_rate_cards WHERE engine = ? AND unit = ?').all(String(engine), String(unit));
        const highest = Number(rows[0] && rows[0].version) || 0;
        return highest + 1;
    }

    /**
     * A new version, as a draft. A draft is never used: the search reads the active card only, so a price
     * the owner has not activated changes nothing.
     */
    async function addDraft(body, { actor = null } = {}) {
        const engine = String(body.engine || '').trim();
        const unit = String(body.unit || '').trim();
        if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(engine)) throw new AiError(422, 'ai.invalid', 'engine must be an engine id');
        if (!UNITS.includes(unit)) throw new AiError(422, 'ai.invalid', `unit must be one of ${UNITS.join(', ')}`);
        const price = String(body.price == null ? '' : body.price).trim();
        const ceiling = String(body.ceiling == null ? '' : body.ceiling).trim();
        if (!/^[0-9]+(?:\.[0-9]+)?$/.test(price)) throw new AiError(422, 'ai.invalid', 'price must be a plain decimal amount');
        if (!/^[0-9]+(?:\.[0-9]+)?$/.test(ceiling)) throw new AiError(422, 'ai.invalid', 'ceiling must be a plain decimal amount');
        const priceNano = nanoOf(price, 'price');
        const ceilingNano = nanoOf(ceiling, 'ceiling');
        if (ceilingNano < priceNano) throw new AiError(422, 'ai.invalid', 'the ceiling reserves at least the price');
        const currency = String(body.currency || USD).trim();
        const included = body.included == null || body.included === '' ? null : String(body.included).trim();
        const sourceUrl = body.source_url == null || body.source_url === '' ? null : String(body.source_url).trim();
        if (sourceUrl && !/^https:\/\//.test(sourceUrl)) throw new AiError(422, 'ai.invalid', 'source_url must be an https page');
        const readOn = String(body.read_on || new Date(now()).toISOString().slice(0, 10)).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(readOn) || !Number.isFinite(Date.parse(readOn))) throw new AiError(422, 'ai.invalid', 'read_on must be a date in YYYY-MM-DD');
        const version = await nextVersion(engine, unit);
        const id = `src_${ids.ulid()}`;
        if (!db) {
            return { id, engine, version, unit, price, ceiling, currency, included, source_url: sourceUrl, read_on: readOn, status: 'draft', reviewed_by: actor, created_at: at(), age_days: 0, stale: false };
        }
        const rows = await db.prepare(`INSERT INTO search_rate_cards (id, engine, version, unit, price, ceiling, currency, "included", source_url, read_on, status, reviewed_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?) RETURNING id, engine, version, unit, price, ceiling, currency, "included", source_url, read_on, status, reviewed_by, created_at`)
            .run(id, engine, version, unit, price, ceiling, currency, included, sourceUrl, readOn, actor, at());
        const row = await db.prepare('SELECT id, engine, version, unit, price, ceiling, currency, "included", source_url, read_on, status, reviewed_by, created_at FROM search_rate_cards WHERE id = ?').all(id);
        return cardOf(row[0] || { id, engine, version, unit, price, ceiling, currency, included, source_url: sourceUrl, read_on: readOn, status: 'draft', reviewed_by: actor, created_at: at() });
    }

    /**
     * The owner activates a draft: the card it replaces for that (engine, unit) is retired, and the draft
     * becomes the one active card. One statement each, in one transaction: there is never a moment with two
     * active cards for a unit, nor a moment with none.
     */
    async function activate(id, { actor = null } = {}) {
        if (!db) throw new AiError(503, 'ai.unavailable', 'rate cards need a database');
        const rows = await db.prepare('SELECT id, engine, version, unit, status FROM search_rate_cards WHERE id = ?').all(String(id));
        const row = rows[0];
        if (!row) throw new AiError(404, 'ai.not_found', 'no such rate card');
        if (row.status === 'active') return cardOf(row);
        if (row.status !== 'draft') throw new AiError(422, 'ai.invalid', 'only a draft can be activated');
        await db.tx(async () => {
            await db.prepare("UPDATE search_rate_cards SET status = 'retired' WHERE engine = ? AND unit = ? AND status = 'active'").run(row.engine, row.unit);
            await db.prepare("UPDATE search_rate_cards SET status = 'active', reviewed_by = ? WHERE id = ?").run(actor, row.id);
        });
        const after = await db.prepare('SELECT id, engine, version, unit, price, ceiling, currency, "included", source_url, read_on, status, reviewed_by, created_at FROM search_rate_cards WHERE id = ?').all(row.id);
        return cardOf(after[0]);
    }

    return {
        active, activeFor, list, get, addDraft, activate, nextVersion,
        estimate, settle, unitsMayUse, unitsUsed, nanoOf, nanoOfCost, times, usdOf, ageDays, isStale, view, perThousand,
    };
}

module.exports = {
    createRateCards, SEED, UNITS, STATUSES, USD, STALE_AFTER_DAYS, MS_PER_DAY, NANO_PER_USD,
    nanoOf, nanoOfCost, times, estimate, settle, unitsMayUse, unitsUsed, ageDays, isStale, usdOf, view, dayOf, perThousand,
};
