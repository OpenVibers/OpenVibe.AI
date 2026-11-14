'use strict';
const { requestFor, query } = require('../transport');
const { imageRow } = require('../image-row');

// SerpApi's Google Images operation. The supplier is SerpApi; the upstream index is Google, and every row
// says so. Search results grant no reuse rights: licence and author stay null rather than being guessed.
module.exports = {
    id: 'serpapi-images', credential_id: 'serpapi', byok: true,
    kinds: ['images'], key_env: 'SEARCH_SERPAPI_KEY', hosts: ['serpapi.com'], freshness: [],
    class: 'web_image_discovery',
    source: 'https://serpapi.com/google-images-api',
    pricing_note: 'Starter $25/month for 1,000 searches; 250 free searches a month. Search results do not establish reuse rights.',
    upstreams: ['google'],
    filters: {
        license: 'unsupported', commercial: 'unsupported', format: 'local', orientation: 'local',
        size: 'local', color: 'unsupported', after: 'unsupported', type: 'local', safe_search: 'unsupported',
    },
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)(query('https://serpapi.com/search.json', {
            engine: 'google_images', q: b.q, num: Math.min(b.limit, 100), api_key: key,
        }));
        return (out.images_results || []).map((r, i) => imageRow(r, {
            index: i, upstream: 'google', source_page: r.link,
        }));
    },
};
