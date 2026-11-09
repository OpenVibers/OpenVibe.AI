'use strict';
module.exports = {
    id: 'iconify',
    kinds: ['icons'],
    async search(b, get) {
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
        return (out.icons || []).slice(0, b.limit).map((name) => {
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
            };
        });
    },
};
