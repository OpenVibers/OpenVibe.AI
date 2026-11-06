'use strict';
/**
 * Plan E5: the trust signals Network supplies through its existing identity read, cached in AI.
 *
 *   GET {OV_NETWORK_INTERNAL_URL}/internal/identity/resolve?subject_id=usr_…&trust=1
 *   Authorization: a service token with identity.subject.resolve
 *
 * The answer is the usual projection plus `trust`:
 *   { account_age_hours, account_age_days, verified, verified_by, passkey, linked_accounts, active_30d }
 *
 * Network computes the facts (server/identity/trust.js): a passkey backup, a linked account, or an account 30
 * days old that was active in the last 30 days. AI never asks for an email or a linked account's identity.
 * A miss is cached briefly and treated as unavailable: the allowance falls back to the new tier, the
 * conservative side, not to a remembered "verified".
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const USR = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function numberOf(value, max = 1e9) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.min(max, n) : 0;
}

/** Only the fields the allowance uses, with sane types; anything else is dropped. */
function normalize(trust) {
    if (!trust || typeof trust !== 'object') return null;
    const by = Array.isArray(trust.verified_by) ? trust.verified_by.filter((x) => typeof x === 'string' && x).slice(0, 8) : [];
    return {
        account_age_hours: numberOf(trust.account_age_hours, 100 * 365 * 24),
        account_age_days: numberOf(trust.account_age_days, 36500),
        verified: trust.verified === true || trust.verified === 1,
        verified_by: by,
        passkey: trust.passkey === true,
        linked_accounts: numberOf(trust.linked_accounts, 100),
        active_30d: trust.active_30d === true,
    };
}

/**
 * createNetworkSignals({ config, env, fetchImpl, clock, log, tokens }): one cached read per subject.
 * `tokens` is a service-token client (tests pass a stub); production builds one from OV_OAUTH_CLIENT_SECRET.
 */
function createNetworkSignals({ config, env = process.env, fetchImpl = globalThis.fetch, clock = { now: () => Date.now() }, log = console, tokens = null } = {}) {
    const cfg = (config && config.abuse) || {};
    const network = String((config && config.networkInternalUrl) || '').replace(/\/+$/, '');
    const secret = env.OV_OAUTH_CLIENT_SECRET || '';
    const clientId = (config && config.console && config.console.clientId) || env.OV_OAUTH_CLIENT_ID || 'ai';
    let client = tokens;
    if (!client && secret && network && cfg.network) {
        client = createServiceTokenClient({
            tokenUrl: `${network}/oauth/token`, clientId, clientSecret: secret,
            scope: { 'openvibe.network': 'identity.subject.resolve' }, fetch: fetchImpl,
        });
    }
    const ttlMs = Math.max(1000, Number(cfg.signalsTtlMs) || 300_000);
    const missTtlMs = Math.max(1000, Math.min(ttlMs, Number(cfg.signalsMissTtlMs) || 60_000));
    const timeoutMs = Math.max(100, Number(cfg.signalsTimeoutMs) || 2000);
    const enabled = Boolean(cfg.network && network && client);
    const cache = new Map();
    const inflight = new Map();

    async function read(subject) {
        const token = await client.getToken({ audience: 'openvibe.network' });
        const url = `${network}/internal/identity/resolve?subject_id=${encodeURIComponent(subject)}&trust=1`;
        const res = await fetchImpl(url, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`Network identity read answered ${res.status}`);
        const body = await res.json().catch(() => null);
        const trust = normalize(body && body.trust);
        if (!trust) throw new Error('Network identity read carried no trust object');
        return { available: true, ...trust };
    }

    /** The signals for a person subject. Never throws: an outage is `{ available: false }`. */
    async function get(subject) {
        const id = String(subject || '');
        if (!USR.test(id)) return { available: false, reason: 'not a person' };
        if (!enabled) return { available: false, reason: 'disabled' };
        const hit = cache.get(id);
        const now = clock.now();
        if (hit && now - hit.at < (hit.value.available ? ttlMs : missTtlMs)) return hit.value;
        if (inflight.has(id)) return inflight.get(id);
        const p = (async () => {
            let value;
            try { value = await read(id); } catch (err) {
                if (cfg.logMisses !== false) log.warn(`[abuse] the Network trust read failed: ${err && err.message}`);
                value = { available: false, reason: 'network' };
            }
            cache.set(id, { at: now, value });
            inflight.delete(id);
            return value;
        })();
        inflight.set(id, p);
        return p;
    }

    return { enabled, get, normalize, _cache: cache };
}

module.exports = { createNetworkSignals, normalize, USR };
