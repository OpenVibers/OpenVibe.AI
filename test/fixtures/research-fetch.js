'use strict';
/**
 * A canned web for MegaSource tests (no network): Wikipedia, Commons, Wikidata, Fandom, Openverse and DeepSeek answer
 * from these fixtures by URL. `calls` records every request; `deepseek` scripts DeepSeek's status.
 */
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const meta = (license, extra = {}) => ({ LicenseShortName: { value: license }, Artist: { value: '<a href="x">Jane Doe</a>' }, ImageDescription: { value: 'The <b>SQLite</b> logo' }, ...extra });
const file = (title, mime, w, h, license, extra) => ({ title, imageinfo: [{ url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${encodeURIComponent(title.slice(5))}?utm_source=x`, thumburl: `https://upload.wikimedia.org/thumb/${encodeURIComponent(title.slice(5))}.png`, thumbwidth: Math.min(w, 1280), thumbheight: h, width: w, height: h, mime, descriptionurl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`, extmetadata: meta(license, extra) }] });

function createResearchFetch({ deepseek = { status: 200 }, fandom = false } = {}) {
    const calls = [];
    async function fetchImpl(url, init = {}) {
        const u = new URL(url);
        const p = u.searchParams;
        calls.push({ host: u.hostname, path: u.pathname, params: Object.fromEntries(p), method: init.method || 'GET', body: init.body || null });
        if (u.hostname.endsWith('.wikipedia.org')) {
            if (p.get('list') === 'search') return json({ query: { search: [{ title: 'SQLite', snippet: 'an embedded <span>database</span>' }, { title: 'SQL', snippet: 'a language' }, { title: 'SQLite (disambiguation)', snippet: '' }] } });
            if (p.get('generator') === 'images') return json({ query: { pages: [file('File:SQLite diagram.png', 'image/png', 1600, 900, 'CC BY-SA 4.0'), file('File:SQLite promo.jpg', 'image/jpeg', 800, 600, 'Fair use', { NonFree: { value: 'true' } }), file('File:Symbol category class.svg', 'image/svg+xml', 180, 180, 'Public domain')] } });
            if (p.get('prop') === 'extracts') return json({ query: { pages: [{ title: p.get('titles'), extract: 'SQLite is a database engine written in C.\n\n== History ==\nD. Richard Hipp designed it in 2000.\n\n== References ==\nA list of links.' }] } });
            if (p.get('prop') === 'imageinfo') return json({ query: { pages: [file(`File:${p.get('titles').replace(/^File:/, '')}`, 'image/svg+xml', 400, 200, 'Public domain')] } });
            return json({ query: {
                normalized: [{ from: 'SQLite (disambiguation)', to: 'SQLite (disambiguation)' }],
                pages: [
                    { title: 'SQL', fullurl: 'https://en.wikipedia.org/wiki/SQL', extract: 'SQL is a query language.', description: 'Query language', pageprops: { wikibase_item: 'Q47607' } },
                    { title: 'SQLite', fullurl: 'https://en.wikipedia.org/wiki/SQLite', extract: 'SQLite is a database engine.', description: 'Embedded database', pageprops: { wikibase_item: 'Q319417' }, original: { source: 'https://upload.wikimedia.org/wikipedia/commons/3/38/SQLite370.svg', width: 400, height: 200 }, thumbnail: { source: 'https://upload.wikimedia.org/thumb/SQLite370.svg.png', width: 400, height: 200 } },
                    { title: 'SQLite (disambiguation)', fullurl: 'https://en.wikipedia.org/wiki/SQLite_(disambiguation)', extract: 'may refer to', pageprops: { disambiguation: '' } },
                ],
            } });
        }
        if (u.hostname === 'commons.wikimedia.org') {
            if (p.get('generator') === 'search') return json({ query: { pages: [{ index: 2, ...file('File:Whistle stop tour.jpg', 'image/jpeg', 1200, 800, 'CC BY 2.0', { ImageDescription: { value: 'A whistle stop campaign tour' } }) }, { index: 1, ...file('File:SQLite logo photo.jpg', 'image/jpeg', 1200, 800, 'CC0') }, { index: 3, ...file('File:SQLite poster.jpg', 'image/jpeg', 1200, 800, 'CC BY-NC 2.0') }] } });
            return json({ query: { pages: [file('File:SQLite at work.jpg', 'image/jpeg', 2000, 1500, 'CC BY 4.0')] } });
        }
        if (u.hostname === 'www.wikidata.org') {
            if (p.get('ids') === 'Q319417' && /claims/.test(p.get('props'))) return json({ entities: { Q319417: { labels: { en: { value: 'SQLite' } }, descriptions: { en: { value: 'relational database engine' } }, claims: {
                P178: [{ rank: 'normal', mainsnak: { datavalue: { type: 'wikibase-entityid', value: { id: 'Q92743' } } } }],
                P571: [{ rank: 'normal', mainsnak: { datavalue: { type: 'time', value: { time: '+2000-08-17T00:00:00Z', precision: 11 } } } }],
                P18: [{ rank: 'normal', mainsnak: { datavalue: { type: 'string', value: 'SQLite at work.jpg' } } }],
            } } } });
            return json({ entities: { Q92743: { labels: { en: { value: 'D. Richard Hipp' } } } } });
        }
        if (u.hostname.endsWith('.fandom.com')) {
            if (!fandom) return json({ error: 'no wiki' }, 404);
            if (p.get('meta') === 'siteinfo') return json({ query: { general: { sitename: 'SQLite Wiki', lang: 'en' } } });
            if (p.get('list') === 'search') return json({ query: { search: [{ title: 'WAL mode' }, { title: 'WAL mode/Gallery' }] } });
            if (p.get('action') === 'parse') return json({ parse: { title: p.get('page'), text: '<aside class="portable-infobox"><h3 class="pi-data-label">Introduced</h3><div class="pi-data-value">2010</div></aside><p>Write-ahead logging keeps readers going.</p><h2>Use</h2><ul><li>Set the journal mode.</li></ul><h2>References</h2><ol><li>link</li></ol>' } });
            return json({ query: { pages: [{ title: p.get('titles'), original: { source: 'https://static.wikia.nocookie.net/sqlite/images/a/ab/Wal.png/revision/latest?cb=1', width: 600, height: 400 } }] } });
        }
        if (u.hostname === 'api.openverse.org') return json({ results: [{ url: 'https://live.staticflickr.com/1/sqlite.jpg', title: 'SQLite sticker', width: 1024, height: 768, license: 'by', license_version: '2.0', creator: 'Sam', foreign_landing_url: 'https://www.flickr.com/photos/1', source: 'flickr' }] });
        if (u.hostname === 'api.deepseek.com') {
            if (deepseek.status !== 200) return json({ error: { message: 'no' } }, deepseek.status);
            if (u.pathname === '/v1/tools/search') return json({ results: [
                { title: 'SQLite Home Page', url: 'https://sqlite.org/index.html?utm_source=a', snippet: 'Small. Fast. Reliable.', summary: 'SQLite is a C library.', content: 'SQLite is a C-language library that implements a small, fast, self-contained, high-reliability, full-featured SQL database engine. '.repeat(6), site_name: 'SQLite', date: '2026-01-01T00:00:00Z', authority: 4, rerank_score: 2.8 },
                { title: 'SQLite — Wikipedia mirror', url: 'https://en.m.wikipedia.org/wiki/SQLite', snippet: 'dup', summary: 'dup', content: 'duplicate of the encyclopedia page', authority: 3, rerank_score: 2.0 },
                { title: 'A thin page', url: 'https://example.com/thin#1', snippet: 'short', summary: '', content: '', authority: 1, rerank_score: 1.2 },
            ] });
            if (u.pathname === '/v1/tools/fetch') return json({ title: 'A thin page', content: 'The full text DeepSeek fetched for the thin page.' });
        }
        return json({ error: 'not in the fixture web' }, 404);
    }
    return { fetchImpl, calls };
}

module.exports = { createResearchFetch };
