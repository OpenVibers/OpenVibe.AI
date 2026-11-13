'use strict';
const { requestFor, post } = require('../transport');
// DataForSEO's Google Images operation. The supplier is DataForSEO, the upstream index is Google, and a
// search result grants no reuse rights: the licence and the author stay unknown, like every other discovery
// engine.
const basic = (key) => ({ authorization: 'Basic ' + Buffer.from(String(key)).toString('base64') });
const collect = (items, out = []) => {
    for (const item of items || []) {
        if (!item || typeof item !== 'object') continue;
        if (typeof item.source_url === 'string' && item.source_url) out.push(item);
        if (Array.isArray(item.items)) collect(item.items, out);
    }
    return out;
};
module.exports = {
    id: 'dataforseo-images', byok: true, checked_on: '2026-11-13',
    kinds: ['images'], key_env: 'SEARCH_DATAFORSEO_KEY', hosts: ['api.dataforseo.com'],
    price_per_1000: 2,
    source: 'https://dataforseo.com/pricing/google-serp/google-images-serp-api',
    pricing_note: 'Live mode $0.002 per SERP = $2.00 per 1,000 SERPs (up to 100 images each); the queued modes are cheaper but take minutes. Search results grant no reuse rights.',
    freshness: [],
    upstreams: ['google'],
    onboarding: 'The same DataForSEO key as the web engine: the login and the password joined by a colon. The key is sent as HTTP Basic.',
    filters: {
        license: 'unsupported', commercial: 'unsupported', format: 'unsupported', orientation: 'unsupported',
        size: 'unsupported', color: 'unsupported', after: 'unsupported', type: 'unsupported', safe_search: 'unsupported',
    },
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)('https://api.dataforseo.com/v3/serp/google/images/live/advanced', post({
            task: [{ keyword: b.q, location_code: 2840, language_code: 'en', depth: Math.min(b.limit, 100) }],
        }, basic(key)));
        const items = out.tasks?.[0]?.result?.[0]?.items || [];
        return collect(items).slice(0, b.limit).map((r, i) => ({
            title: String(r.title || ''),
            url: r.source_url,
            thumbnail: r.encoded_url || null,
            source_page: r.url || null,
            width: null, height: null,
            license: null, license_url: null, author: null, attribution: null,
            upstream: 'google', upstream_rank: i + 1,
        }));
    },
};
