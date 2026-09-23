'use strict';
/**
 * Named prepare/postprocess hooks. Template TEXT is data (versioned in the templates table); the
 * little bits of logic Live's prompts needed — formatting a timeline, picking a translation
 * direction phrase, repairing a model's almost-JSON — are code, referenced from workflow steps by
 * name and versioned with the service.
 *
 *   prepare(input)            -> { vars, params?, output? }   output short-circuits the provider call
 *   postprocess(result, input) -> output object, or null when the answer is unusable (the run then
 *                                 fails with output.empty — an explicit state, never a placeholder)
 *
 * The Live hooks are ported from OpenVibe.Live: server/i18n/translate.js, server/ai/ai-analysis.js,
 * server/ai/media-analysis.js, server/recap/recap.js and server/internal/routes.js.
 */
const { parseJsonLoose } = require('../util');

// ── Live: shared bits ────────────────────────────────────
const LANG_NAMES = {
    en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ru: 'Russian', uk: 'Ukrainian', ar: 'Arabic',
    th: 'Thai', he: 'Hebrew', el: 'Greek', hi: 'Hindi', es: 'Spanish', pt: 'Portuguese', fr: 'French',
    de: 'German', it: 'Italian', tr: 'Turkish', vi: 'Vietnamese', id: 'Indonesian', pl: 'Polish', nl: 'Dutch',
};
const langName = (c) => LANG_NAMES[c] || c || 'English';

const CATEGORIES = ['outdoors', 'travel', 'building', 'music', 'gaming', 'robot', 'desktop', 'irl', 'other'];
function normalizeCategory(c) {
    const t = String(c || '').toLowerCase().trim();
    if (!t) return null;
    if (CATEGORIES.includes(t)) return t;
    const map = { 'just chatting': 'irl', chatting: 'irl', talk: 'irl', coding: 'desktop', programming: 'desktop', software: 'desktop', tech: 'desktop', art: 'building', craft: 'building', diy: 'building', cooking: 'irl', hiking: 'outdoors', driving: 'travel', 'road trip': 'travel', robotics: 'robot', game: 'gaming', games: 'gaming', dj: 'music' };
    return map[t] || null;
}

