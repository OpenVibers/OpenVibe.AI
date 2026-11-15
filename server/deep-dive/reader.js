'use strict';
/**
 * Reading one page for the general deep dive (research.deep_dive): its text, the way a person reads it.
 *
 *   - public addresses over HTTPS only (an http link is read as https; publicTarget on the first URL and on every
 *     redirect, at most 4; the guarded fetch checks the address again at connect time);
 *   - robots.txt first (our own user agent, else *): a page it disallows is not read, and the report says so;
 *   - at most 1.5 MB of HTML or plain text, 15 s; a PDF, an image or anything else is "not a web page";
 *   - the text is the page's article or main part when it has one (else its body), without scripts, styles,
 *     navigation, headers, footers, forms and asides, its headings and paragraphs kept as lines, at most 14,000
 *     characters (cut at a paragraph);
 *   - the page's own title, description, site name and publication date (its meta tags, JSON-LD or <time>).
 *
 * Nothing on the page runs: it is text, never a browser. A page that cannot be read is { status: 'skipped', reason }.
 */
const { guardedFetch } = require('../providers/guarded-fetch');
const { publicTarget } = require('../search/transport');
const { createRobots } = require('../capture/robots');

const MAX_BYTES = 1_500_000;
const MAX_TEXT = 14_000;
const UA = 'OpenVibeDeepDive/1.0 (+https://openvibe.exchange/deep-dive)';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', laquo: '«', raquo: '»' };
function decode(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
        if (e[0] === '#') {
            const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
        }
        const v = ENTITIES[e.toLowerCase()];
        return v == null ? all : v;
    });
}
const oneLine = (s, n) => decode(String(s == null ? '' : s)).replace(/\s+/g, ' ').trim().slice(0, n);

function meta(html, names) {
    for (const n of names) {
        const re = new RegExp(`<meta[^>]+(?:name|property|itemprop)=["']${n}["'][^>]*>`, 'i');
        const tag = re.exec(html);
        if (tag) {
            const c = /content=["']([^"']*)["']/i.exec(tag[0]);
            if (c && c[1].trim()) return c[1];
        }
    }
    return null;
}

/** The published date, as YYYY-MM-DD, from the page's own words about itself. */
function publishedOf(html) {
    const m = meta(html, ['article:published_time', 'datePublished', 'pubdate', 'publishdate', 'date', 'dc.date', 'DC.date.issued', 'og:published_time']);
    const ld = /"datePublished"\s*:\s*"([^"]+)"/.exec(html);
    const time = /<time[^>]+datetime=["']([^"']+)["']/i.exec(html);
    for (const v of [m, ld && ld[1], time && time[1]]) {
        const t = Date.parse(String(v || ''));
        if (Number.isFinite(t) && t > Date.UTC(1990, 0, 1) && t < Date.now() + 86_400_000) return new Date(t).toISOString().slice(0, 10);
    }
    return null;
}

