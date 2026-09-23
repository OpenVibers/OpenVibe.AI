'use strict';
/**
 * OpenVibe.AI configuration. Everything comes from the environment (.env in development,
 * /etc/openvibe/ai.env in production); .env.example documents the list.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 *
 * Provider settings keep the names OpenVibe.Live used for them (its admin site settings
 * ai_provider / ai_base_url / ai_api_key / ai_model / ai_model_<role> / ai_pricing_json /
 * ai_max_cost_usd_per_day, upper-cased here) and Live's own environment names for whisper.cpp
 * (WHISPER_*), so the same keys work on both sides of the move. Secrets are only ever read by
 * NAME through secretRef(); nothing here logs or returns a value.
 */

const int = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
};
const float = (v, d) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const list = (v, d) => (v == null || v === '' ? d : String(v).split(',').map(s => s.trim()).filter(Boolean));
const trimUrl = (v) => String(v || '').trim().replace(/\/+$/, '');

/**
 * AI_NS_FALLBACK: namespaces for a service token that carries no `ns` claim, as
 * `service=ns|ns,service=ns`. A service not listed gets `<service>.*`; `none` turns the fallback off
 * (an ns-less token then runs nothing). The default covers Live, whose Network grant has no
 * namespaces: its own workflows, plus network.site_copy for its /internal/ai/site-copy fallback.
 */
const DEFAULT_NS_FALLBACK = 'live=live.*|network.site_copy';
function nsFallback(v) {
    const raw = v == null || v === '' ? DEFAULT_NS_FALLBACK : String(v).trim();
    if (/^(none|off|0|false)$/i.test(raw)) return { derive: false, fallback: {} };
    const fallback = {};
    for (const entry of raw.split(',').map(s => s.trim()).filter(Boolean)) {
        const m = /^([a-z][a-z0-9-]{1,39})\s*=\s*(.+)$/.exec(entry);
        if (!m) throw new Error(`AI_NS_FALLBACK: "${entry}" is not service=ns|ns`);
        fallback[m[1]] = m[2].split('|').map(s => s.trim()).filter(Boolean);
    }
    return { derive: true, fallback };
}

