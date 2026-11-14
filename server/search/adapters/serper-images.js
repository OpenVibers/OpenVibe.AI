'use strict';
const { requestFor, post } = require('../transport');
module.exports = {
    id: 'serper-images', credential_id: 'serper', byok: true, manual_only: true,
    kinds: ['images'], key_env: 'SEARCH_SERPER_KEY', hosts: ['google.serper.dev'], freshness: [],
    class: 'web_image_discovery',
    source: 'https://serper.dev/',
    upstreams: ['google'],
    filters: {
        license: 'unsupported', commercial: 'unsupported', format: 'local', orientation: 'local',
        size: 'local', color: 'unsupported', after: 'unsupported', type: 'local', safe_search: 'unsupported',
    },
    pricing_note: 'Starter prepaid pack: $50 for 50000 credits. Search results do not establish reuse rights.',
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)('https://google.serper.dev/images', post({ q: b.q, num: Math.min(b.limit, 10) }, { 'x-api-key': key }));
        return (out.images || []).map((r, i) => ({ title: r.title || '', url: r.imageUrl, snippet: '', published: null,
            thumbnail: r.thumbnailUrl, width: r.imageWidth, height: r.imageHeight, source_page: r.link,
            license: null, license_url: null, author: null, attribution: null, upstream: 'google', upstream_rank: i + 1 }));
    },
};
