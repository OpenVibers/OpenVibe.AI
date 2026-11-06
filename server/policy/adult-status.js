'use strict';
/**
 * The adult account flag (the Exchange remake, "Uncensored"), read from OpenVibe.Network.
 *
 * Network owns the account and the confirmation: the person ticks "I am 18 or older" in their settings
 * (`public/my.html`, `PUT /api/v1/me/adult`), and the flag lives on their account row. AI never keeps its own copy of
 * somebody's age: a run with `policy: "uncensored"` asks Network, once per person per five minutes, and fails closed
 * when Network cannot answer.
 *
 *   GET /internal/identity/adult?subject_id=usr_…
 *       Authorization: a service token with identity.subject.resolve
 *       → 200 { subject_id, adult: true, confirmed_at }   the person confirmed it
 *       → 200 { subject_id, adult: false }                no confirmation on the account
 *       → 404                                             no such subject
 *
 * The answer is cached for five minutes so a burst of requests from one person costs one call, and the cache is
 * bounded. A failure is never cached: the next request asks again.
 */
const USR = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const CACHE_MS = 5 * 60 * 1000;
const MAX_CACHE = 5000;

class AdultStatusError extends Error {
    constructor(code, detail) {
        super(`${code}: ${detail}`);
        this.code = code;
        this.detail = detail;
    }
}

function createAdultStatus({ config, env = process.env, fetchImpl = globalThis.fetch, clock = { now: () => Date.now() }, log = console } = {}) {
    const secret = env.OV_OAUTH_CLIENT_SECRET || '';
    const base = String((config && config.networkInternalUrl) || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    const cache = new Map();     // subject -> { adult, confirmed_at, at }
    let tokens = null;

    function tokenClient() {
        if (!tokens) {
            const { createServiceTokenClient } = require('openvibe-sdk/auth');
            tokens = createServiceTokenClient({ tokenUrl: `${base}/oauth/token`, clientId: env.OV_OAUTH_CLIENT_ID || 'ai', clientSecret: secret, fetch: fetchImpl });
        }
        return tokens;
    }

    /** Is this subject an account that confirmed it is 18+? Fails closed, never invents an age. */
    async function adultFor(subject) {
        const id = String(subject || '');
        if (!USR.test(id)) return false;
        const hit = cache.get(id);
        if (hit && clock.now() - hit.at < CACHE_MS) return hit.adult;
        const asked = await ask(id);
        if (cache.size >= MAX_CACHE) cache.clear();
        cache.set(id, { ...asked, at: clock.now() });
        return asked.adult;
    }

    async function ask(id) {
        if (!secret) throw new AdultStatusError('adult.unavailable', 'the adult account flag cannot be read here: OV_OAUTH_CLIENT_SECRET is not set');
        let token;
        try { token = await tokenClient().getToken({ audience: 'openvibe.network' }); }
        catch (err) { throw new AdultStatusError('adult.unavailable', `Network did not issue a service token (${String(err && err.message || err).slice(0, 160)})`); }
        let res;
        try {
            res = await fetchImpl(`${base}/internal/identity/adult?subject_id=${encodeURIComponent(id)}`, {
                method: 'GET', signal: AbortSignal.timeout(5000),
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            });
        } catch (err) { throw new AdultStatusError('adult.unavailable', `Network could not be reached (${String(err && err.message || err).slice(0, 160)})`); }
        if (res.status === 404) return { adult: false, confirmed_at: null };
        if (res.status !== 200) throw new AdultStatusError('adult.unavailable', `Network answered ${res.status}`);
        let body = null;
        try { body = await res.json(); } catch { body = null; }
        if (!body || typeof body !== 'object') throw new AdultStatusError('adult.unavailable', 'Network answered with no JSON');
        return { adult: body.adult === true, confirmed_at: body.confirmed_at || null };
    }

    /** Forget one person's answer (the settings screen changing the flag, and tests). */
    function forget(subject) { cache.delete(String(subject || '')); }
    function clear() { cache.clear(); }

    return { adultFor, forget, clear, get enabled() { return Boolean(secret); } };
}

module.exports = { createAdultStatus, AdultStatusError, USR, CACHE_MS };
