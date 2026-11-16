'use strict';
/**
 * The general deep dive: workflow research.deep_dive, report ai.research@1. The owner, 11-15: Exchange's search "was
 * meant to deep dive any query in a general sense", and OpenVibe.Design's design deep dive uses it as its core. It
 * researches any question the way an expert would, in six steps:
 *
 *   plan     a model writes the sub-questions an expert would need answered, and the searches that find them
 *   search   MegaSource, plus the web engine on the question and on every planned search; GitHub for software
 *   choose   a model picks the pages worth reading in full, with a reason each; the person's own pages always come
 *   read     each page is fetched as text (reader.js: public HTTPS only, robots.txt, 1.5 MB), three at a time
 *   analyse  a model takes notes on each page against the questions: what it says, short exact quotes, what it is
 *   write    the answer: a summary, key points, an answer per question with its confidence, a comparison when the
 *            question compares, where the sources disagree, what is still open, and what to do next. Every claim
 *            cites the pages it rests on, and nothing is said that the notes do not hold
 *
 * The price shown before the run is the ceiling it holds itself to: once the receipt reaches it, no more pages are
 * analysed and the answer is written from what was read (a gap says so). Cancelling stops the next fetch and model
 * call. No ai.deep_dive.updated event is sent (its steps are the design dive's); the page polls the state.
 */
const { AiError } = require('../util');
const schemas = require('../schemas');
const prompts = require('./prompts');
const { PLAN_OUTPUT, PAGES_OUTPUT, PAGE_READ_OUTPUT, WRITE_OUTPUT, RESEARCH_STEPS, RESEARCH_REPORT } = require('./schema');

const iso = (v) => (v ? new Date(v).toISOString() : null);
const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
const same = (a, b) => String(a || '').replace(/#.*$/, '').replace(/\/$/, '') === String(b || '').replace(/#.*$/, '').replace(/\/$/, '');

/** At most `n` at a time, in order. */
async function pool(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    }));
    return out;
}

