'use strict';
/**
 * The credential a request names in its header (Codes C3): `x-openvibe-credential: <provider>` or
 * `<provider>:<subject>`.
 *
 * Without it the router picks an upstream. With it the run uses that person's own key for that provider, which is
 * what a harness that runs on the person's own machine sends (its base URL points here and its token names them).
 * The person is the subject in the header, or the subject the token acts for (on_behalf_of: a run token, Codes C3).
 * The key itself never comes here: it stays sealed in the vault (server/credentials.js).
 *
 * The two model endpoints read the same header: POST /v1/messages (Anthropic's format) and POST
 * /v1/chat/completions (OpenAI's format).
 */
function credentialFor(req) {
    const raw = String(req.get('x-openvibe-credential') || '').trim();
    if (!raw) return {};
    const m = /^([a-z]+)(?::(.+))?$/.exec(raw);
    if (!m) return { status: 400, error: 'x-openvibe-credential must be <provider> or <provider>:<subject>' };
    const provider = m[1];
    const subject = m[2] || (req.principal && req.principal.claims && req.principal.claims.on_behalf_of) || null;
    if (!subject) return { status: 400, error: `x-openvibe-credential ${provider} needs the person whose key it is: send <provider>:<subject>, or use a token that acts for them (on_behalf_of)` };
    return { credential: { subject, provider } };
}

module.exports = { credentialFor };
