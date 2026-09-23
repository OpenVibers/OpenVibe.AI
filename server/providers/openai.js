'use strict';
/**
 * OpenAI-compatible adapter, ported from OpenVibe.Live (server/ai/llm.js _openaiBody/_callOpenAI
 * and server/ai/ai-provider.js transcribe). Covers OpenAI, OpenRouter, Groq, Together and
 * self-hosted llama.cpp / LM Studio / Ollama (OpenAI mode) — anything with the OpenAI REST shape:
 *
 *   chat and every text operation   POST {base}/chat/completions
 *   embed                           POST {base}/embeddings
 *   transcribe                      POST {base}/audio/transcriptions   (Whisper-style)
 *
 * Structured output steps down json_schema -> json_object -> prose for gateways that lack it
 * (Live's behaviour); prose JSON is repaired by the engine.
 */
const fs = require('fs');
const path = require('path');
const { ProviderError, postJson, deadline, describeAbort } = require('./common');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const TEXT_OPS = ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich'];

function isReasoningModel(m) { return /^(gpt-5|o\d)/i.test(m || ''); }

function buildBody({ model, system, messages, image, json, maxTokens, temperature, cacheKey, baseUrl }, jsonMode) {
    const msgs = [];
    const sysText = (system || []).map(x => x.text).join('\n\n');
    if (sysText) msgs.push({ role: 'system', content: sysText });
    messages.forEach((m, i) => {
        const last = i === messages.length - 1;
        if (last && image && m.role === 'user') {
            const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
            msgs.push({ role: 'user', content: [...parts, { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } }] });
        } else msgs.push({ role: m.role, content: Array.isArray(m.content) ? m.content : String(m.content || '') });
    });
    const body = { model, messages: msgs };
    if (isReasoningModel(model)) {
        body.max_completion_tokens = Math.max(maxTokens, 256) + 512;
        body.reasoning_effort = /^gpt-5/i.test(model) ? 'minimal' : 'low';
    } else {
        body.max_tokens = maxTokens;
        if (temperature != null) body.temperature = temperature;
    }
    if (json && jsonMode === 'schema') body.response_format = { type: 'json_schema', json_schema: { name: json.name || 'result', schema: json.schema, strict: json.strict !== false } };
    else if (json && jsonMode === 'object') body.response_format = { type: 'json_object' };
    if (cacheKey && /api\.openai\.com/i.test(baseUrl)) body.prompt_cache_key = String(cacheKey).slice(0, 64);
    return body;
}

function createOpenAiProvider(record, { apiKey = '', fetchImpl = globalThis.fetch } = {}) {
    const baseUrl = String(record.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const headers = () => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});
    const caps = new Set(record.capabilities && record.capabilities.length ? record.capabilities : [...TEXT_OPS, 'json', 'vision', 'embed', 'transcribe']);

    async function chat(req) {
        let jsonMode = req.json ? 'schema' : null;
        for (let attempt = 0; attempt < 3; attempt++) {
            const body = buildBody({ ...req, baseUrl }, jsonMode);
            try {
                const j = await postJson(`${baseUrl}/chat/completions`, headers(), body, { signal: req.signal, timeoutMs: req.timeoutMs, fetchImpl });
                const msg = j.choices && j.choices[0] && j.choices[0].message;
                const text = (msg && typeof msg.content === 'string' ? msg.content : '').trim();
                const u = j.usage || {};
                return { text, json: null, model: j.model || req.model, usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cached: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0 } };
            } catch (e) {
                // Gateways without structured-output support: schema -> json_object -> prose.
                if (e instanceof ProviderError && e.status === 400 && jsonMode && /response_format|json_schema|schema|strict/i.test(e.message)) {
                    jsonMode = jsonMode === 'schema' ? 'object' : null;
                    continue;
                }
                throw e;
            }
        }
        throw new ProviderError('structured output unsupported', { code: 'provider.unsupported' });
    }

    async function embed(req) {
        const j = await postJson(`${baseUrl}/embeddings`, headers(), { model: req.model, input: req.input }, { signal: req.signal, timeoutMs: req.timeoutMs, fetchImpl });
        const vectors = (j.data || []).sort((a, b) => a.index - b.index).map(d => d.embedding);
        const u = j.usage || {};
        return { vectors, model: j.model || req.model, usage: { input: u.prompt_tokens || u.total_tokens || 0, output: 0, cached: 0 } };
    }

    async function transcribe(req) {
        if (!req.filePath || !fs.existsSync(req.filePath)) throw new ProviderError('transcription audio file missing', { code: 'provider.input' });
        const form = new FormData();
        form.append('file', new Blob([fs.readFileSync(req.filePath)], { type: 'audio/wav' }), path.basename(req.filePath));
        form.append('model', req.model || 'whisper-1');
        form.append('response_format', 'verbose_json');
        if (req.language && req.language !== 'auto') form.append('language', req.language);
        let res;
        try {
            res = await fetchImpl(`${baseUrl}/audio/transcriptions`, { method: 'POST', headers: headers(), body: form, signal: deadline(req.signal, req.timeoutMs) });
        } catch (err) {
            throw describeAbort(err, req.signal, req.timeoutMs) || new ProviderError(`connection failed: ${err.message}`, { code: 'provider.unreachable' });
        }
        const raw = await res.text();
        if (!res.ok) throw new ProviderError(`Transcribe HTTP ${res.status}: ${raw.slice(0, 300)}`, { status: res.status, code: 'provider.http' });
        // verbose_json has segments; some providers still answer plain text.
        try {
            const j = JSON.parse(raw);
            const segments = Array.isArray(j.segments) ? j.segments.map(s => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() })) : [];
            return { text: String(j.text || j.transcript || '').trim(), segments, model: req.model || 'whisper-1', usage: { input: 0, output: 0, cached: 0 } };
        } catch {
            return { text: String(raw || '').trim(), segments: [], model: req.model || 'whisper-1', usage: { input: 0, output: 0, cached: 0 } };
        }
    }

    const adapter = {
        key: record.key,
        kind: 'openai',
        supports: (feature) => caps.has(feature),
        chat,
        embed,
        transcribe,
    };
    for (const op of TEXT_OPS) if (op !== 'chat') adapter[op] = chat;   // the engine shapes the prompt per operation
    return adapter;
}

module.exports = { createOpenAiProvider, buildBody, DEFAULT_BASE_URL };
