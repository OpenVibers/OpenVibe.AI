'use strict';
/**
 * A person's own machine as their model (AI on your own machines: contracts 0.219.0 bot.command@1 kind ai and the
 * capability bot.machine.ai; 0.220.0 the credential provider node). One chat completion goes through OpenVibe.Bot,
 * POST /api/v1/machines/:id/commands with kind ai, as OpenVibe.AI acting for the person (X-OV-Subject), to the machine's
 * own model server (OpenVibe Node's ai plugin: Ollama, LM Studio, llama.cpp). Bot checks that the machine is theirs and
 * that they turned on "Let my AI use this computer's models"; the prompt never reaches anyone else's machine.
 *
 * Off without OV_BOT_INTERNAL_URL or a client secret: a credential with provider node is then refused, never sent
 * elsewhere. → chat({ machine, subject, model, messages, maxTokens, temperature, signal, timeoutMs })
 *   -> { text, model, usage: { input, output, cached } }
 */
const { AiError } = require('./util');

const MACHINE_RE = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function createMachineModels({ config, env = process.env, fetchImpl = globalThis.fetch, tokens: override = null }) {
    const base = String((config.bot && config.bot.url) || '').replace(/\/+$/, '');
    const secret = env.OV_OAUTH_CLIENT_SECRET || '';
    const enabled = Boolean(base && (override || secret));
    let tokens = override;
    const tokenClient = () => {
        if (!tokens) {
            const { createServiceTokenClient } = require('openvibe-sdk/auth');
            const network = String(config.networkInternalUrl || 'http://127.0.0.1:4000').replace(/\/+$/, '');
            tokens = createServiceTokenClient({ tokenUrl: `${network}/oauth/token`, clientId: env.OV_OAUTH_CLIENT_ID || 'ai', clientSecret: secret, scope: { 'openvibe.bot': 'bot.machine.ai' }, fetch: fetchImpl });
        }
        return tokens;
    };

    async function chat({ machine, subject, model, messages, maxTokens = null, temperature = null, signal = null, timeoutMs = 120000 }) {
        if (!enabled) throw new AiError(503, 'machine.unavailable', 'a person\'s own machine cannot be reached from this service (OV_BOT_INTERNAL_URL)');
        if (!MACHINE_RE.test(String(machine)) || !SUBJECT_RE.test(String(subject))) throw new AiError(422, 'credential.invalid', 'a node credential names a dev_ machine of a usr_ person');
        const value = { model, messages, ...(maxTokens ? { max_tokens: Math.min(32768, Math.max(1, Math.round(maxTokens))) } : {}), ...(temperature != null ? { temperature: Math.min(2, Math.max(0, Number(temperature))) } : {}) };
        const token = await tokenClient().getToken({ audience: 'openvibe.bot' });
        let res;
        try {
            res = await fetchImpl(`${base}/api/v1/machines/${encodeURIComponent(machine)}/commands`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'X-OV-Subject': subject, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ kind: 'ai', value, ms: Math.min(600000, Math.max(5000, timeoutMs)) }),
                signal: signal || AbortSignal.timeout(Math.min(610000, timeoutMs + 10000)),
            });
        } catch (err) {
            throw new AiError(503, 'machine.unreachable', `OpenVibe.Bot did not answer: ${String(err && err.message || err).slice(0, 200)}`);
        }
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            const code = (body && body.code) || 'machine.refused';
            const why = (body && (body.detail || body.reason || body.title)) || `OpenVibe.Bot answered ${res.status}`;
            throw new AiError(res.status === 404 ? 404 : res.status === 403 ? 403 : 502, code, String(why).slice(0, 300));
        }
        if (!body || body.result !== 'ack') throw new AiError(502, 'machine.failed', `the machine did not answer: ${String((body && (body.reason || body.result)) || 'no answer').slice(0, 200)}`);
        const d = body.data || {};
        const u = d.usage || {};
        return { text: String((d.message && d.message.content) || '').trim(), model: d.model || model, usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cached: 0 } };
    }

    return { enabled, chat };
}

module.exports = { createMachineModels };
