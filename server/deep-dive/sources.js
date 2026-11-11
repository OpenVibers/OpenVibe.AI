'use strict';
/**
 * Every search a deep dive uses, gathered into one numbered source list (ai.deep-dive@1 sources).
 *
 *   named      the sites the person typed: read for their title, always candidates
 *   MegaSource server/research/: Wikipedia, Wikidata, the Search Fabric or DeepSeek's web search, and licensed
 *              pictures, all deduplicated and dated
 *   AI search  Exchange's own engines (server/search/): web, pictures, and icons for Expert
 *   GitHub     open-source projects and their demo/homepage links
 *   rules      OpenVibe.Design's rules register (GET https://openvibe.design/api/v1/rules), so the synthesis is
 *              checked against what OpenVibe already decided
 *   components OpenVibe.Design's component registry (GET /api/v1/components)
 *
 * Nothing here is a claim: a source is a page or a project that was read, with its URL and the date it was read.
 * A provider that fails is a warning and a gap, never an invented row.
 */
const { guardedFetch } = require('../providers/guarded-fetch');
const { publicTarget } = require('../search/transport');

const ONE_LINE = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const HOST = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
const canon = (u) => { try { const x = new URL(String(u)); x.hash = ''; x.hostname = x.hostname.toLowerCase(); return x.href.replace(/\/$/, ''); } catch { return null; } };
const DESIGN_PUBLISHERS = /(smashingmagazine|nngroup|uxdesign|interactions\.acm|alistapart|awwwards|css-tricks|web\.dev|developer\.mozilla|designsystems|uxplanet|figma\.com\/blog|medium\.com|substack\.com|dribbble\.com\/stories|abduzeedo|itsnicethat|dezeen)/i;
const WORD = /[a-z0-9]{3,}/g;
const words = (s) => new Set(String(s || '').toLowerCase().match(WORD) || []);

