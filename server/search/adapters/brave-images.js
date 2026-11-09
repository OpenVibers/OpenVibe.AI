'use strict';
const { requestFor, query } = require('../transport');
module.exports = {
    id: 'brave-images', byok: true, checked_on: '2026-11-09',
    kinds: ['images'], key_env: 'SEARCH_BRAVE_IMAGES_KEY', credential_id: 'brave', hosts: ['api.search.brave.com'],
    price_per_1000: 5, source: 'https://api-dashboard.search.brave.com/app/plans', freshness: [],
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)(query('https://api.search.brave.com/res/v1/images/search', { q: b.q, count: b.limit, safesearch: 'strict' }), { headers: { 'x-subscription-token': key } });
        // Search index results do not grant a reuse licence or identify the creator.
        return out.results.map(r => ({ title: r.title || '', url: r.properties?.url, thumbnail: r.thumbnail?.src, width: r.properties?.width, height: r.properties?.height, license: null, author: null, source_page: r.url, attribution: null }));
    },
};
