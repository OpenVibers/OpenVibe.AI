'use strict';
/**
 * Anthropic Messages API adapter, ported from OpenVibe.Live server/ai/llm.js
 * (_anthropicBody/_callAnthropic): real system blocks with cache_control on the stable ones
 * (prompt caching), images as base64 blocks, structured output through a forced tool.
 * No embeddings or transcription on this API — supports() says so and the router skips it.
 */
const { postJson } = require('./common');

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const TEXT_OPS = ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich'];

function buildBody({ model, system, messages, image, json, maxTokens, temperature }) {
    const body = { model, max_tokens: Math.max(1, maxTokens) };
    if (system && system.length) {
        body.system = system.map(x => (x.cache ? { type: 'text', text: x.text, cache_control: { type: 'ephemeral' } } : { type: 'text', text: x.text }));
    }
    body.messages = messages.map((m, i) => {
        const last = i === messages.length - 1;
        const content = Array.isArray(m.content)
            ? m.content.map(c => (c.type === 'text' ? { type: 'text', text: c.text } : c))
            : [{ type: 'text', text: String(m.content || '') }];
        if (last && image && m.role === 'user') content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } });
        return { role: m.role, content };
    });
    if (temperature != null) body.temperature = temperature;
    if (json) {
        body.tools = [{ name: json.name || 'result', description: json.description || 'Return the result.', input_schema: json.schema }];
        body.tool_choice = { type: 'tool', name: json.name || 'result' };
    }
    return body;
}

function createAnthropicProvider(record, { apiKey = '', fetchImpl = globalThis.fetch } = {}) {
    const baseUrl = String(record.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const caps = new Set(record.capabilities && record.capabilities.length ? record.capabilities.filter(f => f !== 'embed' && f !== 'transcribe') : [...TEXT_OPS, 'json', 'vision']);

    async function chat(req) {
        const j = await postJson(`${baseUrl}/messages`, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, buildBody(req), { signal: req.signal, timeoutMs: req.timeoutMs, fetchImpl });
        const content = j.content || [];
        let text = content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
        let jsonOut = null;
        const tool = content.find(c => c.type === 'tool_use');
        if (tool && tool.input) { jsonOut = tool.input; if (!text) text = JSON.stringify(tool.input); }
        const u = j.usage || {};
        const cached = u.cache_read_input_tokens || 0;
        return { text, json: jsonOut, model: j.model || req.model, usage: { input: (u.input_tokens || 0) + cached + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0, cached } };
    }

    const adapter = { key: record.key, kind: 'anthropic', supports: (f) => caps.has(f), chat };
    for (const op of TEXT_OPS) if (op !== 'chat') adapter[op] = chat;
    return adapter;
}

module.exports = { createAnthropicProvider, buildBody, DEFAULT_BASE_URL };
