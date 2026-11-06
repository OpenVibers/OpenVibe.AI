'use strict';
/**
 * The real upstream behind a provider record (`server/providers/upstream.js`).
 *
 * A provider record has an internal key the router uses ("shared" is Live's pooled OpenVibe key), and a
 * display name the owner typed. Neither says who actually serves the model. The Exchange catalog must show
 * the real upstream, and may list a model only when that upstream's configured key can serve it: an OpenAI
 * key cannot serve claude-*, a DeepSeek key cannot serve gpt-*, and a custom proxy whose upstream nobody
 * recorded can serve nothing the catalogue can promise.
 *
 *   upstreamOf(provider)              → { key, name, families } for a record with a known real upstream,
 *                                       null when `shared` names no upstream and its base URL is not one
 *   serves(upstream, provider, row)   → could this upstream serve the registered model row?
 *   configured(provider, env)         → is the key this record needs present right now?
 *
 * For a provider an admin named directly (deepseek, local, …) the real upstream is the record itself; only
 * the seeded `shared` record hides its upstream, and only it is interpreted here. Nothing is invented: an
 * unknown host or provider_name yields null, and the caller leaves those offers out.
 */
const { resolveSecret } = require('../util');

const NAMES = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    deepseek: 'DeepSeek',
    openrouter: 'OpenRouter',
    groq: 'Groq',
    google: 'Google Gemini',
    gemini: 'Google Gemini',
    mistral: 'Mistral AI',
    xai: 'xAI',
    together: 'Together AI',
    fireworks: 'Fireworks AI',
    cerebras: 'Cerebras',
    minimax: 'MiniMax',
    ollama: 'Ollama',
};

// Hosts that identify the upstream when AI_PROVIDER is blank or says "openai-compatible".
const HOSTS = [
    [/(^|\.)openai\.com$/i, 'openai'],
    [/(^|\.)anthropic\.com$/i, 'anthropic'],
    [/(^|\.)deepseek\.com$/i, 'deepseek'],
    [/(^|\.)openrouter\.ai$/i, 'openrouter'],
    [/(^|\.)groq\.com$/i, 'groq'],
    [/(^|\.)googleapis\.com$/i, 'google'],
    [/(^|\.)mistral\.ai$/i, 'mistral'],
    [/(^|\.)x\.ai$/i, 'xai'],
    [/(^|\.)together\.xyz$/i, 'together'],
    [/(^|\.)fireworks\.ai$/i, 'fireworks'],
    [/(^|\.)cerebras\.ai$/i, 'cerebras'],
    [/(^|\.)minimax\.(ai|io)$/i, 'minimax'],
];

// Upstreams that route many families: every model row may be theirs. A direct provider (not `shared`) is
// likewise trusted for its own rows: its key is the reason the row exists.
const ROUTES_ALL = new Set(['openrouter', 'ollama', 'together', 'fireworks', 'cerebras']);
// A first-party upstream serves only its own family.
const FAMILIES = {
    openai: ['openai'],
    anthropic: ['anthropic'],
    deepseek: ['deepseek'],
    google: ['google'],
    mistral: ['mistral'],
    xai: ['xai'],
    groq: ['open', 'gpt-oss'],
    minimax: ['minimax'],
};

const hostOf = (url) => {
    try { return new URL(String(url || '')).hostname.toLowerCase(); } catch (e) { return ''; }
};

/** The family an id names: what the upstream's key is allowed to serve. */
function familyOfModel(modelKey) {
    const s = String(modelKey || '').toLowerCase().replace(/^models\//, '');
    const leaf = s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
    if (/^gpt-oss/.test(leaf)) return 'gpt-oss';
    if (/^(gpt-|chatgpt|o[1-9](?:-|$)|text-embedding|whisper|tts-|dall-e|gpt-image|codex|computer-use|omni)/.test(leaf)) return 'openai';
    if (/^claude/.test(leaf)) return 'anthropic';
    if (/^deepseek/.test(leaf)) return 'deepseek';
    if (/^(gemini|gemma|learnlm|imagen|veo)/.test(leaf)) return 'google';
    if (/^(mistral|magistral|codestral|devstral|ministral|pixtral|open-mistral)/.test(leaf)) return 'mistral';
    if (/^grok/.test(leaf)) return 'xai';
    if (/^minimax/.test(leaf)) return 'minimax';
    if (/^(llama|qwen|qwq|kimi|moonshot|glm|zhipu|phi|yi|ernie|hunyuan|nemotron|command|cohere|dbrx|falcon|starcoder|mixtral)/.test(leaf)) return 'open';
    return 'unknown';
}

/**
 * The real upstream of a provider record. A direct provider is its own upstream; `shared` is resolved from
 * its configured upstream name (AI_PROVIDER in metadata.provider_name) or its base URL host. Unknown → null.
 */
function upstreamOf(provider) {
    if (!provider) return null;
    if (provider.key !== 'shared') {
        return { key: provider.key, name: provider.display_name || provider.key, families: null };
    }
    const meta = provider.metadata || {};
    const declared = String(meta.provider_name || '').trim().toLowerCase();
    let key = NAMES[declared] ? declared : null;
    if (!key) {
        const host = hostOf(provider.base_url);
        for (const [re, name] of HOSTS) if (re.test(host)) { key = name; break; }
    }
    if (!key) return null;
    return { key, name: NAMES[key], families: ROUTES_ALL.has(key) ? null : (FAMILIES[key] || []) };
}

/** Could this upstream serve this model row? A direct provider's own rows are trusted. */
function serves(upstream, provider, row) {
    if (!upstream || !provider || !row) return false;
    if (provider.key !== 'shared') return true;
    if (!upstream.families) return true;
    return upstream.families.includes(familyOfModel(row.model_key));
}

/**
 * Is the credential this provider needs present right now? No credential for a keyless record (local,
 * whisper), and none needed for a free or pooled-subscription provider. A missing env/vault reference is
 * not configured: its models must not appear as offers.
 */
function configured(provider, env = process.env) {
    if (!provider || provider.status !== 'active') return false;
    if (provider.auth_mode === 'none') return true;
    if (provider.billing_profile === 'free') return true;
    if (provider.billing_profile === 'subscription' && !provider.secret_ref) return true;
    try { return Boolean(resolveSecret(provider.secret_ref, env)); } catch (e) { return false; }
}

module.exports = { upstreamOf, serves, configured, familyOfModel, NAMES };
