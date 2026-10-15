'use strict';
/**
 * OpenAI-compatible adapter, ported from OpenVibe.Live (server/ai/llm.js _openaiBody/_callOpenAI
 * and server/ai/ai-provider.js transcribe). Covers OpenAI, OpenRouter, Groq, Together and
 * self-hosted llama.cpp / LM Studio / Ollama (OpenAI mode) — anything with the OpenAI REST shape:
 *
 *   chat and every text operation   POST {base}/chat/completions
 *   embed                           POST {base}/embeddings
 *   transcribe                      POST {base}/audio/transcriptions   (Whisper-style)
 *   image                           POST {base}/images/generations     (dall-e-*, gpt-image-1)
 *
 * Structured output steps down json_schema -> json_object -> prose for gateways that lack it
 * (Live's behaviour); prose JSON is repaired by the engine.
 */
const fs = require('fs');
const path = require('path');
const { ProviderError, postJson, deadline, describeAbort, approxTokens, schemaInstruction } = require('./common');
const { sseEvents, createAccumulator } = require('./stream');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const TEXT_OPS = ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich'];

function isReasoningModel(m) { return /^(gpt-5|o\d)/i.test(m || ''); }

function buildBody({ model, system, messages, image, json, maxTokens, temperature, cacheKey, baseUrl }, jsonMode) {
    const msgs = [];
    // Stepped down from json_schema: the schema travels in the instructions instead.
    const hint = json && jsonMode !== 'schema' ? schemaInstruction(json) : '';
    const sysText = [...(system || []).map(x => x.text), hint].filter(Boolean).join('\n\n');
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
    const caps = new Set(record.capabilities && record.capabilities.length ? record.capabilities : [...TEXT_OPS, 'json', 'vision', 'embed', 'transcribe', 'image']);

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
        if (!req.model) throw new ProviderError('transcription model is not configured', { code: 'provider.model' });
        const form = new FormData();
        form.append('file', new Blob([fs.readFileSync(req.filePath)], { type: 'audio/wav' }), path.basename(req.filePath));
        form.append('model', req.model);
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
            if (!j || typeof j !== 'object' || (typeof j.text !== 'string' && typeof j.transcript !== 'string'))
                throw new ProviderError('transcription response has no text field', { code: 'provider.output' });
            const segments = Array.isArray(j.segments) ? j.segments.map(s => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() })) : [];
            return { text: String(j.text || j.transcript || '').trim(), segments, model: req.model, usage: { input: 0, output: 0, cached: 0 } };
        } catch (err) {
            if (err instanceof ProviderError) throw err;
            return { text: String(raw || '').trim(), segments: [], model: req.model, usage: { input: 0, output: 0, cached: 0 } };
        }
    }

    // OpenAI Images API: metered per image (usage.output = images returned), never per token.
    // dall-e-* answers a URL unless asked for b64_json; gpt-image-1 answers base64 already; dall-e-3 takes only n=1.
    async function images(req) {
        const model = req.model;
        if (!model) throw new ProviderError('image model is not configured', { code: 'provider.model' });
        const body = { model, prompt: String(req.prompt || ''), n: Math.max(1, Math.min(Number(req.n) || 1, /^dall-e-3/i.test(model) ? 1 : 4)) };
        if (req.size) body.size = String(req.size);
        if (!/^gpt-image-1/i.test(model)) body.response_format = 'b64_json';
        const j = await postJson(`${baseUrl}/images/generations`, headers(), body, { signal: req.signal, timeoutMs: req.timeoutMs, fetchImpl });
        const list = (Array.isArray(j.data) ? j.data : []).filter(d => d && (d.b64_json || d.url))
            .map(d => ({ b64: d.b64_json || null, url: d.url || null, revised_prompt: d.revised_prompt || null }));
        if (!list.length) throw new ProviderError('image response has no data', { code: 'provider.output' });
        return { images: list, model: j.model || model, usage: { input: 0, output: list.length, cached: 0 } };
    }

    /**
     * complete (the OpenAI-compatible endpoint, /v1/chat/completions): the caller's Chat Completions request as they
     * wrote it (messages with tool calls and tool results, tools, tool_choice, response_format, stop, seed), sent to
     * this upstream with the routed model. A reasoning model takes max_completion_tokens and its default temperature.
     * → { completion, text, model, usage }
     */
    async function complete(req) {
        const o = req.openai || {};
        const body = { model: req.model, messages: o.messages };
        for (const k of ['tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'stop', 'seed', 'top_p', 'presence_penalty', 'frequency_penalty']) {
            if (o[k] !== undefined && o[k] !== null) body[k] = o[k];
        }
        if (isReasoningModel(req.model)) {
            if (req.maxTokens) body.max_completion_tokens = req.maxTokens;
            for (const k of ['top_p', 'presence_penalty', 'frequency_penalty']) delete body[k];
        } else {
            if (req.maxTokens) body.max_tokens = req.maxTokens;
            if (req.temperature != null) body.temperature = req.temperature;
        }
        if (typeof req.onDelta === 'function') return await completeStreaming(body, req);
        const j = await postJson(`${baseUrl}/chat/completions`, headers(), body, { signal: req.signal, timeoutMs: req.timeoutMs, fetchImpl });
        if (!Array.isArray(j.choices) || !j.choices.length) throw new ProviderError('completion has no choices', { code: 'provider.output' });
        const msg = j.choices[0].message || {};
        const u = j.usage || {};
        return {
            completion: { choices: j.choices, system_fingerprint: j.system_fingerprint || null },
            text: typeof msg.content === 'string' ? msg.content : '',
            model: j.model || req.model,
            usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cached: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0 },
        };
    }

    /**
     * complete with stream: true: each upstream chunk's choices go to req.onDelta as they arrive, and the answer is put
     * back together (content joined, tool calls assembled) so the run ends with the same completion as without
     * streaming. Usage comes from the final chunk (stream_options.include_usage); an upstream that sends none is
     * estimated from the text.
     */
    async function completeStreaming(body, req) {
        let res;
        try {
            res = await fetchImpl(`${baseUrl}/chat/completions`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers() },
                body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
                signal: deadline(req.signal, req.timeoutMs), stream: true,
            });
        } catch (err) {
            throw describeAbort(err, req.signal, req.timeoutMs) || new ProviderError(`connection failed: ${err.message}`, { code: 'provider.unreachable' });
        }
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            let j = {};
            try { j = JSON.parse(text); } catch { /* not JSON */ }
            const msg = (j.error && (j.error.message || j.error)) || `HTTP ${res.status}: ${String(text).slice(0, 200)}`;
            throw new ProviderError(typeof msg === 'string' ? msg : JSON.stringify(msg), { status: res.status, code: res.status === 401 || res.status === 403 ? 'provider.auth' : 'provider.http', body: j });
        }
        const acc = createAccumulator();
        let usage = null;
        let model = req.model;
        let fingerprint = null;
        try {
            for await (const chunk of sseEvents(res.body)) {
                if (chunk.error) throw new ProviderError(String(chunk.error.message || chunk.error).slice(0, 300), { code: 'provider.http' });
                if (chunk.model) model = chunk.model;
                if (chunk.system_fingerprint) fingerprint = chunk.system_fingerprint;
                if (chunk.usage) usage = chunk.usage;
                for (const c of chunk.choices || []) {
                    acc.add(c);
                    req.onDelta({ index: Number(c.index) || 0, delta: c.delta || {}, finish_reason: c.finish_reason || null, model });
                }
            }
        } catch (err) {
            if (err instanceof ProviderError) throw err;
            throw describeAbort(err, req.signal, req.timeoutMs) || new ProviderError(`the stream broke: ${err.message}`, { code: 'provider.unreachable' });
        }
        const choices = acc.result();
        if (!choices.length) throw new ProviderError('completion has no choices', { code: 'provider.output' });
        const first = choices[0].message;
        const u = usage || {};
        const estimated = !usage;
        const inTok = estimated ? (body.messages || []).reduce((n, m) => n + approxTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')), 0) : (u.prompt_tokens || 0);
        const outTok = estimated ? approxTokens(`${first.content || ''}${JSON.stringify(first.tool_calls || '')}`) : (u.completion_tokens || 0);
        return {
            completion: { choices, system_fingerprint: fingerprint },
            text: typeof first.content === 'string' ? first.content : '',
            model,
            usage: { input: inTok, output: outTok, cached: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0, ...(estimated ? { estimated: true } : {}) },
        };
    }

    const adapter = {
        key: record.key,
        kind: 'openai',
        // complete is the chat endpoint as the caller wrote it: any upstream that chats completes; tools are declared.
        supports: (feature) => caps.has(feature) || (feature === 'complete' && caps.has('chat')),
        chat,
        complete,
        embed,
        transcribe,
        image: images,
    };
    for (const op of TEXT_OPS) if (op !== 'chat') adapter[op] = chat;   // the engine shapes the prompt per operation
    return adapter;
}

module.exports = { createOpenAiProvider, buildBody, DEFAULT_BASE_URL };
