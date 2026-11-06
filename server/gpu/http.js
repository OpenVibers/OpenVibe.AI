'use strict';
/**
 * One HTTP call to a GPU marketplace. The API key never leaves this process: it goes in the
 * Authorization header, never in a URL, and a failure never carries the key back.
 */
const { AiError } = require('../util');

async function apiJson(fetchImpl, url, { method = 'GET', body = null, key = null, label = 'the marketplace' } = {}) {
    const headers = { Accept: 'application/json' };
    if (body != null) headers['Content-Type'] = 'application/json';
    if (key) headers.Authorization = 'Bearer ' + key;
    let res;
    try {
        res = await fetchImpl(url, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
    } catch (err) {
        throw new AiError(502, 'gpu.marketplace_unreachable', label + ' did not answer: ' + String(err && err.message).slice(0, 200));
    }
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
        const detail = (json && (json.detail || json.message || json.error)) || String(res.status);
        throw new AiError(502, 'gpu.marketplace_error', label + ' refused: ' + String(detail).slice(0, 200) + ' (' + res.status + ')');
    }
    return json;
}

module.exports = { apiJson };
