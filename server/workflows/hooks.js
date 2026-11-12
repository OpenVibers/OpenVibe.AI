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

// Moments (ai-moments-job.js): how each flavor of moment is picked.
const MOMENT_FLAVOR = {
    paste: 'This moment becomes a SCREENSHOT paste: pick something visually striking in a single frame — a face or reaction, a visual gag, something odd on screen, a scene change. What was said matters less than what is SEEN.',
    clip: 'This moment becomes a 25-SECOND VIDEO CLIP: pick a beat that plays out over time — a line that lands, a reaction, a sound, chat exploding, something HAPPENING — not a static pretty frame.',
};
// Live's moment registry keeps two moments of one VOD this far apart (server/ai/moment-registry.js GAP_SEC).
const MOMENT_GAP_SEC = 120;
const ABSTAIN_CLIP = 'If NOTHING here is clearly worth a clip (only routine talk with no reaction, a static screen, nothing happening, or only moments already used), say so instead of forcing a pick: a missed clip costs less than a bad one. Then answer {"at": null, "title": "", "desc": "", "why": "<a few words>"}. Otherwise: ';
const oneLine = (t, max) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, max);
/** "12:34", "[1:02:03]" or "75:12" → seconds; anything else (a bare number, words) → NaN. */
function clockSeconds(v) {
    const m = /^\s*\[?\s*(?:(\d{1,2}):)?(\d{1,4}):(\d{2})(?:\.\d+)?\s*\]?\s*$/.exec(String(v == null ? '' : v));
    if (!m || Number(m[3]) > 59 || (m[1] !== undefined && Number(m[2]) > 59)) return NaN;
    return (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
}
// Text shown to the public as a description: one paragraph of prose. A model that answers with a list, headings or
// bold labels ("- Streamer handle: x (@x).") has its markup and labels dropped, line by line, and headings left out,
// before the lines are joined.
const PROSE_LABEL = /^(?:streamer(?: handle)?|handle|(?:profile )?overview|summary|profile|content(?: niche)?|niche|tone(?:\/vibe)?|vibe|(?:recurring )?themes|activities|moderation(?: notes)?|notes?|bio|category)\s*:\s*/i;
function plainProse(text, max) {
    const lines = String(text || '').split(/\r?\n/)
        .filter((l) => !/^\s*#{1,6}\s/.test(l))
        .map((l) => l.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+|>\s*)/, '').replace(/\*\*|__/g, '').trim().replace(PROSE_LABEL, '').trim())
        .filter(Boolean)
        .map((l) => (/[.!?…"')\]]$/.test(l) ? l : `${l}.`));
    return lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Chat messages as Live formatted them: "[Xm ago] [#channel] author: (kind) text", the freshest 9000 characters. */
function chatLines(messages, withWhere) {
    const out = (messages || []).map((m) => {
        const when = Number.isInteger(m.mins_ago) ? `[${m.mins_ago}m ago] ` : '';
        const where = withWhere && m.where ? `[${m.where}] ` : '';
        const kind = m.kind && m.kind !== 'chat' ? `(${m.kind}) ` : '';
        return `${when}${where}${m.author}: ${kind}${String(m.text || '').trim().slice(0, 220)}`;
    }).join('\n');
    return out.length > 9000 ? out.slice(out.length - 9000) : out;
}

const PREPARE = {
    // AI viewers (viewers/*.js). Live builds the stream context; the rules and the asks live here.
    'live.viewers.plan'(input) {
        const n = input.max_lines || 3;
        return { vars: { stable: input.stable, volatile: input.volatile, max_lines: n }, params: { max_tokens: 70 * n + 120 } };
    },
    'live.viewers.reply'(input) {
        return { vars: { stable: input.stable, situation: input.situation || '', bot: input.bot, streamer_line: input.streamer_line, max_words: input.max_words || 18 } };
    },
    'live.viewers.fold'(input) {
        const clip = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
        const personas = input.personas.map((p) => `### ${p.username}\nCurrent memory: ${p.memory ? clip(p.memory, 700) : '(none)'}\nRecent lines:\n- ${(p.lines || []).map((l) => clip(l, 160)).join('\n- ')}`).join('\n\n');
        return { vars: { channel_memory: clip(input.channel_memory, 600), personas }, params: { max_tokens: 160 * input.personas.length + 160 } };
    },
    'live.viewers.clone'(input) {
        return { vars: { name: input.name, overview: input.overview || '', memory: input.memory || '', samples: (input.samples || []).length ? `- ${input.samples.join('\n- ')}` : '' } };
    },
    // The Rundown's Today card (Live rundown/today.js): the day's takes as numbered lines, no JSON wrapping, so a
    // small model cannot answer as though it were given an empty day.
    'live.rundown.today'(input) {
        const takes = (Array.isArray(input.takes) ? input.takes : []).map((t, i) => {
            const bits = [`${i + 1}. [take:${Number(t.take_id)}] ${clean(t.streamer, 80) || 'someone'}`];
            if (t.when) bits.push(`at ${clean(t.when, 40)}`);
            if (t.topic) bits.push(`on ${clean(t.topic, 120)}`);
            bits.push(`— what: ${clean(t.what, 500)}`);
            if (t.take) bits.push(`— their take: ${clean(t.take, 300)}`);
            if (t.quote) bits.push(`— their words: "${clean(t.quote, 400)}"`);
            return bits.join(' ');
        }).join('\n');
        return { vars: { date: clean(input.date, 20), count: takes ? takes.split('\n').length : 0, takes: takes || '(none given)' } };
    },
    // The Rundown (Live rundown/desk.js): transcript lines as "[seconds] text", the known topics one per line.
    'live.rundown.segment'(input) {
        const clean = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
        return { vars: {
            streamer: clean(input.streamer, 80), title: clean(input.title, 200) || '(none)', category: clean(input.category, 80) || '(none)',
            topics: (input.topics || []).slice(0, 60).map((t) => `- ${clean(t, 120)}`).join('\n') || '(none yet)',
            earlier: clean(input.earlier, 800) || '(this is the start)',
            lines: (input.lines || []).map((x) => `[${Math.round(Number(x.t) || 0)}] ${clean(x.text, 1000)}`).join('\n'),
        } };
    },
    'live.rundown.episode'(input) {
        return { vars: { payload: input } };
    },
    'live.rundown.topic'(input) {
        return { vars: { payload: input } };
    },
    'live.clips.confirm'(input) {
        const clean = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
        return { vars: {
            scene: (input.scene || []).map((d) => `- ${clean(d, 160)}`).join('\n') || '(none)',
            script: (input.transcript || []).map((x) => `- [${mmss(Number(x.t) || 0)}] ${clean(x.text, 140)}`).join('\n') || '(none)',
            sounds: (input.sounds || []).map((x) => `- [${mmss(Number(x.t) || 0)}] ${x.label} (${Number(x.confidence || 0).toFixed(2)})`).join('\n') || '(none)',
            chat: (input.chat || []).slice(-30).map((c) => `- ${clean(c, 100)}`).join('\n') || '(none)',
        } };
    },
    // Chat analysis (chat-ai.js): messages formatted as Live formatted them, freshest 9000 characters kept.
    'live.chat.global'(input) {
        return { vars: {
            window_label: input.window_label || 'past hour', prior_memory: String(input.prior_memory || '').slice(0, 1600),
            recent_labels: (input.recent_labels || []).slice(-8).map((l) => `- ${l}`).join('\n') || '(none yet)',
            count: (input.messages || []).length, messages: chatLines(input.messages, true),
        } };
    },
    'live.chat.profile'(input) {
        const name = String(input.name || '').slice(0, 120);
        const subject = input.subject_kind === 'relay' ? `an external chatter ("${name}", bridged in from ${input.platform || 'another platform'})`
            : input.subject_kind === 'anon' ? `an ANONYMOUS chatter ("${name}", not logged in)` : `an individual chatter ("${name}")`;
        const noun = input.subject_kind === 'anon' ? 'this anon' : 'this user';
        const header = input.recent_24h ? `MESSAGES FROM ${noun.toUpperCase()} IN THE LAST 24H` : `${noun.toUpperCase()}'S MOST RECENT MESSAGES`;
        return { vars: {
            subject, noun, recent: input.recent_24h === true, seen: input.subject_kind === 'user' && input.seen ? input.seen : 0,
            prior_memory: String(input.prior_memory || '').slice(0, 1200), messages_header: header, messages: chatLines(input.messages, false),
        } };
    },
    'live.person.overview'(input) {
        return { vars: { as_streamer: String(input.as_streamer), as_chatter: String(input.as_chatter) } };
    },
    'live.stream.titles'(input) {
        return { vars: { list: input.summaries.map((t, i) => `${i}. ${String(t).replace(/\s+/g, ' ').slice(0, 200)}`).join('\n') } };
    },
    'live.moments.rank'(input) {
        const vods = input.vods || [];
        const list = vods.map((v, i) => `${i}. [${v.views || 0} views · ${v.clips || 0} clips · peak ${v.peak_viewers || 0}] "${String(v.title || '').replace(/\s+/g, ' ').trim().slice(0, 70)}" — ${String(v.overview || '').replace(/\s+/g, ' ').trim().slice(0, 260) || '(no summary)'}`).join('\n');
        return { vars: { list, top: Math.min(vods.length, Math.max(input.want || 6, 6)) } };
    },
    'live.hero.slogans'(input) {
        const block = (list, head, total) => (list || []).map((x) => `- ${String(x.name || '').slice(0, head)}: ${String(x.text || '').replace(/\s+/g, ' ').slice(0, 180)}`).join('\n').slice(0, total);
        return { vars: {
            global: String(input.global || '').slice(0, 1800) || '(quiet)',
            users: block((input.users || []).slice(0, 8), 64, 1600) || '(none yet)',
            streamers: block((input.streamers || []).slice(0, 8), 64, 1400) || '(none yet)',
            vods: (input.vods || []).slice(0, 10).map((v) => `- ${String(v.name || '').slice(0, 60)}: ${String(v.text || '').replace(/\s+/g, ' ').slice(0, 140)}`).join('\n').slice(0, 1400) || '(none yet)',
            usernames: (input.usernames || []).join(', ') || '(none yet)',
            target: input.count || 20,
        } };
    },
    'live.easter_egg'(input) {
        return { vars: { vibe: String(input.vibe || '').slice(0, 400) } };
    },
    'live.home.star'(input) {
        return { vars: { payload: { recent_stars: input.recent_stars || [], previous_star: input.previous_star || null, candidates: input.candidates } } };
    },
    'live.moments.pick'(input) {
        const lines = (list, max) => (list || []).map((x) => `[${mmss(Number(x.t) || 0)}] ${oneLine(x.text || x.label, max)}`).join('\n');
        const times = (list, n) => ((list || []).length ? list.slice(0, n).map((t) => mmss(Number(t) || 0)).join(', ') : 'none');
        const avoid = (input.avoid || []).map(Number).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
        if (!(input.timeline || []).length && !(input.transcript || []).length) return { output: null };
        // What is within two minutes of a used moment is not shown at all. Told only to stay away, the model picked
        // 0:01 beside a used 0:06, and 4 of the 11-03 10:44 run's 12 picks were thrown away for it.
        const free = (t) => avoid.every((a) => Math.abs((Number(t) || 0) - a) >= MOMENT_GAP_SEC);
        const open = (list) => (list || []).filter((x) => free(x && x.t));
        const timeline = open(input.timeline);
        const transcript = open(input.transcript);
        if (!timeline.length && !transcript.length) {
            return { output: { t: null, title: '', desc: '', abstain: true, why: 'every moment shown is within two minutes of one already used' } };
        }
        return {
            vars: {
                title: oneLine(input.title, 80),
                timeline: lines(timeline, 180) || '(none)',
                transcript: lines(transcript, 160) || '(none)',
                sounds: lines(open(input.sounds), 80) || '(none)',
                clipped: times((input.clipped || []).filter(free), 12),
                spikes: times((input.spikes || []).filter(free), 6),
                flavor_hint: MOMENT_FLAVOR[input.flavor] || MOMENT_FLAVOR.paste,
                // Only a clip may come back empty (C09): a paste needs one good frame, and offering it the same way out
                // made the model decline all twelve VODs of the 11-03 run, leaving the home with no new pastes.
                abstain_hint: input.flavor === 'clip' ? ABSTAIN_CLIP : '',
                avoid: avoid.map(mmss).join(', '),
            },
        };
    },
    // C09: the lines within a minute of the moment, as [m:ss]; nothing to check against is "unsure" with no model run.
    'live.moments.verify'(input) {
        const t = Number(input.t) || 0;
        const near = (list, key) => (list || []).filter((x) => Math.abs((Number(x.t) || 0) - t) <= 60).map((x) => `[${mmss(Number(x.t) || 0)}] ${oneLine(x[key], 200)}`);
        const timeline = near(input.timeline, 'text');
        const transcript = near(input.transcript, 'text');
        const sounds = near(input.sounds, 'label');
        if (!timeline.length && !transcript.length && !sounds.length) return { output: { verdict: 'unsure', unsupported: [], why: 'nothing recorded near the moment to check against' } };
        const c = input.chat || {};
        const chat = Number(c.peak) > 0 ? `${Math.round(Number(c.peak))} messages in the busiest 30 s (the stream averages ${Math.round(Number(c.avg) || 0)})${Number(c.people) > 0 ? ` from ${Math.round(Number(c.people))} people` : ''}` : 'no chat reaction recorded';
        return {
            vars: {
                title: oneLine(input.title, 120) || 'Untitled stream', at: mmss(t),
                clip_title: oneLine(input.clip_title, 120), clip_desc: oneLine(input.clip_desc, 400) || '(none)',
                timeline: timeline.join('\n') || '(none)', transcript: transcript.join('\n') || '(none)', sounds: sounds.join('\n') || '(none)', chat,
            },
        };
    },
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
    // Wiki generation (OpenVibe.Wiki's "vibe a wiki"): the plan's page budget, and a page's link targets and pictures.
    'wiki.space'(input) {
        return { vars: { ...input, max_pages: input.max_pages || 12, sources_block: sourcesBlock(input.sources), source_count: (input.sources || []).length } };
    },
    'wiki.page'(input) {
        const pages = (Array.isArray(input.pages) ? input.pages : []).map((t) => clean(t, 200)).filter(Boolean).slice(0, 60);
        const images = (Array.isArray(input.images) ? input.images : []).slice(0, 16);
        return {
            vars: {
                ...input,
                topic: input.topic || input.space || input.title,
                pages_block: pages.map((t) => `- ${t}`).join('\n') || '(this is the only page)',
                images_block: images.map((im, i) => `[${i}] ${clean(im.title, 300)}${im.description ? ` — ${clean(im.description, 400)}` : ''}`).join('\n'),
                sources_block: sourcesBlock(input.sources),
                source_count: (input.sources || []).length,
            },
        };
    },
    // The wiki writer (content.wiki): the numbered sources, the outline and the pages it may link.
    'content.wiki'(input) {
        const outline = (Array.isArray(input.outline) ? input.outline : []).map((h) => clean(h, 300)).filter(Boolean).slice(0, 30);
        const pages = (Array.isArray(input.pages) ? input.pages : []).map((t) => clean(t, 200)).filter(Boolean).slice(0, 60);
        const facts = (Array.isArray(input.facts) ? input.facts : []).map((f) => ({ label: clean(f && f.label, 80), value: clean(f && f.value, 400) })).filter((f) => f.label && f.value).slice(0, 40);
        return {
            vars: {
                ...input,
                topic: input.topic || input.title,
                space: input.space || input.topic || input.title,
                instruction: input.instruction ? clean(input.instruction, 4000) : '',
                outline_block: outline.map((h, i) => `${i + 1}. ${h}`).join('\n'),
                pages_block: pages.map((t) => `- ${t}`).join('\n'),
                facts_block: facts.map((f) => `- ${f.label}: ${f.value}`).join('\n'),
                sources_block: sourcesBlock(input.sources),
                source_count: (input.sources || []).length,
            },
        };
    },
    'pics.describe_image'(input) {
        return { vars: { title: clean(input.title, 120) || '' } };
    },
    'food.read_pantry_photo'(input) {
        const foods = (Array.isArray(input.foods) ? input.foods : []).slice(0, 80);
        return { vars: { kind: input.kind === 'receipt' ? 'grocery receipt' : 'cupboard, fridge or shelf', foods_block: foods.map((f, i) => `${i}: ${clean(f, 120)}`).join('\n') } };
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
    'live.viewers.plan'(r) {
        const p = r.json || parseJsonLoose(r.text) || { skip: true, lines: [] };
        const str = (v) => (v == null ? null : String(v));
        const lines = (Array.isArray(p.lines) ? p.lines : []).filter((l) => l && typeof l === 'object' && typeof l.text === 'string' && l.bot).slice(0, 12).map((l) => ({
            bot: String(l.bot).slice(0, 80), target: ['viewer', 'bot', 'streamer', 'ambient'].includes(l.target) ? l.target : 'ambient', reply_to: str(l.reply_to), thread: str(l.thread), topic: str(l.topic),
            delay_ms: Math.max(0, Math.min(45000, Math.round(Number(l.delay_ms) || 0))), text: l.text.slice(0, 500), reason: String(l.reason || '').slice(0, 120),
        }));
        return { skip: !!p.skip && !lines.length, notes: String(p.notes || '').slice(0, 200), lines, threads_close: Array.isArray(p.threads_close) ? p.threads_close.map(String).slice(0, 20) : [] };
    },
    'live.viewers.reply'(r) {
        const t = String(r.text || '').trim();
        return t ? { text: t.slice(0, 500) } : null;
    },
    'live.viewers.fold'(r) {
        const j = r.json || parseJsonLoose(r.text);
        if (!j || !Array.isArray(j.memories)) return null;
        return { memories: j.memories.filter((m) => m && m.bot).map((m) => ({ bot: String(m.bot).slice(0, 80), memory: String(m.memory || '').slice(0, 2000) })), channel_memory: String(j.channel_memory || '').slice(0, 2000) };
    },
    'live.viewers.clone'(r) {
        const t = String(r.text || '').trim();
        return t ? { text: t.slice(0, 1000) } : null;
    },
    // The Rundown: every field clamped; a segment without a topic, title or what is dropped; times stay inside the lines'.
    'live.rundown.segment'(r, input) {
        const j = r.json || parseJsonLoose(r.text);
        if (!j || !Array.isArray(j.segments)) return null;
        const one = (t, n) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, n);
        const ts = (input && input.lines || []).map((x) => Number(x.t)).filter(Number.isFinite);
        const lo = ts.length ? Math.min(...ts) : 0, hi = ts.length ? Math.max(...ts) : Infinity;
        const at = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; };
        const KINDS = ['news', 'games', 'tech', 'life', 'music', 'sports', 'money', 'internet', 'chat', 'other'];
        const segments = j.segments.filter((x) => x && one(x.topic, 120) && one(x.title, 90) && one(x.what, 500)).slice(0, 4).map((x) => {
            const start = at(x.start), end = Math.max(start, at(x.end));
            return {
                start, end, topic: one(x.topic, 120), kind: KINDS.includes(x.kind) ? x.kind : 'other', title: one(x.title, 90), what: one(x.what, 500),
                take: one(x.take, 300) || null, quip: one(x.quip, 220), score: Math.min(5, Math.max(1, Math.round(Number(x.score) || 1))),
                quotes: (Array.isArray(x.quotes) ? x.quotes : []).filter((q) => q && one(q.text, 400)).slice(0, 2).map((q) => ({ t: at(q.t), text: one(q.text, 400), en: one(q.en, 400) || null })),
            };
        });
        const tset = new Set(ts.map((t) => Math.round(t * 10)));
        const others = [...new Set((Array.isArray(j.others) ? j.others : []).map(Number).filter((t) => Number.isFinite(t) && tset.has(Math.round(t * 10))))].slice(0, 400);
        return { others, segments };
    },
    'live.rundown.episode'(r, input) {
        const j = r.json || parseJsonLoose(r.text);
        if (!j || !j.title || !j.recap) return null;
        const one = (t, n) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, n);
        const n = (input && input.segments || []).length;
        const seen = new Set();
        const chapters = (Array.isArray(j.chapters) ? j.chapters : []).filter((c) => c && Number.isInteger(c.index) && c.index >= 0 && c.index < n && !seen.has(c.index) && seen.add(c.index) && one(c.title, 60))
            .slice(0, 10).map((c) => ({ index: c.index, title: one(c.title, 60) }));
        const recap = String(j.recap).split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 4).join('\n\n').slice(0, 1200);
        return { title: one(j.title, 80), logline: one(j.logline, 220), recap, chapters };
    },
    'live.rundown.topic'(r) {
        const j = r.json || parseJsonLoose(r.text);
        if (!j || !j.summary) return null;
        const one = (t, n) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, n);
        return { headline: one(j.headline, 100), summary: one(j.summary, 700) };
    },
    // The day's card: public prose, so the labels and markup are filtered like any other public AI text, and a
    // highlight survives only when its take_id is one of the takes it was given (never an invented link).
    'live.rundown.today'(r, input) {
        const j = r.json || parseJsonLoose(r.text);
        if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
        const one = (t, n) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, n);
        const headline = one(j.headline, 100);
        const summary = plainProse(j.summary, 700);
        if (!headline || !summary) return null;
        const ids = new Set((input && Array.isArray(input.takes) ? input.takes : []).map((x) => Number(x && x.take_id)).filter((n) => Number.isInteger(n) && n > 0));
        // A card that says there were no takes or nothing was said, when takes were given, is a fabrication: no card.
        if (ids.size && /\bno takes?\b|\bnothing (?:was|has been) (?:said|submitted|shared)\b|\bno (?:streamer|one) (?:said|submitted|shared)\b/i.test(`${headline} ${summary}`)) return null;
        const seen = new Set();
        const highlights = (Array.isArray(j.highlights) ? j.highlights : []).slice(0, 8)
            .map((h) => ({ take_id: Number(h && h.take_id), line: plainProse(h && h.line, 240) }))
            .filter((h) => ids.has(h.take_id) && h.line && !seen.has(h.take_id) && seen.add(h.take_id))
            .slice(0, 3);
        return { headline, summary, highlights };
    },
    'live.clips.confirm'(r) {
        const j = r.json || parseJsonLoose(r.text);
        if (!j || typeof j !== 'object') return null;
        return { clip: j.clip === true, title: String(j.title || '').replace(/\s+/g, ' ').trim().slice(0, 80), desc: String(j.desc || '').replace(/\s+/g, ' ').trim().slice(0, 400) };
    },
    // Global picture or one chatter's profile (the profile's input names its subject_kind); every key the schema asks for.
    'live.chat.insight'(r, input) {
        const j = r.json || parseJsonLoose(r.text);
        if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
        const keys = input.subject_kind ? ['overview_24h', 'overview_alltime', 'memory'] : ['recent_overview', 'memory'];
        if (!keys.some((k) => typeof j[k] === 'string' && j[k].trim())) return null;
        const out = {};
        for (const k of keys) out[k] = typeof j[k] === 'string' ? j[k].slice(0, 4000) : '';
        out.timeline = (Array.isArray(j.timeline) ? j.timeline : []).filter((t) => t && t.label).slice(0, 5)
            .map((t) => ({ label: String(t.label).slice(0, 120), detail: String(t.detail || '').slice(0, 400), mins_ago: Math.max(0, Math.round(Number(t.mins_ago) || 0)) }));
        return out;
    },
    'live.person.overview'(r) {
        const t = (r.json && typeof r.json.overview === 'string' ? r.json.overview : r.text || '').replace(/^\s*(combined\s+overview|overview)\s*[:\-–]\s*/i, '').trim();
        return t ? { overview: t.slice(0, 2000) } : null;
    },
    'live.stream.titles'(r, input) {
        const j = r.json || parseJsonLoose(r.text);
        const arr = Array.isArray(j) ? j : j && Array.isArray(j.titles) ? j.titles : null;
        if (!arr) return null;
        const titles = arr.filter((x) => x && Number.isInteger(Number(x.index)) && Number(x.index) >= 0 && Number(x.index) < input.summaries.length && x.title)
            .map((x) => ({ index: Number(x.index), title: String(x.title).replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 80) }));
        return { titles };
    },
    'live.moments.rank'(r, input) {
        const j = r.json || parseJsonLoose(r.text);
        const arr = Array.isArray(j) ? j : j && Array.isArray(j.ranked) ? j.ranked : null;
        if (!arr) return null;
        const seen = new Set();
        const ranked = arr.filter((x) => x && Number.isInteger(Number(x.index)) && input.vods[Number(x.index)] != null && !seen.has(Number(x.index)) && seen.add(Number(x.index)))
            .map((x) => ({ index: Number(x.index), score: Math.max(0, Math.min(100, Math.round(Number(x.score) || 0))), why: String(x.why || '').replace(/\s+/g, ' ').trim().slice(0, 60) }));
        return { ranked };
    },
    'live.hero.slogans'(r) {
        const j = r.json || parseJsonLoose(r.text);
        const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.slice(0, 200)).slice(0, 60) : []);
        if (!j || (!list(j.audiences).length && !list(j.quips).length)) return null;
        return { audiences: list(j.audiences), quips: list(j.quips) };
    },
    'live.easter_egg'(r) {
        const j = r.json || parseJsonLoose(r.text);
        if (!j || !Array.isArray(j.code) || !j.code.length) return null;
        const strs = (v) => (Array.isArray(v) ? v.map((x) => String(x)).slice(0, 12) : []);
        return { title: String(j.title || '').slice(0, 80), code: strs(j.code), clues: strs(j.clues || j.hints).map((c) => c.slice(0, 200)), effect: ['confetti', 'fireworks', 'matrix', 'rainbow', 'shake'].includes(j.effect) ? j.effect : 'confetti', reward: String(j.reward || '').slice(0, 300) };
    },
    'live.home.star'(r) {
        const j = r.json || parseJsonLoose(r.text);
        if (!j || !j.username) return null;
        return { username: String(j.username).slice(0, 64), headline: String(j.headline || '').trim().slice(0, 60), reason: String(j.reason || '').trim().slice(0, 170) };
    },
    'live.moments.pick'(r, input) {
        const j = r.json || parseJsonLoose(r.text);
        const has = (k) => j && Object.prototype.hasOwnProperty.call(j, k);
        // An explicit "nothing worth it" (at or t null, or abstain: true) is an answer, not a failure (C09).
        if (j && (j.abstain === true || (has('at') && j.at === null) || (!has('at') && has('t') && j.t === null))) {
            return { t: null, title: '', desc: '', abstain: true, why: oneLine(j.why, 200) };
        }
        if (!j) return null;
        // The moment comes back as the lines show it ("12:34", "1:02:03"); a bare number there could be minutes or
        // seconds, so it is no answer. An older answer's t is seconds.
        const t = has('at') ? clockSeconds(j.at) : Number(j.t);
        if (!Number.isFinite(t) || t < 0) return null;
        // Never after everything the model was shown: a time past the last line (plus two minutes) is made up.
        const shown = ['timeline', 'transcript', 'sounds'].flatMap((k) => ((input && input[k]) || []).map((x) => Number(x && x.t)))
            .concat(((input && input.clipped) || []).map(Number), ((input && input.spikes) || []).map(Number)).filter(Number.isFinite);
        if (shown.length && t > Math.max(...shown) + 120) return null;
        return { t: Math.floor(t), title: oneLine(j.title, 80).replace(/^["']+|["']+$/g, ''), desc: oneLine(j.desc, 400) };
    },
    // C09: only a verdict from the set is an answer; "supported" with claims it calls unbacked is not a yes.
    'live.moments.verify'(r) {
        const j = r.json || parseJsonLoose(r.text);
        if (!j || typeof j !== 'object' || !['supported', 'unsupported', 'unsure'].includes(j.verdict)) return null;
        const unsupported = (Array.isArray(j.unsupported) ? j.unsupported : []).map((x) => oneLine(x, 200)).filter(Boolean).slice(0, 8);
        const verdict = j.verdict === 'supported' && unsupported.length ? 'unsure' : j.verdict;
        return { verdict, unsupported, why: oneLine(j.why, 200) };
    },
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
    // The JSON answer (2026-11-11, ask 363: lines that read as a person wrote them): the card's own line and the page's
    // overview; an answer in plain prose is still taken as the overview alone.
    'live.streamer.overview'(r) {
        const j = r.json || parseJsonLoose(r.text);
        if (j && typeof j.overview === 'string' && j.overview.trim()) {
            const overview = plainProse(j.overview, 4000);
            const line = typeof j.line === 'string' ? plainProse(j.line, 140) : '';
            return overview ? { overview, ...(line ? { line } : {}) } : null;
        }
        const overview = plainProse(r.text, 4000);
        return overview ? { overview } : null;
    },
    'live.media.overview'(r) { const overview = plainProse(r.text, 2000); return overview ? { overview } : null; },
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

// Space's builder keeps its hooks beside its templates (server/workflows/space.js).
{ const space = require('./space'); Object.assign(PREPARE, space.PREPARE); Object.assign(POSTPROCESS, space.POSTPROCESS); }
// People's own controls (2026-11-11): the layout suggestion's prepare and postprocess live with its template.
{ const ui = require('./ui-layout'); PREPARE['ui.layout.suggest'] = ui.prepare; POSTPROCESS['ui.layout.suggest'] = ui.postprocess; }

/**
 * What the run cache keys on, for a workflow whose input carries parts that do not change the answer (item 151, C12:
 * the range cache). live.media.transcribe gets a signed media URL (exp, sig) that differs on every call and a
 * low_power flag that only changes how fast whisper runs, so the same seconds of the same recording were transcribed
 * again (30 of 317 runs in the week to 11-03). Its key is the recording, the range, the language and words: the cache
 * stays scoped to the requester as before.
 */
const CACHE_INPUT = {
    'live.media.transcribe'(input) {
        let url = String(input.media_url || '');
        try {
            const u = new URL(url);
            for (const k of ['exp', 'sig', 'expires', 'signature', 'token']) u.searchParams.delete(k);
            url = u.toString();
        } catch { /* not a URL: kept as given */ }
        const { low_power: _lowPower, ...rest } = input;
        return { ...rest, media_url: url };
    },
};

module.exports = { PREPARE, POSTPROCESS, CACHE_INPUT, CATEGORIES, normalizeCategory, translatable, sourcesBlock, LANG_NAMES };
