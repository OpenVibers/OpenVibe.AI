'use strict';
/**
 * The newest compatible routes, which reuse the Chat Completions path rather than a second router:
 *
 *   POST /v1/responses                              OpenAI's Responses API (stateless), converted in and out
 *   POST /v1beta/models/{model}:generateContent     Gemini's generateContent, converted in and out
 *   POST /v1beta/models/{model}:streamGenerateContent  the same stream, SSE with ?alt=sse, else a JSON array
 *
 * Each request becomes one POST /v1/chat/completions on the same connection (the way /v1/completions
 * falls through), so it is the same run, auth, quota, hold, routing, usage record and receipt. The
 * response is converted back on res.json / res.write. Gemini also accepts x-goog-api-key and ?key=
 * carrying an OpenVibe key, and its errors take Google's { error: { code, message, status } } shape.
 */
const express = require('express');
const { CAPS } = require('../auth');
const { AiError, sendError } = require('../util');

function accounting(run) {
    return { cost: Number(run.usage.cost_usd || 0), latency: Math.max(0, Date.parse(run.finished_at) - Date.parse(run.started_at || run.created_at)) || 0,
        provider: run.provenance?.provider || null };
}

const INVALID = (message) => new AiError(400, 'input.invalid', message);
const passThrough = ['max_cost_usd', 'on_behalf_of', 'policy', 'service_tier', 'data_policy', 'x_openvibe', 'provider', 'models', 'prefer', 'effort', 'agent_role', 'kind'];

// --- OpenAI error shape (the same as server/api/openai.js) -------------------------------------------------------

function openaiError(res, status, message, code) {
    res.status(status).json({ error: { message: String(message || 'error').slice(0, 1000),
        type: status === 401 || status === 403 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status === 402 ? 'insufficient_quota' : status >= 500 ? 'api_error' : 'invalid_request_error',
        code: code || null, param: null } });
}

/** A problem+json from the auth layer is converted to OpenAI's { error } as it is written. */
function asOpenAiErrors(req, res, next) {
    const end = res.end.bind(res);
    res.end = (chunk, ...rest) => {
        const ct = String(res.getHeader('Content-Type') || '');
        if (res.statusCode >= 400 && /problem\+json/.test(ct) && chunk) {
            let p = null;
            try { p = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)); } catch { p = null; }
            if (p && p.error == null) {
                const body = JSON.stringify({ error: { message: String(p.detail || p.title || p.code || 'error'), type: res.statusCode === 401 || res.statusCode === 403 ? 'authentication_error' : res.statusCode >= 500 ? 'api_error' : 'invalid_request_error', code: p.code || null, param: null } });
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.setHeader('Content-Length', Buffer.byteLength(body));
                return end(body);
            }
        }
        return end(chunk, ...rest);
    };
    next();
}

// --- OpenAI Responses API -----------------------------------------------------------------------------------------

const runIdOf = (id) => String(id || '').replace(/^chatcmpl-/, '') || `run_${Date.now()}`;

/** One Responses content array -> a Chat content value (a string when it is all text). */
function responsesContent(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) throw INVALID('message content must be a string or an array of content parts');
    const parts = [];
    for (const p of content) {
        if (typeof p === 'string') { parts.push({ type: 'text', text: p }); continue; }
        if (!p || typeof p !== 'object') throw INVALID('message content parts must be objects');
        if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') {
            parts.push({ type: 'text', text: String(p.text == null ? '' : p.text) });
        } else if (p.type === 'input_image' || p.type === 'image_url') {
            const url = typeof p.image_url === 'string' ? p.image_url : p.image_url && p.image_url.url;
            if (typeof url !== 'string' || !/^(data:image\/|https:\/\/)/i.test(url)) throw INVALID('input_image.image_url must be a data:image URL or an https URL');
            parts.push({ type: 'image_url', image_url: { url, ...(p.detail ? { detail: p.detail } : {}) } });
        } else throw INVALID(`unsupported content part type ${String(p.type || 'unknown')}`);
    }
    if (!parts.length) return '';
    return parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('') : parts;
}

/** One Responses input item (a message, or a tool call / result from a previous response). */
function responsesItem(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw INVALID('input items must be objects');
    if (item.type === 'function_call') {
        if (typeof item.name !== 'string' || !item.name) throw INVALID('function_call.name is required');
        return [{ role: 'assistant', content: null, tool_calls: [{ id: item.call_id || item.id || `call_${Date.now()}`, type: 'function',
            function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) } }] }];
    }
    if (item.type === 'function_call_output') {
        if (typeof item.call_id !== 'string' || !item.call_id) throw INVALID('function_call_output.call_id is required');
        return [{ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output == null ? '' : item.output) }];
    }
    const role = item.role === 'developer' ? 'system' : item.role;
    if (!['system', 'user', 'assistant', 'tool'].includes(role)) throw INVALID('message.role must be user, assistant, system or developer');
    return [{ role, content: responsesContent(item.content) }];
}

