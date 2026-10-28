'use strict';
/**
 * The Search Fabric's web scope, for MegaSource (OpenVibe.Search, plan 2026-10-28 §4.5):
 *
 *   POST <OV_SEARCH_INTERNAL_URL>/api/v1/query
 *   { q, scopes: ["web"], depth, limit, freshness }
 *
 * Each page keeps the provider that found it, its URL and its dates, so a research citation can
 * name all three. Search's viewer requires `search.query.delegate` of any service token
 * (server/auth.js CAPS.delegate), so that is the capability AI asks Network for:
 *
 *   grant `ai` `search.query.delegate` on audience `openvibe.search`.
 *
 * `search.fabric.query` is the route's public capability in openvibe-contracts; Search does not
 * check it for a service token today. AI asks only for the web scope. A Search that is down,
 * refuses the token or answers nothing never fails a research run: the caller falls back to
 * DeepSeek (server/research/deepseek.js).
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const AUDIENCE = 'openvibe.search';
const CAPABILITY = 'search.query.delegate';
const TIMEOUT_MS = 15000;
const MAX_RESULTS = 20;

function clip(value, max) {
    return String(value == null ? '' : value).slice(0, max);
}

function hostOf(url) {
    try { return new URL(String(url)).hostname.toLowerCase() || null; } catch { return null; }
}

function shortError(err) {
    const text = String((err && (err.message || err.name)) || 'request failed').replace(/\s+/g, ' ').trim();
    return text.slice(0, 160) || 'request failed';
}

/**
 * Search Fabric web results as MegaSource's web shape. A citation needs url, title, published_at,
 * retrieved_at and provider: all survive here. `score` follows the ladder's order (Search says its
 * scores are not comparable across scopes), so the first page ranks first.
 */
function mapResults(body, at = Date.now()) {
    const list = Array.isArray(body && body.results) ? body.results : [];
    const web = list.filter((r) => r && r.url && (r.scope === 'web' || r.kind === 'page'));
    return web.slice(0, MAX_RESULTS).map((r, i) => ({
        url: clip(r.url, 2048),
        title: clip(r.title || hostOf(r.url) || r.url, 300),
        site: r.site ? clip(r.site, 253) : hostOf(r.url),
        snippet: r.snippet == null ? '' : clip(r.snippet, 600),
        summary: '',
        content: r.snippet == null ? '' : clip(r.snippet, 600),
        date: r.published_at ? clip(r.published_at, 40) : null,
        retrieved_at: r.retrieved_at ? clip(r.retrieved_at, 40) : new Date(at).toISOString(),
        provider: r.provider ? clip(r.provider, 40) : 'search_fabric',
        authority: -1,
        score: Math.max(0.1, 2.2 - i * 0.1),
    }));
}

function createSearchFabric({ config = {}, env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), tokens: givenTokens = null } = {}) {
    const url = String(config.url || '').replace(/\/+$/, '');
    const networkUrl = String(config.networkUrl || env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    const clientId = String(config.clientId || env.OV_OAUTH_CLIENT_ID || 'ai').trim();
    const secret = env.OV_OAUTH_CLIENT_SECRET || '';
    const enabled = config.enabled !== false;
    let tokens = givenTokens;

    function available() {
        if (!enabled) return { configured: false, reason: 'search fabric is off' };
        if (!url) return { configured: false, reason: 'OV_SEARCH_INTERNAL_URL is unset' };
        if (!tokens && !secret) return { configured: false, reason: 'OV_OAUTH_CLIENT_SECRET is unset' };
        return { configured: true, reason: null };
    }

    function tokenClient() {
        if (!tokens) {
            tokens = createServiceTokenClient({
                tokenUrl: `${networkUrl}/oauth/token`,
                clientId,
                clientSecret: secret,
                scope: { [AUDIENCE]: CAPABILITY },
                fetch: fetchImpl,
                now,
            });
        }
        return tokens;
    }

    /** One web query: { results, groups, citations, route, next_cursor }. */
    async function search(q, { limit = 8, depth = 'standard', freshness = 'any', signal = null } = {}) {
        const availability = available();
        if (!availability.configured) throw Object.assign(new Error(availability.reason), { code: 'search.unavailable' });
        const token = await tokenClient().getToken({ audience: AUDIENCE });
        const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : TIMEOUT_MS;
        const timeout = AbortSignal.timeout(timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        let res;
        try {
            res = await fetchImpl(`${url}/api/v1/query`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'OpenVibeResearch/1.0 (+https://ai.openvibe.services; Contact@OpenVibe.Network)',
                },
                body: JSON.stringify({
                    q: clip(q, 200),
                    scopes: ['web'],
                    depth,
                    freshness,
                    limit: Math.min(Math.max(1, Number(limit) || 8), MAX_RESULTS),
                }),
                signal: combined,
            });
        } catch (err) {
            if (signal && signal.aborted) throw err;
            throw Object.assign(new Error(`OpenVibe.Search did not answer: ${shortError(err)}`), { code: 'search.unavailable' });
        }
        const text = await res.text().catch(() => '');
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = null; }
        if (!res.ok) {
            const code = body && body.code ? ` (${clip(body.code, 80)})` : '';
            throw Object.assign(new Error(`OpenVibe.Search answered ${res.status}${code}`), { status: res.status, code: 'search.refused' });
        }
        if (!body || !Array.isArray(body.results)) throw Object.assign(new Error('OpenVibe.Search answered no results'), { code: 'search.bad_answer' });
        return {
            results: mapResults(body, now()),
            groups: body.groups && typeof body.groups === 'object' ? body.groups : {},
            citations: Array.isArray(body.citations) ? body.citations : [],
            route: body.route && typeof body.route === 'object' ? body.route : { explain: [], cost_usd: 0 },
            next_cursor: body.next_cursor || null,
        };
    }

    function status() {
        const a = available();
        return { configured: a.configured, reason: a.reason, url: url || null, audience: AUDIENCE, capability: CAPABILITY };
    }

    return { search, available, status };
}

module.exports = { createSearchFabric, mapResults, AUDIENCE, CAPABILITY };
