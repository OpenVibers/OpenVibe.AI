'use strict';
const { requestFor, query } = require('../transport');

// Unsplash's photo search. The download event is deliberately not sent here: it is one server-side call when
// a person chooses or imports a picture, through the idempotent trackDownload operation.
module.exports = {
    id: 'unsplash', byok: true,
    kinds: ['images'], key_env: 'SEARCH_UNSPLASH_KEY', hosts: ['api.unsplash.com'],
    class: 'provider_asset_catalog',
    source: 'https://unsplash.com/documentation#search-photos', freshness: [],
    pricing_note: 'No provider fee. Attribution, hotlinking and a download event when a picture is chosen are required.',
    filters: {
        license: 'local', commercial: 'local', format: 'local', orientation: 'native',
        size: 'local', color: 'native', after: 'local', type: 'local', safe_search: 'native',
    },
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)(query('https://api.unsplash.com/search/photos', { query: b.q, per_page: Math.min(30, b.limit), content_filter: 'high', color: b.color, orientation: { landscape: 'landscape', portrait: 'portrait', square: 'squarish' }[b.orientation] }), { headers: { authorization: 'Client-ID ' + key } });
        return out.results.map((r, i) => ({ title: r.alt_description || r.description || '', url: r.urls.full, thumbnail: r.urls.thumb, width: r.width, height: r.height, published: r.created_at || null, license: 'unsplash', license_url: 'https://unsplash.com/license', author: r.user.name, source_page: r.links.html, attribution: `Photo by ${r.user.name} on Unsplash`, author_url: r.user.links?.html, download_location: r.links.download_location, upstream: 'unsplash', upstream_rank: i + 1 }));
    },
    async trackDownload({ download_location }, { fetchImpl, key }) {
        const url = downloadUrl(download_location);
        await requestFor(this.hosts, fetchImpl)(url, { headers: { authorization: 'Client-ID ' + key } });
        return { tracked: true };
    },
};

function downloadUrl(value) {
    let u;
    try { u = new URL(String(value)); } catch { throw Object.assign(new Error('A valid Unsplash download_location is required'), { unbilled: true }); }
    if (u.protocol !== 'https:' || u.hostname !== 'api.unsplash.com' || !/^\/photos\/[^/]+\/download\/?$/.test(u.pathname) || u.username || u.password)
        throw Object.assign(new Error('download_location must be an Unsplash photo download endpoint'), { unbilled: true });
    return u.href;
}
