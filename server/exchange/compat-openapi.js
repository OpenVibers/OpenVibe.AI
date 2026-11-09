'use strict';
const provider = { type: 'object', additionalProperties: false, properties: {
    ...Object.fromEntries(['order', 'only', 'ignore'].map(k => [k, { type: 'array', maxItems: 64, items: { type: 'string' } }])),
    allow_fallbacks: { type: 'boolean' }, sort: { enum: ['price', 'throughput', 'latency', 'quality', 'value'] },
    max_price: { type: 'object', additionalProperties: false, description: 'USD per million tokens; unknown prices fail the cap.', properties: { prompt: { type: 'number', minimum: 0 }, completion: { type: 'number', minimum: 0 } } },
    data_collection: { enum: ['allow', 'deny'] }, zdr: { type: 'boolean' },
} };
const properties = { model: { type: 'string', description: 'maker/model, @preset/name, or model suffix :free, :floor, :nitro.' },
    models: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' }, description: 'Ordered model fallbacks in the same run and hold.' },
    provider, usage: { type: 'object', properties: { include: { type: 'boolean' } } },
};
const operation = (operationId, summary, props, required = []) => ({ operationId, summary, tags: ['exchange'], security: [{ bearer: [] }],
    parameters: [{ in: 'header', name: 'Idempotency-Key', schema: { type: 'string' }, description: 'Owner-scoped replay; changed input or endpoint conflicts.' }],
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: props, required } } } },
    responses: { 200: { description: 'Provider result, token usage and x_openvibe accounting. usage.include adds cost (USD), latency (milliseconds), and provider.' }, 400: { description: 'Invalid request' }, 401: { description: 'Invalid or expired key' }, 403: { description: 'Model outside key scope' }, 409: { description: 'Idempotency conflict' }, 429: { description: 'Key cap reached' }, 503: { description: 'No eligible provider' } },
});
const paths = {
    '/v1/models': { get: { operationId: 'compatModels', summary: 'Catalogue models with OpenRouter pricing and context fields', tags: ['exchange'], security: [{ bearer: [] }], responses: { 200: { description: 'data model entries: id, name, pricing (USD per token strings), context_length, architecture, top_provider. Anthropic header selects Anthropic format. Catalogue flag off retains the virtual model.' } } } },
    '/v1/chat/completions': { post: operation('compatChatCompletions', 'Chat completion with provider routing', { ...properties, messages: { type: 'array', items: { type: 'object' } }, stream: { type: 'boolean' } }, ['messages']) },
    '/v1/messages': { post: operation('compatMessages', 'Anthropic Messages with provider routing', { ...properties, messages: { type: 'array', items: { type: 'object' } }, max_tokens: { type: 'integer', minimum: 1 }, stream: { type: 'boolean' } }, ['messages', 'max_tokens']) },
    '/v1/completions': { post: operation('compatCompletions', 'Legacy string-prompt completion', { ...properties, prompt: { type: 'string', minLength: 1 }, stream: { type: 'boolean' } }, ['prompt']) },
    '/v1/embeddings': { post: operation('compatEmbeddings', 'Float embeddings from a registered provider', { ...properties, input: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, encoding_format: { const: 'float' } }, ['input']) },
    '/v1/images/generations': { post: operation('compatImageGeneration', 'Image generation when an image route is configured', { ...properties, prompt: { type: 'string' }, n: { type: 'integer', minimum: 1, maximum: 4 }, size: { type: 'string' } }, ['prompt']) },
    '/v1/generation': { get: { operationId: 'compatGeneration', summary: 'Read accounting for your own generation', tags: ['exchange'], security: [{ bearer: [] }], parameters: [{ in: 'query', name: 'id', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'data: id, model, provider, cost, total_cost (USD), latency (ms), tokens_prompt, tokens_completion, created_at. No prompt or output.' }, 404: { description: 'Missing or owned by another requester' } } } },
    '/v1/presets/import': { post: operation('compatPresetImport', 'Save a validated request preset for the signed-in person', { ...properties, name: { type: 'string' }, system: { type: 'string' }, temperature: { type: 'number' }, top_p: { type: 'number' }, max_tokens: { type: 'integer' } }, ['name']) },
};
module.exports = { paths, provider };