/** Live's _extractDescription: lift a description out of almost-JSON, never store a raw blob. */
function extractDescription(text, maxLen) {
    if (!text) return '';
    const j = parseJsonLoose(text);
    if (j && j.description) return String(j.description).slice(0, maxLen);
    const dm = text.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    if (dm) { try { return JSON.parse(`"${dm[1]}"`).slice(0, maxLen); } catch { return dm[1].slice(0, maxLen); } }
    const t = text.trim();
    return /^[{[]/.test(t) ? '' : t.slice(0, maxLen);
}
function extractTags(text, maxTags) {
    const j = parseJsonLoose(text);
    if (j && Array.isArray(j.tags)) return j.tags.slice(0, maxTags).map(String);
    const tm = text && text.match(/"tags"\s*:\s*\[([^\]]*)/i);
    if (tm) return tm[1].split(',').map(s => s.replace(/["'\s]/g, '')).filter(Boolean).slice(0, maxTags);
    return [];
}
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const clean = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** Live's translatable(): is there anything worth translating (letters, not emotes/links)? */
function translatable(text) {
    const s = String(text || '').trim();
    if (s.length < 2 || s.length > 4000) return false;
    const stripped = s.replace(/https?:\/\/\S+/gi, '').replace(/:[a-z0-9_]+:/gi, '').replace(/[!/]\w+/g, '').replace(/@\w+/g, '');
    return /\p{L}{2,}/u.test(stripped);
}

// ── Product workflows: numbered sources ──────────────────
function sourcesBlock(sources) {
    return (sources || []).map((s, i) => {
        const head = [`[${i}]`, s.title || s.source_type, s.author ? `by ${s.author}` : '', s.published_at ? `(published ${s.published_at})` : '', s.url || ''].filter(Boolean).join(' ');
        const body = String(s.content || s.snippet || '').slice(0, 6000);
        return body ? `${head}\n${body}` : head;
    }).join('\n\n');
}

const PREPARE = {
    'live.translate'(input) {
        const text = String(input.text || '').trim();
        const from = input.from || 'auto';
        const to = input.to || 'en';
        if (!translatable(text)) return { output: { text: null, from, to, unchanged: false, reason: 'not_translatable' } };
        if (from === to) return { output: { text: null, from, to, unchanged: true, reason: 'same_language' } };
        const context = input.context || 'chat';
        const kind = context === 'bio' ? 'a streamer\'s profile bio'
            : context === 'speech' ? 'lines of live-stream speech (a casual gamer talking to his chat)'
                : 'a live-stream chat message';
        return {
            vars: { text, kind, src: from === 'auto' ? 'the source language' : langName(from), dst: langName(to), speech: context === 'speech' },
            params: { max_tokens: Math.max(40, Math.min(input.max_tokens || 600, Math.round(text.length * 2.2) + 60)) },
        };
    },
    'live.paste.describe_image'(input) {
        return { vars: { title: String(input.title || '').slice(0, 120) } };
    },
    'live.paste.summarize_text'(input) {
        return { vars: { title: String(input.title || '').slice(0, 120), snippet: String(input.content || '').slice(0, 6000) } };
    },
    'live.stream.summarize'(input) {
        const lines = (input.observations || []).slice(-80).map(d => `- ${d}`).join('\n');
        if (!lines) return { output: null };
        let audio = '';
        const speech = (input.speech || []).slice(-200)
            .map(r => `[${mmss(Number(r.start_sec) || 0)}] ${String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, 200)}`)
            .filter(l => l.length > 8).join('\n');
        if (speech) audio += `\n\nWHAT THE STREAMER SAID (timestamped):\n${speech}`;
        const sounds = (input.sounds || []).slice(-60).map(r => `[${mmss(Number(r.start_sec) || 0)}] ${r.label} (${Number(r.confidence || 0).toFixed(2)})`).join('\n');
        if (sounds) audio += `\n\nNOTABLE SOUNDS HEARD:\n${sounds}`;
        return { vars: { lines, audio_block: audio, categories: CATEGORIES.join(', ') } };
    },
    'live.streamer.overview'(input) {
        const st = input.streamer || {};
        const mem = (input.memories || []).slice(0, 40).map(d => `- ${d}`).filter(l => l.length > 2);
        const vods = (input.vods || []).map(v => `- ${v.title || 'Untitled VOD'}${v.category ? ` [${v.category}]` : ''}`);
        const pastes = (input.pastes || []).filter(p => p.summary).map(p => `- "${p.title || 'paste'}": ${p.summary}`);
        if (!mem.length && !vods.length && !pastes.length) return { output: null };
        const ctx = [
            `Streamer: ${st.display_name || st.username} (@${st.username})`,
            st.bio ? `Bio: ${String(st.bio).slice(0, 400)}` : '',
            st.category ? `Usual category (${st.category_inferred ? 'inferred by AI from their streams' : 'self-selected'}): ${st.category}` : '',
            mem.length ? `\nLive-stream observations (across sessions):\n${mem.join('\n')}` : '',
            vods.length ? `\nRecent VODs:\n${vods.join('\n')}` : '',
            pastes.length ? `\nPaste summaries:\n${pastes.join('\n')}` : '',
        ].filter(Boolean).join('\n');
        return { vars: { ctx } };
    },
    'live.media.overview'(input) {
        const frames = input.frames || [];
        const transcript = String(input.transcript || '');
        if (!frames.length && !transcript) return { output: null };
        const parts = [];
        if (frames.length) parts.push(`Visual observations across the video (in order):\n${frames.map(f => `- ${f}`).join('\n')}`);
        if (transcript) parts.push(`Audio transcript (sampled from the recording):\n"${transcript.slice(0, 4000)}"`);
        return { vars: { parts: parts.join('\n\n') } };
    },
    'network.site_copy'(input) {
        const sites = (input.sites || []).slice(0, 24).map(x => ({ id: clean(x.id, 40), name: clean(x.name, 60), what: clean(x.what, 400), popular: (Array.isArray(x.popular) ? x.popular : []).slice(0, 8).map(v => clean(v, 60)) }));
        const links = (input.links || []).slice(0, 80).map(l => ({ id: clean(l.id, 60), name: clean(l.name, 60), about: clean(l.about, 120) }));
        return { vars: { payload: { sites, links } } };
    },
    sources(input) {
        return { vars: { ...input, sources_block: sourcesBlock(input.sources), source_count: (input.sources || []).length } };
    },
    // ── Direct operations ──
    'ai.summarize'(input) {
        return { vars: { ...input, max_words: input.max_words || 120 } };
    },
    'ai.classify'(input) {
        return {
            vars: input,
            jsonSchema: {
                type: 'object', additionalProperties: false, required: ['label', 'confidence', 'rationale'],
                properties: { label: { type: 'string', enum: input.labels }, confidence: { type: 'number', minimum: 0, maximum: 1 }, rationale: { type: 'string', maxLength: 1000 } },
            },
        };
    },
    'ai.extract'(input) {
        return { vars: input, jsonSchema: input.schema };
    },
    'ai.enrich'(input) {
        return {
            vars: input,
            jsonSchema: {
                type: 'object', additionalProperties: false, required: ['data', 'notes'],
                properties: { data: input.schema || { type: 'object' }, notes: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 20 } },
            },
        };
    },
};

const POSTPROCESS = {
    'ai.classify'(r, input) {
        const j = r.json || parseJsonLoose(r.text);
        if (!j || !input.labels.includes(j.label)) return null;   // a label outside the given set is not an answer
        return { label: j.label, confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)), rationale: String(j.rationale || '').slice(0, 1000) };
    },
    'live.translate'(r, input) {
        const out = typeof r.text === 'string' ? r.text.trim().replace(/^["“]|["”]$/g, '') : '';
        if (!out) return null;
        const src = String(input.text || '').trim();
        if (out === src) return { text: null, from: input.from || 'auto', to: input.to || 'en', unchanged: true, reason: 'already_target_language' };
        return { text: out, from: input.from || 'auto', to: input.to || 'en', unchanged: false };
    },
    'live.paste.describe_image'(r) {
        const description = extractDescription(r.text, 600);
        return description ? { description, tags: extractTags(r.text, 8) } : null;
    },
    'live.paste.summarize_text'(r) {
        return r.text ? { description: r.text.slice(0, 300), tags: [] } : null;
    },
    'live.stream.describe_frame'(r) {
        const description = extractDescription(r.text, 400);
        if (!description) return null;
        const j = parseJsonLoose(r.text) || {};
        return { description, tags: extractTags(r.text, 6), worthy: j.worthy === true, title: j.worthy === true ? String(j.title || '').replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 80) : '' };
    },
    'live.stream.summarize'(r) {
        if (!r.text) return null;
        const j = parseJsonLoose(r.text);
        const overview = j && j.overview ? String(j.overview).slice(0, 2000) : (extractDescription(r.text, 2000) || r.text.slice(0, 2000));
        return { overview, category: normalizeCategory(j && j.category), tags: j && Array.isArray(j.tags) ? j.tags.map(String).slice(0, 6) : [] };
    },
    'live.streamer.overview'(r) { return r.text ? { overview: r.text.slice(0, 4000) } : null; },
    'live.media.overview'(r) { return r.text ? { overview: r.text.slice(0, 2000) } : null; },
    'live.stream.recap'(r) {
        const out = r.json || parseJsonLoose(r.text);
        if (!out || !out.headline || !out.summary) return null;
        return {
            headline: String(out.headline).trim().slice(0, 90), summary: String(out.summary).trim().slice(0, 500), moment: String(out.moment || '').trim().slice(0, 200),
            tags: (Array.isArray(out.tags) ? out.tags : []).map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 4),
            grade: ['S', 'A', 'B', 'C'].includes(out.grade) ? out.grade : 'B',
        };
    },
    'network.site_copy'(r, input) {
        const out = r.json || parseJsonLoose(r.text);
        if (!out || !Array.isArray(out.sites)) return null;
        // The model PICKS link ids from the allow-list; anything else is dropped, so nothing it
        // says can become a link or a tag on another site.
        const linkIds = new Set((input.links || []).map(l => clean(l.id, 60)));
        const siteIds = new Set((input.sites || []).map(s => clean(s.id, 40)));
        return {
            sites: out.sites.filter(s => s && siteIds.has(String(s.id))).map(s => ({
                id: String(s.id), blurb: clean(s.blurb, 300), picks: (Array.isArray(s.picks) ? s.picks : []).map(String).filter(p => linkIds.has(p) && p !== String(s.id)).slice(0, 4),
            })),
        };
    },
};

module.exports = { PREPARE, POSTPROCESS, CATEGORIES, normalizeCategory, translatable, sourcesBlock, LANG_NAMES };
