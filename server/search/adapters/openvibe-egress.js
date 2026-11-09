'use strict';
const { guardedFetch } = require('../../providers/guarded-fetch');
module.exports = {
    id: 'openvibe-egress', kinds: ['fetch'], byok: false, price_per_1000: 0,
    source: 'https://openvibe.exchange', checked_on: '2026-11-09', freshness: [],
    async read(b, { fetchImpl = guardedFetch }) {
        const r = await fetchImpl(b.url, { signal: AbortSignal.timeout(10000), redirect: 'error', headers: { accept: 'text/plain,text/html' } });
        if (!r.ok) throw new Error('The page did not answer');
        return { text: (await r.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' '), cost: 0 };
    },
};
