'use strict';
/**
 * OpenVibe.AI configuration. Everything comes from the environment (.env in development,
 * /etc/openvibe/ai.env in production); .env.example documents the list.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 *
 * Provider settings keep the names OpenVibe.Live used for them (its admin site settings
 * ai_provider / ai_base_url / ai_api_key / ai_model / ai_pricing_json /
 * ai_max_cost_usd_per_day, upper-cased here) and Live's own environment names for whisper.cpp
 * (WHISPER_*), so the same keys work on both sides of the move. Secrets are only ever read by
 * NAME through secretRef(); nothing here logs or returns a value.
 */

const { loadGovern } = require('./govern');

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
    let pricing = {};
    if (env.AI_PRICING_JSON) {
        try { pricing = JSON.parse(env.AI_PRICING_JSON) || {}; } catch { throw new Error('AI_PRICING_JSON is not valid JSON'); }
    }
    const baseUrl = trimUrl(env.BASE_URL || (isProduction ? 'https://ai.openvibe.services' : `http://localhost:${port}`));
    return {
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        // Browser reads of the public stats and release endpoints only. Values are exact origins;
        // CORS never allows credentials, and token/console routes do not use this list.
        cors: { origins: list(env.AI_CORS_ORIGINS, ['https://ai.openvibe.services', 'https://openvibe.services']) },

        // Identity: OpenVibe.Network signs the service tokens callers present (audience openvibe.ai).
        networkUrl: trimUrl(env.OV_NETWORK_URL || 'https://openvibe.network'),
        networkInternalUrl: trimUrl(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        // The JWKS the SDK's client fetches (one client per URL): the internal URL unless OV_NETWORK_JWKS_URL says otherwise.
        networkJwksUrl: `${trimUrl(env.OV_NETWORK_JWKS_URL || env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000')}/api/.well-known/jwks`,
        issuer: trimUrl(env.OV_NETWORK_ISSUER || env.OV_NETWORK_URL || 'https://openvibe.network'),
        // A person's own provider keys (server/credentials.js): AES-256-GCM, 64 hex characters; unset = credentials off.
        credentialsKey: String(env.AI_CREDENTIALS_KEY || '').trim(),
        // Test-on-save for a person's own key (L36 Y1): a model list, else one token, within this budget. Ten seconds in
        // production; a test may shorten it.
        credentialTestTimeoutMs: Math.max(50, Math.min(60000, int(env.AI_CREDENTIAL_TEST_TIMEOUT_MS, 10000))),
        // The person's memory (server/memory/): AES-256-GCM with a key of its own, so it can rotate apart from credentials.
        memoryKey: String(env.AI_MEMORY_KEY || '').trim(),
        // The store's own maintenance (server/memory/jobs.js): owner by owner, with a per-run cap. Off in test mode
        // (the way the JWKS client is) and off while a provider is in a drill, so a drill never spends the budget.
        memoryJobs: {
            enabled: bool(env.AI_MEMORY_JOBS, nodeEnv !== 'test'),
            intervalMs: int(env.AI_MEMORY_JOB_INTERVAL_MS, 15 * 60 * 1000),
            maxOwners: int(env.AI_MEMORY_JOB_MAX_OWNERS, 10),
            maxScopesPerOwner: int(env.AI_MEMORY_JOB_MAX_SCOPES, 4),
            maxEmbeddings: int(env.AI_MEMORY_JOB_MAX_EMBEDDINGS, 100),
            maxModelCalls: int(env.AI_MEMORY_JOB_MAX_MODEL_CALLS, 20),
            maxProfiles: int(env.AI_MEMORY_JOB_MAX_PROFILES, 10),
        },
        networkPublicKey: env.OV_NETWORK_PUBLIC_KEY ? env.OV_NETWORK_PUBLIC_KEY.replace(/\\n/g, '\n') : null,
        audience: 'openvibe.ai',

        // ── OpenVibe.Events → AI (server/bench/events.js): AI subscribes to bench.rating.changed at boot.
        // The secret verifies the signed delivery (v2); unset turns POST /internal/events off. EVENTS_URL
        // is the shared producer/consumer address, AI_EVENTS_URL overrides it. AI_EVENTS_SUBSCRIBE=0 (or no
        // secret) leaves subscription creation to the operator/script; the endpoint is this service's loopback.
        events: {
            url: trimUrl(env.AI_EVENTS_URL || env.EVENTS_URL),
            secrets: list(env.AI_EVENTS_SECRET || env.AI_BENCH_EVENTS_SECRET || env.EVENTS_SECRET, []),
            endpoint: String(env.AI_EVENTS_ENDPOINT || '').trim(),
            subscribe: bool(env.AI_EVENTS_SUBSCRIBE, true),
        },
        // Where AI reads board detail a sparse bench.rating.changed leaves out (cost per solved, intervals).
        bench: {
            url: trimUrl(env.AI_BENCH_URL || env.OV_BENCH_INTERNAL_URL || env.OV_BENCH_URL || env.BENCH_URL || 'http://127.0.0.1:5230'),
            timeoutMs: int(env.AI_BENCH_TIMEOUT_MS, 15000),
        },

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
            // A person's session for their run receipt (GET /runs/:id): a longer, read-only session.
            personSessionTtlMin: Math.max(5, Math.min(7 * 24 * 60, int(env.AI_PERSON_SESSION_TTL_MIN, 24 * 60))),
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
            timeoutMs: int(env.AI_PROVIDER_TIMEOUT_MS, 30000),
        },
        // ── Placement (T6 provider router): openvibe-sdk/placement orders a route's capability pool ──
        placement: {
            // A candidate replaces the route's current placement only when it scores this much better,
            // so a small price/latency wobble does not make the router oscillate.
            minGain: Math.max(0, Math.min(1, float(env.AI_PLACEMENT_MIN_GAIN, 0.15))),
            costWeight: float(env.AI_PLACEMENT_COST_WEIGHT, 0.5),
            latencyWeight: float(env.AI_PLACEMENT_LATENCY_WEIGHT, 0.5),
        },
        // Configurable local HTTP seam: POST {operation, request} JSON to this URL.
        httpSeamUrl: trimUrl(env.AI_HTTP_SEAM_URL),
        // A local model server speaking the OpenAI API (llama.cpp's llama-server, Ollama's /v1): the provider `local`,
        // route media.local (roadmap WS-O task 5). No key; never a paid provider. embedModel (an embedding GGUF the
        // server serves at /embeddings) makes `local` a member of the default.embedding pool. llama.cpp serves one
        // model per process, so embedUrl may name a second local server; it defaults to the chat model's URL.
        localLlm: {
            url: trimUrl(env.AI_LOCAL_LLM_URL),
            embedUrl: trimUrl(env.AI_LOCAL_EMBED_URL) || trimUrl(env.AI_LOCAL_LLM_URL),
            model: String(env.AI_LOCAL_LLM_MODEL || '').trim(),
            embedModel: String(env.AI_LOCAL_EMBED_MODEL || '').trim(),
            timeoutMs: int(env.AI_LOCAL_LLM_TIMEOUT_MS, 180000),
        },
        // Image generation (POST /api/v1/image, workflow ai.image): off until AI_IMAGE_MODEL names the shared
        // provider's image model (dall-e-3, gpt-image-1); then boot seeds that model and route default.image.
        image: { model: String(env.AI_IMAGE_MODEL || '').trim(), size: String(env.AI_IMAGE_SIZE || '').trim() || '1024x1024' },
        // MegaSource (server/research/, workflow research.gather): web search asks the Search Fabric's web scope
        // first (OpenVibe.Search POST /api/v1/query, capability search.fabric.query) as AI's service principal;
        // DeepSeek's paid search stays as the fallback when the fabric is off, refuses or answers nothing. The
        // service token needs Search's viewer capability search.query.delegate (Network grant: ai on
        // openvibe.search); Search's own ladder calls this service back, so that caller keeps DeepSeek directly.
        research: {
            deepseek: bool(env.AI_RESEARCH_DEEPSEEK, true),
            deepseekKeyRef: String(env.AI_RESEARCH_DEEPSEEK_KEY_REF || 'env:DEEPSEEK_API_KEY').trim(),
            deepseekUrl: trimUrl(env.AI_RESEARCH_DEEPSEEK_URL || 'https://api.deepseek.com'),
            deepseekDaily: int(env.AI_RESEARCH_DEEPSEEK_DAILY, 1500),
            timeoutMs: int(env.AI_RESEARCH_TIMEOUT_MS, 15000),
            fabric: {
                enabled: bool(env.AI_RESEARCH_SEARCH, true),
                url: trimUrl(env.OV_SEARCH_INTERNAL_URL || env.AI_RESEARCH_SEARCH_URL || 'http://127.0.0.1:4710'),
                networkUrl: trimUrl(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
                clientId: String(env.OV_OAUTH_CLIENT_ID || 'ai').trim(),
                timeoutMs: int(env.AI_RESEARCH_SEARCH_TIMEOUT_MS, 15000),
            },
        },
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
            // NVIDIA Parakeet TDT (parakeet-cli, same whisper.cpp build): on when PARAKEET_MODEL names the ggml model.
            parakeetBin: env.PARAKEET_BIN || null,
            parakeetModel: env.PARAKEET_MODEL || null,
            engine: env.ASR_ENGINE === 'whisper' ? 'whisper' : 'auto',
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
            // Object storage Media hands recordings off to (a 302 to a presigned URL), and Media's origin shield
            // edge.openvibe.media (where it sends a B2 copy's reads, through its slice cache): reachable ONLY as a
            // redirect from Media itself (its public host or the internal origin), never as a URL a caller names.
            storageHosts: list(env.AI_MEDIA_STORAGE_HOSTS, ['*.backblazeb2.com', '*.r2.cloudflarestorage.com', 'edge.openvibe.media']),
            maxBytes: int(env.AI_FETCH_MAX_BYTES, 512 * 1024 * 1024),
            maxImageBytes: int(env.AI_FETCH_MAX_IMAGE_BYTES, 12 * 1024 * 1024),
            timeoutMs: int(env.AI_FETCH_TIMEOUT_MS, 120000),
        },

        // ── Billing (plan T5 lane F): one platform.usage-sample@1 reading per accounted run, posted by
        // server/usage-samples.js to billing.usage.record (POST /api/v1/usage, audience openvibe.billing).
        // Readings are queued unless USAGE_SAMPLES=off; they are sent while OV_BILLING_INTERNAL_URL is set.
        // No `capability:` key: AI asks for billing.usage.record (named in usage-samples.js), Billing enforces it,
        // and openvibe-contracts-check reads a `capability: 'x'` literal as one this service enforces.
        billing: {
            enabled: bool(env.USAGE_SAMPLES, true),
            billingUrl: trimUrl(env.OV_BILLING_INTERNAL_URL),
            audience: 'openvibe.billing',
            intervalMs: Math.max(100, int(env.USAGE_SAMPLES_INTERVAL_MS, 2000)),
        },

        // ── A person's own machine as their model (server/machines.js; contracts 0.219.0/0.220.0): runs with a
        // credential of provider node go through OpenVibe.Bot (bot.machine.ai), on this host by default (as Actor reaches
        // it); OV_BOT_INTERNAL_URL= (empty) turns it off.
        bot: { url: trimUrl(env.OV_BOT_INTERNAL_URL != null ? env.OV_BOT_INTERNAL_URL : 'http://127.0.0.1:4630') },

        // ── Tier budgets (T6 step 8, server/govern.js): openvibe-sdk/govern in Valkey, off unless AI_GOVERN_TIERS=1.
        govern: loadGovern(env, { bool, int, num: float }),
    };
}

module.exports = { load, LIVE_ROLES };
