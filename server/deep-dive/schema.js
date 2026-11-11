'use strict';
/**
 * The shapes a deep dive runs on.
 *
 * The published document is ai.deep-dive@1 (OpenVibe.Contracts): the question, the seven steps, every source,
 * every capture, the per-site analysis, the synthesis, the recommendations and the receipt, with an evidence
 * list on every claim. This module holds the workflow's input and output schema and the four JSON shapes an
 * intermediate model call answers in (plan, choose, one site's analysis, the synthesis). They are deliberately
 * smaller than the report: the report is assembled here, from what was actually read and captured, so a model
 * cannot invent a capture id, a URL that was not visited, or a media object.
 */

const STR = (n) => ({ type: 'string', maxLength: n });
const NULLABLE = (n) => ({ type: ['string', 'null'], maxLength: n });
const STEPS = ['plan', 'search', 'choose', 'capture', 'analyse', 'synthesise', 'report'];
const DEPTHS = ['quick', 'thorough', 'expert'];

const EVIDENCE = {
    type: 'array', maxItems: 20,
    items: {
        type: 'object', additionalProperties: false, required: ['claim', 'url', 'read_at'],
        properties: {
            claim: STR(600), source_id: { type: ['string', 'null'], maxLength: 40 },
            capture_id: { type: ['string', 'null'], maxLength: 40 }, crop_id: { type: ['string', 'null'], maxLength: 40 },
            url: STR(2048), read_at: STR(40),
        },
    },
};

const SOURCE = {
    type: 'object', additionalProperties: false, required: ['id', 'kind', 'title', 'url', 'read_at'],
    properties: {
        id: STR(40), kind: { enum: ['web', 'picture', 'icon', 'project', 'rules', 'component', 'named'] },
        title: STR(400), url: STR(2048), publisher: NULLABLE(200), engine: NULLABLE(80),
        snippet: NULLABLE(2000), license: NULLABLE(120), read_at: STR(40),
    },
};

const CROP = {
    type: 'object', additionalProperties: false, required: ['id', 'media_id', 'y', 'height'],
    properties: { id: STR(40), media_id: { type: 'string', pattern: '^med_[0-9A-HJKMNP-TV-Z]{26}$' }, y: { type: 'integer', minimum: 0 }, height: { type: 'integer', minimum: 1 } },
};

const CAPTURE = {
    type: 'object', additionalProperties: false,
    required: ['id', 'source_id', 'url', 'captured_at', 'viewport', 'theme', 'full_page', 'crops'],
    properties: {
        id: STR(40), source_id: STR(40), url: STR(2048), final_url: { type: ['string', 'null'], maxLength: 2048 },
        title: NULLABLE(400), captured_at: STR(40), viewport: { enum: [390, 1280] }, theme: { enum: ['light', 'dark'] },
        full_page: { type: 'boolean' }, media_id: { type: ['string', 'null'], pattern: '^med_[0-9A-HJKMNP-TV-Z]{26}$' },
        width: { type: ['integer', 'null'], minimum: 1 }, height: { type: ['integer', 'null'], minimum: 1 },
        crops: { type: 'array', maxItems: 8, items: CROP },
        dom: { type: ['object', 'null'] }, extras: { type: ['object', 'null'] },
        skip: { type: ['string', 'null'], maxLength: 200 }, cached: { type: 'boolean' },
    },
};

const ANALYSIS = {
    type: 'object', additionalProperties: false,
    required: ['source_id', 'url', 'summary', 'strengths', 'weaknesses', 'evidence'],
    properties: {
        source_id: STR(40), url: STR(2048), summary: STR(4000), first_impression: STR(2000), hierarchy: STR(2000),
        density: STR(2000), type: STR(2000), colour: STR(2000), motion: STR(2000), words: STR(2000),
        strengths: { type: 'array', maxItems: 12, items: STR(600) },
        weaknesses: { type: 'array', maxItems: 12, items: STR(600) },
        accessibility: NULLABLE(2000), speed: NULLABLE(2000), evidence: EVIDENCE,
    },
};

const EVIDENCE_CLAIM = {
    type: 'array', maxItems: 20,
    items: {
        type: 'object', additionalProperties: false, required: ['claim', 'site'],
        properties: { claim: STR(600), site: { type: 'integer', minimum: 1, maximum: 30 }, capture: { type: ['integer', 'null'], minimum: 1, maximum: 400 } },
    },
};

const PATTERN_OUT = {
    type: 'object', additionalProperties: false, required: ['name', 'what', 'sites', 'evidence'],
    properties: {
        name: STR(160), what: STR(1200),
        sites: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 40 } },
        usage_count: { type: 'integer', minimum: 0, maximum: 30 },
        evidence: EVIDENCE_CLAIM,
    },
};

const RECOMMENDATION_OUT = {
    type: 'object', additionalProperties: false, required: ['what', 'why', 'rule', 'evidence'],
    properties: {
        what: STR(1200), why: STR(2000),
        rule: {
            type: 'object', additionalProperties: false, required: ['status', 'text'],
            properties: { id: { type: ['string', 'null'], maxLength: 120 }, status: { enum: ['follows', 'would_change', 'none'] }, text: STR(600) },
        },
        evidence: EVIDENCE_CLAIM,
    },
};

