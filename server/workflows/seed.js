'use strict';
/**
 * Boot-time seeding from configuration and code. Idempotent: every boot re-applies it.
 *
 *   providers  stub (always), shared (Live's shared key: AI_PROVIDER / AI_BASE_URL / AI_API_KEY /
 *              AI_MODEL), http-seam (AI_HTTP_SEAM_URL), whisper (WHISPER_*), local (AI_LOCAL_LLM_URL)
 *              — records whose origin is 'seed' follow the environment; admin-edited ones are left alone
 *   models     the configured default model
 *   routes     live.<role> for Live's roles, live.stt, live.creative (AI_CREATIVE_MODEL), default.chat|json|messages|embedding and media.local|paid
 *              as capability pools ordered by openvibe-sdk/placement; and the historical
 *              product route keys as explicit aliases of default.json
 *   templates, workflows   from server/workflows/{live,core,products,media,chat}.js — a code change becomes a
 *              new version unless an admin has versioned that key since (admin edits win)
 *   quotas     AI_MAX_COST_USD_PER_DAY (global/day, Live's ai_max_cost_usd_per_day) and a per-service
 *              request rate for every service
 */
const live = require('./live');
const space = require('./space');
const media = require('./media');
const core = require('./core');
const products = require('./products');
const devblog = require('./devblog');
const chat = require('./chat');
const research = require('./research');
const deepDive = require('./deep-dive');
const video = require('./video');
const meme = require('./meme');
const changelog = require('./changelog');
const pictures = require('./pictures');
const uiLayout = require('./ui-layout');
const decide = require('./decide');
const poolSeed = require('../providers/pool-seed');
const { resolveSecret } = require('../util');

const ROLE_TIMEOUT = { chat: 20000, vision: 30000, director: 25000, summary: 30000, legacy: 30000 };
const HISTORICAL_ROUTES = ['wiki.generate', 'blog.draft', 'news.summarize', 'reviews.summarize', 'deals.enrich', 'coupons.extract', 'trade.summarize', 'codes.generate_docs', 'games.generate_lore', 'moderation.classify', 'tools.describe', 'food.suggest', 'rent.screen'];
// DeepSeek's own list (GET https://api.deepseek.com/models, checked 2026-11-06) and its own price page
// (https://api-docs.deepseek.com/quick_start/pricing, checked 2026-11-06). The card carries the peak rate;
// the page halves it off-peak (all hours outside 01:00-04:00 and 06:00-10:00 UTC Mon-Fri). Never rounded.
const DEEPSEEK_MODELS = [
    {
        model_key: 'deepseek-flash', display_name: 'DeepSeek V4.1 Flash', type: 'chat',
        context_window: 1048576, max_output: 393216,
        supports: { json: true, tools: true, streaming: true, vision: true },
        cost: { in_per_mtok: 0.30, out_per_mtok: 1.20, cached_per_mtok: 0.006, source: 'https://api-docs.deepseek.com/quick_start/pricing', verified_at: '2026-11-06' },
        metadata: { org: 'deepseek', model: 'deepseek-flash', family: 'DeepSeek', tier: 'fast', reasoning: true, reasoning_reserve_tokens: 1536, configured_by: 'DEEPSEEK_API_KEY', pricing_note: 'Peak rates (01:00-04:00 and 06:00-10:00 UTC, Mon-Fri); off-peak is half: $0.15 in, $0.003 cached, $0.60 out per 1M.' },
    },
    {
        model_key: 'deepseek-v4-pro', display_name: 'DeepSeek V4 Pro', type: 'chat',
        context_window: 1048576, max_output: 393216,
        supports: { json: true, tools: true, streaming: true, vision: false },
        cost: { in_per_mtok: 1.32, out_per_mtok: 3.96, cached_per_mtok: 0.044, source: 'https://api-docs.deepseek.com/quick_start/pricing', verified_at: '2026-11-06' },
        metadata: { org: 'deepseek', model: 'deepseek-v4-pro', family: 'DeepSeek', tier: 'strong', reasoning: true, reasoning_reserve_tokens: 1536, configured_by: 'DEEPSEEK_API_KEY', pricing_note: 'Peak rates (01:00-04:00 and 06:00-10:00 UTC, Mon-Fri); off-peak is half: $0.66 in, $0.022 cached, $1.98 out per 1M.' },
    },
];

