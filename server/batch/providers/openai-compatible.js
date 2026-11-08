'use strict';
/**
 * The OpenAI-compatible batch API, as one adapter (BA2).
 *
 * The shape is the one OpenAI's Batch API documents, and the one DashScope, Moonshot and DeepInfra
 * copy for their OpenAI-compatible endpoints:
 *
 *   1. upload a JSONL file   POST {base}/files         purpose "batch", one request per line;
 *   2. create a batch        POST {base}/batches       input_file_id, endpoint, completion_window;
 *   3. poll the batch        GET  {base}/batches/{id}  status, output_file_id, error_file_id;
 *   4. read the answers      GET  {base}/files/{id}/content   one JSON line per request.
 *
 * A line of the file is an ordinary Chat Completions request with the caller's own id:
 *
 *   {"custom_id":"bni_...","method":"POST","url":"/v1/chat/completions","body":{"model":"...","messages":[...]}}
 *
 * The provider answers with the same custom_id, which is how an answer finds the item it belongs to
 * (server/batch/batcher.js). Nothing here touches the database or the money: the adapter only moves
 * bytes and says what its tier costs.
 */

/** The endpoint the batch posts to: the OpenAI-compatible chat completions path. */
const CHAT_ENDPOINT = '/v1/chat/completions';

/** The window the provider promises for its answers. */
const COMPLETION_WINDOW = '24h';

class BatchProviderError extends Error {
    constructor(message, { code = 'batch.provider_error', status = 502 } = {}) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

/**
 * One JSONL line per item, in the order the items were given.
 *
 * The custom_id is the item's own id, so the answers can be matched back without guessing. The
 * shape of the request inside the line is the Chat Completions body the provider expects.
 */
function buildLines(items) {
    return items.map((item) => JSON.stringify({
        custom_id: item.customId,
        method: 'POST',
        url: item.url || CHAT_ENDPOINT,
        body: item.body,
    }));
}

/** The size of the file, in bytes, as the provider will count it. */
function byteLength(lines) {
    // One newline per line, as a JSONL file has.
    return lines.reduce((n, line) => n + Buffer.byteLength(line, 'utf8') + 1, 0);
}

/**
 * The adapter.
 *
 *   baseUrl   the provider's OpenAI-compatible base (with the version segment)
 *   apiKey    the provider's key (never logged, never returned)
 *   fetchImpl the fetch to use (the tests pass a stub server)
 *   limits    what the provider accepts (items, bytes, one model per file)
 */
function createOpenAiCompatibleAdapter({ baseUrl, apiKey, fetchImpl = globalThis.fetch, limits = {}, timeoutMs = 60000 } = {}) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const maxItems = Number(limits.maxItems) > 0 ? Number(limits.maxItems) : 10000;
    const maxBytes = Number(limits.maxBytes) > 0 ? Number(limits.maxBytes) : 100 * 1024 * 1024;
    const oneModelPerFile = limits.oneModelPerFile !== false;

