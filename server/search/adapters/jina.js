'use strict';
const { requestFor, post, bearer, query, web } = require('../transport');
module.exports = {
    id: 'jina', byok: true,
    kinds: ['web', 'fetch'], key_env: 'SEARCH_JINA_KEY', hosts: ['s.jina.ai', 'r.jina.ai'],
    class: 'page_reader',
    source: 'https://jina.ai/reader/#apiform',
    pricing_note: 'Search from 10000 tokens/request; $50/1B token pack ($0.05/M). Reader is token based, not a fixed request fee.',
    price_per_million_tokens: 0.05, freshness: [],
    // The reader is token-priced; the reserve is ten times the published price per call.
    ceilingNano: () => 5000000n,
    cost(out) {
        const tokens = out.usage?.tokens ?? out.data?.usage?.tokens ?? (Array.isArray(out.data) ? out.data.reduce((n, r) => n + (r.usage?.tokens || 0), 0) : 0);
        if (!Number.isFinite(tokens) || tokens <= 0) throw new Error('Jina usage is missing');
        return tokens * 0.05 / 1e6;
    },
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)(query('https://s.jina.ai/', { q: b.q }), { headers: { ...bearer(key), 'x-token-budget': '100000' } });
        return { rows: out.data.map(r => web(r, r.description || r.content, r.publishedTime)), cost: this.cost(out) };
    },
    async read(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)('https://r.jina.ai/', post({ url: b.url }, { ...bearer(key), 'x-token-budget': '100000', 'x-no-cache': 'true', 'x-engine': 'direct' }));
        return { text: out.data.content, cost: this.cost(out) };
    },
};
