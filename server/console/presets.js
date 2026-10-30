'use strict';
/**
 * Providers an owner can add from the console in a few clicks (server/console/index.js, /console/providers/new). Each
 * is an OpenAI-compatible endpoint unless it says otherwise; prices are not here (rate cards are typed in by a person
 * from the provider's own price page, with the page and the day, on the model form).
 */
const PRESETS = [
    { id: 'deepseek', name: 'DeepSeek', kind: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-flash', keys: 'https://platform.deepseek.com/api_keys' },
    { id: 'openrouter', name: 'OpenRouter', kind: 'openai', base_url: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', keys: 'https://openrouter.ai/settings/keys' },
    { id: 'groq', name: 'Groq', kind: 'openai', base_url: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-20b', keys: 'https://console.groq.com/keys' },
    { id: 'gemini', name: 'Google Gemini', kind: 'openai', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', keys: 'https://aistudio.google.com/apikey' },
    { id: 'mistral', name: 'Mistral', kind: 'openai', base_url: 'https://api.mistral.ai/v1', model: '', keys: 'https://console.mistral.ai/api-keys' },
    { id: 'together', name: 'Together AI', kind: 'openai', base_url: 'https://api.together.xyz/v1', model: '', keys: 'https://api.together.ai/settings/api-keys' },
    { id: 'fireworks', name: 'Fireworks', kind: 'openai', base_url: 'https://api.fireworks.ai/inference/v1', model: '', keys: 'https://fireworks.ai/account/api-keys' },
    { id: 'cerebras', name: 'Cerebras', kind: 'openai', base_url: 'https://api.cerebras.ai/v1', model: '', keys: 'https://cloud.cerebras.ai/' },
    { id: 'xai', name: 'xAI', kind: 'openai', base_url: 'https://api.x.ai/v1', model: '', keys: 'https://console.x.ai/' },
    { id: 'openai', name: 'OpenAI', kind: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-5-mini', keys: 'https://platform.openai.com/api-keys' },
    { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', base_url: 'https://api.anthropic.com/v1', model: '', keys: 'https://console.anthropic.com/settings/keys' },
    // Anthropic-format endpoints of providers that also speak the OpenAI format (Codes C3): POST /v1/messages reaches
    // these as they are, an OpenAI-shaped record never is converted.
    { id: 'deepseek-anthropic', name: 'DeepSeek (Anthropic format)', kind: 'anthropic', base_url: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat', keys: 'https://platform.deepseek.com/api_keys' },
    { id: 'minimax-anthropic', name: 'MiniMax (Anthropic format)', kind: 'anthropic', base_url: 'https://api.minimax.io/anthropic', model: 'MiniMax-M2', keys: 'https://platform.minimax.io/user-center/basic-information/interface-key' },
    { id: 'custom', name: 'Another OpenAI-compatible API', kind: 'openai', base_url: '', model: '', keys: null },
];

// What a text provider added here can do (the router only offers it the operations it lists).
const TEXT_CAPS = ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json'];

const byId = (id) => PRESETS.find((p) => p.id === id) || null;

module.exports = { PRESETS, TEXT_CAPS, byId };
