'use strict';
/**
 * The deterministic no-key stub provider (mandatory for local and test operation).
 *
 * Every answer is a pure function of the request: the same request always yields the same output,
 * so tests are exact and browsers can exercise Wiki/Blog/News flows without keys or network.
 * Outputs are realistically SHAPED — a JSON answer follows the requested schema (enums, bounds,
 * arrays, nested objects), text has sentences, embeddings are unit vectors, transcripts have
 * timed segments — and are clearly marked synthetic: free-text strings start with "(synthetic)"
 * and every result carries synthetic: true, which the run records and returns. Downstream
 * products treat a synthetic run as "no real answer" (Live does; the publication gate keeps it
 * noindex).
 *
 * Drill modes (provider metadata, for fallback/breaker drills): { fail: 'error' | 'timeout' }.
 */
const crypto = require('crypto');
const { ProviderError, approxTokens, sleep } = require('./common');

const WORDS = ['signal', 'stream', 'moment', 'chat', 'overview', 'context', 'detail', 'summary', 'topic', 'source',
    'evidence', 'draft', 'highlight', 'session', 'update', 'note', 'theme', 'story', 'entity', 'record'];

function seeded(seedText) {
    let h = crypto.createHash('sha256').update(seedText).digest();
    let i = 0;
    return function next() {
        if (i + 4 > h.length) { h = crypto.createHash('sha256').update(h).digest(); i = 0; }
        const v = h.readUInt32BE(i);
        i += 4;
        return v / 0x100000000;
    };
}

function lastUserText(req) {
    const msgs = req.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
        const c = msgs[i].content;
        if (msgs[i].role === 'user') return typeof c === 'string' ? c : JSON.stringify(c);
    }
    return '';
}

function phrase(rnd, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]);
    return out.join(' ');
}

/** A value shaped like `schema`, drawn from rnd. Strings are marked synthetic. */
function synthesize(schema, rnd, depth = 0, name = 'value') {
    if (!schema || typeof schema !== 'object' || depth > 6) return null;
    if (schema.const !== undefined) return schema.const;
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[Math.floor(rnd() * schema.enum.length)];
    const alt = schema.oneOf || schema.anyOf;
    if (Array.isArray(alt) && alt.length) return synthesize(alt[0], rnd, depth + 1, name);
    let type = schema.type;
    if (Array.isArray(type)) type = type.find(t => t !== 'null') || 'null';
    if (!type) type = schema.properties ? 'object' : schema.items ? 'array' : 'string';
    switch (type) {
        case 'object': {
            const out = {};
            const props = schema.properties || {};
            for (const [k, sub] of Object.entries(props)) out[k] = synthesize(sub, rnd, depth + 1, k);
            return out;
        }
        case 'array': {
            const max = Number.isInteger(schema.maxItems) ? schema.maxItems : 3;
            const min = Number.isInteger(schema.minItems) ? schema.minItems : Math.min(1, max);
            const n = Math.max(min, Math.min(max, min + Math.floor(rnd() * 3)));
            return Array.from({ length: n }, (_, i) => synthesize(schema.items || { type: 'string' }, rnd, depth + 1, `${name}_${i + 1}`));
        }
        case 'integer': {
            const min = Number.isFinite(schema.minimum) ? schema.minimum : 0;
            const max = Number.isFinite(schema.maximum) ? schema.maximum : min + 100;
            return Math.floor(min + rnd() * (max - min + 1));
        }
        case 'number': {
            const min = Number.isFinite(schema.minimum) ? schema.minimum : 0;
            const max = Number.isFinite(schema.maximum) ? schema.maximum : 1;
            return Math.round((min + rnd() * (max - min)) * 1000) / 1000;
        }
        case 'boolean': return rnd() < 0.5;
        case 'null': return null;
        default: {
            let s = `(synthetic) ${name.replace(/_/g, ' ')}: ${phrase(rnd, 4 + Math.floor(rnd() * 5))}`;
            if (Number.isInteger(schema.maxLength)) s = s.slice(0, Math.max(0, schema.maxLength));
            if (Number.isInteger(schema.minLength) && s.length < schema.minLength) s = s.padEnd(schema.minLength, '.');
            return s;
        }
    }
}

