'use strict';
const { requestFor, query } = require('../transport');
module.exports = {
    id: 'unsplash', byok: true, checked_on: '2026-11-09',
    kinds: ['images'], key_env: 'SEARCH_UNSPLASH_KEY', hosts: ['api.unsplash.com'],
    price_per_1000: 0, source: 'https://unsplash.com/developers', freshness: [],
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)(query('https://api.unsplash.com/search/photos', { query: b.q, per_page: Math.min(30, b.limit), content_filter: 'high', orientation: { landscape: 'landscape', portrait: 'portrait', square: 'squarish' }[b.orientation] }), { headers: { authorization: 'Client-ID ' + key } });
        return out.results.map(r => ({ title: r.alt_description || r.description || '', url: r.urls.full, thumbnail: r.urls.thumb, width: r.width, height: r.height, published: r.created_at || null, license: 'unsplash', license_url: 'https://unsplash.com/license', author: r.user.name, source_page: r.links.html, attribution: `Photo by ${r.user.name} on Unsplash`, author_url: r.user.links?.html, download_location: r.links.download_location }));
    },
};