/** The LLM steps' JSON. Each is one call; a wrong shape fails the run rather than filling anything in. */
const PLAN_OUTPUT = {
    type: 'object', additionalProperties: true, required: ['questions', 'searches'],
    properties: {
        questions: { type: 'array', minItems: 3, maxItems: 12, items: { type: 'object', additionalProperties: true, required: ['key', 'question'], properties: { key: STR(40), question: STR(400) } } },
        searches: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', additionalProperties: true, required: ['q'], properties: { q: STR(400), kind: { enum: ['web', 'images', 'icons', 'projects'] } } } },
    },
};

const CHOOSE_OUTPUT = {
    type: 'object', additionalProperties: true, required: ['sites'],
    properties: {
        sites: {
            type: 'array', minItems: 1, maxItems: 30,
            items: { type: 'object', additionalProperties: true, required: ['url', 'reason'], properties: { url: STR(2048), reason: STR(600), kind: STR(40) } },
        },
    },
};

const ANALYSIS_OUTPUT = {
    type: 'object', additionalProperties: true, required: ['summary', 'strengths', 'weaknesses'],
    properties: {
        summary: STR(4000), first_impression: STR(2000), hierarchy: STR(2000), density: STR(2000), type: STR(2000),
        colour: STR(2000), motion: STR(2000), words: STR(2000), accessibility: NULLABLE(2000), speed: NULLABLE(2000),
        strengths: { type: 'array', maxItems: 12, items: STR(600) },
        weaknesses: { type: 'array', maxItems: 12, items: STR(600) },
        evidence: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: true, required: ['claim'], properties: { claim: STR(600), shot: { type: ['integer', 'null'], minimum: 1 } } } },
    },
};

const SYNTHESIS_OUTPUT = {
    type: 'object', additionalProperties: true,
    required: ['patterns', 'comparison', 'best', 'mistakes', 'gap', 'reference_tokens', 'do', 'dont', 'accessibility', 'speed', 'recommendations'],
    properties: {
        patterns: { type: 'array', maxItems: 40, items: PATTERN_OUT },
        comparison: {
            type: 'object', additionalProperties: true, required: ['columns', 'rows'],
            properties: { columns: { type: 'array', maxItems: 12, items: STR(120) }, rows: { type: 'array', maxItems: 30, items: { type: 'array', maxItems: 12, items: STR(1000) } } },
        },
        best: { type: 'object', additionalProperties: true, required: ['site', 'what'], properties: { site: { type: 'integer', minimum: 1, maximum: 30 }, what: STR(2000), evidence: EVIDENCE_CLAIM } },
        mistakes: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: true, required: ['what'], properties: { what: STR(1200), evidence: EVIDENCE_CLAIM } } },
        gap: STR(2000),
        reference_tokens: {
            type: 'object', additionalProperties: true, required: ['palettes', 'type_scales', 'spacing'],
            properties: {
                palettes: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: true, required: ['site', 'colours'], properties: { site: { type: 'integer', minimum: 1 }, colours: { type: 'array', maxItems: 16, items: STR(40) } } } },
                type_scales: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: true, required: ['site', 'families', 'sizes'], properties: { site: { type: 'integer', minimum: 1 }, families: { type: 'array', maxItems: 8, items: STR(120) }, sizes: { type: 'array', maxItems: 16, items: STR(40) } } } },
                spacing: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: true, required: ['site', 'steps'], properties: { site: { type: 'integer', minimum: 1 }, steps: { type: 'array', maxItems: 16, items: STR(40) } } } },
            },
        },
        do: { type: 'array', maxItems: 20, items: STR(600) },
        dont: { type: 'array', maxItems: 20, items: STR(600) },
        accessibility: { type: 'array', maxItems: 20, items: STR(600) },
        speed: { type: 'array', maxItems: 20, items: STR(600) },
        recommendations: { type: 'array', minItems: 1, maxItems: 20, items: RECOMMENDATION_OUT },
    },
};

