'use strict';
const { requestFor, query } = require('../transport');
module.exports = {
    id: 'pexels', byok: true, checked_on: '2026-11-09',
    kinds: ['images'], key_env: 'SEARCH_PEXELS_KEY', hosts: ['api.pexels.com'],
    price_per_1000: 0, source: 'https://www.pexels.com/api/', freshness: [],
    pricing_note: 'No provider fee for existing keys; new key issuance is currently paused, so new keys are not offered.',
    onboarding: 'paused',
    upstreams: ['pexels'],
    filters: {
        license: 'local', commercial: 'local', format: 'local', orientation: 'native',
        size: 'local', color: 'unsupported', after: 'unsupported', type: 'local', safe_search: 'unsupported',
    },
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)(query('https://api.pexels.com/v1/search', { query: b.q, per_page: b.limit, orientation: b.orientation }), { headers: { authorization: key } });
        return out.photos.map((r, i) => ({ title: r.alt || '', url: r.src.original, thumbnail: r.src.medium, width: r.width, height: r.height, license: 'pexels', license_url: 'https://www.pexels.com/license/', author: r.photographer, author_url: r.photographer_url, source_page: r.url, attribution: `Photo by ${r.photographer} on Pexels`, upstream: 'pexels', upstream_rank: i + 1 }));
    },
};
