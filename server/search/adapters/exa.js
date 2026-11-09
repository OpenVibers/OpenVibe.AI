'use strict';
const { requestFor, post, query, since, web } = require('../transport');
module.exports = {
    id: 'exa', byok: true, checked_on: '2026-11-09',
    kinds: ['web'], key_env: 'SEARCH_EXA_KEY', hosts: ['api.exa.ai'],
    price_per_1000: 7, source: 'https://exa.ai/docs/admin/pricing', freshness: ['day', 'month', 'year'],
    pricing_note: 'Auto search, up to 10 results; $1/1000 for each additional result.',
    ceiling: b => (7 + Math.max(0, b.limit - 10)) / 1000,
    estimate(b) { return this.ceiling(b); },
    async search(b, { fetchImpl, key, now }) {
        const out = await requestFor(this.hosts, fetchImpl)('https://api.exa.ai/search', post({ query: b.q, type: 'auto', numResults: b.limit, contents: { highlights: true }, ...(b.freshness ? { startPublishedDate: since(b.freshness, now()) } : {}) }, { 'x-api-key': key }));
        return { rows: out.results.map(r => web(r, r.highlights?.join(' ') || r.text, r.publishedDate)), cost: out.costDollars?.total ?? this.ceiling(b) };
    },
};