const REPORT = {
    type: 'object', additionalProperties: false,
    required: ['id', 'schema', 'run_id', 'status', 'input', 'steps', 'sources', 'captures', 'analysis', 'synthesis', 'recommendations', 'receipt', 'gaps', 'created_at', 'updated_at'],
    properties: {
        id: STR(40), schema: { const: 'ai.deep-dive@1' }, run_id: STR(40),
        status: { enum: ['queued', 'running', 'choosing', 'succeeded', 'failed', 'cancelled'] },
        input: {
            type: 'object', additionalProperties: false, required: ['question', 'depth', 'max_sites'],
            properties: { question: STR(500), depth: { enum: DEPTHS }, max_sites: { type: 'integer', minimum: 1, maximum: 30 }, sites: { type: 'array', maxItems: 30, items: STR(2048) } },
        },
        steps: {
            type: 'array', maxItems: 7,
            items: {
                type: 'object', additionalProperties: false, required: ['key', 'status'],
                properties: { key: { enum: STEPS }, status: { enum: ['pending', 'running', 'done', 'skipped', 'failed'] }, detail: NULLABLE(300), started_at: { type: ['string', 'null'] }, finished_at: { type: ['string', 'null'] } },
            },
        },
        sources: { type: 'array', maxItems: 200, items: SOURCE },
        captures: { type: 'array', maxItems: 400, items: CAPTURE },
        analysis: { type: 'array', maxItems: 30, items: ANALYSIS },
        synthesis: {
            type: 'object', additionalProperties: false,
            required: ['patterns', 'comparison', 'best', 'mistakes', 'gap', 'reference_tokens', 'do', 'dont', 'accessibility', 'speed'],
            properties: {
                patterns: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: false, required: ['name', 'what', 'sites', 'evidence'], properties: { name: STR(160), what: STR(1200), sites: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 40 } }, usage_count: { type: 'integer', minimum: 0, maximum: 30 }, evidence: EVIDENCE } } },
                comparison: { type: 'object', additionalProperties: false, required: ['columns', 'rows'], properties: { columns: { type: 'array', maxItems: 12, items: STR(120) }, rows: { type: 'array', maxItems: 30, items: { type: 'array', maxItems: 12, items: STR(1000) } } } },
                best: { type: 'object', additionalProperties: false, required: ['source_id', 'what', 'evidence'], properties: { source_id: STR(40), what: STR(2000), evidence: EVIDENCE } },
                mistakes: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['what', 'evidence'], properties: { what: STR(1200), evidence: EVIDENCE } } },
                gap: STR(2000),
                reference_tokens: {
                    type: 'object', additionalProperties: false, required: ['palettes', 'type_scales', 'spacing'],
                    properties: {
                        palettes: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['source_id', 'colours'], properties: { source_id: STR(40), colours: { type: 'array', maxItems: 16, items: STR(40) } } } },
                        type_scales: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['source_id', 'families', 'sizes'], properties: { source_id: STR(40), families: { type: 'array', maxItems: 8, items: STR(120) }, sizes: { type: 'array', maxItems: 16, items: STR(40) } } } },
                        spacing: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['source_id', 'steps'], properties: { source_id: STR(40), steps: { type: 'array', maxItems: 16, items: STR(40) } } } },
                    },
                },
                do: { type: 'array', maxItems: 20, items: STR(600) },
                dont: { type: 'array', maxItems: 20, items: STR(600) },
                accessibility: { type: 'array', maxItems: 20, items: STR(600) },
                speed: { type: 'array', maxItems: 20, items: STR(600) },
            },
        },
        recommendations: {
            type: 'array', maxItems: 20,
            items: {
                type: 'object', additionalProperties: false, required: ['id', 'what', 'why', 'rule', 'evidence'],
                properties: {
                    id: STR(40), what: STR(1200), why: STR(2000),
                    rule: { type: 'object', additionalProperties: false, required: ['status', 'text'], properties: { id: { type: ['string', 'null'], maxLength: 120 }, status: { enum: ['follows', 'would_change', 'none'] }, text: STR(600) } },
                    evidence: EVIDENCE,
                },
            },
        },
        receipt: {
            type: 'object', additionalProperties: false, required: ['price_usd', 'held_usd', 'cost_usd', 'models', 'captures_count', 'synthetic'],
            properties: {
                price_usd: { type: 'number', minimum: 0 }, held_usd: { type: 'number', minimum: 0 }, cost_usd: { type: 'number', minimum: 0 },
                captures_count: { type: 'integer', minimum: 0 }, synthetic: { type: 'boolean' },
                models: {
                    type: 'array', maxItems: 500,
                    items: { type: 'object', additionalProperties: false, required: ['step', 'provider', 'model', 'tokens_in', 'tokens_out', 'cost_usd', 'ms'], properties: {
                        step: { enum: ['plan', 'choose', 'analyse', 'synthesise'] }, provider: NULLABLE(80), model: NULLABLE(200),
                        tokens_in: { type: 'integer', minimum: 0 }, tokens_out: { type: 'integer', minimum: 0 }, cost_usd: { type: 'number', minimum: 0 }, ms: { type: 'integer', minimum: 0 },
                    } },
                },
            },
        },
        gaps: { type: 'array', maxItems: 40, items: STR(400) },
        created_at: STR(40), updated_at: STR(40), finished_at: { type: ['string', 'null'] },
    },
};

const INPUT_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['question', 'depth'],
    properties: {
        question: { type: 'string', minLength: 1, maxLength: 500 }, depth: { enum: DEPTHS },
        sites: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 2048, pattern: '^https?://' } },
    },
};

module.exports = { DEPTHS, STEPS, EVIDENCE, REPORT, INPUT_SCHEMA, PLAN_OUTPUT, CHOOSE_OUTPUT, ANALYSIS_OUTPUT, SYNTHESIS_OUTPUT };
