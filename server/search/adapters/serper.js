'use strict';
const { requestFor, post, web } = require('../transport');
module.exports = {
    id: 'serper', byok: true, checked_on: '2026-11-09',
    kinds: ['web'], key_env: 'SEARCH_SERPER_KEY', hosts: ['google.serper.dev'],
    price_per_1000: 1, source: 'https://serper.dev/', freshness: ['day', 'month', 'year'],
    pricing_note: 'Starter prepaid pack: $50 for 50000 credits; lower rates at volume.',
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)('https://google.serper.dev/search', post({ q: b.q, num: Math.min(b.limit, 10), ...(b.freshness ? { tbs: 'qdr:' + { day: 'd', month: 'm', year: 'y' }[b.freshness] } : {}) }, { 'x-api-key': key }));
        return (out.organic || []).map(r => web({ ...r, url: r.link }, r.snippet, r.date));
    },
};
