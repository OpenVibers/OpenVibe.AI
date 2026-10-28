'use strict';
// SF-4: MegaSource asks the Search Fabric's web scope first, as AI's service principal, and keeps each page's
// provider, date and URL for the citation. DeepSeek remains the fallback when Search is off, refuses or answers
// nothing, and Search's own ladder never makes research ask Search back in a loop.

const assert = require('assert');
const http = require('http');
const { createResearch } = require('../server/research');
const { createSearchFabric } = require('../server/research/search-fabric');
const { createResearchFetch } = require('./fixtures/research-fetch');
const { boot, request, token, suite } = require('./helpers');

const t = suite('research fabric');
const quiet = { log() {}, warn() {}, error() {} };

t.test('configuration: the fabric is on by default, pointed by OV_SEARCH_INTERNAL_URL, and AI_RESEARCH_SEARCH=0 turns it off', () => {
    const { load } = require('../server/config');
    const on = load({ NODE_ENV: 'test', OV_SEARCH_INTERNAL_URL: 'http://search.test:4710' }).research.fabric;
    assert.deepStrictEqual([on.enabled, on.url, on.clientId], [true, 'http://search.test:4710', 'ai']);
    assert.strictEqual(load({ NODE_ENV: 'test', AI_RESEARCH_SEARCH: '0' }).research.fabric.enabled, false);
});

async function listen(handler) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
    };
}

function readBody(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            let json = null;
            try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
            resolve({ raw, json });
        });
    });
}

function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

t.test('the fabric client asks POST /api/v1/query for the web scope, as a service token, and keeps provider/date/url', async () => {
    const seen = [];
    const search = await listen(async (req, res) => {
        const { json: body } = await readBody(req);
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
        json(res, 200, {
            results: [
                {
                    scope: 'web', kind: 'page', title: 'Fabric page', url: 'https://example.org/fabric', site: 'example.org',
                    snippet: 'A fabric snippet', published_at: '2026-10-01T00:00:00Z', retrieved_at: '2026-10-28T12:00:00Z',
                    provider: 'brave', owner: null, type: null, id: null, image: null, score: null,
                },
                {
                    scope: 'web', kind: 'page', title: 'No dates', url: 'https://example.org/nodate', site: 'example.org',
                    snippet: 'x', published_at: null, retrieved_at: null, provider: 'deepseek',
                },
            ],
            groups: { web: 2 },
            citations: [],
            route: { explain: [{ scope: 'web', step: 'brave', ok: true, count: 1 }], cost_usd: 0.0004 },
            next_cursor: null,
        });
    });
    const fabric = createSearchFabric({
        config: { url: search.url, timeoutMs: 2000, networkUrl: 'http://127.0.0.1:9' },
        env: { OV_OAUTH_CLIENT_SECRET: 'x'.repeat(40) },
        fetchImpl: globalThis.fetch,
        tokens: { getToken: async () => 'svc-search' },
    });
    try {
        const page = await fabric.search('solar eclipse', { limit: 8 });
        assert.deepStrictEqual([seen[0].method, seen[0].url, seen[0].auth], ['POST', '/api/v1/query', 'Bearer svc-search']);
        assert.strictEqual(seen[0].body.q, 'solar eclipse');
        assert.deepStrictEqual(seen[0].body.scopes, ['web']);
        assert.strictEqual(seen[0].body.depth, 'standard');
        assert.strictEqual(seen[0].body.limit, 8);
        assert.strictEqual(page.results[0].provider, 'brave');
        assert.strictEqual(page.results[0].date, '2026-10-01T00:00:00Z');
        assert.strictEqual(page.results[0].retrieved_at, '2026-10-28T12:00:00Z');
        assert.strictEqual(page.results[0].url, 'https://example.org/fabric');
        assert.ok(page.results[1].retrieved_at, 'a missing read date is filled at read time');
        assert.strictEqual(page.route.cost_usd, 0.0004);
    } finally { await search.close(); }
});