function createResearch({ config = {}, store, llm, sources, reader, clock = { now: () => Date.now() }, log = console }) {
    const cfg = (config.deepDive && config.deepDive.research) || {};
    const prices = cfg.priceUsd || { quick: 0.1, thorough: 0.3, expert: 0.8 };
    const maxPages = cfg.maxPages || { quick: 8, thorough: 16, expert: 30 };
    const maxSources = cfg.maxSources || { quick: 40, thorough: 70, expert: 120 };
    const maxOut = (config.deepDive && config.deepDive.maxOutputTokens) || 3000;
    const writeRoute = (config.deepDive && config.deepDive.synthesisRoute) || 'background.json';

    function depths() {
        return [
            { key: 'quick', label: 'Quick', pages: maxPages.quick, price_usd: prices.quick, minutes: 1, analysis: `reads the ${maxPages.quick} best pages and answers with their sources` },
            { key: 'thorough', label: 'Thorough', pages: maxPages.thorough, price_usd: prices.thorough, minutes: 3, analysis: `reads ${maxPages.thorough} pages from more searches` },
            { key: 'expert', label: 'Expert', pages: maxPages.expert, price_usd: prices.expert, minutes: 6, analysis: `reads ${maxPages.expert} pages, every angle the plan finds` },
        ];
    }
    const priceOf = (depth) => Number(prices[depth]) || 0;
    const limitOf = (depth) => Math.max(1, Math.min(40, Number(maxPages[depth]) || 8));

    const blankSteps = () => RESEARCH_STEPS.map((key) => ({ key, status: 'pending' }));
    async function step(row, key, status, { detail = null, progress = null } = {}) {
        const now = iso(clock.now());
        const steps = (row.steps && row.steps.length ? row.steps : blankSteps()).map((s) => (s.key !== key ? s : {
            ...s, status, detail: detail == null ? s.detail || null : oneLine(detail, 300),
            ...(status === 'running' && !s.started_at ? { started_at: now } : {}),
            ...(['done', 'failed', 'skipped'].includes(status) ? { finished_at: now } : {}),
        }));
        return store.patch(row.id, { steps, step: key, ...(progress != null ? { progress } : {}), ...(row.status === 'queued' ? { status: 'running' } : {}) });
    }

    // ── The core: what the general deep dive runs as its read, analyse and write steps, and the design dive
    //    (index.js) as its read step. Each reports its progress through a callback and never touches a row itself. ──

    /** Read the chosen pages as text, three at a time; spares stand in for those that cannot be read. */
    async function readPages({ chosen, target, ctx = {}, check = () => {}, onRead = null }) {
        const reads = [];
        const texts = new Map();
        let readCount = 0;
        const queue = chosen.slice();
        const readOne = async (page) => {
            check();
            let got;
            try { got = await reader.read(page.url, { signal: ctx.signal }); } catch (err) {
                if (err && err.code === 'run.cancelled') throw err;
                got = { status: 'skipped', url: page.url, reason: 'the page could not be read' };
            }
            const r = {
                id: `read_${reads.length + 1}`, source_id: page.source_id, url: page.url, final_url: got.final_url || null,
                title: oneLine(got.title || page.title || hostOf(page.url), 400) || null, site: got.site ? oneLine(got.site, 200) : hostOf(page.url),
                published: got.published || null, read_at: iso(clock.now()), words: got.words || 0, status: got.status === 'read' ? 'read' : 'skipped',
                reason: got.status === 'read' ? null : oneLine(got.reason || 'not read', 300), relevant: null, summary: null, kind: null, findings: [],
            };
            reads.push(r);
            if (r.status === 'read') { texts.set(r.id, got.text); readCount += 1; }
            if (onRead) await onRead(reads, readCount);
            return r;
        };
        await pool(queue.splice(0, target), 3, readOne);
        while (readCount < target && queue.length) await readOne(queue.shift());
        return { reads, texts, readCount };
    }

    /** Notes on each page read (what it says, short exact quotes, the kind of source), three at a time, in budget. */
    async function notePages({ reads, texts, question, questions, ctx = {}, check = () => {}, overBudget = () => false, warnings = [], addCall = () => {}, onNote = null }) {
        let noted = 0;
        let budgetGap = false;
        await pool(reads.filter((r) => r.status === 'read'), 3, async (r) => {
            check();
            if (overBudget()) { budgetGap = true; return; }
            try {
                const notes = await llm.call({ routeKey: 'default.json', ...prompts.readPagePrompt({ question, questions, page: { title: r.title, url: r.final_url || r.url, site: r.site, published: r.published, text: texts.get(r.id) } }), schema: PAGE_READ_OUTPUT, schemaName: 'research_page', maxTokens: Math.min(1400, maxOut), signal: ctx.signal, ctx });
                addCall(notes);
                const j = notes.json || {};
                r.relevant = j.relevant !== false;
                r.summary = oneLine(j.summary, 1500) || null;
                r.kind = ['primary', 'reference', 'news', 'opinion', 'vendor', 'forum', 'other'].includes(j.kind) ? j.kind : null;
                r.findings = (j.findings || []).slice(0, 8).map((f) => ({ point: oneLine(f.point, 600), quote: f.quote ? oneLine(f.quote, 400) : null })).filter((f) => f.point);
            } catch (err) {
                if (err && err.code === 'run.cancelled') throw err;
                warnings.push(`notes on ${hostOf(r.url) || r.url}: ${String((err && err.message) || err).slice(0, 160)}`);
            }
            noted += 1;
            if (onNote) await onNote(reads, noted);
        });
        return { budgetGap };
    }

    /** The answer from the notes, every claim citing its pages by source id; assembled from the notes if the model fails. */
    async function answerFrom({ question, questions, reads, ctx = {}, warnings = [], gaps = [], addCall = () => {} }) {
        const noted = reads.filter((r) => r.status === 'read' && r.summary && r.relevant !== false);
        const numbered = (noted.length ? noted : reads.filter((r) => r.status === 'read')).slice(0, 30);
        const cite = (list) => [...new Set((Array.isArray(list) ? list : []).map((n) => numbered[(Number(n) || 0) - 1]).filter(Boolean).map((r) => r.source_id))].slice(0, 8);
        let answer;
        try {
            const w = await llm.call({ routeKey: writeRoute, ...prompts.writePrompt({ question, questions, notes: numbered.map((r, i) => ({ n: i + 1, title: r.title, url: r.final_url || r.url, site: r.site, published: r.published, kind: r.kind, summary: r.summary || '', findings: r.findings })) }), schema: WRITE_OUTPUT, schemaName: 'research_answer', maxTokens: Math.min(5000, Math.max(3000, maxOut)), signal: ctx.signal, ctx });
            addCall(w);
            const j = w.json || {};
            answer = {
                summary: oneLine(j.summary, 3000),
                key_points: (j.key_points || []).slice(0, 12).map((k) => ({ text: oneLine(k.text, 800), sources: cite(k.sources) })).filter((k) => k.text),
                answers: (j.answers || []).slice(0, 12).map((a) => ({ question: (questions[(Number(a.question) || 0) - 1] || {}).question || '', answer: oneLine(a.answer, 2000), confidence: ['high', 'medium', 'low'].includes(a.confidence) ? a.confidence : 'medium', sources: cite(a.sources) })).filter((a) => a.question && a.answer),
                comparison: j.comparison && Array.isArray(j.comparison.columns) && j.comparison.columns.length && Array.isArray(j.comparison.rows) && j.comparison.rows.length
                    ? { columns: j.comparison.columns.slice(0, 8).map((c) => oneLine(c, 120)), rows: j.comparison.rows.slice(0, 20).map((r) => (Array.isArray(r) ? r : []).slice(0, 8).map((c) => oneLine(c, 600))) } : null,
                disagreements: (j.disagreements || []).slice(0, 10).map((d) => ({ what: oneLine(d.what, 800), sources: cite(d.sources) })).filter((d) => d.what),
                open_questions: (j.open_questions || []).slice(0, 10).map((x) => oneLine(x, 400)).filter(Boolean),
                next_steps: (j.next_steps || []).slice(0, 10).map((x) => oneLine(x, 400)).filter(Boolean),
            };
            if (!answer.summary) throw new Error('the answer came back empty');
        } catch (err) {
            if (err && err.code === 'run.cancelled') throw err;
            warnings.push(`writing: ${String((err && err.message) || err).slice(0, 240)}`);
            gaps.push('The answer model did not answer; this answer is assembled from the notes on each page.');
            answer = {
                summary: oneLine(numbered.map((r) => r.summary).filter(Boolean).slice(0, 3).join(' '), 3000) || `The pages read about "${question}" are listed with what each says.`,
                key_points: numbered.flatMap((r) => r.findings.slice(0, 1).map((f) => ({ text: f.point, sources: [r.source_id] }))).slice(0, 10),
                answers: [], comparison: null, disagreements: [], open_questions: questions.map((q) => q.question).slice(0, 6), next_steps: [],
            };
        }
        return { answer, numbered };
    }

    /** One run of the general deep dive. Returns { output, usage, cost, models } for the workflow step. */
    /**
     * Choose: a model picks the pages worth reading in full, with a reason each, and only from what the search found. The
     * person's own pages come first; when too few are chosen, the search's own order fills the rest, one page per site
     * first. Two more than the limit are kept as spares for pages that cannot be read. The general deep dive's step, and
     * the design deep dive's read step uses it too (11-16: in search order it read Wikidata and a code file).
     */
    async function choosePages({ question, questions, sources: readable, limit, ctx = {}, warnings = [], addCall = () => {} }) {
        let chosen = [];
        try {
            const pick = await llm.call({ routeKey: 'default.json', ...prompts.choosePagesPrompt({ question, questions, limit: limit + 2, sources: readable.slice(0, 70) }), schema: PAGES_OUTPUT, schemaName: 'research_pages', maxTokens: Math.min(1800, maxOut), signal: ctx.signal, ctx });
            addCall(pick);
            for (const p of (pick.json && pick.json.pages) || []) {
                // A model may only choose what the search found: a URL that is not in the list is never read.
                const src = readable.find((s) => same(s.url, p.url));
                if (src && !chosen.some((c) => c.source_id === src.id)) chosen.push({ url: src.url, title: src.title, reason: oneLine(p.reason, 600), source_id: src.id });
            }
        } catch (err) {
            if (err && err.code === 'run.cancelled') throw err;
            warnings.push(`choosing: ${String((err && err.message) || err).slice(0, 200)}`);
        }
        for (const s of readable.filter((x) => x.kind === 'named').reverse()) if (!chosen.some((c) => c.source_id === s.id)) chosen.unshift({ url: s.url, title: s.title, reason: 'a page the person named', source_id: s.id });
        if (chosen.length < Math.min(limit, readable.length)) {
            const hosts = new Set(chosen.map((c) => hostOf(c.url)));
            for (const pass of [0, 1]) {
                for (const s of readable) {
                    if (chosen.length >= limit + 2) break;
                    if (chosen.some((c) => c.source_id === s.id) || (pass === 0 && hosts.has(hostOf(s.url)))) continue;
                    hosts.add(hostOf(s.url));
                    chosen.push({ url: s.url, title: s.title, reason: 'one of the search\'s best answers', source_id: s.id });
                }
            }
        }
        return chosen.slice(0, limit + 2);
    }

    async function run({ run: theRun, input, ctx = {} }) {
        const question = oneLine(input.question, 500);
        const depth = input.depth;
        const limit = limitOf(depth);
        const price = priceOf(depth);
        const owner = theRun && theRun.on_behalf_of ? (typeof theRun.on_behalf_of === 'string' ? JSON.parse(theRun.on_behalf_of) : theRun.on_behalf_of) : null;
        const runId = theRun.id;
        let row = await store.ensure({ runId, question, depth, siteLimit: limit, priceUsd: price, owner, kind: 'research' });
        if (!row) throw new AiError(500, 'deep_dive.not_stored', 'the deep dive row could not be written');
        const models = [];
        const gaps = [];
        const warnings = [];
        let usage = { input: 0, output: 0 };
        let cost = 0;
        const addCall = (stepKey, r) => {
            if (!r) return;
            models.push({ step: stepKey, provider: r.provider || null, model: r.model || null, tokens_in: r.tokens_in || 0, tokens_out: r.tokens_out || 0, cost_usd: Number(r.cost_usd) || 0, ms: r.ms || 0 });
            usage = { input: usage.input + (r.tokens_in || 0), output: usage.output + (r.tokens_out || 0) };
            cost += Number(r.cost_usd) || 0;
        };
        const check = () => { if (ctx.signal && ctx.signal.aborted) throw new AiError(409, 'run.cancelled', 'cancelled'); };
        const overBudget = () => price > 0 && cost >= price;

        try {
            row = await store.patch(row.id, { status: 'running', step: 'plan', progress: 0.01, steps: blankSteps() });

            // 1. Plan
            row = await step(row, 'plan', 'running', { detail: 'writing the questions an expert would ask', progress: 0.03 });
            check();
            const plan = await llm.call({ routeKey: 'default.json', ...prompts.researchPlanPrompt({ question, depth }), schema: PLAN_OUTPUT, schemaName: 'research_plan', maxTokens: Math.min(1200, maxOut), signal: ctx.signal, ctx });
            addCall('plan', plan);
            const questions = (plan.json.questions || []).slice(0, 9).map((q, i) => ({ key: oneLine(q.key || `q${i + 1}`, 40), question: oneLine(q.question, 400) })).filter((q) => q.question);
            if (!questions.length) questions.push({ key: 'answer', question });
            const searches = (plan.json.searches || []).slice(0, depth === 'quick' ? 4 : 8);
            row = await store.patch(row.id, { candidates: [], reads: [], plan: { questions, searches } });
            row = await step(row, 'plan', 'done', { detail: `${questions.length} questions, ${searches.length} searches`, progress: 0.1 });

            // 2. Search
            row = await step(row, 'search', 'running', { detail: `${searches.length + 1} searches and MegaSource`, progress: 0.12 });
            check();
            const gathered = await sources.gatherGeneral({ question, searches, namedSites: input.sites || [], signal: ctx.signal, maxSources: maxSources[depth] || 40 });
            const all = gathered.sources || [];
            for (const w of gathered.warnings || []) warnings.push(w);
            if (!all.length) throw new AiError(502, 'source.unavailable', 'no search answered for this question');
            row = await step(row, 'search', 'done', { detail: `${all.length} sources from ${new Set(all.map((s) => s.engine).filter(Boolean)).size || 1} engines`, progress: 0.2 });

            // 3. Choose
            row = await step(row, 'choose', 'running', { detail: 'picking the pages worth reading', progress: 0.22 });
            check();
            const readable = all.filter((s) => ['web', 'named', 'project'].includes(s.kind));
            let chosen = await choosePages({ question, questions, sources: readable, limit, ctx, warnings, addCall: (pick) => addCall('choose', pick) });
            chosen = chosen.map((c, i) => ({ ...c, id: `page_${i + 1}`, chosen: i < limit }));
            row = await store.patch(row.id, { candidates: chosen });
            row = await step(row, 'choose', 'done', { detail: `${Math.min(limit, chosen.length)} pages`, progress: 0.26 });

            // 4. Read: three at a time; a page that cannot be read gives its place to a spare.
            const target = Math.min(limit, chosen.length);
            row = await step(row, 'read', 'running', { detail: `0/${target} pages`, progress: 0.28 });
            const { reads, texts, readCount } = await readPages({ chosen, target, ctx, check,
                onRead: async (all, n) => {
                    row = await store.patch(row.id, { reads: all, progress: 0.28 + 0.24 * Math.min(1, n / Math.max(1, target)) });
                    row = await step(row, 'read', 'running', { detail: `${n}/${target} pages` });
                } });
            if (!readCount) throw new AiError(502, 'source.unavailable', 'none of the chosen pages could be read');
            for (const r of reads.filter((x) => x.status === 'skipped')) warnings.push(`${hostOf(r.url) || r.url}: ${r.reason}`);
            row = await step(row, 'read', 'done', { detail: `${readCount} pages read${reads.length > readCount ? `, ${reads.length - readCount} could not be` : ''}`, progress: 0.52 });

            // 5. Analyse: notes on each page read, three at a time, within the held price.
            const toAnalyse = reads.filter((r) => r.status === 'read');
            row = await step(row, 'analyse', 'running', { detail: `0/${toAnalyse.length} pages`, progress: 0.54 });
            const { budgetGap } = await notePages({ reads, texts, question, questions, ctx, check, overBudget, warnings, addCall: (r) => addCall('analyse', r),
                onNote: async (all, n) => {
                    row = await store.patch(row.id, { reads: all, progress: 0.54 + 0.3 * (n / Math.max(1, toAnalyse.length)) });
                    row = await step(row, 'analyse', 'running', { detail: `${n}/${toAnalyse.length} pages` });
                } });
            if (budgetGap) gaps.push('The held price was reached before every page was analysed; the answer rests on the pages that were.');
            const noted = reads.filter((r) => r.status === 'read' && r.summary && r.relevant !== false);
            row = await step(row, 'analyse', 'done', { detail: `${noted.length} pages with something to say`, progress: 0.85 });

            // 6. Write: the answer, every claim citing its pages (by number here, by source id in the report).
            row = await step(row, 'write', 'running', { detail: 'writing the answer from the notes', progress: 0.87 });
            check();
            const { answer, numbered } = await answerFrom({ question, questions, reads, ctx, warnings, gaps, addCall: (r) => addCall('write', r) });
            row = await step(row, 'write', 'done', { detail: `${answer.key_points.length} key points from ${numbered.length} pages`, progress: 0.98 });

            const nowIso = iso(clock.now());
            const fresh = await store.get(row.id);
            const report = {
                id: runId, schema: 'ai.research@1', run_id: runId, status: 'succeeded',
                input: { question, depth, max_pages: limit, ...(input.sites && input.sites.length ? { sites: input.sites } : {}) },
                steps: fresh.steps, questions, sources: all.slice(0, 200), reads: reads.slice(0, 40), answer,
                receipt: { price_usd: price, held_usd: price, cost_usd: Math.round(cost * 1e6) / 1e6, models: models.slice(0, 200), pages_read: readCount, synthetic: models.some((m) => !m.provider) },
                gaps: [...new Set([...gaps, ...warnings].map((g) => oneLine(g, 400)))].slice(0, 40),
                created_at: row.created_at, updated_at: nowIso, finished_at: nowIso,
            };
            const v = schemas.validate(RESEARCH_REPORT, report);
            if (!v.valid) throw new AiError(502, 'output.invalid', `the deep dive report does not match ai.research@1: ${v.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`, { errors: v.errors });
            row = await store.patch(row.id, { status: 'succeeded', step: 'write', progress: 1, report, gaps: report.gaps, finished_at: nowIso });
            return { output: report, usage, cost, models };
        } catch (err) {
            const cancelled = (err && err.code === 'run.cancelled') || (ctx.signal && ctx.signal.aborted);
            const code = cancelled ? 'run.cancelled' : ((err && err.code) || 'run.internal');
            const detail = String((err && (err.detail || err.message)) || 'the run failed').slice(0, 500);
            try {
                const cur = await store.get(row.id);
                const steps = (cur.steps || []).map((x) => (x.status === 'running' ? { ...x, status: cancelled ? 'skipped' : 'failed', finished_at: iso(clock.now()) } : x));
                await store.patch(row.id, { status: cancelled ? 'cancelled' : 'failed', steps, error_code: code, error_detail: detail, gaps: [...new Set(warnings)].slice(0, 40), finished_at: iso(clock.now()) });
            } catch (e) { log.warn(`[deep-dive] could not record the failure: ${e.message}`); }
            throw err;
        }
    }

    return { run, depths, priceOf, limitOf, choosePages, readPages, notePages, answerFrom };
}

module.exports = { createResearch };
