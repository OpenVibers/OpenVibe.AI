'use strict';
/**
 * The deep dive's prompts. The page is the main session's; these are the words a model is given.
 *
 * The plan writes the questions an expert would ask and the searches that answer them; choose ranks candidate
 * sites with a reason each; analyse reads one page (its DOM measurements, or one full-page screenshot) as a
 * designer; synthesise compares the sites, finds the patterns and the gap, and checks every recommendation
 * against OpenVibe's own rules register. Every answer is JSON in the shape server/deep-dive/schema.js names.
 */

const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

function planPrompt({ question, depth, named }) {
    return {
        system: 'You are a senior product designer planning expert design research. You ask what an expert would ask before looking at a single site, and you say what to search for. Answer only with JSON.',
        user: `The question: "${clean(question, 500)}"
Depth: ${depth}.${named.length ? ` Sites the person already named: ${named.join(', ')}` : ''}

Write the questions an expert designer would ask about this (patterns, hierarchy, density, type, colour, motion, words, trust, accessibility, speed, phone versus computer), and the searches that would answer them. Rules:
- questions: 5 to 9, each { "key": one short slug, "question": one sentence }.
- searches: 2 to 6, each { "q": a search query, "kind": "web" | "images" | "icons" | "projects" }. Make the queries specific to this question and to design (add "design", "case study", "ui", "ux" where they help).
- Do not answer the question yourself. JSON only:
{"questions":[{"key":"hierarchy","question":"..."}],"searches":[{"q":"...","kind":"web"}]}`,
    };
}

function choosePrompt({ question, depth, limit, sources }) {
    const list = sources.map((s, i) => `${i + 1}. [${s.kind}] ${clean(s.title, 140)} — ${s.url}${s.snippet ? ` — ${clean(s.snippet, 220)}` : ''}`).join('\n');
    return {
        system: 'You are a senior product designer choosing which sites a deep dive should capture. You only choose real pages that can be photographed without signing in, and you say why each one is worth the look. Answer only with JSON.',
        user: `The question: "${clean(question, 500)}"
Depth: ${depth}. Choose at most ${limit} sites to capture (390 px, 1280 px, dark and light where supported), from this list only:
${list}

Rules:
- Prefer production pages and real products over listicles, directories, aggregators, social posts, docs and search results.
- Cover different approaches (phone-first, dense dashboard, editorial, playful, minimal), not six versions of one look.
- Every chosen URL must appear in the list above, exactly as given.
- Each reason is one concrete sentence about what this site would teach about the question.
- JSON only: {"sites":[{"url":"https://...","reason":"..."}]}.`,
    };
}

function domAnalysisPrompt({ question, source, capture, dom }) {
    return {
        system: 'You are a senior product designer reading a page\'s measured design system. You describe what is there from the numbers, never what you imagine. Answer only with JSON.',
        user: `Question: "${clean(question, 500)}"
Site: ${clean(source.title, 200)} — ${source.url}
Measured at ${capture.viewport} px, ${capture.theme} theme${capture.extras ? ', with the Expert extras' : ''}.

DOM facts (computed from the live page):
${JSON.stringify(dom, null, 1).slice(0, 14000)}
${capture.extras ? `\nExpert extras (axe-core, LCP/CLS/INP, menus, hover/focus, frames):\n${JSON.stringify(capture.extras, null, 1).slice(0, 6000)}` : ''}

Write { "summary", "first_impression", "hierarchy", "density", "type", "colour", "motion", "words", "accessibility", "speed", "strengths": [up to 4], "weaknesses": [up to 4], "evidence": [{"claim":"...","shot":1}] }.
- Be concrete: name the sizes, counts, colours and words that are actually in the facts.
- Accessibility and speed only when the extras measured them; otherwise say "not measured at this depth" in that field.
- Each evidence claim is one of your own claims, with "shot": 1 (this page). JSON only.`,
    };
}

function visionPrompt({ question, source, viewport, theme, index, total }) {
    return {
        system: 'You are a senior product designer looking at a real page. You say what draws the eye first, how the hierarchy and density work, what is good and what fails. Never invent a control or a colour you cannot see. Answer only with JSON.',
        user: `Question: "${clean(question, 500)}"
This is a full-page screenshot of ${source.url} (${clean(source.title, 160)}) at ${viewport} px, ${theme} theme. It is screenshot ${index} of ${total} for this site.

Write { "summary" (2-3 sentences: what this page is and how it works), "first_impression" (what the eye lands on first), "hierarchy", "density", "type", "colour", "motion" (only what a still can show), "words", "strengths": [up to 3], "weaknesses": [up to 3], "evidence": [{"claim":"...","shot":${index}}] }.
Every claim must follow from what is visible in this image. JSON only.`,
    };
}

