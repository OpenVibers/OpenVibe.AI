'use strict';
const { requestFor, post, bearer, query, web } = require('../transport');
module.exports = {
    id: 'tavily', byok: true, checked_on: '2026-11-09',
    kinds: ['web'], key_env: 'SEARCH_TAVILY_KEY', hosts: ['api.tavily.com'],
    price_per_1000: 8, source: 'https://www.tavily.com/pricing', freshness: ['day', 'month', 'year'],
    pricing_note: 'Pay as you go; basic search uses one credit. Free allowance excluded.',
    included_allowance: '1,000 credits a month',
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)('https://api.tavily.com/search', post({ query: b.q, search_depth: 'basic', auto_parameters: false, max_results: Math.min(20, b.limit), include_published_date: true, ...(b.freshness ? { time_range: b.freshness } : {}) }, bearer(key)));
        return out.results.map(r => web(r, r.content, r.published_date));
    },
};
