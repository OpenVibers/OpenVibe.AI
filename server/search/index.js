'use strict';
const { guardedFetch } = require('../providers/guarded-fetch');
const { publicTarget } = require('./transport');
const { AiError, providerSecret } = require('../util');
const { validate } = require('openvibe-contracts');
const net = require('node:net');
const { createHash } = require('node:crypto');
const adapters = ['openverse', 'commons', 'searxng', 'openvibe', 'iconify',
    'deepseek', 'brave', 'exa', 'tavily', 'serper', 'serpapi', 'jina',
    'openvibe-egress', 'perplexity', 'kagi', 'google', 'unsplash', 'pexels', 'pixabay', 'brave-images',
    'meta', 'serper-images']
    .map(n => require('./adapters/' + n));
const CHARGE = Symbol('search Exchange charge');
const invalid = (message) => new AiError(422, 'ai.invalid', message);
const safeUrl = (s) => {
    try {
        const u = new URL(s);
        return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null;
    } catch { return null; }
};
const credentialId = a => a.credential_id || a.id;
const dimension = n => Number.isInteger(n) && n > 0 ? n : null;
function inputFor(kind, b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw invalid('A JSON object is required');
    if (kind !== 'fetch' && (typeof b.q !== 'string' || !b.q.trim() || b.q.length > 500)) throw invalid('q must contain 1–500 characters');
    if (kind === 'fetch' && (!safeUrl(b.url) || !String(b.url).startsWith('https://') || b.url.length > 8192)) throw invalid('An HTTPS URL is required');
    if (kind === 'fetch' && net.isIP(new URL(b.url).hostname.replace(/^\[|\]$/g, ''))) throw invalid('IP-literal hosts are not called');
    if (b.engine != null && typeof b.engine !== 'string') throw invalid('engine must be a string');
    if (b.limit != null && (!Number.isInteger(b.limit) || b.limit < 1 || b.limit > 50)) throw invalid('limit must be 1–50');
    if (b.max_cost_usd != null && (!Number.isFinite(b.max_cost_usd) || b.max_cost_usd < 0)) throw invalid('max_cost_usd must be nonnegative');
    if (b.freshness && !['day', 'month', 'year'].includes(b.freshness)) throw invalid('freshness must be day, month or year');
    if (b.orientation && !['square', 'portrait', 'landscape'].includes(b.orientation)) throw invalid('orientation must be square, portrait or landscape');
    if (b.colour || b.color || b.type && b.type !== 'icon') throw invalid('This filter is not supported');
    if (b.size && !['small', 'medium', 'large'].includes(b.size)) throw invalid('size must be small, medium or large');
    return { ...b, q: kind === 'fetch' ? undefined : b.q.trim(), limit: b.limit || 10 };
}
function normalize(rows, engine, kind, b) {
    let out = rows.filter(r => safeUrl(r.url)).map(r => ({
        ...r, title: String(r.title || ''), url: safeUrl(r.url), engine,
        snippet: String(r.snippet || ''), published: r.published == null ? null : String(r.published),
        ...(kind === 'web' ? {} : {
            thumbnail: safeUrl(r.thumbnail), source_page: safeUrl(r.source_page), license_url: safeUrl(r.license_url),
            author_url: safeUrl(r.author_url), download_location: safeUrl(r.download_location),
            width: dimension(r.width), height: dimension(r.height),
            license: r.license == null ? null : String(r.license), author: r.author == null ? null : String(r.author),
            attribution: r.attribution == null ? null : String(r.attribution),
        }),
    }));
    const licenseId = v => String(v || '').toLowerCase().replace(/^cc[ -]/, '').replace(/[ -]\d+(?:\.\d+)*$/, '');
    if (b.license) out = out.filter(r => licenseId(r.license) === licenseId(b.license));
    if (b.commercial) out = out.filter(r => ['cc0', 'pdm', 'by', 'by-sa', 'unsplash', 'pexels', 'pixabay'].includes(licenseId(r.license)));
    if (b.format) out = out.filter(r => r.format === b.format || new URL(r.url).pathname.toLowerCase().endsWith('.' + b.format));
    if (b.orientation) out = out.filter(r => r.width && r.height && (b.orientation === 'square' ? r.width === r.height : b.orientation === 'portrait' ? r.height > r.width : r.width > r.height));
    if (b.size) out = out.filter(r => r.width && r.height && (b.size === 'small' ? Math.max(r.width, r.height) < 800 : b.size === 'medium' ? Math.max(r.width, r.height) >= 800 && Math.max(r.width, r.height) < 2000 : Math.max(r.width, r.height) >= 2000));
    if (b.style && b.style !== 'any') out = out.filter(r => r.style === b.style);
    return out.slice(0, b.limit);
}
function createSearch({ fetchImpl = guardedFetch, env = process.env, now = () => Date.now(), credentials = null, registry = null, targetGuard = publicTarget } = {}) {
    const health = new Map();
    const providerFor = (a, providers) => providers.find(p => p.metadata?.search_adapters?.includes(a.id));
    function binding(a, providers) {
        const provider = providerFor(a, providers);
        // Existing environment-backed search stays available until the owner manages its registry row.
        // New adapters require an enabled registry entry when running inside the service.
        const managed = Boolean(registry && (a.registry_required || provider && (provider.origin === 'admin' || provider.status === 'active' || providerSecret(provider, env))));
        const key = managed ? providerSecret(provider, env) || (a.key_env && env[a.key_env]) : a.key_env && env[a.key_env];
        const settings = a.setting === 'EXCHANGE_SEARXNG_URL' && managed && provider?.base_url ? { ...env, EXCHANGE_SEARXNG_URL: provider.base_url } : env;
        const configured = (!a.key_env || Boolean(key)) && (!a.setting || Boolean(settings[a.setting])) && (a.requires || []).every(k => settings[k]);
        if (managed && (!provider || provider.status !== 'active')) return { provider, managed, key, env: settings, configured, available: false };
        return { provider, managed, key, env: settings, configured, available: configured };
    }
    async function engines() {
        const providers = registry ? await registry.listProviders() : [];
        return adapters.map(a => {
            const state = binding(a, providers);
            return { id: a.id, kinds: a.kinds, price_per_1000: a.price_per_1000,
                byok: a.byok, available: state.available, freshness: a.freshness, healthy: (health.get(a.id) || 0) <= now(),
                provider: state.provider?.key || null, manual_only: a.manual_only === true,
                source: a.source, checked_on: a.checked_on, pricing_note: a.pricing_note || null };
        });
    }
    async function prepare(kind, body, { subject = null } = {}) {
        const b = inputFor(kind, body);
        if (b.type === 'icon') kind = 'icons';
        for (const [k, until] of health) if (until <= now()) health.delete(k);
        const candidates = [];
        const providers = registry ? await registry.listProviders() : [];
        for (const a of adapters) {
            if (a.manual_only && (!b.engine || b.engine === 'auto')) continue;
            if (!a.kinds.includes(kind) || b.engine && b.engine !== 'auto' && b.engine !== a.id ||
                b.freshness && !a.freshness.includes(b.freshness) || (a.requires || []).some(k => !env[k])) continue;
            if (kind !== 'fetch' && a.max_query && [...b.q].length + (b.freshness ? 17 : 0) > a.max_query) continue;
            const own = a.byok && subject && credentials ? await credentials.searchForRun(subject, credentialId(a)) : null;
            const state = binding(a, providers);
            const ceiling = a.ceiling ? a.ceiling(b) : a.price_per_1000 / 1000;
            if (!own && !state.available) {
                // An owner-managed provider that is off stays in the plan so the receipt says why it was skipped.
                if (state.managed && state.provider && state.configured)
                    candidates.push({ a, key: state.key, own: false, healthKey: a.id, ceiling, provider: state.provider.key, managed: true, env: state.env, skipReason: 'disabled' });
                continue;
            }
            const key = own?.apiKey || state.key;
            if (a.key_env && !key || a.setting && !state.env?.[a.setting]) continue;
            const healthKey = own ? `${a.id}:${createHash('sha256').update(key).digest('hex')}` : a.id;
            candidates.push({ a, key, own: Boolean(own), healthKey, ceiling, provider: state.provider?.key || null, managed: state.managed, env: state.env || env,
                skipReason: b.max_cost_usd != null && ceiling > b.max_cost_usd ? 'budget' : null });
        }
        // Once the person has an eligible key, fallback stays within their keys (0% Exchange fee).
        const cohort = candidates.some(c => c.own) ? candidates.filter(c => c.own) : candidates;
        // A cooldown is a skip in the receipt, not a disappearance; an explicit engine may still retry.
        const selected = cohort.map(c => {
            if (!c.skipReason && !(b.engine && b.engine !== 'auto') && health.has(c.healthKey)) c.skipReason = 'circuit_open';
            return c;
        });
        const price = c => c.a.estimate ? c.a.estimate(b) : c.a.price_per_1000 == null ? c.ceiling : c.a.price_per_1000 / 1000;
        selected.sort((a, b) => price(a) - price(b));
        const runnable = selected.filter(c => !c.skipReason);
        if (!runnable.length) throw new AiError(503, 'search.unavailable', 'No configured engine serves this request within its price and freshness limits');
        return { kind, b, candidates: selected, ceiling: Math.min(b.max_cost_usd ?? Infinity, runnable.reduce((n, c) => n + (c.own ? 0 : c.ceiling), 0)) };
    }
    const receipt = (engine, cost, start, attempts) => ({ engine, cost_usd: cost, time_ms: Math.max(0, now() - start), ...(attempts ? { attempts } : {}) });
    async function execute(plan, budget = Infinity) {
        const start = now();
        let incurred = 0, charge = 0;
        const attempts = [];
        const attempt = (c, status, started, cost, reason) => ({ provider: c.provider || credentialId(c.a), engine: c.a.id, status,
            ...(reason ? { reason } : {}), time_ms: Math.max(0, now() - started), cost_usd: cost });
        for (const c of plan.candidates) {
            const attemptStart = now();
            if (c.skipReason) { attempts.push(attempt(c, 'skipped', attemptStart, 0, c.skipReason)); continue; }
            if ((!c.own && c.ceiling + charge > budget + 1e-12) || c.ceiling + incurred > (plan.b.max_cost_usd ?? Infinity) + 1e-12) {
                attempts.push(attempt(c, 'skipped', attemptStart, 0, 'budget')); continue;
            }
            let attempted = false;
            try {
                if (plan.kind === 'fetch' && c.a.id !== 'openvibe-egress') await targetGuard(plan.b.url);
                let boundFetch = fetchImpl;
                if (!c.own && c.managed) {
                    const current = await registry.getProvider(c.provider);
                    if (!current || current.status !== 'active') { attempts.push(attempt(c, 'skipped', attemptStart, 0, 'disabled')); continue; }
                    const expected = current.base_url && new URL(current.base_url).origin;
                    // The adapter's own host allowlist covers multi-host readers (Jina); the provider's
                    // registered origin covers a configured SearXNG address. Nothing else gets the key.
                    const hosts = new Set((c.a.hosts || []).map(h => 'https://' + h));
                    boundFetch = (url, init) => {
                        const origin = new URL(String(url)).origin;
                        if (!(expected && origin === expected) && !hosts.has(origin)) throw Object.assign(new Error('Search endpoint does not match the provider'), { unbilled: true });
                        return fetchImpl(url, init);
                    };
                    // Key replacement/removal takes effect even for a previously prepared plan.
                    c.key = providerSecret(current, env) || (c.a.key_env && env[c.a.key_env]);
                    if (c.a.key_env && !c.key) { attempts.push(attempt(c, 'skipped', attemptStart, 0, 'no_credentials')); continue; }
                }
                const options = { fetchImpl: boundFetch, key: c.key, env: c.env, now };
                attempted = true;
                const raw = plan.kind === 'fetch' ? await c.a.read(plan.b, options) : await c.a.search(plan.b, options);
                const cost = raw.cost ?? c.a.price_per_1000 / 1000;
                if (!Number.isFinite(cost) || cost < 0) throw new Error('Invalid engine cost');
                const out = plan.kind === 'fetch'
                    ? { url: plan.b.url, text: String(raw.text || '').slice(0, 200000), receipt: receipt(c.a.id, cost + incurred, start, [...attempts, attempt(c, 'ok', attemptStart, cost)]) }
                    : { results: normalize(Array.isArray(raw) ? raw : raw.rows, c.a.id, plan.kind, plan.b), receipt: receipt(c.a.id, cost + incurred, start, [...attempts, attempt(c, 'ok', attemptStart, cost)]) };
                if (plan.kind !== 'fetch' && !validate(plan.kind === 'web' ? 'exchange.search-result@1' : 'exchange.image-result@1', out).valid) throw new Error('Invalid search response');
                health.delete(c.healthKey);
                Object.defineProperty(out, CHARGE, { value: charge + (c.own ? 0 : cost) });
                return out;
            } catch (error) {
                // A transport timeout or malformed successful response may already be billed.
                // Keep its ceiling in both the fallback budget and receipt, rather than overspend.
                const failedCost = attempted && !error.unbilled ? c.ceiling : 0;
                const reason = ['AbortError', 'TimeoutError'].includes(error.name) || error.code === 'provider.timeout' ? 'timeout'
                    : /usage is missing|Invalid engine cost|Invalid search response/.test(error.message || '') ? 'invalid_response' : 'upstream_error';
                attempts.push(attempt(c, 'error', attemptStart, failedCost, reason));
                if (failedCost) { incurred += failedCost; if (!c.own) charge += failedCost; }
                health.set(c.healthKey, now() + 60000);
                if (health.size > 1000) health.delete(health.keys().next().value);
            }
        }
        throw Object.assign(new AiError(503, 'search.unavailable', 'The selected engines did not answer', { attempts }), { [CHARGE]: charge });
    }
    async function search(kind, b, context = {}) {
        return execute(context.plan || await prepare(kind, b, context), context.budget);
    }
    async function read(body, context = {}) {
        const b = typeof body === 'string' ? { url: body } : body;
        return execute(context.plan || await prepare('fetch', b, context), context.budget);
    }
    return { engines, search, read, prepare };
}
module.exports = { createSearch, adapters, credentialId, CHARGE };
