'use strict';
/**
 * Google Gemini's own API (the native generateContent endpoint), for a provider of kind 'gemini'.
 *
 *   POST {base}/models/{model}:generateContent?key=API_KEY
 *        { contents: [{ role, parts }], systemInstruction, generationConfig }
 *     -> { candidates: [{ content: { parts: [{ text }] } }], usageMetadata, modelVersion }
 *
 * The usage is read from usageMetadata (server/providers/usage.js): promptTokenCount includes
 * cachedContentTokenCount, and thoughtsTokenCount is the thinking. Gemini's OpenAI-compatible endpoint
 * (kind 'openai') does not report the cached tokens, which is why this adapter exists.
 */
const { ProviderError, postJson, schemaInstruction } = require('./common');
const usage = require('./usage');

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const TEXT_OPS = ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich'];

/** The canonical request as Gemini's contents: { role, parts }. */
function contentsOf({ system, messages, image }) {
    const out = [];
    for (const m of messages || []) {
        const role = m.role === 'assistant' ? 'model' : 'user';
        const parts = [];
        if (typeof m.content === 'string') parts.push({ text: m.content });
        else if (Array.isArray(m.content)) for (const p of m.content) if (p && p.type === 'text') parts.push({ text: String(p.text || '') });
        const last = m === (messages || [])[messages.length - 1];
        if (last && image && m.role === 'user') parts.push({ inline_data: { mime_type: image.mediaType, data: image.base64 } });
        if (parts.length) out.push({ role, parts });
    }
    return out;
}

function createGeminiProvider(record, { apiKey = '', fetchImpl = globalThis.fetch } = {}) {
    const baseUrl = String(record.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = (req) => String((req && req.model) || record.default_model || 'gemini-2.5-flash').replace(/^models\//, '');
    const caps = new Set(record.capabilities && record.capabilities.length ? record.capabilities : [...TEXT_OPS, 'json', 'vision']);

    async function generate(req) {
        const sysText = ((req.system || []).map((x) => x.text).join('\n'));
        const body = { contents: contentsOf(req) };
        if (sysText) body.systemInstruction = { parts: [{ text: sysText }] };
        const generationConfig = {};
        if (req.maxTokens) generationConfig.maxOutputTokens = req.maxTokens;
        if (req.temperature != null) generationConfig.temperature = req.temperature;
        if (req.json) {
            generationConfig.responseMimeType = 'application/json';
            generationConfig.responseSchema = req.json.schema;
        }
        if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
        const url = `${baseUrl}/models/${encodeURIComponent(model(req))}:generateContent`;
        const j = await postJson(url, apiKey ? { 'x-goog-api-key': apiKey } : {}, body, { signal: req.signal, timeoutMs: req.timeoutMs, fetchImpl });
        const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
        const text = parts.map((p) => p && p.text ? p.text : '').join('').trim();
        const u = usage.geminiUsage(j.usageMetadata || {});
        return { text, json: null, model: j.modelVersion || model(req), usage: u };
    }

    const chat = async (req) => {
        const r = await generate(req);
        if (!req.json) return r;
        let json = null;
        try { json = JSON.parse(r.text); } catch { json = null; }
        return { ...r, json };
    };

    const adapter = {
        key: record.key,
        kind: 'gemini',
        supports: (feature) => caps.has(feature),
        chat,
        generate,
    };
    for (const op of TEXT_OPS) if (op !== 'chat') adapter[op] = chat;
    return adapter;
}

module.exports = { createGeminiProvider, DEFAULT_BASE_URL };
