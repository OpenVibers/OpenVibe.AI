'use strict';

const catalog = require('./catalog');
const { AiError, providerSecret } = require('../util');
const { guardedFetch } = require('./guarded-fetch');
const { createModelMetadata } = require('../exchange/model-metadata');
const pool = require('./pool-providers');
const number = v => v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const normal = v => String(v || '').replace(/\/+$/, '');

/** Provider-specific prices only: another reseller's price is never the cost of this provider. */
function enrichment(provider, dev, router) {
    const sourceId = provider.metadata?.models_dev_id || provider.key;
    const candidates = dev.entries.filter(e => e.provider === sourceId || (!provider.metadata?.models_dev_id && e.provider_api && normal(e.provider_api) === normal(provider.base_url)));
    const direct = new Map(candidates.sort((a, b) => Number(a.provider === sourceId) - Number(b.provider === sourceId)).map(e => [e.id, e.model]));
    const routed = new Map(router.entries.map(m => [m.id, m]));
    return id => {
        const m = direct.get(id);
        const other = routed.get(id);
        const hints = { ...other?.hints };
        if (m) {
            if (m.limit?.context) hints.contextWindow = m.limit.context;
            if (m.limit?.output) hints.maxOutput = m.limit.output;
            if (Array.isArray(m.modalities?.input)) hints.vision = m.modalities.input.includes('image');
            if (typeof m.tool_call === 'boolean') hints.tools = m.tool_call;
            if (typeof m.reasoning === 'boolean') hints.reasoning = m.reasoning;
        }
        const cost = m && !dev.stale && m.cost ? {
            in_per_mtok: number(m.cost.input), out_per_mtok: number(m.cost.output), cached_per_mtok: number(m.cost.cache_read),
            source: dev.source, verified_at: dev.checked_at?.slice(0, 10),
        } : provider.key === 'openrouter' && !router.stale && other?.cost ? { ...other.cost, source: router.source, verified_at: router.checked_at?.slice(0, 10) } : null;
        return { hints, cost, source: m ? dev.source : other ? router.source : null, checked_at: m ? dev.checked_at : router.checked_at };
    };
}

function createModelSync({ db, registry, env = process.env, fetchImpl = globalThis.fetch, clock = { now: Date.now }, log = console, metadata = null, routerMetadata = null }) {
    const now = () => clock.now();
    const source = metadata || createModelMetadata({ db, fetchImpl, now, log });
    const routerSource = routerMetadata || createModelMetadata({ db, fetchImpl, now, log, sourceId: 'openrouter',
        sourceUrl: pool.byKey.get('openrouter').models_endpoint,
        index: data => Array.isArray(data.data) ? data.data.map(catalog.remoteModel) : [],
    });
    const active = new Map();
    let timer = null;
    let ticking = false;
    let stopped = false;
    const iso = () => new Date(now()).toISOString();
    const read = provider => db.prepare(`SELECT * FROM provider_model_syncs ${provider ? 'WHERE provider_key = ?' : ''} ORDER BY id DESC LIMIT 50`).all(...(provider ? [provider] : []));

    function run(key, { actor = 'system', trigger = 'manual' } = {}) {
        if (stopped) throw new AiError(503, 'ai.unavailable', 'model sync is stopping');
        if (active.has(key)) throw new AiError(409, 'provider.sync_running', 'a model sync is already running');
        const task = (async () => {
            const provider = await registry.getProvider(key);
            if (!provider) throw new AiError(404, 'ai.not_found', 'no such provider');
            const row = await db.prepare("INSERT INTO provider_model_syncs (provider_key, trigger_kind, actor, status, started_at) VALUES (?, ?, ?, 'running', ?) RETURNING id")
                .get(key, trigger, actor, iso());
            try {
                if (!provider.metadata?.models_endpoint && !['openai', 'anthropic', 'responses', 'gemini'].includes(provider.kind)) throw new AiError(422, 'provider.catalog_unsupported', 'this provider has no model list');
                const apiKey = providerSecret(provider, env);
                if (provider.auth_mode !== 'none' && !apiKey && !provider.metadata?.models_public) throw new AiError(409, 'provider.no_credentials', 'set a key before reading the model list');
                const [dev, router] = await Promise.all([source.read(), provider.key === 'openrouter' ? Promise.resolve({ entries: [], stale: true }) : routerSource.read()]);
                const result = await catalog.sync({ registry, provider, apiKey, actor, now, enrich: enrichment(provider, dev, router),
                    fetchImpl: fetchImpl === globalThis.fetch ? guardedFetch : fetchImpl });
                await db.prepare("UPDATE provider_model_syncs SET status = 'succeeded', finished_at = ?, added = ?, updated = ?, missing = ? WHERE id = ?")
                    .run(iso(), result.added.length, result.updated.length, result.missing.length, row.id);
                return { id: row.id, provider: key, ...result };
            } catch (err) {
                const safe = ['provider.auth', 'provider.http', 'provider.unreachable', 'provider.timeout', 'provider.catalog_invalid', 'provider.catalog_unsupported', 'provider.config', 'provider.no_credentials'].includes(err.code) ? err.code : 'provider.sync_failed';
                await db.prepare("UPDATE provider_model_syncs SET status = 'failed', finished_at = ?, error_code = ? WHERE id = ?").run(iso(), safe, row.id);
                throw new AiError(err.status >= 400 && err.status < 600 ? err.status : 502, safe, 'model sync failed; see the sync log');
            }
        })().finally(() => active.delete(key));
        active.set(key, task);
        return task;
    }

    async function tick() {
        if (ticking || stopped) return;
        ticking = true;
        try {
            for (const provider of await registry.listProviders()) {
                if (stopped) break;
                const minutes = Number(provider.metadata?.model_sync_interval_minutes || 0);
                if (provider.status !== 'active' || ![60, 360, 1440].includes(minutes) || active.has(provider.key)) continue;
                const last = (await read(provider.key))[0];
                if (last && now() - Date.parse(last.started_at) < minutes * 60_000) continue;
                await run(provider.key, { trigger: 'scheduled', actor: 'service:ai' }).catch(() => {});
            }
        } finally { ticking = false; }
    }
    return { run, read, tick,
        start() { if (!timer) { timer = setInterval(() => tick().catch(() => log.warn('model sync schedule failed')), 60_000); timer.unref?.(); } },
        async stop() { stopped = true; clearInterval(timer); timer = null; await Promise.allSettled([...active.values()]); },
    };
}

module.exports = { createModelSync, enrichment };
