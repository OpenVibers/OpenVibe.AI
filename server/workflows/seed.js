'use strict';
/**
 * Boot-time seeding from configuration and code. Idempotent: every boot re-applies it.
 *
 *   providers  stub (always), shared (Live's shared key: AI_PROVIDER / AI_BASE_URL / AI_API_KEY /
 *              AI_MODEL), fallback (AI_FALLBACK_*), http-seam (AI_HTTP_SEAM_URL), whisper (WHISPER_*)
 *              — records whose origin is 'seed' follow the environment; admin-edited ones are left alone
 *   models     the configured default and per-role models
 *   routes     live.<role> for Live's roles (AI_MODEL_<ROLE> overrides), live.stt, default.chat|json|
 *              embedding, and the historical product route keys as explicit aliases of default.json
 *   templates, workflows   from server/workflows/{live,core,products}.js — a code change becomes a
 *              new version unless an admin has versioned that key since (admin edits win)
 *   quotas     AI_MAX_COST_USD_PER_DAY (global/day, Live's ai_max_cost_usd_per_day) and a per-service
 *              request rate for every service
 */
const live = require('./live');
const core = require('./core');
const products = require('./products');
const { resolveSecret } = require('../util');

const ROLE_TIMEOUT = { chat: 20000, vision: 30000, director: 25000, summary: 30000, legacy: 30000 };
const HISTORICAL_ROUTES = ['wiki.generate', 'blog.draft', 'news.summarize', 'reviews.summarize', 'deals.enrich', 'coupons.extract', 'trade.summarize', 'codes.generate_docs', 'games.generate_lore', 'moderation.classify'];

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
            : ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json', 'vision', 'embed', 'transcribe'],
        timeout_ms: s.timeoutMs, priority: 10, metadata: { configured_by: 'AI_PROVIDER/AI_BASE_URL/AI_API_KEY/AI_MODEL', provider_name: s.provider || 'openai-compatible' },
    };
}

function providerRecords(config, env) {
    const out = [
        { key: 'stub', display_name: 'Deterministic stub (synthetic output)', kind: 'stub', status: 'active', auth_mode: 'none', default_model: 'stub-1', capabilities: ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'embed', 'json', 'vision', 'transcribe'], timeout_ms: 10000, priority: 1000, metadata: { synthetic: true } },
        sharedProviderRecord(config, env),
        { key: 'whisper', display_name: 'whisper.cpp (local speech-to-text)', kind: 'whisper', status: 'active', auth_mode: 'none', default_model: 'whisper.cpp', capabilities: ['transcribe'], timeout_ms: 600000, priority: 20, metadata: { configured_by: 'WHISPER_*' } },
    ];
    if (config.fallback.baseUrl) {
        const kind = config.fallback.kind === 'anthropic' ? 'anthropic' : 'openai';
        out.push({ key: 'fallback', display_name: 'Fallback provider', kind, status: 'active', base_url: config.fallback.baseUrl, auth_mode: resolveSecret(config.fallback.apiKeyRef, env) ? (kind === 'anthropic' ? 'x-api-key' : 'bearer') : 'none', secret_ref: config.fallback.apiKeyRef, default_model: config.fallback.model || null, capabilities: [], timeout_ms: 30000, priority: 50, metadata: { configured_by: 'AI_FALLBACK_*' } });
    }
    if (config.httpSeamUrl) {
        out.push({ key: 'http-seam', display_name: 'Local HTTP seam', kind: 'http', status: 'active', base_url: config.httpSeamUrl, auth_mode: 'none', default_model: null, capabilities: [], timeout_ms: 30000, priority: 60, metadata: { configured_by: 'AI_HTTP_SEAM_URL' } });
    }
    return out;
}

