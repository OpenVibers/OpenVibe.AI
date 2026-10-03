'use strict';
/**
 * Authentication: callers present OpenVibe.Network service tokens (RS256 client-credentials JWTs,
 * audience openvibe.ai), verified with openvibe-contracts serviceAuth.verifyServiceToken (the claim
 * schema, sandbox refusal, issuer and audience). Only the KEY comes from the SDK: one JWKS client per
 * URL (openvibe-sdk/auth jwksClient) gives fresh keys, the last good keys through an outage,
 * exponential backoff, and a rotation honoured on an unknown kid. OV_NETWORK_PUBLIC_KEY still pins a
 * PEM, which skips the fetch entirely.
 *
 * Capabilities ai.run.create / ai.run.read / ai.workflow.manage / ai.provider.manage / ai.usage.read
 * are proposed in docs/capabilities-proposal/ and are not in openvibe-contracts yet; ai.credential.manage
 * and ai.quota.attribution.manage ship in contracts (0.73.0 / 0.75.0). Until the five do, allows()
 * decides with the contracts' own grant rule (the exact id, or a `family.*` grant); once contracts
 * knows an id, contracts decides.
 *
 * Namespaces fail closed: a token may only run workflows inside the namespaces its `ns` claim holds
 * (the same matching as contracts' namespaceAllowed: 'live.*' allows 'live.translate'). A token
 * without one runs nothing. Every caller's Network grant names its namespaces; the fallback for
 * ns-less service tokens (AI_NS_FALLBACK) and the open-rule lever (AI_NS_REQUIRED=false), shims
 * C-22 and C-23, were retired on 2026-09-28 once no token without `ns` was left.
 */
const { serviceAuth, capabilities, http } = require('openvibe-contracts');
const { jwksClient, jwksStatus } = require('openvibe-sdk/auth');

const CAPS = Object.freeze({
    runCreate: 'ai.run.create',
    runRead: 'ai.run.read',
    workflowManage: 'ai.workflow.manage',
    providerManage: 'ai.provider.manage',
    usageRead: 'ai.usage.read',
    credentialManage: 'ai.credential.manage',
    quotaAttributionManage: 'ai.quota.attribution.manage',
});

/**
 * The Network signing keys, through the SDK's process-wide JWKS client (one per URL). A pinned
 * OV_NETWORK_PUBLIC_KEY PEM skips the fetch entirely; /api/ready reports either as ready.
 */
function createNetworkKeys({ config }) {
    const pinned = config.networkPublicKey || null;
    return {
        pinned: Boolean(pinned),
        /** Every JWKS client's state (url, ready, keys, fetchedAt, stale, failures, lastError, nextTryAt). */
        status: () => (pinned ? [{ url: null, ready: true, keys: 1, pinned: true }] : jwksStatus()),
    };
}

/** Exact id or `family.*` grant (the rule openvibe-contracts applies to the capabilities it knows). */
function hasCap(claims, id) {
    const granted = claims && Array.isArray(claims.cap) ? claims.cap : [];
    return granted.some(g => g === id || (g.endsWith('.*') && id.startsWith(g.slice(0, -1))));
}

function allows(claims, id) {
    if (!hasCap(claims, id)) return { allowed: false, code: 'capability.denied', reason: `${id} not granted` };
    if (!capabilities.get(id)) return { allowed: true, code: null, reason: null };   // not in contracts yet: local rule decided
    const c = capabilities.check(claims, id);
    return c;
}

/** The namespaces a principal may run: its `ns` claim, nothing else. */
function effectiveNamespaces(principal) {
    return principal && Array.isArray(principal.ns) ? principal.ns.filter(n => typeof n === 'string' && n) : [];
}

function namespaceAllowed(principal, workflowKey) {
    return capabilities.namespaceAllowed(effectiveNamespaces(principal), workflowKey);
}

function bearer(req) {
    const h = String(req.headers.authorization || '');
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/** svc:live -> { type: 'service', id: 'live' }; app:/mod: principals keep their type. */
function principalSubject(sub) {
    const m = /^(svc|app|mod):(.+)$/.exec(String(sub || ''));
    if (!m) return null;
    return { type: m[1] === 'svc' ? 'service' : m[1], id: m[2] };
}

function createAuth({ config, log = console }) {
    /** The kid a token's header names (null when absent or undecodable). */
    function headerKid(token) {
        try { return JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8')).kid || null; } catch { return null; }
    }

    /**
     * A Network service/app token: the key from the SDK's JWKS client (or the pinned PEM), every rule
     * from openvibe-contracts' verifyServiceToken (identity.service-token-claims@1, env: sandbox refused).
     */
    async function verify(token) {
        const check = (publicKey) => serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.issuer, audience: config.audience });
        if (config.networkPublicKey) return check(config.networkPublicKey);
        let keys;
        try { keys = await jwksClient(config.networkJwksUrl, { log }).keysForKid(headerKid(token)); } catch (err) {
            // token.no_key (503): no keys loaded yet, so nothing can be verified; retryable, as before. The
            // SDK's message names the internal JWKS URL and the fetch error: logged by the client, never answered.
            return { ok: false, code: 'token.unavailable', reason: 'signing key not loaded yet' };
        }
        const kid = headerKid(token);
        const byKid = kid ? keys.filter((k) => k.kid === kid) : [];
        let last = { ok: false, code: 'token.unavailable', reason: 'no signing key' };
        for (const k of byKid.length ? byKid : keys) {
            last = check(k.key);
            if (last.ok || last.code !== 'token.bad_signature') return last;
        }
        return last;
    }

    /**
     * Express guard. `anyOf` lists capability ids; one granted is enough.
     * Sets req.principal = { sub, subject: {type,id}, cap, ns, jti }.
     */
    function requireCap(...anyOf) {
        return async function capGuard(req, res, next) {
            const ctx = req.ov;
            try {
                const token = bearer(req);
                if (!token) return http.sendProblem(res, 401, 'token.missing', { detail: 'a service token (audience openvibe.ai) is required', ctx });
                const r = await verify(token);
                if (!r.ok) return http.sendProblem(res, r.code === 'token.unavailable' ? 503 : 401, r.code, { detail: r.reason, ctx });
                let decision = null;
                for (const id of anyOf) {
                    decision = allows(r.claims, id);
                    if (decision.allowed) break;
                }
                if (!decision.allowed) return http.sendProblem(res, 403, decision.code, { detail: anyOf.length > 1 ? `one of ${anyOf.join(', ')} is required` : decision.reason, ctx });
                const subject = principalSubject(r.claims.sub);
                req.principal = { sub: r.claims.sub, subject, cap: r.claims.cap, ns: r.claims.ns || [], jti: r.claims.jti, claims: r.claims };
                return next();
            } catch (err) {
                log.error(`[auth] ${req.method} ${req.path}: ${(err && err.stack) || err}`);
                if (!res.headersSent) http.sendProblem(res, 500, 'internal.error', { detail: 'internal error', ctx });
            }
        };
    }

    /** Does the authenticated principal also hold `id`? (for owner-or-admin checks) */
    function principalHas(req, id) { return Boolean(req.principal && allows(req.principal.claims, id).allowed); }

    return { verify, requireCap, principalHas };
}

module.exports = { CAPS, createNetworkKeys, createAuth, hasCap, allows, namespaceAllowed, effectiveNamespaces, principalSubject, bearer };
