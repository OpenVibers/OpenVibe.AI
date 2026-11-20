'use strict';
const { requestFor, query, web } = require('../transport');
// Wikipedia's own search over the English Wikipedia (11-20): a free, reliable index of facts beside the web engines.
// A SimpleQA check on production found the right answer missing from the sources a quarter of the time, and shared
// search had two web engines (DeepSeek and a SearXNG whose upstream engines refuse a server); Wikipedia is the third.
// The MediaWiki API asks for a descriptive User-Agent (API:Etiquette); the content is CC BY-SA 4.0, attribution by link.
const strip = (html) => String(html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const pageUrl = (title) => `https://en.wikipedia.org/wiki/${encodeURIComponent(String(title).replace(/ /g, '_')).replace(/%2F/g, '/').replace(/%3A/g, ':')}`;
module.exports = {
    id: 'wikipedia', byok: false,
    kinds: ['web'], hosts: ['en.wikipedia.org'],
    // Its own index of its own articles: an independent index, ranked by search v2 after the web engines (multi.js).
    class: 'independent_index',
    source: 'https://www.mediawiki.org/wiki/API:Search',
    pricing_note: 'Free: Wikimedia\'s public API, within its etiquette (one request at a time per search, a named User-Agent).',
    freshness: [],
    filters: {},
    async search(b, { fetchImpl }) {
        const out = await requestFor(this.hosts, fetchImpl)(query('https://en.wikipedia.org/w/api.php', {
            action: 'query', list: 'search', srsearch: String(b.q).slice(0, 300), srlimit: Math.max(1, Math.min(b.limit || 10, 10)),
            srprop: 'snippet', format: 'json', formatversion: '2', utf8: '1',
        }), { headers: { 'user-agent': 'OpenVibeSearch/1.0 (https://openvibe.exchange/search; search v2 reference engine)' } });
        const rows = (out.query && Array.isArray(out.query.search)) ? out.query.search : [];
        return rows.filter((r) => r && r.title).map((r) => web({ title: `${r.title} - Wikipedia`, url: pageUrl(r.title) }, strip(r.snippet), null));
    },
};
