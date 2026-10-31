'use strict';
/**
 * The model catalogue keeps itself current (plan L33 P1; the owner, 2026-10-31: "support Anthropic… Gemini… all the
 * DeepSeek, the mainstream ones… and make the whole thing smarter"). A provider's own model list is read with its key
 * and each model is described: what it is (chat, vision, embedding, speech to text, image), how strong (fast, balanced,
 * strong, frontier), whether it sees images, calls tools or thinks first, and its context window and output cap.
 *
 *   describe(id, hints)        → { type, tier, vision, tools, reasoning, contextWindow, maxOutput, note }
 *   listRemote(provider, key)  → [{ id, name, hints }] from the provider's model list:
 *                                 Anthropic GET /v1/models (max_input_tokens, max_tokens, capabilities);
 *                                 OpenAI-compatible GET /models (OpenRouter adds context_length, modalities and
 *                                 supported parameters; Gemini names its models models/…)
 *   sync({ registry, provider, apiKey }) → { added, updated, missing }: new models land switched off (a person turns
 *                                 one on: routing would otherwise change what OpenVibe spends), a known model keeps its
 *                                 status and its prices, and one the provider no longer lists is marked, never deleted.
 *
 * Prices are never read from here: a person types them from the provider's own price page (registry.upsertModel).
 * The families below are what the ids mean; what a provider's list says (Anthropic's capabilities, OpenRouter's
 * modalities and context) wins over them.
 */
const { ProviderError, deadline, describeAbort } = require('./common');

// Each family: the id it matches, then what it is. First match wins, so the narrower come first.
const FAMILIES = [
    [/embed/i, { type: 'embedding', tier: 'fast' }],
    [/whisper|transcri|(^|[-_])stt([-_]|$)/i, { type: 'stt', tier: 'fast' }],
    [/^(gpt-image|dall-e|imagen)|image-(preview|generation)|-image$|flash-image/i, { type: 'image', tier: 'balanced' }],
    [/^veo|^sora|video/i, { type: 'video', tier: 'strong' }],
    [/^claude-(fable|mythos)/i, { tier: 'frontier', vision: true, tools: true, reasoning: true, note: "Anthropic's most capable: the hardest, longest work" }],
    [/^claude-opus/i, { tier: 'frontier', vision: true, tools: true, reasoning: true, note: 'hard changes, design, long agentic work' }],
    [/^claude-sonnet/i, { tier: 'strong', vision: true, tools: true, reasoning: true, note: 'fast and capable: most tasks' }],
    [/^claude-haiku/i, { tier: 'fast', vision: true, tools: true, note: 'the quickest Claude: small jobs and high volume' }],
    [/^claude-/i, { tier: 'balanced', vision: true, tools: true }],
    [/gemini-.*flash-lite/i, { tier: 'fast', vision: true, tools: true, note: 'the cheapest Gemini' }],
    [/gemini-.*flash/i, { tier: 'balanced', vision: true, tools: true, reasoning: true, note: 'quick, long context, sees images' }],
    [/gemini-.*pro/i, { tier: 'strong', vision: true, tools: true, reasoning: true, note: 'long context, sees images, thinks first' }],
    [/^gemma/i, { tier: 'fast' }],
    [/deepseek-reasoner|deepseek-r\d/i, { tier: 'strong', tools: true, reasoning: true, note: 'thinks first: harder problems, very cheap' }],
    [/deepseek/i, { tier: 'balanced', tools: true, note: 'quick and very cheap' }],
    [/^(gpt-[45][.\d]*-?(mini|nano)|o\d-mini)/i, { tier: 'fast', vision: true, tools: true }],
    [/^o\d/i, { tier: 'strong', tools: true, reasoning: true }],
    [/^gpt-5/i, { tier: 'strong', vision: true, tools: true, reasoning: true }],
    [/^gpt-4/i, { tier: 'balanced', vision: true, tools: true }],
    [/^grok-.*mini|grok-.*fast/i, { tier: 'fast', tools: true }],
    [/^grok/i, { tier: 'strong', vision: true, tools: true, reasoning: true }],
    [/magistral|mistral-large|mistral-medium/i, { tier: 'strong', tools: true }],
    [/ministral|mistral-small|mistral-tiny|open-mistral/i, { tier: 'fast', tools: true }],
    [/codestral|devstral/i, { tier: 'balanced', tools: true, note: 'code' }],
    [/reason|thinking/i, { tier: 'strong', tools: true, reasoning: true, note: 'thinks first' }],   // kimi-k2-thinking, …-reasoner
    [/minimax/i, { tier: 'balanced', tools: true }],
    [/llama|qwen|kimi|glm|nemotron|phi-?\d/i, { tier: 'balanced', tools: true }],
];
const TIERS = ['fast', 'balanced', 'strong', 'frontier'];

