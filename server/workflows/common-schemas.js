'use strict';
/** JSON Schema fragments shared by the seeded workflow definitions. */

const MEDIA_REF = {
    type: 'object', additionalProperties: false, required: ['media_id'],
    properties: {
        media_id: { type: 'string', pattern: '^(med_[0-9A-HJKMNP-TV-Z]{26}|legacy:[a-z][a-z0-9-]{1,39}:(vod|clip|file|paste|thumbnail|avatar):[A-Za-z0-9._/-]{1,200})$' },
        role: { type: 'string' }, variant: { type: 'string' },
    },
};

/** An image by allow-listed URL, inline data URL, or MediaRef. */
const IMAGE = {
    type: 'object', additionalProperties: false, minProperties: 1,
    properties: {
        url: { type: 'string', maxLength: 2048 },
        data_url: { type: 'string', maxLength: 16000000 },
        media: MEDIA_REF,
        max_width: { type: 'integer', minimum: 64, maximum: 2048 },
    },
};

const SOURCE = {
    type: 'object', additionalProperties: false, required: ['source_type'],
    properties: {
        source_type: { type: 'string', pattern: '^[a-z][a-z0-9_.-]{1,63}$' },
        source_id: { type: 'string', maxLength: 256 },
        url: { type: 'string', maxLength: 2048 },
        title: { type: 'string', maxLength: 500 },
        author: { type: 'string', maxLength: 200 },
        published_at: { type: 'string', maxLength: 40 },
        retrieved_at: { type: 'string', maxLength: 40 },
        observed_at: { type: 'string', maxLength: 40 },
        snippet: { type: 'string', maxLength: 4000 },
        content: { type: 'string', maxLength: 20000 },
        trust: { type: 'object' },
        provenance: { type: 'object' },
    },
};
const SOURCES = (min = 0, max = 50) => ({ type: 'array', minItems: min, maxItems: max, items: SOURCE });

/** citations: indices into input.sources (the engine narrows the bounds per run). */
const CITES = { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: 50 };
const GAPS = { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 20, description: 'what the sources do not support' };

module.exports = { MEDIA_REF, IMAGE, SOURCE, SOURCES, CITES, GAPS };
