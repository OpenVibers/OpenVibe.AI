'use strict';
/**
 * A person's own machine as their model (AI on your own machines: contracts 0.219.0 bot.command@1 kind ai and the
 * capability bot.machine.ai; 0.220.0 the credential provider node). One chat completion goes through OpenVibe.Bot,
 * POST /api/v1/machines/:id/commands with kind ai, as OpenVibe.AI acting for the person (X-OV-Subject), to the machine's
 * own model server (OpenVibe Node's ai plugin: Ollama, LM Studio, llama.cpp). Bot checks that the machine is theirs and
 * that they turned on "Let my AI use this computer's models"; the prompt never reaches anyone else's machine.
 *
 * Machine `any` (contracts 0.221.0): whichever of the person's own machines is on, lets their AI use its models and
 * offers the model, from Bot's list for OpenVibe.AI (GET /api/v1/machines, only those with the switch on). The fastest
 * at that model goes first (computer.ai_speed, OpenVibe.Node v0.29.0), then the others; one that is busy, away or fails
 * hands over to the next. Never anyone else's machine, never another provider.
 *
 * Off without OV_BOT_INTERNAL_URL or a client secret: a credential with provider node is then refused, never sent
 * elsewhere. → chat({ machine, subject, model, messages, maxTokens, temperature, signal, timeoutMs })
 *   -> { text, model, usage: { input, output, cached }, machine, tried: [{ machine, error }] }
 */
const { AiError } = require('./util');

const MACHINE_RE = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const ANY = 'any';
const MAX_TRIED = 5;   // machines tried for one answer with machine any
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

    const headersFor = (token, subject) => ({ Authorization: `Bearer ${token}`, 'X-OV-Subject': subject, Accept: 'application/json' });

    /** The person's machines that may answer with `model`, the fastest at it first (Bot lists only those switched on). */
    async function candidates(subject, model, signal) {
        const token = await tokenClient().getToken({ audience: 'openvibe.bot' });
        let res;
        try {
            res = await fetchImpl(`${base}/api/v1/machines`, { headers: headersFor(token, subject), signal: signal || AbortSignal.timeout(10000) });
        } catch (err) {
            throw new AiError(503, 'machine.unreachable', `OpenVibe.Bot did not answer: ${String(err && err.message || err).slice(0, 200)}`);
        }
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new AiError(res.status === 403 ? 403 : 502, (body && body.code) || 'machine.refused', String((body && (body.detail || body.title)) || `OpenVibe.Bot answered ${res.status}`).slice(0, 300));
        const speedAt = (m) => {
            const s = m.computer && m.computer.ai_speed;
            return s && s.model === model && Number(s.tokens_per_s) > 0 ? Number(s.tokens_per_s) : 0;
        };
        return ((body && body.machines) || [])
            .filter((m) => m && MACHINE_RE.test(String(m.id)) && m.online && m.ai_models !== false && m.computer && m.computer.ai
                && m.computer.ai.ready !== false && Array.isArray(m.computer.ai.models) && m.computer.ai.models.includes(model))
            .sort((a, b) => speedAt(b) - speedAt(a))
            .map((m) => m.id);
    }

    async function chat(args) {
        if (!enabled) throw new AiError(503, 'machine.unavailable', 'a person\'s own machine cannot be reached from this service (OV_BOT_INTERNAL_URL)');
        const { machine, subject, model, signal = null } = args;
        if (!(MACHINE_RE.test(String(machine)) || machine === ANY) || !SUBJECT_RE.test(String(subject))) throw new AiError(422, 'credential.invalid', 'a node credential names a dev_ machine of a usr_ person, or any of theirs');
        if (machine !== ANY) return { ...(await once(machine, args)), machine, tried: [] };
        const ids = (await candidates(subject, model, signal)).slice(0, MAX_TRIED);
        if (!ids.length) throw new AiError(503, 'machine.none', `none of the person's own machines is on with ${String(model).slice(0, 120)} and lets their AI use it`);
        const tried = [];
        for (const id of ids) {
            try {
                return { ...(await once(id, args)), machine: id, tried };
            } catch (err) {
                if (signal && signal.aborted) throw err;
                if (err && err.status === 422) throw err;
                tried.push({ machine: id, error: String((err && (err.code || err.message)) || err).slice(0, 120) });
            }
        }
        throw new AiError(503, 'machine.none', `none of the person's own machines answered (${tried.map((x) => `${x.machine}: ${x.error}`).join('; ').slice(0, 400)})`);
    }

    async function once(machine, { subject, model, messages, maxTokens = null, temperature = null, signal = null, timeoutMs = 120000 }) {
        const value = { model, messages, ...(maxTokens ? { max_tokens: Math.min(32768, Math.max(1, Math.round(maxTokens))) } : {}), ...(temperature != null ? { temperature: Math.min(2, Math.max(0, Number(temperature))) } : {}) };
        const token = await tokenClient().getToken({ audience: 'openvibe.bot' });
        let res;
        try {
            res = await fetchImpl(`${base}/api/v1/machines/${encodeURIComponent(machine)}/commands`, {
                method: 'POST',
                headers: { ...headersFor(token, subject), 'Content-Type': 'application/json' },
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
