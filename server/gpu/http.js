'use strict';
/**
 * One HTTP call to a GPU marketplace. The API key never leaves this process: it goes in the
 * Authorization header, never in a URL, and a failure never carries the key back.
 */
const { AiError } = require('../util');

async function apiJson(fetchImpl, url, { method = 'GET', body = null, key = null, label = 'the marketplace', allowMissing = false, headers: extra = null, keyHeader = 'Authorization', keyPrefix = 'Bearer ' } = {}) {
    const headers = { Accept: 'application/json', ...(extra || {}) };
    if (body != null) headers['Content-Type'] = 'application/json';
    if (key) headers[keyHeader] = keyPrefix + key;
    let res;
    try {
        res = await fetchImpl(url, { method, headers, redirect: 'error', signal: AbortSignal.timeout(15000), body: body != null ? JSON.stringify(body) : undefined });
    } catch (err) {
        throw new AiError(502, 'gpu.marketplace_unreachable', label + ' did not answer');
    }
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (res.status === 404 && allowMissing) return { missing: true };
    if (!res.ok) {
        const detail = (json && (json.detail || json.message || json.error)) || String(res.status);
        throw new AiError(502, 'gpu.marketplace_error', label + ' refused (' + res.status + ')' );
    }
    return json;
}

module.exports = { apiJson };
