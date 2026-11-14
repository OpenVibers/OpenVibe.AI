'use strict';
const searchTerms = require('./terms');
const { guardedFetch } = require('../providers/guarded-fetch');
const { publicTarget } = require('./transport');
const { AiError, providerSecret } = require('../util');
const searchClasses = require('./classes');
const searchContract = require('./contract');
const { createRateCards } = require('./rate-cards');
const { parseCostUsd } = require('../credits');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { rankImages } = require('./image-rank');
const { createCircuit } = require('./circuit');
const { createSearchCache, keyOf: searchCacheKey, policyFor: cachePolicyFor } = require('./cache');
const { redactError } = require('../redact');
const adapters = ['openverse', 'commons', 'searxng', 'openvibe', 'iconify',
    'deepseek', 'brave', 'exa', 'tavily', 'serper', 'serpapi', 'jina',
    'openvibe-egress', 'perplexity', 'kagi', 'google', 'unsplash', 'pexels', 'pixabay', 'brave-images',
    'meta', 'serper-images', 'serpapi-images', 'searchapi-images', 'serpapi-reverse', 'tineye',
    'mojeek', 'parallel', 'you', 'dataforseo', 'europeana', 'nasa', 'dataforseo-images', 'smithsonian']
    .map(n => require('./adapters/' + n));
