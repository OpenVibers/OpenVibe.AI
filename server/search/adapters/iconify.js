'use strict';
const { requestFor } = require('../transport');
module.exports = {
    id: 'iconify',
    price_per_1000: 0, byok: false, checked_on: '2026-11-09', source: 'https://iconify.design/docs/api/',
    freshness: [],
    hosts: ['api.iconify.design'],
    kinds: ['icons'],
    upstreams: ['iconify'],
    filters: {
        license: 'local', commercial: 'unsupported', format: 'local', set: 'native',
        style: 'local', size: 'unsupported', orientation: 'unsupported', color: 'unsupported',
        after: 'unsupported', type: 'unsupported', safe_search: 'unsupported',
    },
    async search(b, { fetchImpl }) {
        const get = requestFor(this.hosts, fetchImpl);
        const out = await get(
            'https://api.iconify.design/search?' +
                new URLSearchParams({
                    query: b.q,
                    limit: String(Math.max(32, b.limit)),
                    ...(b.set ? { prefix: b.set } : {}),
                }),
        );
        const prefixes = [
            ...new Set(
                (out.icons || []).slice(0, b.limit).map((s) => s.split(':')[0]),
            ),
        ];
        const info = await get(
            'https://api.iconify.design/collections?prefixes=' +
                prefixes.join(','),
        );
        return (out.icons || []).slice(0, b.limit).map((name, i) => {
            const [set, icon] = name.split(':');
            const c = info[set] || {};
            return {
                name,
                set,
                title: name,
                url: `https://api.iconify.design/${set}/${icon}.svg`,
                thumbnail: `https://api.iconify.design/${set}/${icon}.svg`,
                license: c.license?.spdx || c.license?.title || null,
                license_url: c.license?.url || null,
                author: c.author?.name || null,
                source_page: c.author?.url || null,
                attribution: `${name} — ${c.author?.name || set} (${c.license?.spdx || c.license?.title || 'licence unknown'})`,
                format: 'svg',
                style: /(outline|line)/.test(icon)
                    ? 'line'
                    : /(fill|solid)/.test(icon)
                      ? 'solid'
                      : 'unknown',
                published: null,
                upstream: 'iconify',
                upstream_rank: i + 1,
            };
        });
    },
};
