'use strict';
const { requestFor } = require('../transport');
// The Smithsonian Open Access API: a public catalog, no fee. Its metadata licence is CC0 for every record, but
// a media file is only given for a digital image of an object whose underlying work is in the public domain
// (their developer tools), so a record that carries a picture is a public-domain object.
const IDS = 'https://ids.si.edu/ids/deliveryService';
module.exports = {
    id: 'smithsonian', byok: true,
    kinds: ['images'], key_env: 'SEARCH_SMITHSONIAN_KEY', hosts: ['api.si.edu', 'ids.si.edu'],
    class: 'open_asset_catalog',
    source: 'https://www.si.edu/openaccess/devtools',
    pricing_note: 'No provider fee: the Open Access API is free with a key from api.data.gov. The metadata of every record is CC0; a media file is only given for an object whose underlying work is in the public domain, so a picture here is a public-domain object.',
    freshness: [],
    upstreams: ['smithsonian'],
    onboarding: 'Register for an API key at api.data.gov/signup and send it as api_key. The key is the person\'s own.',
    filters: {
        license: 'local', commercial: 'local', format: 'unsupported', orientation: 'unsupported',
        size: 'unsupported', color: 'unsupported', after: 'unsupported', type: 'unsupported', safe_search: 'unsupported',
    },
    async search(b, { fetchImpl, key }) {
        const q = new URLSearchParams({ q: b.q + ' AND online_visual_material:true', rows: String(Math.min(b.limit, 50)), api_key: key });
        const out = await requestFor(this.hosts, fetchImpl)('https://api.si.edu/openaccess/api/v1.0/search?' + q);
        const rows = [];
        for (const row of out.response?.rows || []) {
            const d = row.content?.descriptiveNonRepeating || {};
            const media = d.online_media?.media || [];
            // A record without a media file is not a picture: the API holds metadata for it, not an image.
            for (const picture of media.filter(m => m.type === 'Images' && m.idsId)) {
                rows.push({
                    title: String(row.title || d.title?.content || ''),
                    url: IDS + '?id=' + encodeURIComponent(picture.idsId) + '&max=1000',
                    thumbnail: IDS + '?id=' + encodeURIComponent(picture.idsId) + '&max=400',
                    source_page: 'https://www.si.edu/object/' + String(row.url || ''),
                    width: null, height: null,
                    license: 'cc0',
                    license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
                    author: d.data_source || null,
                    attribution: [String(row.title || ''), d.data_source || 'Smithsonian', '(CC0)'].filter(Boolean).join(' — '),
                    published: null,
                    upstream: 'smithsonian', upstream_rank: rows.length + 1,
                });
            }
        }
        return rows;
    },
};