/** Responses function tools are flat ({ type, name, parameters }); Chat tools nest them under `function`. */
function responsesTools(tools) {
    if (tools == null) return undefined;
    if (!Array.isArray(tools)) throw INVALID('tools must be an array');
    return tools.map((t) => {
        if (!t || typeof t !== 'object' || t.type !== 'function') throw INVALID('only function tools are supported');
        const name = t.name || (t.function && t.function.name);
        if (typeof name !== 'string' || !name) throw INVALID('a function tool needs a name');
        const description = t.description != null ? t.description : t.function && t.function.description;
        const parameters = t.parameters != null ? t.parameters : t.function && t.function.parameters;
        return { type: 'function', function: { name, ...(description != null ? { description } : {}), ...(parameters != null ? { parameters } : {}), ...(t.strict != null ? { strict: t.strict } : {}) } };
    });
}

function responsesToolChoice(choice) {
    if (choice == null) return undefined;
    if (typeof choice === 'string') {
        if (!['auto', 'none', 'required'].includes(choice)) throw INVALID('tool_choice must be auto, none, required or a function');
        return choice;
    }
    if (choice && typeof choice === 'object') {
        const name = choice.name || (choice.function && choice.function.name);
        if ((choice.type === 'function' || choice.type == null) && typeof name === 'string' && name) return { type: 'function', function: { name } };
    }
    throw INVALID('tool_choice must be auto, none, required or a function');
}

/** text.format -> Chat response_format. Responses writes json_schema flat, Chat nests it. */
function responsesTextFormat(format) {
    if (format == null) return undefined;
    if (typeof format !== 'object') throw INVALID('text.format must be an object');
    if (format.type === 'text') return undefined;
    if (format.type === 'json_object') return { type: 'json_object' };
    if (format.type === 'json_schema') {
        const js = format.json_schema && typeof format.json_schema === 'object' ? format.json_schema : format;
        if (!js.schema || typeof js.schema !== 'object') throw INVALID('text.format.schema must be an object');
        return { type: 'json_schema', json_schema: { name: typeof js.name === 'string' && js.name ? js.name : 'response', schema: js.schema, ...(js.strict != null ? { strict: js.strict } : {}) } };
    }
    throw INVALID('text.format.type must be text, json_object or json_schema');
}

function responsesToChat(b) {
    const messages = [];
    let hasInput = false;
    if (typeof b.input === 'string') {
        if (!b.input.length) throw INVALID('input must not be empty');
        messages.push({ role: 'user', content: b.input });
        hasInput = true;
    } else if (Array.isArray(b.input)) {
        for (const item of b.input) {
            const added = responsesItem(item);
            if (added.some((m) => m.role !== 'system')) hasInput = true;
            messages.push(...added);
        }
    } else throw INVALID('input must be a string or an array of message items');
    if (b.instructions != null) {
        if (typeof b.instructions !== 'string') throw INVALID('instructions must be a string');
        messages.unshift({ role: 'system', content: b.instructions });
    }
    if (!hasInput) throw INVALID('input must not be empty');
    const out = { messages };
    if (b.model != null) out.model = b.model;
    if (b.temperature != null) out.temperature = b.temperature;
    if (b.top_p != null) out.top_p = b.top_p;
    if (b.max_output_tokens != null) out.max_tokens = Math.max(1, Math.min(Number(b.max_output_tokens) || 1, 16000));
    if (b.stream != null) out.stream = b.stream === true;
    if (b.stream === true) out.stream_options = { include_usage: true };
    if (b.tools !== undefined) out.tools = responsesTools(b.tools);
    if (b.tool_choice !== undefined) out.tool_choice = responsesToolChoice(b.tool_choice);
    if (b.parallel_tool_calls !== undefined) out.parallel_tool_calls = b.parallel_tool_calls;
    const format = responsesTextFormat(b.text && b.text.format);
    if (format) out.response_format = format;
    for (const k of passThrough) if (b[k] !== undefined) out[k] = b[k];
    return out;
}

