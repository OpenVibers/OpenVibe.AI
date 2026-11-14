'use strict';
const { createHash } = require('node:crypto');
const { requestFor, query } = require('../transport');

const DAY = 24 * 60 * 60 * 1000;
const cache = new Map();
const images = new Map();

// Pixabay requires a 24-hour response cache and forbids permanent hotlinking. Search rows point at this
// service's short-lived proxy, never at Pixabay's CDN; the proxy serves the bytes from the cached lookup.
module.exports = {
    id: 'pixabay', byok: true, checked_on: '2026-11-13',
    kinds: ['images'], key_env: 'SEARCH_PIXABAY_KEY', hosts: ['pixabay.com'], freshness: [],
    class: 'provider_asset_catalog',
    price_per_1000: 0, source: 'https://pixabay.com/api/docs/',
    pricing_note: 'No provider fee. Responses are cached for 24 hours and pictures are proxied, as its terms require.',
    filters: {
        license: 'local', commercial: 'local', format: 'local', orientation: 'native',
        size: 'local', color: 'unsupported', after: 'unsupported', type: 'local', safe_search: 'native',
    },
    async search(b, { fetchImpl, key, now = Date.now, publicBase = 'https://ai.openvibe.services' }) {
        const cacheKey = createHash('sha256').update(JSON.stringify({
            q: b.q, limit: b.limit, orientation: b.orientation || null, safe: 'true',
            key: createHash('sha256').update(String(key)).digest('hex'),
        })).digest('hex');
        const hit = cache.get(cacheKey);
        if (hit && hit.until > now()) return hit.value;
        const out = await requestFor(this.hosts, fetchImpl)(query('https://pixabay.com/api/', { key, q: b.q, per_page: Math.max(3, b.limit), safesearch: 'true', orientation: { landscape: 'horizontal', portrait: 'vertical' }[b.orientation] }));
        const rows = (out.hits || []).map((r, i) => {
            const image = proxyImage(r, publicBase, now());
            return {
                title: r.tags || '', url: image, thumbnail: image,
                width: r.imageWidth, height: r.imageHeight,
                license: 'pixabay', license_url: 'https://pixabay.com/service/license-summary/',
                author: r.user, source_page: r.pageURL, attribution: `Image by ${r.user} on Pixabay`,
                upstream: 'pixabay', upstream_rank: i + 1,
            };
        });
        cache.set(cacheKey, { until: now() + DAY, value: rows });
        purge(now());
        return rows;
    },
    async image(id, { fetchImpl }) {
        const record = images.get(String(id));
        if (!record || record.until <= Date.now()) throw Object.assign(new Error('This Pixabay image is no longer cached'), { status: 404, code: 'search.image_expired' });
        const url = new URL(record.url);
        if (url.protocol !== 'https:' || !['cdn.pixabay.com', 'pixabay.com'].includes(url.hostname) || url.username || url.password)
            throw new Error('Pixabay image host is not allowed');
        const r = await fetchImpl(url.href, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { accept: 'image/*' } });
        if (!r.ok) throw Object.assign(new Error('Pixabay image unavailable'), { status: 502, code: 'search.image_unavailable' });
        return { body: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/jpeg' };
    },
};

function proxyImage(hit, base, at) {
    const id = String(hit.id || '');
    const original = hit.largeImageURL || hit.webformatURL;
    if (id && original) {
        images.set(id, { url: original, until: Date.now() + DAY });
        return `${String(base).replace(/\/+$/, '')}/v1/search/images/pixabay/${encodeURIComponent(id)}`;
    }
    return original;
}

function purge(now) {
    for (const [k, v] of cache) if (v.until <= now) cache.delete(k);
    const wall = Date.now();
    for (const [k, v] of images) if (v.until <= wall) images.delete(k);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    if (images.size > 1000) images.delete(images.keys().next().value);
}
