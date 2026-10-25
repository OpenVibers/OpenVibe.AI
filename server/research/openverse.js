'use strict';
/**
 * Openverse (api.openverse.org): openly licensed pictures from Flickr, museums and other collections, anonymous use.
 * Only licences that allow commercial reuse are asked for (CC0, public domain, CC BY, CC BY-SA).
 */

const NAMES = { cc0: 'CC0', pdm: 'Public domain', by: 'CC BY', 'by-sa': 'CC BY-SA' };

function createOpenverse({ http }) {
    async function search(query, { limit = 8, signal } = {}) {
        const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${limit}&license_type=commercial&mature=false`;
        const j = await http.getJson(url, { signal, timeout: 10000 });
        return (j.results || []).filter((r) => r.url && /^https:/.test(r.url) && (r.width || 0) >= 320 && NAMES[r.license]).map((r) => ({
            url: r.url,
            original: r.url,
            width: r.width || null,
            height: r.height || null,
            mime: null,
            title: String(r.title || '').slice(0, 200) || query,
            description: null,
            author: r.creator ? String(r.creator).slice(0, 160) : null,
            license: `${NAMES[r.license]}${r.license_version && !/^(cc0|pdm)$/.test(r.license) ? ` ${r.license_version}` : ''}`,
            license_url: r.license_url || null,
            free: true,
            source_url: r.foreign_landing_url || null,
            provider: `openverse${r.source ? `/${r.source}` : ''}`,
        }));
    }
    return { search };
}

module.exports = { createOpenverse };
