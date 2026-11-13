'use strict';
const { requestFor } = require('../transport');
// Europeana is an open catalog of European heritage: every record carries its own rights statement.
// The API's own metadata licence (CC0) is NOT the rights of the object, so the rights come from the record.
const RIGHTS = {
    'cc0': 'http://creativecommons.org/publicdomain/zero/1.0/',
    'pdm': 'http://creativecommons.org/publicdomain/mark/1.0/',
    'by': 'http://creativecommons.org/licenses/by/4.0/',
    'by-sa': 'http://creativecommons.org/licenses/by-sa/4.0/',
    'by-nc': 'http://creativecommons.org/licenses/by-nc/4.0/',
    'by-nd': 'http://creativecommons.org/licenses/by-nd/4.0/',
    'inc': 'http://rightsstatements.org/vocab/InC/1.0/',
};
const LICENSE_OF = new Map(Object.entries(RIGHTS).map(([id, uri]) => [uri, id]));
const licenseOf = (rights) => {
    const uri = Array.isArray(rights) ? rights[0] : rights;
    if (!uri) return { license: null, license_url: null };
    return { license: LICENSE_OF.get(uri) || null, license_url: String(uri) };
};
module.exports = {
    id: 'europeana', byok: true, checked_on: '2026-11-13',
    kinds: ['images'], key_env: 'SEARCH_EUROPEANA_KEY', hosts: ['api.europeana.eu'],
    price_per_1000: 0,
    source: 'https://api.europeana.eu/record/v2/search.json',
    pricing_note: 'No provider fee: the API answers with a free key and Europeana publishes no price list. Its API terms page could not be read on 2026-11-13 (a bot check answered), so commercial use of the API is unconfirmed.',
    freshness: [],
    upstreams: ['europeana'],
    onboarding: 'Register an API key at pro.europeana.eu and send it as wskey. The key in the demo account works for a test, but it is rate limited.',
    filters: {
        license: 'native', commercial: 'local', format: 'unsupported', orientation: 'unsupported',
        size: 'unsupported', color: 'unsupported', after: 'local', type: 'unsupported', safe_search: 'unsupported',
    },
    async search(b, { fetchImpl, key }) {
        const q = new URLSearchParams({ wskey: key, query: b.q, rows: String(Math.min(b.limit, 100)), profile: 'rich' });
        if (b.license && RIGHTS[b.license]) q.set('qf', 'RIGHTS:' + RIGHTS[b.license]);
        const out = await requestFor(this.hosts, fetchImpl)('https://api.europeana.eu/record/v2/search.json?' + q);
        return (out.items || []).map((r, i) => {
            const { license, license_url } = licenseOf(r.rights);
            const title = (r.title || []).find(t => t) || '';
            const author = (r.dataProvider || []).find(p => p) || '';
            return {
                title,
                url: (r.edmIsShownBy || [])[0] || null,
                // A preview Europeana marks as no-distribute is not ours to show.
                thumbnail: r.previewNoDistribute ? null : (r.edmPreview || [])[0] || null,
                source_page: (r.edmIsShownAt || [])[0] || r.guid || null,
                width: null, height: null,
                license, license_url,
                author: author || null,
                attribution: [title, author, license ? '(' + license + ')' : ''].filter(Boolean).join(' — '),
                published: r.timestamp_created || null,
                indexed_on: r.timestamp_update || null,
                upstream: 'europeana', upstream_rank: i + 1,
            };
        });
    },
};
