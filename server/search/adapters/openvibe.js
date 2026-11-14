'use strict';
const { requestFor } = require('../transport');
// OpenVibe's own index (OpenVibe.Search's public search API). Until 11-12 this asked https://openvibe.search, a host
// that does not exist, and read `url`/`snippet` where Search answers `canonical_url`/`summary`: the engine never
// answered, and Exchange's search page said "This engine is unavailable" for every query.
const HOST = 'search.openvibe.network';
module.exports = {
    id: 'openvibe',
    price_per_1000: 0, byok: false, checked_on: '2026-11-12', source: `https://${HOST}`,
    freshness: [],
    hosts: [HOST],
    kinds: ['web'],
    class: 'first_party_index',
    async search(b, { fetchImpl }) {
        const get = requestFor(this.hosts, fetchImpl);
        const out = await get(
            `https://${HOST}/api/v1/search?` +
                new URLSearchParams({ q: b.q, limit: String(b.limit) }),
        );
        return (out.results || [])
            .map((r) => ({
                title: String(r.title || '').trim(),
                url: r.canonical_url || r.url || '',
                snippet: r.summary || r.snippet || r.description || '',
                published: r.published_at || null,
            }))
            .filter((r) => r.title && /^https:\/\//.test(r.url));
    },
};
