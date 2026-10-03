'use strict';
/**
 * Boot-time seeding from configuration and code. Idempotent: every boot re-applies it.
 *
 *   providers  stub (always), shared (Live's shared key: AI_PROVIDER / AI_BASE_URL / AI_API_KEY /
 *              AI_MODEL), http-seam (AI_HTTP_SEAM_URL), whisper (WHISPER_*), local (AI_LOCAL_LLM_URL)
 *              — records whose origin is 'seed' follow the environment; admin-edited ones are left alone
 *   models     the configured default model
 *   routes     live.<role> for Live's roles, live.stt, default.chat|json|embedding and media.local|paid
 *              as capability pools ordered by openvibe-sdk/placement; and the historical
 *              product route keys as explicit aliases of default.json
 *   templates, workflows   from server/workflows/{live,core,products}.js — a code change becomes a
 *              new version unless an admin has versioned that key since (admin edits win)
 *   quotas     AI_MAX_COST_USD_PER_DAY (global/day, Live's ai_max_cost_usd_per_day) and a per-service
 *              request rate for every service
 */
const live = require('./live');
const media = require('./media');
const core = require('./core');
const products = require('./products');
const { resolveSecret } = require('../util');

const ROLE_TIMEOUT = { chat: 20000, vision: 30000, director: 25000, summary: 30000, legacy: 30000 };
const HISTORICAL_ROUTES = ['wiki.generate', 'blog.draft', 'news.summarize', 'reviews.summarize', 'deals.enrich', 'coupons.extract', 'trade.summarize', 'codes.generate_docs', 'games.generate_lore', 'moderation.classify', 'tools.describe'];

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
    if (config.localLlm && config.localLlm.url) {
        // A local model server (llama.cpp, Ollama) speaking the OpenAI API: no key, never paid (WS-O task 5).
        out.push({ key: 'local', display_name: 'Local model (OpenAI-compatible server on this host)', kind: 'openai', status: 'active', base_url: config.localLlm.url, auth_mode: 'none', secret_ref: null, default_model: config.localLlm.model || 'local', capabilities: ['chat', 'generate', 'summarize', 'classify', 'extract'], timeout_ms: config.localLlm.timeoutMs, priority: 5, metadata: { configured_by: 'AI_LOCAL_LLM_URL', local: true, paid: false } });
    }
    if (config.httpSeamUrl) {
        out.push({ key: 'http-seam', display_name: 'Local HTTP seam', kind: 'http', status: 'active', base_url: config.httpSeamUrl, auth_mode: 'none', default_model: null, capabilities: [], timeout_ms: 30000, priority: 60, metadata: { configured_by: 'AI_HTTP_SEAM_URL' } });
    }
    return out;
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
    const shared = await registry.getProvider('shared');

    // Models
    const models = new Set([shared.default_model]);
    for (const m of models) if (m && !await registry.getModel('shared', m)) await registry.upsertModel({ provider_key: 'shared', model_key: m, type: 'chat', supports: { json: true, vision: true } }, { actor: 'seed' });
    if (!await registry.getModel('stub', 'stub-1')) await registry.upsertModel({ provider_key: 'stub', model_key: 'stub-1', type: 'chat', supports: { json: true, vision: true }, metadata: { synthetic: true } }, { actor: 'seed' });
    if (!await registry.getModel('whisper', 'whisper.cpp')) await registry.upsertModel({ provider_key: 'whisper', model_key: 'whisper.cpp', type: 'stt', supports: { json: false } }, { actor: 'seed' });
    const embeddingModel = env.AI_EMBEDDING_MODEL || 'text-embedding-3-small';
    if (!await registry.getModel('shared', embeddingModel)) await registry.upsertModel({ provider_key: 'shared', model_key: embeddingModel, type: 'embedding' }, { actor: 'seed' });

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
    // Speech and embeddings only admit registered models of the matching type. Until O9 adds another
    // upstream, an unavailable sole provider still answers the explicit 503.
    await registry.seedVersioned('route', 'live.stt', pool(600000, { capability: 'transcribe', constraints: { objective: 'balanced' } }));
    await registry.seedVersioned('route', 'default.chat', pool(30000, { max_output_tokens: 800 }));
    await registry.seedVersioned('route', 'default.json', pool(60000, { options: { temperature: 0.3 }, max_output_tokens: 2400, response_format: 'json' }));
    await registry.seedVersioned('route', 'default.embedding', pool(30000, { capability: 'embed', constraints: { objective: 'balanced' } }));
    // media.analyze (WS-O task 5): the local model when there is one; the paid route is used only under a media.paid budget.
    if (config.localLlm && config.localLlm.url) await registry.seedVersioned('route', 'media.local', pool(config.localLlm.timeoutMs, { capability: 'summarize', constraints: { objective: 'balanced', provider_scope: 'local' }, options: { temperature: 0.3 }, max_output_tokens: 350 }));
    await registry.seedVersioned('route', 'media.paid', pool(60000, { capability: 'summarize', constraints: { objective: 'correctness', provider_scope: 'paid', ...(authority ? { authority } : {}) }, options: { temperature: 0.3 }, max_output_tokens: 350 }));
    for (const key of HISTORICAL_ROUTES) await registry.seedVersioned('route', key, { primary: { provider: 'shared', model: null }, fallbacks: [], options: {}, max_output_tokens: null, response_format: 'json', timeout_ms: null, alias_of: 'default.json' });

    // Templates, then workflows (workflows reference templates)
    for (const t of [...live.templates, ...core.templates, ...products.templates, ...media.templates]) {
        const { key, ...def } = t;
        await registry.seedVersioned('template', key, { description: null, default_route: null, owner: 'ai', visibility: 'internal', metadata: {}, ...def });
    }
    for (const w of [...live.workflows, ...core.workflows, ...products.workflows, ...media.workflows]) {
        const { key, ...def } = w;
        await registry.seedVersioned('workflow', key, { description: null, default_route: null, cache_ttl_sec: null, metadata: {}, ...def });
    }

    // Quotas
    const seedQuota = async (q) => {
        const prev = await db.prepare("SELECT origin FROM quotas WHERE scope_type = ? AND scope_id = ? AND \"window\" = ? AND COALESCE(workflow_prefix, '') = ''").get(q.scope_type, q.scope_type === 'global' ? '*' : q.scope_id, q.window);
        if (!prev || prev.origin === 'seed') await quotas.upsert(q, { actor: 'seed', origin: 'seed' });
    };
    if (config.quotas.globalCostPerDay > 0) await seedQuota({ scope_type: 'global', window: 'day', max_cost_usd: config.quotas.globalCostPerDay });
    if (config.quotas.serviceRequestsPerMinute > 0) await seedQuota({ scope_type: 'service', scope_id: '*', window: 'minute', max_requests: config.quotas.serviceRequestsPerMinute });
    if (config.quotas.serviceRequestsPerDay > 0) await seedQuota({ scope_type: 'service', scope_id: '*', window: 'day', max_requests: config.quotas.serviceRequestsPerDay });
}

module.exports = { seed, providerRecords, HISTORICAL_ROUTES };
