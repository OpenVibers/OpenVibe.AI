'use strict';
/**
 * Providers an owner can add from the console in a few clicks (server/console/index.js, /console/providers/new). Each
 * is an OpenAI-compatible endpoint unless it says otherwise; prices are not here (rate cards are typed in by a person
 * from the provider's own price page, with the page and the day, on the model form).
 */
const { PROVIDERS } = require('../providers/pool-providers');
const PRESETS = [
    ...PROVIDERS.filter(p => p.capabilities.includes('chat')).map(p => ({
        id: p.key, name: p.display_name, kind: p.kind, base_url: p.base_url,
        model: p.default_model || '', keys: p.docs_url,
    })),
    // Compatibility names for already stored personal credentials; not separate provider rows.
    { id: 'deepseek-anthropic', name: 'DeepSeek (Anthropic format)', kind: 'anthropic', base_url: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat', keys: 'https://platform.deepseek.com/api_keys' },
    { id: 'minimax-anthropic', name: 'MiniMax (Anthropic format)', kind: 'anthropic', base_url: 'https://api.minimax.io/anthropic', model: 'MiniMax-M2', keys: 'https://platform.minimax.io/user-center/basic-information/interface-key' },
    { id: 'custom', name: 'Another OpenAI-compatible API', kind: 'openai', base_url: '', model: '', keys: null },
];

// What a text provider added here can do (the router only offers it the operations it lists).
const TEXT_CAPS = ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json'];

const byId = (id) => PRESETS.find((p) => p.id === id) || null;

/**
 * The providers a person may store their own key for (L36 Y1). One table: each credential provider is a preset
 * above, so its base URL and wire format (OpenAI-compatible or Anthropic Messages) are the console's, never a
 * second list. DeepSeek and MiniMax keep their Anthropic-format endpoints (their keys speak Messages there, which is
 * what a person's stored model expects); `custom` is the preset with an empty base URL, and a person names it.
 * `node` is not here: it is the person's own machine, not a key (server/credentials.js keeps its old route).
 */
const CREDENTIAL_PRESET = {
    anthropic: 'anthropic', openai: 'openai', gemini: 'gemini', deepseek: 'deepseek-anthropic',
    mistral: 'mistral', xai: 'xai', groq: 'groq', cerebras: 'cerebras', together: 'together',
    fireworks: 'fireworks', openrouter: 'openrouter', minimax: 'minimax-anthropic', custom: 'custom',
};
const CREDENTIAL_PROVIDERS = Object.keys(CREDENTIAL_PRESET);

/** The console preset behind a credential provider: { id, kind, base_url, model, keys } or null. */
function credentialProvider(id) {
    const preset = byId(CREDENTIAL_PRESET[id]);
    return preset ? { id, kind: preset.kind, base_url: preset.base_url, model: preset.model, keys: preset.keys } : null;
}

module.exports = { PRESETS, TEXT_CAPS, byId, CREDENTIAL_PROVIDERS, CREDENTIAL_PRESET, credentialProvider };

