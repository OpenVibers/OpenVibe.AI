'use strict';
const { requestFor, post, bearer, query, since, web } = require('../transport');
module.exports = {
    id: 'deepseek', byok: true, checked_on: '2026-11-09',
    kinds: ['web', 'fetch'], key_env: 'SEARCH_DEEPSEEK_KEY', hosts: ['api.deepseek.com'],
    price_per_1000: 0.75, source: 'https://api-docs.deepseek.com/guides/search/',
    freshness: ['day', 'month', 'year'], max_query: 128,
    async search(b, { fetchImpl, key, now }) {
        const q = b.q + (b.freshness ? ' after:' + since(b.freshness, now()).slice(0, 10) : '');
        if ([...q].length > 128) throw new Error('DeepSeek query exceeds 128 characters');
        const out = await requestFor(this.hosts, fetchImpl)('https://api.deepseek.com/v1/tools/search', post({ query: q, count: b.limit, need_content: false }, bearer(key)));
        return { rows: out.results.map(r => web(r, r.snippet || r.summary, r.date)), cost: out.results.length ? 0.00075 : 0 };
    },
    async read(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)('https://api.deepseek.com/v1/tools/fetch', post({ url: b.url }, bearer(key)));
        return { text: out.content, cost: out.content ? 0.00075 : 0 };
    },
};
