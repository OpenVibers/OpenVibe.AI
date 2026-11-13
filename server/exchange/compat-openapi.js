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
    '/v1/models': { get: { operationId: 'compatModels', summary: 'Catalogue models with OpenRouter pricing and context fields', tags: ['exchange'], security: [{ bearer: [] }], responses: { 200: { description: 'data model entries: id, name, pricing (USD per token strings), context_length, architecture, top_provider, and features: { tools, structured_output, vision, audio_in, audio_out, reasoning_effort, prompt_caching, logprobs, streaming, batch, realtime, files }. A feature is true or false only when the registry model and provider metadata say so; unknown is null. Anthropic header selects Anthropic format. Catalogue flag off retains the virtual model.' } } } },
    '/v1/chat/completions': { post: operation('compatChatCompletions', 'Chat completion with provider routing', { ...properties, messages: { type: 'array', items: { type: 'object' } }, stream: { type: 'boolean' } }, ['messages']) },
    '/v1/messages': { post: operation('compatMessages', 'Anthropic Messages with provider routing', { ...properties, messages: { type: 'array', items: { type: 'object' } }, max_tokens: { type: 'integer', minimum: 1 }, stream: { type: 'boolean' } }, ['messages', 'max_tokens']) },
    '/v1/completions': { post: operation('compatCompletions', 'Legacy string-prompt completion', { ...properties, prompt: { type: 'string', minLength: 1 }, stream: { type: 'boolean' } }, ['prompt']) },
    '/v1/embeddings': { post: operation('compatEmbeddings', 'Float embeddings from a registered provider', { ...properties, input: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, encoding_format: { const: 'float' } }, ['input']) },
    '/v1/images/generations': { post: operation('compatImageGeneration', 'Image generation on configured non-metered capacity; paid image accounting is not yet supported', { ...properties, prompt: { type: 'string' }, n: { type: 'integer', minimum: 1, maximum: 4 }, size: { type: 'string' } }, ['prompt']) },
    '/v1/audio/transcriptions': { post: { operationId: 'compatTranscriptions', summary: 'Speech-to-text through the router\'s transcribe route', tags: ['exchange'], security: [{ bearer: [] }],
        parameters: [{ in: 'header', name: 'Idempotency-Key', schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file', 'model'], properties: {
            file: { type: 'string', format: 'binary', description: 'Audio to transcribe: mp3, mp4, mpeg, mpga, m4a, wav, webm, ogg or flac, at most 3 MB.' },
            model: { type: 'string', description: 'A transcription model id. The router\'s live.stt route picks the provider and model that run; the answer names it.' },
            language: { type: 'string', description: 'ISO-639-1 language, or auto.' }, prompt: { type: 'string', maxLength: 1000, description: 'An initial prompt for the transcriber.' },
            response_format: { enum: ['json', 'text', 'verbose_json'], default: 'json' }, temperature: { type: 'number', minimum: 0, maximum: 1 },
            max_cost_usd: { type: 'number', minimum: 0, description: 'The caller liability cap for the Balance hold.' },
        } } } } },
        responses: { 200: { description: 'json: { text, usage, x_openvibe }; text: the plain text; verbose_json: { task, language, duration, text, segments, usage, x_openvibe }.' }, 400: { description: 'Invalid request or unsupported file type' }, 401: { description: 'Invalid or expired key' }, 413: { description: 'Audio too large' }, 429: { description: 'Key cap reached' }, 503: { description: 'No eligible provider' } } } },
    '/v1/moderations': { post: operation('compatModerations', 'Moderation through a structured model with the fixed moderation.classify prompt (no provider moderation endpoint is configured)', { ...properties,
        input: { anyOf: [{ type: 'string' }, { type: 'array', maxItems: 16, items: { type: 'string' } }] } }, ['input']) },
    '/v1/rerank': { post: operation('compatRerank', 'Cohere/Jina-shaped rerank by embeddings cosine similarity (no reranker adapter is configured)', { ...properties,
        query: { type: 'string', maxLength: 32000 }, documents: { type: 'array', minItems: 1, maxItems: 63, items: { anyOf: [{ type: 'string' }, { type: 'object', required: ['text'], properties: { text: { type: 'string' } } }] } },
        top_n: { type: 'integer', minimum: 1 }, return_documents: { type: 'boolean' } }, ['query', 'documents']) },
    '/v1/audio/speech': { post: { operationId: 'compatSpeech', summary: 'Speech synthesis in a Chat voice, metered per character', tags: ['exchange'], security: [{ bearer: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['model', 'input', 'voice'],
            properties: { model: { type: 'string', description: 'Any model id (the voice pins the offer).' }, input: { type: 'string', maxLength: 4096, description: 'The text to speak.' },
                voice: { type: 'string', description: 'A Chat voice id (server/providers/speech.js), one per provider voice.' },
                response_format: { enum: ['mp3', 'ogg_opus', 'wav'], default: 'mp3' }, speed: { type: 'number', minimum: 0.25, maximum: 4, default: 1 },
                max_cost_usd: { type: 'number', minimum: 0, description: 'The caller liability cap for the Balance hold.' } } } } } },
        responses: { 200: { description: 'The audio bytes (the voice MIME type), with x-openvibe-receipt-id and x-openvibe-receipt headers.' }, 400: { description: 'Invalid request' }, 401: { description: 'Invalid or expired key' }, 402: { description: 'Quota or balance refused' }, 404: { description: 'Unknown voice' }, 429: { description: 'Key cap reached' }, 503: { description: 'No eligible provider' } } } },
    '/v1/generation': { get: { operationId: 'compatGeneration', summary: 'Read accounting for your own generation', tags: ['exchange'], security: [{ bearer: [] }], parameters: [{ in: 'query', name: 'id', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'data: id, model, provider, cost, total_cost (USD), latency (ms), tokens_prompt, tokens_completion, created_at. No prompt or output.' }, 404: { description: 'Missing or owned by another requester' } } } },
    '/v1/presets/import': { post: operation('compatPresetImport', 'Save a validated request preset for the signed-in person', { ...properties, name: { type: 'string' }, system: { type: 'string' }, temperature: { type: 'number' }, top_p: { type: 'number' }, max_tokens: { type: 'integer' } }, ['name']) },
};
module.exports = { paths, provider };
