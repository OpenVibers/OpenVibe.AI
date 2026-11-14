'use strict';
const { requestFor, post, web } = require('../transport');
// Parallel is a research index of its own: it returns pages and excerpts for an objective, not a ranked list
// of links. Its customer terms allow the output to be shown to one end customer per query, and forbid caching
// it, reselling the service and using it to train a model (read 2026-11-13).
module.exports = {
    id: 'parallel', byok: true,
    kinds: ['web'], key_env: 'SEARCH_PARALLEL_KEY', hosts: ['api.parallel.ai'],
    class: 'semantic',
    source: 'https://docs.parallel.ai/getting-started/pricing',
    pricing_note: 'Search API: $1 per 1,000 fast or turbo requests (10 results each), $5 per 1,000 in basic or advanced; $1 per 1,000 for every result beyond the first 10. This adapter asks for fast mode.',
    freshness: [],
    onboarding: 'Create an API key on the Parallel platform. The Search API answers POST /v1/search with the key in the x-api-key header.',
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)('https://api.parallel.ai/v1/search', post({
            objective: 'Find the most relevant web results for: ' + b.q,
            search_queries: [b.q],
            mode: 'fast',
            advanced_settings: { max_results: Math.min(b.limit, 10) },
        }, { 'x-api-key': key }));
        return (out.results || []).map(r => web({ ...r, url: r.url }, (r.excerpts || []).join(' '), r.publish_date));
    },
};
