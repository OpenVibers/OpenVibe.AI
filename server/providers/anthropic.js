'use strict';
/**
 * Anthropic Messages API adapter, ported from OpenVibe.Live server/ai/llm.js
 * (_anthropicBody/_callAnthropic): real system blocks with cache_control on the stable ones
 * (prompt caching), images as base64 blocks, structured output through a forced tool.
 * No embeddings or transcription on this API — supports() says so and the router skips it.
 *
 * `messages` (Codes C3) is the caller's own Messages API request passed through as written (POST /v1/messages on AI):
 * messages, system, tools, tool_choice, stop_sequences, temperature, max_tokens, and stream with Anthropic's own SSE
 * event names (message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop,
 * ping). DeepSeek and MiniMax publish Anthropic-compatible endpoints, so the same adapter serves them at another
 * base_url.
 */
const { postJson, ProviderError, deadline, describeAbort } = require('./common');
const { sseFrames } = require('./stream');

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const TEXT_OPS = ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich'];
const MESSAGES_FIELDS = ['system', 'tools', 'tool_choice', 'stop_sequences', 'temperature', 'top_p', 'top_k', 'metadata'];

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

/** The caller's Messages API body, with the routed model and only the fields they set. */
function messagesBody(req) {
    const body = { model: req.model, max_tokens: Math.max(1, Number(req.maxTokens) || 1024) };
    if (Array.isArray(req.messages)) body.messages = req.messages;
    for (const k of MESSAGES_FIELDS) if (req[k] !== undefined && req[k] !== null) body[k] = req[k];
    return body;
}

const usageOf = (message) => {
    const u = (message && message.usage) || {};
    const cached = u.cache_read_input_tokens || 0;
    return { input: (u.input_tokens || 0) + cached + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0, cached };
};
const textOf = (message) => (message && Array.isArray(message.content) ? message.content : []).filter(c => c && c.type === 'text').map(c => c.text).join('').trim();

/**
 * The message a streamed answer adds up to: content blocks by index (a tool call's input joined from its
 * input_json_delta pieces and parsed), the stop reason, and the usage from message_start and message_delta.
 */
function createMessageAccumulator(model) {
    let message = null;
    let usage = {};
    let stopReason = null;
    let stopSequence = null;
    const blocks = new Map();
    return {
        add(event, data) {
            if (!data || typeof data !== 'object') return;
            if (event === 'message_start') {
                message = data.message && typeof data.message === 'object' ? data.message : null;
                usage = { ...((message && message.usage) || {}) };
            } else if (event === 'content_block_start') {
                const block = { ...(data.content_block || {}) };
                if (block.type === 'tool_use' && (block.input == null || typeof block.input !== 'object')) block.input = {};
                blocks.set(Number(data.index) || 0, { block, json: '' });
            } else if (event === 'content_block_delta') {
                const slot = blocks.get(Number(data.index) || 0);
                const d = data.delta || {};
                if (!slot) return;
                if (d.type === 'text_delta') slot.block.text = String(slot.block.text || '') + String(d.text || '');
                else if (d.type === 'input_json_delta') slot.json += String(d.partial_json || '');
                else if (d.type === 'thinking_delta') slot.block.thinking = String(slot.block.thinking || '') + String(d.thinking || '');
                else if (d.type === 'signature_delta') slot.block.signature = String(slot.block.signature || '') + String(d.signature || '');
            } else if (event === 'message_delta') {
                const d = data.delta || {};
                if (d.stop_reason !== undefined) stopReason = d.stop_reason;
                if (d.stop_sequence !== undefined) stopSequence = d.stop_sequence;
                if (data.usage) usage = { ...usage, ...data.usage };
            }
        },
        result() {
            const content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, slot]) => {
                const block = { ...slot.block };
                if (block.type === 'tool_use') {
                    if (slot.json) { try { block.input = JSON.parse(slot.json); } catch { /* an incomplete tool call keeps what it has */ } }
                    if (block.input == null) block.input = {};
                }
                return block;
            });
            return { ...(message || {}), type: 'message', role: 'assistant', model: (message && message.model) || model, content, stop_reason: stopReason, stop_sequence: stopSequence, usage };
        },
    };
}

