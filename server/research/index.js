'use strict';
/**
 * MegaSource: one research call over many sources, merged into one ranked, de-duplicated evidence pack that the
 * product workflows cite by number (workflow research.gather, POST /api/v1/research).
 *
 *   wikipedia   articles for the query: full text of the best ones, lead pictures, the Wikidata id
 *   fandom      the topic's own community wiki, when it has one (characters, episodes, places, lore)
 *   wikidata    the top article's key statements as labelled facts (an infobox's raw material) and its picture
 *   deepseek    web search with page text (DeepSeek's Search API) and pages it cannot read in full (its Fetch API);
 *               paid per call, so only for first-party callers and within its daily cap
 *   commons     freely licensed pictures for the query
 *   openverse   more openly licensed pictures
 *
 * Every provider is optional and fails on its own: a provider that errors, times out or stands down is reported in
 * `providers` and the rest still answer. Nothing is invented: a source is a page that was read, with its URL, when it
 * was read and its licence; a picture carries its own licence and `free` says whether anyone may reuse it.
 */
const { createHttp } = require('./http');
const { createWikimedia } = require('./wikimedia');
const { createFandom } = require('./fandom');
const { createOpenverse } = require('./openverse');
const { createDeepseek } = require('./deepseek');
const { clip, canonicalUrl, hostOf } = require('./text');
const { resolveSecret } = require('../util');

const PROVIDERS = ['wikipedia', 'fandom', 'wikidata', 'deepseek', 'commons', 'openverse'];
const LICENSE = { wikipedia: 'CC BY-SA 4.0 (Wikipedia)', fandom: 'CC BY-SA 3.0 (Fandom)', wikidata: 'CC0 (Wikidata)' };

const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const short = (err) => oneLine(err && err.message ? err.message : err, 160) || 'failed';

