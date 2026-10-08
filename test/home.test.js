'use strict';
// The public home (plan T6: AI as a developer product). ai.openvibe.services renders server/home.js for a
// browser and keeps the text/plain API index for curl and API clients, serves the pinned OpenVibe Frame at
// /shared, and answers robots.txt, sitemap.xml and llms.txt. The vhosts: the developer-app routes are the only
// API the public vhost proxies, and ai.openvibe.network is a 301 to the product origin.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, request, suite } = require('./helpers');
const { HOME_CSP } = require('../server/home');

const SITE = 'https://ai.openvibe.services';
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const t = suite('home');
let h;

t.test('boot with the public origin as BASE_URL', async () => {
    h = await boot({ env: { BASE_URL: SITE } });
});

t.test('GET / as a browser: the home page, its CSP and a private cache', async () => {
    const r = await request(h.base, 'GET', '/', { headers: { Accept: BROWSER } });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/html/);
    assert.strictEqual(r.headers.get('content-security-policy'), HOME_CSP);
    assert.strictEqual(r.headers.get('cache-control'), 'private, max-age=300', 'Cloudflare ignores Vary: Accept');
    assert.match(r.headers.get('vary'), /Accept/);
    assert.strictEqual((r.text.match(/<h1\b/g) || []).length, 1, 'exactly one h1');
    assert.ok(r.text.includes('Many models, one API.'), 'the hero');
    assert.ok(r.text.includes(`<link rel="canonical" href="${SITE}/">`), 'the canonical public origin');
    assert.ok(r.text.includes(`${SITE}/api/v1/chat`), 'the examples call the public origin');
    assert.ok(r.text.includes('https://openvibe.services/projects'), 'where a project and an app are made');
    assert.ok(!/ai\.openvibe\.network/.test(r.text), 'never the old name');
});

t.test('GET / for curl and API clients: the text index, unchanged in kind', async () => {
    for (const accept of [undefined, '*/*', 'application/json', 'text/plain']) {
        const r = await request(h.base, 'GET', '/', { headers: accept ? { Accept: accept } : {} });
        assert.strictEqual(r.status, 200, String(accept));
        assert.match(r.headers.get('content-type'), /^text\/plain/, String(accept));
        assert.ok(r.text.startsWith('OpenVibe.AI: providers, models, routing'), String(accept));
        assert.ok(r.text.includes('ai.app.run') && r.text.includes('/console'), String(accept));
    }
});

t.test('the home links the pinned Frame stylesheet, and /shared serves it', async () => {
    const r = await request(h.base, 'GET', '/', { headers: { Accept: BROWSER } });
    const href = (r.text.match(/href="(\/shared\/showcase\.css\?v=[0-9a-f]+)"/) || [])[1];
    assert.ok(href, 'the showcase stylesheet, content-addressed');
    const css = await request(h.base, 'GET', href);
    assert.strictEqual(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.match(css.headers.get('cache-control'), /immutable/);
});

t.test('robots.txt, sitemap.xml and llms.txt name the public origin', async () => {
    const robots = await request(h.base, 'GET', '/robots.txt');
    assert.strictEqual(robots.status, 200);
    for (const line of ['Allow: /$', 'Allow: /stats', 'Disallow: /console', 'Disallow: /auth/', 'Disallow: /api/', `Sitemap: ${SITE}/sitemap.xml`]) assert.ok(robots.text.includes(line), line);
    const map = await request(h.base, 'GET', '/sitemap.xml');
    assert.strictEqual(map.status, 200);
    assert.match(map.headers.get('content-type'), /xml/);
    assert.deepStrictEqual([...map.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]), [`${SITE}/`, `${SITE}/stats`]);
    const llms = await request(h.base, 'GET', '/llms.txt');
    assert.strictEqual(llms.status, 200);
    assert.match(llms.headers.get('content-type'), /^text\/plain/);
    assert.ok(llms.text.startsWith('# OpenVibe.AI'));
    assert.ok(llms.text.includes(`${SITE}/stats`) && llms.text.includes(`POST ${SITE}/api/v1/chat`));
});

const active = (file) => fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx', file), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

t.test('the public vhost proxies the home, its files and exactly the developer-app API routes', () => {
    const conf = active('ai.openvibe.services.conf');
    for (const loc of ['location = / {', 'location = /stats', 'location = /sitemap.xml', 'location = /llms.txt', 'location /shared/']) assert.ok(conf.includes(loc), loc);
    const ops = conf.indexOf('location ~ ^/api/v1/(chat|generate|summarize|classify|extract|embed)$ {');
    const run = conf.indexOf('location ~ ^/api/v1/runs/[A-Za-z0-9_-]+$ {');
    assert.ok(ops >= 0 && run >= 0, 'the six operations and the run read');
    for (const [i, verb] of [[ops, 'POST'], [run, 'GET']]) {
        const block = conf.slice(i, conf.indexOf('\n    }', i));
        assert.ok(block.includes(`limit_except ${verb} { deny all; }`), verb);
        assert.ok(block.includes('limit_req zone=ovai_apps'), 'rate-limited per address');
        for (const hdr of ['X-Real-IP $remote_addr', 'X-Forwarded-For $remote_addr', 'CF-Connecting-IP $remote_addr']) assert.ok(block.includes(hdr), hdr);
    }
    const rest = conf.indexOf('location /api/ {');
    assert.ok(conf.slice(rest, conf.indexOf('}', rest)).includes('return 403;'), 'the rest of the API stays host-local');
    assert.ok(!conf.includes('$proxy_add_x_forwarded_for'));
});

t.test('ai.openvibe.network answers 301 to the same path on ai.openvibe.services, and proxies nothing', () => {
    const conf = active('ai.openvibe.network.conf');
    assert.ok(!conf.includes('proxy_pass'), 'nothing is served under the old name');
    assert.strictEqual((conf.match(/return 301 https:\/\/ai\.openvibe\.services\$request_uri;/g) || []).length, 2, 'HTTP and HTTPS');
});

t.test('the CSPs let Cloudflare Web Analytics load and report (it injects its beacon on this zone)', async () => {
    assert.match(HOME_CSP, /script-src [^;]*https:\/\/static\.cloudflareinsights\.com/);
    assert.match(HOME_CSP, /connect-src [^;]*https:\/\/cloudflareinsights\.com/);
    const stats = await request(h.base, 'GET', '/stats', { headers: { Accept: BROWSER } });
    assert.match(stats.headers.get('content-security-policy'), /script-src https:\/\/static\.cloudflareinsights\.com; connect-src https:\/\/cloudflareinsights\.com/);
});

t.test('a browser gets a page for a path nothing serves; an API client the problem document; /favicon.ico is the icon', async () => {
    const page = await request(h.base, 'GET', '/no-such-page', { headers: { Accept: BROWSER } });
    assert.strictEqual(page.status, 404);
    assert.ok(page.text.includes('<html lang="en">') && page.text.includes('<title>Not found') && page.text.includes('rel="icon"'));
    const api = await request(h.base, 'GET', '/api/v1/no-such-thing', { headers: { Accept: BROWSER } });
    assert.strictEqual(api.status, 404);
    assert.match(api.headers.get('content-type'), /json/);
    const icon = await request(h.base, 'GET', '/favicon.ico');
    assert.strictEqual(icon.status, 200);
    assert.match(icon.headers.get('content-type'), /^image\/svg\+xml/);
});

t.test('shutdown', async () => { await h.stop(); });

t.run();
