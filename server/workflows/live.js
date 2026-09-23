'use strict';
/**
 * OpenVibe.Live's AI features as workflows, moved from Live with minimal change.
 *
 * Two shapes:
 *   - STRUCTURED workflows own their prompt here (versioned templates) and take structured input:
 *     translation, paste image/text analysis, stream-frame description (moments), stream summary
 *     (stream memory / overview + inferred category), streamer overview, VOD/clip media overview,
 *     stream recap, speech-to-text, and Network's footer copy (the dependency the plan reverses).
 *   - PASSTHROUGH workflows carry a prompt Live still renders itself (chat AI viewers, chat
 *     insights, moment ranking, slogans, easter eggs, arena, home star …). Each Live feature has
 *     its own workflow key so every run stays attributable to a workflow + model + run (§33);
 *     their prompts move into templates feature by feature (docs/migration.md).
 *
 * Prompt text below is copied verbatim from Live (server/i18n/translate.js, server/ai/ai-analysis.js,
 * server/ai/media-analysis.js, server/recap/recap.js, server/internal/routes.js).
 */
const { IMAGE, MEDIA_REF, SOURCES } = require('./common-schemas');

const ROLES = ['chat', 'vision', 'director', 'summary', 'legacy'];
const LANG = { type: 'string', pattern: '^(auto|[a-z]{2})$' };
const STR = (n) => ({ type: 'string', maxLength: n });