function createResearch({ config = {}, env = process.env, fetchImpl, now = () => Date.now(), log = console } = {}) {
    const http = createHttp({ ...(fetchImpl ? { fetchImpl } : {}), timeoutMs: config.timeoutMs || 15000 });
    const wikimedia = createWikimedia({ http });
    const fandom = createFandom({ http });
    const openverse = createOpenverse({ http });
    const deepseek = createDeepseek({ http, key: config.deepseekKey || (config.deepseek !== false ? resolveSecret(config.deepseekKeyRef, env) : ''), base: config.deepseekUrl || 'https://api.deepseek.com', dailyCap: config.deepseekDaily || 1500, now, log });

    function status() {
        return { providers: PROVIDERS, deepseek: deepseek.status() };
    }

    /**
     * input: { query, topic?, focus?, question?, lang?, max_sources?, max_images?, images?, content_chars?, providers? }
     *   query   what to research ("Kim Possible", "Ron Stoppable Kim Possible")
     *   topic   the subject the query belongs to, used to find the topic's own wiki (defaults to the query)
     *   focus   one subject inside the topic (a character, an episode): searched for inside the topic's wiki
     * opts: { signal, allowPaid } — allowPaid false (a developer app) leaves DeepSeek out.
     */
    async function gather(input = {}, { signal = null, allowPaid = true } = {}) {
        const query = oneLine(input.query, 200);
        if (!query) throw Object.assign(new Error('research needs a query'), { status: 422 });
        const topic = oneLine(input.topic, 200) || query;
        const focus = oneLine(input.focus, 200) || null;
        const lang = /^[a-z]{2,3}$/.test(input.lang || '') ? input.lang : 'en';
        const maxSources = int(input.max_sources, 1, 20, 10);
        const maxImages = input.images === false ? 0 : int(input.max_images, 0, 24, 10);
        const chars = int(input.content_chars, 500, 12000, 5000);
        const want = new Set(Array.isArray(input.providers) && input.providers.length ? input.providers.filter((p) => PROVIDERS.includes(p)) : PROVIDERS);
        const searchText = focus && !query.toLowerCase().includes(focus.toLowerCase()) ? `${focus} ${query}` : query;
        const retrievedAt = new Date(now()).toISOString();
        const providers = {};
        const usage = { requests: 0, deepseek_search: 0, deepseek_fetch: 0, cost_usd: 0 };
        const startRequests = http.count();

        async function timed(name, fn) {
            const t0 = now();
            try {
                const value = await fn();
                const count = value == null ? 0 : Array.isArray(value) ? value.length : (value.count != null ? value.count : 1);
                providers[name] = { ok: true, ms: now() - t0, count };
                return value;
            } catch (err) {
                if (signal && signal.aborted) throw err;
                providers[name] = { ok: false, ms: now() - t0, error: short(err) };
                return null;
            }
        }
        const skip = (name, reason) => { providers[name] = { ok: false, skipped: reason }; return null; };

        // Round one, all at once: Wikipedia, web search and the picture libraries.
        const useDeepseek = want.has('deepseek') && (allowPaid ? (deepseek.available() || skip('deepseek', deepseek.status().configured ? (deepseek.status().reason || 'daily cap reached') : 'not configured')) : skip('deepseek', 'first-party callers only'));
        const [wiki, web, commons, openv] = await Promise.all([
            want.has('wikipedia') ? timed('wikipedia', async () => {
                const hits = await wikimedia.searchWikipedia(searchText, { lang, limit: focus ? 4 : 5, signal });
                const list = await wikimedia.articles(hits.map((h) => h.title), { lang, full: focus ? 2 : 3, chars, signal });
                return list.filter((a) => !a.disambiguation && a.text);
            }) : null,
            useDeepseek ? timed('deepseek', async () => {
                usage.deepseek_search += 1;
                return deepseek.search(searchText, { count: 8, needContent: true, question: input.question || null, signal });
            }) : null,
            maxImages && want.has('commons') ? timed('commons', () => wikimedia.commonsSearch(searchText, { limit: 8, signal })) : null,
            maxImages && want.has('openverse') ? timed('openverse', () => openverse.search(searchText, { limit: 6, signal })) : null,
        ]);

        // Round two: the topic's own wiki, the top article's facts and pictures, and full text for web results that came back short.
        const top = wiki && wiki[0];
        const hints = (web || []).map((r) => r.url);
        const [fan, facts, articlePictures, fetched] = await Promise.all([
            want.has('fandom') ? timed('fandom', async () => {
                const site = await fandom.findWiki(topic, hints, { lang, signal });
                if (!site) return null;
                const titles = await fandom.search(site.base, focus || topic, { limit: 4, signal });
                const pages = (await Promise.all(titles.slice(0, focus ? 2 : 3).map((t) => fandom.page(site.base, t, { chars, signal }).catch(() => null)))).filter(Boolean);
                return { site, pages, count: pages.length };
            }) : null,
            want.has('wikidata') && top && top.qid ? timed('wikidata', () => wikimedia.wikidataFacts(top.qid, { lang, signal })) : null,
            maxImages && want.has('wikipedia') && top ? timed('wikipedia_images', () => wikimedia.articleImages(top.title, { lang, limit: 10, signal })) : null,
            useDeepseek && web ? (async () => {
                // A short result is read in full, unless it is a copy of an encyclopedia page already read.
                const read = new Set((wiki || []).map((a) => canonicalUrl(a.url)));
                const thin = web.filter((r) => r.score >= 1 && r.content.length < 400 && !read.has(canonicalUrl(r.url))).slice(0, 2);
                return Promise.all(thin.map(async (r) => {
                    try { usage.deepseek_fetch += 1; const page = await deepseek.fetchPage(r.url, { chars, signal }); r.content = page.content || r.content; } catch { /* the summary stays */ }
                }));
            })() : null,
        ]);
        void fetched;
        // The Wikidata item's picture, and the article's lead picture when the article's own list left it out (a logo
        // drawn as SVG), each with its licence from the file's page.
        const leadName = top && top.lead ? decodeURIComponent(String(top.lead.original).split('/').pop() || '') : '';
        const leadListed = leadName && (articlePictures || []).some((i) => String(i.original).endsWith(`/${encodeURIComponent(leadName).replace(/%20/g, '_')}`) || String(i.original).endsWith(`/${leadName}`));
        const [factPicture, leadPicture] = await Promise.all([
            maxImages && facts && facts.image ? timed('wikidata_image', () => wikimedia.commonsFiles([facts.image], { signal })) : null,
            maxImages && leadName && !leadListed ? wikimedia.fileInfo([leadName], { lang, allowSvg: true, signal }).catch(() => null) : null,
        ]);

        // Sources, ranked: the topic's own pages first, then the encyclopedia, then the web by DeepSeek's score.
        const scored = [];
        const focusLc = (focus || '').toLowerCase();
        (fan && fan.pages || []).forEach((p, i) => {
            const exact = focusLc ? p.title.toLowerCase() === focusLc : i === 0;
            scored.push({ score: (exact ? 3.3 : 2.4) - i * 0.15, s: { source_type: 'fandom', url: p.url, title: `${p.title} — ${fan.site.name}`, snippet: clip(p.text, 300), content: p.text, retrieved_at: retrievedAt, provenance: { provider: 'fandom', site: fan.site.name, license: LICENSE.fandom } } });
        });
        (wiki || []).forEach((a, i) => {
            const exact = a.title.toLowerCase() === (focusLc || query.toLowerCase());
            scored.push({ score: (exact || i === 0 ? 3.0 : 1.7) - i * 0.12, s: { source_type: 'wikipedia', url: a.url, title: `${a.title} — Wikipedia`, snippet: a.description || clip(a.text, 300), content: a.text, published_at: a.revisedAt || undefined, retrieved_at: retrievedAt, provenance: { provider: 'wikipedia', site: `${lang}.wikipedia.org`, license: LICENSE.wikipedia } } });
        });
        (web || []).forEach((r) => {
            const content = clip(r.content || r.summary || r.snippet, chars);
            if (!content) return;
            scored.push({ score: Math.min(r.score, 3) * 0.9 + Math.max(r.authority, 0) * 0.08, s: { source_type: 'web', url: r.url, title: r.title || hostOf(r.url), snippet: r.snippet || clip(r.summary, 300), content, published_at: r.date || undefined, retrieved_at: retrievedAt, provenance: { provider: 'deepseek', site: r.site || hostOf(r.url), authority: r.authority, score: r.score } } });
        });
        if (facts && facts.facts.length) {
            scored.push({ score: 2.0, s: { source_type: 'wikidata', url: facts.url, title: `${facts.name} — Wikidata`, snippet: facts.description || `${facts.facts.length} facts`, content: facts.facts.map((f) => `${f.label}: ${f.value}`).join('\n'), retrieved_at: retrievedAt, provenance: { provider: 'wikidata', site: 'wikidata.org', license: LICENSE.wikidata } } });
        }
        scored.sort((a, b) => b.score - a.score);
        const seen = new Set();
        const sources = [];
        for (const { s } of scored) {
            const key = canonicalUrl(s.url);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            for (const k of Object.keys(s)) if (s[k] === undefined) delete s[k];
            sources.push(s);
            if (sources.length >= maxSources) break;
        }

        // Pictures: the subject's own (Wikidata, the article, the topic's wiki) before library search results.
        const images = [];
        const seenImg = new Set();
        const lead = (leadPicture || []).map((i) => ({ ...i, title: top.title, description: i.description || top.description || null, source_url: i.source_url || top.url }));
        const fanPics = (fan && fan.pages || []).map((p) => p.image).filter(Boolean);
        // Library search is loose ("Ron Stoppable" also finds "whistle stop" photos): a library picture must name every
        // word of the focus, or most of the query's, in its title or description.
        const significant = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !/^(the|and|for|with|from|wiki)$/.test(w));
        const named = (img) => {
            const text = significant(`${img.title} ${img.description || ''}`).join(' ');
            const need = significant(focus || query);
            const hits = need.filter((w) => text.includes(w)).length;
            return need.length ? (focus ? hits === need.length : hits >= Math.ceil(need.length / 2)) : true;
        };
        const library = [...(commons || []), ...(openv || [])].filter(named);
        for (const img of [...(factPicture || []), ...lead, ...(articlePictures || []), ...fanPics, ...library]) {
            if (!img || !img.url || !/^https:\/\//.test(img.url) || /\.svg(\?|$)/i.test(img.url)) continue;
            const key = String(img.original || img.url).replace(/\/(scale-to-width-down|thumb)\/.*$/, '');
            if (seenImg.has(key)) continue;
            seenImg.add(key);
            images.push({ ...img });
            if (images.length >= maxImages) break;
        }

        usage.requests = http.count() - startRequests;
        usage.cost_usd = Number(((usage.deepseek_search + usage.deepseek_fetch) * deepseek.PRICE_PER_CALL_USD).toFixed(5));
        return {
            query, topic, focus, lang, retrieved_at: retrievedAt,
            sources, images,
            facts: facts ? facts.facts : [],
            topic_wiki: fan && fan.site ? { name: fan.site.name, url: fan.site.base } : null,
            providers, usage,
        };
    }

    return { gather, status };
}

module.exports = { createResearch, PROVIDERS };
