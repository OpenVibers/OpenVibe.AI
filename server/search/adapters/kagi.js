'use strict';
const { requestFor, query, web } = require('../transport');
module.exports = {
    id: 'kagi', byok: true, checked_on: '2026-11-09',
    kinds: ['web'], key_env: 'SEARCH_KAGI_KEY', hosts: ['kagi.com'],
    price_per_1000: 25, source: 'https://help.kagi.com/kagi/api/search-legacy.html', freshness: [],
    pricing_note: 'Documented v0 Search API; requires an API-enabled account.',
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)(query('https://kagi.com/api/v0/search', { q: b.q }), { headers: { authorization: 'Bot ' + key } });
        return out.data.filter(r => r.t === 0).map(r => web(r, r.snippet, r.published));
    },
};
