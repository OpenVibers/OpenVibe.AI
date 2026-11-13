'use strict';
/**
 * fal.ai (server/providers/fal.js): hosted models behind one key and one bill.
 *
 * fal runs every model as an endpoint: POST https://fal.run/{model id} with `Authorization: Key <key>`
 * and a JSON body answers with the model's own JSON. The catalogue's short model name maps to fal's
 * endpoint id here (ENDPOINTS); a name the catalogue does not know is sent as the endpoint id itself.
 *
 * Pictures today: FLUX.1 [schnell] is $0.003 per megapixel and fal bills by rounding up to the next
 * whole megapixel (fal's own model page, read 2026-11-13). The picture is metered per picture:
 * usage.output is the number of pictures, like every other image adapter.
 */
const { ProviderError, postJson } = require('./common');

const DEFAULT_BASE_URL = 'https://fal.run';

/** fal's endpoint id for each model the catalogue names. */
const ENDPOINTS = Object.freeze({
    'flux-schnell': 'fal-ai/flux/schnell',
});

/** fal's named sizes; the catalogue asks for pixels, fal names them. */
const SIZES = Object.freeze({
    '1024x1024': 'square_hd',
    '1024x1536': 'portrait_hd',
    '1536x1024': 'landscape_hd',
});

function createFalProvider(record, { apiKey = '', fetchImpl = globalThis.fetch } = {}) {
    const baseUrl = String(record.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const headers = () => (apiKey ? { Authorization: `Key ${apiKey}` } : {});

    /**
     * One picture from a prompt. req: { model, prompt, n, size, signal, timeoutMs }.
     * → { images: [{ url, b64, content_type }], model, usage: { input: 0, output: pictures, cached: 0 } }
     */
    async function image(req) {
        const model = String(req.model || 'flux-schnell');
        const prompt = String(req.prompt || '').trim();
        if (!prompt) throw new ProviderError('image needs a prompt', { code: 'provider.input' });
        const body = { prompt, num_images: Math.max(1, Math.min(Number(req.n) || 1, 4)) };
        if (req.size) body.image_size = SIZES[String(req.size)] || String(req.size);
        const j = await postJson(`${baseUrl}/${ENDPOINTS[model] || model}`, headers(), body, { signal: req.signal, timeoutMs: req.timeoutMs, fetchImpl });
        const list = (Array.isArray(j.images) ? j.images : []).filter((i) => i && (i.url || i.b64_json))
            .map((i) => ({ url: i.url || null, b64: i.b64_json || null, content_type: i.content_type || null }));
        if (!list.length) throw new ProviderError('fal returned no picture', { code: 'provider.output' });
        return { images: list, model, usage: { input: 0, output: list.length, cached: 0 } };
    }

    return { key: record.key, kind: 'fal', synthetic: false, image, supports: (f) => f === 'image' };
}

module.exports = { createFalProvider, ENDPOINTS, SIZES };
