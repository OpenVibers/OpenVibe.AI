'use strict';
/**
 * The shapes video.analyze runs on.
 *
 * The published document is ai.video-analysis@1 (OpenVibe.Contracts): the video it read, what ffprobe
 * measured, the keyframes it took (each a small JPEG kept as a run artifact, with what the vision route
 * saw in it and the on-screen text it read), the transcript with its word times, the chapters, the
 * summary, the people, objects and places that were named (only what was shown or said, each with the
 * time it was seen or heard), the tags, the answer to the question that was asked, the explicit-content
 * verdict and the receipt of every step and model call.
 *
 * This module holds the workflow's input and output schema and the two JSON shapes an intermediate
 * model call answers in (one frame, the whole video). They are deliberately smaller than the report:
 * the report is assembled here, from what was actually measured, heard and seen, so a model cannot
 * invent a frame, a time, a name or a chapter that no tool found.
 */

const STR = (n) => ({ type: 'string', maxLength: n });
const NULLABLE = (n) => ({ type: ['string', 'null'], maxLength: n });
const NUM = { type: 'number' };

/** The three depths. The frame caps below are the defaults; the service config may raise or lower them. */
const DEPTHS = ['quick', 'standard', 'deep'];
const FRAME_CAPS = { quick: 12, standard: 32, deep: 96 };

/** The steps, in the order they run. Every one of them is in the receipt. */
const STEPS = ['probe', 'keyframes', 'transcript', 'describe', 'analyse', 'explicit', 'report'];

/** A keyframe: when it was taken, where its JPEG is, what is shown in it and the text on screen. */
const KEYFRAME = {
    type: 'object', additionalProperties: false, required: ['t', 'url', 'caption', 'text'],
    properties: { t: NUM, url: STR(2048), caption: STR(1200), text: STR(1200) },
};

/** One spoken word, with the times it was said. */
const WORD = {
    type: 'object', additionalProperties: false, required: ['t0', 't1', 'w'],
    properties: { t0: NUM, t1: NUM, w: STR(200) },
};

/** One chapter of the video. */
const CHAPTER = {
    type: 'object', additionalProperties: false, required: ['start', 'end', 'title'],
    properties: { start: NUM, end: NUM, title: STR(200) },
};

/** A person, object or place that was named, with where it was seen or said. */
const ENTITY = {
    type: 'object', additionalProperties: false, required: ['name', 'kind', 'evidence'],
    properties: {
        name: STR(200), kind: { enum: ['person', 'object', 'place', 'organization', 'other'] },
        evidence: {
            type: 'array', maxItems: 20,
            items: {
                type: 'object', additionalProperties: false, required: ['t', 'from'],
                properties: { t: NUM, from: { enum: ['frame', 'speech'] } },
            },
        },
    },
};

/** What ffprobe measured. Nothing here is guessed: a stream that is not there is null. */
const PROBE = {
    type: 'object', additionalProperties: false, required: ['duration_s', 'size_bytes', 'video', 'audio'],
    properties: {
        duration_s: NUM, size_bytes: NUM,
        video: {
            type: ['object', 'null'], additionalProperties: false, required: ['codec', 'width', 'height', 'fps', 'rotation'],
            properties: { codec: STR(40), width: { type: 'integer', minimum: 0 }, height: { type: 'integer', minimum: 0 }, fps: NUM, rotation: { type: 'integer', minimum: -360, maximum: 360 } },
        },
        audio: {
            type: ['object', 'null'], additionalProperties: false, required: ['codec', 'sample_rate', 'channels'],
            properties: { codec: STR(40), sample_rate: { type: 'integer', minimum: 0 }, channels: { type: 'integer', minimum: 0 } },
        },
    },
};

/** One step of the run, in the receipt. A step that failed says so; nothing is filled in. */
const STEP_RECEIPT = {
    type: 'object', additionalProperties: false, required: ['key', 'status'],
    properties: {
        key: { enum: STEPS }, status: { enum: ['done', 'skipped', 'failed'] },
        detail: NULLABLE(300), cost_usd: { type: 'number', minimum: 0 }, ms: { type: 'integer', minimum: 0 },
    },
};

/** One model call, in the receipt. */
const MODEL_RECEIPT = {
    type: 'object', additionalProperties: false, required: ['step', 'provider', 'model', 'tokens_in', 'tokens_out', 'cost_usd'],
    properties: {
        step: { enum: ['describe', 'analyse', 'explicit'] }, provider: NULLABLE(80), model: NULLABLE(200),
        tokens_in: { type: 'integer', minimum: 0 }, tokens_out: { type: 'integer', minimum: 0 }, cost_usd: { type: 'number', minimum: 0 },
    },
};

