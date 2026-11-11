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
 * Listed prices and optional public metadata fill previously unknown prices; owner and price-book values win.
 * The families below are what the ids mean; what a provider's list says (Anthropic's capabilities, OpenRouter's
 * modalities and context) wins over them.
 */
const { ProviderError, deadline, describeAbort } = require('./common');

// Each family: the id it matches, then what it is. First match wins, so the narrower come first.
const FAMILIES = [
    [/^muse-ember/i, { tier: 'fast', vision: true, tools: true, reasoning: true, note: 'high-volume repeated work and agent sub-steps' }],
    [/^muse-spark/i, { tier: 'strong', vision: true, tools: true, reasoning: true, note: 'general and agentic work' }],
    [/rerank/i, { type: 'rerank', tier: 'fast' }],
    [/tts|text-to-speech|speech-/i, { type: 'speech', tier: 'fast' }],
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
    if (MODEL_TYPES.includes(hints.type)) out.type = hints.type;
    if (Number(hints.contextWindow) > 0) out.contextWindow = Math.round(Number(hints.contextWindow));
    if (Number(hints.maxOutput) > 0) out.maxOutput = Math.round(Number(hints.maxOutput));
    return out;
}

async function getJson(url, headers, { timeoutMs = 20000, fetchImpl = globalThis.fetch } = {}) {
    let res;
    try { res = await fetchImpl(url, { headers, redirect: 'error', signal: deadline(null, timeoutMs) }); } catch (err) {
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
    const endpoint = provider.metadata?.models_endpoint || `${base}/models`;
    if (new URL(endpoint).origin !== new URL(base).origin) throw new ProviderError('model list must use the provider origin', { code: 'provider.config' });
    if (provider.key === 'gemini' || provider.metadata?.api_family === 'google') {
        const out = [];
        const tokens = new Set();
        const url = new URL(endpoint);
        for (let page = 0; page < 100; page++) {
            const j = await getJson(url.href, { 'x-goog-api-key': apiKey }, { fetchImpl });
            if (!Array.isArray(j.models) || j.models.some(m => !m || typeof m.name !== 'string' || !m.name.startsWith('models/')))
                throw new ProviderError('invalid model list', { code: 'provider.catalog_invalid' });
            out.push(...j.models.map(remoteModel));
            if (!j.nextPageToken) return out;
            if (typeof j.nextPageToken !== 'string' || tokens.has(j.nextPageToken) || page === 99)
                throw new ProviderError('incomplete model list', { code: 'provider.catalog_invalid' });
            tokens.add(j.nextPageToken);
            url.searchParams.set('pageToken', j.nextPageToken);
        }
    }
    if (provider.kind === 'anthropic') {
        // Anthropic's Models API pages by after_id; its Anthropic-format look-alikes (DeepSeek, MiniMax) have no list.
        if (!/anthropic\.com/i.test(base) && !provider.metadata?.models_endpoint) return [];
        const out = [];
        let after = null;
        for (let page = 0; page < 10; page++) {
            const url = new URL(endpoint);
            url.searchParams.set('limit', '100');
            if (after) url.searchParams.set('after_id', after);
            const auth = provider.auth_mode === 'none' ? {} : provider.auth_mode === 'bearer' ? { Authorization: `Bearer ${apiKey}` } : { 'x-api-key': apiKey };
            const j = await getJson(url.href, { ...auth, 'anthropic-version': '2023-06-01' }, { fetchImpl });
            if (!Array.isArray(j.data)) throw new ProviderError('invalid model list', { code: 'provider.catalog_invalid' });
            for (const m of j.data || []) {
                const caps = m.capabilities || {};
                const has = (k) => (caps[k] && typeof caps[k] === 'object' ? caps[k].supported !== false : caps[k] == null ? null : !!caps[k]);
                out.push({ id: m.id, name: m.display_name || m.id, hints: { contextWindow: m.max_input_tokens, maxOutput: m.max_tokens, vision: has('image_input') ?? has('vision'), reasoning: has('thinking') ?? has('extended_thinking') } });
            }
            if (!j.has_more) break;
            if (!j.last_id || page === 9) throw new ProviderError('incomplete model list', { code: 'provider.catalog_invalid' });
            after = j.last_id;
        }
        return out;
    }
    const headers = provider.auth_mode === 'none' || !apiKey ? {} : provider.auth_mode === 'x-api-key' ? { [provider.metadata?.auth_header || 'x-api-key']: apiKey } : { Authorization: `Bearer ${apiKey}` };
    const out = [];
    const tokens = new Set();
    const url = new URL(endpoint);
    for (let page = 0; page < 10; page++) {
        const j = await getJson(url.href, headers, { fetchImpl });
        const rows = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : j?.models;
        if (!Array.isArray(rows) || rows.some(m => !m || typeof (m.id || m.name) !== 'string' || !(m.id || m.name).trim())) {
            throw new ProviderError('invalid model list', { code: 'provider.catalog_invalid' });
        }
        out.push(...rows.map(remoteModel));
        const token = j.next_page_token || j.nextPageToken;
        if (!token && !j.has_more) return out;
        if (typeof token !== 'string' || tokens.has(token) || page === 9) throw new ProviderError('incomplete model list', { code: 'provider.catalog_invalid' });
        tokens.add(token);
        url.searchParams.set(j.next_page_token ? 'page_token' : 'pageToken', token);
    }
}

function remoteModel(m) {
    const id = String(m.id || m.name || '').replace(/^models\//, '');
    const arch = m.architecture || {};
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : null;
    const type = m.type === 'language' ? 'chat' : m.type;
    return {
        id, name: m.displayName || m.display_name || (m.name && m.name !== m.id ? String(m.name).replace(/^models\//, '') : id),
        ...(typeof m.version === 'string' ? { version: m.version } : {}),
        ...(Array.isArray(m.supportedGenerationMethods) ? { generationMethods: m.supportedGenerationMethods.filter(x => typeof x === 'string') } : {}),
        hints: {
            contextWindow: m.context_length || m.context_window || m.inputTokenLimit || (m.top_provider && m.top_provider.context_length),
            maxOutput: m.outputTokenLimit || (m.top_provider && m.top_provider.max_completion_tokens),
            ...(Array.isArray(m.supportedGenerationMethods) ? { type: m.supportedGenerationMethods.includes('embedContent') && !m.supportedGenerationMethods.includes('generateContent') ? 'embedding' : 'chat' } : {}),
            ...(m.thinking != null ? { reasoning: Boolean(m.thinking) } : {}),
            vision: Array.isArray(arch.input_modalities) ? arch.input_modalities.includes('image') : null,
            tools: params ? params.includes('tools') : null,
            reasoning: params ? params.includes('reasoning') || params.includes('include_reasoning') : null,
            ...(MODEL_TYPES.includes(type) ? { type } : {}),
        },
        ...(m.pricing ? { cost: listedCost(m.pricing) } : {}),
    };
}

const price = (value, scale = 1) => value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) * scale : null;
function listedCost(pricing) {
    return { in_per_mtok: price(pricing.prompt, 1e6), out_per_mtok: price(pricing.completion, 1e6), cached_per_mtok: price(pricing.input_cache_read, 1e6) };
}
const MODEL_TYPES = ['chat', 'vision', 'embedding', 'stt', 'image', 'video', 'speech', 'rerank'];

/** Read the provider's list and bring its models into the catalogue. */
async function sync({ registry, provider, apiKey, fetchImpl = globalThis.fetch, actor = 'system', now = () => Date.now(), enrich = null }) {
    const remote = await listRemote(provider, apiKey, { fetchImpl });
    const known = new Map((await registry.listModels({ provider: provider.key })).map((m) => [m.model_key, m]));
    const seen = new Set();
    const result = { added: [], updated: [], missing: [], skipped: [] };
    const at = new Date(now()).toISOString();
    for (const m of remote) {
        const extra = enrich ? enrich(m.id) : {};
        const d = describe(m.id, { ...extra.hints, ...Object.fromEntries(Object.entries(m.hints || {}).filter(([, v]) => v != null)) });
        if (!MODEL_TYPES.includes(d.type)) { result.skipped.push(m.id); continue; }
        seen.add(m.id);
        const prev = known.get(m.id);
        const uncensored = require('./pool-providers').isUncensored(provider, { model_key: m.id, metadata: prev?.metadata || {} });
        const contributor = provider.key === 'meta' && /-contributor$/i.test(m.id);
        const metadata = { tier: d.tier, reasoning: d.reasoning, note: d.note, ...prev?.metadata, synced_at: at, listed: true,
            ...(m.version ? { version: m.version } : {}),
            ...(m.generationMethods ? { generation_methods: m.generationMethods } : {}),
            ...(contributor ? { routing_excluded: true, routing_excluded_reason: 'Meta Contributor mode permits training on prompts and is not allowed in OpenVibe routing.' } : {}),
            ...(uncensored ? { uncensored: true, min_age: 18 } : {}),
            ...(extra.source ? { catalogue_enrichment: { source: extra.source, checked_at: extra.checked_at } } : {}) };
        delete metadata.missing_since;
        const ownCost = m.cost && Object.values(m.cost).some(v => v != null) ? { ...m.cost, source: provider.metadata?.models_endpoint || `${provider.base_url.replace(/\/+$/, '')}/models`, verified_at: at.slice(0, 10) } : null;
        const hasPrice = prev?.metadata?.price_book || ['in_per_mtok', 'out_per_mtok', 'cached_per_mtok'].some(f => prev?.cost?.[f] != null);
        const cost = hasPrice ? prev.cost : ownCost || extra.cost || prev?.cost;
        await registry.upsertModel({
            provider_key: provider.key, model_key: m.id, display_name: prev?.display_name || m.name || m.id, type: d.type,
            // A new model is switched off until a person turns it on; a known one keeps its status (and its prices).
            status: contributor ? 'disabled' : prev ? prev.status : provider.metadata?.auto_list_new_models === true && !uncensored ? 'active' : 'disabled',
            context_window: d.contextWindow ?? (prev && prev.context_window) ?? null, max_output: d.maxOutput ?? (prev && prev.max_output) ?? null,
            supports: { json: true, tools: d.tools, streaming: true, vision: d.vision }, metadata, ...(cost ? { cost } : {}),
        }, { actor });
        (prev ? result.updated : result.added).push(m.id);
    }
    for (const [id, prev] of known) {
        if (seen.has(id) || (prev.metadata && prev.metadata.missing_since)) continue;
        if (!(prev.metadata && prev.metadata.listed)) continue;   // typed in by a person, never listed: leave it be
        await registry.upsertModel({ provider_key: provider.key, model_key: id, status: 'disabled', metadata: { ...prev.metadata, listed: false, missing_since: at } }, { actor });
        result.missing.push(id);
    }
    return result;
}

module.exports = { describe, listRemote, remoteModel, sync, FAMILIES, TIERS };