/** Roles Live's llm.js routes by (one route per role; see server/workflows/seed.js). */
const LIVE_ROLES = ['chat', 'vision', 'director', 'summary', 'legacy'];

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4700);
    const aiProvider = String(env.AI_PROVIDER || '').trim().toLowerCase();
    const aiBaseUrl = trimUrl(env.AI_BASE_URL);
    const roleModels = {};
    for (const r of LIVE_ROLES) {
        const v = env[`AI_MODEL_${r.toUpperCase()}`];
        if (v && String(v).trim()) roleModels[r] = String(v).trim();
    }
    let pricing = {};
    if (env.AI_PRICING_JSON) {
        try { pricing = JSON.parse(env.AI_PRICING_JSON) || {}; } catch { throw new Error('AI_PRICING_JSON is not valid JSON'); }
    }
    return {
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl: trimUrl(env.BASE_URL || (isProduction ? 'https://ai.openvibe.network' : `http://localhost:${port}`)),

        // Identity: OpenVibe.Network signs the service tokens callers present (audience openvibe.ai).
        networkUrl: trimUrl(env.OV_NETWORK_URL || 'https://openvibe.network'),
        networkInternalUrl: trimUrl(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        issuer: trimUrl(env.OV_NETWORK_ISSUER || env.OV_NETWORK_URL || 'https://openvibe.network'),
        networkPublicKey: env.OV_NETWORK_PUBLIC_KEY ? env.OV_NETWORK_PUBLIC_KEY.replace(/\\n/g, '\n') : null,
        audience: 'openvibe.ai',
        // Namespaces fail closed (server/auth.js): no `ns` claim, no namespaced run, except the
        // documented service fallback. AI_NS_REQUIRED=false is a rollback lever to the old open rule.
        namespaces: { required: bool(env.AI_NS_REQUIRED, true), ...nsFallback(env.AI_NS_FALLBACK) },

        dbPath: env.AI_DB_PATH || './data/ai.db',

        // ── The shared provider (Live's "shared key") ──
        // AI_ENABLED is Live's ai_enabled master switch. Unset means "on when a key or a
        // self-hosted base URL is configured".
        shared: {
            enabled: bool(env.AI_ENABLED, true),
            provider: aiProvider,                      // anthropic | openai | openrouter | groq | ollama | '' (OpenAI-shaped)
            baseUrl: aiBaseUrl,
            apiKeyRef: 'env:AI_API_KEY',               // secret reference, never the value
            model: String(env.AI_MODEL || '').trim(),
            roleModels,
            timeoutMs: int(env.AI_PROVIDER_TIMEOUT_MS, 30000),
        },
        // Optional second OpenAI-compatible provider used as the fallback of every route.
        fallback: {
            baseUrl: trimUrl(env.AI_FALLBACK_BASE_URL),
            apiKeyRef: 'env:AI_FALLBACK_API_KEY',
            model: String(env.AI_FALLBACK_MODEL || '').trim(),
            kind: String(env.AI_FALLBACK_PROVIDER || '').trim().toLowerCase(),
        },
        // Configurable local HTTP seam: POST {operation, request} JSON to this URL.
        httpSeamUrl: trimUrl(env.AI_HTTP_SEAM_URL),
        // Let routes fall back to the deterministic stub when every real provider fails.
        // Off in production: synthetic output must never stand in for a real answer there.
        stubFallback: bool(env.AI_STUB_FALLBACK, !isProduction),

        pricing: {
            table: pricing,
            inputPerMtok: float(env.AI_INPUT_COST_PER_MTOK, 3),
            outputPerMtok: float(env.AI_OUTPUT_COST_PER_MTOK, 15),
        },

        // ── Local speech-to-text (whisper.cpp), Live's names ──
        whisper: {
            bin: env.WHISPER_BIN || null,
            model: env.WHISPER_MODEL || null,
            modelLive: env.WHISPER_MODEL_LIVE || null,
            modelMulti: env.WHISPER_MODEL_MULTI || null,
            vadModel: env.WHISPER_VAD_MODEL || null,
            vad: env.WHISPER_VAD !== '0',
            threads: Math.max(2, Math.min(8, int(env.WHISPER_THREADS, 4))),
            beam: Math.max(1, Math.min(8, int(env.WHISPER_BEAM, 1))),
            maxConcurrent: Math.max(1, int(env.WHISPER_MAX_CONCURRENT, 1)),
        },

        // ── Quotas seeded at boot (admin API edits them afterwards) ──
        quotas: {
            // Live's ai_max_cost_usd_per_day: one global daily spend cap across every caller.
            globalCostPerDay: float(env.AI_MAX_COST_USD_PER_DAY, 0),
            serviceRequestsPerMinute: int(env.AI_QUOTA_SERVICE_RPM, 600),
            serviceRequestsPerDay: int(env.AI_QUOTA_SERVICE_RPD, 50000),
        },

        // ── Runs ──
        runs: {
            maxWaitMs: int(env.AI_MAX_WAIT_MS, 60000),
            maxConcurrent: Math.max(1, int(env.AI_MAX_CONCURRENT_RUNS, 4)),
            defaultCacheTtlSec: int(env.AI_CACHE_TTL_SEC, 7 * 24 * 3600),
            maxInputBytes: int(env.AI_MAX_INPUT_BYTES, 6 * 1024 * 1024),
            retentionDays: int(env.AI_RUN_RETENTION_DAYS, 30),
        },
        // Raw prompt/response logging is opt-in debugging only, and only for callers that ask.
        debugRawLog: bool(env.AI_DEBUG_RAW_LOG, false),

        // ── Circuit breaker ──
        breaker: {
            failureThreshold: Math.max(1, int(env.AI_BREAKER_FAILURES, 3)),
            cooldownMs: int(env.AI_BREAKER_COOLDOWN_MS, 60000),
        },
        // One retry on a transient failure (timeout, 429, 5xx, connection reset) before the
        // router moves on to the fallback — Live's rule.
        providerRetries: Math.max(0, int(env.AI_PROVIDER_RETRIES, 1)),
        retryDelayMs: Math.max(0, int(env.AI_PROVIDER_RETRY_DELAY_MS, 800)),

        // ── Media inputs: only these hosts are ever fetched (SSRF guard) ──
        media: {
            publicUrl: trimUrl(env.OV_MEDIA_URL || 'https://openvibe.media'),
            internalUrl: trimUrl(env.OV_MEDIA_INTERNAL_URL || ''),
            // https hostnames (exact, or *.suffix) that media/image URLs may point at.
            allowHosts: list(env.AI_FETCH_ALLOW_HOSTS, ['openvibe.media', 'openvibe.live', 'openvibe.network', '*.openvibe.network', 'openvibe.community', 'openvibe.tools', 'openvibe.games']),
            maxBytes: int(env.AI_FETCH_MAX_BYTES, 512 * 1024 * 1024),
            maxImageBytes: int(env.AI_FETCH_MAX_IMAGE_BYTES, 12 * 1024 * 1024),
            timeoutMs: int(env.AI_FETCH_TIMEOUT_MS, 120000),
        },
    };
}

module.exports = { load, LIVE_ROLES };
