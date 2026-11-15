'use strict';
/**
 * Image search, a page at a time (the owner, 11-15: the design deep dive "should screenshot search queries on Google,
 * Bing, etc to analyze a whole page of images at once … and filter for recent results … fully configurable").
 *
 * For each query (the question and the plan's picture searches, or the person's own), every chosen image engine that
 * answers is asked for one page of results, at the chosen recency: Google and Bing images through the person's own
 * keys (SerpAPI, Serper, SearchAPI, DataForSEO) or OpenVibe's own SearXNG instance, and the open collections
 * (Openverse, Wikimedia Commons, NASA). An engine that cannot filter by date is left out of a dated sheet (and the
 * report says so) rather than mixing old results in. The page is laid out the way a results page shows it, as one
 * sheet: up to 60 thumbnails in a grid, in the engine's own order. A vision model then reads the whole sheet at once:
 * what recurs, the palettes, the compositions, the styles, the outliers.
 *
 * The engines' pages are never scraped: the results come through their APIs (or our own SearXNG), and the sheet is
 * ours, drawn from the thumbnails (public HTTPS only, through the guarded fetch). A sheet is a private Media object of
 * the run's owner, like the screenshots, read back through the deep dive's shots route.
 */
const { guardedFetch } = require('../providers/guarded-fetch');
const { publicTarget } = require('../search/transport');

const RECENCY_DAYS = { day: 1, week: 7, month: 31, year: 366 };
const ENGINE_NAMES = {
    searxng: 'Google, Bing and DuckDuckGo images (OpenVibe SearXNG)', 'serpapi-images': 'Google Images (SerpAPI)', 'serper-images': 'Google Images (Serper)',
    'searchapi-images': 'Google or Bing Images (SearchAPI)', 'dataforseo-images': 'Google Images (DataForSEO)', 'brave-images': 'Brave Images',
    openverse: 'Openverse', commons: 'Wikimedia Commons', nasa: 'NASA', unsplash: 'Unsplash', pexels: 'Pexels', pixabay: 'Pixabay', europeana: 'Europeana', smithsonian: 'Smithsonian',
};
const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const isoDaysAgo = (days, now) => new Date(now - days * 86400000).toISOString().slice(0, 10);