// ── Templates ────────────────────────────────────────────
const templates = [
    {
        key: 'live.translate', name: 'Live: translate chat, bio or speech',
        description: 'From server/i18n/translate.js. Keeps tone, slang, emotes and mentions; speech keeps line count.',
        input_schema: { type: 'object' }, output_schema: { type: 'object' },
        system_prompt: 'You translate {{kind}} from {{src}} to {{dst}}. Rules: keep the tone, slang, jokes, profanity and emoji as they are; keep names, URLs, :emotes:, !commands and @mentions unchanged; never add explanations, notes, quotes or brackets; if it is already in the target language, return it unchanged.{{#speech}} Input may contain several lines separated by newlines — return exactly the same number of lines, in order.{{/speech}} Output ONLY the translation.',
        user_prompt: '{{text}}',
        default_route: 'live.chat', owner: 'live',
    },
    {
        key: 'live.paste.describe_image', name: 'Live: describe an image paste or moment frame',
        description: 'From ai-analysis.analyzeImagePaste (paste_image, moment_frame).',
        input_schema: { type: 'object' }, output_schema: { type: 'object' },
        system_prompt: '',
        user_prompt: 'You are describing an uploaded image/screenshot for a paste titled "{{title}}".\nReply ONLY with compact JSON: {"description":"1-2 sentence description of what the image shows","tags":["3-6","short","lowercase","tags"]}.',
        default_route: 'live.vision', owner: 'live',
    },
    {
        key: 'live.paste.summarize_text', name: 'Live: summarize a text paste',
        description: 'From ai-analysis.analyzeTextPaste (paste_text).',
        input_schema: { type: 'object' }, output_schema: { type: 'object' },
        system_prompt: '',
        user_prompt: 'Summarize what this pasted text is about in one short sentence (max 200 chars), plainly. Title: "{{title}}".\n\n---\n{{snippet}}',
        default_route: 'live.legacy', owner: 'live',
    },
    {
        key: 'live.stream.describe_frame', name: 'Live: describe a live-stream frame',
        description: 'From ai-analysis.analyzeStreamFrame (stream_memory): memory description, tags, and a screenshot-worthiness verdict + caption for live pastes, in one vision call.',
        input_schema: { type: 'object' }, output_schema: { type: 'object' },
        system_prompt: '',
        user_prompt: 'This is a frame from a live stream. Reply ONLY with compact JSON: {"description":"one concise sentence describing what is happening on screen right now","tags":["2-5","short","tags"],"worthy":<true only if this exact frame is genuinely screenshot-worthy on its own: a face/reaction, a visual gag, something unusual or funny on screen — false for ordinary gameplay/desktop/chat/talking-head frames>,"title":"<if worthy: a punchy, funny 3-7 word caption for it, else empty>"}.',
        default_route: 'live.vision', owner: 'live',
    },
    {
        key: 'live.stream.summarize', name: 'Live: stream overview + inferred category',
        description: 'From ai-analysis.summarizeStreamMemories: whole-session overview from timestamped observations and the audio timeline; category is inferred, never defaulted.',
        input_schema: { type: 'object' }, output_schema: { type: 'object' },
        system_prompt: '',
        user_prompt: 'These are timestamped observations from a live stream, in order since it started. Reply ONLY with compact JSON: {"overview":"a thorough overview (2-6 sentences) of what this stream has been about overall — the main activities, topics, and vibe across the whole session (not just the latest moment)","category":"<exactly one of: {{categories}} — what this stream mostly IS, judged from the observations; desktop = screen/software/coding, gaming = playing games, irl = camera on a person talking/doing things indoors, outdoors/travel = out in the world>","tags":["3-6","short","lowercase","tags"]}\n{{lines}}{{audio_block}}',
        default_route: 'live.legacy', owner: 'live',
    },
    {
        key: 'live.streamer.overview', name: 'Live: internal streamer profile for staff',
        description: 'From ai-analysis.generateStreamerOverview.',
        input_schema: { type: 'object' }, output_schema: { type: 'object' },
        system_prompt: '',
        user_prompt: 'You are building an internal profile of a livestreamer for site staff, using aggregated signals across their streams, VODs, and pastes. Write a concise overview (4-8 sentences) covering: what they stream / their content niche, recurring themes or activities, tone/vibe, and anything notable for moderation. Be factual and neutral; do NOT invent specifics that aren\'t supported by the signals below.\n\n{{ctx}}',
        default_route: 'live.legacy', owner: 'live',
    },
    {
        key: 'live.media.overview', name: 'Live: VOD/clip overview from frames + transcript',
        description: 'From media-analysis.analyzeMedia (media_overview).',
        input_schema: { type: 'object' }, output_schema: { type: 'object' },
        system_prompt: '',
        user_prompt: 'You are writing an AI overview of a recorded video. Using ONLY the signals below (be concrete, don\'t invent), summarize what the video is about in 2-5 sentences — the main activities, topics, and vibe.\n\n{{parts}}',
        default_route: 'live.legacy', owner: 'live',
    },
    {
        key: 'live.stream.recap', name: 'Live: after-show report',
        description: 'From recap/recap.js aiWriteup (stream_recap).',
        input_schema: { type: 'object' },
        output_schema: {
            type: 'object', additionalProperties: false, required: ['headline', 'summary', 'moment', 'tags', 'grade'], properties: {
                headline: { type: 'string', description: '≤ 70 chars, like a sports-page headline about this stream, no quotes, no emojis' },
                summary: { type: 'string', description: '2–3 sentences, ≤ 420 chars, what happened and how it went, concrete, warm, second person is fine' },
                moment: { type: 'string', description: '≤ 160 chars, the single moment of the night (from the mic lines, chat spike, a clip title or the transcript) — or empty string' },
                tags: { type: 'array', items: { type: 'string' }, description: '3 short vibe tags, 1–2 words each, lowercase' },
                grade: { type: 'string', enum: ['S', 'A', 'B', 'C'], description: 'S = legendary night, A = great, B = solid, C = quiet' },
            },
        },
        system_prompt: 'You write the "after-show report" for a live stream on OpenVibe.Live (a scrappy, open-source, community-run streaming site). Voice: sports-page energy, warm, specific, a little funny, never mocking the streamer or the viewers. Use the REAL numbers and names given. Small streams are fine — a 4-viewer night can still be an A if it was fun. Output only JSON.',
        user_prompt: '{{json facts}}',
        default_route: 'live.summary', owner: 'live', metadata: { json_name: 'stream_recap' },
    },
    {
        key: 'network.site_copy', name: 'Network: shared footer copy',
        description: 'Was Live\'s POST /internal/ai/site-copy (server/internal/routes.js). The model writes blurbs and PICKS link ids from an allow-list; it never returns URLs or markup.',
        input_schema: { type: 'object' },
        output_schema: {
            type: 'object', additionalProperties: false, required: ['sites'], properties: {
                sites: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'blurb', 'picks'], properties: { id: { type: 'string' }, blurb: { type: 'string' }, picks: { type: 'array', items: { type: 'string' } } } } },
            },
        },
        system_prompt: 'You write footer copy for OpenVibe, an open source, community-run network of sites (live streaming, online tools, community pastes, games, media). Voice: plain, confident, specific, a little playful. Never claim anything is free, costs $0, or has no ads. No hype words, no emoji, no markup, no URLs. For each site write one blurb of at most 150 characters saying what a visitor can do there right now, and choose 4 link ids from the provided list that a visitor of that site would most likely want next (prefer other sites and popular tools; never the site itself).',
        user_prompt: '{{json payload}}',
        default_route: 'live.summary', owner: 'network', metadata: { json_name: 'site_copy' },
    },
];

