'use strict';
/**
 * The search caches (plan §W.2 step 6, 11-14): what a provider's own terms allow us to keep of a search, and
 * where that copy lives.
 *
 * The value lives in Valkey when the service has one, so every process of the service shares it; without Valkey
 * (a test, a small install) it is a Map in this process. Never PostgreSQL: no provider's terms allow a search
 * result to be stored durably, and a database row is exactly that.
 *
 * The key is `search:cache:<scope>:<engine>:<sha256 of kind, normalized query, filters, purpose and the person
 * for same_user>`. The scope is part of the key, so a shared entry can never be read as a same-person one, and
 * the person is only in it for a same-person cache, so one person's results never answer another's.
 *
 * The value is the normalized results, capped at 256 KB, with the moment it was stored, so a hit can say how old
 * it is.
 */
const { createHash } = require('node:crypto');
const terms = require('./terms');

/** A kept result is at most this big. A bigger answer is not kept: the cache is an optimisation, never a limit. */
const MAX_VALUE_BYTES = 256 * 1024;

/** The request fields that change the answer. A different filter is a different answer. */
const FILTER_KEYS = ['license', 'commercial', 'format', 'orientation', 'size', 'color', 'after', 'type', 'style',
    'set', 'safe_search', 'upstream', 'limit', 'freshness', 'require_known_rights', 'allow_provider_license'];

/** The query as a cache sees it: trimmed, single-spaced, case-folded. */
function normalizeQuery(text) {
    return String(text == null ? '' : text).trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The filters of a request, as a stable text. */
function filtersOf(body) {
    const parts = [];
    for (const key of FILTER_KEYS) {
        const value = body ? body[key] : null;
        if (value == null || value === '' || value === false) continue;
        parts.push(key + '=' + String(value));
    }
    return parts.sort().join('&');
}

/** What the search is about: the query, the picture, or the page. */
function subjectOf(kind, body) {
    if (kind === 'fetch') return 'url:' + String((body && body.url) || '').trim().toLowerCase();
    if (kind === 'reverse_image') {
        if (body && body.image_url) return 'url:' + String(body.image_url).trim().toLowerCase();
        // An uploaded picture is named by its own bytes, never by the query beside it.
        return 'upload:' + createHash('sha256').update(String((body && body.image) || '')).digest('hex');
    }
    return 'q:' + normalizeQuery(body && body.q);
}

/**
 * The cache key of one request for one engine. The person is in it only for a same-person cache, so a shared
 * entry can never answer one person with another's results.
 */
function keyOf({ scope, engine, kind, body, purpose, subject }) {
    const parts = [String(kind || ''), subjectOf(kind, body), filtersOf(body), String(purpose || 'interactive_display')];
    if (scope === 'same_user') parts.push('person:' + String(subject || ''));
    const hash = createHash('sha256').update(parts.join('\u0000')).digest('hex');
    return 'search:cache:' + scope + ':' + engine + ':' + hash;
}

/**
 * What this request may keep of this provider's answers. Nothing when the request is private (a private request
 * is never kept and never answered from a cache), when the kind is a page read rather than a result, when the
 * provider's own terms forbid caching, or when a same-person cache has no person to name it after.
 */
function policyFor(engineId, { kind = 'web', private: isPrivate = false, subject = null } = {}) {
    if (isPrivate) return null;
    if (kind === 'fetch') return null;
    const policy = terms.cacheOf(engineId);
    if (!policy || policy.scope === 'none' || !(policy.ttl_s > 0)) return null;
    if (policy.scope === 'same_user' && !subject) return null;
    return policy;
}

/**
 * The store. Valkey when the service has one (every process shares it), a Map in this process otherwise.
 * A store that is down never stops a search: the cache is skipped and the provider is called.
 */
function createSearchCache({ valkey = null, now = () => Date.now() } = {}) {
    const local = new Map();
    const storeKey = (key) => (valkey ? valkey.key(...key.split(':')) : key);
    /** The kept answer and how old it is, or null. */
    async function get(key) {
        if (valkey) {
            try {
                const raw = await valkey.client.get(storeKey(key));
                if (!raw) return null;
                const parsed = JSON.parse(raw);
                if (!parsed || !Array.isArray(parsed.results)) return null;
                const storedAt = Number(parsed.stored_at) || 0;
                return { results: parsed.results, age_s: Math.max(0, Math.floor((now() - storedAt) / 1000)) };
            } catch { return null; }
        }
        const entry = local.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= now()) { local.delete(key); return null; }
        return { results: entry.results, age_s: Math.max(0, Math.floor((now() - entry.storedAt) / 1000)) };
    }
    /**
     * Keep an answer for as long as the provider's terms allow. A result larger than the cap is not kept.
     * Returns true when it was stored.
     */
    async function set(key, results, ttlS) {
        const seconds = Math.max(1, Math.trunc(Number(ttlS) || 0));
        try {
            const payload = { stored_at: now(), results };
            const text = JSON.stringify(payload);
            if (Buffer.byteLength(text, 'utf8') > MAX_VALUE_BYTES) return false;
            if (valkey) {
                await valkey.client.set(storeKey(key), text, 'EX', seconds);
                return true;
            }
            local.set(key, { results, storedAt: payload.stored_at, expiresAt: now() + seconds * 1000 });
            if (local.size > 1000) local.delete(local.keys().next().value);
            return true;
        } catch { return false; }
    }
    return { get, set };
}

module.exports = { createSearchCache, keyOf, policyFor, normalizeQuery, filtersOf, subjectOf, MAX_VALUE_BYTES, FILTER_KEYS };
