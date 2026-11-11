'use strict';

const knownLicense = (r) => Boolean(r.license && r.license_url);
const pixels = (r) => (r.width || 0) * (r.height || 0);
const key = (r) => {
    try {
        const u = new URL(r.url);
        return `${u.hostname.replace(/^www\./, '')}${decodeURIComponent(u.pathname).replace(/\/(?:thumb|thumbnail|preview)s?\//gi, '/').replace(/(?:[_-]\d{2,5}x\d{2,5})(?=\.)/g, '').toLowerCase()}`;
    } catch { return r.url; }
};
const score = (r) => (knownLicense(r) ? 100 : 0) + Math.min(50, Math.log2(Math.max(1, pixels(r)))) + (r.source_page ? 5 : 0);

function rankImages(rows, limit) {
    const ordered = [...rows].sort((a, b) => score(b) - score(a));
    const seen = new Set();
    const out = [];
    for (const row of ordered) {
        const exact = key(row);
        const title = String(row.title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        const near = title.length > 15 && `${title}|${Math.round((row.width || 0) / Math.max(1, row.height || 1) * 10)}`;
        if (seen.has(exact) || near && seen.has(near)) continue;
        seen.add(exact);
        if (near) seen.add(near);
        out.push(row);
        if (out.length >= limit) break;
    }
    return out;
}

module.exports = { rankImages };