function deepseekProviderRecord(config, env) {
    const key = resolveSecret(config.deepseek.apiKeyRef, env);
    return {
        key: 'deepseek', display_name: 'DeepSeek', kind: 'openai',
        status: config.deepseek.enabled && key ? 'active' : 'disabled',
        base_url: config.deepseek.baseUrl, auth_mode: 'bearer', secret_ref: config.deepseek.apiKeyRef,
        default_model: DEEPSEEK_MODELS[0].model_key,
        capabilities: ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json', 'vision'],
        timeout_ms: config.deepseek.timeoutMs, priority: 20, provider_access: 'OWN_DEPLOYMENT',
        metadata: { configured_by: 'DEEPSEEK_API_KEY', provider_name: 'deepseek', billing_profile: 'metered' },
    };
}

function sharedProviderRecord(config, env) {
    const s = config.shared;
    const base = s.baseUrl;
    // Live's rule: Anthropic only when explicitly chosen and not pointed at an OpenAI-compatible
    // gateway; everything else (openai, openrouter, groq, ollama, blank) is OpenAI-shaped.
    const kind = s.provider === 'anthropic' && (!base || /anthropic\.com/i.test(base)) ? 'anthropic' : 'openai';
    const hasKey = Boolean(resolveSecret(s.apiKeyRef, env));
    const selfHosted = Boolean(base) && !/api\.openai\.com|anthropic\.com/i.test(base);
    const auth = kind === 'anthropic' ? 'x-api-key' : (hasKey || !selfHosted ? 'bearer' : 'none');
    return {
        key: 'shared', display_name: 'Shared provider (Live\'s shared key)', kind,
        status: s.enabled ? 'active' : 'disabled',
        base_url: base || (kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'),
        auth_mode: auth, secret_ref: s.apiKeyRef,
        default_model: s.model || (kind === 'anthropic' ? 'claude-sonnet-5' : 'gpt-4o-mini'),
        capabilities: kind === 'anthropic'
            ? ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json', 'vision']
            // image only with AI_IMAGE_MODEL: the Images API is OpenAI-shaped, and image generation is off without it.
            : ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json', 'vision', 'embed', 'transcribe', ...(config.image && config.image.model ? ['image'] : [])],
        timeout_ms: s.timeoutMs, priority: 10, metadata: { configured_by: 'AI_PROVIDER/AI_BASE_URL/AI_API_KEY/AI_MODEL', provider_name: s.provider || 'openai-compatible', billing_profile: 'metered',
            // OpenAI's own API sells a Flex tier (about half the price, slower) and a Batch API (half the
            // price, within 24 hours). A self-hosted gateway does not, so the multipliers belong to
            // OpenAI's own page only: https://platform.openai.com/docs/guides/flex-processing and
            // https://platform.openai.com/docs/guides/batch (read 2026-11-07).
            ...(/api\.openai\.com/i.test(base) ? { tier_rates: { flex: 0.5, batch: 0.5 } } : {}) },
    };
}

function speechProviderRecords(config, env) {
    const out = [];
    const gkey = config.speech ? resolveSecret(config.speech.googleKeyRef, env) : '';
    out.push({ key: 'google-tts', display_name: 'Google Cloud Text-to-Speech', kind: 'google-tts',
        status: gkey ? 'active' : 'disabled',
        base_url: (config.speech && config.speech.googleBaseUrl) || 'https://texttospeech.googleapis.com',
        auth_mode: 'bearer', secret_ref: config.speech ? config.speech.googleKeyRef : 'env:AI_GOOGLE_TTS_API_KEY',
        default_model: 'gc_smooth_operator', capabilities: ['speak'],
        timeout_ms: (config.speech && config.speech.timeoutMs) || 60000, priority: 20, provider_access: 'OWN_DEPLOYMENT',
        metadata: { configured_by: 'AI_GOOGLE_TTS_API_KEY', provider_name: 'google-tts', billing_profile: 'metered' } });
    const pkey = config.speech ? resolveSecret(config.speech.pollyKeyRef, env) : '';
    out.push({ key: 'polly', display_name: 'Amazon Polly', kind: 'polly',
        status: pkey ? 'active' : 'disabled',
        base_url: (config.speech && config.speech.pollyBaseUrl) || 'https://polly.amazonaws.com',
        auth_mode: 'bearer', secret_ref: config.speech ? config.speech.pollyKeyRef : 'env:AI_POLLY_ACCESS_KEY_ID',
        default_model: 'pl_joanna_std', capabilities: ['speak'],
        timeout_ms: (config.speech && config.speech.timeoutMs) || 60000, priority: 20, provider_access: 'OWN_DEPLOYMENT',
        metadata: { configured_by: 'AI_POLLY_ACCESS_KEY_ID', provider_name: 'polly', billing_profile: 'metered' } });
    // ElevenLabs (2026-11-13): the third voice. The key is the owner's (AI_ELEVENLABS_API_KEY in the
    // server's settings, or the key the guided setup stores in ai.provider_keys). UNVERIFIED until the
    // owner reads its terms, so it serves the network's own work and stays out of paid managed routes.
    const ekey = config.speech ? resolveSecret(config.speech.elevenLabsKeyRef, env) : '';
    out.push({ key: 'elevenlabs', display_name: 'ElevenLabs', kind: 'elevenlabs',
        status: ekey ? 'active' : 'disabled',
        base_url: (config.speech && config.speech.elevenLabsBaseUrl) || 'https://api.elevenlabs.io',
        auth_mode: 'x-api-key', secret_ref: config.speech ? config.speech.elevenLabsKeyRef : 'env:AI_ELEVENLABS_API_KEY',
        default_model: 'eleven_voice', capabilities: ['speak'],
        timeout_ms: (config.speech && config.speech.timeoutMs) || 60000, priority: 20, provider_access: 'UNVERIFIED',
        metadata: { configured_by: 'AI_ELEVENLABS_API_KEY', provider_name: 'elevenlabs', billing_profile: 'metered' } });
    return out;
}

function providerRecords(config, env) {
    const out = [
        { key: 'stub', display_name: 'Deterministic stub (synthetic output)', kind: 'stub', status: 'active', auth_mode: 'none', default_model: 'stub-1', capabilities: ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'embed', 'json', 'vision', 'transcribe', 'speak', 'speech'], timeout_ms: 10000, priority: 1000, provider_access: 'OWN_DEPLOYMENT', metadata: { synthetic: true, billing_profile: 'free' } },
        sharedProviderRecord(config, env),
        deepseekProviderRecord(config, env),
        ...speechProviderRecords(config, env),
        { key: 'whisper', display_name: 'whisper.cpp (local speech-to-text)', kind: 'whisper', status: 'active', auth_mode: 'none', default_model: 'whisper.cpp', capabilities: ['transcribe'], timeout_ms: 600000, priority: 20, provider_access: 'OWN_DEPLOYMENT', metadata: { configured_by: 'WHISPER_*', billing_profile: 'free' } },
    ];
    // A local model server (llama.cpp, Ollama) speaking the OpenAI API: no key, never paid (WS-O task 5).
    // No json: the small local models must not be offered the product JSON routes. Embed only with an embedding model.
    const localTextCaps = ['chat', 'generate', 'summarize', 'classify', 'extract'];
    if (config.localLlm && config.localLlm.url) {
        const localCaps = [...localTextCaps];
        if (config.localLlm.embedModel) localCaps.push('embed');
        out.push({ key: 'local', display_name: 'Local model (OpenAI-compatible server on this host)', kind: 'openai', status: 'active', base_url: config.localLlm.url, auth_mode: 'none', secret_ref: null, default_model: config.localLlm.model || 'local', capabilities: localCaps, timeout_ms: config.localLlm.timeoutMs, priority: 5, provider_access: 'OWN_DEPLOYMENT', metadata: { configured_by: 'AI_LOCAL_LLM_URL', embed_url: config.localLlm.embedUrl || config.localLlm.url, local: true, paid: false, billing_profile: 'free' } });
    }
    if (config.localLlm2 && config.localLlm2.url) {
        // The second local chat model: another llama.cpp process and another family, so a match has two sides.
        out.push({ key: 'local2', display_name: 'Local model 2 (OpenAI-compatible server on this host)', kind: 'openai', status: 'active', base_url: config.localLlm2.url, auth_mode: 'none', secret_ref: null, default_model: config.localLlm2.model || 'local2', capabilities: [...localTextCaps], timeout_ms: config.localLlm2.timeoutMs, priority: 5, provider_access: 'OWN_DEPLOYMENT', metadata: { configured_by: 'AI_LOCAL_LLM2_URL', local: true, paid: false, billing_profile: 'free' } });
    }
    if (config.httpSeamUrl) {
        out.push({ key: 'http-seam', display_name: 'Local HTTP seam', kind: 'http', status: 'active', base_url: config.httpSeamUrl, auth_mode: 'none', default_model: null, capabilities: [], timeout_ms: 30000, priority: 60, metadata: { configured_by: 'AI_HTTP_SEAM_URL', billing_profile: 'metered' } });
    }
    return out;
}

