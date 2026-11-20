'use strict';
/**
 * Merging the answers of several engines and several queries into one list (Exchange search v2, plan §W.7, the owner
 * 11-20: "multi-search … it should deduplicate … more powerful, but also minimalist").
 *
 *   canonicalUrl(url)          one key per page: https, the host without www./m./amp., no tracking parameters, no
 *                              fragment, sorted parameters, no trailing slash or /amp
 *   siteOf(url)                the registrable domain (example.co.uk), for the per-site cap
 *   similar(a, b)              how alike two results' words are (0..1): the same story syndicated on two sites
 *   fuse(lists, opts)          Reciprocal Rank Fusion over every list (score = Σ 1 / (k + rank), k = 60), the same page
 *                              merged into one result that names every engine and query that found it, near-duplicates
 *                              folded, at most `perSite` results of one site before any site's next, and a gentle
 *                              boost for a result more than one engine agreed on
 *
 * RRF ranks by position alone, so engines whose scores mean different things (a neural engine, an index, a metasearch)
 * are combined without normalising scores that cannot be compared.
 */

// Parameters that say who sent the visitor, never what the page is.
const TRACKING = /^(utm_[a-z_]+|fbclid|gclid|gclsrc|dclid|msclkid|yclid|mc_cid|mc_eid|_ga|_gl|igshid|si|spm|ref|ref_src|ref_url|referrer|src|s_kwcid|cmpid|campaign|cid|trk|trkCampaign|mkt_tok|oly_anon_id|oly_enc_id|vero_id|_hsenc|_hsmi|hsCtaTracking|wt_mc|ncid|ocid|ito|feature)$/i;
// Two-part public suffixes common enough to matter for the per-site cap (example.co.uk is one site, not co.uk).
const SECOND_LEVEL = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'com.br', 'com.cn', 'com.mx', 'com.tr', 'co.in', 'co.za', 'com.sg', 'com.hk', 'com.tw', 'github.io', 'gitlab.io', 'pages.dev', 'vercel.app', 'netlify.app', 'herokuapp.com', 'blogspot.com', 'substack.com', 'medium.com', 'wordpress.com']);

// A public web host: dotted, ending in a real top-level domain. "http://go/v1/…" (an engine's internal redirect, seen
// on 11-20), localhost and bare addresses are not pages anyone can open.
const PUBLIC_HOST = /^(?=.{4,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

function canonicalUrl(raw) {
    let u;
    try { u = new URL(String(raw)); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    let host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!PUBLIC_HOST.test(host) || u.username || u.password) return null;
    host = host.replace(/^(www\d*|m|mobile|amp)\./, '');
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    let path = u.pathname.replace(/\/{2,}/g, '/');
    path = path.replace(/\/(amp|index\.html?|index\.php)$/i, '/').replace(/\.amp$/i, '');
    if (path.length > 1) path = path.replace(/\/+$/, '');
    try { path = decodeURI(path); } catch { /* keep it encoded */ }
    const query = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
    return `${host}${path === '/' ? '' : path}${query}`.toLowerCase();
}

function hostOf(raw) {
    try { return new URL(String(raw)).hostname.toLowerCase().replace(/^(www\d*|m|mobile|amp)\./, ''); } catch { return ''; }
}

function siteOf(raw) {
    let host;
    try { host = new URL(String(raw)).hostname.toLowerCase().replace(/^(www\d*|m|mobile|amp)\./, ''); } catch { return ''; }
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const two = parts.slice(-2).join('.');
    return SECOND_LEVEL.has(two) ? parts.slice(-3).join('.') : two;
}

const WORD = /[\p{L}\p{N}]+/gu;
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'with', 'by', 'at', 'from', 'as', 'it', 'its', 'this', 'that', 'be', 'de', 'la', 'le', 'el', 'und', 'der', 'die']);
function words(text) {
    return new Set((String(text || '').toLowerCase().match(WORD) || []).filter((w) => w.length > 1 && !STOP.has(w)));
}
/** Jaccard similarity of two results' title and snippet words. */
function similar(a, b) {
    const x = words(`${a.title} ${a.snippet}`), y = words(`${b.title} ${b.snippet}`);
    if (x.size < 6 || y.size < 6) return 0;
    let both = 0;
    for (const w of x) if (y.has(w)) both++;
    return both / (x.size + y.size - both);
}

/**
 * lists: [{ engine, query, results: [{ title, url, snippet, published, … }] }] in each list's own order.
 * → { results: [...merged, best first], duplicates: n folded away, total: n before folding }
 */
