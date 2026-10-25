'use strict';
/**
 * Wikipedia, Wikimedia Commons and Wikidata, through their public APIs (no key; a descriptive User-Agent).
 *
 *   searchWikipedia   article titles for a query
 *   articles          intro, lead image, Wikidata id and description for several titles at once, and the full plain
 *                     text of the first few
 *   articleImages     the pictures an article uses, each with its licence (free files from Commons and an article's
 *                     own non-free ones, marked so)
 *   commonsSearch     freely licensed pictures on Commons for a query
 *   commonsFiles      licence and size for named files (a Wikidata item's image)
 *   wikidataFacts     a Wikidata item's key statements as labelled facts
 *
 * Text is CC BY-SA (Wikipedia) or CC0 (Wikidata); every picture carries its own licence from the file's metadata.
 */
const { stripTags, extractText, clip, isFreeLicense } = require('./text');

const API = (lang) => `https://${lang}.wikipedia.org/w/api.php`;
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const WIKIDATA = 'https://www.wikidata.org/w/api.php';
const IMAGE_MIME = /^image\/(jpeg|png|webp|gif)$/;
// Interface pictures an article carries that are not about its subject.
const NOT_SUBJECT = /(^|[\s_-])(icon|symbol|flag of|logo of wikipedia|commons-logo|wiki letter|question book|edit-clear|ambox|padlock|crystal|nuvola|disambig|portal|stub|blank|placeholder)([\s_.-]|$)/i;
const META = 'LicenseShortName|LicenseUrl|Artist|ImageDescription|NonFree|UsageTerms|ObjectName';