const RECEIPT = {
    type: 'object', additionalProperties: false, required: ['steps', 'models', 'cost_usd'],
    properties: {
        steps: { type: 'array', maxItems: 16, items: STEP_RECEIPT },
        models: { type: 'array', maxItems: 400, items: MODEL_RECEIPT },
        cost_usd: { type: 'number', minimum: 0 },
    },
};

/** The published document: ai.video-analysis@1. */
const REPORT = {
    type: 'object', additionalProperties: false,
    required: ['media_id', 'duration_s', 'probe', 'keyframes', 'transcript', 'chapters', 'summary', 'entities', 'tags', 'explicit', 'receipt'],
    properties: {
        media_id: { type: ['string', 'null'], pattern: '^med_[0-9A-HJKMNP-TV-Z]{26}$' },
        duration_s: NUM,
        probe: PROBE,
        keyframes: { type: 'array', maxItems: 200, items: KEYFRAME },
        transcript: {
            type: 'object', additionalProperties: false, required: ['lang', 'words', 'text'],
            properties: {
                lang: STR(8),
                words: { type: 'array', maxItems: 20000, items: WORD },
                text: { type: 'string', maxLength: 200000 },
            },
        },
        chapters: { type: 'array', maxItems: 60, items: CHAPTER },
        summary: STR(6000),
        entities: { type: 'array', maxItems: 120, items: ENTITY },
        tags: { type: 'array', maxItems: 40, items: STR(60) },
        answer: { type: 'string', maxLength: 4000 },
        explicit: {
            type: 'object', additionalProperties: false, required: ['category', 'reason'],
            properties: { category: { enum: ['fine', 'sex_acts', 'minor_sexual'] }, reason: STR(300) },
        },
        receipt: RECEIPT,
    },
};

/** The workflow's input: one video the requester may read, a depth, and a question. */
const INPUT_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['depth'],
    anyOf: [{ required: ['media_id'] }, { required: ['attachment_id'] }, { required: ['url'] }],
    properties: {
        media_id: { type: 'string', pattern: '^med_[0-9A-HJKMNP-TV-Z]{26}$' },
        attachment_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{6,80}$' },
        url: { type: 'string', maxLength: 2048, pattern: '^https?://' },
        depth: { enum: DEPTHS },
        ask: { type: 'string', maxLength: 500 },
        language: { type: 'string', pattern: '^(auto|[a-z]{2})$' },
    },
};

/** The vision route's answer about one frame: what is shown, and the text on screen. */
const FRAME_OUTPUT = {
    type: 'object', additionalProperties: true, required: ['caption'],
    properties: {
        caption: STR(1200),
        text: STR(1200),
        people: { type: 'array', maxItems: 20, items: STR(200) },
        objects: { type: 'array', maxItems: 30, items: STR(200) },
        places: { type: 'array', maxItems: 20, items: STR(200) },
        explicit: { enum: ['fine', 'sex_acts', 'minor_sexual'] },
    },
};

/** The one model call that writes the chapters, the summary, the entities, the tags and the answer. */
const ANALYSIS_OUTPUT = {
    type: 'object', additionalProperties: true,
    required: ['summary', 'chapters', 'entities', 'tags'],
    properties: {
        summary: STR(6000),
        chapters: {
            type: 'array', maxItems: 60,
            items: {
                type: 'object', additionalProperties: true, required: ['start', 'end', 'title'],
                properties: { start: NUM, end: NUM, title: STR(200) },
            },
        },
        entities: {
            type: 'array', maxItems: 120,
            items: {
                type: 'object', additionalProperties: true, required: ['name', 'kind', 'evidence'],
                properties: {
                    name: STR(200), kind: { enum: ['person', 'object', 'place', 'organization', 'other'] },
                    evidence: {
                        type: 'array', maxItems: 20,
                        items: { type: 'object', additionalProperties: true, required: ['t', 'from'], properties: { t: NUM, from: { enum: ['frame', 'speech'] } } },
                    },
                },
            },
        },
        tags: { type: 'array', maxItems: 40, items: STR(60) },
        answer: { type: 'string', maxLength: 4000 },
    },
};

module.exports = { DEPTHS, FRAME_CAPS, STEPS, KEYFRAME, WORD, CHAPTER, ENTITY, PROBE, RECEIPT, REPORT, INPUT_SCHEMA, FRAME_OUTPUT, ANALYSIS_OUTPUT };
