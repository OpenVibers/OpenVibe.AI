'use strict';
/**
 * The deep dive: one durable AI run (workflow design.deep_dive) with seven steps.
 *
 *   plan        a model writes the questions an expert would ask and the searches that answer them
 *   search      MegaSource, AI search's web/picture/icon engines, GitHub and Design's rules + component registers
 *   choose      a model ranks the candidate sites with a reason each; a person may add or drop any before capture
 *               (Quick goes straight on; Thorough and Expert wait up to AI_DEEP_DIVE_CHOOSE_WAIT_SEC)
 *   capture     every chosen site at 390 and 1280 px, light and (when supported) dark, full page after a slow
 *               scroll, with the DOM facts and, at Expert depth, axe-core, LCP/CLS/INP, menus, hover/focus and a
 *               frame strip; every shot is a private Media object of the run's owner; a 7-day cache per viewport
 *               and theme; robots.txt respected
 *   analyse     a text model reads each site's DOM facts, a vision model reads each full-page screenshot; crops are
 *               the evidence for each point
 *   synthesise  patterns across sites, a comparison, the best version, what everyone gets wrong, the gap,
 *               reference tokens, do/don't, accessibility and speed, and recommendations checked against our rules
 *   report      ai.deep-dive@1 assembled from what was actually read and captured, with the receipt of every model
 *               call and capture
 *
 * Cancelling the run aborts the provider calls and every later capture (the runs API's existing cancel). The price
 * shown before the run is held on the tier budgets by the API route; the real cost is the receipt.
 */
const { AiError } = require('../util');
const schemas = require('../schemas');
const events = require('../events');
const { createDeepDiveStore } = require('./store');
const { createLlm } = require('./llm');
const { createSourceGatherer } = require('./sources');
const { DEPTHS, STEPS, REPORT, PLAN_OUTPUT, CHOOSE_OUTPUT, ANALYSIS_OUTPUT, SYNTHESIS_OUTPUT } = require('./schema');
const prompts = require('./prompts');

const iso = (v) => (v ? new Date(v).toISOString() : null);
const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
const uniq = (list, n = 12) => [...new Set((list || []).map((x) => oneLine(x, 600)).filter(Boolean))].slice(0, n);

