'use strict';
/**
 * Provider pool and router.
 *
 *   pool.adapter(key)          the adapter for a provider record (rebuilt when the record changes)
 *   pool.health(key)           circuit-breaker state
 *   pool.execute(route, op, req, ctx)
 *        tries the route's primary, then each fallback, skipping candidates that are disabled,
 *        circuit-open, missing credentials or that do not support the operation; applies a strict
 *        timeout and cancellation to every call and one retry on a transient failure; records one
 *        request-log row per attempt or skip (fallback = 1 for every non-primary candidate) and
 *        returns { result, provider, model, fallbackUsed }. When nothing answers it throws
 *        AiError 503 provider.unavailable — an explicit state, never a made-up answer.
 *
 * Circuit breaker per provider: `failureThreshold` consecutive failures open it for `cooldownMs`;
 * after that one half-open probe decides whether it closes again.
 */
const { AiError, resolveSecret, sha256 } = require('../util');
const { retryable, sleep, ProviderError } = require('./common');
const { createStubProvider } = require('./stub');
const { createOpenAiProvider } = require('./openai');
const { createAnthropicProvider } = require('./anthropic');
const { createHttpSeamProvider } = require('./http');
const { createWhisperProvider } = require('./whisper');

function createProviderPool({ db, registry, config, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, env = process.env, log = console }) {
    const cache = new Map();          // key -> { stamp, adapter }
    const stats = {};                 // key -> { calls, failures, ... } (in memory; tests + /api/ready)

    function statFor(key) { return stats[key] || (stats[key] = { calls: 0, ok: 0, failures: 0, skipped: 0 }); }

    function build(p) {
        const apiKey = resolveSecret(p.secret_ref, env);
        switch (p.kind) {
            case 'stub': return createStubProvider(p, { stats: statFor(p.key) });
            case 'openai': return createOpenAiProvider(p, { apiKey, fetchImpl });
            case 'anthropic': return createAnthropicProvider(p, { apiKey, fetchImpl });
            case 'http': return createHttpSeamProvider(p, { apiKey, fetchImpl });
            case 'whisper': return createWhisperProvider(p, { config });
            default: throw new Error(`unknown provider kind ${p.kind}`);
        }
    }

    function adapter(key) {
        const p = registry.getProvider(key);
        if (!p) return null;
        const stamp = `${p.updated_at}|${p.secret_ref}|${resolveSecret(p.secret_ref, env) ? 1 : 0}`;
        const hit = cache.get(key);
        if (hit && hit.stamp === stamp) return { record: p, adapter: hit.adapter };
        const a = build(p);
        cache.set(key, { stamp, adapter: a });
        return { record: p, adapter: a };
    }

    // ── Circuit breaker ────────────────────────────────────
    const getHealth = db.prepare('SELECT * FROM provider_health WHERE provider_key = ?');
    const putHealth = db.prepare(`INSERT INTO provider_health (provider_key, state, consecutive_failures, opened_at, last_error, last_success_at, last_failure_at)
        VALUES (@provider_key, @state, @consecutive_failures, @opened_at, @last_error, @last_success_at, @last_failure_at)
        ON CONFLICT(provider_key) DO UPDATE SET state = excluded.state, consecutive_failures = excluded.consecutive_failures, opened_at = excluded.opened_at,
          last_error = excluded.last_error, last_success_at = excluded.last_success_at, last_failure_at = excluded.last_failure_at`);
    function health(key) {
        const h = getHealth.get(key) || { provider_key: key, state: 'closed', consecutive_failures: 0, opened_at: null, last_error: null, last_success_at: null, last_failure_at: null };
        if (h.state === 'open' && clock.now() - (h.opened_at || 0) >= config.breaker.cooldownMs) return { ...h, state: 'half_open' };
        return h;
    }
    function recordSuccess(key) {
        const h = health(key);
        if (h.state !== 'closed') registry.audit('system', 'provider.circuit_closed', 'provider', key, { metadata: { after_failures: h.consecutive_failures } });
        putHealth.run({ ...h, provider_key: key, state: 'closed', consecutive_failures: 0, opened_at: null, last_success_at: clock.now() });
    }
    function recordFailure(key, err) {
        const h = health(key);
        const failures = (h.consecutive_failures || 0) + 1;
        const open = h.state === 'half_open' || failures >= config.breaker.failureThreshold;
        if (open && h.state !== 'open') registry.audit('system', 'provider.circuit_opened', 'provider', key, { metadata: { failures, error: String(err && err.message || err).slice(0, 200) } });
        putHealth.run({ ...h, provider_key: key, state: open ? 'open' : 'closed', consecutive_failures: failures, opened_at: open ? clock.now() : h.opened_at, last_error: String(err && err.message || err).slice(0, 500), last_failure_at: clock.now() });
    }
    function resetHealth(key) { db.prepare('DELETE FROM provider_health WHERE provider_key = ?').run(key); }

    // ── Pricing (Live's rules: model row -> AI_PRICING_JSON longest prefix -> flat rates) ──
    function priceFor(providerKey, model) {
        const p = registry.getProvider(providerKey);
        if (!p || p.kind === 'stub' || p.kind === 'whisper') return { in: 0, out: 0, cached: 0 };
        const row = model ? registry.getModel(providerKey, model) : null;
        if (row && row.cost && Number.isFinite(row.cost.in_per_mtok) && row.cost.in_per_mtok !== null) {
            const inRate = Number(row.cost.in_per_mtok);
            return { in: inRate, out: Number(row.cost.out_per_mtok) || 0, cached: row.cost.cached_per_mtok != null ? Number(row.cost.cached_per_mtok) : inRate * 0.1 };
        }
        const table = config.pricing.table || {};
        const m = String(model || '').toLowerCase();
        let best = null; let bestLen = -1;
        for (const [k, v] of Object.entries(table)) {
            const key = String(k).toLowerCase();
            if (key === 'default') continue;
            if (m.startsWith(key) && key.length > bestLen && v && typeof v === 'object') { best = v; bestLen = key.length; }
        }
        if (!best && table.default && typeof table.default === 'object') best = table.default;
        const inRate = best && Number.isFinite(Number(best.in)) ? Number(best.in) : config.pricing.inputPerMtok;
        const outRate = best && Number.isFinite(Number(best.out)) ? Number(best.out) : config.pricing.outputPerMtok;
        const cachedRate = best && Number.isFinite(Number(best.cached)) ? Number(best.cached) : inRate * 0.1;
        return { in: inRate, out: outRate, cached: cachedRate };
    }
    function costOf(providerKey, model, usage) {
        const pr = priceFor(providerKey, model);
        const input = Math.max(0, (usage.input || 0) - (usage.cached || 0));
        return (input / 1e6) * pr.in + ((usage.cached || 0) / 1e6) * pr.cached + ((usage.output || 0) / 1e6) * pr.out;
    }

    // ── Routing ────────────────────────────────────────────
    function candidates(route) {
        const list = [route.primary, ...(route.fallbacks || [])].filter(c => c && c.provider);
        if (config.stubFallback && !list.some(c => c.provider === 'stub') && registry.getProvider('stub')) list.push({ provider: 'stub', model: null, auto: true });
        return list;
    }

    function skipReason(p, a, features) {
        if (!p || !a) return 'unknown_provider';
        if (p.status !== 'active') return 'disabled';
        if (p.auth_mode !== 'none' && !resolveSecret(p.secret_ref, env)) return 'no_credentials';
        if (features.some(f => !a.supports(f))) return 'unsupported';
        if (health(p.key).state === 'open') return 'circuit_open';
        return null;
    }

    /**
     * ctx: { runId, routeKey, routeVersion, signal, logRequest(entry), debugRaw }
     * req: canonical request (system, messages, image, json, maxTokens, temperature, cacheKey, input, filePath, ...)
     */
    async function execute(route, operation, req, ctx = {}) {
        const features = [operation];
        if (req.image) features.push('vision');
        if (req.json) features.push('json');
        const tried = [];
        const list = candidates(route);
        for (let i = 0; i < list.length; i++) {
            const c = list[i];
            const entry = adapter(c.provider);
            const p = entry && entry.record;
            const a = entry && entry.adapter;
            const model = c.model || (p && p.default_model) || null;
            const fallback = i > 0;
            const base = { operation, provider_key: c.provider, model_key: model, route_key: ctx.routeKey || null, route_version: ctx.routeVersion || null, fallback: fallback ? 1 : 0, prompt_hash: ctx.promptHash || null, input_hash: ctx.inputHash || null };
            const why = skipReason(p, a, features);
            if (why) {
                statFor(c.provider).skipped++;
                tried.push({ provider: c.provider, skipped: why });
                if (ctx.logRequest) ctx.logRequest({ ...base, status: 'skipped', skip_reason: why });
                continue;
            }
            const timeoutMs = Math.max(1000, Math.min(req.timeoutMs || route.timeout_ms || p.timeout_ms || 30000, p.timeout_ms || 600000));
            const retries = config.providerRetries;
            let lastErr = null;
            for (let attempt = 0; attempt <= retries; attempt++) {
                if (ctx.signal && ctx.signal.aborted) throw new AiError(409, 'run.cancelled', 'run was cancelled');
                const started = clock.now();
                const t0 = Date.now();
                try {
                    const fn = a[operation];
                    if (typeof fn !== 'function') throw new ProviderError(`${operation} not implemented`, { code: 'provider.unsupported' });
                    statFor(c.provider).calls += p.kind === 'stub' ? 0 : 1;   // stub counts its own calls
                    const result = await fn({ ...req, model, signal: ctx.signal, timeoutMs });
                    const latency = Date.now() - t0;
                    const usage = result.usage || { input: 0, output: 0, cached: 0 };
                    const cost = costOf(c.provider, result.model || model, usage);
                    statFor(c.provider).ok++;
                    recordSuccess(c.provider);
                    if (ctx.logRequest) {
                        ctx.logRequest({
                            ...base, model_key: result.model || model, status: 'ok', output_hash: sha256(result.json || result.text || result.vectors || result.segments || ''),
                            tokens_in: usage.input || 0, tokens_out: usage.output || 0, tokens_cached: usage.cached || 0, tokens_estimated: usage.estimated ? 1 : 0,
                            cost_usd: cost, latency_ms: latency,
                            debug_prompt: ctx.debugRaw ? JSON.stringify({ system: req.system, messages: req.messages }).slice(0, 200000) : null,
                            debug_response: ctx.debugRaw ? String(result.text || '').slice(0, 200000) : null,
                        });
                    }
                    return { result, provider: c.provider, providerKind: p.kind, model: result.model || model, fallbackUsed: fallback, usage, cost, latencyMs: latency, synthetic: Boolean(result.synthetic || a.synthetic), tried, startedAt: started };
                } catch (err) {
                    lastErr = err;
                    if (ctx.signal && ctx.signal.aborted) {
                        if (ctx.logRequest) ctx.logRequest({ ...base, status: 'cancelled', latency_ms: Date.now() - t0, error: 'cancelled' });
                        throw new AiError(409, 'run.cancelled', 'run was cancelled');
                    }
                    statFor(c.provider).failures++;
                    if (ctx.logRequest) ctx.logRequest({ ...base, status: err && err.code === 'provider.timeout' ? 'timeout' : 'error', latency_ms: Date.now() - t0, error: String(err && err.message || err).slice(0, 500) });
                    if (attempt < retries && retryable(err)) { await sleep(config.retryDelayMs + Math.floor(Math.random() * Math.min(700, config.retryDelayMs)), ctx.signal).catch(() => {}); continue; }
                    break;
                }
            }
            recordFailure(c.provider, lastErr);
            tried.push({ provider: c.provider, error: String(lastErr && lastErr.message || lastErr).slice(0, 200) });
            log.warn(`[ai] ${operation} via ${c.provider}/${model || '-'} failed: ${lastErr && lastErr.message}`);
        }
        throw new AiError(503, 'provider.unavailable', 'no provider on this route could answer', { tried });
    }

    return { adapter, health, resetHealth, execute, priceFor, costOf, stats, statFor, candidates };
}

module.exports = { createProviderPool };
