'use strict';
module.exports = {
    id: 'searxng',
    kinds: ['web'],
    setting: 'EXCHANGE_SEARXNG_URL',
    async search(b, get, base) {
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
