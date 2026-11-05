'use strict';
/**
 * OpenVibe.Network single sign-on for the operator console: the OAuth half comes from
 * openvibe-sdk/sso (createSsoClient), as OAuth client `ai` (the client AI already uses for its
 * service tokens). The console keeps its own short staff session, CSRF token and staff checks in
 * session.js / index.js; this module owns only the handshake:
 *
 *   start()      <OV_NETWORK_URL>/oauth/authorize?response_type=code&client_id=ai
 *                &redirect_uri=<BASE_URL>/auth/callback&scope=profile&state=…&code_challenge=…
 *                &code_challenge_method=S256
 *   exchange()   the SDK's token grant (client secret + code_verifier), server to server; the access
 *                token is then verified with openvibe-sdk/auth verifyUserToken against the Network's
 *                JWKS (or the pinned OV_NETWORK_PUBLIC_KEY), as a person
 *   checkClient() the SDK's health check: does the Network accept this client? (/auth/health)
 *
 * The Network's user access token carries `role`, `is_owner` and `subject_id` (and, once the Network
 * issues them, `staff_caps` / `staff_map`), minted at the code exchange, so what the console reads
 * is current as of sign-in; the session is short. AI keeps none of the Network's tokens: the refresh
 * token it is handed is revoked straight away (best effort).
 */
const { ids, staff } = require('openvibe-contracts');
const { verifyUserToken } = require('openvibe-sdk/auth');
const { createSsoClient } = require('openvibe-sdk/sso');

const PRINCIPAL_SUB = /^(svc|app|mod):/;

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

function createConsoleSso({ config, clientSecret, fetchImpl = globalThis.fetch, log = console }) {
    const cc = config.console;
    const client = createSsoClient({
        site: 'ai',
        siteName: 'OpenVibe.AI',
        baseUrl: config.baseUrl,
        clientId: cc.clientId,
        clientSecret,
        networkUrl: config.networkUrl,
        networkInternalUrl: config.networkInternalUrl,
        issuer: config.issuer,
        redirectUri: cc.redirectUri,
        scope: 'profile',
        audience: cc.ssoAudience,
        fetch: fetchImpl,
        log,
    });

    /** The authorize URL and the state/verifier the flow cookie must keep. → { url, state, verifier } */
    function start() {
        return client.authorizeUrl();
    }

    /** Redeem the code with the SDK, verify the person's token, revoke the refresh token AI will not use. */
    async function exchange({ code, verifier, now = Date.now() }) {
        const data = await client.tokenGrant({
            grant_type: 'authorization_code',
            redirect_uri: cc.redirectUri,
            code: String(code),
            code_verifier: verifier,
        });
        if (!data || !data.access_token) {
            throw Object.assign(new Error('the Network sent no access token'), { status: 502 });
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

    /** 'ok' | 'invalid' | 'unknown': does the Network accept this site's OAuth client? */
    function checkClient() {
        return client.checkClient();
    }

    return { start, exchange, checkClient };
}

module.exports = { createConsoleSso, personFromClaims, verifyUserToken };
