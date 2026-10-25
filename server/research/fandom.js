'use strict';
/**
 * Fandom: the community wiki dedicated to a topic (a show, a game, a franchise), through its public MediaWiki API.
 * Finding it: the hosts web search returned, else the topic's name as a subdomain (kimpossible.fandom.com), checked
 * by asking the wiki its name, which must share a word with the topic. Text is CC BY-SA 3.0 (Fandom's licence); a page's
 * picture is the wiki's own and is marked as not freely licensed.
 */
const { articleText, clip, hostOf } = require('./text');

const qs = (params) => Object.entries({ format: 'json', formatversion: '2', ...params }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'wiki', 'fandom', 'tv', 'series', 'show', 'game', 'film', 'movie']);

function words(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));
}

/** Subdomains to try for a topic, most specific first. */
function slugsFor(topic) {
    const all = String(topic || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\([^)]*\)/g, ' ');
    const w = all.split(/[^a-z0-9]+/).filter(Boolean);
    const content = w.filter((x) => !STOP.has(x));
    const out = [w.join(''), content.join(''), content.slice(0, 2).join(''), content[0] && content[0].length >= 4 ? content[0] : ''];
    return [...new Set(out.filter((s) => /^[a-z0-9]{3,60}$/.test(s)))].slice(0, 4);
}

function createFandom({ http }) {
    async function probe(base, topic, signal) {
        const r = await http.request(`${base}/api.php?${qs({ action: 'query', meta: 'siteinfo', siprop: 'general' })}`, { signal, timeout: 8000 });
        const g = r.status === 200 && r.json && r.json.query && r.json.query.general;
        if (!g || !g.sitename) return null;
        const topicWords = new Set(words(topic));
        const overlap = words(g.sitename).some((x) => topicWords.has(x)) || words(new URL(base).hostname.split('.')[0]).some((x) => topicWords.has(x));
        return overlap ? { base, name: String(g.sitename), lang: g.lang || 'en' } : null;
    }

    /** The topic's wiki: { base, name } or null. hints are URLs a web search returned. */
    async function findWiki(topic, hints = [], { lang = 'en', signal } = {}) {
        const hosts = [];
        for (const u of hints) {
            const h = hostOf(u);
            const m = /^([a-z0-9-]{2,60})\.fandom\.com$/.exec(h);
            if (m && m[1] !== 'community' && m[1] !== 'www' && !hosts.includes(m[1])) hosts.push(m[1]);
        }
        const path = lang && lang !== 'en' ? `/${lang}` : '';
        for (const slug of [...hosts.slice(0, 2), ...slugsFor(topic)].filter((s, i, a) => a.indexOf(s) === i).slice(0, 5)) {
            try {
                const found = await probe(`https://${slug}.fandom.com${path}`, topic, signal);
                if (found) return found;
            } catch { /* try the next one */ }
        }
        return null;
    }

    async function search(base, query, { limit = 4, signal } = {}) {
        const j = await http.getJson(`${base}/api.php?${qs({ action: 'query', list: 'search', srsearch: query, srlimit: String(limit), srnamespace: '0' })}`, { signal });
        return ((j.query && j.query.search) || []).map((s) => s.title).filter((t) => !/\/(Gallery|Transcript|Quotes|LAM)$/i.test(t));
    }

    /** One article: readable text and its picture. */
    async function page(base, title, { chars = 6000, signal } = {}) {
        const [parsed, images] = await Promise.all([
            http.getJson(`${base}/api.php?${qs({ action: 'parse', page: title, prop: 'text|displaytitle', redirects: '1', disableeditsection: '1', disabletoc: '1', disablelimitreport: '1' })}`, { signal }),
            http.getJson(`${base}/api.php?${qs({ action: 'query', titles: title, prop: 'pageimages', piprop: 'original', redirects: '1' })}`, { signal }).catch(() => null),
        ]);
        const p = parsed && parsed.parse;
        if (!p || !p.text) return null;
        const name = p.title || title;
        const url = `${base}/wiki/${encodeURIComponent(name.replace(/ /g, '_'))}`;
        const text = clip(articleText(typeof p.text === 'string' ? p.text : p.text['*']), chars);
        const pg = images && images.query && images.query.pages && images.query.pages[0];
        const original = pg && pg.original;
        const image = original && original.source && original.width >= 160 ? {
            url: String(original.source).replace(/\/revision\/latest(\?|$)/, '/revision/latest/scale-to-width-down/1024$1'),
            original: original.source,
            width: Math.min(original.width, 1024),
            height: original.width > 1024 ? Math.round(original.height * 1024 / original.width) : original.height,
            mime: /\.png/i.test(original.source) ? 'image/png' : /\.webp/i.test(original.source) ? 'image/webp' : /\.gif/i.test(original.source) ? 'image/gif' : 'image/jpeg',
            title: name, description: null, author: null,
            license: 'Fandom wiki picture (copyright of its owners; used for identification)', license_url: null, free: false,
            source_url: url, provider: 'fandom',
        } : null;
        return text ? { title: name, url, text, image } : null;
    }

    return { findWiki, search, page };
}

module.exports = { createFandom, slugsFor };