function textFor(op, req, rnd) {
    const src = lastUserText(req).replace(/\s+/g, ' ').trim();
    const firstWords = src.split(' ').slice(0, 10).join(' ');
    switch (op) {
        case 'summarize': return `(synthetic) Summary: ${firstWords ? `${firstWords}…` : 'no input text'} — ${phrase(rnd, 6)}.`;
        case 'classify': return `(synthetic) ${phrase(rnd, 1)}`;
        case 'extract': return `(synthetic) extracted ${phrase(rnd, 3)}`;
        case 'enrich': return `(synthetic) enriched ${phrase(rnd, 5)}`;
        default: return `(synthetic) ${phrase(rnd, 8 + Math.floor(rnd() * 8))}. ${phrase(rnd, 6)}.`;
    }
}

/** A transparent 1x1 PNG, base64: the stub's image for every prompt. */
const STUB_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function createStubProvider(record = { key: 'stub', metadata: {} }, { stats = null } = {}) {
    const fail = record.metadata && record.metadata.fail;

    async function run(op, req) {
        if (stats) stats.calls = (stats.calls || 0) + 1;
        if (req.signal && req.signal.aborted) throw new ProviderError('cancelled', { code: 'provider.cancelled' });
        if (fail === 'error') throw new ProviderError('stub drill: provider error', { status: 503, code: 'provider.http' });
        if (fail === 'timeout') { await sleep(Math.min(req.timeoutMs || 1000, 60000), req.signal); throw new ProviderError('stub drill: timeout', { code: 'provider.timeout' }); }
        if (record.metadata && Number(record.metadata.delay_ms) > 0) await sleep(Number(record.metadata.delay_ms), req.signal);
        const seed = JSON.stringify({ op, m: req.model || null, s: (req.system || []).map(x => x.text), u: req.messages, j: req.json ? req.json.schema : null, i: req.input || null, img: req.image ? req.image.base64.length : 0 });
        const rnd = seeded(seed);
        const model = req.model || 'stub-1';
        if (op === 'embed') {
            const inputs = Array.isArray(req.input) ? req.input : [String(req.input || '')];
            const vectors = inputs.map((t) => {
                const r = seeded(`embed:${t}`);
                const v = Array.from({ length: 64 }, () => r() * 2 - 1);
                const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0)) || 1;
                return v.map(x => Math.round((x / norm) * 1e6) / 1e6);
            });
            return { vectors, model, synthetic: true, usage: { input: inputs.reduce((n, t) => n + approxTokens(t), 0), output: 0, cached: 0, estimated: true } };
        }
        if (op === 'image') {
            // One fixed 1x1 PNG per requested image: deterministic, and metered per image like a real provider.
            const n = Math.max(1, Math.min(Number(req.n) || 1, 4));
            const images = Array.from({ length: n }, () => ({ b64: STUB_PNG, url: null, revised_prompt: null }));
            return { images, model, synthetic: true, usage: { input: 0, output: n, cached: 0, estimated: true } };
        }
        if (op === 'transcribe') {
            const n = 2 + Math.floor(rnd() * 3);
            const at = Number(req.offsetSec) || 0;   // a window of a longer recording keeps the recording's times
            const segments = Array.from({ length: n }, (_, i) => ({ start: at + i * 4, end: at + i * 4 + 3.5, text: `(synthetic) ${phrase(rnd, 5)}` }));
            return { text: segments.map(s => s.text).join(' '), segments, model, synthetic: true, usage: { input: 0, output: 0, cached: 0, estimated: true } };
        }
        let json = null;
        let text;
        if (req.json && req.json.schema) {
            json = synthesize(req.json.schema, rnd, 0, req.json.name || 'result');
            text = JSON.stringify(json);
        } else {
            text = textFor(op, req, rnd);
        }
        const inTok = approxTokens((req.system || []).map(x => x.text).join('')) + approxTokens(lastUserText(req)) + (req.image ? 800 : 0);
        return { text, json, model, synthetic: true, usage: { input: inTok, output: approxTokens(text), cached: 0, estimated: true } };
    }

    /** complete: an OpenAI-shaped answer. With tools and no tool result yet it calls the first tool; else it answers. */
    async function complete(req) {
        const o = req.openai || {};
        const msgs = Array.isArray(o.messages) ? o.messages : [];
        const last = msgs[msgs.length - 1] || {};
        const rnd = seeded(`complete:${JSON.stringify(msgs).slice(-2000)}`);
        const inTok = msgs.reduce((n, m) => n + approxTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')), 0);
        const tool = Array.isArray(o.tools) && o.tools.length && last.role !== 'tool' && o.tool_choice !== 'none' ? o.tools[0] : null;
        const stream = typeof req.onDelta === 'function' ? req.onDelta : null;
        if (tool && tool.function) {
            const args = tool.function.parameters ? synthesize(tool.function.parameters, rnd, 0, 'arguments') : {};
            const call = { id: `call_${crypto.createHash('sha256').update(JSON.stringify(msgs)).digest('hex').slice(0, 24)}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(args) } };
            if (stream) {
                // As OpenAI streams a call: the id and name first, then the arguments in pieces, then the finish.
                stream({ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] }, finish_reason: null, model: req.model || 'stub-1' });
                for (const piece of call.function.arguments.match(/.{1,8}/gs) || []) stream({ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null, model: req.model || 'stub-1' });
                stream({ index: 0, delta: {}, finish_reason: 'tool_calls', model: req.model || 'stub-1' });
            }
            return { completion: { choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }] }, text: '', model: req.model || 'stub-1', synthetic: true, usage: { input: inTok, output: 20, cached: 0, estimated: true } };
        }
        const text = last.role === 'tool' ? `(synthetic) the tool answered: ${String(last.content || '').slice(0, 80)}` : `(synthetic) ${phrase(rnd, 8)}`;
        if (stream) {
            const words = text.split(/(?<= )/);
            words.forEach((w, i) => stream({ index: 0, delta: i === 0 ? { role: 'assistant', content: w } : { content: w }, finish_reason: null, model: req.model || 'stub-1' }));
            stream({ index: 0, delta: {}, finish_reason: 'stop', model: req.model || 'stub-1' });
        }
        return { completion: { choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }, text, model: req.model || 'stub-1', synthetic: true, usage: { input: inTok, output: approxTokens(text), cached: 0, estimated: true } };
    }

    /** messages: an Anthropic-shaped answer, streamed as Anthropic's own events when asked (POST /v1/messages). */
    async function messages(req) {
        const msgs = Array.isArray(req.messages) ? req.messages : [];
        const last = msgs[msgs.length - 1] || {};
        const rnd = seeded(`messages:${JSON.stringify(msgs).slice(-2000)}`);
        const inTok = msgs.reduce((n, m) => n + approxTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')), 0)
            + approxTokens((Array.isArray(req.system) ? req.system : []).map(x => x && x.text).join(''));
        const hasResult = Array.isArray(last.content) && last.content.some(c => c && c.type === 'tool_result');
        const tool = Array.isArray(req.tools) && req.tools.length && !hasResult && !(req.tool_choice && req.tool_choice.type === 'none') ? req.tools[0] : null;
        const model = req.model || 'stub-1';
        const digest = crypto.createHash('sha256').update(JSON.stringify(msgs)).digest('hex').slice(0, 24);
        let content;
        let stop;
        if (tool && tool.name) {
            content = [{ type: 'tool_use', id: `toolu_${digest}`, name: tool.name, input: tool.input_schema ? synthesize(tool.input_schema, rnd, 0, 'input') : {} }];
            stop = 'tool_use';
        } else {
            const text = hasResult ? `(synthetic) the tool answered: ${String(last.content.find(c => c && c.type === 'tool_result').content || '').slice(0, 80)}` : `(synthetic) ${phrase(rnd, 8)}`;
            content = [{ type: 'text', text }];
            stop = 'end_turn';
        }
        const outTok = approxTokens(JSON.stringify(content));
        const message = { id: `msg_${digest}`, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null,
            usage: { input_tokens: inTok, output_tokens: outTok, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
        if (typeof req.onDelta === 'function') {
            req.onDelta({ event: 'message_start', data: { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } } });
            content.forEach((block, index) => {
                if (block.type === 'text') {
                    req.onDelta({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
                    for (const piece of block.text.split(/(?<= )/)) req.onDelta({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } } });
                } else {
                    req.onDelta({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { ...block, input: {} } } });
                    req.onDelta({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } } });
                }
                req.onDelta({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
            });
            req.onDelta({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outTok } } });
            req.onDelta({ event: 'message_stop', data: { type: 'message_stop' } });
        }
        return { message, text: content.filter(c => c.type === 'text').map(c => c.text).join(''), model, synthetic: true, usage: { input: inTok, output: outTok, cached: 0, estimated: true } };
    }

    const adapter = {
        key: record.key,
        kind: 'stub',
        synthetic: true,
        supports: () => true,
        complete,
        messages,
        transcribe: async (req) => await run('transcribe', req),
        embed: async (req) => await run('embed', req),
        image: async (req) => await run('image', req),
    };
    for (const op of ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich']) adapter[op] = async (req) => await run(op, req);
    return adapter;
}

module.exports = { createStubProvider, synthesize, seeded, STUB_PNG };
