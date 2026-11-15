'use strict';
// The general deep dive (workflow research.deep_dive, report ai.research@1; the owner, 11-15: Exchange's search deep
// dives any query, and Design's deep dive builds on it), end to end on the stub model:
//   - its price and pages per depth, before anyone signs in; Exchange may start it (its search), another service not;
//   - plan, search (MegaSource and the web engine on every planned search), choose (only pages the search found),
//     read (a page that cannot be read gives its place to a spare), analyse, write: six steps, all done, live state
//     with the plan's questions and every page read;
//   - the report: every page read with its notes, an answer whose citations are pages that were read, a receipt
//     with every model call; the run's own output is the same document; nobody else reads it; no sites to choose;
//   - the page reader on its own: the article's text, the date, refusing what is not a web page or is too thin.
// The search, MegaSource and the page fetches are fakes; nothing reaches the internet.
const assert = require('assert');
const { boot, request, token } = require('./helpers');
const { createReader } = require('../server/deep-dive/reader');

const USER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const words = (n, about) => Array.from({ length: n }, (_, i) => `${about}${i % 7 === 0 ? '.' : ''}`).join(' ');

function fakes() {
    const searched = [];
    const research = { async gather({ query }) { return {
        sources: [
            { url: 'https://example.org/heat-pumps-explained', title: 'Heat pumps explained', snippet: 'How a heat pump moves heat.', provider: 'wikipedia' },
            { url: 'https://example.org/heat-pump-costs-2026', title: 'What a heat pump costs in 2026', snippet: 'Prices and grants.', provider: 'search_fabric' },
        ], images: [], facts: [], providers: { wikipedia: { ok: true }, search_fabric: { ok: true }, query },
    }; } };
    const search = { async search(kind, body) {
        searched.push(body.q);
        return { results: [
            { title: `Results for ${body.q}`, url: `https://example.net/${encodeURIComponent(body.q).slice(0, 40)}`, snippet: 'A page from the search' },
            { title: 'A page that cannot be read', url: 'https://blocked.example/page', snippet: 'robots say no' },
            { title: 'Heat pumps in cold climates', url: 'https://example.com/cold', snippet: 'They work at -20 C.' },
        ], receipt: { engine: 'openvibe' } };
    } };
    const reads = [];
    const reader = { async read(url) {
        reads.push(url);
        if (/blocked\.example/.test(url)) return { status: 'skipped', url, reason: 'robots.txt disallows this page' };
        return { status: 'read', url, final_url: url, title: `Page ${url.split('/').pop()}`, site: 'Example', published: '2026-03-01', description: null, text: words(240, 'heat'), words: 240 };
    } };
    return { research, search, reader, searched, reads };
}

async function waitFor(h, id, tok, wanted, tries = 160) {
    let last = null;
    for (let i = 0; i < tries; i++) {
        const r = await request(h.base, 'GET', `/api/v1/deep-dives/${id}/state`, { tok });
        last = r.body && r.body.deep_dive;
        if (last && wanted.includes(last.status)) return last;
        await new Promise((ok) => setTimeout(ok, 200));
    }
    return last;
}