function seed({ registry, quotas, config, env = process.env, db }) {
    // Providers
    for (const p of providerRecords(config, env)) {
        const prev = registry.getProvider(p.key);
        if (!prev || prev.origin === 'seed') {
            const same = prev && Object.keys(p).every(k => JSON.stringify(p[k] ?? null) === JSON.stringify(prev[k] ?? null));
            if (!same) registry.upsertProvider({ base_url: null, secret_ref: null, ...p }, { actor: 'seed', origin: 'seed' });
        }
    }
    const shared = registry.getProvider('shared');
    const hasFallback = Boolean(registry.getProvider('fallback'));
    const fallbacks = hasFallback ? [{ provider: 'fallback', model: null }] : [];

    // Models
    const models = new Set([shared.default_model, ...Object.values(config.shared.roleModels)]);
    for (const m of models) if (m && !registry.getModel('shared', m)) registry.upsertModel({ provider_key: 'shared', model_key: m, type: 'chat', supports: { json: true, vision: true } }, { actor: 'seed' });
    if (!registry.getModel('stub', 'stub-1')) registry.upsertModel({ provider_key: 'stub', model_key: 'stub-1', type: 'chat', supports: { json: true, vision: true }, metadata: { synthetic: true } }, { actor: 'seed' });
    if (!registry.getModel('whisper', 'whisper.cpp')) registry.upsertModel({ provider_key: 'whisper', model_key: 'whisper.cpp', type: 'stt', supports: { json: false } }, { actor: 'seed' });

    // Routes
    for (const role of live.ROLES) {
        registry.seedVersioned('route', `live.${role}`, {
            primary: { provider: 'shared', model: config.shared.roleModels[role] || null }, fallbacks,
            options: {}, max_output_tokens: null, response_format: 'text', timeout_ms: ROLE_TIMEOUT[role], alias_of: null,
        });
    }
    registry.seedVersioned('route', 'live.stt', { primary: { provider: 'whisper', model: null }, fallbacks: [], options: {}, max_output_tokens: null, response_format: 'text', timeout_ms: 600000, alias_of: null });
    registry.seedVersioned('route', 'default.chat', { primary: { provider: 'shared', model: null }, fallbacks, options: {}, max_output_tokens: 800, response_format: 'text', timeout_ms: 30000, alias_of: null });
    registry.seedVersioned('route', 'default.json', { primary: { provider: 'shared', model: null }, fallbacks, options: { temperature: 0.3 }, max_output_tokens: 2400, response_format: 'json', timeout_ms: 60000, alias_of: null });
    registry.seedVersioned('route', 'default.embedding', { primary: { provider: 'shared', model: env.AI_EMBEDDING_MODEL || 'text-embedding-3-small' }, fallbacks: [], options: {}, max_output_tokens: null, response_format: 'text', timeout_ms: 30000, alias_of: null });
    for (const key of HISTORICAL_ROUTES) registry.seedVersioned('route', key, { primary: { provider: 'shared', model: null }, fallbacks: [], options: {}, max_output_tokens: null, response_format: 'json', timeout_ms: null, alias_of: 'default.json' });

    // Templates, then workflows (workflows reference templates)
    for (const t of [...live.templates, ...core.templates, ...products.templates]) {
        const { key, ...def } = t;
        registry.seedVersioned('template', key, { description: null, default_route: null, owner: 'ai', visibility: 'internal', metadata: {}, ...def });
    }
    for (const w of [...live.workflows, ...core.workflows, ...products.workflows]) {
        const { key, ...def } = w;
        registry.seedVersioned('workflow', key, { description: null, default_route: null, cache_ttl_sec: null, metadata: {}, ...def });
    }

    // Quotas
    const seedQuota = (q) => {
        const prev = db.prepare("SELECT origin FROM quotas WHERE scope_type = ? AND scope_id = ? AND window = ? AND COALESCE(workflow_prefix, '') = ''").get(q.scope_type, q.scope_type === 'global' ? '*' : q.scope_id, q.window);
        if (!prev || prev.origin === 'seed') quotas.upsert(q, { actor: 'seed', origin: 'seed' });
    };
    if (config.quotas.globalCostPerDay > 0) seedQuota({ scope_type: 'global', window: 'day', max_cost_usd: config.quotas.globalCostPerDay });
    if (config.quotas.serviceRequestsPerMinute > 0) seedQuota({ scope_type: 'service', scope_id: '*', window: 'minute', max_requests: config.quotas.serviceRequestsPerMinute });
    if (config.quotas.serviceRequestsPerDay > 0) seedQuota({ scope_type: 'service', scope_id: '*', window: 'day', max_requests: config.quotas.serviceRequestsPerDay });
}

module.exports = { seed, providerRecords, HISTORICAL_ROUTES };
