'use strict';
/**
 * Media workflows (roadmap WS-O task 5).
 *
 *   media.analyze  local-first analysis of a VOD, clip or audio file (server/workflows/media-analysis.js): FFmpeg
 *                  signals, scenes, local speech-to-text, highlights with their evidence, and an overview from a local
 *                  model, or extractive; a paid provider only when the caller allows it and a budget covers it.
 *                  Media owns media; Live calls it for its VOD and clip overviews (its grant names media.analyze).
 */
const { MEDIA_REF } = require('./common-schemas');

const NUM = { type: 'number' };
const SPAN = { type: 'object', additionalProperties: false, required: ['start', 'end'], properties: { start: NUM, end: NUM } };
const ARR = (items, max) => ({ type: 'array', items, maxItems: max });
const STR = (n) => ({ type: 'string', maxLength: n });

const templates = [
    {
        key: 'media.analyze.overview', name: 'Media: overview from signals and a transcript',
        description: 'The overview step of media.analyze, for a local model (media.local) or, with a budget, a paid one (media.paid).',
        input_schema: { type: 'object' }, output_schema: { type: 'object' },
        system_prompt: 'You describe a video or audio recording for its creator, from facts a machine measured and from a speech transcript. Use only what is given. Do not guess what is on screen beyond what the transcript says, and never invent names, numbers or events. Write 2 to 4 plain sentences in English (at most 500 characters): what the recording is about and what happens in it, with the times of the highlights that matter. Do not retell or translate the transcript; quote at most one short phrase (under 60 characters). No markup, no emoji, no preamble.',
        user_prompt: 'Measured facts:\n{{facts}}\n\nHighlights (time, why, what was said):\n{{highlights}}\n\nTranscript:\n{{transcript}}',
        default_route: 'media.local', owner: 'media', metadata: {},
    },
];

const workflows = [
    {
        key: 'media.analyze', name: 'Local-first media analysis: signals, scenes, speech, highlights, overview', namespace: 'media',
        description: 'FFmpeg signals (scene changes, black and frozen picture, silence, loudness), scenes, whisper.cpp speech-to-text and scored highlights, all on this host; the overview from a local model, else extractive. Paid providers only with allow_paid and a media.paid cost budget.',
        input_schema: {
            type: 'object', additionalProperties: false, required: [],
            properties: {
                media: MEDIA_REF, media_url: STR(2048),
                language: { type: 'string', pattern: '^(auto|[a-z]{2})$' },
                seconds: { type: 'integer', minimum: 0, maximum: 36000, description: 'analyse at most this many seconds from the start (0: all)' },
                allow_paid: { type: 'boolean', description: 'a paid provider may write the overview when no local model can and a budget allows it' },
            },
        },
        output_schema: {
            type: 'object', additionalProperties: false,
            required: ['duration_seconds', 'analyzed_seconds', 'streams', 'signals', 'scenes', 'transcript', 'speech_ratio', 'highlights', 'overview', 'gaps'],
            properties: {
                duration_seconds: NUM, analyzed_seconds: NUM,
                streams: { type: 'object', additionalProperties: false, required: ['video', 'audio'], properties: { video: { type: 'boolean' }, audio: { type: 'boolean' } } },
                signals: {
                    type: 'object', additionalProperties: false, required: ['scene_changes', 'black', 'frozen', 'silence', 'loudness'],
                    properties: {
                        scene_changes: ARR({ type: 'object', additionalProperties: false, required: ['t', 'score'], properties: { t: NUM, score: NUM } }, 300),
                        black: ARR(SPAN, 200), frozen: ARR(SPAN, 200), silence: ARR(SPAN, 500),
                        loudness: {
                            type: 'object', additionalProperties: false, required: ['integrated_lufs', 'range_lu', 'typical_lufs', 'peaks', 'per_minute'],
                            properties: {
                                integrated_lufs: { type: ['number', 'null'] }, range_lu: { type: ['number', 'null'] }, typical_lufs: { type: ['number', 'null'], description: 'the median second: the programme\'s usual level' },
                                peaks: ARR({ type: 'object', additionalProperties: false, required: ['start', 'end', 'lufs'], properties: { start: NUM, end: NUM, lufs: NUM } }, 50),
                                per_minute: ARR({ type: ['number', 'null'] }, 600),
                            },
                        },
                    },
                },
                scenes: ARR(SPAN, 300),
                transcript: {
                    type: 'object', additionalProperties: false, required: ['available', 'language', 'text', 'segments'],
                    properties: { available: { type: 'boolean' }, language: STR(8), text: { type: 'string', maxLength: 200000 }, segments: ARR({ type: 'object', additionalProperties: false, required: ['start', 'end', 'text'], properties: { start: NUM, end: NUM, text: { type: 'string' } } }, 5000) },
                },
                speech_ratio: { type: ['number', 'null'], minimum: 0, maximum: 1 },
                highlights: ARR({ type: 'object', additionalProperties: false, required: ['start', 'end', 'score', 'reasons', 'excerpt'], properties: { start: NUM, end: NUM, score: NUM, reasons: ARR({ type: 'string', enum: ['loud', 'scene changes', 'speech'] }, 3), excerpt: STR(300) } }, 10),
                overview: { type: 'object', additionalProperties: false, required: ['text', 'source'], properties: { text: STR(1500), source: { type: 'string', enum: ['local_model', 'paid', 'extractive'] }, provider: { type: ['string', 'null'] }, model: { type: ['string', 'null'] } } },
                gaps: ARR(STR(300), 20),
            },
        },
        steps: [{ kind: 'media_analysis', stt_route: 'live.stt', template: 'media.analyze.overview', local_route: 'media.local', paid_route: 'media.paid' }],
        // Not cached: a result made while the local model was down (or before a budget) must not outlive that, and
        // callers keep what they asked for (Live's vod_ai_state/clip_ai_state).
        cache_mode: 'none',
    },
];

module.exports = { templates, workflows };
