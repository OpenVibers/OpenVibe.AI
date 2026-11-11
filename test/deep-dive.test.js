'use strict';
// Deep dives end to end: the price before the run, the Exchange service allowance, the seven steps with live
// progress, choosing sites (add, drop, start), the report (ai.deep-dive@1) with its captures and receipt, cancel
// stopping the spend, and a caller that may not read someone else's run. Search, research, capture and the Design
// registers are fakes; no test reaches the internet and no outside site is read.
const assert = require('assert');
const { boot, request, token } = require('./helpers');

const ALPHA = '01JAB2C3D4E5F6G7H8J9K0MNPQ';
const USER = `usr_${ALPHA}`;
let media = 0;
const med = () => { media += 1; return `med_${ALPHA.slice(0, 24)}${String(media).padStart(2, '0')}`; };
const json = (body) => ({ ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } });
const html = (title) => ({ ok: true, status: 200, async json() { throw new Error('not json'); }, async text() { return `<html><head><title>${title}</title><meta name="description" content="A design reference"></head><body><h1>${title}</h1></body></html>`; } });

function fixtures() {
    const sourceFetch = async (url) => {
        const u = new URL(url);
        if (u.pathname === '/api/v1/rules') return json({ updated: '2026-11-11', areas: [{ id: 'phone', title: 'Phones first' }], rules: [
            { id: 'tap-targets', area: 'phone', rule: 'Controls are big enough for a thumb.', detail: 'At least 44 px.', url: 'https://openvibe.design/rules#tap-targets' },
            { id: 'honest-empty', area: 'honest', rule: 'An empty page says it is empty.', detail: 'No fake rows.', url: 'https://openvibe.design/rules#honest-empty' },
        ] });
        if (u.pathname === '/api/v1/components') return json({ version: 1, components: [{ name: 'action', title: 'Action', summary: 'A button that posts.' }] });
        if (u.hostname === 'api.github.com') return json({ items: [{ full_name: 'acme/robot-ui', html_url: 'https://github.com/acme/robot-ui', description: 'A phone-first robot panel', stargazers_count: 120, homepage: 'https://robot.example', pushed_at: '2026-10-01T00:00:00Z' }] });
        return html(`Reference ${u.pathname}`);
    };
    const research = { async gather() { return {
        sources: [
            { url: 'https://example.org/robot-panel', title: 'A phone-first robot control panel', snippet: 'One thumb reaches every control.', provider: 'search_fabric', license: null },
            { url: 'https://example.org/dense-dashboard', title: 'A dense operations dashboard', snippet: 'Every robot in one screen.', provider: 'search_fabric' },
        ],
        images: [{ url: 'https://example.org/pic.jpg', source_url: 'https://example.org/pic', title: 'Panel reference', provider: 'openverse', license: 'CC0', author: 'A' }],
        facts: [], providers: { search_fabric: { ok: true, count: 2 } },
    }; } };
    const search = { async search(kind) { return {
        results: kind === 'web'
            ? [{ title: 'A phone-first robot control panel', url: 'https://example.org/robot-panel', snippet: 'A design case study' }]
            : [{ title: 'Reference', url: 'https://example.org/img', snippet: 'x', license: 'CC0' }],
        receipt: { engine: 'openvibe', cost_usd: 0, time_ms: 5 },
    }; } };
    return { sourceFetch, research, search };
}

function fakeCapture({ delayMs = 0, calls = [] } = {}) {
    let n = 0;
    return {
        calls,
        available: () => true,
        async captureSite({ url, extras, signal }) {
            calls.push({ url, at: Date.now() });
            if (delayMs) await new Promise((resolve) => { const t = setTimeout(resolve, delayMs); if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); });
            if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'run.cancelled' });
            n += 1;
            const combos = [];
            for (const viewport of [390, 1280]) {
                const extrasData = extras && viewport === 1280
                    ? { a11y: { violations: [{ id: 'button-name', impact: 'critical', help: 'Buttons must have an accessible name', nodes: 1 }], passes: 5 }, metrics: { lcp_ms: 1200, cls: 0.02, inp_ms: 90, long_tasks: 2 }, menus: [], frames: [] }
                    : null;
                combos.push({
                    viewport, theme: 'light', full_page: true, media_id: med(), width: viewport, height: 2000,
                    crops: [{ id: `crop-${n}-${viewport}`, media_id: med(), y: 0, height: 844 }],
                    title: 'Fixture', final_url: url,
                    dom: { fonts: { families: [{ value: 'Inter', count: 10, share: 1 }], sizes: [{ value: '16px', count: 10, share: 1 }] }, palette: { text: [{ value: '#111111', count: 5 }], backgrounds: [{ value: '#ffffff', count: 5 }], borders: [] }, spacing: [{ value: '8px', count: 4 }], grid: { page_height: 2000 }, navigation: { sticky: true }, outline: [], buttons: [], links: [], components: {}, words: { h1: 'Robot' } },
                    extras: extrasData, captured_at: new Date().toISOString(), cached: false,
                });
            }
            return { url, title: 'Fixture', final_url: url, combos, warnings: [], skipped: null, reason: null, ms: delayMs || 20 };
        },
    };
}

