'use strict';
module.exports = {
    id: 'openvibe',
    kinds: ['web'],
    async search(b, get) {
        const out = await get(
            'https://openvibe.search/api/v1/search?' +
                new URLSearchParams({ q: b.q, limit: String(b.limit) }),
        );
        return (out.results || []).map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.snippet || r.description || '',
            published: r.published_at || null,
        }));
    },
};
