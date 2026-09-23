'use strict';
/**
 * The direct operations (POST /api/v1/{chat,generate,summarize,classify,extract,enrich,embed}).
 * Each one IS a workflow (ai.<op>) so a direct call gets the same run record, quota, cache, audit
 * and attribution as any product workflow — the convenience routes are thin, not a second engine.
 */
const { PASSTHROUGH_OUTPUT } = require('./live');

const STR = (n) => ({ type: 'string', maxLength: n });
const OBJ = (props, required = []) => ({ type: 'object', additionalProperties: false, required, properties: props });
const COMMON = { max_tokens: { type: 'integer', minimum: 1, maximum: 16000 }, temperature: { type: ['number', 'null'], minimum: 0, maximum: 2 } };

const templates = [
    {
        key: 'ai.generate', name: 'Generate text', input_schema: { type: 'object' }, output_schema: { type: 'object' },
        system_prompt: '{{system}}', user_prompt: '{{prompt}}', default_route: 'default.chat',
    },
    {
        key: 'ai.summarize', name: 'Summarize text', input_schema: { type: 'object' }, output_schema: { type: 'object' },
        system_prompt: 'You summarize text faithfully and plainly. Never add facts, names, numbers or claims that are not in the text.',
        user_prompt: 'Summarize the following{{#style}} ({{style}}){{/style}} in at most {{max_words}} words.\n\n---\n{{text}}',
        default_route: 'default.chat',
    },
    {
        key: 'ai.classify', name: 'Classify text into given labels', input_schema: { type: 'object' }, output_schema: { type: 'object' },
        system_prompt: 'You classify text into exactly one of the given labels. If none fits, choose the closest and give a low confidence. Output only JSON.',
        user_prompt: 'Labels: {{json labels}}{{#instructions}}\nInstructions: {{instructions}}{{/instructions}}\n\nText:\n{{text}}',
        default_route: 'default.json', metadata: { json_name: 'classification' },
    },
    {
        key: 'ai.extract', name: 'Extract structured data', input_schema: { type: 'object' }, output_schema: { type: 'object' },
        system_prompt: 'You extract structured data from text. Use only what the text states; use null for anything it does not state. Never guess. Output only JSON matching the schema.',
        user_prompt: '{{#instructions}}Instructions: {{instructions}}\n\n{{/instructions}}Text:\n{{text}}',
        default_route: 'default.json', metadata: { json_name: 'extraction' },
    },
    {
        key: 'ai.enrich', name: 'Enrich a record', input_schema: { type: 'object' }, output_schema: { type: 'object' },
        system_prompt: 'You enrich a record by normalising and filling fields that follow directly from the record itself. Never invent facts that are not derivable from the record; leave them null and say so in notes. Output only JSON.',
        user_prompt: 'Instructions: {{instructions}}\n\nRecord:\n{{json record}}',
        default_route: 'default.json', metadata: { json_name: 'enrichment' },
    },
];

const workflows = [
    {
        key: 'ai.chat', name: 'Chat completion', namespace: 'ai',
        input_schema: OBJ({ system: STR(200000), messages: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', required: ['role', 'content'], properties: { role: { enum: ['user', 'assistant'] }, content: STR(200000) } } }, ...COMMON }, ['messages']),
        output_schema: PASSTHROUGH_OUTPUT,
        steps: [{ kind: 'passthrough', route: 'default.chat' }], cache_mode: 'none',
    },
    {
        key: 'ai.generate', name: 'Generate text', namespace: 'ai',
        input_schema: OBJ({ prompt: STR(200000), system: STR(200000), ...COMMON }, ['prompt']),
        output_schema: OBJ({ text: { type: 'string' } }, ['text']),
        steps: [{ kind: 'llm', template: 'ai.generate', operation: 'generate', output: 'text', wrap: 'text', params: { max_tokens: 800 } }], cache_mode: 'private',
    },
    {
        key: 'ai.summarize', name: 'Summarize text', namespace: 'ai',
        input_schema: OBJ({ text: STR(400000), max_words: { type: 'integer', minimum: 10, maximum: 2000 }, style: STR(100), ...COMMON }, ['text']),
        output_schema: OBJ({ summary: { type: 'string' } }, ['summary']),
        steps: [{ kind: 'llm', template: 'ai.summarize', operation: 'summarize', output: 'text', wrap: 'summary', prepare: 'ai.summarize', params: { max_tokens: 600, temperature: 0.2 } }], cache_mode: 'private',
    },
    {
        key: 'ai.classify', name: 'Classify text', namespace: 'ai',
        input_schema: OBJ({ text: STR(100000), labels: { type: 'array', minItems: 2, maxItems: 50, items: STR(80), uniqueItems: true }, instructions: STR(2000), ...COMMON }, ['text', 'labels']),
        output_schema: OBJ({ label: STR(80), confidence: { type: 'number', minimum: 0, maximum: 1 }, rationale: STR(1000) }, ['label', 'confidence']),
        steps: [{ kind: 'llm', template: 'ai.classify', operation: 'classify', output: 'json', prepare: 'ai.classify', postprocess: 'ai.classify', params: { max_tokens: 200, temperature: 0 } }], cache_mode: 'private',
    },
    {
        key: 'ai.extract', name: 'Extract structured data', namespace: 'ai',
        input_schema: OBJ({ text: STR(200000), schema: { type: 'object' }, instructions: STR(2000), ...COMMON }, ['text', 'schema']),
        output_schema: OBJ({ data: {} }, ['data']),
        steps: [{ kind: 'llm', template: 'ai.extract', operation: 'extract', output: 'json', wrap: 'data', prepare: 'ai.extract', params: { max_tokens: 1200, temperature: 0 } }], cache_mode: 'private',
    },
    {
        key: 'ai.enrich', name: 'Enrich a record', namespace: 'ai',
        input_schema: OBJ({ record: { type: 'object' }, instructions: STR(4000), schema: { type: 'object' }, ...COMMON }, ['record', 'instructions']),
        output_schema: OBJ({ data: { type: 'object' }, notes: { type: 'array', items: { type: 'string' } } }, ['data']),
        steps: [{ kind: 'llm', template: 'ai.enrich', operation: 'enrich', output: 'json', prepare: 'ai.enrich', params: { max_tokens: 1200, temperature: 0.2 } }], cache_mode: 'private',
    },
    {
        key: 'ai.embed', name: 'Embed text', namespace: 'ai',
        input_schema: OBJ({ input: { anyOf: [STR(32000), { type: 'array', minItems: 1, maxItems: 64, items: STR(32000) }] } }, ['input']),
        output_schema: OBJ({ vectors: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, dimensions: { type: 'integer' } }, ['vectors', 'dimensions']),
        steps: [{ kind: 'embed', route: 'default.embedding' }], cache_mode: 'private',
    },
];

module.exports = { templates, workflows };
