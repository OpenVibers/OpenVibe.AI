'use strict';
const { requestFor, post, web } = require('../transport');
// You.com: their terms forbid selling or distributing the services, extracting the output automatically and
// building a competing product, so this engine is a person's own key only: it never runs on a shared key
// (read 2026-11-13).
const pageAge = (value) => {
    const s = String(value || '');
    if (!s) return null;
    return /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(s) ? s + 'Z' : s;
};
module.exports = {
    id: 'you', byok: true, manual_only: true, checked_on: '2026-11-13',
    kinds: ['web'], key_env: 'SEARCH_YOU_KEY', hosts: ['ydc-index.io'],
    class: 'answer_engine',
    price_per_1000: 5,
    source: 'https://you.com/docs/administration/billing',
    pricing_note: '$5.00 per 1,000 calls (up to 100 results per call). Full page extraction is $1.00 per 1,000 pages crawled live and is not requested here.',
    freshness: ['day', 'month', 'year'],
    onboarding: 'Get an API key at you.com/platform and send it as X-API-Key to POST https://ydc-index.io/v1/search. Credits are pay as you go; the key is the person\'s own.',
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)('https://ydc-index.io/v1/search', post({
            query: b.q, count: Math.min(b.limit, 100),
            ...(b.freshness ? { freshness: b.freshness } : {}),
        }, { 'X-API-Key': key }));
        return (out.results?.web || []).map(r => web({ ...r, url: r.url }, r.description || (r.snippets || []).join(' '), pageAge(r.page_age)));
    },
};
