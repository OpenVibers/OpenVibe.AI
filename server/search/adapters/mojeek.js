'use strict';
const { requestFor, query, web } = require('../transport');
// Mojeek is an independent index of its own: its results come from Mojeek's crawler, not from Google.
// The Startup plan allows a one hour cache for the same user; Business and Enterprise allow storage rights.
// Its terms allow commercial use, AI use, re-ranking and combining with other sources (read 2026-11-13).
const published = (r) => {
    const t = Number(r.pdate || r.timestamp || 0);
    // The house publishes a second-precision timestamp.
    return t > 0 ? new Date(t * 1000).toISOString().replace('.000Z', 'Z') : null;
};
module.exports = {
    id: 'mojeek', byok: true, checked_on: '2026-11-13',
    kinds: ['web'], key_env: 'SEARCH_MOJEEK_KEY', hosts: ['api.mojeek.com'],
    class: 'independent_index',
    price_per_1000: 2.65,
    source: 'https://www.mojeek.com/services/search/web-search-api',
    pricing_note: 'Startup £2 per 1,000 requests (up to 10 results), Business £3, Enterprise on request; VAT excluded. Mojeek publishes in GBP, not USD: converted at 1 GBP = 1.3227 USD (ECB reference rate read 2026-11-13), $2.65 per 1,000 requests.',
    included_allowance: 'Free credit on the Startup plan',
    freshness: ['day', 'month', 'year'],
    onboarding: 'Sign up on the Mojeek Search API page (card required, PAYG, no automatic payments). The Startup plan caps a request at 10 results and allows caching results for one hour for the same user; Business and Enterprise add storage rights.',
    filters: { safe_search: 'native' },
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)(query('https://api.mojeek.com/search', {
            q: b.q, t: Math.min(b.limit, 10), fmt: 'json', api_key: key,
            ...(b.freshness ? { since: b.freshness } : {}),
            ...(b.safe_search === 'strict' ? { safe: 1 } : {}),
        }));
        const results = out.response?.status === 'ERROR' ? [] : (out.response?.results || []);
        return results.map(r => web({ ...r, url: r.url }, r.desc, published(r)));
    },
};
