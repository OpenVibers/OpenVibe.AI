'use strict';
// One supplier's image result, with the same shape as the rest of the image adapters. `upstream` names the
// index that actually answered (Google, Bing, Yandex), and `upstream_rank` keeps the provider's own order
// beside the rank OpenVibe's rerank gives the row later.
function imageRow(r, { index = 0, upstream, source_page = null } = {}) {
    return {
        title: String(r.title || ''),
        url: r.original || r.imageUrl || r.url || null,
        snippet: String(r.snippet || r.source || ''),
        published: r.published || null,
        thumbnail: r.thumbnail || null,
        width: r.original_width ?? r.width ?? null,
        height: r.original_height ?? r.height ?? null,
        source_page: source_page || r.link || null,
        license: null,
        license_url: null,
        author: null,
        attribution: null,
        upstream: upstream || null,
        upstream_rank: Number.isInteger(r.position) && r.position > 0 ? r.position : index + 1,
    };
}
module.exports = { imageRow };