t.test('research uses the fabric first, and its citation keeps the provider, date and URL', async () => {
    const calls = [];
    const fabric = {
        available: () => ({ configured: true }),
        status: () => ({ configured: true }),
        search: async (q, opts) => {
            calls.push({ q, opts });
            return {
                results: [{
                    url: 'https://example.org/fabric', title: 'Fabric page', site: 'example.org',
                    snippet: 'A fabric snippet', summary: '', content: 'A fabric snippet',
                    date: '2026-10-02T03:04:05Z', retrieved_at: '2026-10-28T06:07:08Z',
                    provider: 'brave', authority: -1, score: 2.2,
                }],
                groups: { web: 1 },
                citations: [],
                route: { explain: [{ scope: 'web', step: 'brave', ok: true, count: 1 }], cost_usd: 0.0004 },
                next_cursor: null,
            };
        },
    };
    const web = createResearchFetch();
    const r = createResearch({ config: { deepseekKey: 'sk-test', deepseekDaily: 10 }, env: {}, fetchImpl: web.fetchImpl, fabric, log: quiet });
    const out = await r.gather({ query: 'SQLite', max_images: 0 });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].opts.depth, 'standard');
    const source = out.sources.find((s) => s.url === 'https://example.org/fabric');
    assert.ok(source, JSON.stringify(out.sources.map((s) => s.url)));
    assert.strictEqual(source.published_at, '2026-10-02T03:04:05Z');
    assert.strictEqual(source.retrieved_at, '2026-10-28T06:07:08Z');
    assert.strictEqual(source.provenance.provider, 'brave');
    assert.strictEqual(source.provenance.via, 'search_fabric');
    assert.strictEqual(out.providers.search_fabric.ok, true);
    assert.strictEqual(out.providers.search_fabric.cost_usd, 0.0004);
    assert.strictEqual(out.usage.search_fabric, 1);
    assert.strictEqual(out.usage.search_fabric_cost_usd, 0.0004, 'the fabric route cost is reported');
    assert.strictEqual(out.usage.cost_usd, 0, 'a paid fabric step is Search\'s cost, not billed to this run twice');
    assert.ok(!web.calls.some((c) => c.host === 'api.deepseek.com'), 'DeepSeek is not called when the fabric answers');
});

t.test('DeepSeek is the fallback when the fabric refuses or answers nothing', async () => {
    for (const [label, search] of [
        ['refuses', async () => { throw new Error('Search is down'); }],
        ['answers nothing', async () => ({ results: [], groups: { web: 0 }, citations: [], route: { explain: [], cost_usd: 0 }, next_cursor: null })],
    ]) {
        const fabric = { available: () => ({ configured: true }), status: () => ({ configured: true }), search };
        const web = createResearchFetch();
        const r = createResearch({ config: { deepseekKey: 'sk-test' }, env: {}, fetchImpl: web.fetchImpl, fabric, log: quiet });
        const out = await r.gather({ query: `SQLite ${label}`, max_images: 0 });
        assert.strictEqual(out.providers.search_fabric.ok, false, label);
        assert.strictEqual(out.providers.deepseek.ok, true, label);
        assert.ok(out.sources.some((s) => s.provenance.provider === 'deepseek' && !s.provenance.via), `${label}: a direct DeepSeek source`);
        assert.strictEqual(out.usage.deepseek_search, 1, label);
        assert.ok(out.usage.cost_usd >= 0.0015, `${label}: the fallback cost is counted`);
    }
});

