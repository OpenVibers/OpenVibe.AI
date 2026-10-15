'use strict';
/**
 * Project secrets (ADR-056) through OpenVibe.Network's POST /internal/secrets/use, with AI's own service token
 * (network.secret.use, audience openvibe.network). A developer app's run may name its project's own provider key:
 *
 *   reveal({ project_id, environment, name, origin }) → { value, version }
 *
 * The project's grant of that secret to `ai` for reveal to the provider's origin decides. Network answers 404 for a
 * secret that does not exist or is not granted (SecretRefused, final for the run); anything else (Network unreachable,
 * no service credentials here) is thrown as it is. A revealed value is used for the one run it is for and never kept,
 * logged or stored.
 */
const { AiError } = require('./util');

class SecretRefused extends AiError {
    constructor(detail) { super(403, 'project_secret.refused', detail); }
}

function createProjectSecrets({ config, env = process.env, fetchImpl = globalThis.fetch }) {
    const base = String(config.networkInternalUrl || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    const secret = env.OV_OAUTH_CLIENT_SECRET || '';
    let tokens = null;
    const tokenClient = () => {
        if (!tokens) {
            const { createServiceTokenClient } = require('openvibe-sdk/auth');
            tokens = createServiceTokenClient({ tokenUrl: `${base}/oauth/token`, clientId: env.OV_OAUTH_CLIENT_ID || 'ai', clientSecret: secret, fetch: fetchImpl });
        }
        return tokens;
    };
    return {
        available: () => Boolean(secret),
        async reveal({ project_id, environment, name, origin }) {
            if (!secret) throw new AiError(503, 'project_secret.unavailable', 'project secrets are not configured on this service');
            const t = await tokenClient().getToken({ audience: 'openvibe.network' });
            let res;
            try {
                res = await fetchImpl(`${base}/internal/secrets/use`, {
                    method: 'POST', signal: AbortSignal.timeout(5000),
                    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify({ project_id, environment, name, purpose: 'reveal', origin }),
                });
            } catch (err) {
                throw new AiError(503, 'project_secret.unavailable', `OpenVibe.Network did not answer: ${err.message}`);
            }
            const body = await res.json().catch(() => null);
            if (res.status === 404) throw new SecretRefused(`project secret ${name} (${environment}) does not exist, or is not granted to ai for reveal to ${origin}`);
            if (!res.ok || !body || typeof body.value !== 'string' || !body.value) throw new AiError(503, 'project_secret.unavailable', `OpenVibe.Network answered ${res.status}`);
            return { value: body.value, version: body.version };
        },
    };
}

module.exports = { createProjectSecrets, SecretRefused };
