'use strict';
const { requestFor, query } = require('../transport');
const { imageRow } = require('../image-row');

const ENGINES = { google: 'google_images', bing: 'bing_images', yandex: 'yandex_images' };

// One supplier (SearchAPI.io), three upstreams. The person picks `upstream`; every row names the one that
// answered. Results carry no licence metadata, so a licence filter is refused for this engine.
module.exports = {
    id: 'searchapi-images', credential_id: 'searchapi', byok: true, checked_on: '2026-11-13',
    kinds: ['images'], key_env: 'SEARCH_SEARCHAPI_KEY', hosts: ['www.searchapi.io'], freshness: [],
    class: 'web_image_discovery',
    price_per_1000: 4, source: 'https://www.searchapi.io/docs/google-images',
    included_allowance: '100 trial searches',
    pricing_note: '$40/month for 10,000 searches; 100 trial searches. Search results do not establish reuse rights.',
    upstreams: ['google', 'bing', 'yandex'],
    filters: {
        license: 'unsupported', commercial: 'unsupported', format: 'local', orientation: 'local',
        size: 'local', color: 'unsupported', after: 'unsupported', type: 'local', safe_search: 'unsupported',
    },
    async search(b, { fetchImpl, key }) {
        const upstream = b.upstream || 'google';
        const engine = ENGINES[upstream];
        if (!engine) throw new Error('Unsupported SearchAPI upstream');
        const out = await requestFor(this.hosts, fetchImpl)(query('https://www.searchapi.io/api/v1/search', {
            engine, q: b.q, num: Math.min(b.limit, 100), api_key: key,
        }));
        return (out.images_results || []).map((r, i) => imageRow(r, {
            index: i, upstream, source_page: r.link,
        }));
    },
};
