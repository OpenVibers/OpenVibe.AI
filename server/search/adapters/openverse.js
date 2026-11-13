'use strict';
const { requestFor } = require('../transport');
module.exports = {
    id: 'openverse',
    price_per_1000: 0, byok: false, checked_on: '2026-11-09', source: 'https://api.openverse.org/',
    freshness: [],
    hosts: ['api.openverse.org'],
    kinds: ['images'],
    upstreams: ['openverse'],
    filters: {
        license: 'native', commercial: 'native', format: 'native', orientation: 'native',
        size: 'native', color: 'unsupported', after: 'local', type: 'native', safe_search: 'unsupported',
    },
    async search(b, { fetchImpl }) {
        const get = requestFor(this.hosts, fetchImpl);
        const q = new URLSearchParams({
            q: b.q,
            page_size: String(b.limit),
            mature: 'false',
        });
        for (const [a, k] of [
            ['license', 'license'],
            ['format', 'extension'],
            ['orientation', 'aspect_ratio'],
            ['size', 'size'],
        ])
            if (b[a])
                q.set(
                    k,
                    a === 'license'
                        ? String(b[a])
                              .toLowerCase()
                              .replace(/^cc[ -]/, '')
                        : b[a],
                );
        if (b.commercial) q.set('license_type', 'commercial');
        if (b.type === 'photo') q.set('category', 'photograph');
        if (b.type === 'illustration') q.set('category', 'illustration');
        const out = await get('https://api.openverse.org/v1/images/?' + q);
        return (out.results || []).map((r, i) => ({
            title: r.title,
            url: r.url,
            thumbnail: r.thumbnail,
            width: r.width,
            height: r.height,
            license: r.license,
            license_url: r.license_url,
            author: r.creator,
            source_page: r.foreign_landing_url,
            attribution: r.attribution,
            format: r.filetype,
            type: r.category === 'photograph' ? 'photo' : r.category || null,
            indexed_on: r.indexed_on || null,
            published: null,
            upstream: 'openverse',
            upstream_rank: i + 1,
        }));
    },
};
