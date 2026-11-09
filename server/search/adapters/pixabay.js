'use strict';
const { requestFor, query } = require('../transport');
module.exports = {
    id: 'pixabay', byok: true, checked_on: '2026-11-09',
    kinds: ['images'], key_env: 'SEARCH_PIXABAY_KEY', hosts: ['pixabay.com'],
    price_per_1000: 0, source: 'https://pixabay.com/api/docs/', freshness: [],
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)(query('https://pixabay.com/api/', { key, q: b.q, per_page: Math.max(3, b.limit), safesearch: 'true', orientation: { landscape: 'horizontal', portrait: 'vertical' }[b.orientation] }));
        return out.hits.map(r => ({ title: r.tags || '', url: r.largeImageURL || r.webformatURL, thumbnail: r.previewURL, width: r.imageWidth, height: r.imageHeight, license: 'pixabay', license_url: 'https://pixabay.com/service/license-summary/', author: r.user, source_page: r.pageURL, attribution: `Image by ${r.user} on Pixabay` }));
    },
};
