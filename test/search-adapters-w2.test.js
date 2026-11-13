'use strict';
const assert = require('node:assert/strict');
const { createSearch } = require('../server/search');
const { redact, redactError } = require('../server/redact');
const { sendError } = require('../server/util');
const fixture = name => require('./fixtures/search/' + name + '.json');
const KEY = 'fixture-search-key';
const json = value => new Response(JSON.stringify(value), { status: 200 });
const params = (url) => new URL(url).searchParams;

(async () => {
    // ── Mojeek: an independent index, the key in the query string, its own freshness ────────────────
    {
        let seen = null;
        const search = createSearch({ env: { SEARCH_MOJEEK_KEY: KEY }, fetchImpl: async (url) => { seen = new URL(url); return json(fixture('mojeek').response); } });
        const out = await search.search('web', { q: 'lantern', engine: 'mojeek' });
        assert.equal(seen.hostname, 'api.mojeek.com');
        assert.equal(seen.pathname, '/search');
        assert.equal(seen.searchParams.get('api_key'), KEY, 'the key travels in the query string');
        assert.equal(seen.searchParams.get('fmt'), 'json');
        assert.equal(seen.searchParams.get('t'), '10', 'the Startup plan answers ten results');
        assert.equal(out.results[0].title, 'Lantern');
        assert.equal(out.results[0].snippet, 'A new lantern');
        assert.equal(out.results[0].published, '2026-11-08T12:00:00Z');
        await search.search('web', { q: 'lantern', engine: 'mojeek', freshness: 'day' });
        assert.equal(seen.searchParams.get('since'), 'day', 'Mojeek takes its own since parameter');
        const card = (await search.engines()).find(e => e.id === 'mojeek');
        assert.equal(card.price_per_1000, 2.65);
        assert.equal(card.checked_on, '2026-11-13');
        assert.equal(card.source, 'https://www.mojeek.com/services/search/web-search-api');
        assert.match(card.pricing_note, /GBP/);
    }

    // ── Parallel: a research index, the key in a header, an objective and keyword queries ─────────────
    {
        let seen = null, body = null;
        const search = createSearch({ env: { SEARCH_PARALLEL_KEY: KEY }, fetchImpl: async (url, init) => {
            seen = new URL(url); body = JSON.parse(init.body);
            return json(fixture('parallel').response);
        } });
        const out = await search.search('web', { q: 'lantern', engine: 'parallel' });
        assert.equal(seen.hostname, 'api.parallel.ai');
        assert.equal(seen.pathname, '/v1/search');
        assert.deepEqual(body.search_queries, ['lantern'], 'Parallel needs at least one keyword query');
        assert.match(body.objective, /lantern/);
        assert.equal(body.mode, 'fast');
        assert.equal(out.results[0].snippet, 'A new lantern');
        const card = (await search.engines()).find(e => e.id === 'parallel');
        assert.equal(card.price_per_1000, 1);
        assert.equal(card.checked_on, '2026-11-13');
        assert.equal(card.source, 'https://docs.parallel.ai/getting-started/pricing');
    }

    // ── You.com: the key in a header, and a person's own key only ─────────────────────────────────
    {
        let seen = null, body = null, headers = null;
        const search = createSearch({ env: { SEARCH_YOU_KEY: KEY }, fetchImpl: async (url, init) => {
            seen = new URL(url); body = JSON.parse(init.body); headers = init.headers;
            return json(fixture('you').response);
        } });
        const out = await search.search('web', { q: 'lantern', engine: 'you' });
        assert.equal(seen.hostname, 'ydc-index.io');
        assert.equal(seen.pathname, '/v1/search');
        assert.equal(headers['X-API-Key'], KEY, 'the key is a header, never the query string');
        assert.equal(body.query, 'lantern');
        assert.equal(body.count, 10);
        assert.equal(out.results[0].published, '2026-11-08T12:00:00Z');
        await search.search('web', { q: 'lantern', engine: 'you', freshness: 'month' });
        assert.equal(body.freshness, 'month');
        const card = (await search.engines()).find(e => e.id === 'you');
        assert.equal(card.manual_only, true, 'their terms forbid reselling the service: the key is the own one');
        assert.equal(card.price_per_1000, 5);
        assert.equal(card.source, 'https://you.com/docs/administration/billing');
    }

    // ── DataForSEO: HTTP Basic, one live SERP, Google as the upstream ────────────────────────────────
    {
        let seen = null, body = null, headers = null;
        const search = createSearch({ env: { SEARCH_DATAFORSEO_KEY: KEY }, fetchImpl: async (url, init) => {
            seen = new URL(url); body = JSON.parse(init.body); headers = init.headers;
            return json(fixture('dataforseo').response);
        } });
        const out = await search.search('web', { q: 'lantern', engine: 'dataforseo' });
        assert.equal(seen.hostname, 'api.dataforseo.com');
        assert.equal(seen.pathname, '/v3/serp/google/organic/live/regular', 'live mode, one POST');
        assert.equal(Buffer.from(headers.authorization.replace('Basic ', ''), 'base64').toString('utf8'), KEY, 'the key is Basic auth');
        assert.equal(body.task[0].keyword, 'lantern');
        assert.equal(body.task.length, 1, 'a live SERP call carries one task');
        assert.equal(out.results[0].title, 'Lantern');
        assert.equal(out.results[0].published, null, 'a Google result carries no publication date');
        const card = (await search.engines()).find(e => e.id === 'dataforseo');
        assert.equal(card.price_per_1000, 2);
        assert.equal(card.source, 'https://dataforseo.com/pricing/google-serp/google-organic-serp-api');
    }

    // ── Europeana: an open catalog, the rights of the object, not the licence of the metadata ───────
    {
        let seen = null;
        const response = fixture('europeana').response;
        const search = createSearch({ env: { SEARCH_EUROPEANA_KEY: KEY }, fetchImpl: async (url) => { seen = new URL(url); return json(response); } });
        const out = await search.search('images', { q: 'cat', engine: 'europeana' });
        assert.equal(seen.hostname, 'api.europeana.eu');
        assert.equal(seen.pathname, '/record/v2/search.json');
        assert.equal(seen.searchParams.get('wskey'), KEY);
        const row = out.results[0];
        assert.equal(row.license, 'cc0');
        assert.equal(row.rights.family, 'public_domain', 'the record says the object is CC0');
        assert.equal(row.rights.commercial_use, true);
        assert.equal(row.rights.standalone_redistribution, true);
        await search.search('images', { q: 'cat', engine: 'europeana', license: 'cc0' });
        assert.equal(seen.searchParams.get('qf'), 'RIGHTS:http://creativecommons.org/publicdomain/zero/1.0/');
        // The API's own metadata licence is CC0 for every record; the object's rights are what the record says.
        const inc = JSON.parse(JSON.stringify(response));
        inc.items[0].rights = ['http://rightsstatements.org/vocab/InC/1.0/'];
        const other = createSearch({ env: { SEARCH_EUROPEANA_KEY: KEY }, fetchImpl: async () => json(inc) });
        const unknown = await other.search('images', { q: 'cat', engine: 'europeana' });
        assert.equal(unknown.results[0].license, 'inc');
        assert.equal(unknown.results[0].rights.family, 'unknown', 'rights the record does not clear stay unknown');
        assert.equal(unknown.results[0].rights.status, 'provider_claimed', 'the catalog claims a licence it does not clear');
        const card = (await search.engines()).find(e => e.id === 'europeana');
        assert.equal(card.price_per_1000, 0);
        assert.equal(card.checked_on, '2026-11-13');
    }

    // ── NASA: a public catalog, no key, and public domain only for a NASA-created picture ────────────
    {
        const response = fixture('nasa').response;
        const search = createSearch({ env: {}, fetchImpl: async (url) => {
            const u = new URL(url);
            return json(u.pathname.endsWith('/collection.json') ? fixture('nasa-assets') : response);
        } });
        const out = await search.search('images', { q: 'lantern', engine: 'nasa' });
        assert.equal(out.results[0].license, 'public_domain', 'a NASA-created picture is public domain');
        assert.equal(out.results[0].rights.family, 'public_domain');
        assert.equal(out.results[0].rights.commercial_use, true);
        assert.equal(out.results[0].author, 'NASA/JPL-Caltech');
        // A record that names another creator keeps its rights unknown.
        const other = JSON.parse(JSON.stringify(response));
        other.collection.items[0].data[0].secondary_creator = 'A photographer';
        const third = createSearch({ env: {}, fetchImpl: async (url) => {
            const u = new URL(url);
            return json(u.pathname.endsWith('/collection.json') ? fixture('nasa-assets') : other);
        } });
        const unknown = await third.search('images', { q: 'lantern', engine: 'nasa' });
        assert.equal(unknown.results[0].license, null);
        assert.equal(unknown.results[0].rights.family, 'unknown', 'the rights of someone else\'s picture stay unknown');
        const card = (await search.engines()).find(e => e.id === 'nasa');
        assert.equal(card.price_per_1000, 0);
        assert.equal(card.checked_on, '2026-11-13');
    }

    // ── DataForSEO images: a SERP proxy, so the rights of the picture are unknown ─────────────────────
    {
        let seen = null, headers = null;
        const search = createSearch({ env: { SEARCH_DATAFORSEO_KEY: KEY }, fetchImpl: async (url, init) => {
            seen = new URL(url); headers = init.headers;
            return json(fixture('dataforseo-images').response);
        } });
        const out = await search.search('images', { q: 'cat', engine: 'dataforseo-images' });
        assert.equal(seen.pathname, '/v3/serp/google/images/live/advanced');
        assert.ok(headers.authorization.startsWith('Basic '));
        const row = out.results[0];
        assert.equal(row.url, 'https://images.example.org/cat.jpg');
        assert.equal(row.upstream, 'google');
        assert.equal(row.license, null);
        assert.equal(row.rights.status, 'unknown', 'a discovery engine grants no rights');
        assert.equal(row.rights.family, 'third_party');
        const card = (await search.engines()).find(e => e.id === 'dataforseo-images');
        assert.equal(card.price_per_1000, 2);
        assert.equal(card.source, 'https://dataforseo.com/pricing/google-serp/google-images-serp-api');
    }

    // ── Smithsonian: an open catalog, the key in the query string, a picture only for a public domain ──
    {
        let seen = null;
        const search = createSearch({ env: { SEARCH_SMITHSONIAN_KEY: KEY }, fetchImpl: async (url) => { seen = new URL(url); return json(fixture('smithsonian').response); } });
        const out = await search.search('images', { q: 'lantern', engine: 'smithsonian' });
        assert.equal(seen.hostname, 'api.si.edu');
        assert.equal(seen.pathname, '/openaccess/api/v1.0/search');
        assert.equal(seen.searchParams.get('api_key'), KEY);
        assert.match(seen.searchParams.get('q'), /online_visual_material:true/, 'their own example asks for picture records');
        const row = out.results[0];
        assert.equal(row.url, 'https://ids.si.edu/ids/deliveryService?id=fixture-image-1&max=1000');
        assert.equal(row.license, 'cc0');
        assert.equal(row.rights.family, 'public_domain', 'a record with a media file is a public domain object');
        assert.equal(row.rights.commercial_use, true);
        const card = (await search.engines()).find(e => e.id === 'smithsonian');
        assert.equal(card.price_per_1000, 0);
        assert.equal(card.checked_on, '2026-11-13');
        assert.equal(card.source, 'https://www.si.edu/openaccess/devtools');
    }

    // ── The breaker is shared: two services, one Valkey, one open circuit ────────────────────────────
    {
        const store = new Map();
        const written = [];
        const valkey = {
            key: (...parts) => 'test:' + parts.join(':'),
            client: {
                async get(k) { return store.has(k) ? store.get(k) : null; },
                async set(k, v, mode, seconds) { store.set(k, v); written.push({ k, v, mode, seconds }); return 'OK'; },
                async del(k) { store.delete(k); return 1; },
            },
        };
        const failing = async (url) => { throw new Error('upstream is down: ' + url); };
        const first = createSearch({ env: { SEARCH_SERPAPI_KEY: KEY }, valkey, fetchImpl: failing });
        const second = createSearch({ env: { SEARCH_SERPAPI_KEY: KEY }, valkey, fetchImpl: failing });
        await first.search('web', { q: 'cat', engine: 'serpapi' }).catch(() => {});
        const key = 'test:search:circuit:shared:serpapi';
        assert.ok(store.has(key), 'the circuit lives at search:circuit:<scope>:<engine>');
        assert.equal(written.at(-1).mode, 'EX', 'the open-until time is the TTL');
        assert.equal(written.at(-1).seconds, 60);
        // The other service sees the same open circuit.
        assert.equal((await first.engines()).find(e => e.id === 'serpapi').healthy, false);
        assert.equal((await second.engines()).find(e => e.id === 'serpapi').healthy, false);
        // Without Valkey the breaker is a Map in the process: another service does not see it.
        const alone = createSearch({ env: { SEARCH_SERPAPI_KEY: KEY }, fetchImpl: failing });
        await alone.search('web', { q: 'cat', engine: 'serpapi' }).catch(() => {});
        assert.equal((await alone.engines()).find(e => e.id === 'serpapi').healthy, false);
        assert.equal((await createSearch({ env: { SEARCH_SERPAPI_KEY: KEY } }).engines()).find(e => e.id === 'serpapi').healthy, true);
    }

    // ── A key in a query string never reaches an error, a receipt or a log ───────────────────────────
    {
        const SECRET = 'a-real-looking-key-9f2c';
        // The redaction masks every name a provider, a proxy or a client library uses for a secret.
        for (const name of ['api_key', 'apikey', 'key', 'token', 'access_token', 'app_id', 'app_key', 'client_secret'])
            assert.ok(!redact('https://example.org/search?' + name + '=' + SECRET).includes(SECRET), name + ' is masked');
        assert.ok(redact('https://example.org/search?api_key=' + SECRET + '&q=cat').includes('api_key=REDACTED'));
        assert.ok(!redact('authorization: Bearer ' + SECRET).includes(SECRET));
        for (const [id, keyEnv, url] of [
            ['serpapi', 'SEARCH_SERPAPI_KEY', 'https://serpapi.com/search.json?engine=google&q=cat&api_key=' + SECRET],
            ['pixabay', 'SEARCH_PIXABAY_KEY', 'https://pixabay.com/api/?key=' + SECRET + '&q=cat'],
        ]) {
            const logged = [];
            const log = { error: (m) => logged.push(String(m)), warn: (m) => logged.push(String(m)), log: (m) => logged.push(String(m)) };
            const res = { headersSent: false, statusCode: 500, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(v) { this.body = String(v); } };
            const search = createSearch({ env: { [keyEnv]: SECRET }, fetchImpl: async (u) => { throw new Error('GET ' + u + ' failed'); } });
            const error = await search.search(id === 'pixabay' ? 'images' : 'web', { q: 'cat', engine: id }).catch(e => e);
            assert.ok(error, id + ' fails');
            assert.ok(!JSON.stringify(error).includes(SECRET), id + ': the error carries no key');
            assert.ok(!JSON.stringify(error.attempts || []).includes(SECRET), id + ': the receipt carries no key');
            sendError(res, error, {}, log);
            assert.ok(!JSON.stringify(res.body || '').includes(SECRET), id + ': the answer carries no key');
            // An unexpected error reaches the API layer and its stack is written to the log.
            const raw = new Error('GET ' + url + ' failed');
            sendError(res, raw, {}, log);
            assert.ok(logged.length, id + ': the error is logged');
            assert.ok(!JSON.stringify(logged).includes(SECRET), id + ': the log carries no key');
            assert.ok(!JSON.stringify(res.body || '').includes(SECRET), id + ': the answer carries no key');
            // And the upstream error itself is redacted before it can be written anywhere.
            const upstream = new Error('GET ' + url + ' failed');
            redactError(upstream);
            assert.ok(!upstream.message.includes(SECRET), id + ': the upstream error is redacted');
        }
    }

    console.log('search adapters (11-13): request shapes, auth placement, rights, tariffs, the shared circuit and the redaction passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