function synthesisPrompt({ question, depth, analyses, sources, rules, components, tokens, research = null }) {
    const siteList = analyses.map((a, i) => `${i + 1}. ${a.url} — ${clean(a.summary, 260)}`).join('\n');
    const ruleList = (rules || []).map((r) => `- ${r.id}: ${clean(r.rule, 300)} (${clean(r.area, 80)})`).join('\n') || '- (the rules register did not answer)';
    const compList = (components || []).map((c) => `- ${c.title || c.name}: ${clean(c.summary, 220)}`).join('\n') || '- (the component registry did not answer)';
    return {
        system: 'You are the design lead writing the synthesis of expert design research for OpenVibe. You compare real sites, name the patterns and how many sites use each, find what everyone gets wrong and the gap nobody fills, and you check every recommendation against OpenVibe\'s own rules register. Every claim cites a site. Answer only with JSON.',
        user: `Question: "${clean(question, 500)}" (depth: ${depth}).

The sites, numbered for your citations:
${siteList}
${research && research.answer && research.answer.summary ? `
What the best write-ups on this say (read in full before the sites were chosen; use it to judge the sites, never as a site):
${clean(research.answer.summary, 1200)}
${(research.answer.key_points || []).slice(0, 8).map((k) => `- ${clean(k.text, 300)}`).join('\n')}
` : ''}
Their analyses (JSON; each has source_id, url, summary, strengths, weaknesses):
${JSON.stringify(analyses.map((a) => ({ source_id: a.source_id, url: a.url, summary: clean(a.summary, 800), first_impression: clean(a.first_impression, 500), hierarchy: clean(a.hierarchy, 500), density: clean(a.density, 400), type: clean(a.type, 400), colour: clean(a.colour, 400), motion: clean(a.motion, 300), words: clean(a.words, 300), strengths: a.strengths, weaknesses: a.weaknesses, accessibility: a.accessibility, speed: a.speed })), null, 1).slice(0, 30000)}

Reference tokens measured from the DOM (palettes, type scales, spacing):
${JSON.stringify(tokens, null, 1).slice(0, 6000)}

OpenVibe's rules register (use these ids; a recommendation follows one, would change one, or has none):
${ruleList}

OpenVibe's component registry:
${compList}

Write JSON with:
{"patterns":[{"name","what","sites":[site numbers],"usage_count","evidence":[{"claim","site":number}]}],
 "comparison":{"columns":["Site","..."],"rows":[["...", "..."]]},
 "best":{"site":number,"what","evidence":[{"claim","site":number}]},
 "mistakes":[{"what","evidence":[{"claim","site":number}]}],
 "gap":"...",
 "reference_tokens":{"palettes":[{"site":number,"colours":["#..."]}],"type_scales":[{"site":number,"families":[],"sizes":[]}],"spacing":[{"site":number,"steps":[]}]},
 "do":["..."],"dont":["..."],"accessibility":["..."],"speed":["..."],
 "recommendations":[{"what","why","rule":{"id":one of the rule ids or null,"status":"follows"|"would_change"|"none","text":the rule in one line},"evidence":[{"claim","site":number}]}]}

Rules: 5 to 10 patterns; 4 to 8 do and don't; 5 to 8 recommendations, each with a site number in its evidence. Use only the rules above; never invent a rule id. JSON only.`,
    };
}

// ── The general deep dive (research.deep_dive): any question, researched and answered with its sources ──

function researchPlanPrompt({ question, depth }) {
    return {
        system: 'You are an expert researcher planning a deep dive into a question for a curious, busy person. You ask what an expert would need to know to answer it well, and you plan searches that find primary sources, data, expert views, recent news and the strongest disagreement. Answer only with JSON.',
        user: `The question: "${clean(question, 500)}"
Depth: ${depth}.

Rules:
- questions: 4 to 9 sub-questions that together answer it well (definitions, how it works, the numbers, who says what, what changed lately, risks or criticism, what to do), each { "key": a short slug, "question": one sentence }.
- searches: 3 to 8, each { "q": a search query, "kind": "web" or "projects" (code on GitHub, only when the question is about software) }. Vary them: the plain question, the data or statistics, the primary source (an official site, a paper, a standard), recent news (this year), expert analysis, criticism or problems, and comparisons where the question compares.
- Do not answer the question yourself. JSON only:
{"questions":[{"key":"basics","question":"..."}],"searches":[{"q":"...","kind":"web"}]}`,
    };
}