function createSourceGatherer({ config = {}, log = console, fetchImpl = guardedFetch, research = null, search = null, now = () => Date.now() } = {}) {
    const designUrl = String((config.deepDive && config.deepDive.designUrl) || 'https://openvibe.design').replace(/\/+$/, '');
    const timeoutMs = (config.deepDive && config.deepDive.rulesTimeoutMs) || 8000;

    async function getJson(url, accept = 'application/json') {
        await publicTarget(url);
        const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept, 'user-agent': 'OpenVibeDeepDive/1.0 (+https://openvibe.exchange/deep-dive)' } });
        if (!res.ok) throw new Error(`${HOST(url)} answered ${res.status}`);
        return await res.json();
    }

    async function titleOf(url) {
        try {
            const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(6000), headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'OpenVibeDeepDive/1.0 (+https://openvibe.exchange/deep-dive)' } });
            if (!res.ok) return { title: HOST(url) || url, snippet: null };
            const text = (await res.text()).slice(0, 250000);
            const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(text) || [])[1];
            const desc = (/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i.exec(text) || [])[1];
            return { title: ONE_LINE(title || HOST(url) || url, 300), snippet: desc ? ONE_LINE(desc, 600) : null };
        } catch { return { title: HOST(url) || url, snippet: null }; }
    }

    async function rulesRegister(question) {
        try {
            const body = await getJson(`${designUrl}/api/v1/rules`);
            const list = Array.isArray(body.rules) ? body.rules : [];
            const q = words(question);
            const scored = list.map((r) => {
                const text = `${r.rule || ''} ${r.detail || ''} ${r.area || ''}`.toLowerCase();
                let score = 0;
                for (const w of q) if (text.includes(w)) score++;
                return { r, score };
            }).sort((a, b) => b.score - a.score);
            const picked = [];
            for (const { r, score } of scored) {
                if (picked.length >= 14) break;
                if (score || picked.length < 8) picked.push(r);
            }
            return { updated: body.updated || null, rules: picked, areas: body.areas || [] };
        } catch (err) { log.warn(`[deep-dive] rules register: ${String(err && err.message || err).slice(0, 160)}`); return { updated: null, rules: [], areas: [] }; }
    }

    async function componentsRegister(question) {
        try {
            const body = await getJson(`${designUrl}/api/v1/components`);
            const list = Array.isArray(body.components) ? body.components : [];
            const q = words(question);
            const picked = list.filter((c) => {
                const text = `${c.name || ''} ${c.title || ''} ${c.summary || ''}`.toLowerCase();
                return [...q].some((w) => text.includes(w));
            }).slice(0, 6);
            return { version: body.version || null, components: picked.length ? picked : list.slice(0, 4) };
        } catch (err) { log.warn(`[deep-dive] component registry: ${String(err && err.message || err).slice(0, 160)}`); return { version: null, components: [] }; }
    }

    async function github(question, limit = 5) {
        const q = encodeURIComponent(`${question} design`);
        const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${Math.max(1, Math.min(10, limit))}`;
        try {
            await publicTarget(url);
            const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(9000), headers: { accept: 'application/vnd.github+json', 'user-agent': 'OpenVibeDeepDive/1.0', 'x-github-api-version': '2022-11-28' } });
            if (!res.ok) return { projects: [], warning: `GitHub answered ${res.status}` };
            const body = await res.json();
            return { projects: (body.items || []).map((r) => ({ name: r.full_name, url: r.html_url, description: ONE_LINE(r.description, 600), stars: r.stargazers_count || 0, homepage: r.homepage ? String(r.homepage) : null, updated: r.pushed_at || null })) };
        } catch (err) { return { projects: [], warning: `GitHub: ${String(err && err.message || err).slice(0, 160)}` }; }
    }

    /**
     * Gather. Returns { sources, rules, components, warnings }; every source has id src_N, kind, title, url,
     * publisher, engine, snippet, read_at. ctx.signal ends the joins early.
     */
    async function gather({ question, depth, namedSites = [], signal = null, maxSources = 40 }) {
        const at = new Date(now()).toISOString();
        const sources = [];
        const warnings = [];
        const seen = new Set();
        const add = (s) => {
            const url = canon(s.url);
            if (!url || seen.has(url) || sources.length >= maxSources) return null;
            seen.add(url);
            const id = `src_${sources.length + 1}`;
            sources.push({ id, kind: s.kind, title: ONE_LINE(s.title || HOST(url) || url, 400), url, publisher: s.publisher || HOST(url) || null, engine: s.engine || null, snippet: s.snippet ? ONE_LINE(s.snippet, 2000) : null, license: s.license ? ONE_LINE(s.license, 120) : null, read_at: s.read_at || at });
            return id;
        };

        // The person's own sites first: they are always candidates, even if search never finds them.
        for (const raw of namedSites.slice(0, 30)) {
            const url = canon(raw);
            if (!url || !/^https?:/.test(url)) continue;
            const info = await titleOf(url);
            add({ kind: 'named', url, title: info.title, snippet: info.snippet });
        }

        const mega = research && typeof research.gather === 'function'
            ? await research.gather({ query: `${question} design`, max_sources: Math.min(12, maxSources), max_images: depth === 'quick' ? 6 : 10 }, { signal, allowPaid: true }).catch((err) => { warnings.push(`research: ${String(err && err.message || err).slice(0, 160)}`); return null; })
            : null;
        if (mega) {
            for (const s of mega.sources || []) add({ kind: 'web', url: s.url, title: s.title, snippet: s.snippet || s.content, engine: s.provider || 'megasource', publisher: HOST(s.url), license: s.license });
            for (const p of mega.images || []) add({ kind: 'picture', url: p.source_url || p.url, title: p.title || p.description, snippet: p.author ? `by ${p.author}` : null, engine: p.provider || 'commons', license: p.license });
            for (const p of mega.providers ? Object.entries(mega.providers) : []) if (p[1] && p[1].ok === false) warnings.push(`${p[0]}: ${p[1].skipped || p[1].error || 'did not answer'}`);
        }

        if (search && typeof search.search === 'function') {
            const calls = [['web', { q: question, limit: 8 }], ['images', { q: `${question} interface`, limit: 6 }]];
            if (depth === 'expert') calls.push(['icons', { q: question, limit: 6 }]);
            for (const [kind, body] of calls) {
                if (signal && signal.aborted) break;
                try {
                    const page = await search.search(kind, body, {});
                    const engine = page && page.receipt ? page.receipt.engine : 'search';
                    for (const r of (page && page.results) || []) {
                        add({ kind: kind === 'images' ? 'picture' : kind === 'icons' ? 'icon' : 'web', url: r.url, title: r.title, snippet: r.snippet || r.attribution || r.author, engine, publisher: HOST(r.url), license: r.license || null });
                    }
                } catch (err) { warnings.push(`${kind} search: ${String(err && err.message || err).slice(0, 160)}`); }
            }
        }

        const gh = await github(question, depth === 'quick' ? 3 : 6);
        if (gh.warning) warnings.push(gh.warning);
        for (const p of gh.projects) add({ kind: 'project', url: p.url, title: p.name, snippet: `${p.description || ''}${p.stars ? ` · ${p.stars} stars` : ''}${p.homepage ? ` · demo ${p.homepage}` : ''}`.slice(0, 900), engine: 'github', publisher: 'github.com' });

        const rules = await rulesRegister(question);
        for (const r of rules.rules) add({ kind: 'rules', url: r.url || `${designUrl}/rules#${r.id}`, title: `Rule: ${ONE_LINE(r.rule, 180)}`, snippet: ONE_LINE(r.detail || r.why || '', 900), engine: 'openvibe.design', publisher: 'openvibe.design', read_at: at });
        const comps = await componentsRegister(question);
        for (const c of comps.components) add({ kind: 'component', url: `${designUrl}/components`, title: `Component: ${c.title || c.name}`, snippet: ONE_LINE(c.summary || (c.anatomy || []).map((a) => a.role).join('; '), 900), engine: 'openvibe.design', publisher: 'openvibe.design' });

        // Design write-ups from the web results are the ones from the publications that write them.
        for (const s of sources) if (s.kind === 'web' && DESIGN_PUBLISHERS.test(s.url)) s.engine = s.engine || 'write-up';
        return { sources, rules: rules.rules, components: comps.components, warnings };
    }

    return { gather, titleOf, rulesRegister, componentsRegister, github };
}

module.exports = { createSourceGatherer, DESIGN_PUBLISHERS };
