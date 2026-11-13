'use strict';
const { requestFor, query } = require('../transport');

// TinEye's own reverse-image index: an image URL or a multipart upload in, its matches and the pages that
// carry them out. It is a reverse_image operation, never a keyword search, and it is explicit selection only.
module.exports = {
    id: 'tineye', byok: true, manual_only: true, checked_on: '2026-11-13',
    kinds: ['reverse_image'], key_env: 'SEARCH_TINEYE_KEY', hosts: ['api.tineye.com'], freshness: [],
    price_per_1000: 40, source: 'https://api.tineye.com/python/docs/',
    pricing_note: 'Example bundle: $200 per 5,000 searches. Verify the current bundle before use.',
    uploads: true,
    filters: {},
    async reverse(b, { fetchImpl, key }) {
        const get = requestFor(this.hosts, fetchImpl);
        let out;
        if (b.image) {
            const { buffer, mime, extension } = decodeImage(b.image);
            const boundary = '----openvibe' + Date.now().toString(16) + Math.random().toString(16).slice(2);
            const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image_upload"; filename="image.${extension}"\r\nContent-Type: ${mime}\r\n\r\n`);
            const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
            out = await get('https://api.tineye.com/rest/search/', {
                method: 'POST',
                headers: { 'x-api-key': key, 'content-type': `multipart/form-data; boundary=${boundary}` },
                body: Buffer.concat([head, buffer, tail]),
            });
        } else {
            out = await get(query('https://api.tineye.com/rest/search/', {
                image_url: b.image_url, limit: Math.min(b.limit, 100), sort: 'score', order: 'desc',
            }), { headers: { 'x-api-key': key } });
        }
        const matches = out.results?.matches || [];
        return {
            rows: matches.slice(0, b.limit).map((m, i) => {
                const backlinks = Array.isArray(m.backlinks) ? m.backlinks : [];
                const pages = backlinks.map((x) => ({
                    page: safePage(x.backlink), image: safePage(x.url), crawled: x.crawl_date || null,
                })).filter((x) => x.page || x.image).slice(0, 10);
                const first = pages[0] || null;
                const image = safePage(m.image_url);
                return {
                    title: `${m.domain || 'Match'}${m.score != null ? ` · ${Math.round(Number(m.score))}% match` : ''}`,
                    url: image || (first && (first.image || first.page)) || null,
                    snippet: pages.map((x) => x.page).filter(Boolean).join(' · '),
                    published: first && first.crawled ? String(first.crawled) : null,
                    thumbnail: image,
                    width: Number.isFinite(Number(m.width)) ? Number(m.width) : null,
                    height: Number.isFinite(Number(m.height)) ? Number(m.height) : null,
                    source_page: (first && first.page) || (m.domain ? `https://${m.domain}` : null),
                    license: null, license_url: null, author: null, attribution: null,
                    upstream: 'tineye',
                    upstream_rank: i + 1,
                    reverse_image: true,
                    match_score: m.score == null ? null : Number(m.score),
                    backlinks: pages,
                };
            }),
            cost: this.price_per_1000 / 1000,
        };
    },
};

function safePage(value) {
    try {
        const u = new URL(String(value));
        return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null;
    } catch { return null; }
}

function decodeImage(data) {
    const match = /^data:(image\/(?:png|jpe?g|gif|bmp|tiff|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(data));
    if (!match) throw Object.assign(new Error('Image upload must be a base64 image data URL'), { unbilled: true });
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length < 128) throw Object.assign(new Error('Image upload is too small'), { unbilled: true });
    if (buffer.length > 5 * 1024 * 1024) throw Object.assign(new Error('Image upload is larger than 5 MB'), { unbilled: true });
    const mime = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
    return { buffer, mime, extension: mime.split('/')[1].replace('jpeg', 'jpg') };
}
