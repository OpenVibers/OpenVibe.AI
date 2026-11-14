'use strict';
const { requestFor, query, web } = require('../transport');
module.exports = {
    id: 'serpapi', byok: true, checked_on: '2026-11-09',
    kinds: ['web'], key_env: 'SEARCH_SERPAPI_KEY', hosts: ['serpapi.com'],
    class: 'serp_proxy',
    price_per_1000: 25, source: 'https://serpapi.com/pricing', freshness: ['day', 'month', 'year'],
    included_allowance: '250 searches a month',
    pricing_note: 'Starter subscription: $25/month for 1000 searches; lower rates at volume.',
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)(query('https://serpapi.com/search.json', { engine: 'google', q: b.q, num: Math.min(b.limit, 10), api_key: key, tbs: b.freshness ? 'qdr:' + { day: 'd', month: 'm', year: 'y' }[b.freshness] : undefined }));
        return (out.organic_results || []).map(r => web({ ...r, url: r.link }, r.snippet, r.date));
    },
};