// ── Structured workflows ─────────────────────────────────
const TEXT_OUT = (props, required) => ({ type: 'object', additionalProperties: false, required, properties: props });

const structured = [
    {
        key: 'live.translate', name: 'Translate a chat line, bio or speech lines', namespace: 'live',
        description: 'Direction is chosen by the caller (Live picks it from the script and the channel language). Cached per service: translations of public text are the same for every Live user.',
        input_schema: TEXT_OUT({ text: STR(4000), from: LANG, to: LANG, context: { enum: ['chat', 'bio', 'speech'] }, max_tokens: { type: 'integer', minimum: 40, maximum: 1200 } }, ['text', 'to']),
        output_schema: TEXT_OUT({ text: { type: ['string', 'null'] }, from: STR(8), to: STR(8), unchanged: { type: 'boolean' }, reason: STR(40) }, ['text', 'unchanged']),
        steps: [{ kind: 'llm', template: 'live.translate', operation: 'generate', output: 'text', prepare: 'live.translate', postprocess: 'live.translate', params: { temperature: 0.2, timeout_ms: 15000 } }],
        cache_mode: 'service', cache_ttl_sec: 30 * 24 * 3600,
    },
    {
        key: 'live.paste.describe_image', name: 'Describe an image paste / moment frame', namespace: 'live',
        input_schema: TEXT_OUT({ title: STR(500), image: IMAGE, sources: SOURCES(0, 5) }, ['image']),
        output_schema: TEXT_OUT({ description: STR(600), tags: { type: 'array', items: STR(200), maxItems: 8 } }, ['description', 'tags']),
        steps: [{ kind: 'llm', template: 'live.paste.describe_image', operation: 'generate', output: 'text', image: 'image', image_max_width: 1280, prepare: 'live.paste.describe_image', postprocess: 'live.paste.describe_image', params: { max_tokens: 300 } }],
        cache_mode: 'private',
    },
    {
        key: 'live.paste.summarize_text', name: 'Summarize a text paste', namespace: 'live',
        input_schema: TEXT_OUT({ title: STR(500), content: STR(200000), sources: SOURCES(0, 5) }, ['content']),
        output_schema: TEXT_OUT({ description: STR(300), tags: { type: 'array', maxItems: 0 } }, ['description', 'tags']),
        steps: [{ kind: 'llm', template: 'live.paste.summarize_text', operation: 'summarize', output: 'text', prepare: 'live.paste.summarize_text', postprocess: 'live.paste.summarize_text', params: { max_tokens: 120 } }],
        cache_mode: 'private',
    },
    {
        key: 'live.stream.describe_frame', name: 'Describe a live-stream frame (moment detection)', namespace: 'live',
        input_schema: TEXT_OUT({ image: IMAGE, sources: SOURCES(0, 5) }, ['image']),
        output_schema: TEXT_OUT({ description: STR(400), tags: { type: 'array', items: STR(200), maxItems: 6 }, worthy: { type: 'boolean' }, title: STR(80) }, ['description', 'tags', 'worthy', 'title']),
        steps: [{ kind: 'llm', template: 'live.stream.describe_frame', operation: 'generate', output: 'text', image: 'image', image_max_width: 768, postprocess: 'live.stream.describe_frame', params: { max_tokens: 240 } }],
        cache_mode: 'none',
    },
    {
        key: 'live.stream.summarize', name: 'Stream overview + inferred category (stream memory)', namespace: 'live',
        input_schema: TEXT_OUT({
            observations: { type: 'array', items: STR(1000), minItems: 1, maxItems: 400 },
            speech: { type: 'array', maxItems: 1000, items: { type: 'object', required: ['start_sec', 'text'], properties: { start_sec: { type: 'number' }, text: STR(2000) } } },
            sounds: { type: 'array', maxItems: 500, items: { type: 'object', required: ['start_sec', 'label'], properties: { start_sec: { type: 'number' }, label: STR(120), confidence: { type: 'number' } } } },
            sources: SOURCES(0, 50),
        }, ['observations']),
        output_schema: TEXT_OUT({ overview: STR(2000), category: { type: ['string', 'null'], enum: ['outdoors', 'travel', 'building', 'music', 'gaming', 'robot', 'desktop', 'irl', 'other', null] }, tags: { type: 'array', items: STR(200), maxItems: 6 } }, ['overview', 'category', 'tags']),
        steps: [{ kind: 'llm', template: 'live.stream.summarize', operation: 'summarize', output: 'text', prepare: 'live.stream.summarize', postprocess: 'live.stream.summarize', params: { max_tokens: 560 } }],
        cache_mode: 'private',
    },
    {
        key: 'live.streamer.overview', name: 'Internal streamer overview for staff', namespace: 'live',
        input_schema: TEXT_OUT({
            streamer: { type: 'object', required: ['username'], properties: { username: STR(80), display_name: STR(120), bio: STR(2000), category: STR(40), category_inferred: { type: 'boolean' } } },
            memories: { type: 'array', items: STR(1000), maxItems: 100 },
            vods: { type: 'array', maxItems: 50, items: { type: 'object', properties: { title: STR(300), category: STR(40) } } },
            pastes: { type: 'array', maxItems: 50, items: { type: 'object', properties: { title: STR(300), summary: STR(600) } } },
            sources: SOURCES(0, 50),
        }, ['streamer']),
        output_schema: TEXT_OUT({ overview: STR(4000) }, ['overview']),
        steps: [{ kind: 'llm', template: 'live.streamer.overview', operation: 'summarize', output: 'text', prepare: 'live.streamer.overview', postprocess: 'live.streamer.overview', params: { max_tokens: 550 } }],
        cache_mode: 'private',
    },
    {
        key: 'live.media.overview', name: 'VOD/clip overview from frames and transcript', namespace: 'live',
        input_schema: TEXT_OUT({ frames: { type: 'array', items: STR(1000), maxItems: 60 }, transcript: STR(200000), sources: SOURCES(0, 50) }, []),
        output_schema: TEXT_OUT({ overview: STR(2000) }, ['overview']),
        steps: [{ kind: 'llm', template: 'live.media.overview', operation: 'summarize', output: 'text', prepare: 'live.media.overview', postprocess: 'live.media.overview', params: { max_tokens: 400 } }],
        cache_mode: 'private',
    },
    {
        key: 'live.stream.recap', name: 'After-show report for a finished stream', namespace: 'live',
        input_schema: TEXT_OUT({ facts: { type: 'object' }, sources: SOURCES(0, 50) }, ['facts']),
        output_schema: TEXT_OUT({ headline: STR(90), summary: STR(500), moment: STR(200), tags: { type: 'array', items: STR(200), maxItems: 4 }, grade: { enum: ['S', 'A', 'B', 'C'] } }, ['headline', 'summary', 'moment', 'tags', 'grade']),
        steps: [{ kind: 'llm', template: 'live.stream.recap', operation: 'generate', output: 'json', postprocess: 'live.stream.recap', params: { max_tokens: 500, temperature: 0.8, timeout_ms: 40000 } }],
        cache_mode: 'private',
    },
    {
        key: 'live.media.transcribe', name: 'Speech-to-text for a VOD, clip or audio file', namespace: 'live',
        description: 'whisper.cpp on this host (Live\'s transcribe.js), media fetched only from allow-listed OpenVibe hosts.',
        input_schema: TEXT_OUT({ media: MEDIA_REF, media_url: STR(2048), language: LANG, seconds: { type: 'integer', minimum: 0, maximum: 36000 }, offset_sec: { type: 'number', minimum: 0 } }, []),
        output_schema: TEXT_OUT({ text: { type: 'string' }, language: STR(8), segments: { type: 'array', items: { type: 'object', required: ['start', 'end', 'text'], properties: { start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' } } } } }, ['text', 'segments']),
        steps: [{ kind: 'transcribe', route: 'live.stt' }],
        cache_mode: 'private',
    },
    {
        key: 'network.site_copy', name: 'Footer copy for the shared network chrome', namespace: 'network',
        description: 'Reverses the dependency: OpenVibe.Network used to call Live\'s /internal/ai/site-copy for this.',
        input_schema: TEXT_OUT({
            sites: { type: 'array', minItems: 1, maxItems: 24, items: { type: 'object', required: ['id'], properties: { id: STR(40), name: STR(60), what: STR(400), popular: { type: 'array', items: STR(200), maxItems: 8 } } } },
            links: { type: 'array', maxItems: 80, items: { type: 'object', required: ['id'], properties: { id: STR(60), name: STR(60), about: STR(120) } } },
        }, ['sites']),
        output_schema: TEXT_OUT({ sites: { type: 'array', items: { type: 'object', required: ['id', 'blurb', 'picks'], properties: { id: STR(40), blurb: STR(300), picks: { type: 'array', items: STR(60), maxItems: 4 } } } } }, ['sites']),
        steps: [{ kind: 'llm', template: 'network.site_copy', operation: 'generate', output: 'json', prepare: 'network.site_copy', postprocess: 'network.site_copy', params: { max_tokens: 2200, temperature: 0.7, timeout_ms: 60000 } }],
        cache_mode: 'service', cache_ttl_sec: 12 * 3600,
    },
];

// ── Passthrough workflows (prompt still rendered by Live) ──
const PASSTHROUGH_INPUT = {
    type: 'object', additionalProperties: false,
    properties: {
        role: { enum: ROLES },
        kind: STR(64),
        source: STR(64),
        system: { anyOf: [STR(400000), { type: 'array', maxItems: 12, items: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: STR(400000), cache: { type: 'boolean' } } } }] },
        messages: { type: 'array', maxItems: 200, items: { type: 'object', required: ['role', 'content'], properties: { role: { enum: ['user', 'assistant'] }, content: {} } } },
        user: STR(800000),
        image: IMAGE,
        json: { type: 'object', required: ['schema'], properties: { name: STR(64), schema: { type: 'object' }, strict: { type: 'boolean' }, description: STR(500) } },
        max_tokens: { type: 'integer', minimum: 1, maximum: 16000 },
        temperature: { type: ['number', 'null'], minimum: 0, maximum: 2 },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000 },
        cache_key: STR(128),
    },
    anyOf: [{ required: ['user'] }, { required: ['messages'] }],
};
const PASSTHROUGH_OUTPUT = { type: 'object', required: ['text', 'json'], properties: { text: { type: 'string' }, json: { type: ['object', 'array', 'null'] } } };

const PASSTHROUGH = [
    ['live.complete', 'Any other Live completion', 'Fallback for a Live llm.complete() kind without its own workflow yet.'],
    ['live.viewers.plan', 'AI viewers: director plan', 'viewers/director.js plan() — ai_viewers_director.'],
    ['live.viewers.reply', 'AI viewers: fast streamer reply', 'viewers/director.js quickReply() — ai_viewers_reply.'],
    ['live.viewers.line', 'AI viewers: single line', 'viewers/budget.js generate() — ai_viewers (chat reply).'],
    ['live.viewers.fold', 'AI viewers: memory fold', 'viewers/fold.js — ai_viewers_fold.'],
    ['live.chat.insight', 'Chat insights and session overviews', 'chat-ai.js and chat-ai-routes.js — chat_global, chat_user, chat_relay, chat_anon, combined_overview, session_titles.'],
    ['live.moments.rank', 'Moments: rank VOD moments', 'ai-moments-job.js — moment_vod_rank.'],
    ['live.moments.pick', 'Moments: pick a moment', 'ai-moments-job.js — moment_pick.'],
    ['live.clips.confirm', 'Auto-clip confirmation', 'auto-clip-job.js — auto_clip_confirm.'],
    ['live.hero.slogans', 'Home hero slogans', 'slogan-job.js — hero_slogans.'],
    ['live.easter_egg', 'Easter eggs', 'easter-egg-job.js — easter_egg.'],
    ['live.home.star', 'Star of OpenVibe write-up', 'home/star-job.js — home_star.'],
    ['live.arena.persona', 'Arena: persona', 'arena-service.js — arena_persona.'],
    ['live.arena.quotes', 'Arena: quotes', 'arena-service.js — arena_quotes.'],
    ['live.arena.scene', 'Arena: scene description', 'arena-service.js — arena_scene.'],
    ['live.arena.judge', 'Arena: beef and mic judging', 'arena/listener.js — arena_beef_judge, arena_mic_judge.'],
    ['live.arena.headline', 'Arena: headline', 'arena/beef.js — arena_headline.'],
    ['live.status_check', 'Provider probe', 'ai-analysis.testStatus / llm.testProvider — status_check.'],
];

const passthrough = PASSTHROUGH.map(([key, name, description]) => ({
    key, name, namespace: 'live', description: `${description} Prompt rendered by Live (passthrough); the run records only its hash.`,
    input_schema: PASSTHROUGH_INPUT, output_schema: PASSTHROUGH_OUTPUT,
    steps: [{ kind: 'passthrough', route_prefix: 'live' }],
    cache_mode: 'none',
    metadata: { passthrough: true },
}));

/** Live llm.complete() `kind` -> workflow key (the Live client uses the same table). */
const KIND_TO_WORKFLOW = {
    ai_viewers_director: 'live.viewers.plan', ai_viewers_reply: 'live.viewers.reply', ai_viewers: 'live.viewers.line', ai_viewers_fold: 'live.viewers.fold',
    chat_global: 'live.chat.insight', chat_user: 'live.chat.insight', chat_relay: 'live.chat.insight', chat_anon: 'live.chat.insight', combined_overview: 'live.chat.insight', session_titles: 'live.chat.insight',
    moment_vod_rank: 'live.moments.rank', moment_pick: 'live.moments.pick', auto_clip_confirm: 'live.clips.confirm', hero_slogans: 'live.hero.slogans', easter_egg: 'live.easter_egg', home_star: 'live.home.star',
    arena_persona: 'live.arena.persona', arena_quotes: 'live.arena.quotes', arena_scene: 'live.arena.scene', arena_beef_judge: 'live.arena.judge', arena_mic_judge: 'live.arena.judge', arena_headline: 'live.arena.headline',
    status_check: 'live.status_check',
};

module.exports = { templates, workflows: [...structured, ...passthrough], KIND_TO_WORKFLOW, ROLES, PASSTHROUGH_INPUT, PASSTHROUGH_OUTPUT };
