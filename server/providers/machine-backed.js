'use strict';
/**
 * The host's own local models, answered by a Link machine (plan §AD.23 step 2; the owner, 2026-11-17: "all that should
 * be able to be processed via link on the shared node"). Production ran two llama.cpp chat servers next to every site
 * on a four-core host with its swap full; the shared node (ov-node-01, eight cores) runs the same models in its own
 * model server and opens no port. With AI_LOCAL_LLM_MACHINE (and AI_LOCAL_LLM2_MACHINE) naming a Bot machine, the `local`
 * (and `local2`) provider's chat goes there through OpenVibe.Bot as the machine's owner (server/machines.js: Bot checks
 * the machine is theirs and that "Let my AI use this computer's models" is on). The host's own server answers when the
 * machine cannot, until it is turned off. Receipts, the local gate and the logs are the provider's, as before.
 *
 *   machineBacked(adapter, { machines, machine, subject, model, log }) → the adapter, with chat through the machine
 */
const MACHINE_RE = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

const textOf = (content) => (Array.isArray(content) ? content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n') : String(content == null ? '' : content));

function machineBacked(adapter, { machines, machine, subject, model, log = console } = {}) {
    if (!adapter || !machines || !MACHINE_RE.test(String(machine || '')) || !SUBJECT_RE.test(String(subject || '')) || !model) return adapter;
    let lastWarn = 0;
    async function chat(req = {}) {
        // A picture, a tool call or JSON goes to the host's own server as before: the machine answers plain text.
        if (req.image || req.json || (req.openai && req.openai.tools)) return adapter.chat(req);
        const sys = (req.system || []).map((x) => x && x.text).filter(Boolean).join('\n\n');
        const messages = [
            ...(sys ? [{ role: 'system', content: sys }] : []),
            ...(req.messages || []).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user', content: textOf(m.content) })),
        ];
        try {
            const r = await machines.chat({ machine, subject, model, messages, maxTokens: req.maxTokens, temperature: req.temperature, signal: req.signal, timeoutMs: req.timeoutMs });
            return { text: r.text || '', json: null, model: r.model || model, usage: r.usage || { input: 0, output: 0, cached: 0 }, machine: r.machine || machine };
        } catch (err) {
            if (req.signal && req.signal.aborted) throw err;
            const now = Date.now();
            if (now - lastWarn > 60000) { lastWarn = now; if (log && log.warn) log.warn(`[ai] ${adapter.key} on ${machine}: ${String((err && (err.detail || err.message)) || err).slice(0, 200)}; the host's own server answers`); }
            return adapter.chat(req);
        }
    }
    return { ...adapter, chat, machine };
}

module.exports = { machineBacked };