// Every adapter says what class of engine it is (plan §W.2 step 4); an adapter without a known class is refused
// here, because an engine that cannot be compared with another one may never be routed to.
searchClasses.checkAdapters(adapters);
const CHARGE = Symbol('search Exchange charge');
const FILTER_KEYS = ['license', 'commercial', 'format', 'orientation', 'size', 'color', 'after', 'type', 'style', 'set', 'safe_search'];
// The reasons an engine is not called that a kept answer still satisfies: the engine is in cooldown or the
// caller's budget would not cover a call, and a kept answer costs nothing either way.
const FREE_SKIPS = new Set(['budget', 'circuit_open']);
const invalid = (message) => new AiError(422, 'ai.invalid', message);
const safeUrl = (s) => {
    try {
        const u = new URL(s);
        return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null;
    } catch { return null; }
};
const credentialId = a => a.credential_id || a.id;
// An amount as plain decimal text, never in exponent form: the billing routes parse money the same way.
const plainDecimal = (value) => {
    const text = String(value);
    return /[eE]/.test(text) ? Number(value).toFixed(9) : text;
};
const dimension = n => Number.isInteger(n) && n > 0 ? n : null;
function inputFor(kind, b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw invalid('A JSON object is required');
    // The classes the request asks for (plan §W.2 step 4): one name or a list of them.
    if (b.class != null) {
        const wanted = Array.isArray(b.class) ? b.class : [b.class];
        if (!wanted.length || wanted.some(c => typeof c !== 'string')) throw invalid('class must be a class name or a list of them');
        const unknown = wanted.filter(c => !searchClasses.isClass(c));
        if (unknown.length) throw invalid(`class must be one of ${searchClasses.CLASS_NAMES.join(', ')}`);
    }
    if (kind === 'reverse_image') {
        const imageUrl = typeof b.image_url === 'string' && b.image_url.startsWith('https://') && b.image_url.length <= 8192 && safeUrl(b.image_url);
        const upload = typeof b.image === 'string' && /^data:image\/(?:png|jpe?g|gif|bmp|tiff|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(b.image);
        if (!imageUrl && !upload) throw invalid('image_url or a base64 image is required');
        if (b.image && b.image.length > 8 * 1024 * 1024) throw invalid('image is too large; the limit is 5 MB after decoding');
        if (b.engine != null && typeof b.engine !== 'string') throw invalid('engine must be a string');
        if (b.limit != null && (!Number.isInteger(b.limit) || b.limit < 1 || b.limit > 50)) throw invalid('limit must be 1–50');
        if (b.max_cost_usd != null && (!Number.isFinite(b.max_cost_usd) || b.max_cost_usd < 0)) throw invalid('max_cost_usd must be nonnegative');
        return { ...b, limit: b.limit || 10 };
    }
    if (kind !== 'fetch' && (typeof b.q !== 'string' || !b.q.trim() || b.q.length > 500)) throw invalid('q must contain 1–500 characters');
    if (kind === 'fetch' && (!safeUrl(b.url) || !String(b.url).startsWith('https://') || b.url.length > 8192)) throw invalid('An HTTPS URL is required');
    if (kind === 'fetch' && net.isIP(new URL(b.url).hostname.replace(/^\[|\]$/g, ''))) throw invalid('IP-literal hosts are not called');
    if (b.engine != null && typeof b.engine !== 'string') throw invalid('engine must be a string');
    if (b.limit != null && (!Number.isInteger(b.limit) || b.limit < 1 || b.limit > 50)) throw invalid('limit must be 1–50');
    if (b.max_cost_usd != null && (!Number.isFinite(b.max_cost_usd) || b.max_cost_usd < 0)) throw invalid('max_cost_usd must be nonnegative');
    if (b.freshness && !['day', 'month', 'year'].includes(b.freshness)) throw invalid('freshness must be day, month or year');
    if (b.orientation && !['square', 'portrait', 'landscape'].includes(b.orientation)) throw invalid('orientation must be square, portrait or landscape');
    if (b.colour) throw invalid('Use color for the colour filter');
    if (b.color && !['black_and_white', 'black', 'white', 'yellow', 'orange', 'red', 'purple', 'magenta', 'green', 'teal', 'blue'].includes(b.color)) throw invalid('color is not supported');
    if (b.type && !['icon', 'photo', 'illustration', 'vector'].includes(b.type)) throw invalid('type is not supported');
    if (b.after && (!/^\d{4}-\d{2}-\d{2}$/.test(b.after) || !Number.isFinite(Date.parse(b.after)))) throw invalid('after must be a date in YYYY-MM-DD');
    if (b.safe_search != null && b.safe_search !== 'strict') throw invalid('safe_search must be strict');
    if (b.size && !['small', 'medium', 'large'].includes(b.size)) throw invalid('size must be small, medium or large');
    if (b.upstream && !['google', 'bing', 'yandex'].includes(b.upstream)) throw invalid('upstream must be google, bing or yandex');
    if (b.purpose != null && !searchTerms.PURPOSES.includes(b.purpose)) throw invalid(`purpose must be one of ${searchTerms.PURPOSES.join(', ')}`);
    if (b.private != null && typeof b.private !== 'boolean') throw invalid('private must be true or false');
    if (b.require_known_rights != null && typeof b.require_known_rights !== 'boolean') throw invalid('require_known_rights must be true or false');
    if (b.allow_provider_license != null && typeof b.allow_provider_license !== 'boolean') throw invalid('allow_provider_license must be true or false');
    return { ...b, q: kind === 'fetch' ? undefined : b.q.trim(), limit: b.limit || 10 };
}
// ── Image rights (plan §W.2 step 1, 11-13) ─────────────────────────────────────────────────────────────────────────────
// What a result says about reuse, kept apart from what it IS. A web-image discovery engine finds where a picture appears;
// it grants nothing, so its rights are unknown and it never passes a known-rights or commercial request. A provider's own
// content licence (Unsplash, Pexels, Pixabay) allows commercial use but is not an open licence: no standalone
// redistribution, the provider's display rules (attribution, hotlinking, download tracking). An open catalog's result
// carries the licence it claims (provider_claimed: the catalog did not verify it).
const DISCOVERY_ENGINES = new Set(['brave-images', 'serper-images', 'serpapi-images', 'searchapi-images', 'serpapi-reverse', 'tineye', 'dataforseo-images']);
const PROVIDER_LICENSES = {
    unsplash: { attribution_required: true, hotlink_required: true },
    pexels: { attribution_required: true, hotlink_required: false },
    pixabay: { attribution_required: true, hotlink_required: false },
};
const SOFTWARE_LICENSES = /^(mit|apache(?:[ -]?2(?:\.0)?)?|isc|bsd(?:-\d-clause)?|ofl(?:-1\.1)?|mpl(?:-2\.0)?|gpl.*|lgpl.*|unlicense)$/;
function rightsOf(engine, license, r = {}) {
    // cc-by-sa, by_sa and public_domain are the same licence written three ways.
    const id = String(license || '').toLowerCase().trim().replace(/^cc[ -]/, '').replace(/_/g, '-').replace(/[ -]v?\d+(?:\.\d+)*$/, '');
    const base = { status: 'unknown', family: 'unknown', license_id: license == null ? null : String(license), commercial_use: null,
        modifications: null, standalone_redistribution: null, attribution_required: false, hotlink_required: false,
        download_tracking_url: r.download_location || null };
    if (DISCOVERY_ENGINES.has(engine)) return { ...base, family: 'third_party', license_id: null };
    if (PROVIDER_LICENSES[engine]) {
        return { ...base, status: 'provider_claimed', family: 'provider_content_license', license_id: engine, commercial_use: true,
            modifications: true, standalone_redistribution: false, ...PROVIDER_LICENSES[engine] };
    }
    const claimed = { ...base, status: 'provider_claimed' };
    if (['0', 'cc0', 'pdm', 'publicdomain', 'public domain', 'public-domain', 'pd'].includes(id)) {
        return { ...claimed, family: 'public_domain', commercial_use: true, modifications: true, standalone_redistribution: true };
    }
    const cc = /^by(-nc)?(-nd)?(-sa)?$/.exec(id) || /^by(-nc)?(-sa)?(-nd)?$/.exec(id);
    if (cc) {
        return { ...claimed, family: 'open_license', commercial_use: !/-nc/.test(id), modifications: !/-nd/.test(id),
            standalone_redistribution: true, attribution_required: true };
    }
    if (SOFTWARE_LICENSES.test(id)) {
        return { ...claimed, family: 'open_license', commercial_use: true, modifications: true, standalone_redistribution: true, attribution_required: true };
    }
    return { ...claimed, family: 'unknown' };
}

function normalize(rows, engine, kind, b) {
    const imageKind = kind !== 'web';
    let out = rows
        .map((r, i) => ({
            ...r,
            upstream_rank: Number.isInteger(r.upstream_rank) && r.upstream_rank > 0 ? r.upstream_rank : Number.isInteger(r.position) && r.position > 0 ? r.position : i + 1,
            title: String(r.title || ''), url: safeUrl(r.url), engine,
            snippet: String(r.snippet || ''), published: r.published == null ? null : String(r.published),
            ...(imageKind ? {
                thumbnail: safeUrl(r.thumbnail), source_page: safeUrl(r.source_page), license_url: safeUrl(r.license_url),
                author_url: safeUrl(r.author_url), download_location: safeUrl(r.download_location),
                width: dimension(r.width), height: dimension(r.height),
                license: r.license == null ? null : String(r.license), author: r.author == null ? null : String(r.author),
                attribution: r.attribution == null ? null : String(r.attribution),
                ...(kind === 'images' || kind === 'icons' || kind === 'reverse_image' ? { rights: rightsOf(engine, r.license, r) } : {}),
            } : {}),
        }))
        .filter(r => r.url);
    const licenseId = v => String(v || '').toLowerCase().replace(/^cc[ -]/, '').replace(/[ -]\d+(?:\.\d+)*$/, '');
    // Local filters are applied only to image/icon result shapes; a requested filter the adapter cannot
    // honour was already refused or skipped in prepare(), never silently dropped here.
    if (kind === 'images') {
        if (b.license) out = out.filter(r => licenseId(r.license) === licenseId(b.license));
        if (b.commercial) out = out.filter(r => r.rights.status !== 'unknown' && r.rights.commercial_use === true);
        if (b.format) out = out.filter(r => r.format === b.format || new URL(r.url).pathname.toLowerCase().endsWith('.' + b.format));
        if (b.orientation) out = out.filter(r => r.width && r.height && (b.orientation === 'square' ? r.width === r.height : b.orientation === 'portrait' ? r.height > r.width : r.width > r.height));
        if (b.size) out = out.filter(r => r.width && r.height && (b.size === 'small' ? Math.max(r.width, r.height) < 800 : b.size === 'medium' ? Math.max(r.width, r.height) >= 800 && Math.max(r.width, r.height) < 2000 : Math.max(r.width, r.height) >= 2000));
        if (b.after) out = out.filter(r => (r.published || r.indexed_on) && Date.parse(r.published || r.indexed_on) >= Date.parse(b.after));
        if (b.type === 'vector') out = out.filter(r => r.format === 'svg' || new URL(r.url).pathname.toLowerCase().endsWith('.svg'));
        if (b.type === 'photo') out = out.filter(r => ['unsplash', 'pexels', 'pixabay'].includes(engine) || r.type === 'photo');
        if (b.type === 'illustration') out = out.filter(r => r.type === 'illustration');
    }
    if (kind === 'icons') {
        if (b.style && b.style !== 'any') out = out.filter(r => r.style === b.style);
        if (b.format) out = out.filter(r => r.format === b.format || new URL(r.url).pathname.toLowerCase().endsWith('.' + b.format));
        if (b.license) out = out.filter(r => licenseId(r.license) === licenseId(b.license));
        if (b.commercial) out = out.filter(r => r.rights.status !== 'unknown' && r.rights.commercial_use === true);
    }
    // Known rights only (Design, Website), and provider content licences only when the caller allows them (a template
    // or a product for sale wants open licences or public domain).
    if (imageKind && b.require_known_rights === true) out = out.filter(r => r.rights && r.rights.status !== 'unknown' && r.rights.family !== 'unknown');
    if (imageKind && b.allow_provider_license === false) out = out.filter(r => r.rights && r.rights.family !== 'provider_content_license');
    const limited = kind === 'images' ? rankImages(out, b.limit) : out.slice(0, b.limit);
    return limited.map((r, i) => ({ ...r, rank: i + 1 }));
}
function createMemoryEvents() {
    const seen = new Set();
    const key = (scope, provider, id) => `${scope}\u0000${provider}\u0000${id}`;
    return {
        async once(scope, provider, id) {
            const k = key(scope, provider, id);
            if (seen.has(k)) return { created: false };
            seen.add(k);
            if (seen.size > 5000) seen.delete(seen.values().next().value);
            return { created: true };
        },
        async release(scope, provider, id) { seen.delete(key(scope, provider, id)); },
    };
}
function createSearch({ fetchImpl = guardedFetch, env = process.env, now = () => Date.now(), credentials = null, registry = null, targetGuard = publicTarget, events = null, publicBase = process.env.AI_PUBLIC_URL || 'https://ai.openvibe.services', valkey = null, db = null } = {}) {
    // The breaker lives in Valkey when the service has one, so every process sees the same open circuit
    // (server/search/circuit.js); without one it is a Map in this process.
    const circuit = createCircuit({ valkey, now });
    // The versioned rate cards (plan §W.2 step 3): what a unit of an engine costs, what a hold reserves, and
    // the card a receipt names. A process without a database reads version 1 as it was seeded.
    const rateCards = createRateCards({ db, clock: { now: () => now() } });
    // The search caches (plan §W.2 step 6): what a provider's own terms allow us to keep. Valkey when the
    // service has one, a Map in this process otherwise; never PostgreSQL (server/search/cache.js).
    const searchCache = createSearchCache({ valkey, now });
    const assetEvents = events || createMemoryEvents();
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
    function filtersFor(a) {
        const base = a.kinds.includes('web')
            ? { freshness: a.freshness && a.freshness.length ? 'native' : 'unsupported', safe_search: 'unsupported' }
            : {};
        return { ...base, ...(a.filters || {}) };
    }
    function unsupportedFor(a, kind, b) {
        const filters = filtersFor(a);
        const out = [];
        for (const key of FILTER_KEYS) {
            if (b[key] == null || b[key] === '' || b[key] === false) continue;
            if (key === 'type' && b.type === 'icon') continue;
            if (kind === 'web' && key !== 'safe_search') continue;
            if (kind === 'icons' && !['license', 'commercial', 'format', 'set', 'style'].includes(key)) continue;
            if (kind === 'reverse_image') continue;
            if (filters[key] !== 'native' && filters[key] !== 'local') out.push(key);
        }
        if (kind === 'images' && b.type) {
            const allowed = b.type === 'photo' ? ['unsplash', 'pexels', 'pixabay', 'openverse']
                : b.type === 'illustration' ? ['openverse'] : b.type === 'vector' ? ['openverse', 'commons'] : [];
            if (!allowed.includes(a.id)) out.push('type');
        }
        if (b.upstream && !(a.upstreams || []).includes(b.upstream)) out.push('upstream');
        if (kind === 'reverse_image' && b.image && !a.uploads) out.push('image upload');
        return [...new Set(out)];
    }
    async function engines() {
        const providers = registry ? await registry.listProviders() : [];
        // The breaker lives in Valkey when the service has one: the card says whether the engine is healthy.
        const open = await Promise.all(adapters.map(a => circuit.openUntil('shared', a.id)));
        // The active rate cards of every engine (plan §W.2 step 3): what a unit costs, what a hold reserves and
        // the day the price was read. A card older than ninety days says so.
        const cards = await rateCards.active();
        return adapters.map((a, i) => {
            const state = binding(a, providers);
            const own = cards.get(a.id) || [];
            return { id: a.id, kinds: a.kinds, class: a.class,
                rate_cards: own, pricing_stale: own.some(c => c.stale),
                byok: a.byok, available: state.available, freshness: a.freshness, healthy: open[i] <= now(),
                provider: state.provider?.key || null, manual_only: a.manual_only === true,
                source: a.source, pricing_note: a.pricing_note || null,
                included_allowance: own.find(c => c.included)?.included || null, onboarding: a.onboarding || null,
                upstreams: a.upstreams || (a.upstream ? [a.upstream] : []),
                uploads: a.uploads === true, filters: filtersFor(a), terms: searchTerms.termsOf(a.id) };
        });
    }
    async function prepare(kind, body, { subject = null } = {}) {
        const b = inputFor(kind, body);
        if (b.type === 'icon') kind = 'icons';
        if (kind === 'reverse_image' && (!b.engine || b.engine === 'auto'))
            throw new AiError(422, 'search.invalid', 'Choose an engine for a reverse image search');
        const candidates = [];
        const skippedForFilters = new Set();
        const notConsidered = [];
        const providers = registry ? await registry.listProviders() : [];
        // The active rate cards price every engine (plan §W.2 step 3): a card is never edited, and only the
        // active one is used. The caller's own ceiling is an exact amount, never a float.
        const cards = await rateCards.active();
        const cardOf = (id) => (cards.get(id) || [])[0] || null;
        const budgetNano = b.max_cost_usd == null ? null : parseCostUsd(plainDecimal(b.max_cost_usd));
        // The class gate (plan §W.2 step 4). A request may name the classes it wants; otherwise a web search uses
        // the classes a web search uses (an index, a proxy, OpenVibe's own services, a metasearch) and an answer
        // engine or a semantic engine joins only when the request asks for an answer or for research. A named engine
        // is the caller asking for that engine, so only a named class can refuse it.
        const explicit = Boolean(b.engine && b.engine !== 'auto');
        const named = searchClasses.asked(b);
        const allowed = explicit ? named : searchClasses.allowedFor(kind, b);
        if (explicit && named) {
            const engine = adapters.find(a => a.id === b.engine);
            if (engine && !named.includes(engine.class))
                throw new AiError(422, 'search.unsupported', `${b.engine} is not a ${named.join(' or ')} engine`);
        }
        for (const a of adapters) {
            if (a.manual_only && !explicit) continue;
            if (!a.kinds.includes(kind)) continue;
            if (explicit && b.engine !== a.id) continue;
            if (b.freshness && !a.freshness.includes(b.freshness) || (a.requires || []).some(k => !env[k])) continue;
            if (kind !== 'fetch' && a.max_query && [...b.q].length + (b.freshness ? 17 : 0) > a.max_query) continue;
            const unsupported = unsupportedFor(a, kind, b);
            if (unsupported.length) {
                if (b.engine && b.engine !== 'auto' && b.engine === a.id)
                    throw new AiError(422, 'search.unsupported', `${a.id} cannot honour ${unsupported.join(', ')}; choose an engine that supports it`);
                skippedForFilters.add(a.id);
                continue;
            }
            // The provider's own terms decide (plan §W.2 step 2): a purpose they do not allow, a private request to a
            // provider that keeps queries, monitoring on transient-only results. Named explicitly, it is refused; on auto
            // it is skipped with the reason in the receipt.
            const denied = searchTerms.denial(a.id, b);
            if (denied) {
                if (b.engine && b.engine !== 'auto' && b.engine === a.id) {
                    const t = searchTerms.termsOf(a.id);
                    throw new AiError(422, 'search.terms', `${a.id} cannot serve this request (${denied.replace(/_/g, ' ')})${t ? `: ${t.source}` : ': its terms are not reviewed yet'}`);
                }
                candidates.push({ a, key: null, own: false, scope: 'shared', engine: a.id, ceilingNano: 0n, estimateNano: 0n, card: null, provider: null, managed: false, env, skipReason: denied });
                continue;
            }
            const own = a.byok && subject && credentials ? await credentials.searchForRun(subject, credentialId(a)) : null;
            const state = binding(a, providers);
            // The hold is the card's ceiling × the units this call may use, and never less than the reserve the
            // engine declares for itself. Both are integer nano-USD.
            const card = cardOf(a.id);
            const units = rateCards.unitsMayUse(card, b);
            const cardCeilingNano = card ? rateCards.estimate(card, units) : null;
            const declaredNano = a.ceilingNano ? a.ceilingNano(b) : null;
            const ceilingNano = cardCeilingNano == null ? declaredNano
                : declaredNano == null ? cardCeilingNano : (declaredNano > cardCeilingNano ? declaredNano : cardCeilingNano);
            // The estimate is what the call is expected to cost: the engine's own estimate when it declares
            // one, otherwise the card's price for the units it may use.
            const estimateNano = a.estimateNano ? a.estimateNano(b)
                : card ? rateCards.settle(card, units) : null;
            if (ceilingNano == null || estimateNano == null) {
                // An engine with no card and no reserve of its own has no price: it is never called.
                if (b.engine && b.engine !== 'auto')
                    throw new AiError(422, 'search.unsupported', `${a.id} has no rate card yet`);
                candidates.push({ a, key: null, own: false, scope: 'shared', engine: a.id, ceilingNano: 0n, estimateNano: 0n, card: null, provider: null, managed: false, env, skipReason: 'no_rate_card' });
                continue;
            }
            if (!own && !state.available) {
                // An owner-managed provider that is off stays in the plan so the receipt says why it was skipped.
                if (state.managed && state.provider && state.configured)
                    candidates.push({ a, key: state.key, own: false, scope: 'shared', engine: a.id, ceilingNano, estimateNano, card, provider: state.provider.key, managed: true, env: state.env, skipReason: 'disabled' });
                continue;
            }
            const key = own?.apiKey || state.key;
            if (a.key_env && !key || a.setting && !state.env?.[a.setting]) continue;
            // An engine of another class is not considered at all: auto never ranks unlike engines by price alone,
            // so a cheap answer engine never beats a raw index on a plain display. The receipt says which ones.
            if (allowed && !allowed.includes(a.class)) {
                notConsidered.push({ engine: a.id, class: a.class, reason: 'class_not_considered' });
                continue;
            }
            // The breaker's scope says whose key failed: a person's own key is its own circuit.
            const scope = own ? 'k:' + createHash('sha256').update(key).digest('hex') : 'shared';
            candidates.push({ a, key, own: Boolean(own), scope, engine: a.id, ceilingNano, estimateNano, card, provider: state.provider?.key || null, managed: state.managed, env: state.env || env,
                skipReason: budgetNano != null && ceilingNano > budgetNano ? 'budget' : null });
        }
        // Once the person has an eligible key, fallback stays within their keys (0% Exchange fee).
        const cohort = candidates.some(c => c.own) ? candidates.filter(c => c.own) : candidates;
        // A cooldown is a skip in the receipt, not a disappearance; an explicit engine may still retry.
        const selected = [];
        for (const c of cohort) {
            if (!c.skipReason && !(b.engine && b.engine !== 'auto') && (await circuit.openUntil(c.scope, c.engine)) > now()) c.skipReason = 'circuit_open';
            selected.push(c);
        }
        // The order is the estimate, in integer nano-USD: an exact comparison, never a float subtraction.
        selected.sort((a, b) => (a.estimateNano < b.estimateNano ? -1 : a.estimateNano > b.estimateNano ? 1 : 0));
        const runnable = selected.filter(c => !c.skipReason);
        if (!runnable.length) {
            const requested = FILTER_KEYS.filter(k => b[k] != null && b[k] !== '' && b[k] !== false && !(k === 'type' && b.type === 'icon'));
            const TERMS_REASONS = ['terms_unreviewed', 'terms_disallow_purpose', 'privacy_incompatible', 'retention_incompatible'];
            if (selected.length && selected.every(c => TERMS_REASONS.includes(c.skipReason)))
                throw new AiError(422, 'search.terms', `No engine's terms allow this request (${searchTerms.purposeOf(b)}${b.private ? ', private' : ''})`);
            if (skippedForFilters.size)
                throw new AiError(422, 'search.unsupported', `No configured engine can honour the requested filters (${[...new Set(requested)].join(', ') || 'engine limitation'})`);
            if (named && named.length)
                throw new AiError(422, 'search.unsupported', `No ${named.join(' or ')} engine serves this search`);
            if (b.engine && b.engine !== 'auto' && !selected.length) {
                const chosen = adapters.find(a => a.id === b.engine);
                if (!chosen || !chosen.kinds.includes(kind))
                    throw new AiError(422, 'search.unsupported', 'This engine does not serve this search');
            }
            throw new AiError(503, 'search.unavailable', 'No configured engine serves this request within its price and freshness limits');
        }
        // The classes this request was allowed to use, and the engines whose class kept them out of it.
        const classesAllowed = allowed || [adapters.find(a => a.id === b.engine)?.class].filter(Boolean);
        // What the call holds: every runnable engine's reserve, capped by the caller's own ceiling.
        const held = runnable.reduce((n, c) => n + (c.own ? 0n : c.ceilingNano), 0n);
        const ceilingNano = budgetNano == null ? held : (budgetNano < held ? budgetNano : held);
        // The person the search is for: a same-person cache is named after them, and nobody else answers it.
        return { kind, b, subject: subject || null, candidates: selected, notConsidered, classesAllowed, ceilingNano,
            ceiling: rateCards.usdOf(ceilingNano) };
    }
    // The receipt names the class of the engine that answered, the classes the request allowed, and the engines
    // whose class kept them out of it (plan §W.2 step 4). It also names the rate card that priced the call and
    // the terms that allowed it (plan §W.2 step 3): the card {id, version}, the terms' review day, the purpose,
    // the hold the call reserved and what it settled.
    const receipt = (plan, engine, costNano, start, attempts, engineClass, card, estimateNano, cache = null) => ({
        engine, cost_usd: rateCards.usdOf(costNano), time_ms: Math.max(0, now() - start),
        ...(engineClass ? { class: engineClass } : {}),
        ...(plan.classesAllowed && plan.classesAllowed.length ? { classes_allowed: plan.classesAllowed } : {}),
        ...(plan.notConsidered && plan.notConsidered.length ? { not_considered: plan.notConsidered } : {}),
        ...(attempts ? { attempts } : {}),
        ...(card ? { rate_card: { id: card.id, version: card.version } } : {}),
        ...(searchTerms.termsOf(engine) ? { terms: { reviewed_on: searchTerms.termsOf(engine).reviewed_on } } : {}),
        purpose: searchTerms.purposeOf(plan.b),
        estimate: { nano_usd: String(estimateNano == null ? 0n : estimateNano) },
        actual: { nano_usd: String(costNano) },
        // The cache (plan §W.2 step 6): a hit says so and how old the answer is; a miss says it was not kept.
        ...(cache ? { cache } : {}),
    });
    /**
     * The cache a provider's own terms allow (plan §W.2 step 6): what may be kept, for whom and for how long.
     * Nothing is kept when the request is private, when the provider's terms forbid caching, when the kind is a
     * page read rather than a result, or when a same-person cache has no person to name it after.
     */
    function cachePlanFor(c, plan) {
        const policy = cachePolicyFor(c.a.id, { kind: plan.kind, private: plan.b.private === true, subject: plan.subject });
        if (!policy) return null;
        const key = searchCacheKey({ scope: policy.scope, engine: c.a.id, kind: plan.kind, body: plan.b,
            purpose: searchTerms.purposeOf(plan.b), subject: plan.subject });
        return { key, scope: policy.scope, ttl_s: policy.ttl_s };
    }
    async function execute(plan, budget = Infinity) {
        const start = now();
        // The money is integer nano-USD from here on: what the call reserved, what it settled, what it charges.
        let incurredNano = 0n, chargeNano = 0n;
        const budgetNano = budget === Infinity ? null : BigInt(Math.max(0, Math.round(Number(budget) * 1e9)));
        const capNano = plan.b.max_cost_usd == null ? null : parseCostUsd(plainDecimal(plan.b.max_cost_usd));
        const attempts = [];
        const attempt = (c, status, started, cost, reason) => ({ provider: c.provider || credentialId(c.a), engine: c.a.id, class: c.a.class, status,
            ...(reason ? { reason } : {}), time_ms: Math.max(0, now() - started), cost_usd: cost });
        for (const c of plan.candidates) {
            const attemptStart = now();
            // A kept answer costs nothing: it is served even when the engine itself would not be called
            // (its circuit is open, or the caller's budget would not cover a call). An engine the terms
            // refuse, or one the owner turned off, is never answered from a cache.
            if (c.skipReason && !FREE_SKIPS.has(c.skipReason)) { attempts.push(attempt(c, 'skipped', attemptStart, 0, c.skipReason)); continue; }
            const kept = cachePlanFor(c, plan);
            if (kept) {
                const hit = await searchCache.get(kept.key);
                if (hit) {
                    const out = { results: hit.results, receipt: receipt(plan, c.a.id, incurredNano, start, null, c.a.class, c.card, c.ceilingNano, { hit: true, age_s: hit.age_s }) };
                    if (!searchContract.check(plan.kind === 'web' ? 'web' : 'images', out).valid) throw new Error('Invalid search response');
                    Object.defineProperty(out, CHARGE, { value: rateCards.usdOf(chargeNano) });
                    return out;
                }
            }
            if (c.skipReason) { attempts.push(attempt(c, 'skipped', attemptStart, 0, c.skipReason)); continue; }
            if ((!c.own && budgetNano != null && c.ceilingNano + chargeNano > budgetNano) || (capNano != null && c.ceilingNano + incurredNano > capNano)) {
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
                const options = { fetchImpl: boundFetch, key: c.key, env: c.env, now, publicBase };
                attempted = true;
                const raw = plan.kind === 'fetch' ? await c.a.read(plan.b, options)
                    : plan.kind === 'reverse_image' ? await c.a.reverse(plan.b, options)
                    : await c.a.search(plan.b, options);
                // The settle is the card's price × the units the call used. An engine that reports what the
                // provider charged (a token-priced reader, an answer engine) settles at that amount instead.
                const rows = Array.isArray(raw) ? raw : raw.rows;
                const reported = raw.cost;
                if (reported != null && (!Number.isFinite(reported) || reported < 0)) throw new Error('Invalid engine cost');
                const costNano = reported != null ? rateCards.nanoOfCost(reported)
                    : c.card ? rateCards.settle(c.card, rateCards.unitsUsed(c.card, { results: (rows || []).length }))
                        : (c.estimateNano == null ? 0n : c.estimateNano);
                const results = plan.kind === 'fetch' ? null : normalize(rows, c.a.id, plan.kind, plan.b);
                const rec = receipt(plan, c.a.id, costNano + incurredNano, start, [...attempts, attempt(c, 'ok', attemptStart, rateCards.usdOf(costNano))], c.a.class, c.card, c.ceilingNano, kept ? { hit: false } : null);
                const out = plan.kind === 'fetch'
                    ? { url: plan.b.url, text: String(raw.text || '').slice(0, 200000), receipt: rec }
                    : { results, receipt: rec };
                if (plan.kind !== 'fetch' && !searchContract.check(plan.kind === 'web' ? 'web' : 'images', out).valid) throw new Error('Invalid search response');
                // A miss stores the normalized results for as long as the provider's own terms allow.
                if (kept) await searchCache.set(kept.key, results, kept.ttl_s);
                await circuit.clear(c.scope, c.engine);
                Object.defineProperty(out, CHARGE, { value: rateCards.usdOf(chargeNano + (c.own ? 0n : costNano)) });
                return out;
            } catch (error) {
                // An upstream error can carry the request URL, and a request URL can carry the key.
                redactError(error);
                // A transport timeout or malformed successful response may already be billed.
                // Keep its ceiling in both the fallback budget and receipt, rather than overspend.
                const failedNano = attempted && !error.unbilled ? c.ceilingNano : 0n;
                const reason = ['AbortError', 'TimeoutError'].includes(error.name) || error.code === 'provider.timeout' ? 'timeout'
                    : /usage is missing|Invalid engine cost|Invalid search response/.test(error.message || '') ? 'invalid_response' : 'upstream_error';
                attempts.push(attempt(c, 'error', attemptStart, rateCards.usdOf(failedNano), reason));
                if (failedNano) { incurredNano += failedNano; if (!c.own) chargeNano += failedNano; }
                await circuit.trip(c.scope, c.engine, now() + 60000);
            }
        }
        throw Object.assign(new AiError(503, 'search.unavailable', 'The selected engines did not answer', { attempts }), { [CHARGE]: rateCards.usdOf(chargeNano) });
    }
    async function search(kind, b, context = {}) {
        return execute(context.plan || await prepare(kind, b, context), context.budget);
    }
    async function read(body, context = {}) {
        const b = typeof body === 'string' ? { url: body } : body;
        return execute(context.plan || await prepare('fetch', b, context), context.budget);
    }
    /**
     * Unsplash's required download event: one call when a person chooses or imports a picture. The claim
     * (subject + download_location) is idempotent, so a double click or a retried request does not count twice.
     */
    async function trackDownload(body, { subject = null } = {}) {
        const location = body && body.download_location;
        if (typeof location !== 'string') throw invalid('download_location is required');
        const url = safeUrl(location);
        if (!url || !String(url).startsWith('https://api.unsplash.com/photos/') || !/^\/photos\/[^/]+\/download\/?$/.test(new URL(url).pathname))
            throw invalid('download_location must be an Unsplash photo download endpoint');
        const a = adapters.find(x => x.id === 'unsplash');
        const providers = registry ? await registry.listProviders() : [];
        const state = binding(a, providers);
        const own = subject && credentials ? await credentials.searchForRun(subject, credentialId(a)) : null;
        const key = own?.apiKey || state.key;
        if (!key) throw new AiError(503, 'search.unavailable', 'Unsplash needs a key to record a download');
        const scope = subject || 'shared';
        // The ixid query is Unsplash's tracking token, not a different picture: count the photo path once.
        const photo = new URL(url);
        const eventKey = createHash('sha256').update(photo.origin + photo.pathname.replace(/\/$/, '')).digest('hex');
        const claim = await assetEvents.once(scope, a.id, eventKey);
        if (!claim.created) return { tracked: true, already: true };
        try {
            await a.trackDownload({ download_location: url }, { fetchImpl, key });
        } catch (error) {
            await assetEvents.release(scope, a.id, eventKey).catch(() => {});
            throw error;
        }
        return { tracked: true, already: false };
    }
    async function pixabayImage(id) {
        const a = adapters.find(x => x.id === 'pixabay');
        return a.image(id, { fetchImpl });
    }
    return { engines, search, read, prepare, trackDownload, pixabayImage };
}
module.exports = { createSearch, adapters, credentialId, CHARGE, rightsOf };