function fuse(lists, { k = 60, limit = 10, perSite = 2, nearDuplicate = 0.8, agreementBoost = 0.15 } = {}) {
    const byKey = new Map();
    let total = 0;
    for (const list of lists) {
        const rows = Array.isArray(list.results) ? list.results : [];
        rows.forEach((r, i) => {
            const key = canonicalUrl(r.url);
            if (!key) return;
            total++;
            const rank = i + 1;
            const hit = byKey.get(key);
            if (!hit) {
                byKey.set(key, { ...r, key, site: siteOf(r.url), engines: [list.engine], queries: [list.query], score: 1 / (k + rank), best: rank });
                return;
            }
            hit.score += 1 / (k + rank);
            if (!hit.engines.includes(list.engine)) hit.engines.push(list.engine);
            if (!hit.queries.includes(list.query)) hit.queries.push(list.query);
            // The better-placed hit names the result; the longer snippet and a known date are kept from either.
            if (rank < hit.best) { hit.best = rank; hit.title = r.title || hit.title; }
            if (String(r.snippet || '').length > String(hit.snippet || '').length) hit.snippet = r.snippet;
            if (!hit.published && r.published) hit.published = r.published;
        });
    }
    // Agreement: a page more than one engine found is likelier to be what was asked for.
    for (const r of byKey.values()) if (r.engines.length > 1) r.score *= 1 + agreementBoost * (r.engines.length - 1);
    const sorted = [...byKey.values()].sort((a, b) => b.score - a.score || a.best - b.best);
    // Near-duplicates: the same story under two addresses (syndication, mirrors) is folded into the better one.
    const kept = [];
    let folded = 0;
    for (const r of sorted) {
        // A mirror is another site's whole host inside this one (louvre.fr.a.global.clara.net, a CDN copy of
        // louvre.fr, 11-20): it folds into that site's page with the same path, or the site's best page.
        const host = hostOf(r.url);
        const mirrorOf = kept.find((x) => { const h = hostOf(x.url); return h && host !== h && host.startsWith(`${h}.`); });
        const twin = mirrorOf || kept.find((x) => x.title && r.title && similar(x, r) >= nearDuplicate);
        if (twin) {
            folded++;
            twin.score += r.score * 0.5;
            for (const e of r.engines) if (!twin.engines.includes(e)) twin.engines.push(e);
            (twin.also = twin.also || []).push(r.url);
            continue;
        }
        kept.push(r);
    }
    kept.sort((a, b) => b.score - a.score || a.best - b.best);
    // At most perSite results of one site among the first ones; the rest follow, in their order.
    const first = [], later = [], seen = new Map();
    for (const r of kept) {
        const n = seen.get(r.site) || 0;
        if (n < perSite) { first.push(r); seen.set(r.site, n + 1); } else later.push(r);
    }
    const out = [...first, ...later].slice(0, limit).map(({ key, best, site, score, ...r }) => ({ ...r, score: Math.round(score * 1e5) / 1e5 }));
    return { results: out, duplicates: total - byKey.size + folded, total };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#8217': '’', '#8216': '‘', '#8220': '“', '#8221': '”', '#8211': '–', '#8212': '—', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
const decode = (t) => String(t || '').replace(/&(#?[a-z0-9]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] || (/^#\d+$/.test(e) ? String.fromCodePoint(Number(e.slice(1))) : m));
// A sentence, not page chrome: enough words, most of them lower-case prose, not a run of menu labels.
function prose(s) {
    const w = s.split(/\s+/).filter(Boolean);
    if (w.length < 6) return false;
    const capped = w.filter((x) => /^[\p{Lu}]/u.test(x)).length / w.length;
    return capped < 0.6 && /[.!?:;)]$|[,;]/.test(s.trim());
}
/**
 * The passage of a page that answers the query best (11-20: a whole navigation blob was returned once): the page is cut
 * into sentences, menus and other chrome left out, and the best window of up to three sentences is scored by the
 * query's words. Up to `max` characters; entities decoded.
 */
function excerpt(text, query, { max = 600 } = {}) {
    const q = words(query);
    if (!q.size) return '';
    const sentences = decode(text).replace(/\r/g, '').split(/\n+|(?<=[.!?])\s+(?=[\p{Lu}\d“"(])/u)
        .map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x.length >= 25 && x.length <= 900 && prose(x));
    let best = null;
    for (let i = 0; i < sentences.length; i++) {
        for (let n = 1; n <= 3 && i + n <= sentences.length; n++) {
            const p = sentences.slice(i, i + n).join(' ');
            if (p.length > max * 1.4) break;
            const w = words(p);
            let hit = 0;
            for (const x of q) if (w.has(x)) hit++;
            const score = hit / q.size - (n - 1) * 0.04 + Math.min(0.1, p.length / 6000);
            if (!best || score > best.score) best = { p, score };
        }
    }
    if (!best || best.score < 0.3) return '';
    return best.p.length > max ? `${best.p.slice(0, max).replace(/\s+\S*$/, '')}…` : best.p;
}

/**
 * Does a result talk about the question at all? At least two of the question's words (or two in five, for a long one)
 * in its title, snippet or passage. One shared word is not enough: a search for a tile museum's hours matched a dress
 * and a Bluetooth tracker named "Tile" (11-20). Questions of one or two words are not judged.
 */
function onTopic(r, query) {
    const q = words(query);
    if (q.size < 3) return true;
    const w = words(`${r.title} ${r.snippet} ${r.excerpt || ''} ${r.url}`);
    let hit = 0;
    for (const x of q) if (w.has(x)) hit++;
    return hit >= Math.min(q.size, Math.max(2, Math.ceil(q.size * 0.4)));
}

module.exports = { canonicalUrl, siteOf, similar, fuse, excerpt, onTopic, decode, words, TRACKING };
