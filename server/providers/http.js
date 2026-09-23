'use strict';
/**
 * The configurable local HTTP seam. Any process that speaks this tiny protocol can be a provider
 * (a local model server, a test double, an experimental pipeline):
 *
 *   POST <base_url>
 *   { "operation": "chat|generate|summarize|classify|extract|enrich|embed",
 *     "model": "...", "system": [{text}], "messages": [{role, content}], "json": {name, schema}|null,
 *     "max_tokens": n, "temperature": t, "input": [...] (embed) }
 *   -> { "text": "...", "json": {...}|null, "vectors": [[...]] (embed), "model": "...",
 *        "usage": { "input": n, "output": n, "cached": n }, "synthetic": false }
 *
 * The base URL is operator-configured (provider record), never caller-supplied.
 */
const { postJson } = require('./common');

const OPS = ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'embed'];

function createHttpSeamProvider(record, { apiKey = '', fetchImpl = globalThis.fetch } = {}) {
    const url = String(record.base_url || '').replace(/\/+$/, '');
    const caps = new Set(record.capabilities && record.capabilities.length ? record.capabilities : ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json']);
    const headers = () => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});

    async function call(operation, req) {
        const body = {
            operation, model: req.model || null, system: req.system || [], messages: req.messages || [], json: req.json || null,
            max_tokens: req.maxTokens || null, temperature: req.temperature ?? null, input: req.input || null,
            image: req.image ? { media_type: req.image.mediaType, base64: req.image.base64 } : null,
        };
        const j = await postJson(url, headers(), body, { signal: req.signal, timeoutMs: req.timeoutMs, fetchImpl });
        const u = j.usage || {};
        return {
            text: typeof j.text === 'string' ? j.text : (j.json ? JSON.stringify(j.json) : ''),
            json: j.json && typeof j.json === 'object' ? j.json : null,
            vectors: Array.isArray(j.vectors) ? j.vectors : undefined,
            model: j.model || req.model,
            synthetic: j.synthetic === true,
            usage: { input: Number(u.input) || 0, output: Number(u.output) || 0, cached: Number(u.cached) || 0 },
        };
    }

    const adapter = { key: record.key, kind: 'http', supports: (f) => caps.has(f) };
    for (const op of OPS) adapter[op] = (req) => call(op, req);
    return adapter;
}

module.exports = { createHttpSeamProvider };
