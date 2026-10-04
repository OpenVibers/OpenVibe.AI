'use strict';
/**
 * OpenAI Responses API adapter, for GPT-family models that only speak Responses and any gateway
 * with the same shape (any OpenAI-compatible base_url):
 *
 *   chat and every text operation   POST {base}/responses
 *        { model, instructions, input, max_output_tokens, text: { format: { type: 'json_schema' | 'json_object' } } }
 *     -> { output: [{ content: [{ type: 'output_text', text }] }], usage: { input_tokens, output_tokens } }
 *
 * Same transport, error mapping and usage shape as openai.js (postJson: deadline, describeAbort,
 * ProviderError; the pool's one retry on a transient failure), and the same structured-output
 * step-down json_schema -> json_object -> prose for gateways that lack it. No embeddings or
 * transcription: those stay with the `openai` kind.
 */
const { ProviderError, postJson } = require('./common');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const TEXT_OPS = ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich'];

function isReasoningModel(m) { return /^(gpt-5|o\d)/i.test(m || ''); }

/** Chat-style content (a string or [{type:'text',text}] parts) as Responses input content. */
function inputContent(content) {
    if (!Array.isArray(content)) return String(content || '');
    return content.map(p => (p && p.type === 'text' ? { type: 'input_text', text: String(p.text || '') } : p));
}

function buildBody({ model, system, messages, image, json, maxTokens, temperature, cacheKey, baseUrl }, jsonMode) {
    const input = (messages || []).map((m, i) => {
        const last = i === messages.length - 1;
        if (last && image && m.role === 'user') {
            const parts = Array.isArray(m.content) ? inputContent(m.content) : [{ type: 'input_text', text: String(m.content || '') }];
            return { role: 'user', content: [...parts, { type: 'input_image', image_url: `data:${image.mediaType};base64,${image.base64}` }] };
        }
        return { role: m.role, content: inputContent(m.content) };
    });
    const body = { model, input };
    const sysText = (system || []).map(x => x.text).join('\n\n');
    if (sysText) body.instructions = sysText;
    if (isReasoningModel(model)) {
        body.max_output_tokens = Math.max(maxTokens, 256) + 512;
        body.reasoning = { effort: /^gpt-5/i.test(model) ? 'minimal' : 'low' };
    } else {
        body.max_output_tokens = maxTokens;
        if (temperature != null) body.temperature = temperature;
    }
    if (json && jsonMode === 'schema') body.text = { format: { type: 'json_schema', name: json.name || 'result', schema: json.schema, strict: json.strict !== false } };
    else if (json && jsonMode === 'object') body.text = { format: { type: 'json_object' } };
    if (cacheKey && /api\.openai\.com/i.test(baseUrl)) body.prompt_cache_key = String(cacheKey).slice(0, 64);
    return body;
}

/** The output_text parts of every output item, in order. */
function outputText(j) {
    const parts = [];
    for (const item of Array.isArray(j.output) ? j.output : []) {
        for (const c of (item && Array.isArray(item.content) ? item.content : [])) {
            if (c && c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
        }
    }
    if (!parts.length && typeof j.output_text === 'string') parts.push(j.output_text);
    return parts.join('').trim();
}

/** An upstream that echoes the bearer key back in its error body never gets it into a thrown error. */
function scrubKey(err, apiKey) {
    if (!apiKey || !(err instanceof ProviderError)) return err;
    if (err.message.includes(apiKey)) err.message = err.message.split(apiKey).join('[redacted]');
    if (typeof err.stack === 'string' && err.stack.includes(apiKey)) err.stack = err.stack.split(apiKey).join('[redacted]');
    if (err.body && JSON.stringify(err.body).includes(apiKey)) err.body = null;
    return err;
}

function createResponsesProvider(record, { apiKey = '', fetchImpl = globalThis.fetch } = {}) {
    const baseUrl = String(record.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const headers = () => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});
    const caps = new Set(record.capabilities && record.capabilities.length ? record.capabilities : [...TEXT_OPS, 'json', 'vision']);

    async function chat(req) {
        let jsonMode = req.json ? 'schema' : null;
        for (let attempt = 0; attempt < 3; attempt++) {
            const body = buildBody({ ...req, baseUrl }, jsonMode);
            try {
                const j = await postJson(`${baseUrl}/responses`, headers(), body, { signal: req.signal, timeoutMs: req.timeoutMs, fetchImpl });
                const u = j.usage || {};
                return { text: outputText(j), json: null, model: j.model || req.model, usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, cached: (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0 } };
            } catch (e) {
                // Gateways without structured-output support: schema -> json_object -> prose.
                if (e instanceof ProviderError && e.status === 400 && jsonMode && /text\.format|json_schema|json_object|schema|strict/i.test(e.message)) {
                    jsonMode = jsonMode === 'schema' ? 'object' : null;
                    continue;
                }
                throw scrubKey(e, apiKey);
            }
        }
        throw new ProviderError('structured output unsupported', { code: 'provider.unsupported' });
    }

    const adapter = {
        key: record.key,
        kind: 'responses',
        supports: (feature) => caps.has(feature),
        chat,
    };
    for (const op of TEXT_OPS) if (op !== 'chat') adapter[op] = chat;   // the engine shapes the prompt per operation
    return adapter;
}

module.exports = { createResponsesProvider, buildBody, outputText, DEFAULT_BASE_URL };
