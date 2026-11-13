'use strict';
/**
 * Voyage AI (server/providers/voyage.js): embeddings and reranking.
 *
 * POST https://api.voyageai.com/v1/embeddings with { model, input, input_type } answers with the
 * vectors and the tokens used; POST /v1/rerank with { model, query, documents } answers with the
 * documents' ranks (Voyage's own API reference, read 2026-11-13).
 *
 * Price: voyage-4-lite is $0.02 per 1M tokens, voyage-4 $0.06 and voyage-4-large $0.12; the first
 * 200 million tokens of every account are free. The reranker is $0.05 per 1M tokens (rerank-3) and
 * $0.02 (rerank-3-lite) (docs.voyageai.com/docs/pricing, read 2026-11-13).
 *
 * The reranker is implemented here and priced, but the guided setup has no rerank step and the
 * router has no rerank route yet, so nothing offers it until one exists.
 */
const { ProviderError, postJson } = require('./common');

const DEFAULT_BASE_URL = 'https://api.voyageai.com';

function createVoyageProvider(record, { apiKey = '', fetchImpl = globalThis.fetch } = {}) {
    const baseUrl = String(record.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const headers = () => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});

    /**
     * Texts into vectors. req: { model, input (a text or a list of texts), inputType, signal, timeoutMs }.
     * → { vectors, model, usage: { input: tokens, output: 0, cached: 0 } }
     */
    async function embed(req) {
        const model = String(req.model || 'voyage-4-lite');
        const input = Array.isArray(req.input) ? req.input : [req.input];
        if (!input.length || input.some((t) => typeof t !== 'string' || !t.length)) {
            throw new ProviderError('embedding needs text', { code: 'provider.input' });
        }
        // Voyage reads documents and queries differently; the network embeds documents.
        const body = { model, input, input_type: req.inputType || 'document' };
        const j = await postJson(`${baseUrl}/v1/embeddings`, headers(), body, { signal: req.signal, timeoutMs: req.timeoutMs, fetchImpl });
        const vectors = (Array.isArray(j.data) ? j.data : []).slice()
            .sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0))
            .map((d) => d.embedding);
        if (vectors.length !== input.length) throw new ProviderError('voyage returned the wrong number of vectors', { code: 'provider.output' });
        const u = j.usage || {};
        return { vectors, model, usage: { input: Number(u.total_tokens) || 0, output: 0, cached: 0 } };
    }

    /**
     * A query against documents, ranked. req: { model, query, documents, topK, signal, timeoutMs }.
     * → { results: [{ index, relevance_score }], model, usage: { input: tokens, output: 0, cached: 0 } }
     */
    async function rerank(req) {
        const model = String(req.model || 'rerank-3');
        const documents = Array.isArray(req.documents) ? req.documents : [];
        if (!req.query || !documents.length) throw new ProviderError('rerank needs a query and documents', { code: 'provider.input' });
        const body = { model, query: String(req.query), documents };
        if (req.topK) body.top_k = Number(req.topK);
        const j = await postJson(`${baseUrl}/v1/rerank`, headers(), body, { signal: req.signal, timeoutMs: req.timeoutMs, fetchImpl });
        const results = (Array.isArray(j.data) ? j.data : []).map((d) => ({ index: Number(d.index), relevance_score: Number(d.relevance_score) }));
        if (!results.length) throw new ProviderError('voyage returned no ranking', { code: 'provider.output' });
        const u = j.usage || {};
        return { results, model, usage: { input: Number(u.total_tokens) || 0, output: 0, cached: 0 } };
    }

    return { key: record.key, kind: 'voyage', synthetic: false, embed, rerank, supports: (f) => f === 'embed' || f === 'rerank' };
}

module.exports = { createVoyageProvider };