function createAnthropicProvider(record, { apiKey = '', fetchImpl = globalThis.fetch } = {}) {
    const baseUrl = String(record.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const caps = new Set(record.capabilities && record.capabilities.length ? record.capabilities.filter(f => f !== 'embed' && f !== 'transcribe') : [...TEXT_OPS, 'json', 'vision']);
    // Anthropic authenticates with x-api-key. The Anthropic-compatible endpoints (DeepSeek, MiniMax) take a bearer token,
    // so one is sent there too; api.anthropic.com gets only the header it documents.
    const headers = () => (apiKey
        ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', ...(/anthropic\.com/i.test(baseUrl) ? {} : { Authorization: `Bearer ${apiKey}` }) }
        : { 'anthropic-version': '2023-06-01' });

    async function chat(req) {
        const j = await postJson(`${baseUrl}/messages`, headers(), buildBody(req), { signal: req.signal, timeoutMs: req.timeoutMs, fetchImpl });
        const content = j.content || [];
        let text = content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
        let jsonOut = null;
        const tool = content.find(c => c.type === 'tool_use');
        if (tool && tool.input) { jsonOut = tool.input; if (!text) text = JSON.stringify(tool.input); }
        const u = j.usage || {};
        const cached = u.cache_read_input_tokens || 0;
        return { text, json: jsonOut, model: j.model || req.model, usage: { input: (u.input_tokens || 0) + cached + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0, cached } };
    }

    /** POST /v1/messages as the caller wrote it → { message, text, model, usage }. */
    async function messages(req) {
        const body = messagesBody(req);
        if (typeof req.onDelta === 'function') return await messagesStreaming(body, req);
        const j = await postJson(`${baseUrl}/messages`, headers(), body, { signal: req.signal, timeoutMs: req.timeoutMs, fetchImpl });
        if (!j || j.type !== 'message' || !Array.isArray(j.content)) throw new ProviderError('message response has no content', { code: 'provider.output' });
        return { message: j, text: textOf(j), model: j.model || req.model, usage: usageOf(j) };
    }

    /** The same request with stream: true: each event goes to req.onDelta as it arrives, then the answer it adds up to. */
    async function messagesStreaming(body, req) {
        let res;
        try {
            res = await fetchImpl(`${baseUrl}/messages`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers() },
                body: JSON.stringify({ ...body, stream: true }), signal: deadline(req.signal, req.timeoutMs), stream: true,
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
        const acc = createMessageAccumulator(req.model);
        try {
            for await (const frame of sseFrames(res.body)) {
                const event = frame.event || (frame.data && frame.data.type) || 'message';
                if (event === 'error' || (frame.data && frame.data.type === 'error')) {
                    const e = (frame.data && frame.data.error) || {};
                    throw new ProviderError(String(e.message || 'the stream reported an error').slice(0, 300), { code: 'provider.http' });
                }
                acc.add(event, frame.data);
                if (frame.data) req.onDelta({ event, data: frame.data });
            }
        } catch (err) {
            if (err instanceof ProviderError) throw err;
            throw describeAbort(err, req.signal, req.timeoutMs) || new ProviderError(`the stream broke: ${err.message}`, { code: 'provider.unreachable' });
        }
        const message = acc.result();
        if (!Array.isArray(message.content) || !message.content.length) throw new ProviderError('message response has no content', { code: 'provider.output' });
        return { message, text: textOf(message), model: message.model || req.model, usage: usageOf(message) };
    }

    const adapter = { key: record.key, kind: 'anthropic', supports: (f) => caps.has(f) || (f === 'messages' && caps.has('chat')), chat, messages };
    for (const op of TEXT_OPS) if (op !== 'chat') adapter[op] = chat;
    return adapter;
}

module.exports = { createAnthropicProvider, buildBody, messagesBody, DEFAULT_BASE_URL };
