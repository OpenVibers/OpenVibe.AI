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

const path = require('path');
const { loadGovern } = require('./govern');
const { DEFAULT_PROVIDERS: DEFAULT_FREE_PROVIDERS } = require('./free-tier');

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
        // The human pages that used to live here are OpenVibe.Exchange now (2026-11-07). This is where a
        // browser is sent, page by page; the API, a run's receipt and the operator console stay here.
        exchangeUrl: trimUrl(env.OV_EXCHANGE_URL || 'https://openvibe.exchange'),
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
        // The AI ledger (L40): the fee the OpenVibe key carries, and the roll-up job (off in test mode, off while a
        // provider is in a drill).
        usage: {
            feeRate: Number(env.AI_KEY_FEE_RATE || 0) || 0,
        },
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
        // ── DeepSeek, its own provider when its key is configured ──
        // DEEPSEEK_API_KEY is also the research fallback's key; this makes its chat models managed offers.
        deepseek: {
            enabled: bool(env.AI_DEEPSEEK_ENABLED, true),
            baseUrl: trimUrl(env.AI_DEEPSEEK_BASE_URL || 'https://api.deepseek.com'),
            apiKeyRef: String(env.AI_DEEPSEEK_KEY_REF || 'env:DEEPSEEK_API_KEY').trim(),
            timeoutMs: int(env.AI_DEEPSEEK_TIMEOUT_MS, 90000),
        },
        // ── Spend safety for runs nobody pays for (the free allowance, the anonymous Try it) ──
        // A run with no person's own token, no app project, no service run-token budget and no own key may
        // use only offers from these sources (provider keys; `local` is every local model server and
        // `community` the community machines) AND at or below this output price (USD per 1M tokens). Anything
        // else needs the person's own Balance or their own key; the router answers 402 billing.payer_required.
        freeUse: {
            providers: list(env.AI_FREE_PROVIDERS, DEFAULT_FREE_PROVIDERS),
            maxOutputPricePerMtok: Math.max(0, float(env.AI_FREE_MAX_OUTPUT_PRICE_USD_PER_MTOK, 1.5)),
        },
        // ── Plan E5: abuse prevention for the free tier (server/abuse/) ──
        // A signed HttpOnly device id (set by the AI Exchange API host for openvibe.exchange), the local
        // iptoasn.com table (scripts/update-ip2asn.js; never a paid API), the daily allowance the trust tiers
        // scale, and the anomaly limits. Network signals are read from Network's identity route and cached.
        abuse: {
            enabled: bool(env.AI_ABUSE, true),
            // The full (verified) daily allowance in free tokens: input + output. Zero switches the free allowance off.
            dailyTokens: Math.max(0, int(env.AI_FREE_DAILY_TOKENS, 20000)),
            // Network's trust signals (server/abuse/network.js). Off in tests unless a test opts in.
            network: bool(env.AI_ABUSE_NETWORK, nodeEnv !== 'test'),
            signalsTtlMs: Math.max(1000, int(env.AI_ABUSE_SIGNALS_TTL_MS, 300000)),
            signalsMissTtlMs: Math.max(1000, int(env.AI_ABUSE_SIGNALS_MISS_TTL_MS, 60000)),
            signalsTimeoutMs: Math.max(100, int(env.AI_ABUSE_SIGNALS_TIMEOUT_MS, 2000)),
            // The HMAC key for the device cookie and every salted hash. Unset: a per-boot key (device cookies do not
            // survive a restart, and the hashes cannot be linked across boots). Set it in production.
            salt: String(env.AI_ABUSE_SALT || '').trim(),
            // Only a service token naming one of these ids may forward the client address (x-ov-client-ip) or a
            // signed device id (x-ov-device-id). The Exchange is the first-party caller that does.
            firstPartyServices: list(env.AI_FIRST_PARTY_SERVICES, ['exchange']),
            deviceCookieName: String(env.AI_DEVICE_COOKIE_NAME || 'ovai_device').trim(),
            // openvibe.exchange: the API host sets the cookie for the parent domain, so the site and the API share it.
            deviceCookieDomain: String(env.AI_DEVICE_COOKIE_DOMAIN || '').trim(),
            deviceCookieSecure: bool(env.AI_DEVICE_COOKIE_SECURE, baseUrl.startsWith('https://')),
            deviceCookieSameSite: String(env.AI_DEVICE_COOKIE_SAMESITE || 'Lax').trim(),
            ip2asnV4: String(env.AI_IP2ASN_V4 || path.join(__dirname, '..', 'data', 'ip2asn', 'ip2asn-v4.tsv')).trim(),
            ip2asnV6: String(env.AI_IP2ASN_V6 || path.join(__dirname, '..', 'data', 'ip2asn', 'ip2asn-v6.tsv')).trim(),
            // ASNs an operator knows are hosting ones, on top of the organisation-name match (server/abuse/asn.js).
            hostingAsns: list(env.AI_HOSTING_ASNS, []),
            ratePerMin: Math.max(1, int(env.AI_ABUSE_RATE_PER_MIN, 60)),
            hostingRatePerMin: Math.max(1, int(env.AI_ABUSE_HOSTING_RATE_PER_MIN, 20)),
            // Anomaly: free tokens in a minute against the last week's per-minute baseline, per ASN, device and input.
            velocityFactor: Math.max(1, float(env.AI_ABUSE_VELOCITY_FACTOR, 10)),
            velocityMinTokensPerMin: Math.max(1, int(env.AI_ABUSE_VELOCITY_MIN_TOKENS_PER_MIN, 10000)),
            // Proof of work for the anonymous Try it (no account). Required in production; a test opts in.
            powRequired: bool(env.AI_POW_REQUIRED, nodeEnv !== 'test'),
            powBits: Math.max(8, Math.min(28, int(env.AI_POW_BITS, 18))),
            powTtlMs: Math.max(30000, int(env.AI_POW_TTL_MS, 300000)),
            powChallengesPerMinute: Math.max(1, int(env.AI_POW_CHALLENGES_PER_MIN, 10)),
        },

        // ── Placement (T6 provider router): openvibe-sdk/placement orders a route's capability pool ──
        placement: {
            // A candidate replaces the route's current placement only when it scores this much better,
            // so a small price/latency wobble does not make the router oscillate.
            minGain: Math.max(0, Math.min(1, float(env.AI_PLACEMENT_MIN_GAIN, 0.15))),
            costWeight: float(env.AI_PLACEMENT_COST_WEIGHT, 0.5),
            latencyWeight: float(env.AI_PLACEMENT_LATENCY_WEIGHT, 0.5),
        },
        // L36 Y7: the task-aware router's fallback chain tries at most this many providers.
        routing: {
            maxAttempts: Math.max(1, int(env.AI_ROUTING_MAX_ATTEMPTS, 3)),
        },
        // AI Exchange P7 (PLAN §D/§E): alias routes ranked by measured evidence. Off by default; with the flag
        // off nothing is written and no order changes. The EWMA alpha, the minimum sample count below which
        // evidence is sparse (and reported, never trusted), the probability floor, the decisions a challenger
        // must win, and the exploration share (0 = never leave the incumbent).
        routingEvidence: {
            enabled: bool(env.AI_ROUTING_EVIDENCE, false),
            alpha: Math.max(0.01, Math.min(1, float(env.AI_ROUTING_EVIDENCE_ALPHA, 0.2))),
            minSamples: Math.max(1, int(env.AI_ROUTING_EVIDENCE_MIN_SAMPLES, 20)),
            successFloor: Math.max(0.01, Math.min(1, float(env.AI_ROUTING_EVIDENCE_SUCCESS_FLOOR, 0.1))),
            prior: Math.max(0.01, Math.min(1, float(env.AI_ROUTING_EVIDENCE_PRIOR, 0.9))),
            hysteresisDecisions: Math.max(1, int(env.AI_ROUTING_EVIDENCE_DECISIONS, 3)),
            explorationShare: Math.max(0, Math.min(1, float(env.AI_ROUTING_EVIDENCE_EXPLORE, 0))),
            affinityGain: Math.max(0, Math.min(1, float(env.AI_ROUTING_EVIDENCE_AFFINITY, 0.05))),
            minGain: Math.max(0, Math.min(1, float(env.AI_ROUTING_EVIDENCE_MIN_GAIN, 0.15))),
            expectedOutputTokens: Math.max(1, int(env.AI_ROUTING_EVIDENCE_OUTPUT_TOKENS, 512)),
        },
        // AI Exchange P4 (CHECKPOINT D3): the truthful model catalog, exact ids and dynamic aliases. Off by
        // default: today's /v1 behaviour, the single `openvibe` model and no disclosure object, is unchanged.
        modelCatalog: {
            enabled: bool(env.AI_MODEL_CATALOG, false),
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
            // Never let the local model starve the host: one generation at a time across every local provider,
            // and a short answer unless a route already asked for less (server/providers/index.js).
            maxTokens: Math.max(1, int(env.AI_LOCAL_LLM_MAX_TOKENS, 512)),
            concurrency: Math.max(1, int(env.AI_LOCAL_LLM_CONCURRENCY, 1)),
        },
        // A second local chat server (its own llama.cpp process, another model family): the provider `local2`.
        // Same rules as `local`: no key, never paid, no JSON. Two local offers let a caller pin a match
        // between models without sending either side to a paid provider.
        localLlm2: {
            url: trimUrl(env.AI_LOCAL_LLM2_URL),
            model: String(env.AI_LOCAL_LLM2_MODEL || '').trim(),
            timeoutMs: int(env.AI_LOCAL_LLM2_TIMEOUT_MS, 180000),
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
        // Aggregate demand for Host's inference planner (GET /api/v1/usage/series): off by default;
        // the capability gate (ai.usage.read) is still required when it is on.
        usageSeries: { enabled: bool(env.AI_USAGE_SERIES, false) },
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
            // A provider that answered "insufficient balance" is out of money, not flaky: its circuit stays open this
            // long (10 minutes), shared by every request, before one probe is allowed to spend again.
            exhaustedCooldownMs: Math.max(60000, int(env.AI_BREAKER_EXHAUSTED_COOLDOWN_MS, 15 * 60000)),
        },
        // One retry on a transient failure (timeout, 429, 5xx, connection reset) before the
        // router moves on to the fallback — Live's rule.
        providerRetries: Math.max(0, int(env.AI_PROVIDER_RETRIES, 1)),
        retryDelayMs: Math.max(0, int(env.AI_PROVIDER_RETRY_DELAY_MS, 800)),

        // ── The measured refusal rates (server/refusal/) ──
        // The weekly job that asks every offer the same published, harmless questions and publishes how
        // often it refused them. Due-based, like the price book: the last finished run is a row in the
        // database, because AI is deployed several times a day and a timer in the process never comes round.
        refusal: {
            enabled: bool(env.AI_REFUSAL_JOB, !bool(env.AI_DRILL, false) && nodeEnv !== 'test'),
            intervalMs: Math.max(3600000, int(env.AI_REFUSAL_INTERVAL_MS, 7 * 24 * 60 * 60 * 1000)),
            tickMs: Math.max(60000, int(env.AI_REFUSAL_TICK_MS, 60 * 60 * 1000)),
            firstTickMs: Math.max(1000, int(env.AI_REFUSAL_FIRST_TICK_MS, 5 * 60 * 1000)),
            claimTtlMs: Math.max(60000, int(env.AI_REFUSAL_CLAIM_TTL_MS, 15 * 60 * 1000)),
            // How many of the published probes one offer is asked (the attempts the rate is based on).
            probesPerOffer: Math.max(1, int(env.AI_REFUSAL_PROBES, 4)),
            maxOffers: Math.max(1, int(env.AI_REFUSAL_MAX_OFFERS, 500)),
        },
        // ── The 18+ board (server/willing/): two owner-budget measurement jobs, both OFF by default ──
        // The willingness job asks every live offer the published 60 lawful adult prompts and records
        // the refusal and hedge rates. The abliteration tax runs the objective set on each declared
        // base/abliterated pair. Neither calls a provider until enabled AND given a budget above zero;
        // `plan()` is the dry run and lists the estimated cost from the live rate cards. An uncensored
        // offer is asked under the adult tier, which needs the adult measurement account below.
        willingness: {
            enabled: bool(env.AI_WILLINGNESS_JOB, false),
            budgetUsd: Math.max(0, Number(env.AI_WILLINGNESS_BUDGET_USD) || 0),
            intervalMs: Math.max(3600000, int(env.AI_WILLINGNESS_INTERVAL_MS, 7 * 24 * 60 * 60 * 1000)),
            tickMs: Math.max(60000, int(env.AI_WILLINGNESS_TICK_MS, 60 * 60 * 1000)),
            firstTickMs: Math.max(1000, int(env.AI_WILLINGNESS_FIRST_TICK_MS, 5 * 60 * 1000)),
            claimTtlMs: Math.max(60000, int(env.AI_WILLINGNESS_CLAIM_TTL_MS, 15 * 60 * 1000)),
            maxOffers: Math.max(1, int(env.AI_WILLINGNESS_MAX_OFFERS, 500)),
            outputTokens: Math.max(1, int(env.AI_WILLINGNESS_OUTPUT_TOKENS, 256)),
            adultSubject: /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(env.AI_WILLINGNESS_SUBJECT || '')) ? String(env.AI_WILLINGNESS_SUBJECT) : null,
        },
        abliterationTax: {
            enabled: bool(env.AI_ABLITERATION_TAX, false),
            budgetUsd: Math.max(0, Number(env.AI_ABLITERATION_TAX_BUDGET_USD) || 0),
            intervalMs: Math.max(3600000, int(env.AI_ABLITERATION_TAX_INTERVAL_MS, 7 * 24 * 60 * 60 * 1000)),
            tickMs: Math.max(60000, int(env.AI_ABLITERATION_TAX_TICK_MS, 60 * 60 * 1000)),
            firstTickMs: Math.max(1000, int(env.AI_ABLITERATION_TAX_FIRST_TICK_MS, 5 * 60 * 1000)),
            claimTtlMs: Math.max(60000, int(env.AI_ABLITERATION_TAX_CLAIM_TTL_MS, 15 * 60 * 1000)),
            outputTokens: Math.max(1, int(env.AI_ABLITERATION_TAX_OUTPUT_TOKENS, 256)),
            adultSubject: /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(env.AI_ABLITERATION_TAX_SUBJECT || env.AI_WILLINGNESS_SUBJECT || ''))
                ? String(env.AI_ABLITERATION_TAX_SUBJECT || env.AI_WILLINGNESS_SUBJECT) : null,
        },
        // ── The half-price batches (server/batch/) ──
        // Many prompts submitted at once, answered later, at half the retail price, billed through Billing.
        batches: {
            enabled: bool(env.AI_BATCHES, true),
            // The cap: how many prompts one batch may carry.
            maxItems: Math.max(1, int(env.AI_BATCH_MAX_ITEMS, 1000)),
            // How long a batch waits for low-cost capacity when the customer names no deadline (hours).
            deadlineHours: Math.max(1, Math.min(72, int(env.AI_BATCH_DEADLINE_HOURS, 24))),
            // The owner's loss budget (ai.batches.loss_budget_usd_per_day): what the network may absorb
            // per UTC day by running a batch item on ordinary capacity at its deadline. Zero never.
            lossBudgetUsdPerDay: Math.max(0, Number(env.AI_BATCH_LOSS_BUDGET_USD_PER_DAY || 0) || 0),
            tickMs: Math.max(5000, int(env.AI_BATCH_TICK_MS, 60 * 1000)),
            claimTtlMs: Math.max(60000, int(env.AI_BATCH_CLAIM_TTL_MS, 15 * 60 * 1000)),
            // The native batcher (BA2): the providers' own batch APIs.
            native: {
                // How many requests one provider batch carries.
                maxItemsPerGroup: Math.max(1, int(env.AI_BATCH_NATIVE_MAX_ITEMS, 1000)),
                // How long a group waits before it is submitted anyway (milliseconds).
                maxAgeMs: Math.max(1000, int(env.AI_BATCH_NATIVE_MAX_AGE_MS, 5 * 60 * 1000)),
                pollMs: Math.max(5000, int(env.AI_BATCH_NATIVE_POLL_MS, 60 * 1000)),
                claimTtlMs: Math.max(60000, int(env.AI_BATCH_NATIVE_CLAIM_TTL_MS, 5 * 60 * 1000)),
            },
        },
        // ── The living price book (server/pricebook/) ──
        // The weekly job that reads every catalogued provider's own price listing and keeps the price the router
        // charges in step with it (plan E1). A change of more than the threshold waits for the owner on the
        // operator console; a smaller one is applied at once. Off under a restore drill (AI_DRILL=1) and off in
        // test mode, where the recorded listings are replayed instead.
        priceBook: {
            enabled: bool(env.AI_PRICE_BOOK, !bool(env.AI_DRILL, false) && nodeEnv !== 'test'),
            // How long between two runs. The service is deployed several times a day, so the book is due-based:
            // the last finished run is a row in the database and the tick only reads the listings when the
            // interval has passed since then.
            intervalMs: Math.max(3600000, int(env.AI_PRICE_BOOK_INTERVAL_MS, 7 * 24 * 60 * 60 * 1000)),
            // How often the service asks whether the book is due, and how long after a boot the first ask is.
            tickMs: Math.max(60000, int(env.AI_PRICE_BOOK_TICK_MS, 60 * 60 * 1000)),
            firstTickMs: Math.max(1000, int(env.AI_PRICE_BOOK_FIRST_TICK_MS, 5 * 60 * 1000)),
            // How long a claimed run holds the claim, so a worker that dies does not block the next one.
            claimTtlMs: Math.max(60000, int(env.AI_PRICE_BOOK_CLAIM_TTL_MS, 15 * 60 * 1000)),
            timeoutMs: Math.max(1000, int(env.AI_PRICE_BOOK_TIMEOUT_MS, 20000)),
            maxBytes: Math.max(1024, int(env.AI_PRICE_BOOK_MAX_BYTES, 8 * 1024 * 1024)),
            thresholdPct: Number(env.AI_PRICE_BOOK_THRESHOLD_PCT || 20) / 100,
        },

        // ── Hourly provider balance probe (server/providers/balance.js) ──
        // Each active provider with a balance API (DeepSeek today) is asked GET <origin>/user/balance and the reading
        // is exposed as ai_provider_balance_usd{provider} on GET /metrics. Off under a restore drill (AI_DRILL=1).
        balance: {
            enabled: bool(env.AI_BALANCE_PROBE, !bool(env.AI_DRILL, false)),
            intervalMs: Math.max(60000, int(env.AI_BALANCE_PROBE_INTERVAL_MS, 60 * 60 * 1000)),
            timeoutMs: Math.max(1000, int(env.AI_BALANCE_PROBE_TIMEOUT_MS, 10000)),
        },

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

        // ── Billing Balance (AI Exchange F, CHECKPOINT D2/D9/D10/D12), off by default. A paid managed request holds
        // its worst-case cost before any provider call, extends the hold while streaming, and settles once. Reads the
        // same OV_BILLING_INTERNAL_URL and OV_OAUTH_CLIENT_SECRET as the usage samples; the capability is one per
        // operation (contracts v0.289.1): billing.credit.hold.{create,extend,settle,release}. An app holds against
        // its project's Balance and a person against their own; no Network owner lookup is made.
        credits: {
            enabled: bool(env.AI_CREDITS, false),
            billingUrl: trimUrl(env.OV_BILLING_INTERNAL_URL),
            audience: 'openvibe.billing',
            timeoutMs: Math.max(200, Math.min(30000, int(env.AI_CREDITS_TIMEOUT_MS, 5000))),
            // A settle Billing could not take is retried by the background queue with exponential backoff.
            settleRetryMs: Math.max(1000, Math.min(5 * 60 * 1000, int(env.AI_CREDITS_SETTLE_RETRY_MS, 5000))),
            settleMaxRetryMs: Math.max(1000, Math.min(60 * 60 * 1000, int(env.AI_CREDITS_SETTLE_MAX_RETRY_MS, 5 * 60 * 1000))),
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

        // ── Community AI offers (the design's "Offer to the network"; plan E4): requests that opt in to community
        // capacity may run on a person's Node, only after its canaries and model fingerprint pass. AI reads the offers
        // from Network's resource registry (network.registry.read), dispatches through Bot (bot.machine.ai), and keeps
        // the verification and earnings ledger. On by default: without a Network service secret the list is empty.
        community: {
            enabled: bool(env.AI_COMMUNITY, true),
            refreshMs: Math.max(1000, int(env.AI_COMMUNITY_REFRESH_MS, 30000)),
            canaryMaxAgeMs: Math.max(60000, int(env.AI_COMMUNITY_CANARY_MAX_AGE_MS, 6 * 60 * 60 * 1000)),
            canaryTimeoutMs: Math.max(2000, Math.min(120000, int(env.AI_COMMUNITY_CANARY_TIMEOUT_MS, 30000))),
            // About 1% of community answers are re-run on a trusted machine with the same model; a mismatch stops traffic.
            spotRate: Math.max(0, Math.min(1, float(env.AI_COMMUNITY_SPOT_RATE, 0.01))),
            // Until a machine has this many days of verified service, a seller earns at most the daily cap. Credits are
            // pending (not spendable) until the requester's own Balance charge exists; kudos are the volunteer reward.
            trustDays: Math.max(1, Math.min(365, int(env.AI_COMMUNITY_TRUST_DAYS, 7))),
            dailyEarningCapMicro: Math.max(0, Math.min(1e15, int(env.AI_COMMUNITY_DAILY_CAP_CREDITS, 100) * 1e6)),
            kudosPerThousandTokens: Math.max(1, Math.min(1000, int(env.AI_COMMUNITY_KUDOS_PER_1K, 1))),
            // A community endpoint is a standalone OpenAI-compatible server registered by its own https address with
            // the seller's Network developer key (server/community/endpoints.js). AI reaches it only through the egress
            // guard: https, a public DNS answer, no IP literal, a timeout, a response byte cap, and never the buyer's
            // identity in a header. maxPerOwner bounds one seller's registrations.
            endpoints: {
                enabled: bool(env.AI_COMMUNITY_ENDPOINTS, true),
                timeoutMs: Math.max(5000, Math.min(120000, int(env.AI_COMMUNITY_ENDPOINT_TIMEOUT_MS, 60000))),
                maxBytes: Math.max(65536, Math.min(16 * 1024 * 1024, int(env.AI_COMMUNITY_ENDPOINT_MAX_BYTES, 2 * 1024 * 1024))),
                maxRedirects: Math.max(0, Math.min(3, int(env.AI_COMMUNITY_ENDPOINT_MAX_REDIRECTS, 2))),
                maxPerOwner: Math.max(1, Math.min(100, int(env.AI_COMMUNITY_ENDPOINT_MAX_PER_OWNER, 20))),
            },
        },

        // ── Exchange webhooks (the plan's "For builders", item 7): a developer registers an https receiver and AI
        // signs usage, earnings and offer.down deliveries with the header openvibe-sdk/exchange verifies. A delivery
        // is a row retried with a backoff, so a receiver that is down loses nothing. The receiver URL is judged by
        // the same egress guard as a community endpoint; a private address is refused at registration.
        webhooks: {
            enabled: bool(env.AI_WEBHOOKS, true),
            timeoutMs: Math.max(1000, Math.min(120000, int(env.AI_WEBHOOK_TIMEOUT_MS, 10000))),
            maxBytes: Math.max(4096, Math.min(1024 * 1024, int(env.AI_WEBHOOK_MAX_BYTES, 65536))),
            maxAttempts: Math.max(1, Math.min(12, int(env.AI_WEBHOOK_MAX_ATTEMPTS, 6))),
            maxPerOwner: Math.max(1, Math.min(50, int(env.AI_WEBHOOK_MAX_PER_OWNER, 10))),
            // The first retry waits this long; each further attempt doubles it, up to maxDelayMs.
            baseDelayMs: Math.max(100, Math.min(3600000, int(env.AI_WEBHOOK_BASE_DELAY_MS, 10000))),
            maxDelayMs: Math.max(1000, Math.min(86400000, int(env.AI_WEBHOOK_MAX_DELAY_MS, 3600000))),
            tickMs: Math.max(250, Math.min(60000, int(env.AI_WEBHOOK_TICK_MS, 1000))),
        },

        // ── Tier budgets (T6 step 8, server/govern.js): openvibe-sdk/govern in Valkey, off unless AI_GOVERN_TIERS=1.
        govern: loadGovern(env, { bool, int, num: float }),
    };
}

module.exports = { load, LIVE_ROLES };