t.test('POST /api/v1/research: the token scope is search.query.delegate and the stored citation keeps provider/date/url', async () => {
    let tokenRequest = null;
    const network = await listen(async (req, res) => {
        const { raw } = await readBody(req);
        tokenRequest = Object.fromEntries(new URLSearchParams(raw));
        json(res, 200, { access_token: 'svc-ai-search', token_type: 'Bearer', expires_in: 300, scope: 'search.query.delegate' });
    });
    let query = null;
    const search = await listen(async (req, res) => {
        const { json: body } = await readBody(req);
        query = { method: req.method, url: req.url, auth: req.headers.authorization, body };
        json(res, 200, {
            results: [{
                scope: 'web', kind: 'page', title: 'Fabric page', url: 'https://example.org/fabric-e2e', site: 'example.org',
                snippet: 'A fabric snippet', published_at: '2026-10-03T00:00:00Z', retrieved_at: '2026-10-28T01:02:03Z',
                provider: 'brave', owner: null, type: null, id: null, image: null, score: null,
            }],
            groups: { web: 1 },
            citations: [],
            route: { explain: [{ scope: 'web', step: 'brave', ok: true, count: 1 }], cost_usd: 0.0004 },
            next_cursor: null,
        });
    });
    const fixture = createResearchFetch();
    const fetchImpl = async (url, init) => {
        const s = String(url);
        if (s.startsWith(network.url) || s.startsWith(search.url)) return fetch(s, init);
        return fixture.fetchImpl(url, init);
    };
    const researcher = createResearch({
        config: {
            timeoutMs: 15000,
            deepseek: false,
            fabric: { enabled: true, url: search.url, networkUrl: network.url, clientId: 'ai', timeoutMs: 2000 },
        },
        env: { OV_OAUTH_CLIENT_SECRET: 'x'.repeat(40) },
        fetchImpl,
        log: quiet,
    });
    const h = await boot({ research: researcher });
    try {
        const tok = token('wiki', ['ai.run.create'], { ns: ['research.*'] });
        const res = await request(h.base, 'POST', '/api/v1/research?wait=15000', { tok, body: { query: 'SQLite', max_images: 0 } });
        assert.strictEqual(res.status, 201, res.text);
        assert.strictEqual(res.body.run.status, 'succeeded', JSON.stringify(res.body.run.error));
        assert.deepStrictEqual([tokenRequest.grant_type, tokenRequest.client_id, tokenRequest.audience, tokenRequest.scope],
            ['client_credentials', 'ai', 'openvibe.search', 'search.query.delegate']);
        assert.deepStrictEqual([query.method, query.url, query.auth], ['POST', '/api/v1/query', 'Bearer svc-ai-search']);
        assert.deepStrictEqual(query.body.scopes, ['web']);
        // research.gather's output sources are the numbered citations its callers use.
        const citation = res.body.run.output.sources.find((s) => s.url === 'https://example.org/fabric-e2e');
        assert.ok(citation, JSON.stringify(res.body.run.output.sources.map((s) => s.url)));
        assert.strictEqual(citation.published_at, '2026-10-03T00:00:00Z');
        assert.strictEqual(citation.retrieved_at, '2026-10-28T01:02:03Z');
        assert.strictEqual(citation.provenance.provider, 'brave');
        assert.strictEqual(citation.provenance.via, 'search_fabric');
    } finally {
        await h.stop();
        await network.close();
        await search.close();
    }
});

t.test('Search asking AI for a web source keeps DeepSeek and does not ask Search back', async () => {
    let fabricCalls = 0;
    const fabric = {
        available: () => ({ configured: true }),
        status: () => ({ configured: true }),
        search: async () => { fabricCalls += 1; return { results: [], route: { explain: [], cost_usd: 0 } }; },
    };
    const web = createResearchFetch();
    const researcher = createResearch({ config: { deepseekKey: 'sk-test', deepseekDaily: 10 }, env: {}, fetchImpl: web.fetchImpl, fabric, log: quiet });
    const h = await boot({ research: researcher });
    try {
        const tok = token('search', ['ai.run.create'], { ns: ['research.*'] });
        const res = await request(h.base, 'POST', '/api/v1/research?wait=15000', { tok, body: { query: 'SQLite', max_images: 0 } });
        assert.strictEqual(res.status, 201, res.text);
        assert.strictEqual(fabricCalls, 0, 'the fabric is not asked back');
        assert.ok(res.body.run.output.sources.some((s) => s.provenance.provider === 'deepseek' && !s.provenance.via), 'DeepSeek answered directly');
    } finally { await h.stop(); }
});

t.run();
