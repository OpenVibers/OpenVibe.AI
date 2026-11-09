'use strict';
const { guardedFetch } = require('../providers/guarded-fetch');
const { AiError } = require('../util');
const adapters = ['openverse', 'commons', 'searxng', 'openvibe', 'iconify'].map(
    (n) => require('./adapters/' + n),
);
const safeUrl = (s) => {
    try {
        const u = new URL(s);
        return ['https:', 'http:'].includes(u.protocol) &&
            !u.username &&
            !u.password
            ? u.href
            : null;
    } catch {
        return null;
    }
};
function createSearch({
    fetchImpl = guardedFetch,
    env = process.env,
    now = () => Date.now(),
} = {}) {
    const health = new Map();
    async function get(url) {
        const r = await fetchImpl(String(url), {
            headers: {
                accept: 'application/json',
                'user-agent':
                    'OpenVibe.Exchange/1.0 (https://openvibe.exchange)',
            },
            signal: AbortSignal.timeout(10000),
            redirect: 'error',
        });
        if (!r.ok) throw new Error('Engine unavailable');
        return r.json();
    }
    function engines() {
        return adapters.map((a) => ({
            id: a.id,
            kinds: a.kinds,
            price_per_1000: 0,
            byok: false,
            available: !a.setting || Boolean(env[a.setting]),
            freshness: a.id === 'searxng' ? 'day, month, year' : 'index',
            healthy: (health.get(a.id) || 0) <= now(),
        }));
    }
    async function search(kind, b) {
        if (typeof b.q !== 'string' || !b.q.trim() || b.q.length > 500)
            throw new AiError(
                422,
                'ai.invalid',
                'q must contain 1–500 characters',
            );
        if (b.colour || b.color || (b.type && b.type !== 'icon'))
            throw new AiError(
                422,
                'ai.invalid',
                'This filter is not supported by the configured engines',
            );
        if (b.type === 'icon') kind = 'icons';
        const input = {
            ...b,
            q: b.q.trim(),
            limit: Math.min(50, Math.max(1, Number(b.limit) || 10)),
        };
        if (b.freshness && !['day', 'month', 'year'].includes(b.freshness))
            throw new AiError(
                422,
                'ai.invalid',
                'freshness must be day, month or year',
            );
        const candidates = engines().filter(
            (e) =>
                e.available &&
                e.kinds.includes(kind) &&
                (!b.freshness || e.id === 'searxng') &&
                (b.engine && b.engine !== 'auto'
                    ? e.id === b.engine
                    : e.healthy),
        );
        if (!candidates.length)
            throw new AiError(
                503,
                'search.unavailable',
                'No configured engine serves this request',
            );
        const start = now();
        for (const c of candidates) {
            try {
                const a = adapters.find((a) => a.id === c.id);
                let rows = await a.search(
                    input,
                    get,
                    a.setting && env[a.setting],
                );
                rows = rows
                    .filter((r) => safeUrl(r.url))
                    .map((r) => ({
                        ...r,
                        url: safeUrl(r.url),
                        thumbnail: safeUrl(r.thumbnail),
                        source_page: safeUrl(r.source_page),
                        engine: c.id,
                        snippet: r.snippet || '',
                    }));
                if (b.license) {
                    const licenseId = (value) =>
                        String(value || '')
                            .toLowerCase()
                            .replace(/^cc[ -]/, '')
                            .replace(/[ -]\d+(?:\.\d+)*$/, '');
                    rows = rows.filter(
                        (r) => licenseId(r.license) === licenseId(b.license),
                    );
                }
                if (b.commercial)
                    rows = rows.filter(
                        (r) =>
                            r.license && !/nc|noncommercial/i.test(r.license),
                    );
                if (b.format)
                    rows = rows.filter(
                        (r) =>
                            r.format === b.format ||
                            new URL(r.url).pathname
                                .toLowerCase()
                                .endsWith('.' + b.format),
                    );
                if (b.orientation)
                    rows = rows.filter((r) =>
                        b.orientation === 'square'
                            ? r.width === r.height
                            : b.orientation === 'portrait'
                              ? r.height > r.width
                              : r.width > r.height,
                    );
                if (b.style && b.style !== 'any')
                    rows = rows.filter((r) => r.style === b.style);
                return {
                    results: rows.slice(0, input.limit),
                    receipt: {
                        engine: c.id,
                        cost_usd: 0,
                        time_ms: now() - start,
                    },
                };
            } catch {
                health.set(c.id, now() + 60000);
            }
        }
        throw new AiError(
            503,
            'search.unavailable',
            'The selected engines did not answer',
        );
    }
    async function read(url) {
        if (!safeUrl(url) || !String(url).startsWith('https://'))
            throw new AiError(422, 'ai.invalid', 'An HTTPS URL is required');
        const start = now();
        const r = await fetchImpl(url, {
            signal: AbortSignal.timeout(10000),
            redirect: 'error',
            headers: { accept: 'text/plain,text/html' },
        });
        if (!r.ok)
            throw new AiError(
                502,
                'search.fetch_failed',
                'The page did not answer',
            );
        const text = await r.text();
        return {
            url,
            text: text
                .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]*>/g, ' ')
                .replace(/[ \t]+/g, ' ')
                .slice(0, 200000),
            receipt: {
                engine: 'openvibe-egress',
                cost_usd: 0,
                time_ms: now() - start,
            },
        };
    }
    return { engines, search, read };
}
module.exports = { createSearch };
