'use strict';
// The public pages of ai.openvibe.services moved to openvibe.exchange on 2026-11-07. This origin keeps the API,
// a run's receipt and the operator console; every human page answers 301 on an exact map (an unknown human path
// goes to the same path on Exchange), and no API path is ever redirected. The text/plain API index for curl stays.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, request, suite } = require('./helpers');

const SITE = 'https://ai.openvibe.services';
const EXCHANGE = 'https://openvibe.exchange';
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const t = suite('home-redirects');
let h;

const location = (r) => String(r.headers.get('location') || '');
const moved = async (p, to, headers = BROWSER) => {
    const r = await request(h.base, 'GET', p, { headers: { Accept: headers }, redirect: 'manual' });
    assert.strictEqual(r.status, 301, `${p}: ${r.status} ${r.text.slice(0, 120)}`);
    assert.strictEqual(location(r), `${EXCHANGE}${to}`, p);
    return r;
};

t.test('boot with the public origin as BASE_URL', async () => {
    h = await boot({ env: { BASE_URL: SITE } });
});

t.test('the home: a browser is sent to Exchange, curl still gets the API index', async () => {
    const r = await moved('/', '/');
    assert.match(r.headers.get('vary'), /\bAccept\b/i);
    assert.match(r.headers.get('cache-control'), /^public, max-age=300$/);
    for (const accept of [undefined, '*/*', 'application/json', 'text/plain']) {
        const text = await request(h.base, 'GET', '/', { headers: accept ? { Accept: accept } : {} });
        assert.strictEqual(text.status, 200, String(accept));
        assert.match(text.headers.get('content-type'), /^text\/plain/, String(accept));
        assert.ok(text.text.startsWith('OpenVibe.AI: providers, models, routing'), String(accept));
        assert.ok(text.text.includes('POST /api/v1/runs') && text.text.includes('GET  /runs/:id') && text.text.includes(`${EXCHANGE}/console`), String(accept));
        assert.ok(text.text.includes(`${EXCHANGE}/`), 'the text index names the new home');
    }
    await moved('/?format=markdown', '/index.md');
    const md = await request(h.base, 'GET', '/', { headers: { Accept: 'text/markdown' }, redirect: 'manual' });
    assert.strictEqual(md.status, 301);
    assert.strictEqual(location(md), `${EXCHANGE}/index.md`);
});

t.test('the exact page map, including the Markdown twins and the legal pages', async () => {
    for (const [p, to] of [
        ['/stats', '/models'],
        ['/updates', '/status'],
        ['/index.md', '/index.md'],
        ['/stats.md', '/models.md'],
        ['/updates.md', '/status.md'],
        ['/terms', '/terms'],
        ['/privacy', '/privacy'],
        ['/dmca', '/dmca'],
        ['/sitemap.xml', '/sitemap.xml'],
        ['/llms-full.txt', '/llms-full.txt'],
    ]) await moved(p, to);
});

t.test('/llms.txt stays on AI and carries the creation catalogue', async () => {
    const r = await request(h.base, 'GET', '/llms.txt', { headers: { Accept: BROWSER }, redirect: 'manual' });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /^text\/plain/);
    assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=300');
    assert.match(r.text, /^# OpenVibe\.AI/m);
    assert.ok(r.text.includes('## What AI can make'), 'names the catalogue section');
    assert.ok(r.text.includes('/api/v1/creations'), 'names the endpoint');
    assert.ok(r.text.includes('Write a blog post'), 'lists a live creation');
});

t.test('an unknown human page goes to the same path on Exchange (its page, or its honest 404); an unknown API path stays a problem document', async () => {
    await moved('/prices-and-latency', '/prices-and-latency');
    await moved('/some-old-post?ref=x', '/some-old-post?ref=x');
    await moved('/__ovcheck-404', '/__ovcheck-404');
    for (const p of ['/api/nope', '/v1/nope', '/api/v1/nope']) {
        const r = await request(h.base, 'GET', p, { headers: { Accept: BROWSER }, redirect: 'manual' });
        assert.strictEqual(r.status, 404, p);
        assert.match(r.headers.get('content-type') || '', /application\/problem\+json/, p);
        assert.ok(!location(r).startsWith(EXCHANGE), p);
    }
});

t.test('console paths redirect to Exchange while machine and receipt routes stay on AI', async () => {
    const health = await request(h.base, 'GET', '/api/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.status, 'ok');
    const release = await request(h.base, 'GET', '/release.json');
    assert.strictEqual(release.status, 200);
    await moved('/console', '/console');
    await moved('/console/providers?tab=all', '/console/providers?tab=all');
    await moved('/auth/login', '/auth/login');
    await moved('/you', '/privacy/keys');
    await moved('/you?allow=actor&provider=openai', '/privacy/keys?allow=actor&provider=openai');
    for (const p of ['/runs/run_01J0000000000000000000000', '/auth/person/login']) {
        const r = await request(h.base, 'GET', p, { headers: { Accept: BROWSER }, redirect: 'manual' });
        assert.ok(!location(r).startsWith(EXCHANGE), `${p} stays on this origin (${r.status} ${location(r)})`);
    }
});

t.test('robots.txt asks crawlers to leave this origin alone and names Exchange’s sitemap', async () => {
    const r = await request(h.base, 'GET', '/robots.txt');
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('Disallow: /'));
    assert.ok(r.text.includes(`Sitemap: ${EXCHANGE}/sitemap.xml`));
});

const active = (file) => fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx', file), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

t.test('the vhost still proxies the API, the run receipt and the console; the app answers and redirects the pages', () => {
    const conf = active('ai.openvibe.services.conf');
    for (const loc of ['location = /stats', 'location = /updates', 'location = /terms', 'location = /privacy', 'location = /dmca', 'location = /sitemap.xml', 'location = /llms.txt', 'location = /api/v1/creations ', 'location = /api/v1/creations.md ', 'location /runs/ {', 'location /console {', 'location /auth/ {', 'location /shared/']) assert.ok(conf.includes(loc), loc);
    const ops = conf.indexOf('location ~ ^/api/v1/(chat|generate|summarize|classify|extract|embed|decisions)$ {');
    const run = conf.indexOf('location ~ ^/api/v1/runs/[A-Za-z0-9_-]+$ {');
    const completions = conf.indexOf('location = /v1/chat/completions {');
    const models = conf.indexOf('location = /v1/models {');
    assert.ok(ops >= 0 && run >= 0 && completions >= 0 && models >= 0, 'the API routes are untouched');
    assert.ok(conf.slice(completions, conf.indexOf('\n    }', completions)).includes('proxy_buffering off;'), 'streamed answers are not buffered');
    assert.ok(conf.includes('location = /robots.txt'));
});

t.test('stop', async () => { await h.stop(); });

t.run();