function responsesMeta(b) {
    return {
        instructions: b.instructions != null ? b.instructions : null,
        max_output_tokens: b.max_output_tokens != null ? b.max_output_tokens : null,
        temperature: b.temperature != null ? b.temperature : null,
        top_p: b.top_p != null ? b.top_p : null,
        tools: Array.isArray(b.tools) ? b.tools : [],
        tool_choice: b.tool_choice != null ? b.tool_choice : 'auto',
        parallel_tool_calls: b.parallel_tool_calls !== false,
        store: b.store === true,
        metadata: b.metadata && typeof b.metadata === 'object' ? b.metadata : {},
        text_format: b.text && b.text.format ? b.text.format : { type: 'text' },
        model: b.model != null ? b.model : 'openvibe',
    };
}

function responsesUsage(usage) {
    const u = usage || {};
    const input = Number(u.prompt_tokens) || 0;
    const output = Number(u.completion_tokens) || 0;
    return {
        input_tokens: input,
        input_tokens_details: { cached_tokens: Number(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0 },
        output_tokens: output,
        output_tokens_details: { reasoning_tokens: Number(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0 },
        total_tokens: Number(u.total_tokens) || input + output,
    };
}

function responsesBase(chat, meta, status) {
    return {
        id: `resp_${runIdOf(chat.id)}`, object: 'response',
        created_at: Number(chat.created) || Math.floor(Date.now() / 1000), status, error: null, incomplete_details: null,
        instructions: meta.instructions, max_output_tokens: meta.max_output_tokens,
        model: chat.model || meta.model || 'openvibe', output: [],
        parallel_tool_calls: meta.parallel_tool_calls, previous_response_id: null,
        reasoning: { effort: null, summary: null }, store: meta.store, temperature: meta.temperature,
        text: { format: meta.text_format }, tool_choice: meta.tool_choice, tools: meta.tools, top_p: meta.top_p,
        truncation: 'disabled', usage: null, user: null, metadata: meta.metadata,
    };
}

function responsesFromChat(chat, meta) {
    const out = responsesBase(chat, meta, 'completed');
    const choice = (chat.choices && chat.choices[0]) || {};
    const message = choice.message || {};
    const runId = runIdOf(chat.id);
    const text = typeof message.content === 'string' ? message.content : '';
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (text.length || !calls.length) {
        out.output.push({ type: 'message', id: `msg_${runId}`, status: 'completed', role: 'assistant',
            content: [{ type: 'output_text', text, annotations: [], logprobs: [] }] });
    }
    calls.forEach((call, i) => out.output.push({ type: 'function_call', id: `fc_${runId}_${i}`, call_id: call.id, name: call.function && call.function.name,
        arguments: (call.function && call.function.arguments) || '', status: 'completed' }));
    out.usage = responsesUsage(chat.usage);
    if (choice.finish_reason === 'length') { out.status = 'incomplete'; out.incomplete_details = { reason: 'max_output_tokens' }; }
    if (chat.x_openvibe) out.x_openvibe = chat.x_openvibe;
    return out;
}

/** Convert the Chat Completions SSE stream to Responses events, in the documented order. */
function responsesStream(res, meta) {
    const rawWrite = res.write.bind(res);
    const rawEnd = res.end.bind(res);
    let started = false;
    let done = false;
    let response = null;
    let seq = 0;
    let text = '';
    let textItem = null;
    let textIndex = -1;
    let outputIndex = 0;
    let finishReason = null;
    let usage = null;
    const calls = new Map();
    const items = [];
    const send = (type, data) => {
        if (done || res.writableEnded || res.destroyed) return;
        rawWrite(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
    };
    const start = (chat) => {
        if (started) return;
        started = true;
        response = responsesBase(chat, meta, 'in_progress');
        send('response.created', { response });
    };
    const addText = () => {
        if (textItem) return;
        const part = { type: 'output_text', text: '', annotations: [], logprobs: [] };
        textItem = { type: 'message', id: `msg_${response.id.slice(5)}`, status: 'in_progress', role: 'assistant', content: [part] };
        textIndex = outputIndex++;
        send('response.output_item.added', { output_index: textIndex, item: textItem });
        send('response.content_part.added', { item_id: textItem.id, output_index: textIndex, content_index: 0, part });
        items.push({ index: textIndex, item: textItem });
    };
    const addCall = (call, idx) => {
        const item = { type: 'function_call', id: `fc_${response.id.slice(5)}_${calls.size}`, call_id: call.id || `call_${idx}`,
            name: call.function && call.function.name ? call.function.name : 'function', arguments: '', status: 'in_progress' };
        const placed = { index: outputIndex++, item, args: '', finished: false };
        calls.set(idx, placed);
        items.push({ index: placed.index, item });
        send('response.output_item.added', { output_index: placed.index, item });
    };
    const finish = (reason) => {
        if (reason) finishReason = reason;
        if (!started) return;
        if (!textItem && !calls.size) addText();
        if (textItem && textItem.status !== 'completed') {
            textItem.status = 'completed';
            const part = textItem.content[0];
            part.text = text;
            send('response.output_text.done', { item_id: textItem.id, output_index: textIndex, content_index: 0, text, logprobs: [] });
            send('response.content_part.done', { item_id: textItem.id, output_index: textIndex, content_index: 0, part });
            send('response.output_item.done', { output_index: textIndex, item: textItem });
        }
        for (const call of calls.values()) {
            if (call.finished) continue;
            call.finished = true;
            call.item.status = 'completed';
            call.item.arguments = call.args;
            send('response.function_call_arguments.done', { item_id: call.item.id, output_index: call.index, arguments: call.args });
            send('response.output_item.done', { output_index: call.index, item: call.item });
        }
    };
    const complete = () => {
        if (done) return;
        finish(finishReason);
        if (!started) { done = true; return; }
        const output = items.slice().sort((a, b) => a.index - b.index).map((x) => x.item);
        const final = { ...response, status: finishReason === 'length' ? 'incomplete' : 'completed',
            incomplete_details: finishReason === 'length' ? { reason: 'max_output_tokens' } : null, output, usage: responsesUsage(usage) };
        send('response.completed', { response: final });
        done = true;
    };
    const handle = (chat) => {
        if (!chat || typeof chat !== 'object') return;
        if (chat.error) {
            send('error', { code: chat.error.code || null, message: chat.error.message || 'error', param: null });
            done = true;
            return;
        }
        start(chat);
        if (chat.usage) usage = chat.usage;
        if (chat.x_openvibe) response.x_openvibe = chat.x_openvibe;
        for (const choice of chat.choices || []) {
            const d = choice.delta || {};
            if (typeof d.content === 'string' && d.content.length) {
                addText();
                text += d.content;
                send('response.output_text.delta', { item_id: textItem.id, output_index: textIndex, content_index: 0, delta: d.content, logprobs: [] });
            }
            for (const call of d.tool_calls || []) {
                const idx = Number(call.index) || 0;
                if (!calls.has(idx)) addCall(call, idx);
                const placed = calls.get(idx);
                if (call.id) placed.item.call_id = call.id;
                if (call.function && call.function.name) placed.item.name = call.function.name;
                const piece = call.function && call.function.arguments;
                if (typeof piece === 'string' && piece.length) {
                    placed.args += piece;
                    send('response.function_call_arguments.delta', { item_id: placed.item.id, output_index: placed.index, delta: piece });
                }
            }
            if (choice.finish_reason) finish(choice.finish_reason);
        }
    };
    res.write = (chunk, ...args) => {
        const value = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        if (value.startsWith(': ')) return true;
        if (value.startsWith('data: ')) {
            const data = value.slice(6).replace(/\s+$/, '');
            if (data === '[DONE]') { complete(); return true; }
            try { handle(JSON.parse(data)); } catch { /* not a chat chunk */ }
            return true;
        }
        return rawWrite(chunk, ...args);
    };
    res.end = (chunk, ...args) => {
        if (chunk == null) complete();
        return rawEnd(chunk, ...args);
    };
}

// --- Gemini generateContent ---------------------------------------------------------------------------------------

const GEMINI_STATUS = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 409: 'ABORTED', 429: 'RESOURCE_EXHAUSTED', 500: 'INTERNAL', 503: 'UNAVAILABLE', 504: 'DEADLINE_EXCEEDED' };
function geminiError(status, message, code) {
    return { error: { code: status, message: String(message || 'error').slice(0, 1000), status: GEMINI_STATUS[status] || 'UNKNOWN', ...(code ? { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: code }] } : {}) } };
}
function geminiStatusFor(code) {
    if (/^(input|validation)\./.test(code || '')) return 400;
    if (/quota|allowance|budget/.test(code || '')) return 429;
    if (code === 'project_secret.refused' || /capability\.denied|policy\./.test(code || '')) return 403;
    if (code === 'ai.model_not_found') return 404;
    return 503;
}
function asGeminiErrors(req, res, next) {
    const end = res.end.bind(res);
    res.end = (chunk, ...rest) => {
        const ct = String(res.getHeader('Content-Type') || '');
        if (res.statusCode >= 400 && /problem\+json/.test(ct) && chunk) {
            let p = null;
            try { p = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)); } catch { p = null; }
            if (p && p.error == null) {
                const body = JSON.stringify(geminiError(res.statusCode, p.detail || p.title || p.code || 'error', p.code));
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.setHeader('Content-Length', Buffer.byteLength(body));
                return end(body);
            }
        }
        return end(chunk, ...rest);
    };
    next();
}

