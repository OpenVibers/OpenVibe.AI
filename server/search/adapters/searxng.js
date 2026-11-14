'use strict';
const { requestFor } = require('../transport');
module.exports = {
    id: 'searxng',
    byok: false, source: 'https://docs.searxng.org/',
    freshness: ['day', 'month', 'year'],
    hosts: [],
    kinds: ['web'],
    class: 'metasearch',
    setting: 'EXCHANGE_SEARXNG_URL',
    async search(b, { fetchImpl, env }) {
        const base = env.EXCHANGE_SEARXNG_URL;
        const get = requestFor([new URL(base).hostname], fetchImpl);
        const url = new URL('/search', base);
        url.search = new URLSearchParams({
            q: b.q,
            format: 'json',
            safesearch: '1',
            ...(b.freshness ? { time_range: b.freshness } : {}),
        }).toString();
        const out = await get(url);
        return (out.results || []).map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.content || '',
            published: r.publishedDate || null,
        }));
    },
};