/** The readable text of an HTML page: its article or main part, as lines. */
function textOf(html) {
    let h = String(html)
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style|noscript|svg|template|iframe|canvas|object|select|button)\b[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<(nav|header|footer|aside|form|dialog|menu)\b[\s\S]*?<\/\1\s*>/gi, ' ');
    const pick = (tag) => {
        const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
        let best = '';
        for (let m = re.exec(h); m; m = re.exec(h)) if (m[1].length > best.length) best = m[1];
        return best;
    };
    const article = pick('article');
    const main = pick('main');
    const body = (/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(h) || [null, h])[1];
    const strip = (x) => x.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const len = (x) => strip(x).length;
    h = article && len(article) > 600 ? article : main && len(main) > 600 ? main : body;
    const lines = h
        .replace(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi, (a, t, inner) => `\n\n${'#'.repeat(Number(t[1]))} ${inner}\n\n`)
        .replace(/<li\b[^>]*>/gi, '\n- ')
        .replace(/<(br|hr)\b[^>]*>/gi, '\n')
        .replace(/<\/(p|div|section|li|tr|table|blockquote|pre|ul|ol|dd|dt|figure|figcaption)>/gi, '\n\n')
        .replace(/<(td|th)\b[^>]*>/gi, ' | ')
        .replace(/<[^>]+>/g, ' ');
    const out = decode(lines).split(/\n+/).map((l) => l.replace(/[ \t\f\v ]+/g, ' ').trim()).filter((l) => l && !/^[-|#\s]+$/.test(l));
    // Short repeated lines (cookie banners, share buttons) carry nothing.
    const counts = new Map();
    for (const l of out) counts.set(l, (counts.get(l) || 0) + 1);
    let text = out.filter((l) => !(l.length < 60 && counts.get(l) > 2)).join('\n');
    if (text.length > MAX_TEXT) {
        const cut = text.lastIndexOf('\n', MAX_TEXT);
        text = text.slice(0, cut > MAX_TEXT * 0.6 ? cut : MAX_TEXT);
    }
    return text;
}

function createReader({ fetchImpl = guardedFetch, robots = null, checkTarget = publicTarget, log = console, timeoutMs = 15_000 } = {}) {
    const rules = robots || createRobots({ fetchImpl, log });

    async function body(res) {
        if (!res.body || typeof res.body.getReader !== 'function') {
            const t = await res.text();
            return t.length > MAX_BYTES ? t.slice(0, MAX_BYTES) : t;
        }
        const rd = res.body.getReader();
        const chunks = [];
        let n = 0;
        for (;;) {
            const { done, value } = await rd.read();
            if (done) break;
            chunks.push(value);
            n += value.length;
            if (n >= MAX_BYTES) { try { await rd.cancel(); } catch { /* */ } break; }
        }
        return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    }

    /** → { status: 'read', url, final_url, title, description, site, published, text, words } or { status: 'skipped', url, reason } */
    async function read(url, { signal = null } = {}) {
        const skip = (reason) => ({ status: 'skipped', url, reason });
        const https = (u) => String(u || '').replace(/^http:\/\//i, 'https://');
        let target = https(url);
        if (!/^https:\/\//i.test(target)) return skip('not an http(s) page');
        const allowed = await rules.check(target).catch(() => ({ allowed: true }));
        if (!allowed.allowed) return skip(allowed.reason || 'robots.txt disallows this page');
        let res = null;
        const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        try {
            for (let hop = 0; hop < 5; hop++) {
                await checkTarget(target);
                res = await fetchImpl(target, { redirect: 'manual', signal: deadline, headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.8', 'accept-language': 'en;q=0.9,*;q=0.5', 'user-agent': UA } });
                if (res.status >= 300 && res.status < 400 && res.headers && typeof res.headers.get === 'function' && res.headers.get('location')) {
                    if (hop === 4) return skip('too many redirects');
                    target = https(new URL(res.headers.get('location'), target).href);
                    if (!/^https:/i.test(target)) return skip('a redirect away from the web');
                    continue;
                }
                break;
            }
        } catch (err) {
            if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'run.cancelled' });
            return skip(/timeout|abort/i.test(String(err && (err.name || err.message))) ? 'the page took too long' : 'the page could not be reached');
        }
        if (!res || !res.ok) return skip(`the page answered ${res ? res.status : 'nothing'}`);
        const type = String((res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || 'text/html').toLowerCase();
        if (!/text\/html|application\/xhtml|text\/plain/.test(type)) return skip(/pdf/.test(type) ? 'a PDF (not read as a web page)' : 'not a web page');
        let raw;
        try { raw = await body(res); } catch { return skip('the page stopped half way'); }
        const isText = /text\/plain/.test(type);
        const text = isText ? raw.replace(/\r\n?/g, '\n').slice(0, MAX_TEXT) : textOf(raw);
        const words = (text.match(/\S+/g) || []).length;
        if (words < 60) return skip('the page has almost no text (it may need a browser or a sign-in)');
        const title = isText ? null : oneLine((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw) || [])[1] || meta(raw, ['og:title']) || '', 300);
        return {
            status: 'read', url, final_url: target, title: title || null,
            description: isText ? null : (oneLine(meta(raw, ['description', 'og:description']) || '', 600) || null),
            site: isText ? null : (oneLine(meta(raw, ['og:site_name', 'application-name']) || '', 120) || null),
            published: isText ? null : publishedOf(raw), text, words,
        };
    }

    return { read };
}

module.exports = { createReader, textOf, publishedOf, decode };
