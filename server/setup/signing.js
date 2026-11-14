'use strict';
/**
 * How a host proves that a key is its own: the three signatures a server host needs.
 *
 *   OVHcloud      an application key, an application secret and a consumer key, signed into a header
 *   Oracle Cloud  a service account's own key pair, signed into the Authorization header (OCI's own scheme)
 *   Google Cloud  a service account's JSON key, signed into a JWT that buys a short access token
 *
 * A signature is made with the owner's own key and is never written anywhere: it lives in the header of the
 * one read that tests it, and the answer carries only what the host said.
 */
const crypto = require('crypto');

/** The base64url of a buffer or a string (the JWT and the signature use it). */
function b64url(input) {
    return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * OVHcloud's signature (https://api.ovh.com/createToken/): HMAC-SHA1 of the consumer key, the method, the
 * query, the body and the timestamp, keyed with the application secret. The answer carries the headers the
 * call needs and nothing else.
 */
function ovhHeaders({ applicationKey, applicationSecret, consumerKey, method = 'GET', url, body = '', timestamp }) {
    const at = String(timestamp || Math.floor(Date.now() / 1000));
    const target = new URL(url);
    const toSign = [consumerKey, method.toUpperCase(), target.pathname + target.search, body, at].join('+');
    const signature = crypto.createHmac('sha1', String(applicationSecret)).update(toSign).digest('base64');
    return {
        'X-Ovh-Application': String(applicationKey),
        'X-Ovh-Consumer': String(consumerKey),
        'X-Ovh-Timestamp': at,
        'X-Ovh-Signature': '$1$' + signature,
    };
}

/**
 * Oracle Cloud's signature (https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm): the
 * RSA-SHA256 of the request's own parts, keyed with the user's private key. The key id is the tenancy, the
 * user and the fingerprint, as three ocids joined by slashes.
 */
function ociHeaders({ tenancy, user, fingerprint, privateKey, method = 'GET', url, body = '', now = new Date() }) {
    const target = new URL(url);
    const date = now.toUTCString();
    const host = target.host;
    // The body hash is the Base64 SHA-256 of the body, as OCI's own signers write it.
    const contentHash = crypto.createHash('sha256').update(body || '').digest('base64');
    const headers = {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body || '')),
        date,
        host,
        'x-content-sha256': contentHash,
    };
    const names = ['content-length', 'content-type', 'date', 'host', 'x-content-sha256'];
    // The signable string, in OCI's own order: the verb, the request URI, the canonical headers, the names
    // of the signed headers, and the hashed body.
    const canonicalHeaders = names.map((name) => name + ':' + String(headers[name]).trim() + '\n').join('');
    const signedHeaders = names.join(' ');
    const signable = [method.toUpperCase(), target.pathname + target.search, canonicalHeaders, signedHeaders, contentHash].join('\n');
    const pem = String(privateKey || '').replace(/\\n/g, '\n');
    const signature = crypto.createSign('RSA-SHA256').update(signable).sign(pem, 'base64');
    return {
        date,
        host,
        'content-type': headers['content-type'],
        'content-length': headers['content-length'],
        'x-content-sha256': contentHash,
        signable,
        authorization: 'Signature version="1",keyId="' + tenancy + '/' + user + '/' + fingerprint + '",algorithm="rsa-sha256",headers="' + signedHeaders + '",signature="' + signature + '"',
    };
}

/**
 * Google's own: a service account's JSON key signs a JWT, and the JWT buys a short access token for the
 * cloud platform scope. The token is used once and never written down.
 */
async function googleAccessToken({ serviceAccount, fetchImpl, now = Date.now, timeoutMs = 10_000 }) {
    let account;
    try { account = typeof serviceAccount === 'string' ? JSON.parse(serviceAccount) : serviceAccount; }
    catch { return { ok: false, message: 'the service account key is not a JSON document' }; }
    if (!account || !account.client_email || !account.private_key) {
        return { ok: false, message: 'the service account key has no client_email or private_key' };
    }
    const issued = Math.floor(now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
        iss: account.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: account.token_uri || 'https://oauth2.googleapis.com/token',
        iat: issued,
        exp: issued + 3600,
    };
    const signed = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims));
    let signature;
    try {
        signature = crypto.createSign('RSA-SHA256').update(signed).sign(String(account.private_key).replace(/\\n/g, '\n'), 'base64');
    } catch (err) {
        return { ok: false, message: 'the service account key could not sign a request: ' + (err && err.message ? String(err.message).slice(0, 120) : 'the private key is not readable') };
    }
    const assertion = signed + '.' + b64url(signature);
    const url = account.token_uri || 'https://oauth2.googleapis.com/token';
    let res;
    try {
        res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
            body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + encodeURIComponent(assertion),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        return { ok: false, message: 'Google did not answer for the access token: ' + (err && err.name === 'TimeoutError' ? 'it did not answer in time' : 'it could not be reached') };
    }
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (res.status < 200 || res.status >= 300) {
        const says = json && json.error && json.error.message ? String(json.error.message).slice(0, 160) : json && json.error_description ? String(json.error_description).slice(0, 160) : '';
        return { ok: false, message: 'Google refused the service account (' + res.status + ')' + (says ? ': ' + says : '.') };
    }
    if (!json || !json.access_token) return { ok: false, message: 'Google answered without an access token.' };
    return { ok: true, token: json.access_token, expires_in: json.expires_in || 3600 };
}

module.exports = { ovhHeaders, ociHeaders, googleAccessToken, b64url };