function createDeepDive({ config = {}, db, clock = { now: () => Date.now() }, log = console, registry, pool, research = null, search = null, capture = null, mediaStore = null, fetcher = null, sourceFetch = null } = {}) {
    const cfg = config.deepDive || {};
    const ccfg = config.capture || {};
    const store = createDeepDiveStore({ db, clock, log });
    const llm = createLlm({ registry, pool, config, log, clock });
    const sources = createSourceGatherer({ config, log, research, search, now: () => clock.now(), ...(sourceFetch ? { fetchImpl: sourceFetch } : {}) });
    const prices = cfg.priceUsd || { quick: 0.2, thorough: 0.5, expert: 1.2 };
    const maxSites = cfg.maxSites || { quick: 6, thorough: 15, expert: 30 };
    const maxSources = cfg.maxSources || { quick: 40, thorough: 80, expert: 140 };
    const maxOut = cfg.maxOutputTokens || 3000;

    function depths() {
        return [
            { key: 'quick', label: 'Quick', sites: maxSites.quick, price_usd: prices.quick, minutes: 3, analysis: 'captures and reads each site; no Expert extras' },
            { key: 'thorough', label: 'Thorough', sites: maxSites.thorough, price_usd: prices.thorough, minutes: 8, analysis: 'more sites, the same captures and analysis' },
            { key: 'expert', label: 'Expert', sites: maxSites.expert, price_usd: prices.expert, minutes: 18, analysis: 'plus interactions, accessibility and speed' },
        ];
    }

    function priceOf(depth) { return Number(prices[depth]) || 0; }
    function limitOf(depth) { return Math.min(Number(maxSites[depth]) || 6, ccfg.maxCaptures || 30); }

    async function emit(row, { step = null, status = null, error = null } = {}) {
        try {
            await events.deepDiveUpdated({
                runId: row.run_id || row.id, deepDiveId: row.id, status: status || row.status, step: step == null ? row.step : step,
                progress: row.progress, steps: row.steps, depth: row.depth, requester: { type: run.requester_type || 'service', id: run.requester_id || 'ai' },
                on_behalf_of: row.owner || null, url: `https://openvibe.exchange/deep-dive/${row.run_id || row.id}`, error,
            });
        } catch (err) { log.warn(`[deep-dive] event failed: ${String((err && err.message) || err).slice(0, 160)}`); }
    }

    async function stepsWith(row, updates = {}) {
        const out = (row.steps && row.steps.length ? row.steps : STEPS.map((key) => ({ key, status: 'pending' }))).map((s) => ({ ...s, ...(updates[s.key] || {}) }));
        return out;
    }

    async function startStep(row, key, detail, progress) {
        const steps = await stepsWith(row, { [key]: { status: 'running', detail: detail || null, started_at: iso(clock.now()) } });
        const next = await store.patch(row.id, { steps, step: key, progress, status: row.status === 'queued' ? 'running' : row.status });
        if (next) await emit(next, { step: key, status: next.status });
        return next;
    }

    async function finishStep(row, key, progress, detail = null) {
        const steps = await stepsWith(row, { [key]: { status: 'done', detail: detail || null, finished_at: iso(clock.now()) } });
        const next = await store.patch(row.id, { steps, step: key, progress });
        if (next) await emit(next, { step: key, status: next.status });
        return next;
    }

    /** The fallback choice when the model returns nothing usable: named sites, then web/project pages. */
    function fallbackCandidates(list, limit) {
        const seen = new Set();
        const out = [];
        for (const s of list) {
            if (s.kind === 'rules' || s.kind === 'component' || s.kind === 'picture' || s.kind === 'icon') continue;
            if (seen.has(s.url)) continue;
            seen.add(s.url);
            out.push({ url: s.url, title: s.title, source_id: s.id, reason: s.kind === 'named' ? 'a site the person named' : 'an expert read from the search' });
            if (out.length >= limit) break;
        }
        return out;
    }

    function evidenceOf(item, sites, capturesBySite) {
        if (!item) return [];
        const site = sites[(Number(item.site) || 1) - 1] || sites[0];
        if (!site) return [];
        const caps = capturesBySite.get(site.source_id) || [];
        const cap = item.capture ? caps[(Number(item.capture) || 1) - 1] : caps.find((c) => c.theme === 'light' && c.viewport === 1280) || caps[0];
        return [{ claim: oneLine(item.claim || 'observed on the site', 600), source_id: site.source_id, capture_id: cap ? cap.id : null, crop_id: cap && cap.crops && cap.crops[0] ? cap.crops[0].id : null, url: site.url, read_at: cap ? cap.captured_at : iso(clock.now()) }];
    }

    /**
     * A synthesis that does not depend on the model: used when the synthesis call fails (a truncated JSON answer,
     * a provider refusal) so a run that already read real sites still reports what it found, with a gap naming the
     * missing step. It is assembled from the per-site analyses and the rules register only; nothing is invented.
     */
    function fallbackSynthesis({ analysis, capturesBySite, rules, question, tokens }) {
        const sites = analysis.map((a) => ({ source_id: a.source_id, url: a.url }));
        const ev = (a, claim) => {
            const cap = (capturesBySite.get(a.source_id) || [])[0];
            return [{ claim: oneLine(claim, 600), source_id: a.source_id, capture_id: cap ? cap.id : null, crop_id: cap && cap.crops && cap.crops[0] ? cap.crops[0].id : null, url: a.url, read_at: cap ? cap.captured_at : iso(clock.now()) }];
        };
        const strengths = new Map();
        const weaknesses = [];
        for (const a of analysis) {
            for (const x of a.strengths || []) strengths.set(x, [...(strengths.get(x) || []), a]);
            for (const x of a.weaknesses || []) weaknesses.push({ a, text: x });
        }
        const patterns = [...strengths.entries()].slice(0, 10).map(([name, list]) => ({ name: oneLine(name, 160), what: `Seen on ${list.length} of ${analysis.length} sites in this run.`, sites: list.map((a) => a.source_id), usage_count: list.length, evidence: list.slice(0, 2).flatMap((a) => ev(a, name)) }));
        if (!patterns.length) patterns.push({ name: 'What the sites are', what: analysis.map((a) => a.summary).filter(Boolean).slice(0, 3).join(' ').slice(0, 1200), sites: sites.map((x) => x.source_id).slice(0, 30), usage_count: sites.length, evidence: analysis.slice(0, 2).flatMap((a) => ev(a, a.summary)) });
        const best = analysis.slice().sort((a, b) => (b.strengths || []).length - (a.strengths || []).length)[0] || null;
        const recs = weaknesses.slice(0, 6).map((w, i) => ({
            id: `rec_${i + 1}`, what: `Avoid: ${oneLine(w.text, 500)}`, why: `Seen on ${w.a.url}; the site analysis says it fails there.`,
            rule: { id: null, status: 'none', text: '' }, evidence: ev(w.a, w.text),
        }));
        if (!recs.length && best) recs.push({ id: 'rec_1', what: `The best version is ${best.url}: keep what it does well.`, why: 'It has the most strengths among the sites read.', rule: { id: null, status: 'none', text: '' }, evidence: ev(best, best.summary) });
        return {
            patterns,
            comparison: { columns: ['Site', 'Summary', 'Good', 'Fails'], rows: analysis.slice(0, 30).map((a) => [a.url, oneLine(a.summary, 600), (a.strengths || []).join('; ').slice(0, 800), (a.weaknesses || []).join('; ').slice(0, 800)]) },
            best: best ? { source_id: best.source_id, what: best.summary, evidence: ev(best, best.summary) } : { source_id: null, what: '', evidence: [] },
            mistakes: weaknesses.slice(0, 12).map((w) => ({ what: w.text, evidence: ev(w.a, w.text) })),
            gap: `A gap in this run: the synthesis model did not answer, so this is assembled from the site analyses. ${oneLine(question, 200)} was not compared by a model.`,
            reference_tokens: {
                palettes: tokens.map((t) => ({ source_id: t.source_id, colours: t.palettes })).filter((x) => x.colours.length).slice(0, 30),
                type_scales: tokens.map((t) => ({ source_id: t.source_id, families: t.families, sizes: t.sizes })).filter((x) => x.families.length || x.sizes.length).slice(0, 30),
                spacing: tokens.map((t) => ({ source_id: t.source_id, steps: t.spacing })).filter((x) => x.steps.length).slice(0, 30),
            },
            do: [...strengths.keys()].slice(0, 12).map((x) => oneLine(x, 600)),
            dont: weaknesses.slice(0, 12).map((w) => oneLine(w.text, 600)),
            accessibility: analysis.map((a) => a.accessibility).filter(Boolean).slice(0, 8),
            speed: analysis.map((a) => a.speed).filter(Boolean).slice(0, 8),
            recommendations: recs,
        };
    }

    /** Run one deep dive for one run row. Returns { output, usage, cost, models } for the workflow step. */
    async function run({ run, input, ctx = {} }) {
        const question = oneLine(input.question, 500);
        const depth = input.depth;
        const siteLimit = limitOf(depth);
        const price = priceOf(depth);
        const owner = run && run.on_behalf_of ? (typeof run.on_behalf_of === 'string' ? JSON.parse(run.on_behalf_of) : run.on_behalf_of) : null;
        const runId = run.id;
        let row = await store.ensure({ runId, question, depth, siteLimit, priceUsd: price, owner });
        if (!row) throw new AiError(500, 'deep_dive.not_stored', 'the deep dive row could not be written');
        const models = [];
        const gaps = [];
        const warnings = [];
        let usage = { input: 0, output: 0 };
        let cost = 0;
        const addCall = (step, r) => {
            if (!r) return;
            models.push({ step, provider: r.provider, model: r.model, tokens_in: r.tokens_in || 0, tokens_out: r.tokens_out || 0, cost_usd: Number(r.cost_usd) || 0, ms: r.ms || 0 });
            usage = { input: usage.input + (r.tokens_in || 0), output: usage.output + (r.tokens_out || 0) };
            cost += Number(r.cost_usd) || 0;
        };
        const check = () => { if (ctx.signal && ctx.signal.aborted) throw new AiError(409, 'run.cancelled', 'cancelled'); };
        // The price shown before the run is the ceiling the run holds itself to (the receipt may be lower).
        const overBudget = () => price > 0 && cost >= price;

        try {
            await store.patch(row.id, { status: 'running', step: 'plan', progress: 0.01 });
            row = await store.get(row.id);
            await emit(row, { step: 'plan', status: 'running' });

            // 1. Plan
            row = await startStep(row, 'plan', 'writing the expert questions', 0.03);
            check();
            const plan = await llm.call({ routeKey: 'default.json', ...prompts.planPrompt({ question, depth, named: input.sites || [] }), schema: PLAN_OUTPUT, schemaName: 'deep_dive_plan', maxTokens: Math.min(1200, maxOut), signal: ctx.signal, ctx });
            addCall('plan', plan);
            row = await finishStep(row, 'plan', 0.1, `${(plan.json.questions || []).length} questions, ${(plan.json.searches || []).length} searches`);

            // 2. Search, every way we have.
            row = await startStep(row, 'search', 'MegaSource, the search engines, GitHub and our own registers', 0.12);
            check();
            const gathered = await sources.gather({ question, depth, namedSites: input.sites || [], signal: ctx.signal, maxSources: maxSources[depth] || 40 });
            const allSources = gathered.sources || [];
            for (const w of gathered.warnings || []) warnings.push(w);
            if (!allSources.length) throw new AiError(502, 'source.unavailable', 'no search source answered for this question');
            row = await finishStep(row, 'search', 0.3, `${allSources.length} sources from ${new Set(allSources.map((s) => s.engine).filter(Boolean)).size} engines`);

            // 3. Choose
            row = await startStep(row, 'choose', 'ranking the sites worth capturing', 0.32);
            check();
            let chosen = [];
            try {
                const pickable = allSources.filter((s) => ['web', 'project', 'named'].includes(s.kind));
                const choose = await llm.call({ routeKey: 'default.json', ...prompts.choosePrompt({ question, depth, limit: siteLimit, sources: pickable.slice(0, 60) }), schema: CHOOSE_OUTPUT, schemaName: 'deep_dive_choose', maxTokens: Math.min(1600, maxOut), signal: ctx.signal, ctx });
                addCall('choose', choose);
                for (const c of choose.json.sites || []) {
                    const url = String(c.url || '').replace(/#.*$/, '');
                    const src = pickable.find((s) => s.url.replace(/\/$/, '') === url.replace(/\/$/, ''));
                    // A model may only choose from what was read: a URL that is not in the list is not invented into one.
                    if (!src) continue;
                    chosen.push({ url: src.url, title: c.title || src.title || hostOf(src.url), reason: oneLine(c.reason, 600), source_id: src.id, kind: src.kind });
                }
            } catch (err) {
                warnings.push(`choosing: ${String((err && err.message) || err).slice(0, 200)}`);
            }
            // The person's named sites are always candidates; the model only ranks the rest.
            for (const s of allSources.filter((x) => x.kind === 'named')) if (!chosen.some((c) => c.url === s.url)) chosen.unshift({ url: s.url, title: s.title, reason: 'a site the person named', source_id: s.id, kind: 'named' });
            chosen = chosen.filter((c, i) => c.url && chosen.findIndex((x) => x.url.replace(/\/$/, '') === c.url.replace(/\/$/, '')) === i).slice(0, siteLimit);
            if (!chosen.length) chosen = fallbackCandidates(allSources, siteLimit);
            chosen = chosen.map((c, i) => ({ ...c, id: `site_${i + 1}`, chosen: true }));
            row = await store.patch(row.id, { candidates: chosen, status: 'choosing', step: 'choose', progress: 0.34, decision_at: depth === 'quick' ? iso(clock.now()) : null });
            await emit(row, { step: 'choose', status: 'choosing' });
            if (depth !== 'quick') {
                const until = clock.now() + Math.max(0, Number(cfg.chooseWaitSec) || 0) * 1000;
                while (clock.now() < until) {
                    check();
                    const fresh = await store.get(row.id);
                    if (fresh.decision_at) { row = fresh; break; }
                    await new Promise((r) => { const t = setTimeout(r, 1000); t.unref?.(); });
                }
                row = await store.get(row.id);
                if (Array.isArray(row.candidates) && row.candidates.length) chosen = row.candidates.slice(0, siteLimit);
            }
            row = await finishStep(row, 'choose', 0.4, `${chosen.length} sites`);
            row = await store.patch(row.id, { status: 'running' });

            // 4. Capture
            row = await startStep(row, 'capture', `0/${chosen.length} sites`, 0.42);
            check();
            const captures = [];
            const capturesBySite = new Map();
            const analysisSources = [];
            for (const [i, site] of chosen.entries()) {
                check();
                const sourceId = site.source_id || `src_named_${i + 1}`;
                if (!allSources.some((s) => s.id === sourceId)) allSources.push({ id: sourceId, kind: 'named', title: site.title || hostOf(site.url), url: site.url, publisher: hostOf(site.url), engine: null, snippet: null, license: null, read_at: iso(clock.now()) });
                const siteCaps = [];
                const extras = depth === 'expert';
                try {
                    const cachedLight = (await store.cacheGet(site.url, 1280, 'light', extras)) && (await store.cacheGet(site.url, 390, 'light', extras));
                    if (!extras && cachedLight) {
                        for (const c of [await store.cacheGet(site.url, 390, 'light', extras), await store.cacheGet(site.url, 1280, 'light', extras)]) if (c) siteCaps.push({ ...c, cached: true });
                    } else if (capture) {
                        const got = await capture.captureSite({ url: site.url, runId, owner: owner && owner.id, extras, signal: ctx.signal });
                        if (got && got.skipped) {
                            warnings.push(`${hostOf(site.url) || site.url}: ${got.reason || got.skipped}`);
                            captures.push({ id: `cap_${captures.length + 1}`, source_id: sourceId, url: site.url, final_url: null, title: site.title || null, captured_at: iso(clock.now()), viewport: 390, theme: 'light', full_page: false, media_id: null, width: null, height: null, crops: [], dom: null, extras: null, skip: String(got.skipped === 'robots_disallowed' ? 'robots_disallowed' : got.skipped).slice(0, 200), cached: false });
                        }
                        for (const combo of (got && got.combos) || []) {
                            siteCaps.push(combo);
                            await store.cachePut(site.url, combo.viewport, combo.theme, extras, combo, ccfg.cacheDays || 7);
                        }
                    }
                } catch (err) {
                    if (err && err.code === 'run.cancelled') throw err;
                    warnings.push(`${hostOf(site.url) || site.url}: ${String((err && err.message) || err).slice(0, 200)}`);
                }
                for (const combo of siteCaps) {
                    const cap = {
                        id: `cap_${captures.length + 1}`, source_id: sourceId, url: site.url, final_url: combo.final_url || site.url,
                        title: combo.title || site.title || null, captured_at: combo.captured_at || iso(clock.now()),
                        viewport: combo.viewport, theme: combo.theme, full_page: combo.full_page !== false,
                        media_id: combo.media_id || null, width: combo.width || combo.viewport || null, height: combo.height || null,
                        crops: (combo.crops || []).map((c, j) => ({ id: `crop_${capidSafe(captures.length, j)}`, media_id: c.media_id, y: c.y, height: c.height })),
                        dom: combo.dom || null, extras: combo.extras || null, skip: null, cached: Boolean(combo.cached),
                    };
                    captures.push(cap);
                    if (cap.dom) analysisSources.push({ cap, site, sourceId });
                }
                capturesBySite.set(sourceId, captures.filter((c) => c.source_id === sourceId));
                try {
                    await db.prepare(`INSERT INTO requests (run_id, seq, operation, provider_key, model_key, route_key, route_version, status, skip_reason, fallback, input_hash, tokens_in, tokens_out, tokens_cached, tokens_estimated, cost_usd, latency_ms, created_at)
                        VALUES (?, ?, 'capture', 'capture', NULL, NULL, NULL, ?, ?, 0, NULL, 0, 0, 0, 0, 0, ?, ?)`)
                        .run(runId, 100000 + i, captures.filter((c) => c.source_id === sourceId).length ? 'ok' : 'skipped', captures.filter((c) => c.source_id === sourceId).length ? null : 'no capture', Date.now() - (comboMs(captures) || Date.now()), iso(clock.now())).catch(() => {});
                } catch { /* the receipt is best effort for a capture that was refused */ }
                row = await store.patch(row.id, { captures, progress: 0.42 + (0.28 * (i + 1)) / Math.max(1, chosen.length) });
                row = await store.patch(row.id, { step: 'capture', steps: await stepsWith(row, { capture: { status: 'running', detail: `${i + 1}/${chosen.length} sites` } }) });
                await emit(row, { step: 'capture' });
            }
            row = await finishStep(row, 'capture', 0.7, `${captures.filter((c) => !c.skip).length} captures`);

            // 5. Analyse: the DOM facts by text, each full-page screenshot by a vision model.
            row = await startStep(row, 'analyse', `0/${chosen.length} sites`, 0.72);
            const analysis = [];
            const analysed = new Set();
            for (const [i, site] of chosen.entries()) {
                check();
                const sourceId = site.source_id || `src_named_${i + 1}`;
                const siteCaps = capturesBySite.get(sourceId) || [];
                const primary = siteCaps.find((c) => c.theme === 'light' && c.viewport === 1280 && c.dom) || siteCaps.find((c) => c.dom) || null;
                const evidence = [];
                let text = null;
                if (primary && !overBudget()) {
                    try {
                        text = await llm.call({ routeKey: 'default.json', ...prompts.domAnalysisPrompt({ question, source: { title: site.title, url: site.url }, capture: primary, dom: primary.dom }), schema: ANALYSIS_OUTPUT, schemaName: 'deep_dive_site', maxTokens: Math.min(1800, maxOut), signal: ctx.signal, ctx });
                        addCall('analyse', text);
                    } catch (err) { warnings.push(`analysis of ${hostOf(site.url) || site.url}: ${String((err && err.message) || err).slice(0, 200)}`); }
                }
                // Each light full-page shot (both viewports; Expert also dark) is read by the vision model.
                const shots = siteCaps.filter((c) => c.media_id && c.full_page && (c.theme === 'light' || depth === 'expert'));
                let vision = null;
                for (const [j, cap] of shots.entries()) {
                    check();
                    if (overBudget()) { gaps.push('The held price was reached before every screenshot was read; the remaining screenshots are evidence only.'); break; }
                    if (!mediaStore || typeof mediaStore.bytes !== 'function') break;
                    try {
                        const got = await mediaStore.bytes(cap.media_id, { owner: owner && owner.id, signal: ctx.signal });
                        const image = await fetcher.loadImage({ data_url: `data:${got.mime || 'image/png'};base64,${got.buffer.toString('base64')}`, max_width: cap.viewport === 390 ? 390 : 1024 });
                        const read = await llm.call({ routeKey: depth === 'expert' ? 'background.vision' : 'default.json', ...prompts.visionPrompt({ question, source: { title: site.title, url: site.url }, viewport: cap.viewport, theme: cap.theme, index: j + 1, total: shots.length }), image, schema: ANALYSIS_OUTPUT, schemaName: 'deep_dive_shot', maxTokens: Math.min(1500, maxOut), signal: ctx.signal, ctx });
                        addCall('analyse', read);
                        for (const e of (read.json.evidence || []).slice(0, 6)) evidence.push({ claim: oneLine(e.claim, 600), source_id: sourceId, capture_id: cap.id, crop_id: cap.crops && cap.crops[0] ? cap.crops[0].id : null, url: site.url, read_at: cap.captured_at });
                        if (!vision) vision = read.json;
                        else {
                            vision = {
                                ...vision,
                                summary: vision.summary || read.json.summary,
                                strengths: uniq([...(vision.strengths || []), ...(read.json.strengths || [])], 8),
                                weaknesses: uniq([...(vision.weaknesses || []), ...(read.json.weaknesses || [])], 8),
                            };
                        }
                    } catch (err) { warnings.push(`vision on ${hostOf(site.url) || site.url}: ${String((err && err.message) || err).slice(0, 160)}`); }
                }
                const t = (text && text.json) || {};
                const v = vision || {};
                let accessibility = t.accessibility || null;
                if (primary && primary.extras) {
                    const axe = primary.extras.a11y || {};
                    const violations = Array.isArray(axe.violations) ? axe.violations : [];
                    const measured = violations.length ? `${violations.length} axe-core violations: ${violations.slice(0, 4).map((x) => `${x.id}${x.impact ? ` (${x.impact})` : ''}`).join(', ')}` : (axe.error ? `axe-core could not run: ${axe.error}` : 'no axe-core violations at WCAG 2.1 AA');
                    accessibility = measured;
                    const m = primary.extras.metrics || {};
                    if (m.lcp_ms != null || m.cls != null) {
                        const speed = `LCP ${m.lcp_ms == null ? '—' : `${m.lcp_ms} ms`}; CLS ${m.cls == null ? '—' : m.cls}; INP ${m.inp_ms == null ? 'not measured' : `${m.inp_ms} ms`}; ${m.long_tasks || 0} long tasks`;
                        t.speed = t.speed && t.speed !== 'not measured at this depth' ? `${speed}. ${t.speed}` : speed;
                    }
                }
                const firstCap = siteCaps.find((c) => c.media_id) || null;
                analysis.push({
                    source_id: sourceId, url: site.url,
                    summary: oneLine(t.summary || v.summary || (primary ? 'Captured; the analysis did not answer.' : 'Not captured.'), 4000),
                    first_impression: oneLine(v.first_impression || t.first_impression || '', 2000),
                    hierarchy: oneLine(t.hierarchy || v.hierarchy || '', 2000), density: oneLine(t.density || v.density || '', 2000),
                    type: oneLine(t.type || v.type || '', 2000), colour: oneLine(t.colour || v.colour || '', 2000),
                    motion: oneLine(t.motion || v.motion || '', 2000), words: oneLine(t.words || v.words || '', 2000),
                    strengths: uniq([...(v.strengths || []), ...(t.strengths || [])], 12),
                    weaknesses: uniq([...(v.weaknesses || []), ...(t.weaknesses || [])], 12),
                    accessibility: accessibility || null, speed: t.speed || null,
                    evidence: evidence.length ? evidence.slice(0, 20) : (firstCap ? [{ claim: 'the page as captured', source_id: sourceId, capture_id: firstCap.id, crop_id: firstCap.crops && firstCap.crops[0] ? firstCap.crops[0].id : null, url: site.url, read_at: firstCap.captured_at }] : []),
                });
                analysed.add(sourceId);
                row = await store.patch(row.id, { progress: 0.72 + (0.16 * (i + 1)) / Math.max(1, chosen.length), steps: await stepsWith(row, { analyse: { status: 'running', detail: `${i + 1}/${chosen.length} sites` } }) });
                await emit(row, { step: 'analyse' });
            }
            row = await finishStep(row, 'analyse', 0.88, `${analysis.length} sites analysed`);

            // 6. Synthesise: cross-site patterns, the gap, recommendations against our rules.
            row = await startStep(row, 'synthesise', 'comparing sites against our rules', 0.9);
            check();
            const tokens = analysis.map((a) => {
                const cap = (capturesBySite.get(a.source_id) || []).find((c) => c.dom) || {};
                const dom = cap.dom || {};
                return {
                    source_id: a.source_id,
                    palettes: (dom.palette ? [...(dom.palette.backgrounds || []), ...(dom.palette.text || [])] : []).slice(0, 6).map((x) => x.value),
                    families: (dom.fonts ? (dom.fonts.families || []) : []).slice(0, 3).map((x) => x.value),
                    sizes: (dom.fonts ? (dom.fonts.sizes || []) : []).slice(0, 8).map((x) => x.value),
                    spacing: (dom.spacing || []).slice(0, 8).map((x) => x.value),
                };
            });
            // The synthesis is the longest answer: a bigger budget than the other steps, on the background JSON
            // route (it may wait for the cheapest correct model). If the model still truncates or refuses, the
            // report is assembled from the site analyses and names the missing synthesis as a gap.
            let s = null;
            try {
                const synthCall = await llm.call({ routeKey: cfg.synthesisRoute || 'background.json', ...prompts.synthesisPrompt({ question, depth, analyses: analysis, sources: allSources, rules: gathered.rules || [], components: gathered.components || [], tokens }), schema: SYNTHESIS_OUTPUT, schemaName: 'deep_dive_synthesis', maxTokens: Math.min(5000, Math.max(4000, maxOut)), signal: ctx.signal, ctx });
                addCall('synthesise', synthCall);
                s = synthCall.json || null;
            } catch (err) {
                if (err && err.code === 'run.cancelled') throw err;
                warnings.push(`synthesis: ${String((err && err.message) || err).slice(0, 240)}`);
                gaps.push('The synthesis model did not answer; the synthesis was assembled from the site analyses.');
                s = fallbackSynthesis({ analysis, capturesBySite, rules: gathered.rules || [], question, tokens });
            }
            const sitesForEvidence = analysis.map((a) => ({ source_id: a.source_id, url: a.url }));
            const ruleIds = new Set((gathered.rules || []).map((r) => r.id));
            const mapEvidence = (list) => (Array.isArray(list) ? list : []).flatMap((e) => (e && e.source_id && e.url ? [e] : evidenceOf(e, sitesForEvidence, capturesBySite))).slice(0, 20);
            const bestSite = (s.best && s.best.source_id ? sitesForEvidence.find((x) => x.source_id === s.best.source_id) : sitesForEvidence[(Number(s.best && s.best.site) || 1) - 1]) || sitesForEvidence[0];
            const synthesis = {
                patterns: (s.patterns || []).slice(0, 40).map((p) => ({
                    name: oneLine(p.name, 160), what: oneLine(p.what, 1200),
                    sites: (p.sites || []).map((n) => (sitesForEvidence[(Number(n) || 1) - 1] || {}).source_id).filter(Boolean).slice(0, 30),
                    usage_count: Number(p.usage_count) || 0, evidence: mapEvidence(p.evidence),
                })),
                comparison: { columns: (s.comparison && s.comparison.columns || []).slice(0, 12), rows: (s.comparison && s.comparison.rows || []).slice(0, 30) },
                best: bestSite ? { source_id: bestSite.source_id, what: oneLine(s.best && s.best.what || '', 2000), evidence: mapEvidence(s.best && s.best.evidence) } : { source_id: null, what: '', evidence: [] },
                mistakes: (s.mistakes || []).slice(0, 20).map((m) => ({ what: oneLine(m.what, 1200), evidence: mapEvidence(m.evidence) })),
                gap: oneLine(s.gap, 2000),
                reference_tokens: {
                    palettes: (s.reference_tokens && s.reference_tokens.palettes || []).map((p) => ({ source_id: p.source_id || (sitesForEvidence[(Number(p.site) || 1) - 1] || {}).source_id, colours: (p.colours || []).slice(0, 16) })).filter((p) => p.source_id).slice(0, 30),
                    type_scales: (s.reference_tokens && s.reference_tokens.type_scales || []).map((p) => ({ source_id: p.source_id || (sitesForEvidence[(Number(p.site) || 1) - 1] || {}).source_id, families: (p.families || []).slice(0, 8), sizes: (p.sizes || []).slice(0, 16) })).filter((p) => p.source_id).slice(0, 30),
                    spacing: (s.reference_tokens && s.reference_tokens.spacing || []).map((p) => ({ source_id: p.source_id || (sitesForEvidence[(Number(p.site) || 1) - 1] || {}).source_id, steps: (p.steps || []).slice(0, 16) })).filter((p) => p.source_id).slice(0, 30),
                },
                do: (s.do || []).slice(0, 20).map((x) => oneLine(x, 600)),
                dont: (s.dont || []).slice(0, 20).map((x) => oneLine(x, 600)),
                accessibility: (s.accessibility || []).slice(0, 20).map((x) => oneLine(x, 600)),
                speed: (s.speed || []).slice(0, 20).map((x) => oneLine(x, 600)),
            };
            if (!synthesis.best.source_id) synthesis.best = { source_id: analysis[0] ? analysis[0].source_id : null, what: synthesis.best.what, evidence: synthesis.best.evidence };
            const recommendations = (s.recommendations || []).slice(0, 20).map((r, i) => {
                const id = r.rule && r.rule.id && ruleIds.has(r.rule.id) ? r.rule.id : null;
                const status = id ? (r.rule.status === 'would_change' ? 'would_change' : 'follows') : 'none';
                let ev = mapEvidence(r.evidence);
                if (!ev.length && analysis[0]) {
                    const cap = (capturesBySite.get(analysis[0].source_id) || [])[0];
                    ev = [{ claim: oneLine(r.what, 600), source_id: analysis[0].source_id, capture_id: cap ? cap.id : null, crop_id: cap && cap.crops && cap.crops[0] ? cap.crops[0].id : null, url: analysis[0].url, read_at: cap ? cap.captured_at : iso(clock.now()) }];
                }
                return { id: `rec_${i + 1}`, what: oneLine(r.what, 1200), why: oneLine(r.why, 2000), rule: { id, status, text: oneLine((r.rule && r.rule.text) || (id && (gathered.rules || []).find((x) => x.id === id) || {}).rule || '', 600) }, evidence: ev };
            });
            if (!recommendations.length) gaps.push('The synthesis returned no recommendation; nothing is proposed.');
            row = await finishStep(row, 'synthesise', 0.96, `${synthesis.patterns.length} patterns, ${recommendations.length} recommendations`);

            // 7. Report
            row = await startStep(row, 'report', 'assembling the report and its receipt', 0.98);
            const nowIso = iso(clock.now());
            const report = {
                id: runId, schema: 'ai.deep-dive@1', run_id: runId, status: 'succeeded',
                input: { question, depth, max_sites: siteLimit, ...(input.sites && input.sites.length ? { sites: input.sites } : {}) },
                steps: (await store.get(row.id)).steps,
                sources: allSources.slice(0, 200),
                captures,
                analysis,
                synthesis,
                recommendations,
                receipt: { price_usd: price, held_usd: price, cost_usd: Math.round(cost * 1e6) / 1e6, models, captures_count: captures.filter((c) => !c.skip).length, synthetic: models.some((m) => !m.provider) },
                gaps: [...new Set([...gaps, ...warnings])].slice(0, 40),
                created_at: row.created_at, updated_at: nowIso, finished_at: nowIso,
            };
            const v = schemas.validate(REPORT, report);
            if (!v.valid) throw new AiError(502, 'output.invalid', `the deep dive report does not match ai.deep-dive@1: ${v.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`, { errors: v.errors });
            const steps = (await store.get(row.id)).steps.map((x) => (x.key === 'report' ? { ...x, status: 'done', finished_at: nowIso } : x));
            row = await store.patch(row.id, { status: 'succeeded', step: 'report', progress: 1, steps, report, gaps: report.gaps, finished_at: nowIso });
            await emit(row, { step: 'done', status: 'succeeded' });
            return { output: report, usage, cost, models };
        } catch (err) {
            const cancelled = (err && err.code === 'run.cancelled') || (ctx.signal && ctx.signal.aborted);
            const code = cancelled ? 'run.cancelled' : ((err && err.code) || 'run.internal');
            const detail = String((err && (err.detail || err.message)) || 'the run failed').slice(0, 500);
            try {
                const steps = (await store.get(row.id)).steps.map((x) => (x.status === 'running' ? { ...x, status: cancelled ? 'skipped' : 'failed', finished_at: iso(clock.now()) } : x));
                const failed = await store.patch(row.id, { status: cancelled ? 'cancelled' : 'failed', steps, error_code: code, error_detail: detail, finished_at: iso(clock.now()) });
                if (failed) await emit(failed, { status: failed.status, error: { code, detail } });
            } catch (e) { log.warn(`[deep-dive] could not record the failure: ${e.message}`); }
            throw err;
        }
    }

    return { run, depths, priceOf, limitOf, store, capture, mediaStore, sources };
}

function capidSafe(n, j) { return `${n + 1}_${j + 1}`; }
function comboMs(captures) { return 0; }

module.exports = { createDeepDive };
