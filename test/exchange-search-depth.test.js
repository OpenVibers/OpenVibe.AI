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
        env: { SEARCH_BRAVE_KEY: 'shared-brave-fixture', SEARCH_SERPER_KEY: 'shared-serper-fixture', SEARCH_JINA_KEY: 'shared-jina-fixture' },
        searchFetch: async (url, init = {}) => {
            const host = new URL(url).hostname;
            hosts.push(host);
            // "slow …" searches: Serper takes a while, so a stop or a hang-up lands while the search runs.
            if (host === 'google.serper.dev' && /slow/.test(String(init.body || ''))) await new Promise((r) => setTimeout(r, 1200));
            if (host === 'r.jina.ai') return json({ code: 200, data: { title: 'Lantern', url: 'https://www.example.org/article/', content: 'A new lantern in Lisbon for winter visitors to see.', usage: { tokens: 1000 } } });
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
        assert.deepEqual([...new Set(hosts)].sort(), ['api.search.brave.com', 'google.serper.dev', 'search.openvibe.network'], 'two engines at once, and OpenVibe\'s own index alongside (free)');
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
        // stream: Server-Sent Events, and the key is charged what the calls cost, as with JSON.
        const before = await month();
        const res = await fetch(`${h.base}/v1/search`, { method: 'POST', headers: { authorization: `Bearer ${made.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ q: 'lantern', depth: 'fast', stream: true, cache: false }) });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /^text\/event-stream/);
        const text = await res.text();
        const events = text.split('\n\n').filter(Boolean).map((block) => ({ event: (block.match(/^event: (.+)$/m) || [])[1], data: JSON.parse((block.match(/^data: (.+)$/m) || [])[1]) }));
        assert.deepEqual(events.map((e) => e.event), ['started', 'results', 'done']);
        assert.match(events[0].data.id, /^srch_/, 'the stream names the search, for POST /v1/search/stop');
        assert.equal(events[1].data.stage, 'merged');
        assert.equal(events[2].data.receipt.engine, 'multi');
        let after = null;
        for (let i = 0; i < 50; i++) { after = await month(); if (Number(after.reserved) === 0 && Number(after.spent) > Number(before.spent)) break; await new Promise((r) => setTimeout(r, 20)); }
        assert.ok(Math.abs((Number(after.spent) - Number(before.spent)) - events[2].data.receipt.cost_usd) < 1e-9, 'the streamed search settles at its cost');
        const badStream = await request(h.base, 'POST', '/v1/search', { tok: made.secret, body: { q: 'lantern', depth: 'bottomless', stream: true } });
        assert.equal(badStream.status, 422, 'a bad streamed request is still a plain 422');

        // ── Stopping early (the owner, 11-21: "if an AI found what it needed it can end the search early") ──
        const eventsOf = (text) => text.split('\n\n').filter(Boolean).map((block) => ({ event: (block.match(/^event: (.+)$/m) || [])[1], data: JSON.parse((block.match(/^data: (.+)$/m) || [])[1]) }));
        const slow = { q: 'slow lantern', depth: 'fast', steps: { pages_read: 2 }, cache: false };
        // POST /v1/search/stop { id }: the search answers its caller with what it found, charged only what ran.
        const before2 = await month();
        const streamed = fetch(`${h.base}/v1/search`, { method: 'POST', headers: { authorization: `Bearer ${made.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...slow, stream: true, search_id: 'stop-me-0001' }) }).then((x) => x.text());
        await new Promise((r) => setTimeout(r, 300));
        const other = await keys.create('usr_01JAB2C3D4E5F6G7H8J9K0MNPR', { name: 'Other', monthly_cap_usd: 1, allowed_models: ['openvibe'], expires_at: new Date(Date.now() + 60000).toISOString() });
        const notMine = await request(h.base, 'POST', '/v1/search/stop', { tok: other.secret, body: { id: 'stop-me-0001' } });
        assert.equal(notMine.status, 404, 'only whoever started a search may stop it');
        const stop = await request(h.base, 'POST', '/v1/search/stop', { tok: made.secret, body: { id: 'stop-me-0001' } });
        assert.equal(stop.status, 200, JSON.stringify(stop.body)); assert.equal(stop.body.stopped, true);
        const got = eventsOf(await streamed);
        assert.equal(got[0].data.id, 'stop-me-0001');
        const end = got[got.length - 1];
        assert.equal(end.event, 'done');
        assert.equal(end.data.receipt.stopped, 'stopped');
        assert.ok(!(end.data.receipt.reads || []).some((x) => x.status === 'ok'), 'no page was read after the stop');
        let after2 = null;
        for (let i = 0; i < 100; i++) { after2 = await month(); if (Number(after2.reserved) === 0 && Number(after2.spent) > Number(before2.spent)) break; await new Promise((r) => setTimeout(r, 20)); }
        assert.ok(Math.abs((Number(after2.spent) - Number(before2.spent)) - end.data.receipt.cost_usd) < 1e-9, 'charged what ran');
        assert.ok(end.data.receipt.cost_usd < end.data.receipt.hold_usd, `less than the hold (${end.data.receipt.cost_usd} < ${end.data.receipt.hold_usd})`);
        assert.equal((await request(h.base, 'POST', '/v1/search/stop', { tok: made.secret, body: { id: 'stop-me-0001' } })).status, 404, 'a finished search is not running');

        // A client that hangs up stops the search too, and the hold settles at what ran (it used to settle at the hold).
        const before3 = await month();
        const ac = new AbortController();
        const res3 = await fetch(`${h.base}/v1/search`, { method: 'POST', signal: ac.signal, headers: { authorization: `Bearer ${made.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...slow, q: 'slow lantern hang-up', stream: true }) });
        const reader = res3.body.getReader();
        const first = new TextDecoder().decode((await reader.read()).value);
        assert.match(first, /event: started/);
        ac.abort();
        let after3 = null;
        for (let i = 0; i < 150; i++) { after3 = await month(); if (Number(after3.reserved) === 0 && Number(after3.spent) > Number(before3.spent)) break; await new Promise((r) => setTimeout(r, 20)); }
        assert.equal(Number(after3.reserved), 0, 'the hold is released');
        const spent3 = Number(after3.spent) - Number(before3.spent);
        assert.ok(Math.abs(spent3 - 0.006) < 1e-9, `charged the two engine calls that ran (${spent3}), not the reads' hold too`);
        console.log('exchange-search-depth: 6 checks passed');
    } finally {
        await h.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