    async function call(method, path, { body = null, raw = false } = {}) {
        if (!base) throw new BatchProviderError('this provider has no base URL for its batch API');
        const headers = { Accept: 'application/json' };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        if (body !== null) headers['Content-Type'] = 'application/json';
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, {
                method,
                headers,
                ...(body !== null ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            throw new BatchProviderError(`the provider's batch API is unreachable: ${err && err.message}`, { code: 'batch.provider_unreachable', status: 503 });
        }
        const text = await res.text().catch(() => '');
        if (!res.ok) {
            // The provider's own error, without the key and without the body of the request.
            let detail = text.slice(0, 300);
            try { const j = JSON.parse(text); detail = (j && (j.error && (j.error.message || j.error.code) || j.message)) || detail; } catch { /* keep the text */ }
            throw new BatchProviderError(`the provider's batch API refused the request (${res.status}): ${detail}`, { code: 'batch.provider_refused', status: 502 });
        }
        if (raw) return text;
        try { return JSON.parse(text || '{}'); } catch { return {}; }
    }

    return {
        kind: 'openai-compatible',
        limits: { maxItems, maxBytes, oneModelPerFile },
        completionWindow: COMPLETION_WINDOW,

        /**
         * The file the provider will read: the lines, and their size.
         * The size limit is the provider's own: a file over it is refused there, so it is refused here
         * with the same rule (and never uploaded).
         */
        buildFile(items) {
            if (!Array.isArray(items) || !items.length) throw new BatchProviderError('a batch file needs at least one request');
            if (items.length > maxItems) throw new BatchProviderError(`this provider takes at most ${maxItems} requests in one file`, { code: 'batch.too_many_items', status: 422 });
            if (oneModelPerFile) {
                const models = new Set(items.map((i) => i.body && i.body.model).filter(Boolean));
                if (models.size > 1) throw new BatchProviderError('this provider takes one model per file', { code: 'batch.mixed_models', status: 422 });
            }
            const lines = buildLines(items);
            const bytes = byteLength(lines);
            if (bytes > maxBytes) throw new BatchProviderError(`this provider's file limit is ${maxBytes} bytes and this file is ${bytes}`, { code: 'batch.file_too_large', status: 422 });
            return { lines, bytes };
        },

        /** Upload the file and create the batch. → { batchId } */
        async submit({ items, completionWindow = COMPLETION_WINDOW, metadata = null } = {}) {
            const file = this.buildFile(items);
            const uploaded = await call('POST', '/files', {
                body: { purpose: 'batch', file: file.lines.join('\n') },
            });
            const fileId = uploaded && uploaded.id;
            if (!fileId) throw new BatchProviderError('the provider did not name the uploaded file');
            const created = await call('POST', '/batches', {
                body: {
                    input_file_id: fileId,
                    endpoint: CHAT_ENDPOINT,
                    completion_window: completionWindow,
                    ...(metadata ? { metadata } : {}),
                },
            });
            const batchId = created && created.id;
            if (!batchId) throw new BatchProviderError('the provider did not name the batch');
            return { batchId, fileId, bytes: file.bytes, items: items.length };
        },

        /** The state of the batch: { status, outputFileId, errorFileId } */
        async poll({ batchId } = {}) {
            const b = await call('GET', `/batches/${encodeURIComponent(batchId)}`);
            return {
                status: String(b.status || 'in_progress'),
                outputFileId: b.output_file_id || null,
                errorFileId: b.error_file_id || null,
                raw: b,
            };
        },

        /** The answers, as the raw JSONL the provider wrote. */
        async download({ fileId } = {}) {
            if (!fileId) return '';
            return call('GET', `/files/${encodeURIComponent(fileId)}/content`, { raw: true });
        },

        /**
         * The answers, in the shape every adapter returns: one entry per request, in the provider's own
         * order, each one carrying the custom_id it was asked under (so the answer finds its item) and,
         * when the request failed, the provider's own error.
         *
         * A line of OpenAI's output file is
         *   { id, custom_id, response: { status_code, body: { choices, usage } }, error: null }
         * and a line of its ERROR file is
         *   { id, custom_id, response: null, error: { code, message } }
         */
        parseResults(text) {
            const out = [];
            for (const line of String(text || '').split('\n')) {
                if (!line.trim()) continue;
                let row;
                try { row = JSON.parse(line); } catch { continue; }
                const body = row.response && row.response.body;
                const err = row.error || null;
                if (!body || err) {
                    out.push({
                        custom_id: row.custom_id,
                        ok: false,
                        error: {
                            code: String((err && (err.code || err.type)) || 'batch.item_failed'),
                            detail: String((err && (err.message || err.detail)) || 'the provider failed this request').slice(0, 500),
                        },
                    });
                    continue;
                }
                const choice = (body.choices && body.choices[0]) || null;
                const message = choice && (choice.message || null);
                const text = (message && typeof message.content === 'string')
                    ? message.content
                    : (choice && typeof choice.text === 'string' ? choice.text : '');
                const usage = body.usage || {};
                const details = usage.prompt_tokens_details || {};
                out.push({
                    custom_id: row.custom_id,
                    ok: true,
                    // The raw answer's choices, so a complete run (ai.complete) keeps its tool calls and finish
                    // reason too; the text is what a chat/generate step shapes.
                    output: { text, completion: { choices: body.choices || [], system_fingerprint: body.system_fingerprint || null } },
                    usage: {
                        input: Number(usage.prompt_tokens || 0),
                        output: Number(usage.completion_tokens || 0),
                        cached: Number(details.cached_tokens || 0),
                        cache_write: 0,
                    },
                });
            }
            return out;
        },
    };
}

module.exports = { createOpenAiCompatibleAdapter, BatchProviderError, CHAT_ENDPOINT, COMPLETION_WINDOW };
