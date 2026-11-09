'use strict';
const { guardedFetch } = require('../providers/guarded-fetch');
const { safeLookup } = require('../fetcher');
const net = require('node:net');

function requestFor(hosts, fetchImpl = guardedFetch) {
    return async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.protocol !== 'https:' || url.username || url.password ||
            url.port && url.port !== '443' || !hosts.includes(url.hostname))
            throw new Error('Search endpoint is not allowed');
        const r = await fetchImpl(url.href, {
            ...init, redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { accept: 'application/json', 'user-agent': 'OpenVibe.Exchange/1.0 (https://openvibe.exchange)', ...init.headers },
        });
        // Never include an upstream error or URL: some providers put keys in the query string.
        if (!r.ok) throw Object.assign(new Error('Search engine unavailable'), { unbilled: true });
        const body = await r.json();
        if (body.error || body.code && body.code !== 200) throw new Error('Search engine refused the request');
        return body;
    };
}
const post = (body, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const bearer = (key) => ({ authorization: `Bearer ${key}` });
const query = (base, params) => base + '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v != null));
const since = (freshness, now = Date.now()) => new Date(now - ({ day: 1, month: 30, year: 365 }[freshness] || 0) * 86400000).toISOString();
const web = (r, snippet = r.snippet, published = r.published) => ({ title: String(r.title || ''), url: r.url, snippet: String(snippet || ''), published: published == null ? null : String(published) });
// Remote readers must pass the same public-address rule before receiving a target URL.
// Direct reads also recheck at connect time in guardedFetch (including DNS rebinding).
async function publicTarget(input) {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || net.isIP(url.hostname.replace(/^\[|\]$/g, '')))
        throw new Error('An HTTPS URL without credentials or IP-literal host is required');
    await new Promise((resolve, reject) => safeLookup(url.hostname, { all: true }, (e) => e ? reject(e) : resolve()));
    return url.href;
}
module.exports = { requestFor, post, bearer, query, since, web, publicTarget };