// Workflows and templates whose callers are gone: the Arena's (Live#264, 2026-10-19; it became The Rundown).
const RETIRED = ['live.arena.persona', 'live.arena.quotes', 'live.arena.headline', 'live.arena.drama', 'live.arena.judge_beef', 'live.arena.judge_mic',
    'live.arena.scene', 'live.arena.judge'];

/** Retired with their callers: what is stored is archived, so nothing runs it and it leaves the admin lists. */
async function retire({ registry, db, keys = RETIRED }) {
    let n = 0;
    for (const key of keys) {
        for (const [kind, table] of [['workflow', 'workflows'], ['template', 'templates']]) {
            for (const r of await db.prepare(`SELECT version FROM ${table} WHERE key = ? AND status <> 'archived'`).all(key)) {
                await registry.setStatus(kind, key, r.version, 'archived', { actor: 'seed' });
                n++;
            }
        }
    }
    return n;
}

async function seed({ registry, quotas, config, env = process.env, db }) {
    // Providers
    for (const p of providerRecords(config, env)) {
        const prev = await registry.getProvider(p.key);
        if (!prev || prev.origin === 'seed') {
            const same = prev && Object.keys(p).every(k => JSON.stringify(p[k] ?? null) === JSON.stringify(prev[k] ?? null));
            if (!same) await registry.upsertProvider({ base_url: null, secret_ref: null, ...p }, { actor: 'seed', origin: 'seed' });
        }
    }
    // The providers OpenVibe buys managed capacity from (the Exchange remake, stage 2): Qwen, Kimi, GLM, MiniMax,
    // DeepInfra, Novita, Featherless, Refuseless, Abliteration.ai and OpenRouter. Each is registered off until its key
    // is in the owner settings; the pool skips one whose key does not resolve. Prices come from each provider's own
    // page, with that page and the day they were read (server/providers/pool-providers.js).
    await poolSeed.seedPoolProviders({ registry, actor: 'seed', env });
    const shared = await registry.getProvider('shared');

    // Models
    const models = new Set([shared.default_model]);
    for (const m of models) if (m && !await registry.getModel('shared', m)) await registry.upsertModel({ provider_key: 'shared', model_key: m, type: 'chat', supports: { json: true, vision: true } }, { actor: 'seed' });
    // DeepSeek's own provider and two chat models when its key is configured. A model a person disabled stays
    // disabled; the prices and provenance are refreshed from the constants above on every boot.
    const deepseek = await registry.getProvider('deepseek');
    if (deepseek && deepseek.status === 'active') {
        for (const m of DEEPSEEK_MODELS) {
            const prev = await registry.getModel('deepseek', m.model_key);
            // Once the price book has checked a price it owns it: the seed does not write over it.
            const owned = prev && prev.metadata && prev.metadata.price_book;
            if (!prev || (!owned && prev.metadata && prev.metadata.configured_by === 'DEEPSEEK_API_KEY')) {
                await registry.upsertModel({ provider_key: 'deepseek', ...m, status: prev ? prev.status : 'active',
                    display_name: prev?.metadata?.owner_display_name ? prev.display_name : m.display_name,
                    metadata: { ...m.metadata, ...prev?.metadata },
                }, { actor: 'seed' });
            }
        }
    }
    if (!await registry.getModel('stub', 'stub-1')) await registry.upsertModel({ provider_key: 'stub', model_key: 'stub-1', type: 'chat', supports: { json: true, vision: true }, metadata: { synthetic: true } }, { actor: 'seed' });
    // Speech voices (the Exchange speech route): one model per Chat cloud voice id on its provider, priced per
    // million characters at the provider's own list price (docs/provider-adapters.md#speech). The rate cards
    // price `in_per_mtok` as dollars per million characters for these models; `unit` in the metadata says so.
    try {
        const { VOICES, googleTierOf } = require('../providers/speech');
        for (const [id, v] of Object.entries(VOICES)) {
            const prev = await registry.getModel(v.provider, id);
            if (prev && !(prev.metadata && prev.metadata.configured_by === 'AI_SPEECH_SEED')) continue;
            const source = v.provider === 'google-tts' ? 'https://cloud.google.com/text-to-speech/pricing'
                : v.provider === 'elevenlabs' ? 'https://elevenlabs.io/pricing/api' : 'https://aws.amazon.com/polly/pricing/';
            // The day that voice's own price was read (the Google and Polly voices on 2026-11-10, ElevenLabs on 2026-11-13).
            const checked = v.provider === 'elevenlabs' ? '2026-11-13' : '2026-11-10';
            await registry.upsertModel({ provider_key: v.provider, model_key: id,
                display_name: v.voiceId ? `${v.voiceId} (${v.engine})` : (v.label || v.voice || v.voiceName || v.id),
                type: 'speech', status: 'active', context_window: null, max_output: null,
                cost: { in_per_mtok: v.price_per_million_chars_usd, out_per_mtok: 0, cached_per_mtok: null,
                    effective_from: checked, source, verified_at: checked },
                supports: { json: false, tools: false, streaming: false, vision: false },
                metadata: { configured_by: 'AI_SPEECH_SEED', unit: 'characters', price_per_million_chars_usd: v.price_per_million_chars_usd,
                    cloud_voice: v.voice || v.voiceId || null, cloud_engine: v.engine || googleTierOf(v.voice),
                    ...(v.voice && /Journey/i.test(v.voice) ? { pricing_note: 'Journey has no row on the current pricing page; priced at the Neural2 SKU until Google publishes one.' } : {}) },
            }, { actor: 'seed' });
        }
    } catch (err) { console.warn(`[seed] speech voices were not seeded: ${String((err && err.message) || err).slice(0, 160)}`); }
    if (!await registry.getModel('whisper', 'whisper.cpp')) await registry.upsertModel({ provider_key: 'whisper', model_key: 'whisper.cpp', type: 'stt', supports: { json: false } }, { actor: 'seed' });
    const embeddingModel = env.AI_EMBEDDING_MODEL || 'text-embedding-3-small';
    if (!await registry.getModel('shared', embeddingModel)) await registry.upsertModel({ provider_key: 'shared', model_key: embeddingModel, type: 'embedding' }, { actor: 'seed' });
    // The image model (AI_IMAGE_MODEL) on the shared provider: the only member of default.image until another is added.
    const imageModel = shared && shared.kind === 'openai' && config.image && config.image.model;
    if (imageModel && !await registry.getModel('shared', imageModel)) await registry.upsertModel({ provider_key: 'shared', model_key: imageModel, type: 'image' }, { actor: 'seed' });
    // The local embedding model joins default.embedding as its free member (vectors differ per upstream).
    const localEmbed = config.localLlm && config.localLlm.url && config.localLlm.embedModel;
    if (localEmbed && !await registry.getModel('local', localEmbed)) await registry.upsertModel({ provider_key: 'local', model_key: localEmbed, type: 'embedding', metadata: { seeded: true } }, { actor: 'seed' });
    // Never mix vectors: a seeded local embedding model that is no longer the configured one is retired.
    if (await registry.getProvider('local')) {
        for (const m of await registry.listModels({ provider: 'local' })) {
            if (m.type === 'embedding' && m.status === 'active' && m.metadata && m.metadata.seeded && m.model_key !== localEmbed) await registry.upsertModel({ provider_key: 'local', model_key: m.model_key, status: 'disabled' }, { actor: 'seed' });
        }
    }

    // The room a background route gets (BA1): a Flex tier answers in minutes, not seconds.
    const BACKGROUND_TIMEOUT = 180000;
    // Routes. A capability pool covers every provider that can serve the capability, ordered by
    // openvibe-sdk/placement (brief §4/§5): no static primary/fallbacks and no AI_MODEL_<ROLE> pins.
    // The shared provider is the pool's authority (objective correctness): it serves while it is healthy and
    // the planner fails over to the rest of the pool (the local model) only when it is not, so a small local
    // model never wins Live's text work on price. The media pools remain separate: media.analyze tries
    // local providers first and only reaches paid providers under its own budget.
    const authority = shared ? (shared.default_model ? `shared:${shared.default_model}` : 'shared') : null;
    // This route field names a model operation; the contracts scanner checks unquoted capability keys as auth grants.
    const pool = (timeoutMs, extra = {}) => ({ 'capability': 'chat', constraints: { objective: 'correctness', latency_class: 'interactive', ...(authority ? { authority } : {}) }, pinned: [], fallbacks: [], options: {}, max_output_tokens: null, response_format: 'text', timeout_ms: timeoutMs, alias_of: null, ...extra });
    for (const role of live.ROLES) {
        await registry.seedVersioned('route', `live.${role}`, pool(ROLE_TIMEOUT[role]));
    }
    // Speech and embeddings only admit registered models of the matching type. Embeddings fall over to the local
    // embedding model when AI_LOCAL_EMBED_MODEL registers one; until O9 adds another speech upstream (and for
    // embeddings without a local model), an unavailable sole provider still answers the explicit 503.
    await registry.seedVersioned('route', 'live.stt', pool(600000, { 'capability': 'transcribe', constraints: { objective: 'balanced' } }));
    await registry.seedVersioned('route', 'default.chat', pool(30000, { max_output_tokens: 800 }));
    // POST /v1/messages (Codes C3): only providers that speak Anthropic's Messages API join this pool — the shared
    // provider when it is Anthropic's own API, DeepSeek's and MiniMax's Anthropic-compatible endpoints, and any record an
    // admin adds as kind anthropic. The others are skipped as unsupported, never converted.
    await registry.seedVersioned('route', 'default.messages', pool(120000, { constraints: { objective: 'correctness', latency_class: 'interactive' }, max_output_tokens: 8192 }));
    await registry.seedVersioned('route', 'default.json', pool(60000, { options: { temperature: 0.3 }, max_output_tokens: 2400, response_format: 'json' }));
    // Meme captions need fluency, not factual precision; choose the cheapest eligible JSON route by default.
    await registry.seedVersioned('route', 'meme.caption', pool(30000, { constraints: { objective: 'cheapest', latency_class: 'interactive' }, options: { temperature: 0.85 }, max_output_tokens: 700, response_format: 'json' }));
    // A layout suggestion is a small JSON arrangement, not a conversation: the cheapest structured-output
    // offer that is healthy, with room for every part of a surface (make your own controls, 2026-11-11).
    await registry.seedVersioned('route', 'ui.layout.suggest', pool(60000, { constraints: { objective: 'cheapest', latency_class: 'interactive' }, options: { temperature: 0.2 }, max_output_tokens: 4000, response_format: 'json' }));
    // Decisions without the Decisions API (2026-11-12): small JSON probabilities, the cheapest healthy structured offer.
    await registry.seedVersioned('route', 'decide.fallback', pool(60000, { constraints: { objective: 'cheapest', latency_class: 'interactive' }, options: { temperature: 0 }, max_output_tokens: 4000, response_format: 'json' }));
    await registry.seedVersioned('route', 'default.embedding', pool(30000, { 'capability': 'embed', constraints: { objective: 'balanced' } }));
    // Speech (the Exchange speech route): the voice pins the exact offer, so the pool is only the fallback
    // order when no voice is pinned; every provider that declares `speak` may answer it.
    await registry.seedVersioned('route', 'default.speech', pool(60000, { 'capability': 'speak', constraints: { objective: 'balanced' } }));
    // media.analyze (WS-O task 5): the local model when there is one; the paid route is used only under a media.paid budget.
    // Both are background work (BA1): nobody watches a VOD's overview arrive, so the route says it may wait.
    // The run's own route (media.analysis) exists whatever the host has: it carries the class of the work, and the
    // step inside it picks the local or the paid route for the answer it actually gives.
    await registry.seedVersioned('route', 'media.analysis', pool(BACKGROUND_TIMEOUT, { 'capability': 'chat', constraints: { objective: 'balanced', latency_class: 'background' } }));
    if (config.localLlm && config.localLlm.url) await registry.seedVersioned('route', 'media.local', pool(config.localLlm.timeoutMs, { 'capability': 'summarize', constraints: { objective: 'balanced', latency_class: 'background', provider_scope: 'local' }, options: { temperature: 0.3 }, max_output_tokens: 350 }));
    await registry.seedVersioned('route', 'media.paid', pool(60000, { 'capability': 'summarize', constraints: { objective: 'correctness', latency_class: 'background', provider_scope: 'paid', ...(authority ? { authority } : {}) }, options: { temperature: 0.3 }, max_output_tokens: 350 }));
    // Images (metered per image) only with AI_IMAGE_MODEL: paid providers' registered image models, the shared one first.
    if (imageModel) await registry.seedVersioned('route', 'default.image', pool(120000, { 'capability': 'image', constraints: { objective: 'correctness', provider_scope: 'paid', authority: `shared:${imageModel}` } }));
    for (const key of HISTORICAL_ROUTES) await registry.seedVersioned('route', key, { primary: { provider: 'shared', model: null }, fallbacks: [], options: {}, max_output_tokens: null, response_format: 'json', timeout_ms: null, alias_of: 'default.json' });
    // Food's cupboard photos and receipts (food.read_pantry_photo): JSON from an image, on the JSON pool (its models read images).
    await registry.seedVersioned('route', 'food.vision', { primary: { provider: 'shared', model: null }, fallbacks: [], options: {}, max_output_tokens: 1200, response_format: 'json', timeout_ms: 60000, alias_of: 'default.json' });
    // OpenVibe.Pics' alt text (pics.describe_image): JSON from an image, on the JSON pool like food.vision.
    await registry.seedVersioned('route', 'pics.vision', { primary: { provider: 'shared', model: null }, fallbacks: [], options: {}, max_output_tokens: 400, response_format: 'json', timeout_ms: 60000, alias_of: 'default.json' });
    // Writing people read for fun (The Rundown's desk, live.rundown.*): the chat pool with a stronger model as its
    // authority (AI_CREATIVE_MODEL, gpt-5-mini on OpenAI's API by default; the shared default elsewhere). The nano default
    // misspelled names and wrote flat copy (2026-10-16); the desk makes at most 40 calls an hour.
    const creativeModel = env.AI_CREATIVE_MODEL || (shared && shared.kind === 'openai' && /api\.openai\.com/i.test(shared.base_url || '') ? 'gpt-5-mini' : null);
    if (creativeModel && !await registry.getModel('shared', creativeModel)) await registry.upsertModel({ provider_key: 'shared', model_key: creativeModel, type: 'chat', supports: { json: true, vision: true } }, { actor: 'seed' });
    await registry.seedVersioned('route', 'live.creative', pool(ROLE_TIMEOUT.chat, creativeModel ? { constraints: { objective: 'correctness', latency_class: 'interactive', model: creativeModel, authority: `shared:${creativeModel}` } } : {}));
    // The background routes (BA1): the same pools as the interactive ones, but the route says the work may
    // wait (constraints.latency_class 'background'). The router then looks for the cheapest tier that can
    // answer in minutes: the host's own idle model, a Flex tier, or a provider's off-peak hours. The timeout
    // is longer, because a Flex tier is slower than the standard one. A workflow's route is what gives it
    // its class, so a workflow that uses one of these routes runs in the background.
    //
    // These routes name NO model: the whole point of a background run is that the cheapest offer that can do
    // the work may answer it. The authority is still the shared provider (the network's choice). The host's own
    // idle model answers first only on a route with constraints.allow_local: true, and none of these sets it yet
    // (Opus, 11-07): their text is what people read on Trade, Live and the Rundown, and a 1.5B model is not measured
    // for it. A route that names its model (the creative one below) keeps that model.
    const backgroundPool = (timeoutMs, extra = {}) => ({ 'capability': 'chat', constraints: { objective: 'correctness', latency_class: 'background', ...(authority ? { authority } : {}) }, pinned: [], fallbacks: [], options: {}, max_output_tokens: null, response_format: 'text', timeout_ms: timeoutMs, alias_of: null, ...extra });
    // Each one carries the Live role it serves (legacy, summary, vision, director), so a person who gave their
    // own key a model for that role still gets it (server/providers/index.js roleOfRoute).
    await registry.seedVersioned('route', 'background.legacy', backgroundPool(BACKGROUND_TIMEOUT));
    await registry.seedVersioned('route', 'background.summary', backgroundPool(BACKGROUND_TIMEOUT));
    await registry.seedVersioned('route', 'background.vision', backgroundPool(BACKGROUND_TIMEOUT));
    await registry.seedVersioned('route', 'background.director', backgroundPool(BACKGROUND_TIMEOUT));
    await registry.seedVersioned('route', 'background.json', backgroundPool(BACKGROUND_TIMEOUT, { options: { temperature: 0.3 }, max_output_tokens: 2400, response_format: 'json' }));
    // Media's rotation detector (pics.orientation): a 256 px picture and four possible numbers, so background work
    // with a small answer. The owner's task default may pin a different model; the detector asks for the cheapest.
    await registry.seedVersioned('route', 'pics.orientation', { primary: { provider: 'shared', model: null }, fallbacks: [], options: { temperature: 0 }, max_output_tokens: 80, response_format: 'json', timeout_ms: 60000, alias_of: 'background.json' });
    await registry.seedVersioned('route', 'background.creative', backgroundPool(BACKGROUND_TIMEOUT, creativeModel ? { constraints: { objective: 'correctness', latency_class: 'background', model: creativeModel, authority: `shared:${creativeModel}` } } : {}));
    // Chat's AI members (server/workflows/chat.js): conversation text, so an alias of the chat pool.
    // Space's spaces (server/workflows/space.js): the builder writes whole apps, so it gets the creative model and room to
    // finish; a space's own AI is conversation text, an alias of the chat pool.
    await registry.seedVersioned('route', 'space.build', pool(180000, { max_output_tokens: 16000, options: { outlast_provider_timeout: true }, ...(creativeModel ? { constraints: { objective: 'correctness', latency_class: 'interactive', model: creativeModel, authority: `shared:${creativeModel}` } } : {}) }));
    // Wiki generation (wiki.generate_space, wiki.generate_page): long cited pages people read, so the creative model, room
    // to write (a page is several thousand tokens) and time to finish past the provider's chat timeout.
    await registry.seedVersioned('route', 'wiki.write', pool(170000, { max_output_tokens: 7000, response_format: 'json', options: { outlast_provider_timeout: true, temperature: 0.4 }, ...(creativeModel ? { constraints: { objective: 'correctness', latency_class: 'interactive', model: creativeModel, authority: `shared:${creativeModel}` } } : {}) }));
    await registry.seedVersioned('route', 'space.ask', { primary: { provider: 'shared', model: null }, fallbacks: [], options: {}, max_output_tokens: 800, response_format: 'text', timeout_ms: null, alias_of: 'default.chat' });
    await registry.seedVersioned('route', 'chat.member', { primary: { provider: 'shared', model: null }, fallbacks: [], options: {}, max_output_tokens: 600, response_format: 'text', timeout_ms: null, alias_of: 'default.chat' });

    // Templates, then workflows (workflows reference templates)
    for (const t of [...live.templates, ...core.templates, ...products.templates, ...devblog.templates, ...media.templates, ...chat.templates, ...space.templates, ...research.templates, ...meme.templates, ...changelog.templates, ...pictures.templates, ...uiLayout.templates, ...decide.templates]) {
        const { key, ...def } = t;
        await registry.seedVersioned('template', key, { description: null, default_route: null, owner: 'ai', visibility: 'internal', metadata: {}, ...def });
    }
    for (const w of [...live.workflows, ...core.workflows, ...products.workflows, ...devblog.workflows, ...media.workflows, ...chat.workflows, ...space.workflows, ...research.workflows, ...deepDive.workflows, ...video.workflows, ...meme.workflows, ...changelog.workflows, ...pictures.workflows, ...uiLayout.workflows, ...decide.workflows]) {
        const { key, ...def } = w;
        await registry.seedVersioned('workflow', key, { description: null, default_route: null, cache_ttl_sec: null, metadata: {}, ...def });
    }
    await retire({ registry, db });

    // Quotas
    const seedQuota = async (q) => {
        const prev = await db.prepare("SELECT origin FROM quotas WHERE scope_type = ? AND scope_id = ? AND \"window\" = ? AND COALESCE(workflow_prefix, '') = ''").get(q.scope_type, q.scope_type === 'global' ? '*' : q.scope_id, q.window);
        if (!prev || prev.origin === 'seed') await quotas.upsert(q, { actor: 'seed', origin: 'seed' });
    };
    if (config.quotas.globalCostPerDay > 0) await seedQuota({ scope_type: 'global', window: 'day', max_cost_usd: config.quotas.globalCostPerDay });
    if (config.quotas.serviceRequestsPerMinute > 0) await seedQuota({ scope_type: 'service', scope_id: '*', window: 'minute', max_requests: config.quotas.serviceRequestsPerMinute });
    if (config.quotas.serviceRequestsPerDay > 0) await seedQuota({ scope_type: 'service', scope_id: '*', window: 'day', max_requests: config.quotas.serviceRequestsPerDay });
}

module.exports = { seed, retire, providerRecords, HISTORICAL_ROUTES, RETIRED };