(async () => {
    // ── The reader on its own ──
    const page = (html, type = 'text/html; charset=utf-8', status = 200, headers = {}) => ({ ok: status < 300, status, headers: { get: (k) => ({ 'content-type': type, ...headers })[k.toLowerCase()] || null }, body: null, async text() { return html; } });
    const pages = {
        'https://news.example/a': page(`<html><head><title>Grid news</title><meta property="article:published_time" content="2026-02-03T08:00:00Z"></head><body><nav>Menu Home</nav><article><h1>The grid</h1><p>${words(120, 'power')}</p></article><footer>(c)</footer><script>steal()</script></body></html>`),
        'https://news.example/old': page('', 'text/html', 301, { location: 'http://news.example/a' }),
        'https://news.example/doc.pdf': page('%PDF', 'application/pdf'),
        'https://news.example/thin': page('<html><body><p>Sign in to read.</p></body></html>'),
    };
    const reader = createReader({ fetchImpl: async (url) => pages[url] || page('', 'text/html', 404), checkTarget: async () => {}, robots: { check: async (u) => (/private/.test(u) ? { allowed: false, reason: 'robots.txt disallows this page' } : { allowed: true }) } });
    let got = await reader.read('https://news.example/old');
    assert.deepStrictEqual([got.status, got.final_url, got.title, got.published], ['read', 'https://news.example/a', 'Grid news', '2026-02-03'], 'a redirect (to http, read as https) is followed; the title and the date');
    assert.ok(got.text.startsWith('# The grid') && !/Menu Home|steal/.test(got.text), 'the article, without the menu and the script');
    assert.strictEqual((await reader.read('https://news.example/doc.pdf')).reason, 'a PDF (not read as a web page)');
    assert.match((await reader.read('https://news.example/thin')).reason, /almost no text/);
    assert.match((await reader.read('https://news.example/private/x')).reason, /robots/);
    assert.match((await reader.read('https://news.example/gone')).reason, /404/);

    const f = fakes();
    const h = await boot({ env: { AI_DEEP_DIVE: '1', AI_DRILL: '0', AI_DESIGN_URL: 'https://design.invalid', AI_FREE_PROVIDERS: 'stub', AI_STUB_FALLBACK: 'true' }, research: f.research, search: f.search, deepDiveReader: f.reader, deepDiveFetch: async () => ({ ok: false, status: 404, async json() { return {}; }, async text() { return ''; } }) });
    try {
        // ── The price, before anyone signs in ──
        let r = await request(h.base, 'GET', '/api/v1/deep-dives/depths?kind=research');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual([r.body.kind, r.body.depths.map((d) => d.key), r.body.depths.map((d) => d.price_usd), r.body.depths.map((d) => d.pages)], ['research', ['quick', 'thorough', 'expert'], [0.1, 0.3, 0.8], [8, 16, 30]]);
        r = await request(h.base, 'GET', '/api/v1/deep-dives/depths');
        assert.strictEqual(r.body.kind, 'design', 'without kind: the design dive\'s depths, as before');

        // ── Exchange starts one from its search; a service that does not own it may not ──
        const exchange = token('exchange', ['ai.run.create'], { sub: 'svc:exchange', ns: ['ai.complete'] });
        const live = token('live', ['ai.run.create'], { sub: 'svc:live', ns: ['live.*'] });
        r = await request(h.base, 'POST', '/api/v1/deep-dives', { tok: live, body: { question: 'heat pumps', depth: 'quick', kind: 'research' } });
        assert.strictEqual(r.status, 403);
        r = await request(h.base, 'POST', '/api/v1/deep-dives', { tok: exchange, body: { question: 'Are heat pumps worth it in a cold climate?', depth: 'quick', kind: 'research', on_behalf_of: { type: 'user', id: USER } } });
        assert.strictEqual(r.status, 202, JSON.stringify(r.body));
        assert.deepStrictEqual([r.body.price_usd, r.body.deep_dive.kind, r.body.deep_dive.site_limit], [0.1, 'research', 8]);
        const id = r.body.deep_dive.id;

        const done = await waitFor(h, id, exchange, ['succeeded', 'failed', 'cancelled']);
        assert.strictEqual(done.status, 'succeeded', JSON.stringify(done.error));
        assert.deepStrictEqual(done.steps.map((s) => [s.key, s.status]), [['plan', 'done'], ['search', 'done'], ['choose', 'done'], ['read', 'done'], ['analyse', 'done'], ['write', 'done']]);
        assert.strictEqual(done.kind, 'research');
        assert.ok(done.plan && done.plan.questions.length >= 1, 'the plan\'s questions are in the live state');
        assert.ok(done.reads.length >= 2 && done.reads.some((x) => x.status === 'read'), 'every page read is in the live state');
        assert.ok(f.searched.includes('Are heat pumps worth it in a cold climate?'), 'the web engine ran on the question (and on each planned search the plan wrote)');

        // ── The report ──
        r = await request(h.base, 'GET', `/api/v1/deep-dives/${id}`, { tok: exchange });
        const report = r.body.deep_dive.report;
        assert.strictEqual(report.schema, 'ai.research@1');
        assert.strictEqual(report.input.question, 'Are heat pumps worth it in a cold climate?');
        const sourceIds = new Set(report.sources.map((s) => s.id));
        assert.ok(report.reads.every((x) => sourceIds.has(x.source_id)), 'every page read is a source the search found (none invented)');
        const blocked = report.reads.find((x) => /blocked\.example/.test(x.url));
        if (blocked) assert.deepStrictEqual([blocked.status, blocked.reason], ['skipped', 'robots.txt disallows this page'], 'a page that cannot be read says why');
        const readIds = new Set(report.reads.filter((x) => x.status === 'read').map((x) => x.source_id));
        assert.ok(report.receipt.pages_read >= 1 && report.receipt.pages_read === readIds.size);
        assert.ok(report.answer.summary.length > 0, 'an answer');
        for (const k of report.answer.key_points) assert.ok(k.sources.every((s) => readIds.has(s)), 'a key point cites only pages that were read');
        for (const step of ['plan', 'choose', 'analyse', 'write']) assert.ok(report.receipt.models.some((m) => m.step === step), `the receipt carries the ${step} call`);

        // The run's own output is the same document; nobody else reads it; it has no sites to choose.
        let run = null;
        for (let i = 0; i < 60; i++) {
            run = await request(h.base, 'GET', `/api/v1/runs/${id}`, { tok: exchange });
            if (run.body && run.body.run && run.body.run.output) break;
            await new Promise((ok) => setTimeout(ok, 100));
        }
        assert.strictEqual(run.body.run.output.schema, 'ai.research@1');
        assert.strictEqual(run.body.run.workflow.key, 'research.deep_dive');
        const other = token('other', ['ai.run.create'], { sub: 'svc:other', ns: ['research.*'] });
        assert.strictEqual((await request(h.base, 'GET', `/api/v1/deep-dives/${id}`, { tok: other })).status, 404);
        assert.strictEqual((await request(h.base, 'POST', `/api/v1/deep-dives/${id}/sites`, { tok: exchange, body: { start: true } })).status, 409);

        // The list has it, as research.
        r = await request(h.base, 'GET', '/api/v1/deep-dives?kind=research', { tok: exchange });
        assert.ok(r.body.deep_dives.some((d) => d.id === id && d.kind === 'research'));
    } finally {
        await h.stop();
    }
    process.stdout.write('deep dive (research): reader, price, Exchange only, six steps live, pages read and cited, receipt, owner checks ok\n');
})().catch((err) => { console.error(err); process.exit(1); });
