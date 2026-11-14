'use strict';
const { requestFor, query } = require('../transport');

// SerpApi's Google Reverse Image operation: a separate operation from its Google Images search, sharing the
// same SerpApi credential and price. It returns pages that carry the image; each row is marked reverse_image.
module.exports = {
    id: 'serpapi-reverse', credential_id: 'serpapi', byok: true, manual_only: true, checked_on: '2026-11-13',
    kinds: ['reverse_image'], key_env: 'SEARCH_SERPAPI_KEY', hosts: ['serpapi.com'], freshness: [],
    class: 'reverse_image',
    price_per_1000: 25, source: 'https://serpapi.com/google-reverse-image',
    included_allowance: '250 searches a month',
    pricing_note: 'Starter $25/month for 1,000 searches; 250 free searches a month. Accepts an image URL only.',
    uploads: false,
    filters: {},
    async reverse(b, { fetchImpl, key }) {
        if (!b.image_url) throw Object.assign(new Error('SerpApi reverse image needs an image URL'), { unbilled: true });
        const out = await requestFor(this.hosts, fetchImpl)(query('https://serpapi.com/search.json', {
            engine: 'google_reverse_image', image_url: b.image_url, api_key: key,
        }));
        return {
            rows: (out.image_results || []).map((r, i) => ({
                title: String(r.title || ''),
                // Google's reverse results are pages, not a guaranteed direct image file.
                url: r.link,
                snippet: String(r.snippet || ''),
                published: null,
                thumbnail: null,
                width: null, height: null,
                source_page: r.link || null,
                license: null, license_url: null, author: null, attribution: null,
                upstream: 'google',
                upstream_rank: Number.isInteger(r.position) && r.position > 0 ? r.position : i + 1,
                reverse_image: true,
            })),
            cost: this.price_per_1000 / 1000,
        };
    },
};
