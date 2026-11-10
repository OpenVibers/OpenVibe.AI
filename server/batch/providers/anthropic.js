'use strict';
/**
 * Anthropic's Message Batches (BA2).
 *
 * The shape, as documented on Anthropic's own batch page:
 *
 *   POST {base}/messages/batches   the requests go in the BODY (there is no file here):
 *                                    { requests: [ { custom_id, params: { model, max_tokens, messages } } ] }
 *   GET  {base}/messages/batches/{id}   processing_status, request_counts, results_url
 *   GET  {results_url}                   the answers, one JSON line per request
 *
 * A line of the answers is either
 *
 *   { custom_id, result: { type: 'succeeded', message: { content: [ { type: 'text', text } ] } } }
 *   { custom_id, result: { type: 'error', error: { type, message } } }
 *
 * The discount is half the list price, the window is 24 hours, and one batch carries at most 100 000
 * requests or 256 MB. Those three numbers are read on Anthropic's documentation page, not guessed.
 *
 * The provider is not enabled yet (no production key), so nothing here runs in production yet: the
 * adapter is written so that turning the provider on is a one-line change in server/batch/providers.
 */
const BatchProviderError = require('./openai-compatible').BatchProviderError;

/** The window Anthropic promises for its answers. */
const COMPLETION_WINDOW = '24h';

/** Anthropic needs a max_tokens on every message; the batcher asks for a bounded answer. */
const DEFAULT_MAX_TOKENS = 4096;

/** One text content block, from a string or an array of OpenAI/Anthropic-style text parts. */
function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return String(content == null ? '' : content);
    return content.map((p) => (typeof p === 'string' ? p : (p && (p.text || p.content)) || '')).filter(Boolean).join('\n');
}

/**
 * The batcher builds an OpenAI Chat Completions body (server/workflows/engine.js buildBody). Anthropic's
 * Message Batches take system separately and only user/assistant messages, so the same words are moved
 * to the shape it documents: a system message becomes the system array, the rest keep their role order.
 */
function paramsOf(body = {}) {
    const system = [];
    const fromBody = body.system == null ? '' : (Array.isArray(body.system) ? body.system.map((b) => (typeof b === 'string' ? b : b && b.text || '')).join('\n\n') : String(body.system));
    if (fromBody.trim()) system.push({ type: 'text', text: fromBody });
    const messages = [];
    for (const m of body.messages || []) {
        if (!m || !m.role) continue;
        const text = textOf(m.content);
        if (m.role === 'system') { if (text.trim()) system.push({ type: 'text', text }); continue; }
        messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text }] });
    }
    return {
        model: body.model,
        max_tokens: body.max_tokens || body.max_completion_tokens || DEFAULT_MAX_TOKENS,
        messages,
        ...(system.length ? { system } : {}),
        ...(body.temperature != null ? { temperature: body.temperature } : {}),
    };
}

function createAnthropicAdapter({ baseUrl, apiKey, fetchImpl = globalThis.fetch, limits = {}, timeoutMs = 60000 } = {}) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const maxItems = Number(limits.maxItems) > 0 ? Number(limits.maxItems) : 100000;
    const maxBytes = Number(limits.maxBytes) > 0 ? Number(limits.maxBytes) : 256 * 1024 * 1024;

    async function call(method, path, { body = null, raw = false } = {}) {
        if (!base) throw new BatchProviderError('this provider has no base URL for its batch API');
        const headers = { Accept: 'application/json', 'anthropic-version': '2023-06-01' };
        if (apiKey) headers['x-api-key'] = apiKey;
        if (body !== null) headers['Content-Type'] = 'application/json';
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, {
                method, headers,
                ...(body !== null ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            throw new BatchProviderError(`the provider's batch API is unreachable: ${err && err.message}`, { code: 'batch.provider_unreachable', status: 503 });
        }
        const text = await res.text().catch(() => '');
        if (!res.ok) {
            let detail = text.slice(0, 300);
            try { const j = JSON.parse(text); detail = (j && j.error && (j.error.message || j.error.code)) || detail; } catch { /* keep the text */ }
            throw new BatchProviderError(`the provider's batch API refused the request (${res.status}): ${detail}`, { code: 'batch.provider_refused', status: 502 });
        }
        if (raw) return text;
        try { return JSON.parse(text || '{}'); } catch { return {}; }
    }

    return {
        kind: 'anthropic',
        limits: { maxItems, maxBytes, oneModelPerFile: false },
        completionWindow: COMPLETION_WINDOW,

        /** The requests, in the body: there is no file here. */
        buildFile(items) {
            if (!Array.isArray(items) || !items.length) throw new BatchProviderError('a batch needs at least one request');
            if (items.length > maxItems) throw new BatchProviderError(`this provider takes at most ${maxItems} requests in one batch`, { code: 'batch.too_many_items', status: 422 });
            const bytes = Buffer.byteLength(JSON.stringify(items), 'utf8');
            if (bytes > maxBytes) throw new BatchProviderError(`this provider's limit is ${maxBytes} bytes and this batch is ${bytes}`, { code: 'batch.file_too_large', status: 422 });
            return { requests: items.map((i) => ({ custom_id: i.customId, params: paramsOf(i.body) })), bytes };
        },

        async submit({ items, completionWindow = COMPLETION_WINDOW, metadata = null } = {}) {
            const file = this.buildFile(items);
            const created = await call('POST', '/messages/batches', { body: { requests: file.requests, ...(metadata ? { metadata } : {}) } });
            const batchId = created && created.id;
            if (!batchId) throw new BatchProviderError('the provider did not name the batch');
            return { batchId, bytes: file.bytes, items: items.length };
        },

        async poll({ batchId } = {}) {
            const b = await call('GET', `/messages/batches/${encodeURIComponent(batchId)}`);
            const status = String(b.processing_status || 'in_progress');
            return { status, outputFileId: b.results_url || null, errorFileId: null, counts: b.request_counts || null, raw: b };
        },

        /** The answers, as the raw JSONL the provider wrote (the results URL is absolute). */
        async download({ fileId } = {}) {
            if (!fileId) return '';
            if (/^https?:\/\//.test(fileId)) {
                const res = await fetchImpl(fileId, { headers: { Accept: 'application/json', 'x-api-key': apiKey || '' }, signal: AbortSignal.timeout(timeoutMs) });
                if (!res.ok) throw new BatchProviderError(`the provider's results file could not be read (${res.status})`, { code: 'batch.provider_refused', status: 502 });
                return res.text();
            }
            return call('GET', `/messages/batches/${encodeURIComponent(fileId)}`, { raw: true });
        },

        /** The answers, in the shape every adapter returns. */
        parseResults(text) {
            const out = [];
            for (const line of String(text || '').split('\n')) {
                if (!line.trim()) continue;
                let row;
                try { row = JSON.parse(line); } catch { continue; }
                const result = row.result || {};
                if (result.type === 'succeeded') {
                    const content = (result.message && result.message.content) || [];
                    const answer = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('');
                    const usage = result.message && result.message.usage;
                    out.push({
                        custom_id: row.custom_id,
                        ok: true,
                        output: { text: answer },
                        usage: { input: (usage && usage.input_tokens) || 0, output: (usage && usage.output_tokens) || 0, cached: 0, cache_write: 0 },
                    });
                } else {
                    const err = result.error || {};
                    out.push({ custom_id: row.custom_id, ok: false, error: { code: String(err.type || 'batch.item_failed'), detail: String(err.message || 'the provider failed this request') } });
                }
            }
            return out;
        },
    };
}

module.exports = { createAnthropicAdapter, COMPLETION_WINDOW };
