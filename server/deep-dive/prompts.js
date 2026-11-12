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

function synthesisPrompt({ question, depth, analyses, sources, rules, components, tokens }) {
    const siteList = analyses.map((a, i) => `${i + 1}. ${a.url} — ${clean(a.summary, 260)}`).join('\n');
    const ruleList = (rules || []).map((r) => `- ${r.id}: ${clean(r.rule, 300)} (${clean(r.area, 80)})`).join('\n') || '- (the rules register did not answer)';
    const compList = (components || []).map((c) => `- ${c.title || c.name}: ${clean(c.summary, 220)}`).join('\n') || '- (the component registry did not answer)';
    return {
        system: 'You are the design lead writing the synthesis of expert design research for OpenVibe. You compare real sites, name the patterns and how many sites use each, find what everyone gets wrong and the gap nobody fills, and you check every recommendation against OpenVibe\'s own rules register. Every claim cites a site. Answer only with JSON.',
        user: `Question: "${clean(question, 500)}" (depth: ${depth}).

The sites, numbered for your citations:
${siteList}

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

module.exports = { planPrompt, choosePrompt, domAnalysisPrompt, visionPrompt, synthesisPrompt };
