'use strict';
/**
 * One redaction for the keys that travel in a query string (plan §W.2 step 3, 11-13).
 *
 * Some providers take their key in the URL: SerpApi and Pixabay put it in `api_key` and `key`, Mojeek and
 * Europeana in `api_key` and `wskey`, You.com in the header. A URL that reaches a log, an error, a receipt or a
 * trace must never carry it, so every one of those places goes through this module: `redact()` masks the value of
 * a named parameter wherever it appears, in a URL or in a bare `name=value` pair, and masks a key that was put
 * in a header.
 *
 * The names are the ones a provider, a proxy or a client library uses for a secret:
 *   api_key | apikey | key | token | access_token | app_id | app_key | client_secret
 */
const SECRET_PARAMS = ['api_key', 'apikey', 'key', 'token', 'access_token', 'app_id', 'app_key', 'client_secret'];
const MASK = 'REDACTED';

// api_key, api-key, apiKey: the same name written in three ways.
const NAME = SECRET_PARAMS
    .map(n => n.replace(/_/g, '[_-]?'))
    .join('|');
const PAIR = new RegExp('(^|[^A-Za-z0-9_-])(' + NAME + ')(\\s*=\\s*)([^&\\s"\'<>\\)\\]]+)', 'gi');
const HEADER = new RegExp('((?:x-)?(?:api[_-]?key|apikey|token|access[_-]?token)\\s*[:=]\\s*)([^\\s,;"\']+)', 'gi');
// An authorization header carries the whole value: Bearer and all.
const AUTH = /(authorization\s*[:=]\s*)([^\r\n]+)/gi;

/** True when a parameter name is one that carries a secret. */
function isSecretName(name) {
    const n = String(name || '').toLowerCase().replace(/[-_]/g, '');
    return SECRET_PARAMS.some(p => p.replace(/[-_]/g, '') === n);
}

/**
 * Mask the secret parameters of a URL (or of every URL inside a text). A URL that cannot be parsed still gets
 * its query pairs masked, so a malformed upstream URL cannot carry a key out of here.
 */
function redactUrl(value) {
    if (value == null) return value;
    const s = typeof value === 'string' ? value : String(value);
    return s.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (m, sep, name, val) => (isSecretName(name) ? sep + name + '=' + MASK : m));
}

/**
 * Mask a secret wherever it appears in a text: a query parameter, a bare name=value pair or a header line.
 * Nothing else in the text changes, so an error message stays readable.
 */
function redact(value) {
    if (value == null) return value;
    const s = typeof value === 'string' ? value : String(value);
    return s
        .replace(PAIR, (m, before, name, eq) => before + name + eq + MASK)
        .replace(AUTH, (m, head) => head + MASK)
        .replace(HEADER, (m, head) => head + MASK)
        .split(' ')
        .map(part => (/^https?:\/\//.test(part) ? redactUrl(part) : part))
        .join(' ');
}

/** The same redaction for an error: its message and its stack. */
function redactError(error) {
    if (!error) return error;
    if (error.message) error.message = redact(error.message);
    if (error.stack) error.stack = redact(error.stack);
    return error;
}

module.exports = { redact, redactUrl, redactError, isSecretName, SECRET_PARAMS, MASK };
