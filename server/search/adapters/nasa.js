'use strict';
const { requestFor } = require('../transport');
// The NASA Image and Video Library: a public catalog with no key and no fee. NASA content is generally not
// copyrighted (read 2026-11-13), but NASA also hosts third party material it marks as copyright protected, so
// only a NASA-created record is public domain here; the others keep their rights unknown.
const thirdParty = (data) => {
    const creator = String(data.secondary_creator || '');
    if (creator && !/NASA/i.test(creator)) return true;
    return /copyright\s*(?:protected|holder|©|:)/i.test(String(data.description_508 || data.description || ''));
};
module.exports = {
    id: 'nasa', byok: false,
    kinds: ['images'], freshness: [],
    class: 'open_asset_catalog',
    hosts: ['images-api.nasa.gov', 'images-assets.nasa.gov'],
    source: 'https://images.nasa.gov/docs/images.nasa.gov_api_docs.pdf',
    pricing_note: 'No provider fee: the NASA Image and Video Library API is public and needs no key. NASA content is generally not copyrighted, but a record that names another creator keeps its rights unknown.',
    upstreams: ['nasa'],
    onboarding: 'No key and no signup: POST a query to https://images-api.nasa.gov/search. Each result\'s asset list is a second read of its collection.json.',
    filters: {
        license: 'local', commercial: 'local', format: 'local', orientation: 'local',
        size: 'local', color: 'unsupported', after: 'local', type: 'unsupported', safe_search: 'unsupported',
    },
    async search(b, { fetchImpl }) {
        const get = requestFor(this.hosts, fetchImpl);
        const out = await get('https://images-api.nasa.gov/search?' + new URLSearchParams({ q: b.q, media_type: 'image' }));
        const items = (out.collection?.items || []).slice(0, b.limit);
        const rows = [];
        for (const item of items) {
            const data = item.data?.[0] || {};
            let assets = [];
            try { assets = await get(item.href); } catch { assets = []; }
            const list = Array.isArray(assets) ? assets : [];
            const original = list.find(u => /~orig\./.test(u)) || list.find(u => /~large\./.test(u)) || list.find(u => /~medium\./.test(u)) || list[0] || null;
            const thumb = list.find(u => /~thumb\./.test(u)) || original;
            const title = String(data.title || '');
            const creator = String(data.secondary_creator || 'NASA');
            const own = !thirdParty(data);
            rows.push({
                title,
                url: original,
                thumbnail: thumb,
                source_page: 'https://images.nasa.gov/details/' + encodeURIComponent(String(data.nasa_id || '')),
                width: null, height: null,
                license: own ? 'public_domain' : null,
                license_url: own ? 'https://www.nasa.gov/nasa-brand-center/images-and-media/' : null,
                author: creator,
                attribution: own ? title + ' — ' + creator + ' (NASA, public domain)' : title + ' — ' + creator,
                published: data.date_created || null,
                upstream: 'nasa', upstream_rank: rows.length + 1,
            });
        }
        return rows;
    },
};
