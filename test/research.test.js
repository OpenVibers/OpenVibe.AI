'use strict';
// MegaSource (server/research/): every provider merged into one ranked, de-duplicated pack against a canned web; pictures
// carry their licences and library results must name the subject; DeepSeek is used only with a key, only for
// first-party callers, and stands down on 402; the research.gather workflow and POST /api/v1/research answer.

const assert = require('assert');
const { createResearch } = require('../server/research');
const { articleText, extractText, canonicalUrl, isFreeLicense, clip } = require('../server/research/text');
const { slugsFor } = require('../server/research/fandom');
const { createResearchFetch } = require('./fixtures/research-fetch');
const { boot, request, token, suite } = require('./helpers');

const t = suite('research');
const quiet = { log() {}, warn() {}, error() {} };

t.test('text helpers: article HTML, extracts, URLs, licences', () => {
    const text = articleText('<aside class="portable-infobox"><h3 class="pi-data-label">Voiced by</h3><div class="pi-data-value">Will Friedle<br>someone</div></aside><p>Ron is <b>loyal</b>.<sup class="reference">[1]</sup></p><h2>Personality</h2><ul><li>Brave</li></ul><h2>References</h2><ol><li>x</li></ol><script>evil()</script>');
    assert.match(text, /^Voiced by: Will Friedle, someone$/m);
    assert.match(text, /Ron is loyal\./);
    assert.match(text, /^## Personality$/m);
    assert.match(text, /^- Brave$/m);
    assert.ok(!/References|evil|\[1\]/.test(text), 'references, scripts and markers are gone');
    assert.strictEqual(extractText('Intro.\n\n== History ==\nOld.\n\n== References ==\nlinks'), 'Intro.\n\n## History\nOld.');
    assert.strictEqual(canonicalUrl('http://en.m.wikipedia.org/wiki/SQLite?utm_source=x#top'), 'https://en.wikipedia.org/wiki/SQLite');
    assert.strictEqual(canonicalUrl('javascript:alert(1)'), null);
    for (const free of ['CC BY-SA 4.0', 'CC0', 'Public domain', 'CC BY 2.0', 'GFDL']) assert.ok(isFreeLicense(free), free);
    for (const not of ['CC BY-NC 2.0', 'CC BY-ND 4.0', 'Fair use', '', null, 'All rights reserved']) assert.ok(!isFreeLicense(not), String(not));
    assert.ok(clip('One. Two. Three. Four.', 12).endsWith('.'));
    assert.deepStrictEqual(slugsFor('The Legend of Zelda'), ['thelegendofzelda', 'legendzelda', 'legend']);
    assert.deepStrictEqual(slugsFor('Kim Possible'), ['kimpossible']);
});

t.test('gather: free sources only without a key, ranked and de-duplicated, pictures with licences', async () => {
    const web = createResearchFetch();
    const r = createResearch({ config: {}, env: {}, fetchImpl: web.fetchImpl, log: quiet });
    const out = await r.gather({ query: 'SQLite', max_images: 10 });
    assert.strictEqual(out.providers.deepseek.skipped, 'not configured');
    assert.ok(!web.calls.some((c) => c.host === 'api.deepseek.com'), 'no paid call without a key');
    assert.strictEqual(out.sources[0].url, 'https://en.wikipedia.org/wiki/SQLite', 'the exact article leads');
    assert.match(out.sources[0].content, /## History/);
    assert.ok(!/References/.test(out.sources[0].content));
    assert.ok(!out.sources.some((s) => /disambiguation/.test(s.url)), 'disambiguation pages are left out');
    const wd = out.sources.find((s) => s.source_type === 'wikidata');
    assert.match(wd.content, /Developer: D\. Richard Hipp/);
    assert.match(wd.content, /Founded \/ created: 2000-08-17/);
    assert.deepStrictEqual(out.facts.map((f) => f.label), ['Developer', 'Founded / created']);
    for (const s of out.sources) { assert.ok(s.retrieved_at && s.url && s.title); assert.ok(s.provenance.provider); }
    const byTitle = Object.fromEntries(out.images.map((i) => [i.title, i]));
    assert.strictEqual(out.images[0].provider, 'wikidata', 'the item\'s own picture first');
    assert.strictEqual(byTitle['SQLite diagram'].free, true);
    assert.strictEqual(byTitle['SQLite diagram'].license, 'CC BY-SA 4.0');
    assert.strictEqual(byTitle['SQLite diagram'].author, 'Jane Doe', 'credit is plain text');
    assert.ok(!/utm_/.test(byTitle['SQLite diagram'].original), 'tracking query removed');
    assert.strictEqual(byTitle['SQLite promo'].free, false, 'an article\'s non-free picture is marked');
    assert.ok(!out.images.some((i) => /Symbol category/.test(i.title)), 'interface icons are left out');
    assert.ok(byTitle['SQLite logo photo'], 'a library picture naming the subject is kept');
    assert.ok(!out.images.some((i) => /Whistle/.test(i.title)), 'a library picture of something else is left out');
    assert.ok(!out.images.some((i) => /poster/.test(i.title)), 'NonCommercial licences are not free');
    assert.ok(out.images.some((i) => i.provider === 'openverse/flickr'));
    assert.strictEqual(out.topic_wiki, null);
    assert.strictEqual(out.usage.cost_usd, 0);
});

t.test('gather: the topic\'s Fandom wiki ranks first for a focus page; DeepSeek joins with a key', async () => {
    const web = createResearchFetch({ fandom: true });
    const r = createResearch({ config: { deepseekKey: 'sk-test', deepseekDaily: 10 }, env: {}, fetchImpl: web.fetchImpl, log: quiet });
    const out = await r.gather({ query: 'WAL mode SQLite', topic: 'SQLite', focus: 'WAL mode', max_images: 6 });
    assert.strictEqual(out.sources[0].source_type, 'fandom');
    assert.strictEqual(out.sources[0].url, 'https://sqlite.fandom.com/wiki/WAL_mode');
    assert.match(out.sources[0].content, /^Introduced: 2010$/m);
    assert.deepStrictEqual(out.topic_wiki, { name: 'SQLite Wiki', url: 'https://sqlite.fandom.com' });
    assert.ok(!web.calls.some((c) => c.params.page === 'WAL mode/Gallery'), 'gallery subpages are not read');
    const urls = out.sources.map((s) => s.url);
    assert.ok(urls.includes('https://sqlite.org/index.html?utm_source=a'), 'a web result');
    assert.ok(!urls.includes('https://en.m.wikipedia.org/wiki/SQLite'), 'a mirror of a page already read is dropped');
    const thin = out.sources.find((s) => s.url === 'https://example.com/thin');
    assert.match(thin.content, /full text DeepSeek fetched/, 'a thin result is read in full through Fetch');
    assert.strictEqual(out.usage.deepseek_search, 1);
    assert.strictEqual(out.usage.deepseek_fetch, 1);
    assert.strictEqual(out.usage.cost_usd, 0.0015);
    const ds = web.calls.find((c) => c.path === '/v1/tools/search');
    assert.strictEqual(JSON.parse(ds.body).need_content, true);
    const fan = out.images.find((i) => i.provider === 'fandom');
    assert.strictEqual(fan.free, false);
    assert.match(fan.url, /scale-to-width-down\/1024/);
    // A developer app's run reads only the free sources.
    const before = web.calls.length;
    const app = await r.gather({ query: 'SQLite' }, { allowPaid: false });
    assert.strictEqual(app.providers.deepseek.skipped, 'first-party callers only');
    assert.ok(!web.calls.slice(before).some((c) => c.host === 'api.deepseek.com'));
});

t.test('gather: DeepSeek stands down on 402 and the free sources still answer', async () => {
    const web = createResearchFetch({ deepseek: { status: 402 } });
    const r = createResearch({ config: { deepseekKey: 'sk-test' }, env: {}, fetchImpl: web.fetchImpl, log: quiet });
    const one = await r.gather({ query: 'SQLite' });
    assert.strictEqual(one.providers.deepseek.ok, false);
    assert.match(one.providers.deepseek.error, /balance/);
    assert.ok(one.sources.length >= 2);
    const two = await r.gather({ query: 'SQLite 2' });
    assert.strictEqual(two.providers.deepseek.skipped, 'balance used up', 'no second paid call while standing down');
    assert.strictEqual(web.calls.filter((c) => c.host === 'api.deepseek.com').length, 1);
    assert.strictEqual(r.status().deepseek.reason, 'balance used up');
});

t.test('gather: the key comes from the environment by name, and a daily cap', async () => {
    const web = createResearchFetch();
    const r = createResearch({ config: { deepseekKeyRef: 'env:MY_DS', deepseekDaily: 1 }, env: { MY_DS: 'sk-env' }, fetchImpl: web.fetchImpl, log: quiet });
    await r.gather({ query: 'SQLite' });
    const auth = web.calls.find((c) => c.host === 'api.deepseek.com');
    assert.ok(auth, 'the key resolved');
    const again = await r.gather({ query: 'SQLite again' });
    assert.strictEqual(again.providers.deepseek.skipped, 'daily cap reached');
    const off = createResearch({ config: { deepseek: false, deepseekKeyRef: 'env:MY_DS' }, env: { MY_DS: 'sk-env' }, fetchImpl: web.fetchImpl, log: quiet });
    assert.strictEqual(off.status().deepseek.configured, false);
    await assert.rejects(r.gather({ query: '  ' }), /needs a query/);
});

t.test('research.gather runs as a workflow and through POST /api/v1/research', async () => {
    const h = await boot();
    try {
        const tok = token('wiki', ['ai.run.create'], { ns: ['research.*'] });
        const res = await request(h.base, 'POST', '/api/v1/research?wait=10000', { tok, body: { query: 'SQLite', max_images: 3 } });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        const run = res.body.run;
        assert.strictEqual(run.status, 'succeeded');
        assert.strictEqual(run.provenance.workflow, 'research.gather');
        assert.ok(run.output.sources.length >= 2);
        assert.ok(run.output.images.length <= 3);
        // Cached per calling service for a day: the second ask reads nothing new.
        const again = await request(h.base, 'POST', '/api/v1/research?wait=10000', { tok, body: { query: 'SQLite', max_images: 3 } });
        assert.ok([200, 201].includes(again.status));
        assert.strictEqual(again.body.run.status, 'cached');
        const denied = await request(h.base, 'POST', '/api/v1/research', { tok: token('games', ['ai.run.create'], { ns: ['games.*'] }), body: { query: 'SQLite' } });
        assert.strictEqual(denied.status, 403);
        const bad = await request(h.base, 'POST', '/api/v1/research', { tok, body: { query: 'x', providers: ['google'] } });
        assert.strictEqual(bad.status, 422);
    } finally { await h.stop(); }
});

t.run();