function choosePagesPrompt({ question, questions, limit, sources }) {
    const list = sources.map((s, i) => `${i + 1}. ${clean(s.title, 140)} — ${s.url}${s.snippet ? ` — ${clean(s.snippet, 240)}` : ''}`).join('\n');
    const qs = questions.map((q, i) => `${i + 1}. ${clean(q.question, 200)}`).join('\n');
    return {
        system: 'You are an expert researcher choosing which pages a deep dive should read in full. You pick the pages that answer the questions best and that a careful expert would trust, and you say why. Answer only with JSON.',
        user: `The question: "${clean(question, 500)}"
What it needs answered:
${qs}

Choose at most ${limit} pages to read in full, from this list only:
${list}

Rules:
- Prefer primary and authoritative sources (official sites, standards, papers, documentation, reputable reporting and expert analysis) and recent ones; cover different questions and different viewpoints, including the strongest criticism.
- Avoid thin pages: search results, link lists, social posts, content farms, pages that need a sign-in, and several pages saying the same thing.
- Every chosen URL must appear in the list above, exactly as given. Each reason is one sentence about what the page will answer.
- JSON only: {"pages":[{"url":"https://...","reason":"..."}]}.`,
    };
}

function readPagePrompt({ question, questions, page }) {
    const qs = questions.map((q, i) => `${i + 1}. ${clean(q.question, 200)}`).join('\n');
    return {
        system: 'You read one web page for a deep dive and note only what it actually says that bears on the questions, the way a careful researcher takes notes: each point in your own words, with a short exact quote from the page when there is one. You never add what the page does not say. Answer only with JSON.',
        user: `The question: "${clean(question, 500)}"
The questions to answer:
${qs}

The page: ${clean(page.title || '', 200)} (${page.url})${page.site ? `, ${clean(page.site, 80)}` : ''}${page.published ? `, published ${page.published}` : ''}
---
${String(page.text || '').slice(0, 12000)}
---

Rules:
- relevant: false when the page says nothing useful about the questions (then findings may be empty).
- summary: two or three sentences: what this page is and what it contributes.
- kind: primary (official, the original data or the maker's own page), reference (encyclopedia, documentation, a standard), news, opinion (analysis, a blog, a review), vendor (selling the thing), forum, or other.
- findings: at most 8 points, each { "point": one sentence, "quote": at most 25 words copied exactly from the page, or null }. Numbers, dates and names exactly as written.
JSON only: {"relevant":true,"summary":"...","kind":"reference","findings":[{"point":"...","quote":"..."}]}`,
    };
}

function writePrompt({ question, questions, notes }) {
    const qs = questions.map((q, i) => `${i + 1}. ${clean(q.question, 200)}`).join('\n');
    const read = notes.map((n) => `[${n.n}] ${clean(n.title || n.url, 160)} — ${n.url}${n.site ? ` (${clean(n.site, 60)})` : ''}${n.published ? `, ${n.published}` : ''}${n.kind ? `, ${n.kind}` : ''}
${clean(n.summary, 600)}
${(n.findings || []).map((f) => `- ${clean(f.point, 300)}${f.quote ? ` "${clean(f.quote, 200)}"` : ''}`).join('\n')}`).join('\n\n');
    return {
        system: 'You write the answer to a deep dive from the notes on the pages that were read, for a smart reader who wants the real picture fast. Every claim cites the pages it comes from by their numbers. You say plainly where the sources disagree and what is still unknown, and you never state anything the notes do not support. Answer only with JSON.',
        user: `The question: "${clean(question, 500)}"
The questions it was broken into:
${qs}

The notes, one block per page read, numbered:
${read}

Write:
- summary: the answer in 3 to 6 sentences, the most important first.
- key_points: 4 to 10 points, each { "text": one or two sentences, "sources": [page numbers] }.
- answers: one per question above, { "question": its number, "answer": a short paragraph, "confidence": "high" | "medium" | "low", "sources": [page numbers] }.
- comparison: when the question compares options, a small table { "columns": [...], "rows": [[...]] }; otherwise null.
- disagreements: where the pages disagree, { "what": "...", "sources": [page numbers] }.
- open_questions: what the pages leave unanswered. next_steps: what the reader could do or check next.
Cite only page numbers from the notes. JSON only.`,
    };
}

module.exports = { planPrompt, choosePrompt, domAnalysisPrompt, visionPrompt, synthesisPrompt, researchPlanPrompt, choosePagesPrompt, readPagePrompt, writePrompt };
