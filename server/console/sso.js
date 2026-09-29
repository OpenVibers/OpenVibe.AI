'use strict';
/**
 * OpenVibe.Network single sign-on for the operator console: OAuth 2 authorization code with PKCE
 * (S256), as OAuth client `ai` (the client AI already uses for its service tokens).
 *
 *   authorizeUrl()  <OV_NETWORK_URL>/oauth/authorize?response_type=code&client_id=ai
 *                   &redirect_uri=<BASE_URL>/auth/callback&scope=profile&state=…&code_challenge=…
 *                   &code_challenge_method=S256
 *   exchange()      POST <OV_NETWORK_INTERNAL_URL>/oauth/token (client secret + code_verifier), server
 *                   to server; the access token is then verified with openvibe-sdk/auth verifyUserToken
 *                   against the Network's JWKS (or the pinned OV_NETWORK_PUBLIC_KEY), as a person
 *
 * The Network's user access token carries `role`, `is_owner` and `subject_id` (and, once the Network
 * issues them, `staff_caps` / `staff_map`), minted at the code exchange, so what the console reads
 * is current as of sign-in; the session is short. AI keeps none of the Network's tokens: the refresh
 * token it is handed is revoked straight away (best effort).
 */
const crypto = require('crypto');
const { ids, staff } = require('openvibe-contracts');
const { verifyUserToken } = require('openvibe-sdk/auth');

const PRINCIPAL_SUB = /^(svc|app|mod):/;

function pkcePair() {
    const verifier = crypto.randomBytes(32).toString('base64url');           // 43 chars
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

function authorizeUrl(config, { state, challenge }) {
    const q = new URLSearchParams({
        response_type: 'code',
        client_id: config.console.clientId,
        redirect_uri: config.console.redirectUri,
        scope: 'profile',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
    });
    return `${config.networkUrl}/oauth/authorize?${q.toString()}`;
}

/**
 * The person a verified token names: { subject, username, staff } or { error }. Service, app and
 * module principals and FedCM assertions are not people; a person needs a usr_ subject. `staff` is
 * the staff part of the claims (the contracts staff map's claim names), kept on the session so the
 * console can ask staff.can() on every request.
 */
function personFromClaims(claims) {
    if (!claims || typeof claims !== 'object') return { error: 'not a token' };
    if (PRINCIPAL_SUB.test(String(claims.sub || '')) || claims.actor_type === 'service' || claims.actor_type === 'app') return { error: 'not a person\'s token' };
    if (claims.typ === 'fedcm') return { error: 'a FedCM assertion is not a sign-in' };
    if (!ids.isSubjectId('user', claims.subject_id)) return { error: 'the token carries no network subject' };
    const c = staff.map.claims;
    const staffClaims = { [c.role]: typeof claims[c.role] === 'string' ? claims[c.role] : 'user' };
    if (claims[c.owner] === true) staffClaims[c.owner] = true;
    if (Array.isArray(claims[c.capabilities])) staffClaims[c.capabilities] = claims[c.capabilities].filter(x => typeof x === 'string').slice(0, 100);
    if (typeof claims[c.map] === 'string') staffClaims[c.map] = claims[c.map].slice(0, 20);
    return {
        subject: claims.subject_id,
        username: typeof claims.username === 'string' ? claims.username.slice(0, 64) : null,
        staff: staffClaims,
    };
}

async function exchange({ config, clientSecret, code, verifier, now = Date.now(), fetchImpl = globalThis.fetch, log = null }) {
    const cc = config.console;
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: cc.redirectUri,
        client_id: cc.clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
    });
    const res = await fetchImpl(`${config.networkInternalUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.access_token) {
        const err = new Error((data && (data.error_description || data.error)) || `token endpoint ${res.status}`);
        err.status = res.status;
        throw err;
    }
    // AI never uses the Network session again: drop the refresh token now.
    if (data.refresh_token) {
        Promise.resolve(fetchImpl(`${config.networkInternalUrl}/oauth/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: cc.clientId, client_secret: clientSecret, token: data.refresh_token }),
            signal: AbortSignal.timeout(3000),
        })).catch(() => {});
    }
    const claims = await verifyUserToken(data.access_token, {
        ...(config.networkPublicKey ? { publicKey: config.networkPublicKey } : { jwks: config.networkJwksUrl }),
        issuer: config.issuer, audience: cc.ssoAudience, now, log,
    });
    return personFromClaims(claims);
}

module.exports = { pkcePair, authorizeUrl, verifyUserToken, personFromClaims, exchange };