/** Wikimedia adds ?utm_source=… to file URLs; the picture is the same without it. */
const untracked = (u) => String(u || '').replace(/\?utm_[^#]*$/, '');

const qs = (params) => Object.entries({ format: 'json', formatversion: '2', ...params }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

/** A file page with imageinfo (iiprop url|size|mime|extmetadata) → a research image, or null when unusable. */
function imageFrom(page, provider, fallbackSource, { allowSvg = false } = {}) {
    const ii = page && Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
    if (!ii) return null;
    // A drawing (SVG) only as its PNG rendering, and only when asked for (an article's lead picture, usually a logo).
    const svg = ii.mime === 'image/svg+xml' && allowSvg && /\.png(\?|$)/i.test(ii.thumburl || '');
    if (!svg && !IMAGE_MIME.test(ii.mime || '')) return null;
    const width = ii.width || 0;
    const height = ii.height || 0;
    if ((!svg && (width < 200 || height < 150)) || NOT_SUBJECT.test(page.title || '')) return null;
    const m = ii.extmetadata || {};
    const v = (k) => (m[k] && m[k].value != null ? String(m[k].value) : '');
    const license = stripTags(v('LicenseShortName')) || stripTags(v('UsageTerms')) || null;
    const nonFree = /^(true|1)$/i.test(v('NonFree').trim()) || /fair use|non-?free/i.test(license || '');
    return {
        url: untracked(ii.thumburl || ii.url),
        original: untracked(ii.url),
        width: ii.thumbwidth || width,
        height: ii.thumbheight || height,
        mime: svg ? 'image/png' : ii.mime,
        title: stripTags(v('ObjectName')) || String(page.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' '),
        description: clip(stripTags(v('ImageDescription')), 300) || null,
        author: clip(stripTags(v('Artist')), 160) || null,
        license: nonFree ? (license || 'Non-free (used for identification)') : license,
        license_url: v('LicenseUrl') || null,
        free: !nonFree && isFreeLicense(license),
        source_url: ii.descriptionurl || fallbackSource || null,
        provider,
    };
}

// The statements worth an infobox, in the order shown.
const PROPS = [
    ['P31', 'Instance of'], ['P1476', 'Title'], ['P170', 'Created by'], ['P50', 'Author'], ['P57', 'Directed by'], ['P162', 'Produced by'],
    ['P86', 'Music by'], ['P175', 'Performer'], ['P161', 'Cast member'], ['P725', 'Voice actor'], ['P449', 'Original network'], ['P272', 'Production company'],
    ['P750', 'Distributed by'], ['P123', 'Publisher'], ['P178', 'Developer'], ['P400', 'Platform'], ['P136', 'Genre'], ['P495', 'Country of origin'],
    ['P364', 'Original language'], ['P571', 'Founded / created'], ['P577', 'Publication date'], ['P580', 'Start'], ['P582', 'End'], ['P1113', 'Episodes'],
    ['P2437', 'Seasons'], ['P569', 'Born'], ['P19', 'Place of birth'], ['P570', 'Died'], ['P27', 'Citizenship'], ['P106', 'Occupation'],
    ['P112', 'Founded by'], ['P159', 'Headquarters'], ['P452', 'Industry'], ['P17', 'Country'], ['P131', 'Located in'], ['P36', 'Capital'],
    ['P1082', 'Population'], ['P2046', 'Area'], ['P856', 'Official website'],
];

function timeText(v) {
    const m = /^([+-])(\d{1,16})-(\d\d)-(\d\d)/.exec(String(v.time || ''));
    if (!m) return null;
    const year = `${m[1] === '-' ? '-' : ''}${Number(m[2])}`;
    if (v.precision >= 11 && m[3] !== '00' && m[4] !== '00') return `${year}-${m[3]}-${m[4]}`;
    if (v.precision === 10 && m[3] !== '00') return `${year}-${m[3]}`;
    return year;
}

function createWikimedia({ http }) {
    async function searchWikipedia(query, { lang = 'en', limit = 5, signal } = {}) {
        const j = await http.getJson(`${API(lang)}?${qs({ action: 'query', list: 'search', srsearch: query, srlimit: String(limit), srprop: 'snippet', srenablerewrites: '1', maxlag: '5' })}`, { signal });
        return ((j.query && j.query.search) || []).map((s) => ({ title: s.title, snippet: stripTags(s.snippet) }));
    }

    async function fullText(title, { lang, signal }) {
        const j = await http.getJson(`${API(lang)}?${qs({ action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'wiki', redirects: '1', titles: title, maxlag: '5' })}`, { signal });
        const p = j.query && j.query.pages && j.query.pages[0];
        return p && p.extract ? extractText(p.extract) : '';
    }

    /** Several articles in one call (intro, lead image, Wikidata id), with the full text of the first `full`. */
    async function articles(titles, { lang = 'en', full = 3, chars = 6000, signal } = {}) {
        if (!titles.length) return [];
        const j = await http.getJson(`${API(lang)}?${qs({
            action: 'query', prop: 'extracts|pageimages|pageprops|info|description', exintro: '1', explaintext: '1', exlimit: 'max',
            piprop: 'original|thumbnail', pithumbsize: '1280', ppprop: 'wikibase_item|disambiguation', inprop: 'url', redirects: '1',
            titles: titles.slice(0, 20).join('|'), maxlag: '5',
        })}`, { signal });
        const query = j.query || {};
        const rename = new Map();
        for (const r of [...(query.normalized || []), ...(query.redirects || [])]) rename.set(r.from, r.to);
        const byTitle = new Map((query.pages || []).filter((p) => !p.missing).map((p) => [p.title, p]));
        const ordered = [];
        const seen = new Set();
        for (const t of titles) {
            let name = t;
            for (let i = 0; i < 3 && rename.has(name); i++) name = rename.get(name);
            const p = byTitle.get(name);
            if (p && !seen.has(p.title)) { seen.add(p.title); ordered.push(p); }
        }
        const out = ordered.map((p) => ({
            title: p.title,
            url: p.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
            description: p.description || null,
            text: p.extract || '',
            lead: p.original ? { url: (p.thumbnail && p.thumbnail.source) || p.original.source, original: p.original.source, width: (p.thumbnail && p.thumbnail.width) || p.original.width, height: (p.thumbnail && p.thumbnail.height) || p.original.height } : null,
            qid: (p.pageprops && p.pageprops.wikibase_item) || null,
            disambiguation: Boolean(p.pageprops && p.pageprops.disambiguation !== undefined),
            revisedAt: p.touched || null,
        }));
        const fulls = out.filter((a) => !a.disambiguation).slice(0, full);
        await Promise.all(fulls.map(async (a) => {
            try { const t = await fullText(a.title, { lang, signal }); if (t) a.text = t; } catch { /* the intro stays */ }
        }));
        for (const a of out) a.text = clip(a.text, chars);
        return out;
    }

    function imageQuery(extra) {
        return { prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1280', iiextmetadatafilter: META, iiextmetadatalanguage: 'en', maxlag: '5', ...extra };
    }

    async function articleImages(title, { lang = 'en', limit = 12, signal } = {}) {
        const j = await http.getJson(`${API(lang)}?${qs({ action: 'query', generator: 'images', titles: title, gimlimit: '40', redirects: '1', ...imageQuery() })}`, { signal });
        const source = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
        return ((j.query && j.query.pages) || []).map((p) => imageFrom(p, 'wikipedia', source)).filter(Boolean).slice(0, limit);
    }

    async function commonsSearch(query, { limit = 10, signal } = {}) {
        const j = await http.getJson(`${COMMONS}?${qs({ action: 'query', generator: 'search', gsrsearch: `${query} filetype:bitmap`, gsrnamespace: '6', gsrlimit: String(limit), ...imageQuery() })}`, { signal });
        const pages = ((j.query && j.query.pages) || []).sort((a, b) => (a.index || 0) - (b.index || 0));
        return pages.map((p) => imageFrom(p, 'commons')).filter((i) => i && i.free);
    }

    /** Licence and size for files by name on a Wikipedia (its own files and Commons files alike). */
    async function fileInfo(names, { lang = 'en', allowSvg = false, provider = 'wikipedia', signal } = {}) {
        if (!names.length) return [];
        const titles = names.slice(0, 20).map((n) => (/^File:/i.test(n) ? n : `File:${n}`)).join('|');
        const j = await http.getJson(`${API(lang)}?${qs({ action: 'query', titles, ...imageQuery() })}`, { signal });
        return ((j.query && j.query.pages) || []).map((p) => imageFrom(p, provider, null, { allowSvg })).filter(Boolean);
    }

    async function commonsFiles(names, { signal } = {}) {
        if (!names.length) return [];
        const titles = names.slice(0, 20).map((n) => (/^File:/i.test(n) ? n : `File:${n}`)).join('|');
        const j = await http.getJson(`${COMMONS}?${qs({ action: 'query', titles, ...imageQuery() })}`, { signal });
        return ((j.query && j.query.pages) || []).map((p) => imageFrom(p, 'wikidata')).filter(Boolean);
    }

    /** Labelled facts from a Wikidata item, plus its image file name (P18) when it has one. */
    async function wikidataFacts(qid, { lang = 'en', signal } = {}) {
        if (!/^Q\d{1,12}$/.test(qid || '')) return null;
        const j = await http.getJson(`${WIKIDATA}?action=wbgetentities&ids=${qid}&props=claims%7Clabels%7Cdescriptions&languages=${lang}%7Cen&format=json`, { signal });
        const e = j.entities && j.entities[qid];
        if (!e || !e.claims) return null;
        const pending = [];
        for (const [pid, label] of PROPS) {
            const claims = (e.claims[pid] || []).filter((c) => c.rank !== 'deprecated' && c.mainsnak && c.mainsnak.datavalue).slice(0, 8);
            if (!claims.length) continue;
            pending.push({ pid, label, values: claims.map((c) => c.mainsnak.datavalue) });
        }
        const ids = new Set();
        for (const f of pending) for (const dv of f.values) if (dv.type === 'wikibase-entityid' && dv.value && dv.value.id) ids.add(dv.value.id);
        const labels = new Map();
        const list = [...ids].slice(0, 50);
        if (list.length) {
            const lj = await http.getJson(`${WIKIDATA}?action=wbgetentities&ids=${list.join('%7C')}&props=labels&languages=${lang}%7Cen&format=json`, { signal });
            for (const [id, ent] of Object.entries(lj.entities || {})) {
                const l = ent.labels && (ent.labels[lang] || ent.labels.en);
                if (l) labels.set(id, l.value);
            }
        }
        const facts = [];
        for (const f of pending) {
            const vals = f.values.map((dv) => {
                switch (dv.type) {
                case 'wikibase-entityid': return labels.get(dv.value.id) || null;
                case 'time': return timeText(dv.value);
                case 'quantity': { const n = Number(dv.value.amount); return Number.isFinite(n) ? n.toLocaleString('en-US') : null; }
                case 'monolingualtext': return dv.value.text || null;
                case 'string': return typeof dv.value === 'string' ? dv.value : null;
                default: return null;
                }
            }).filter(Boolean);
            if (vals.length) facts.push({ label: f.label, value: [...new Set(vals)].join(', ').slice(0, 400) });
        }
        const image = e.claims.P18 && e.claims.P18[0] && e.claims.P18[0].mainsnak.datavalue ? String(e.claims.P18[0].mainsnak.datavalue.value) : null;
        const name = (e.labels && (e.labels[lang] || e.labels.en) || {}).value || qid;
        const description = (e.descriptions && (e.descriptions[lang] || e.descriptions.en) || {}).value || null;
        return { qid, name, description, url: `https://www.wikidata.org/wiki/${qid}`, facts: facts.slice(0, 30), image };
    }

    return { searchWikipedia, articles, articleImages, fileInfo, commonsSearch, commonsFiles, wikidataFacts };
}

module.exports = { createWikimedia, imageFrom, timeText, untracked };
