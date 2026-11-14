'use strict';
const { requestFor, post, web } = require('../transport');
// DataForSEO is a SERP proxy for Google: the upstream index is Google, not DataForSEO's own.
// It authenticates with HTTP Basic: the key is the login and the password joined by a colon.
// Live mode answers in one POST; the queued modes are cheaper but take minutes, so they are not used here.
const basic = (key) => ({ authorization: 'Basic ' + Buffer.from(String(key)).toString('base64') });
module.exports = {
    id: 'dataforseo', byok: true, checked_on: '2026-11-13',
    kinds: ['web'], key_env: 'SEARCH_DATAFORSEO_KEY', hosts: ['api.dataforseo.com'],
    class: 'serp_proxy',
    price_per_1000: 2,
    source: 'https://dataforseo.com/pricing/google-serp/google-organic-serp-api',
    pricing_note: 'Live mode $0.002 per SERP = $2.00 per 1,000 SERPs (10 organic results each); the queued modes are cheaper ($0.60 per 1,000) but take minutes. $50 minimum top-up; the balance never expires.',
    freshness: [],
    onboarding: 'DataForSEO issues a login and a password: store them as one key, login:password. The account needs a $50 top-up; white label, MCP and reselling the raw API need a separate agreement.',
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)('https://api.dataforseo.com/v3/serp/google/organic/live/regular', post({
            task: [{ keyword: b.q, location_code: 2840, language_code: 'en', device: 'desktop' }],
        }, basic(key)));
        const items = out.tasks?.[0]?.result?.[0]?.items || [];
        return items.filter(r => r.type === 'organic').map(r => web({ ...r, url: r.url }, r.description, null));
    },
};
