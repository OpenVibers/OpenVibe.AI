'use strict';
/**
 * Ideogram (server/providers/ideogram.js): picture generation and SVG.
 *
 * Every v2 endpoint follows one pattern, POST /v2/{content}/{action}/{model}, with the key in the
 * `Api-Key` header and a multipart/form-data body. The picture models answer straight away with a
 * `data` array of pictures; the SVG endpoint (ideogram-vector-1) answers with a generation id and
 * the picture is fetched from GET /v2/generations/{id} (Ideogram's own API reference, read 2026-11-13).
 *
 * Price: the API is prepaid by credit, $0.01 a credit, and a generation costs the credits its model
 * and rendering settings need; the per-operation price list lives in the account's own Settings
 * (ideogram.ai/pricing, read 2026-11-13). The catalogue therefore carries the credit price, never a
 * per-picture number nobody publishes.
 */
const { ProviderError, getJson, sleep, deadline, describeAbort } = require('./common');

const DEFAULT_BASE_URL = 'https://api.ideogram.ai';

/** The endpoint of each model the catalogue names. */
const ENDPOINTS = Object.freeze({
    'ideogram-4-5': '/v2/image/generate/ideogram-4-5',
    'ideogram-vector-1': '/v2/svg/generate/ideogram-vector-1',
});

/** Ideogram names its shapes; the catalogue asks for pixels. */
const ASPECTS = Object.freeze({ '1024x1024': '1:1', '1024x1536': '2:3', '1536x1024': '3:2' });

/** How long the vector endpoint may take before the adapter gives up. */
const POLL_MS = 1200;
const POLL_MAX = 60;

/** The vector model answers in SVG. */
const isVector = (model) => /vector/.test(String(model || ''));

function createIdeogramProvider(record, { apiKey = '', fetchImpl = globalThis.fetch } = {}) {
    const baseUrl = String(record.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const headers = () => (apiKey ? { 'Api-Key': apiKey, accept: 'application/json' } : {});

    /** The pictures in one Ideogram answer. */
    const pictures = (data, model) => (Array.isArray(data) ? data : []).filter((d) => d && (d.url || d.svg))
        .map((d) => ({ url: d.url || null, b64: null, svg: d.svg || null, format: isVector(model) ? 'svg' : null }));

    /**
     * One picture from a prompt. req: { model, prompt, n, size, signal, timeoutMs }.
     * → { images: [{ url, svg, format }], model, usage: { input: 0, output: pictures, cached: 0 } }
     */
    async function image(req) {
        const model = String(req.model || 'ideogram-4-5');
        const prompt = String(req.prompt || '').trim();
        if (!prompt) throw new ProviderError('image needs a prompt', { code: 'provider.input' });
        const form = new FormData();
        form.append('prompt', prompt);
        form.append('num_images', String(Math.max(1, Math.min(Number(req.n) || 1, 4))));
        if (req.size) form.append('aspect_ratio', ASPECTS[String(req.size)] || String(req.size));
        let res;
        try {
            res = await fetchImpl(`${baseUrl}${ENDPOINTS[model] || `/v2/image/generate/${model}`}`, {
                method: 'POST', headers: headers(), body: form, signal: deadline(req.signal, req.timeoutMs),
            });
        } catch (err) {
            throw describeAbort(err, req.signal, req.timeoutMs) || new ProviderError(`connection failed: ${err.message}`, { code: 'provider.unreachable' });
        }
        const raw = await res.text().catch(() => '');
        if (!res.ok) throw new ProviderError(`ideogram HTTP ${res.status}: ${raw.slice(0, 300)}`, { status: res.status, code: res.status === 401 || res.status === 403 ? 'provider.auth' : 'provider.http' });
        let j = {};
        try { j = raw ? JSON.parse(raw) : {}; } catch { j = {}; }
        const direct = pictures(j.data, model);
        if (direct.length) return { images: direct, model, usage: { input: 0, output: direct.length, cached: 0 } };
        // The vector endpoint answers with a generation id: the picture is fetched from the generations address.
        const id = j.generation_id;
        if (!id) throw new ProviderError('ideogram returned no picture', { code: 'provider.output' });
        for (let attempt = 0; attempt < POLL_MAX; attempt++) {
            const g = await getJson(`${baseUrl}/v2/generations/${encodeURIComponent(String(id))}`, headers(), { signal: req.signal, timeoutMs: req.timeoutMs, fetchImpl });
            const status = String(g.status || '');
            if (status === 'completed') {
                const list = pictures(g.data, model);
                if (!list.length) throw new ProviderError('ideogram returned no picture', { code: 'provider.output' });
                return { images: list, model, usage: { input: 0, output: list.length, cached: 0 } };
            }
            if (status === 'failed') throw new ProviderError(`ideogram generation failed: ${g.failure_reason || 'no reason given'}`, { code: 'provider.output' });
            await sleep(POLL_MS, req.signal);
        }
        throw new ProviderError('ideogram did not finish in time', { code: 'provider.timeout' });
    }

    return { key: record.key, kind: 'ideogram', synthetic: false, image, supports: (f) => f === 'image' };
}

module.exports = { createIdeogramProvider, ENDPOINTS, ASPECTS, isVector };
