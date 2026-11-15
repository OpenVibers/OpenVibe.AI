'use strict';
const { requestFor, recencyOf } = require('../transport');

/** The operator's own loopback instance: plain http to 127.0.0.1, 10 s, JSON only. */
async function loopbackGet(url) {
    const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'OpenVibe.AI/1.0' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw Object.assign(new Error('Search engine unavailable'), { unbilled: true });
    return await r.json();
}
module.exports = {
    id: 'searxng',
    byok: false, source: 'https://docs.searxng.org/',
    freshness: ['day', 'month', 'year'],
    hosts: [],
    kinds: ['web', 'images'],
    // Images: the instance's time range for an 'after' date; safe search on.
    filters: { after: 'native', safe_search: 'native', size: 'local', orientation: 'local', format: 'local' },
    class: 'metasearch',
    setting: 'EXCHANGE_SEARXNG_URL',
    async search(b, { fetchImpl, env, kind = 'web' }) {
        const base = env.EXCHANGE_SEARXNG_URL;
        // An instance on this host's loopback (the operator's own, from config) is asked directly over http; any
        // other instance goes through the guarded HTTPS request every engine uses.
        const loop = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(String(base || ''));
        const get = loop ? loopbackGet : requestFor([new URL(base).hostname], fetchImpl);
        const url = new URL('/search', base);
        const images = kind === 'images' || b.kind === 'images';
        const range = images ? recencyOf(b.after) : b.freshness;
        url.search = new URLSearchParams({
            q: b.q,
            format: 'json',
            safesearch: '1',
            ...(images ? { categories: 'images' } : {}),
            ...(range ? { time_range: range } : {}),
        }).toString();
        const out = await get(url);
        if (images) {
            return (out.results || []).filter((r) => r && (r.img_src || r.thumbnail_src)).slice(0, Math.max(1, b.limit || 40)).map((r, i) => ({
                title: String(r.title || ''), url: r.img_src || null, snippet: '', published: r.publishedDate || null,
                thumbnail: r.thumbnail_src || r.img_src || null, width: null, height: null, source_page: r.url || null,
                license: null, license_url: null, author: null, attribution: null, upstream: Array.isArray(r.engines) && r.engines[0] ? String(r.engines[0]) : 'searxng', upstream_rank: i + 1,
            }));
        }
        return (out.results || []).map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.content || '',
            published: r.publishedDate || null,
        }));
    },
};
