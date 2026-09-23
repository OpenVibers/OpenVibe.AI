'use strict';
/**
 * Authentication: callers present OpenVibe.Network service tokens (RS256 client-credentials JWTs,
 * audience openvibe.ai), verified with openvibe-contracts serviceAuth.verifyServiceToken.
 *
 * Capabilities ai.run.create / ai.run.read / ai.workflow.manage / ai.provider.manage / ai.usage.read
 * are proposed in docs/capabilities-proposal/ and are not in openvibe-contracts yet. Until they
 * ship, allows() decides with the contracts' own grant rule (the exact id, or a `family.*` grant);
 * once contracts knows an id, contracts decides.
 *
 * Namespaces fail closed: a token may only run workflows inside the namespaces it holds (the same
 * matching as contracts' namespaceAllowed: 'live.*' allows 'live.translate'). The `ns` claim decides
 * when it is non-empty. A first-party service token WITHOUT one (Network grants Live's ai.run.create
 * with no namespaces) falls back to its entry in AI_NS_FALLBACK, else to its own `<service>.*`
 * (svc:news -> news.*). App and module tokens without `ns` run nothing. AI_NS_REQUIRED=false restores
 * the old rule (no `ns` = every namespace) and exists only as a rollback lever.
 */
const crypto = require('crypto');
const { serviceAuth, capabilities, http } = require('openvibe-contracts');

const CAPS = Object.freeze({
    runCreate: 'ai.run.create',
    runRead: 'ai.run.read',
    workflowManage: 'ai.workflow.manage',
    providerManage: 'ai.provider.manage',
    usageRead: 'ai.usage.read',
});

/** Loads the Network signing key from /api/.well-known/jwks (retrying), or uses a configured PEM. */
function createKeyStore({ urls = [], pem = null, fetchImpl = globalThis.fetch, log = console } = {}) {
    let key = pem ? toPem(pem) : null;
    let retryTimer = null;
    let refreshTimer = null;

    function toPem(value) {
        return crypto.createPublicKey(value).export({ type: 'spki', format: 'pem' });
    }

    async function fetchOnce() {
        for (const base of urls) {
            if (!base) continue;
            const url = `${base}/api/.well-known/jwks`;
            try {
                const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const body = await res.json();
                const jwk = (body.keys || []).find(k => k.kty === 'RSA');
                if (jwk) key = toPem({ key: jwk, format: 'jwk' });
                else if (typeof body.public_key === 'string' && body.public_key.includes('BEGIN')) key = toPem(body.public_key);
                else throw new Error('no RSA key in response');
                log.log(`[auth] Network public key loaded from ${base}`);
                return key;
            } catch (err) {
                log.warn(`[auth] key fetch from ${url} failed: ${err.message}`);
            }
        }
        return null;
    }

    function start() {
        if (pem) return Promise.resolve(key);
        const attempt = async () => {
            const k = await fetchOnce();
            if (!k && !key) {
                retryTimer = setTimeout(attempt, 30 * 1000);
                retryTimer.unref?.();
            }
            return k;
        };
        refreshTimer = setInterval(() => { fetchOnce().catch(() => {}); }, 6 * 60 * 60 * 1000);
        refreshTimer.unref?.();
        return attempt();
    }

    function stop() { clearTimeout(retryTimer); clearInterval(refreshTimer); }

    return { get: () => key, loaded: () => Boolean(key), start, stop, fetchOnce };
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

const DEFAULT_NAMESPACES = Object.freeze({ required: true, fallback: Object.freeze({}), derive: true });

/** The namespaces a principal may run: its `ns` claim, or (service tokens only) the documented fallback. */
function effectiveNamespaces(principal, nsConfig = DEFAULT_NAMESPACES) {
    const ns = principal && Array.isArray(principal.ns) ? principal.ns.filter(n => typeof n === 'string' && n) : [];
    if (ns.length) return ns;
    const m = /^svc:([a-z][a-z0-9-]{1,39})$/.exec(String((principal && principal.sub) || ''));
    if (!m || !nsConfig.derive) return [];
    const listed = nsConfig.fallback && Object.prototype.hasOwnProperty.call(nsConfig.fallback, m[1]) ? nsConfig.fallback[m[1]] : null;
    return listed && listed.length ? [...listed] : [`${m[1]}.*`];
}

function namespaceAllowed(principal, workflowKey, nsConfig = DEFAULT_NAMESPACES) {
    const ns = principal && Array.isArray(principal.ns) ? principal.ns : [];
    if (!ns.length && nsConfig.required === false) return true;    // AI_NS_REQUIRED=false: the old, open rule
    return capabilities.namespaceAllowed(effectiveNamespaces(principal, nsConfig), workflowKey);
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

function createAuth({ config, keys }) {
    function verify(token) {
        const publicKey = keys.get();
        if (!publicKey) return { ok: false, code: 'token.unavailable', reason: 'signing key not loaded yet' };
        return serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.issuer, audience: config.audience });
    }

    /**
     * Express guard. `anyOf` lists capability ids; one granted is enough.
     * Sets req.principal = { sub, subject: {type,id}, cap, ns, jti }.
     */
    function requireCap(...anyOf) {
        return function capGuard(req, res, next) {
            const ctx = req.ov;
            const token = bearer(req);
            if (!token) return http.sendProblem(res, 401, 'token.missing', { detail: 'a service token (audience openvibe.ai) is required', ctx });
            const r = verify(token);
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
        };
    }

    /** Does the authenticated principal also hold `id`? (for owner-or-admin checks) */
    function principalHas(req, id) { return Boolean(req.principal && allows(req.principal.claims, id).allowed); }

    return { verify, requireCap, principalHas };
}

module.exports = { CAPS, createKeyStore, createAuth, hasCap, allows, namespaceAllowed, effectiveNamespaces, principalSubject, bearer };
