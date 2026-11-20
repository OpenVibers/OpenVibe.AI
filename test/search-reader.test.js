'use strict';
// OpenVibe's own page reader (search/adapters/openvibe-egress.js), after 11-20 on production: most standard searches read
// no page, because the reader sent no User-Agent, failed on every redirect and on http:// results, and each page that
// refused it opened the breaker of the whole reader. A page's refusal now fails that read only.
const assert = require('node:assert/strict');
const reader = require('../server/search/adapters/openvibe-egress');
const { createSearch } = require('../server/search');

const page = (status, body = '', headers = {}) => new Response(status >= 300 && status < 400 ? null : body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

(async () => {
    // The reader on its own.
    const asked = [];
    const site = async (url, init) => {
        asked.push({ url, ua: init.headers['user-agent'] });
        if (url === 'https://example.org/old') return page(301, '', { location: '/new' });
        if (url === 'https://example.org/new') return page(302, '', { location: 'https://www.example.org/final' });
        if (url === 'https://www.example.org/final') return page(200, '<html><nav>Menu</nav><p>The museum opens at 10:00.</p><script>x()</script><p>Closed Mondays.</p></html>');
        if (url === 'https://loop.example/') return page(302, '', { location: 'https://loop.example/' });
        if (url === 'https://inside.example/') return page(302, '', { location: 'http://127.0.0.1/admin' });
        if (url === 'https://blocked.example/') return page(403, 'no');
        if (url === 'https://pdf.example/') return page(200, '%PDF', { 'content-type': 'application/pdf' });
        throw new Error('unexpected ' + url);
    };
    const got = await reader.read({ url: 'http://example.org/old' }, { fetchImpl: site });
    assert.deepEqual(asked.map((a) => a.url), ['https://example.org/old', 'https://example.org/new', 'https://www.example.org/final'], 'http read as https; redirects followed, each hop asked again');
    assert.ok(asked.every((a) => /OpenVibeReader/.test(a.ua)), 'it names itself');
    assert.match(got.text, /The museum opens at 10:00\.\n/, 'blocks end in a line break, for the passage finder');
    assert.ok(!/x\(\)/.test(got.text), 'no script text');
    assert.equal(got.url, 'https://www.example.org/final');
    for (const [url, re] of [['https://loop.example/', /too many/], ['https://blocked.example/', /answered 403/], ['https://pdf.example/', /not text/]]) {
        await assert.rejects(reader.read({ url }, { fetchImpl: site }), (err) => err.target === true && re.test(err.message), url);
    }
    // A redirect to an address the guard refuses is the page's doing: the guard itself checks every hop.
    const guarded = async (url, init) => (url.startsWith('https://127.0.0.1') ? Promise.reject(Object.assign(new Error('not public'), { code: 'EADDRNOTPUBLIC' })) : site(url, init));
    await assert.rejects(reader.read({ url: 'https://inside.example/' }, { fetchImpl: guarded }), (err) => err.target === true);
    await assert.rejects(reader.read({ url: 'ftp://example.org/' }, { fetchImpl: site }), (err) => err.target === true);
    console.log('  ✓ the reader: https, redirects hop by hop, its name, text with line breaks; a page that refuses is marked as the page\'s');

    // Through the search service: a refusing page does not open the reader's breaker; a reader failure still does.
    let down = false;
    const fetchImpl = async (url, init) => {
        if (down) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        return site(url, init);
    };
    const s = createSearch({ env: {}, fetchImpl, log: { warn() {}, log() {}, error() {} } });
    await assert.rejects(s.read({ url: 'https://blocked.example/', engine: 'openvibe-egress' }), (err) => err.code === 'search.unavailable' && /page_refused/.test(JSON.stringify(err.details || err.attempts || err)));
    const ok = await s.read({ url: 'https://www.example.org/final' });
    assert.match(ok.text, /opens at 10:00/, 'the next read is not refused by an open breaker');
    down = true;
    await assert.rejects(s.read({ url: 'https://www.example.org/final', engine: 'openvibe-egress' }));
    down = false;
    await assert.rejects(s.read({ url: 'https://www.example.org/final' }), (err) => err.code === 'search.unavailable', 'a reader that failed itself rests for a minute');
    console.log('  ✓ the service: a refusing page leaves the breaker shut; a failing reader still opens it');
    console.log('search-reader: 2 checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
