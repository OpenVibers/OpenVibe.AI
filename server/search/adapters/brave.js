'use strict';
const { requestFor, query, web } = require('../transport');
module.exports = {
    id: 'brave', byok: true, checked_on: '2026-11-09',
    kinds: ['web'], key_env: 'SEARCH_BRAVE_KEY', hosts: ['api.search.brave.com'],
    price_per_1000: 5, source: 'https://api-dashboard.search.brave.com/app/plans', freshness: ['day', 'month', 'year'],
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)(query('https://api.search.brave.com/res/v1/web/search', { q: b.q, count: Math.min(b.limit, 20), freshness: { day: 'pd', month: 'pm', year: 'py' }[b.freshness] }), { headers: { 'x-subscription-token': key } });
        return (out.web?.results || []).map(r => web(r, r.description, r.page_age));
    },
};