function geminiText(parts) {
    if (!Array.isArray(parts)) return '';
    return parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
}
function geminiSystem(instruction) {
    if (!instruction) return '';
    if (typeof instruction === 'string') return instruction;
    return geminiText(instruction.parts);
}
function geminiLastCallId(messages, name) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        for (const t of (m && m.tool_calls) || []) if (t.function && t.function.name === name) return t.id;
    }
    return `call_${name || 'function'}`;
}
function geminiArgs(value) {
    if (value == null) return {};
    if (typeof value === 'object') return value;
    try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}
function geminiFinish(reason) {
    if (reason === 'length') return 'MAX_TOKENS';
    if (reason === 'content_filter') return 'SAFETY';
    if (reason === 'stop' || reason === 'tool_calls') return 'STOP';
    return reason ? 'OTHER' : undefined;
}
function geminiUsage(usage) {
    const u = usage || {};
    const input = Number(u.prompt_tokens) || 0;
    const output = Number(u.completion_tokens) || 0;
    return {
        promptTokenCount: input, candidatesTokenCount: output,
        totalTokenCount: Number(u.total_tokens) || input + output,
        cachedContentTokenCount: Number(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
    };
}

function geminiToChat(body, model, stream) {
    const b = body && typeof body === 'object' ? body : {};
    if (!Array.isArray(b.contents) || !b.contents.length) throw INVALID('contents must be a non-empty array');
    const messages = [];
    const system = geminiSystem(b.systemInstruction);
    if (system) messages.push({ role: 'system', content: system });
    for (const content of b.contents) {
        if (!content || typeof content !== 'object') throw INVALID('contents must be objects');
        const role = content.role === 'model' ? 'assistant' : 'user';
        const texts = [];
        const images = [];
        const calls = [];
        const results = [];
        for (const part of content.parts || []) {
            if (!part || typeof part !== 'object') continue;
            if (typeof part.text === 'string') texts.push(part.text);
            else if (part.inlineData && part.inlineData.data) {
                const mime = part.inlineData.mimeType || 'image/png';
                images.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${part.inlineData.data}` } });
            } else if (part.functionCall) {
                if (typeof part.functionCall.name !== 'string' || !part.functionCall.name) throw INVALID('functionCall.name is required');
                calls.push({ id: `call_${messages.length}_${calls.length}`, type: 'function',
                    function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) } });
            } else if (part.functionResponse) {
                results.push({ name: part.functionResponse.name, response: part.functionResponse.response });
            }
        }
        if (results.length) {
            for (const r of results) messages.push({ role: 'tool', tool_call_id: geminiLastCallId(messages, r.name), content: JSON.stringify(r.response == null ? {} : r.response) });
            continue;
        }
        const value = images.length ? [...texts.map((text) => ({ type: 'text', text })), ...images] : texts.join('');
        if (calls.length) messages.push({ role: 'assistant', content: value || null, tool_calls: calls });
        else if (texts.length || images.length) messages.push({ role, content: value });
    }
    if (!messages.some((m) => m.role !== 'system')) throw INVALID('contents must not be empty');
    const out = { messages, model };
    const tools = [];
    for (const t of Array.isArray(b.tools) ? b.tools : []) {
        for (const d of Array.isArray(t.functionDeclarations) ? t.functionDeclarations : []) {
            if (!d || typeof d.name !== 'string' || !d.name) throw INVALID('a function declaration needs a name');
            tools.push({ type: 'function', function: { name: d.name, ...(d.description != null ? { description: d.description } : {}), ...(d.parameters != null ? { parameters: d.parameters } : {}) } });
        }
    }
    if (tools.length) out.tools = tools;
    const tc = b.toolConfig && b.toolConfig.functionCallingConfig;
    if (tc) {
        if (tc.mode === 'NONE') out.tool_choice = 'none';
        else if (tc.mode === 'ANY') {
            const names = Array.isArray(tc.allowedFunctionNames) ? tc.allowedFunctionNames : [];
            out.tool_choice = names.length === 1 ? { type: 'function', function: { name: names[0] } } : 'required';
        } else if (tc.mode === 'AUTO') out.tool_choice = 'auto';
    }
    const gc = b.generationConfig && typeof b.generationConfig === 'object' ? b.generationConfig : {};
    if (gc.temperature != null) out.temperature = gc.temperature;
    if (gc.topP != null) out.top_p = gc.topP;
    if (gc.maxOutputTokens != null) out.max_tokens = Math.max(1, Math.min(Number(gc.maxOutputTokens) || 1, 16000));
    if (gc.stopSequences != null) out.stop = gc.stopSequences;
    if (gc.candidateCount != null && Number(gc.candidateCount) !== 1) throw INVALID('candidateCount must be 1');
    if (gc.responseMimeType === 'application/json') {
        const schema = gc.responseSchema || gc.responseJsonSchema;
        out.response_format = schema && typeof schema === 'object'
            ? { type: 'json_schema', json_schema: { name: 'response', schema, strict: true } }
            : { type: 'json_object' };
    }
    if (stream) {
        out.stream = true;
        out.stream_options = { include_usage: true };
    }
    return out;
}

function geminiResponse(chat, model) {
    const choice = (chat.choices && chat.choices[0]) || {};
    const message = choice.message || {};
    const parts = [];
    if (typeof message.content === 'string' && message.content.length) parts.push({ text: message.content });
    for (const call of message.tool_calls || []) parts.push({ functionCall: { name: call.function && call.function.name, args: geminiArgs(call.function && call.function.arguments) } });
    if (!parts.length) parts.push({ text: '' });
    const out = {
        candidates: [{ content: { role: 'model', parts }, finishReason: geminiFinish(choice.finish_reason) || 'STOP', index: 0 }],
        usageMetadata: geminiUsage(chat.usage), modelVersion: chat.model || model,
    };
    if (chat.x_openvibe) out.x_openvibe = chat.x_openvibe;
    return out;
}

function installGeminiJson(res, model) {
    const json = res.json.bind(res);
    res.json = (value) => {
        if (value && Array.isArray(value.choices)) return json(geminiResponse(value, model));
        if (value && value.error && res.statusCode >= 400) return json(geminiError(res.statusCode, value.error.message, value.error.code));
        return json(value);
    };
}

/** The Chat SSE stream -> Gemini chunks, written as SSE, or collected into the JSON array Gemini's REST returns. */
function installGeminiStream(res, model, sse) {
    const rawWrite = res.write.bind(res);
    const rawEnd = res.end.bind(res);
    const rawSetHeader = res.setHeader.bind(res);
    const chunks = [];
    let done = false;
    let finished = false;
    let usage = null;
    let responseModel = model;
    const calls = new Map();
    const emit = (chunk) => {
        if (done) return;
        if (sse) rawWrite(`data: ${JSON.stringify(chunk)}\n\n`);
        else chunks.push(chunk);
    };
    const finish = (reason) => {
        if (finished) return;
        finished = true;
        const parts = [...calls.values()].map((c) => ({ functionCall: { name: c.name, args: geminiArgs(c.args) } }));
        emit({ candidates: [{ content: { role: 'model', parts }, finishReason: geminiFinish(reason || (calls.size ? 'tool_calls' : 'stop')) || 'STOP', index: 0 }], modelVersion: responseModel });
    };
    const handle = (chat) => {
        if (!chat || typeof chat !== 'object') return;
        if (chat.error) {
            emit(geminiError(geminiStatusFor(chat.error.code), chat.error.message, chat.error.code));
            done = true;
            return;
        }
        if (chat.usage) {
            usage = chat.usage;
            emit({ ...(sse && finished ? { candidates: [] } : {}), usageMetadata: geminiUsage(usage), modelVersion: responseModel });
            return;
        }
        for (const choice of chat.choices || []) {
            const d = choice.delta || {};
            if (typeof d.content === 'string' && d.content.length) emit({ candidates: [{ content: { role: 'model', parts: [{ text: d.content }] }, index: 0 }], modelVersion: responseModel });
            for (const call of d.tool_calls || []) {
                const idx = Number(call.index) || 0;
                if (!calls.has(idx)) calls.set(idx, { name: (call.function && call.function.name) || 'function', args: '' });
                const held = calls.get(idx);
                if (call.function && call.function.name) held.name = call.function.name;
                if (call.function && typeof call.function.arguments === 'string') held.args += call.function.arguments;
            }
            if (choice.finish_reason) finish(choice.finish_reason);
        }
    };
    if (!sse) {
        // Gemini's REST stream is a JSON array, not SSE: keep the chat stream's headers from going out and
        // answer the collected chunks in one JSON body when the chat stream ends.
        res.setHeader = (name, value) => {
            if (String(name).toLowerCase() === 'content-type' && /text\/event-stream/.test(String(value))) return res;
            return rawSetHeader(name, value);
        };
        res.flushHeaders = () => {};
    }
    res.write = (chunk, ...args) => {
        const value = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        if (value.startsWith(': ')) return true;
        if (value.startsWith('data: ')) {
            const data = value.slice(6).replace(/\s+$/, '');
            if (data === '[DONE]') { done = true; return true; }
            try { handle(JSON.parse(data)); } catch { /* not a chat chunk */ }
            return true;
        }
        if (sse) return rawWrite(chunk, ...args);
        return true;
    };
    let flushed = false;
    res.end = (chunk, ...args) => {
        if (chunk != null) return rawEnd(chunk, ...args);
        if (sse) return rawEnd(chunk, ...args);
        if (flushed) return rawEnd();
        flushed = true;
        rawSetHeader('Content-Type', 'application/json; charset=utf-8');
        return rawEnd(JSON.stringify(chunks));
    };
}

// --- router -------------------------------------------------------------------------------------------------------

function compatExtra({ runs, auth, config, log }) {
    const r = express.Router();
    const allow = auth.appOrCap(CAPS.appRun, CAPS.runCreate);
    const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (err) { sendError(res, err, req.ov, log); } };

    // Gemini's own key headers name the same OpenVibe keys the bearer header carries. Authorization wins
    // when both are present; nothing is invented from an empty key.
    const geminiKey = (req, res, next) => {
        const header = req.get('x-goog-api-key');
        const query = typeof req.query.key === 'string' ? req.query.key : '';
        const supplied = header || query;
        if (!req.get('authorization') && supplied && String(supplied).trim()) req.headers.authorization = `Bearer ${String(supplied).trim()}`;
        next();
    };

    r.get('/v1/generation', allow, wrap(async (req, res) => {
        const id = String(req.query.id || '').replace(/^(chatcmpl-|msg_)/, '');
        const run = await runs.get(id);
        const p = req.principal;
        // Never use an on_behalf_of claim to widen access to another requester's history.
        const owner = p.subject?.id;
        const type = p.subject?.type;
        if (!run || run.requester.type !== type || run.requester.id !== owner)
            throw new AiError(404, 'generation.not_found', 'Generation not found');
        res.set('Cache-Control', 'no-store').json({ data: { id: run.id, model: run.provenance.model,
            ...accounting(run), total_cost: Number(run.usage.cost_usd || 0),
            tokens_prompt: run.usage.tokens_in, tokens_completion: run.usage.tokens_out, created_at: run.created_at } });
    }));

    // OpenAI Responses API, stateless. `store` is accepted and ignored; previous_response_id is refused
    // rather than pretending the conversation is kept.
    r.post('/v1/responses', asOpenAiErrors, allow, (req, res, next) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        if (b.previous_response_id != null) return openaiError(res, 400, 'previous_response_id is not supported: send the whole conversation as input', 'input.invalid');
        let chat;
        try { chat = responsesToChat(b); } catch (err) { return openaiError(res, err.status || 400, err.detail || err.message, err.code); }
        const meta = responsesMeta(b);
        if (b.stream === true) responsesStream(res, meta);
        else {
            const json = res.json.bind(res);
            res.json = (value) => (value && Array.isArray(value.choices) ? json(responsesFromChat(value, meta)) : json(value));
        }
        req.body = chat;
        req.url = '/v1/chat/completions';
        next();
    });

    // Gemini. Express reads the literal colon in ":model\:generateContent" as part of the path (and the
    // documentation's {model}:generateContent), so the model is req.params.model.
    const gemini = (stream) => (req, res, next) => {
        let chat;
        try { chat = geminiToChat(req.body, req.params.model, stream); } catch (err) { return res.status(err.status || 400).json(geminiError(err.status || 400, err.detail || err.message, err.code)); }
        if (stream) installGeminiStream(res, req.params.model, String(req.query.alt || '').toLowerCase() === 'sse');
        else installGeminiJson(res, req.params.model);
        req.body = chat;
        req.url = '/v1/chat/completions';
        next();
    };
    r.post('/v1beta/models/:model\\:generateContent', geminiKey, asGeminiErrors, allow, gemini(false));
    r.post('/v1beta/models/:model\\:streamGenerateContent', geminiKey, asGeminiErrors, allow, gemini(true));

    r.post('/v1/embeddings', allow, wrap(async (req, res) => {
        const b = req.body || {};
        if (b.encoding_format && b.encoding_format !== 'float') throw new AiError(400, 'input.invalid', 'Only float embeddings are supported');
        if (b.dimensions !== undefined) throw new AiError(400, 'input.invalid', 'Custom dimensions are not supported');
        const input = { input: b.input, max_cost_usd: b.max_cost_usd };
        if (b.model || b.provider || b.models) input.compat_routing = require('../exchange/compat-routing').request(b);
        const created = await runs.create({ workflow: 'ai.embed', input, idempotency_key: req.get('idempotency-key') || undefined }, req.principal, { trace: req.ov?.traceId });
        res.locals.inferenceAdmitted = true;
        if (!created.created) res.set('x-openvibe-replayed', '1');
        const run = await runs.wait(created, Math.max(config.runs.maxWaitMs, 120000));
        if (['succeeded', 'cached'].includes(run.status) || (['failed', 'cancelled'].includes(run.status) && run.usage.attempts === 0)) res.locals.inferenceCharge = Number(run.usage.cost_usd || 0);
        if (!['succeeded', 'cached'].includes(run.status)) throw new AiError(503, run.error?.code || 'run.failed', run.error?.detail || 'Embedding unavailable');
        res.json({ id: run.id, object: 'list', model: run.provenance.model,
            data: run.output.vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
            usage: { prompt_tokens: run.usage.tokens_in, total_tokens: run.usage.tokens_in, ...(b.usage?.include ? accounting(run) : {}) },
            x_openvibe: { run_id: run.id, cost_usd: run.usage.cost_usd, provider: run.provenance.provider } });
    }));
    r.post('/v1/images/generations', allow, wrap(async (req, res) => {
        const b = req.body || {};
        if (b.response_format && !['url', 'b64_json'].includes(b.response_format)) throw new AiError(400, 'input.invalid', 'Unknown image response format');
        const input = { prompt: b.prompt, ...(b.size ? { size: b.size } : {}), ...(b.n ? { n: b.n } : {}), max_cost_usd: b.max_cost_usd };
        input.compat_routing = require('../exchange/compat-routing').request(b);
        const created = await runs.create({ workflow: 'ai.image', input, idempotency_key: req.get('idempotency-key') || undefined }, req.principal, { trace: req.ov?.traceId });
        res.locals.inferenceAdmitted = true;
        if (!created.created) res.set('x-openvibe-replayed', '1');
        const run = await runs.wait(created, Math.max(config.runs.maxWaitMs, 120000));
        if (['succeeded', 'cached'].includes(run.status) || (['failed', 'cancelled'].includes(run.status) && run.usage.attempts === 0)) res.locals.inferenceCharge = Number(run.usage.cost_usd || 0);
        if (!['succeeded', 'cached'].includes(run.status)) throw new AiError(503, run.error?.code || 'run.failed', run.error?.detail || 'Image provider unavailable');
        res.json({ id: run.id, created: Math.floor(Date.parse(run.created_at) / 1000),
            data: run.output.images.map(i => i.b64 ? { b64_json: i.b64 } : { url: i.url }),
            usage: { prompt_tokens: run.usage.tokens_in, completion_tokens: run.usage.tokens_out, ...(b.usage?.include ? accounting(run) : {}) },
            x_openvibe: { run_id: run.id, cost_usd: run.usage.cost_usd, provider: run.provenance.provider } });
    }));
    // Reuse the complete workflow and its single hold, including streaming and idempotency.
    r.post('/v1/completions', (req, res, next) => {
        if (typeof req.body?.prompt !== 'string' || !req.body.prompt.length)
            return res.status(400).json({ error: { code: 'input.invalid', message: 'prompt must be a non-empty string' } });
        const convert = v => v?.choices ? { ...v, object: 'text_completion', choices: v.choices.map(c => ({ index: c.index, text: c.message?.content || c.delta?.content || '', logprobs: c.logprobs || null, finish_reason: c.finish_reason })) } : v;
        const json = res.json.bind(res);
        res.json = v => json(convert(v));
        const write = res.write.bind(res);
        res.write = (chunk, ...args) => {
            const value = String(chunk);
            if (value.startsWith('data: ') && !value.startsWith('data: [DONE]')) {
                try { chunk = 'data: ' + JSON.stringify(convert(JSON.parse(value.slice(6)))) + '\n\n'; } catch {}
            }
            return write(chunk, ...args);
        };
        req.body = { ...req.body, messages: [...(req.body.messages || []), { role: 'user', content: req.body.prompt }] };
        delete req.body.prompt;
        req.url = '/v1/chat/completions';
        next();
    });
    return r;
}
module.exports = { compatExtra, accounting };
