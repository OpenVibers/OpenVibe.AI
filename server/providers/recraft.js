'use strict';
/**
 * Recraft (server/providers/recraft.js): raster pictures and editable SVG.
 *
 * One endpoint serves every model: POST https://external.api.recraft.ai/v1/images/generations with
 * `Authorization: Bearer <token>` and { prompt, model }. A model whose name ends in `_vector` answers
 * in SVG — the url then points at an SVG file (Recraft's own API reference, read 2026-11-13).
 *
 * Price: recraftv4_1_vector is $0.08 a picture and recraftv4_1 is $0.035 (recraft.ai's model pages,
 * read 2026-11-13). The catalogue's price is the vector picture, the one the icon studio wants.
 */
const { ProviderError, postJson } = require('./common');

const DEFAULT_BASE_URL = 'https://external.api.recraft.ai/v1';

/** Recraft names its shapes; the catalogue asks for pixels. */
const SIZES = Object.freeze({ '1024x1024': '1:1', '1024x1536': '2:3', '1536x1024': '3:2' });

/** A vector model answers in SVG. */
const isVector = (model) => /_vector$/.test(String(model || ''));

function createRecraftProvider(record, { apiKey = '', fetchImpl = globalThis.fetch } = {}) {
    const baseUrl = String(record.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const headers = () => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});

    /**
     * One picture from a prompt. req: { model, prompt, n, size, signal, timeoutMs }.
     * → { images: [{ url, b64, format }], model, usage: { input: 0, output: pictures, cached: 0 } }
     */
    async function image(req) {
        const model = String(req.model || 'recraftv4_1_vector');
        const prompt = String(req.prompt || '').trim();
        if (!prompt) throw new ProviderError('image needs a prompt', { code: 'provider.input' });
        const body = { prompt, model };
        if (req.size) body.size = SIZES[String(req.size)] || String(req.size);
        const j = await postJson(`${baseUrl}/images/generations`, headers(), body, { signal: req.signal, timeoutMs: req.timeoutMs, fetchImpl });
        const list = (Array.isArray(j.data) ? j.data : []).filter((d) => d && (d.url || d.b64_json))
            .map((d) => ({ url: d.url || null, b64: d.b64_json || null, format: isVector(model) ? 'svg' : null }));
        if (!list.length) throw new ProviderError('recraft returned no picture', { code: 'provider.output' });
        return { images: list, model, usage: { input: 0, output: list.length, cached: 0 } };
    }

    return { key: record.key, kind: 'recraft', synthetic: false, image, supports: (f) => f === 'image' };
}

module.exports = { createRecraftProvider, SIZES, isVector };
