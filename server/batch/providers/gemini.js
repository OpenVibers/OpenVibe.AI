'use strict';
/**
 * The Gemini Batch API (BA2).
 *
 * NOT VERIFIED. Gemini's batch documentation page is served to a browser (it redirects into AI Studio),
 * so the endpoint below could not be read on the provider's own page while this was written. The
 * adapter is therefore written but NOT enabled: server/batch/providers/index.js keeps it disabled and
 * the network never sends a file to an endpoint nobody read. When the page can be read, the shape
 * below is the one to check, and the provider is enabled only if it matches.
 *
 * The shape the adapter speaks (the Gemini API's batch mode):
 *
 *   POST {base}/models/{model}:batchGenerateContent   the requests go in the body (inline) or in a
 *                                                      file the File API uploaded, and the answer names
 *                                                      the batch (batches/...).
 *   GET  {base}/{batch name}                          the state of the batch and, when it is done,
 *                                                      the inlined answers.
 *
 * The discount on the provider's own page is half the list price, the window is 24 hours, and one
 * batch carries at most 10 000 requests. Those numbers are what the registry records; the endpoint
 * itself is what could not be read.
 */
const BatchProviderError = require('./openai-compatible').BatchProviderError;

/** The window the provider promises for its answers. */
const COMPLETION_WINDOW = '24h';

function createGeminiAdapter({ baseUrl, apiKey, fetchImpl = globalThis.fetch, limits = {}, timeoutMs = 60000 } = {}) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const maxItems = Number(limits.maxItems) > 0 ? Number(limits.maxItems) : 10000;
    const maxBytes = Number(limits.maxBytes) > 0 ? Number(limits.maxBytes) : 100 * 1024 * 1024;

    async function call(method, path, { body = null } = {}) {
        if (!base) throw new BatchProviderError('this provider has no base URL for its batch API');
        const headers = { Accept: 'application/json' };
        if (apiKey) headers['x-goog-api-key'] = apiKey;
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
            try { const j = JSON.parse(text); detail = (j && j.error && j.error.message) || detail; } catch { /* keep the text */ }
            throw new BatchProviderError(`the provider's batch API refused the request (${res.status}): ${detail}`, { code: 'batch.provider_refused', status: 502 });
        }
        try { return JSON.parse(text || '{}'); } catch { return {}; }
    }

    return {
        kind: 'gemini',
        limits: { maxItems, maxBytes, oneModelPerFile: true },
        completionWindow: COMPLETION_WINDOW,

        /** The requests, inline. */
        buildFile(items) {
            if (!Array.isArray(items) || !items.length) throw new BatchProviderError('a batch needs at least one request');
            if (items.length > maxItems) throw new BatchProviderError(`this provider takes at most ${maxItems} requests in one batch`, { code: 'batch.too_many_items', status: 422 });
            const requests = items.map((i) => ({ request: { contents: [{ role: 'user', parts: [{ text: i.body.messages.map((m) => m.content).join('\n') }] }] } }));
            const bytes = Buffer.byteLength(JSON.stringify(requests), 'utf8');
            if (bytes > maxBytes) throw new BatchProviderError(`this provider's limit is ${maxBytes} bytes and this batch is ${bytes}`, { code: 'batch.file_too_large', status: 422 });
            return { requests, bytes };
        },

        async submit({ items, completionWindow = COMPLETION_WINDOW, metadata = null } = {}) {
            const file = this.buildFile(items);
            const model = String(items[0].body.model || '').replace(/^models\//, '');
            if (!model) throw new BatchProviderError('this provider needs one model for the batch');
            const created = await call('POST', `/models/${encodeURIComponent(model)}:batchGenerateContent`, {
                body: { batch: { display_name: (metadata && metadata.display_name) || 'openvibe-batch', input_config: { requests: { requests: file.requests } } } },
            });
            const name = created && created.name;
            if (!name) throw new BatchProviderError('the provider did not name the batch');
            return { batchId: name, bytes: file.bytes, items: items.length };
        },

        async poll({ batchId } = {}) {
            const b = await call('GET', `/${String(batchId || '').replace(/^\//, '')}`);
            const state = String(b.state || 'BATCH_STATE_UNSPECIFIED');
            const done = /SUCCEEDED/i.test(state);
            const failed = /FAILED|CANCELLED|EXPIRED/i.test(state);
            return { status: done ? 'completed' : (failed ? 'failed' : 'in_progress'), outputFileId: done ? 'inline' : null, errorFileId: null, raw: b };
        },

        async download({ fileId } = {}) {
            // The answers come inline in the batch's own answer, not in a separate file.
            return fileId === 'inline' ? '' : '';
        },

        /** The answers, in the shape every adapter returns. */
        parseResults(text, { raw = null } = {}) {
            const out = [];
            const inlined = (raw && raw.response && raw.response.inlinedResponses && raw.response.inlinedResponses.inlinedResponses) || [];
            for (const row of inlined) {
                const custom = (row.request && row.request.customId) || row.custom_id;
                const candidate = (row.response && row.response.candidates && row.response.candidates[0]) || null;
                const parts = (candidate && candidate.content && candidate.content.parts) || [];
                out.push({
                    custom_id: custom,
                    ok: Boolean(candidate),
                    output: { text: parts.map((p) => p.text || '').join('') },
                    usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
                });
            }
            for (const line of String(text || '').split('\n')) {
                if (!line.trim()) continue;
                let row;
                try { row = JSON.parse(line); } catch { continue; }
                out.push({ custom_id: row.custom_id, ok: Boolean(row.response), output: { text: String((row.response && row.response.text) || '') }, usage: { input: 0, output: 0, cached: 0, cache_write: 0 } });
            }
            return out;
        },
    };
}

module.exports = { createGeminiAdapter, COMPLETION_WINDOW };
