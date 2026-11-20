'use strict';
// Search v2 through an Exchange key (plan §W.7): POST /v1/search { q, depth } holds what every engine call may cost
// against the key's monthly cap, runs the engines side by side, and settles at what they really cost; a v1 call on
// the same key is unchanged.
const assert = require('node:assert/strict');
const { boot, request } = require('./helpers');
const { createKeys } = require('../server/platform/keys');

const json = (body) => new Response(JSON.stringify(body));

(async () => {
    const hosts = [];
    const h = await boot({
        env: { SEARCH_BRAVE_KEY: 'shared-brave-fixture', SEARCH_SERPER_KEY: 'shared-serper-fixture' },
        searchFetch: async (url) => {
            const host = new URL(url).hostname;
            hosts.push(host);
            if (host === 'google.serper.dev') return json({ organic: [{ title: 'Lantern', link: 'https://www.example.org/article/', snippet: 'A new lantern in Lisbon for winter visitors to see' }, { title: 'Serper only', link: 'https://serper.example/1', snippet: 's' }] });
            return json(require('./fixtures/search/brave.json').response);
        },
    });
    try {
        const keys = createKeys({ db: h.db });
        const made = await keys.create('usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', { name: 'Search', monthly_cap_usd: 1, allowed_models: ['openvibe'], expires_at: new Date(Date.now() + 60000).toISOString() });
        const month = () => h.db.prepare('SELECT spent,reserved FROM exchange_key_months WHERE key_id = ?').get(made.key.id);
        const settled = async () => { for (let i = 0; i < 50; i++) { const m = await month(); if (m && Number(m.reserved) === 0 && Number(m.spent) > 0) return m; await new Promise((r) => setTimeout(r, 20)); } return month(); };

        const r = await request(h.base, 'POST', '/v1/search', { tok: made.secret, body: { q: 'lantern', depth: 'fast' } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.receipt.engine, 'multi');
        assert.equal(r.body.receipt.depth, 'fast');
        assert.deepEqual([...new Set(hosts)].sort(), ['api.search.brave.com', 'google.serper.dev'], 'two engines at once');
        assert.equal(r.body.results.filter((x) => /example\.org\/article/.test(x.url)).length, 1, 'the page both found is one result');
        assert.equal(r.body.results[0].engines.length, 2);
        const m = await settled();
        assert.equal(Number(m.reserved), 0, 'the hold is released');
        assert.ok(Math.abs(Number(m.spent) - r.body.receipt.cost_usd) < 1e-9, `the key is charged what the calls cost (${m.spent} vs ${r.body.receipt.cost_usd})`);

        const one = await request(h.base, 'POST', '/v1/search', { tok: made.secret, body: { q: 'lantern' } });
        assert.equal(one.status, 200);
        assert.notEqual(one.body.receipt.engine, 'multi', 'a plain q stays one engine');

        const bad = await request(h.base, 'POST', '/v1/search', { tok: made.secret, body: { q: 'lantern', depth: 'bottomless' } });
        assert.equal(bad.status, 422);
        assert.match(JSON.stringify(bad.body), /depth must be one of/);
        console.log('exchange-search-depth: 3 checks passed');
    } finally {
        await h.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
