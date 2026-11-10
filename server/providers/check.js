'use strict';

const { providerSecret } = require('../util');
const { testProviderKey } = require('../owner-inputs');
const { guardedFetch } = require('./guarded-fetch');

/** One explicit owner check, with no inference, retries, redirects or fallback. Never retain upstream text. */
async function checkProvider(provider, { env = process.env, fetchImpl = guardedFetch, now = Date.now } = {}) {
    const started = now();
    let calls = 0;
    let httpStatus = null;
    const finish = (ok, error = null, method = null) => ({
        ok, error, method, http_status: httpStatus, requests: calls,
        latency_ms: Math.max(0, now() - started), checked_at: new Date(started).toISOString(),
    });
    const key = providerSecret(provider, env);
    if (provider.auth_mode !== 'none' && !key) return finish(false, 'key_not_set');
    if (!provider.base_url) return finish(false, 'base_url_not_set');
    let origin;
    try { origin = new URL(provider.base_url).origin; } catch { return finish(false, 'invalid_base_url'); }
    let failure = 'request_failed';
    const once = async (url, init = {}) => {
        const target = new URL(String(url));
        if (target.origin !== origin || target.protocol !== 'https:' || target.username || target.password) {
            failure = 'endpoint_origin_mismatch';
            throw new Error(failure);
        }
        if (calls) { failure = 'request_limit'; throw new Error(failure); }
        calls++;
        try {
            const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
            httpStatus = response.status;
            if (!response.ok) failure = `http_${response.status}`;
            return response;
        } catch (err) {
            failure = ['AbortError', 'TimeoutError'].includes(err && err.name) ? 'timeout' : 'connection_failed';
            throw new Error(failure);
        }
    };
    let method = 'models';
    try {
        if (provider.metadata?.check_endpoint) {
            method = 'account';
            const header = provider.metadata.auth_header || (provider.auth_mode === 'x-api-key' ? 'x-api-key' : 'Authorization');
            const headers = provider.auth_mode === 'none' ? {} : { [header]: header.toLowerCase() === 'authorization' ? `Bearer ${key}` : key };
            const result = await once(provider.metadata.check_endpoint, { method: 'GET', headers });
            // Account data and key labels are deliberately discarded.
            await result.body?.cancel();
            return finish(result.ok, result.ok ? null : failure, method);
        }
        if (provider.kind === 'http' && provider.metadata?.search_adapters?.length) {
            method = 'search';
            const { adapters } = require('../search');
            const adapter = provider.metadata.search_adapters.map(id => adapters.find(a => a.id === id)).find(Boolean);
            if (!adapter) return finish(false, 'check_not_supported', method);
            await adapter.search({ q: 'OpenVibe', limit: 1 }, {
                key, fetchImpl: once, now, env: { ...env, ...(adapter.setting ? { [adapter.setting]: provider.base_url } : {}) },
            });
            return finish(true, null, method);
        }
        const result = await testProviderKey(provider, key, { fetchImpl: once });
        return finish(result.ok, result.ok ? null : httpStatus >= 200 && httpStatus < 300 ? 'invalid_response' : failure, method);
    } catch {
        return finish(false, failure, method);
    }
}

module.exports = { checkProvider };
