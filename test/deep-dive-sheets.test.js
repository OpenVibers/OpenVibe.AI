'use strict';
// Image search a page at a time (server/deep-dive/sheets.js; the owner, 11-15: "screenshot search queries on Google,
// Bing, etc to analyze a whole page of images at once … filter for recent results … fully configurable"):
//   - a dated sheet asks each engine that can filter by date, with the date; one that cannot is left out, and said;
//   - the results are laid out as one sheet in the engine's order (a real JPEG grid), kept as a private Media object of
//     the run's owner, with its sources; too few images or none drawable is a note, never a stop;
//   - "any time" asks every engine; no engine at all is a note;
//   - the adapters: Google Images (SerpAPI, Serper) take Google's own time range (tbs=qdr:w), SearchAPI its
//     time_period, and SearXNG answers images with the instance's time range.
const assert = require('assert');
const sharp = require('sharp');
const { createSheets } = require('../server/deep-dive/sheets');

(async () => {
    const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 200, g: 60, b: 90 } } }).png().toBuffer();
    const fetchImpl = async (url) => ({ ok: !/broken/.test(url), status: 200, arrayBuffer: async () => png });
    const asked = [];
    const results = (n, tag) => Array.from({ length: n }, (_, i) => ({ title: `${tag} ${i}`, url: `https://img.example/${tag}/${i}.png`, thumbnail: `https://img.example/${tag}/t${i}.png`, source_page: `https://site.example/${tag}/${i}` }));
    const search = {
        async engines() {
            return [
                { id: 'serper-images', kinds: ['images'], available: true, filters: { after: 'native' } },
                { id: 'openverse', kinds: ['images'], available: true, filters: { after: 'unsupported' } },
                { id: 'serpapi-images', kinds: ['images'], available: false, byok: true, filters: { after: 'native' } },
                { id: 'brave', kinds: ['web'], available: true, filters: {} },
            ];
        },
        async search(kind, body, ctx) {
            asked.push({ kind, ...body, subject: ctx.subject });
            if (body.engine === 'serpapi-images') throw new Error('no key for SerpAPI');
            return { results: results(body.q === 'few' ? 2 : 12, body.engine) };
        },
    };
    const kept = [];
    const mediaStore = { async put(o) { kept.push(o); return { media_id: `med_01JAB2C3D4E5F6G7H8J9K0MN${String(kept.length).padStart(2, '0')}`, width: 10, height: 10 }; } };
    const s = createSheets({ search, mediaStore, llm: null, fetchImpl, checkTarget: async () => {}, now: () => Date.UTC(2026, 10, 15) });

    // Past week: only the engine that can filter by date, with the date; the other is left out and said.
    let out = await s.make({ queries: ['robot control panel ui'], recency: 'week', perSheet: 12, maxSheets: 4, owner: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', runId: 'run_x' });
    assert.deepStrictEqual(asked.map((a) => [a.engine, a.after, a.subject]), [['serper-images', '2026-11-08', 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ']]);
    assert.ok(out.notes.some((n) => /Openverse cannot filter by date/.test(n)), JSON.stringify(out.notes));
    assert.strictEqual(out.sheets.length, 1);
    const sheet = out.sheets[0];
    assert.deepStrictEqual([sheet.query, sheet.engine, sheet.recency, sheet.count, sheet.sources.length, sheet.sources[0].page], ['robot control panel ui', 'Google Images (Serper)', 'week', 12, 12, 'https://site.example/serper-images/0']);
    const meta = await sharp(kept[0].bytes).metadata();
    assert.deepStrictEqual([meta.format, meta.width, meta.height], ['jpeg', 8 * 200 + 9 * 6, 2 * 200 + 3 * 6], 'one sheet: 12 thumbnails, 8 a row');
    assert.deepStrictEqual([kept[0].visibility, kept[0].owner, kept[0].metadata.engine], ['private', 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', 'serper-images'], 'a private object of the owner');

    // Any time: every engine OpenVibe runs; too few images is a note.
    asked.length = 0;
    out = await s.make({ queries: ['robot panel', 'few'], recency: 'any', perSheet: 12, maxSheets: 8 });
    assert.deepStrictEqual(asked.map((a) => [a.q, a.engine, a.after || null]), [['robot panel', 'serper-images', null], ['robot panel', 'openverse', null], ['few', 'serper-images', null], ['few', 'openverse', null]]);
    assert.strictEqual(out.sheets.length, 2);
    assert.ok(out.notes.some((n) => /too few images for "few"/.test(n)));

    // A person's own choice may name an engine needing their key: asked, and a missing key is a note.
    asked.length = 0;
    out = await s.make({ queries: ['robot panel'], engines: ['serpapi-images'], recency: 'month', perSheet: 12 });
    assert.deepStrictEqual(asked.map((a) => a.engine), ['serpapi-images']);
    assert.ok(out.notes.some((n) => /no key for SerpAPI/.test(n)) && out.sheets.length === 0);

    // No engine that dates: said, nothing made.
    out = await s.make({ queries: ['x'], engines: ['openverse'], recency: 'day' });
    assert.ok(out.notes.some((n) => /No image engine here can filter by date/.test(n)) && out.sheets.length === 0);

    // ── The adapters' time ranges ──
    const seen = [];
    const cap = (body) => async (url, init) => { seen.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null }); return { ok: true, status: 200, json: async () => body }; };
    const week = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    await require('../server/search/adapters/serpapi-images').search.call(require('../server/search/adapters/serpapi-images'), { q: 'ui', limit: 10, after: week }, { fetchImpl: cap({ images_results: [] }), key: 'k' });
    assert.match(seen.pop().url, /tbs=qdr%3Aw/, 'SerpAPI: Google\'s past week');
    await require('../server/search/adapters/serper-images').search.call(require('../server/search/adapters/serper-images'), { q: 'ui', limit: 10, after: week }, { fetchImpl: cap({ images: [] }), key: 'k' });
    assert.strictEqual(seen.pop().body.tbs, 'qdr:w', 'Serper: the same');
    const sa = require('../server/search/adapters/searchapi-images');
    await sa.search.call(sa, { q: 'ui', limit: 10, after: week }, { fetchImpl: cap({ images_results: [] }), key: 'k' });
    assert.match(seen.pop().url, /time_period=last_week/, 'SearchAPI: its time period');
    const sx = require('../server/search/adapters/searxng');
    assert.ok(sx.kinds.includes('images') && sx.filters.after === 'native');
    const rows = await sx.search({ q: 'ui', limit: 5, after: week }, { fetchImpl: cap({ results: [{ title: 'A', url: 'https://page.example/a', img_src: 'https://img.example/a.png', thumbnail_src: 'https://img.example/ta.png', engines: ['google images'] }, { title: 'no image', url: 'https://x.example' }] }), env: { EXCHANGE_SEARXNG_URL: 'https://searx.example' }, kind: 'images' });
    const q = seen.pop().url;
    assert.ok(/categories=images/.test(q) && /time_range=week/.test(q), q);
    assert.deepStrictEqual(rows.map((r) => [r.url, r.thumbnail, r.source_page, r.upstream]), [['https://img.example/a.png', 'https://img.example/ta.png', 'https://page.example/a', 'google images']]);
    // Every tile is numbered (11-16), and the model is told to cite outliers by number: "#14: …".
    const prompt = require('../server/deep-dive/prompts').sheetPrompt({ question: 'A robot app', query: 'robot app', engine: 'SearXNG', recency: 'month', count: 38 });
    assert.match(prompt.user, /Each image has its number \(1 to 38\) in its top-left corner/);
    assert.match(prompt.user, /each starting with its number, e\.g\. "#14:/);
    process.stdout.write('deep dive sheets: dated engines only (with the date), one JPEG grid per engine page, numbered, private to the owner, notes not stops, the person\'s own engines; Google/Serper/SearchAPI/SearXNG time ranges\n');
})().catch((err) => { console.error(err); process.exit(1); });
