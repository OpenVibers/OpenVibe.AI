'use strict';
// The capture worker, on a local fixture site only: robots.txt, the DOM facts, both viewports, dark where the
// site answers prefers-color-scheme, a full page after a slow scroll, Expert extras (axe-core, LCP/CLS/INP, a
// menu and a frame strip), the 45 s page budget's shape, and a disallowed page skipped. No outside site is read.
// The browser tests need /usr/bin/google-chrome; without it the file says so and checks the rules that need no browser.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const { createCapture } = require('../server/capture');
const { createRobots, parse, allowedBy } = require('../server/capture/robots');

const CHROME = '/usr/bin/google-chrome';
const chrome = fs.existsSync(CHROME);

const FIXTURE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture control panel</title>
<meta name="description" content="A phone-first robot control panel fixture."><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{color-scheme: light dark}*{box-sizing:border-box}
body{font-family:Inter,system-ui,sans-serif;background:#ffffff;color:#111111;margin:0;padding:16px;line-height:1.5}
header{position:sticky;top:0;background:#ffffff;padding:8px 0}nav a{color:#111111;margin-right:12px;font-size:14px}
h1{font-size:28px;line-height:1.2}h2{font-size:20px}.card{background:#f4f4f5;border-radius:12px;padding:16px;margin:12px 0;box-shadow:0 1px 2px rgba(0,0,0,.2)}
button{font-size:16px;padding:12px 16px;border-radius:8px;background:#f5a623;border:0}
@media (prefers-color-scheme: dark){body{background:#0c0e12;color:#eeeeee}header{background:#0c0e12}.card{background:#1b1d22}}
</style></head><body>
<header><nav aria-label="Main"><a href="#home">Home</a><a href="#robots">Robots</a><button aria-label="Menu" aria-expanded="false">Menu</button></nav></header>
<main><h1>Control your robot</h1><p>One thumb reaches every control.</p>
<div class="card"><h2>Camera</h2><p>Live view</p><button>Start camera</button></div>
<section class="card"><h2>Drive</h2><p>Forward, back, and turn.</p><button>Forward</button> <button>Stop</button></section>
${Array.from({ length: 8 }, (_, i) => `<section class="card"><h2>Section ${i + 1}</h2><p>${'Robots move slowly and carefully. '.repeat(18)}</p></section>`).join('')}
</main></body></html>`;

function fixtureServer({ robots = 'User-agent: *\nAllow: /\n' } = {}) {
    const s = http.createServer((req, res) => {
        if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(robots); }
        if (req.url === '/secret') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><body><h1>Secret</h1></body></html>'); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(FIXTURE);
    });
    return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); }) })));
}

(async () => {
    // ── robots.txt: groups, longest match and wildcards, no browser needed ──
    const groups = parse('User-agent: *\nDisallow: /private\nAllow: /private/ok\n');
    assert.strictEqual(allowedBy(groups, '/public'), true);
    assert.strictEqual(allowedBy(groups, '/private/x'), false);
    assert.strictEqual(allowedBy(groups, '/private/ok/page'), true);
    // A group that names our user agent replaces the * group for us.
    const own = parse('User-agent: *\nAllow: /\n\nUser-agent: OpenVibeDeepDive\nDisallow: /\n');
    assert.strictEqual(allowedBy(own, '/anything'), false);
    assert.strictEqual(allowedBy(own, '/anything', 'SomeOtherBot'), true);
    const wild = parse('User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*\n');
    assert.strictEqual(allowedBy(wild, '/a/b.pdf'), false);
    assert.strictEqual(allowedBy(wild, '/a/b.pdf?x=1'), true);
    assert.strictEqual(allowedBy(wild, '/tmp/x'), false);
    assert.strictEqual(allowedBy([], '/'), true);
    const robot = createRobots({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'User-agent: *\nDisallow: /no\n' }) });
    assert.strictEqual((await robot.check('https://example.org/no/page')).allowed, false);
    assert.strictEqual((await robot.check('https://example.org/yes')).allowed, true);
    process.stdout.write('capture: robots.txt rules ok\n');

    if (!chrome) { process.stdout.write('capture: skipped (no /usr/bin/google-chrome; the browser checks need it)\n'); return; }

    const site = await fixtureServer();
    const deny = await fixtureServer({ robots: 'User-agent: *\nDisallow: /secret\n' });
    const config = require('../server/config').load({ NODE_ENV: 'test', PORT: '0', AI_DEEP_DIVE: '1' });
    config.capture.pageBudgetMs = 30000;
    const uploads = [];
    let n = 0;
    const upload = async ({ bytes, mime, filename, metadata }) => {
        assert.strictEqual(mime, 'image/png');
        assert.ok(Buffer.isBuffer(bytes) && bytes.length > 1000);
        uploads.push({ filename, metadata });
        n += 1;
        const tail = '01JAB2C3D4E5F6G7H8J9K0MNPQ'.slice(0, 24);
        return { media_id: `med_${tail}${String(n).padStart(2, '0')}`, width: 390, height: 844 };
    };
    try {
        const capture = createCapture({ config, log: { log() {}, warn() {} }, upload, allowLocal: true, robots: { check: async (url) => (url.includes(`:${deny.port}/secret`) ? { allowed: false, reason: 'robots.txt disallows this page' } : { allowed: true, reason: null }) } });
        const started = Date.now();
        const got = await capture.captureSite({ url: `http://127.0.0.1:${site.port}/`, runId: 'run_01JAB2C3D4E5F6G7H8J9K0MNPQ', owner: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', extras: true });
        const ms = Date.now() - started;
        assert.strictEqual(got.skipped, null);
        assert.ok(got.combos.length >= 2, `both viewports were captured (got ${got.combos.length})`);
        assert.ok(got.combos.some((c) => c.viewport === 390 && c.theme === 'light'));
        assert.ok(got.combos.some((c) => c.viewport === 1280 && c.theme === 'light'));
        // The fixture answers prefers-color-scheme: the dark pair is captured too.
        assert.ok(got.combos.some((c) => c.theme === 'dark'), 'the dark theme was captured');
        for (const c of got.combos) {
            assert.ok(c.height > 900, `the page is taller than a screen (${c.height})`);
            assert.ok(c.crops.length >= 1, 'there is a crop for the point');
            assert.ok(c.crops.every((x) => /^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(x.media_id)));
            assert.ok(c.dom, 'the DOM facts are recorded');
        }
        const light = got.combos.find((c) => c.viewport === 1280 && c.theme === 'light');
        assert.ok(light.dom.fonts.families.some((f) => /Inter/i.test(f.value)), 'the type family is measured');
        assert.ok(light.dom.fonts.sizes.some((s) => s.value === '28px'), 'the h1 size is measured');
        assert.ok(light.dom.palette.backgrounds.some((p) => p.value === '#ffffff'), 'the palette carries the page background');
        assert.ok(light.dom.spacing.length > 0 && light.dom.radii.some((r) => r.value === '12px'), 'spacing and radii are measured');
        assert.ok(light.dom.shadows.some((s) => /rgba?\(/.test(s.value)), 'the shadow is measured');
        assert.ok(light.dom.outline.some((h) => h.level === 1 && /Control your robot/.test(h.text)), 'the heading outline is recorded');
        assert.ok(light.dom.buttons.some((b) => /Start camera/.test(b.text)), 'the button words are recorded');
        assert.ok(light.dom.navigation.sticky === true, 'the sticky navigation is recorded');
        assert.ok(light.dom.components.images >= 0 && light.dom.grid.page_height > 0, 'the component inventory and grid are recorded');
        // Expert extras: axe-core findings, measured Web Vitals and a menu open.
        assert.ok(light.extras, 'Expert extras are present on the 1280 light capture');
        assert.ok(Array.isArray(light.extras.a11y.violations), 'axe-core answered with violations');
        assert.ok(Number.isFinite(light.extras.metrics.lcp_ms), 'LCP was measured');
        assert.ok(Number.isFinite(light.extras.metrics.cls), 'CLS was measured');
        assert.ok(light.extras.menus.length >= 1 && light.extras.menus[0].after, 'the menu was opened and photographed');
        assert.ok(light.extras.frames.length >= 2, 'a frame strip was taken');
        assert.ok(uploads.length >= got.combos.length, 'every shot went to Media');
        for (const u of uploads) assert.deepStrictEqual(Object.keys(u.metadata).includes('source_url'), true, 'each shot keeps its source URL');
        assert.ok(ms < 120000, `the fixture capture fits its budget (${ms} ms)`);
        process.stdout.write(`capture: fixture site ok (${got.combos.length} captures, ${uploads.length} shots, ${ms} ms)\n`);

        // robots.txt disallowed: no browser and a reason the report can show.
        const denied = await capture.captureSite({ url: `http://127.0.0.1:${deny.port}/secret`, runId: 'run_01JAB2C3D4E5F6G7H8J9K0MNPQ', owner: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', extras: false });
        assert.strictEqual(denied.skipped, 'robots_disallowed');
        assert.match(denied.reason, /robots\.txt/);
        process.stdout.write('capture: a robots-disallowed page is skipped and says so\n');
    } finally {
        await site.close();
        await deny.close();
    }
})().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
