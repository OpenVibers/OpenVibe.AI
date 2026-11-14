'use strict';
const { requestFor } = require('../transport');
const plain = (s) => String(s || '').replace(/<[^>]*>/g, '');
module.exports = {
    id: 'commons',
    byok: false, source: 'https://www.mediawiki.org/wiki/API:Main_page',
    freshness: [],
    hosts: ['commons.wikimedia.org'],
    kinds: ['images'],
    class: 'open_asset_catalog',
    upstreams: ['commons'],
    filters: {
        license: 'local', commercial: 'local', format: 'native', orientation: 'local',
        size: 'local', color: 'unsupported', after: 'unsupported', type: 'local', safe_search: 'unsupported',
    },
    async search(b, { fetchImpl }) {
        const get = requestFor(this.hosts, fetchImpl);
        const q = new URLSearchParams({
            action: 'query',
            format: 'json',
            generator: 'search',
            gsrnamespace: '6',
            gsrsearch: b.q + (b.format === 'svg' ? ' filetype:svg' : ''),
            gsrlimit: String(b.limit),
            prop: 'imageinfo',
            iiprop: 'url|size|mime|extmetadata',
            iiurlwidth: '400',
        });
        const out = await get('https://commons.wikimedia.org/w/api.php?' + q);
        return Object.values(out.query?.pages || {}).flatMap((p) => {
            const i = p.imageinfo?.[0];
            if (!i) return [];
            const m = i.extmetadata || {};
            const license = plain(m.LicenseShortName?.value)
                .toLowerCase()
                .replace(/^cc /, '')
                .replace(/ /g, '-');
            const author = plain(m.Artist?.value);
            return [
                {
                    title: p.title,
                    url: i.url,
                    thumbnail: i.thumburl || i.url,
                    width: i.width,
                    height: i.height,
                    license,
                    license_url: m.LicenseUrl?.value || null,
                    author,
                    source_page: i.descriptionurl,
                    attribution: `${p.title} — ${author} (${license})`,
                    format:
                        i.mime === 'image/svg+xml'
                            ? 'svg'
                            : i.mime?.split('/')[1],
                    published: null,
                    upstream: 'commons',
                    upstream_rank: null,
                },
            ];
        });
    },
};