function createSheets({ search, mediaStore, fetcher = null, llm, log = console, fetchImpl = guardedFetch, checkTarget = publicTarget, now = () => Date.now() } = {}) {
    let sharp = null;
    try { sharp = require('sharp'); } catch { sharp = null; }

    /** One thumbnail as a square cell (cover, the interesting part kept), or null. */
    async function cellOf(url, size, signal) {
        if (!/^https:\/\//i.test(String(url || ''))) return null;
        try {
            await checkTarget(url);
            const res = await fetchImpl(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000), headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8', 'user-agent': 'OpenVibeDeepDive/1.0 (+https://openvibe.design/deep-dive)' } });
            if (!res.ok) return null;
            const buf = Buffer.from(await res.arrayBuffer());
            if (!buf.length || buf.length > 8 * 1024 * 1024) return null;
            return await sharp(buf, { failOn: 'none', animated: false }).rotate().resize(size, size, { fit: 'cover', position: 'attention' }).jpeg({ quality: 82 }).toBuffer();
        } catch { return null; }
    }

    /** The results laid out as one sheet: a grid in the engine's own order. → { buffer, width, height, used } | null */
    async function compose(images, { cols = 8, cell = 200, gap = 6, signal = null } = {}) {
        if (!sharp) return null;
        const tiles = [];
        for (let i = 0; i < images.length; i += 8) {
            if (signal && signal.aborted) break;
            const got = await Promise.all(images.slice(i, i + 8).map((im) => cellOf(im.thumbnail || im.url, cell, signal)));
            got.forEach((b, j) => { if (b) tiles.push({ buf: b, image: images[i + j] }); });
        }
        if (tiles.length < 4) return null;
        const c = Math.min(cols, tiles.length);
        const rows = Math.ceil(tiles.length / c);
        const width = c * cell + (c + 1) * gap;
        const height = rows * cell + (rows + 1) * gap;
        const buffer = await sharp({ create: { width, height, channels: 3, background: { r: 17, g: 19, b: 25 } } })
            .composite(tiles.map((t, k) => ({ input: t.buf, left: gap + (k % c) * (cell + gap), top: gap + Math.floor(k / c) * (cell + gap) })))
            .jpeg({ quality: 84 }).toBuffer();
        return { buffer, width, height, used: tiles.map((t) => t.image) };
    }

    /**
     * Which engines answer images, and which can honour a date. Without a choice: the ones OpenVibe runs. A person's
     * own choice may name an engine that needs their own key (Google or Bing through SerpAPI, Serper, SearchAPI,
     * DataForSEO): it is asked with their key, and a missing key is a note, not a stop.
     */
    async function enginesFor(wanted, subject) {
        const all = typeof search.engines === 'function' ? await search.engines().catch(() => []) : [];
        const list = (Array.isArray(all) ? all : (all && all.engines) || []).filter((e) => e && Array.isArray(e.kinds) && e.kinds.includes('images'));
        const ok = wanted && wanted.length
            ? list.filter((e) => wanted.includes(e.id) && (e.available !== false || e.byok))
            : list.filter((e) => e.available !== false);
        return ok.map((e) => ({ id: e.id, name: ENGINE_NAMES[e.id] || e.id, dated: ['native', 'local'].includes((e.filters || {}).after) }));
    }

    /**
     * Sheets for these queries. → { sheets: [{ id, media_id, query, engine, recency, count, width, height, sources,
     * reading, patterns, palette, styles, outliers }], notes: [..] }
     */
    async function make({ queries, engines = null, recency = 'year', perSheet = 40, maxSheets = 4, owner = null, runId = null, question = '', signal = null, ctx = {}, onCall = () => {}, onSheet = null, overBudget = () => false, vision = 'default.json' }) {
        const notes = [];
        const sheets = [];
        if (!sharp) return { sheets, notes: ['Image sheets need sharp on this host; none were made.'] };
        if (!mediaStore || typeof mediaStore.put !== 'function') return { sheets, notes: ['Media is not configured; no image sheet was kept.'] };
        const days = RECENCY_DAYS[recency] || null;
        const after = days ? isoDaysAgo(days, now()) : null;
        let available = await enginesFor(engines, owner);
        if (days) {
            const undated = available.filter((e) => !e.dated);
            if (undated.length) notes.push(`${undated.map((e) => e.name).join(', ')} cannot filter by date, so ${undated.length === 1 ? 'it was' : 'they were'} left out of the past-${recency} sheets.`);
            available = available.filter((e) => e.dated);
            if (!available.length) { notes.push(`No image engine here can filter by date; turn the recency to "any time", or add a Google or Bing key, to get image sheets.`); return { sheets, notes }; }
        }
        if (!available.length) return { sheets, notes: ['No image engine answered here.'] };
        for (const q of queries.map((x) => oneLine(x, 200)).filter(Boolean)) {
            for (const engine of available) {
                if (sheets.length >= maxSheets || (signal && signal.aborted) || overBudget()) break;
                let page;
                try {
                    page = await search.search('images', { q, engine: engine.id, limit: Math.max(8, Math.min(60, perSheet)), ...(after ? { after } : {}) }, { subject: owner || undefined });
                } catch (err) { notes.push(`${engine.name}: ${oneLine(err && err.message, 140)}`); continue; }
                const results = ((page && page.results) || []).filter((r) => r && (r.thumbnail || r.url)).slice(0, Math.min(60, perSheet));
                if (results.length < 4) { notes.push(`${engine.name} found too few images for "${q}".`); continue; }
                const drawn = await compose(results, { signal });
                if (!drawn) { notes.push(`${engine.name}: the thumbnails for "${q}" could not be read.`); continue; }
                let stored;
                try {
                    stored = await mediaStore.put({ bytes: drawn.buffer, mime: 'image/jpeg', filename: 'image-sheet.jpg', owner, visibility: 'private', metadata: { kind: 'deep-dive-image-sheet', run_id: runId, query: q, engine: engine.id, recency } });
                } catch (err) { notes.push(`the sheet for "${q}" was not kept: ${oneLine(err && err.message, 140)}`); continue; }
                const sheet = {
                    id: `sheet_${sheets.length + 1}`, media_id: stored.media_id, query: q, engine: engine.name, recency: days ? recency : 'any',
                    count: drawn.used.length, width: drawn.width, height: drawn.height,
                    sources: drawn.used.slice(0, 60).map((r) => ({ url: r.url || null, page: r.source_page || null, title: oneLine(r.title, 160) || null })),
                    reading: null, patterns: [], palette: [], styles: [], outliers: [],
                };
                // The whole page read at once.
                if (llm && fetcher && typeof fetcher.loadImage === 'function' && !overBudget()) {
                    try {
                        const image = await fetcher.loadImage({ data_url: `data:image/jpeg;base64,${drawn.buffer.toString('base64')}`, max_width: 1600 });
                        const read = await llm.call({ routeKey: vision, ...require('./prompts').sheetPrompt({ question, query: q, engine: engine.name, recency: sheet.recency, count: sheet.count }), image, schema: require('./schema').SHEET_OUTPUT, schemaName: 'deep_dive_sheet', maxTokens: 1400, signal, ctx });
                        onCall(read);
                        const j = read.json || {};
                        sheet.reading = oneLine(j.reading, 1500) || null;
                        sheet.patterns = (j.patterns || []).slice(0, 8).map((x) => oneLine(x, 300)).filter(Boolean);
                        sheet.palette = (j.palette || []).slice(0, 8).map((x) => oneLine(x, 80)).filter(Boolean);
                        sheet.styles = (j.styles || []).slice(0, 8).map((x) => oneLine(x, 200)).filter(Boolean);
                        sheet.outliers = (j.outliers || []).slice(0, 6).map((x) => oneLine(x, 300)).filter(Boolean);
                    } catch (err) {
                        if (err && err.code === 'run.cancelled') throw err;
                        notes.push(`the reading of "${q}" (${engine.name}): ${oneLine(err && err.message, 140)}`);
                    }
                }
                sheets.push(sheet);
                if (onSheet) await onSheet(sheets);
            }
        }
        return { sheets, notes };
    }

    return { make, compose, enginesFor };
}

module.exports = { createSheets, RECENCY_DAYS, ENGINE_NAMES };
