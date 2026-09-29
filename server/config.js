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
    const baseUrl = trimUrl(env.BASE_URL || (isProduction ? 'https://ai.openvibe.network' : `http://localhost:${port}`));
    return {
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,

        // Identity: OpenVibe.Network signs the service tokens callers present (audience openvibe.ai).
        networkUrl: trimUrl(env.OV_NETWORK_URL || 'https://openvibe.network'),
        networkInternalUrl: trimUrl(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        issuer: trimUrl(env.OV_NETWORK_ISSUER || env.OV_NETWORK_URL || 'https://openvibe.network'),
        // A person's own provider keys (server/credentials.js): AES-256-GCM, 64 hex characters; unset = credentials off.
        credentialsKey: String(env.AI_CREDENTIALS_KEY || '').trim(),
        networkPublicKey: env.OV_NETWORK_PUBLIC_KEY ? env.OV_NETWORK_PUBLIC_KEY.replace(/\\n/g, '\n') : null,
        audience: 'openvibe.ai',

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role).
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '' },

        // ── Operator console (server/console): OpenVibe.Network SSO (authorization code + PKCE S256
        // as OAuth client `ai`), for Network staff only (README "Operator console"). Both secrets are
        // references, resolved when used; the console answers 503 in production without them.
        console: {
            clientId: String(env.OV_OAUTH_CLIENT_ID || 'ai').trim(),
            clientSecretRef: 'env:OV_OAUTH_CLIENT_SECRET',
            // Signs the sign-in flow cookie and keys the client-address hashes: 32+ random characters.
            sessionSecretRef: 'env:AI_CONSOLE_SESSION_SECRET',
            sessionTtlMin: Math.max(5, Math.min(12 * 60, int(env.AI_CONSOLE_SESSION_TTL_MIN, 60))),
            redirectUri: `${baseUrl}/auth/callback`,
            // Secure (and __Host-) cookies whenever the console is served over https (always in production).
            cookieSecure: baseUrl.startsWith('https://'),
            // Audience a Network user token must carry (the Network's own is always present).
            ssoAudience: String(env.AI_SSO_AUDIENCE || 'openvibe.network').trim(),
        },

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
        // A local model server speaking the OpenAI API (llama.cpp's llama-server, Ollama's /v1): the provider `local`,
        // route media.local (roadmap WS-O task 5). No key; never a paid provider.
        localLlm: { url: trimUrl(env.AI_LOCAL_LLM_URL), model: String(env.AI_LOCAL_LLM_MODEL || '').trim(), timeoutMs: int(env.AI_LOCAL_LLM_TIMEOUT_MS, 180000) },
        // media.analyze (server/workflows/media-analysis.js): the file cap (also bounded by free disk minus a reserve),
        // the download timeout, the scene-change threshold (scdet, 0-100) and the tools.
        mediaAnalysis: {
            // On disk under the service's data directory, not os.tmpdir(): a tmpfs /tmp is memory, and a VOD is gigabytes.
            workDir: env.AI_MEDIA_ANALYSIS_DIR || 'data/media-tmp',
            maxBytes: int(env.AI_MEDIA_ANALYSIS_MAX_BYTES, 4 * 1024 * 1024 * 1024),
            reserveBytes: int(env.AI_MEDIA_ANALYSIS_DISK_RESERVE_BYTES, 3 * 1024 * 1024 * 1024),
            fetchTimeoutMs: int(env.AI_MEDIA_ANALYSIS_FETCH_TIMEOUT_MS, 20 * 60000),
            sceneThreshold: float(env.AI_MEDIA_SCENE_THRESHOLD, 10),
            // Speech-to-text in windows: each call stays well inside the whisper provider's timeout (10 min).
            sttWindowSec: Math.max(10, int(env.AI_MEDIA_STT_WINDOW_SEC, 600)),
            // Read the recording where it lies through the loopback reader (server/media-proxy.js), never downloading
            // it; AI_MEDIA_STREAM=0 downloads it first (then the disk cap applies).
            stream: bool(env.AI_MEDIA_STREAM, true),
            ffmpeg: env.FFMPEG_BIN || 'ffmpeg',
            ffprobe: env.FFPROBE_BIN || 'ffprobe',
        },
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
            // Runs waiting for a slot: past either cap a new run is refused 429 queue.full + Retry-After.
            maxQueued: Math.max(1, int(env.AI_MAX_QUEUED_RUNS, 200)),
            maxQueuedPerCaller: Math.max(1, int(env.AI_MAX_QUEUED_RUNS_PER_CALLER, 50)),
            defaultCacheTtlSec: int(env.AI_CACHE_TTL_SEC, 7 * 24 * 3600),
            maxInputBytes: int(env.AI_MAX_INPUT_BYTES, 6 * 1024 * 1024),
            retentionDays: int(env.AI_RUN_RETENTION_DAYS, 30),
        },
        // Compiled JSON Schema validators (server/schemas.js): an LRU shared by every caller, some of
        // whose schemas are caller-supplied, so it is bounded by count and by total schema size.
        schemaCache: {
            maxEntries: Math.max(1, int(env.AI_SCHEMA_CACHE_MAX, 500)),
            maxBytes: Math.max(1024, int(env.AI_SCHEMA_CACHE_MAX_BYTES, 8 * 1024 * 1024)),
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
            // Object storage Media hands recordings off to (a 302 to a presigned URL): reachable ONLY as a redirect
            // from Media itself (its public host or the internal origin), never as a URL a caller names.
            storageHosts: list(env.AI_MEDIA_STORAGE_HOSTS, ['*.backblazeb2.com', '*.r2.cloudflarestorage.com']),
            maxBytes: int(env.AI_FETCH_MAX_BYTES, 512 * 1024 * 1024),
            maxImageBytes: int(env.AI_FETCH_MAX_IMAGE_BYTES, 12 * 1024 * 1024),
            timeoutMs: int(env.AI_FETCH_TIMEOUT_MS, 120000),
        },
    };
}

module.exports = { load, LIVE_ROLES };
