'use strict';
const { requestFor } = require('../transport');
module.exports = {
    id: 'openvibe',
    price_per_1000: 0, byok: false, checked_on: '2026-11-09', source: 'https://openvibe.search',
    freshness: [],
    hosts: ['openvibe.search'],
    kinds: ['web'],
    async search(b, { fetchImpl }) {
        const get = requestFor(this.hosts, fetchImpl);
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