/** What a model id means, with whatever its provider's list said (hints) taking precedence. */
function describe(id, hints = {}) {
    const bare = String(id || '').replace(/^models\//, '');                         // Gemini names its models models/…
    const leaf = bare.includes('/') ? bare.slice(bare.lastIndexOf('/') + 1) : bare;   // OpenRouter: provider/model
    const fam = (FAMILIES.find(([re]) => re.test(leaf)) || [null, {}])[1];
    const out = {
        type: fam.type || 'chat', tier: fam.tier || 'balanced', vision: !!fam.vision, tools: !!fam.tools, reasoning: !!fam.reasoning,
        contextWindow: null, maxOutput: null, note: fam.note || null,
    };
    if (hints.vision != null) out.vision = !!hints.vision;
    if (hints.tools != null) out.tools = !!hints.tools;
    if (hints.reasoning != null) out.reasoning = !!hints.reasoning;
    if (Number(hints.contextWindow) > 0) out.contextWindow = Math.round(Number(hints.contextWindow));
    if (Number(hints.maxOutput) > 0) out.maxOutput = Math.round(Number(hints.maxOutput));
    return out;
}

async function getJson(url, headers, { timeoutMs = 20000, fetchImpl = globalThis.fetch } = {}) {
    let res;
    try { res = await fetchImpl(url, { headers, signal: deadline(null, timeoutMs) }); } catch (err) {
        throw describeAbort(err, null, timeoutMs) || new ProviderError(`connection failed: ${err.message}`, { code: 'provider.unreachable' });
    }
    const text = await res.text().catch(() => '');
    let j = {};
    try { j = text ? JSON.parse(text) : {}; } catch { j = {}; }
    if (!res.ok) {
        const msg = (j.error && (j.error.message || j.error)) || `HTTP ${res.status}`;
        throw new ProviderError(typeof msg === 'string' ? msg : JSON.stringify(msg), { status: res.status, code: res.status === 401 || res.status === 403 ? 'provider.auth' : 'provider.http' });
    }
    return j;
}

/** A provider's own model list, read with its key → [{ id, name, hints }]. */
async function listRemote(provider, apiKey, { fetchImpl = globalThis.fetch } = {}) {
    const base = String(provider.base_url || '').replace(/\/+$/, '');
    if (!base) throw new ProviderError('the provider has no base URL', { code: 'provider.config' });
    if (provider.kind === 'anthropic') {
        // Anthropic's Models API pages by after_id; its Anthropic-format look-alikes (DeepSeek, MiniMax) have no list.
        if (!/anthropic\.com/i.test(base)) return [];
        const out = [];
        let after = null;
        for (let page = 0; page < 10; page++) {
            const j = await getJson(`${base}/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, { fetchImpl });
            for (const m of j.data || []) {
                const caps = m.capabilities || {};
                const has = (k) => (caps[k] && typeof caps[k] === 'object' ? caps[k].supported !== false : caps[k] == null ? null : !!caps[k]);
                out.push({ id: m.id, name: m.display_name || m.id, hints: { contextWindow: m.max_input_tokens, maxOutput: m.max_tokens, vision: has('image_input') ?? has('vision'), reasoning: has('thinking') ?? has('extended_thinking') } });
            }
            if (!j.has_more || !j.last_id) break;
            after = j.last_id;
        }
        return out;
    }
    const j = await getJson(`${base}/models`, apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, { fetchImpl });
    return (Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : []).map((m) => {
        const id = String(m.id || m.name || '').replace(/^models\//, '');
        const arch = m.architecture || {};
        const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : null;
        return {
            id, name: m.name && m.name !== m.id ? String(m.name).replace(/^models\//, '') : (m.display_name || id),
            hints: {
                contextWindow: m.context_length || m.context_window || m.inputTokenLimit || (m.top_provider && m.top_provider.context_length),
                maxOutput: m.outputTokenLimit || (m.top_provider && m.top_provider.max_completion_tokens),
                vision: Array.isArray(arch.input_modalities) ? arch.input_modalities.includes('image') : null,
                tools: params ? params.includes('tools') : null,
                reasoning: params ? params.includes('reasoning') || params.includes('include_reasoning') : null,
            },
        };
    }).filter((m) => m.id);
}

const MODEL_TYPES = ['chat', 'vision', 'embedding', 'stt', 'image'];

/** Read the provider's list and bring its models into the catalogue. */
async function sync({ registry, provider, apiKey, fetchImpl = globalThis.fetch, actor = 'system', now = () => Date.now() }) {
    const remote = await listRemote(provider, apiKey, { fetchImpl });
    const known = new Map((await registry.listModels({ provider: provider.key })).map((m) => [m.model_key, m]));
    const seen = new Set();
    const result = { added: [], updated: [], missing: [], skipped: [] };
    const at = new Date(now()).toISOString();
    for (const m of remote) {
        const d = describe(m.id, m.hints);
        if (!MODEL_TYPES.includes(d.type)) { result.skipped.push(m.id); continue; }   // video: not a model type here yet
        seen.add(m.id);
        const prev = known.get(m.id);
        const metadata = { ...((prev && prev.metadata) || {}), tier: d.tier, reasoning: d.reasoning, note: d.note, synced_at: at, listed: true };
        delete metadata.missing_since;
        await registry.upsertModel({
            provider_key: provider.key, model_key: m.id, display_name: m.name || m.id, type: d.type,
            // A new model is switched off until a person turns it on; a known one keeps its status (and its prices).
            status: prev ? prev.status : 'disabled',
            context_window: d.contextWindow ?? (prev && prev.context_window) ?? null, max_output: d.maxOutput ?? (prev && prev.max_output) ?? null,
            supports: { json: true, tools: d.tools, streaming: true, vision: d.vision }, metadata,
        }, { actor });
        (prev ? result.updated : result.added).push(m.id);
    }
    for (const [id, prev] of known) {
        if (seen.has(id) || (prev.metadata && prev.metadata.missing_since)) continue;
        if (!(prev.metadata && prev.metadata.listed)) continue;   // typed in by a person, never listed: leave it be
        await registry.upsertModel({ provider_key: provider.key, model_key: id, metadata: { ...prev.metadata, listed: false, missing_since: at } }, { actor });
        result.missing.push(id);
    }
    return result;
}

module.exports = { describe, listRemote, sync, FAMILIES, TIERS };
