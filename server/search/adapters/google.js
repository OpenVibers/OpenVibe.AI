'use strict';
const { requestFor, query, web } = require('../transport');
module.exports = {
    id: 'google', byok: true, checked_on: '2026-11-09',
    kinds: ['web'], key_env: 'SEARCH_GOOGLE_KEY', requires: ['SEARCH_GOOGLE_CX'], hosts: ['customsearch.googleapis.com'],
    class: 'independent_index',
    price_per_1000: 5, source: 'https://developers.google.com/custom-search/v1/overview', freshness: ['day', 'month', 'year'],
    pricing_note: 'After 100 free queries/day. Existing customers only; service ends 2027-01-01.',
    async search(b, { fetchImpl, key, env }) {
        const out = await requestFor(this.hosts, fetchImpl)(query('https://customsearch.googleapis.com/customsearch/v1', { key, cx: env.SEARCH_GOOGLE_CX, q: b.q, num: Math.min(b.limit, 10), dateRestrict: { day: 'd1', month: 'm1', year: 'y1' }[b.freshness] }));
        return (out.items || []).map(r => web({ ...r, url: r.link }));
    },
};
