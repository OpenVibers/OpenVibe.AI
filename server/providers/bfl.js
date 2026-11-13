'use strict';
/**
 * Black Forest Labs, the FLUX owner (server/providers/bfl.js).
 *
 * FLUX 3 Image is asynchronous: POST https://api.bfl.ai/v1/flux-3-image with the `x-key` header
 * answers with a `polling_url`; polling that address until the status is Ready gives the picture at
 * `result.sample` — a signed URL that expires after an hour, so the picture is never stored here.
 *
 * Price: FLUX 3 Image is $0.041 a picture at 768 px, $0.048 at 1K, $0.07 at 1.5K, $0.10 at 2K and
 * $0.607 at 4K (bfl.ai/pricing, read 2026-11-13). The catalogue's price is the 1K picture.
 */
const { ProviderError, postJson, getJson, sleep } = require('./common');

const DEFAULT_BASE_URL = 'https://api.bfl.ai';

/** The endpoint of each model the catalogue names. */
const ENDPOINTS = Object.freeze({ 'flux-3-image': '/v1/flux-3-image' });

/** bfl names its shapes; the catalogue asks for pixels. */
const ASPECTS = Object.freeze({ '1024x1024': '1:1', '1024x1536': '2:3', '1536x1024': '3:2' });

/** How long one picture may take: the poll waits a second between tries and gives up after a minute. */
const POLL_MS = 1200;
const POLL_MAX = 60;

/** The polling address must be bfl's own: the key never travels to another host. */
function sameOrigin(url, base) {
    try { return new URL(String(url)).origin === new URL(String(base)).origin; } catch { return false; }
}

function createBflProvider(record, { apiKey = '', fetchImpl = globalThis.fetch } = {}) {
    const baseUrl = String(record.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const headers = () => (apiKey ? { 'x-key': apiKey } : {});

    /**
     * One picture from a prompt. req: { model, prompt, size, signal, timeoutMs }.
     * → { images: [{ url }], model, usage: { input: 0, output: 1, cached: 0 } }
     */
    async function image(req) {
        const model = String(req.model || 'flux-3-image');
        const prompt = String(req.prompt || '').trim();
        if (!prompt) throw new ProviderError('image needs a prompt', { code: 'provider.input' });
        const body = { prompt };
        if (req.size) body.aspect_ratio = ASPECTS[String(req.size)] || String(req.size);
        const submitted = await postJson(`${baseUrl}${ENDPOINTS[model] || `/${model}`}`, headers(), body, { signal: req.signal, timeoutMs: req.timeoutMs, fetchImpl });
        const polling = submitted && submitted.polling_url;
        if (!polling) throw new ProviderError('bfl returned no polling address', { code: 'provider.output' });
        if (!sameOrigin(polling, baseUrl)) throw new ProviderError('bfl returned a polling address on another host', { code: 'provider.output' });
        for (let attempt = 0; attempt < POLL_MAX; attempt++) {
            const j = await getJson(polling, headers(), { signal: req.signal, timeoutMs: req.timeoutMs, fetchImpl });
            const status = String(j.status || '');
            if (status === 'Ready') {
                const sample = j.result && j.result.sample;
                if (!sample) throw new ProviderError('bfl returned no picture', { code: 'provider.output' });
                return { images: [{ url: String(sample), b64: null }], model, usage: { input: 0, output: 1, cached: 0 } };
            }
            if (status && !['Pending', 'Reasoning', 'Generating'].includes(status)) {
                throw new ProviderError(`bfl generation ${status}`, { code: 'provider.output' });
            }
            await sleep(POLL_MS, req.signal);
        }
        throw new ProviderError('bfl did not finish in time', { code: 'provider.timeout' });
    }

    return { key: record.key, kind: 'bfl', synthetic: false, image, supports: (f) => f === 'image' };
}

module.exports = { createBflProvider, ENDPOINTS, ASPECTS };
