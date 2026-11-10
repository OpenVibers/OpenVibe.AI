'use strict';

const STR = (n) => ({ type: 'string', maxLength: n });
const template = {
    key: 'meme.caption', name: 'Meme: caption ideas', owner: 'meme', visibility: 'internal',
    description: 'Write a few original, short caption ideas for a known meme format.',
    input_schema: { type: 'object', additionalProperties: false, required: ['format', 'topic'], properties: { format: STR(120), topic: STR(300) } },
    output_schema: { type: 'object', additionalProperties: false, required: ['ideas'], properties: { ideas: { type: 'array', minItems: 3, maxItems: 5, items: STR(480) } } },
    system_prompt: 'You write original meme captions. Never quote a known meme, copy a template caption, use hateful slurs, or invent factual claims. Keep each idea short, varied, and safe for a general audience. Return three to five distinct caption ideas as JSON.',
    user_prompt: 'Meme format: {{format}}\nTopic or situation: {{topic}}\n\nWrite three to five original caption ideas. Each idea may use up to four short lines separated by a newline. Return JSON with an ideas array only.',
    default_route: 'meme.caption', metadata: { json_name: 'ideas' },
};
const workflow = {
    key: 'meme.caption', name: 'Original meme caption ideas', namespace: 'meme', owner: 'meme',
    description: 'Generate a handful of original, short caption ideas for a selected meme template.',
    input_schema: template.input_schema, output_schema: template.output_schema, default_route: 'meme.caption',
    steps: [{ kind: 'llm', template: 'meme.caption', operation: 'generate', output: 'json', params: { max_tokens: 700, temperature: 0.85 } }],
    metadata: {
        creation: {
            id: 'meme-caption', product: 'meme', name: 'Write meme caption ideas', workflow: 'meme.caption',
            gives: 'A meme format and the situation you want to joke about.',
            returns: 'Three to five original caption ideas for that format.',
            access: { guest: false, signed_in: true, floor_18: false }, costs_coins: true,
            start_url: 'https://openvibe.meme/',
        },
    },
};

module.exports = { templates: [template], workflows: [workflow] };