function env(over = {}) {
    return { AI_DEEP_DIVE: '1', AI_DRILL: '0', AI_DESIGN_URL: 'https://design.invalid', AI_DEEP_DIVE_CHOOSE_WAIT_SEC: '60', AI_FREE_PROVIDERS: 'stub', AI_STUB_FALLBACK: 'true', ...over };
}

async function waitFor(h, id, tok, wanted, tries = 120) {
    let last = null;
    for (let i = 0; i < tries; i++) {
        const r = await request(h.base, 'GET', `/api/v1/deep-dives/${id}/state`, { tok });
        last = r.body && r.body.deep_dive;
        if (last && wanted.includes(last.status)) return last;
        await new Promise((r2) => setTimeout(r2, 250));
    }
    return last;
}

(async () => {
    // ── The price, before anyone signs in ──
    const f = fixtures();
    const capture = fakeCapture();
    const h = await boot({ env: env(), research: f.research, search: f.search, capture, deepDiveFetch: f.sourceFetch });
    try {
        let r = await request(h.base, 'GET', '/api/v1/deep-dives/depths');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.depths.map((d) => d.key), ['quick', 'thorough', 'expert']);
        assert.strictEqual(r.body.depths[0].price_usd, 0.2);
        assert.strictEqual(r.body.depths[0].sites, 6);
        assert.strictEqual(r.body.depths[2].sites, 30);

        // Exchange holds only ai.complete on ai.run.create: design.deep_dive is the workflow its page starts.
        const exchange = token('exchange', ['ai.run.create'], { sub: 'svc:exchange', ns: ['ai.complete'] });
        r = await request(h.base, 'POST', '/api/v1/deep-dives', { tok: exchange, body: { question: 'a phone-first robot control panel', depth: 'quick', on_behalf_of: { type: 'user', id: USER } } });
        assert.strictEqual(r.status, 202);
        assert.ok(/^run_/.test(r.body.deep_dive.id));
        assert.strictEqual(r.body.price_usd, 0.2);
        assert.strictEqual(r.body.held_usd, 0.2);
        const id = r.body.deep_dive.id;

        // A service that does not own the workflow is still refused by the namespace rule.
        const live = token('live', ['ai.run.create'], { sub: 'svc:live', ns: ['live.*'] });
        r = await request(h.base, 'POST', '/api/v1/deep-dives', { tok: live, body: { question: 'x', depth: 'quick' } });
        assert.strictEqual(r.status, 403);

        const done = await waitFor(h, id, exchange, ['succeeded', 'failed', 'cancelled']);
        assert.strictEqual(done.status, 'succeeded', JSON.stringify(done.error));
        assert.strictEqual(done.progress, 1);
        assert.strictEqual(done.steps.length, 7);
        assert.ok(done.steps.every((s) => s.status === 'done'), 'every step ended done');

        // The whole report: ai.deep-dive@1, its sources, captures, analysis, synthesis and receipt.
        r = await request(h.base, 'GET', `/api/v1/deep-dives/${id}`, { tok: exchange });
        assert.strictEqual(r.status, 200);
        const report = r.body.deep_dive.report;
        assert.ok(report, 'the report is readable');
        assert.strictEqual(report.schema, 'ai.deep-dive@1');
        assert.strictEqual(report.input.question, 'a phone-first robot control panel');
        assert.ok(report.sources.length >= 3, 'the sources are dated pages and projects');
        assert.ok(report.captures.length >= 2, 'the captures are there');
        assert.ok(report.captures.every((c) => /^med_/.test(c.media_id) || c.skip), 'a capture is a Media object or a skip');
        assert.ok(report.captures.every((c) => c.crops.every((x) => /^med_/.test(x.media_id))));
        assert.ok(report.analysis.length >= 1 && report.analysis[0].source_id);
        assert.ok(report.analysis[0].evidence.length >= 1 && report.analysis[0].evidence[0].read_at, 'every analysis point cites its evidence');
        assert.ok(report.synthesis.patterns.length >= 1 && report.synthesis.patterns[0].evidence.length >= 1);
        assert.ok(report.recommendations.length >= 1 && report.recommendations[0].evidence.length >= 1);
        assert.ok(report.receipt.models.length >= 4, 'the receipt lists every model call');
        for (const step of ['plan', 'choose', 'analyse', 'synthesise']) assert.ok(report.receipt.models.some((m) => m.step === step), `the receipt carries the ${step} call`);
        assert.ok(report.receipt.captures_count >= 2);
        assert.deepStrictEqual(report.gaps.length >= 0, true);

        // The run's own output is the same document, and the run receipt has the captures beside the model calls.
        r = await request(h.base, 'GET', `/api/v1/runs/${id}`, { tok: exchange });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.run.output.schema, 'ai.deep-dive@1');
        assert.ok(r.body.requests.some((x) => x.operation === 'capture'), 'the receipt lists captures');

        // Nobody else may read it.
        const other = token('other', ['ai.run.create'], { sub: 'svc:other', ns: ['design.*'] });
        r = await request(h.base, 'GET', `/api/v1/deep-dives/${id}`, { tok: other });
        assert.strictEqual(r.status, 404);
        r = await request(h.base, 'GET', `/api/v1/deep-dives/${id}/shots/${report.captures[0].crops[0].id}`, { tok: exchange });
        assert.strictEqual(r.status, 503); // Media is not configured in this test; the owner check passed.

        // Bad input is refused before a run exists.
        r = await request(h.base, 'POST', '/api/v1/deep-dives', { tok: exchange, body: { question: '', depth: 'quick' } });
        assert.strictEqual(r.status, 422);
        r = await request(h.base, 'POST', '/api/v1/deep-dives', { tok: exchange, body: { question: 'x', depth: 'forever' } });
        assert.strictEqual(r.status, 422);
        process.stdout.write('deep dive: price, run, report, receipt and owner checks ok\n');

        // ── Choosing sites: Thorough waits, the person adds one and drops one, then Capture starts ──
        r = await request(h.base, 'POST', '/api/v1/deep-dives', { tok: exchange, body: { question: 'the pricing page of an AI API', depth: 'thorough', on_behalf_of: { type: 'user', id: USER } } });
        assert.strictEqual(r.status, 202);
        const thorough = r.body.deep_dive.id;
        const choosing = await waitFor(h, thorough, exchange, ['choosing', 'failed', 'cancelled']);
        assert.strictEqual(choosing.status, 'choosing', JSON.stringify(choosing.error));
        assert.ok(choosing.candidates.length >= 1, 'the candidates are listed');
        const drop = choosing.candidates[0].url;
        r = await request(h.base, 'POST', `/api/v1/deep-dives/${thorough}/sites`, { tok: exchange, body: { add: ['https://example.org/pricing-extra'], drop: [drop], start: true } });
        assert.strictEqual(r.status, 200);
        assert.ok(r.body.deep_dive.candidates.some((c) => c.url === 'https://example.org/pricing-extra'), 'the added site is a candidate');
        assert.ok(!r.body.deep_dive.candidates.some((c) => c.url === drop), 'the dropped site is gone');
        const after = await waitFor(h, thorough, exchange, ['succeeded', 'failed', 'cancelled']);
        assert.strictEqual(after.status, 'succeeded', JSON.stringify(after.error));
        process.stdout.write('deep dive: choosing sites, add/drop and start ok\n');
    } finally { await h.close(); }

    // ── Cancel stops the spend: a slow capture is interrupted and no later site is called ──
    const f2 = fixtures();
    const slow = fakeCapture({ delayMs: 1500 });
    const h2 = await boot({ env: env(), research: f2.research, search: f2.search, capture: slow, deepDiveFetch: f2.sourceFetch });
    try {
        const exchange = token('exchange', ['ai.run.create'], { sub: 'svc:exchange', ns: ['ai.complete'] });
        const r = await request(h2.base, 'POST', '/api/v1/deep-dives', { tok: exchange, body: { question: 'onboarding for a crypto wallet', depth: 'quick', on_behalf_of: { type: 'user', id: USER } } });
        assert.strictEqual(r.status, 202);
        const id = r.body.deep_dive.id;
        const capturing = await waitFor(h2, id, exchange, ['running'], 40);
        assert.ok(capturing);
        // Wait until the first capture is under way, then cancel.
        for (let i = 0; i < 40 && !slow.calls.length; i++) await new Promise((r2) => setTimeout(r2, 100));
        assert.ok(slow.calls.length >= 1, 'a capture started');
        const c = await request(h2.base, 'POST', `/api/v1/runs/${id}/cancel`, { tok: exchange, body: {} });
        assert.ok([200, 409].includes(c.status));
        const ended = await waitFor(h2, id, exchange, ['cancelled', 'failed', 'succeeded']);
        assert.strictEqual(ended.status, 'cancelled', JSON.stringify(ended.error));
        const calls = slow.calls.length;
        await new Promise((r2) => setTimeout(r2, 1600));
        assert.strictEqual(slow.calls.length, calls, 'cancelling stopped every later capture');
        process.stdout.write('deep dive: cancel stops the next capture and model call\n');
    } finally { await h2.close(); }
})().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
