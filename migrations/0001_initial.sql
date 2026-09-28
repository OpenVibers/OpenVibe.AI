-- phase: expand
-- OpenVibe.AI on PostgreSQL (ADR-035, roadmap WS-X2): the tables as they were on SQLite (converted by openvibe-sdk
-- tools/asyncify/sqlite-schema-to-pg: text COLLATE "C" compares like SQLite, integers are bigint, identities keep their ids),
-- then the openvibe-publishing stores and the openvibe-sdk inbox and outbox. Generated once on 2026-09-28; never edited after it runs.

CREATE TABLE providers (
    key text COLLATE "C" PRIMARY KEY,
    display_name text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL,                        -- stub | openai | anthropic | http | whisper
    status text COLLATE "C" NOT NULL DEFAULT 'active',     -- active | disabled
    base_url text COLLATE "C",
    auth_mode text COLLATE "C" NOT NULL DEFAULT 'none',    -- none | bearer | x-api-key
    secret_ref text COLLATE "C",                           -- 'env:NAME' — never a value
    default_model text COLLATE "C",
    capabilities text COLLATE "C" NOT NULL DEFAULT '[]',   -- features supports() answers true for
    timeout_ms bigint NOT NULL DEFAULT 30000,
    priority bigint NOT NULL DEFAULT 100,
    metadata text COLLATE "C" NOT NULL DEFAULT '{}',
    origin text COLLATE "C" NOT NULL DEFAULT 'seed',       -- seed (from env at boot) | admin | import
    created_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);
CREATE TABLE provider_health (
    provider_key text COLLATE "C" PRIMARY KEY,
    state text COLLATE "C" NOT NULL DEFAULT 'closed',      -- closed (healthy) | open (skipped) | half_open (one probe)
    consecutive_failures bigint NOT NULL DEFAULT 0,
    opened_at bigint,
    last_error text COLLATE "C",
    last_success_at bigint,
    last_failure_at bigint
);
CREATE TABLE models (
    provider_key text COLLATE "C" NOT NULL,
    model_key text COLLATE "C" NOT NULL,
    display_name text COLLATE "C",
    type text COLLATE "C" NOT NULL DEFAULT 'chat',         -- chat | vision | embedding | stt
    status text COLLATE "C" NOT NULL DEFAULT 'active',
    context_window bigint,
    max_output bigint,
    cost_in_per_mtok double precision,
    cost_out_per_mtok double precision,
    cost_cached_per_mtok double precision,
    supports_json bigint NOT NULL DEFAULT 1,
    supports_tools bigint NOT NULL DEFAULT 0,
    supports_streaming bigint NOT NULL DEFAULT 0,
    supports_vision bigint NOT NULL DEFAULT 0,
    metadata text COLLATE "C" NOT NULL DEFAULT '{}',
    created_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (provider_key, model_key)
);
CREATE TABLE routes (
    key text COLLATE "C" NOT NULL,
    version bigint NOT NULL,
    status text COLLATE "C" NOT NULL DEFAULT 'active',     -- active | disabled
    primary_provider text COLLATE "C" NOT NULL,
    primary_model text COLLATE "C",
    fallbacks text COLLATE "C" NOT NULL DEFAULT '[]',      -- [{provider, model}]
    options text COLLATE "C" NOT NULL DEFAULT '{}',        -- temperature and friends
    max_output_tokens bigint,
    response_format text COLLATE "C" NOT NULL DEFAULT 'text', -- text | json
    timeout_ms bigint,
    alias_of text COLLATE "C",                             -- historical key kept as an explicit alias
    created_by text COLLATE "C",
    created_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (key, version)
);
CREATE TABLE templates (
    key text COLLATE "C" NOT NULL,
    version bigint NOT NULL,
    name text COLLATE "C" NOT NULL,
    description text COLLATE "C",
    input_schema text COLLATE "C" NOT NULL DEFAULT '{}',
    output_schema text COLLATE "C" NOT NULL DEFAULT '{}',
    system_prompt text COLLATE "C" NOT NULL DEFAULT '',
    user_prompt text COLLATE "C" NOT NULL DEFAULT '',
    default_route text COLLATE "C",
    owner text COLLATE "C" NOT NULL DEFAULT 'ai',
    visibility text COLLATE "C" NOT NULL DEFAULT 'internal', -- public | first-party | internal
    status text COLLATE "C" NOT NULL DEFAULT 'active',     -- draft | active | deprecated | archived
    metadata text COLLATE "C" NOT NULL DEFAULT '{}',
    created_by text COLLATE "C",
    created_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (key, version)
);
CREATE TABLE workflows (
    key text COLLATE "C" NOT NULL,
    version bigint NOT NULL,
    name text COLLATE "C" NOT NULL,
    description text COLLATE "C",
    namespace text COLLATE "C" NOT NULL,                   -- owning product: live, network, wiki, ...
    input_schema text COLLATE "C" NOT NULL,
    output_schema text COLLATE "C" NOT NULL,
    steps text COLLATE "C" NOT NULL,                       -- [{kind, template?, operation?, ...}]
    default_route text COLLATE "C",
    cache_mode text COLLATE "C" NOT NULL DEFAULT 'private', -- none | private | service
    cache_ttl_sec bigint,
    status text COLLATE "C" NOT NULL DEFAULT 'active',     -- draft | active | deprecated | archived
    metadata text COLLATE "C" NOT NULL DEFAULT '{}',
    created_by text COLLATE "C",
    created_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (key, version)
);
CREATE TABLE runs (
    id text COLLATE "C" PRIMARY KEY,                       -- run_<ULID>
    workflow_key text COLLATE "C" NOT NULL,
    workflow_version bigint NOT NULL,
    template_key text COLLATE "C",
    template_version bigint,
    route_key text COLLATE "C",
    route_version bigint,
    status text COLLATE "C" NOT NULL,                      -- queued | running | succeeded | failed | cancelled | cached
    requester_type text COLLATE "C" NOT NULL,              -- service | app | mod (the token principal)
    requester_id text COLLATE "C" NOT NULL,
    on_behalf_of text COLLATE "C",                         -- SubjectRef JSON (optional)
    attribution text COLLATE "C",                          -- EntityRef JSON the spend is attributed to (optional)
    source_service text COLLATE "C",
    target text COLLATE "C",                               -- EntityRef JSON (optional)
    target_key text COLLATE "C",                           -- service:type:id for lookups
    input text COLLATE "C" NOT NULL,
    input_hash text COLLATE "C" NOT NULL,
    output text COLLATE "C",
    citations_count bigint NOT NULL DEFAULT 0,
    error_code text COLLATE "C",
    error_detail text COLLATE "C",
    synthetic bigint NOT NULL DEFAULT 0,      -- produced by the stub provider
    provider_key text COLLATE "C",
    model_key text COLLATE "C",
    fallback_used bigint NOT NULL DEFAULT 0,
    attempts bigint NOT NULL DEFAULT 0,
    tokens_in bigint NOT NULL DEFAULT 0,
    tokens_out bigint NOT NULL DEFAULT 0,
    cost_usd double precision NOT NULL DEFAULT 0,
    cache_key text COLLATE "C",
    cached_from text COLLATE "C",                          -- run id whose output a cached run reused
    retry_of text COLLATE "C",
    idempotency_key text COLLATE "C",
    trace_id text COLLATE "C",
    request_id text COLLATE "C",
    options text COLLATE "C" NOT NULL DEFAULT '{}',
    created_at text COLLATE "C" NOT NULL,
    started_at text COLLATE "C",
    finished_at text COLLATE "C"
);
CREATE UNIQUE INDEX idx_runs_idem ON runs(requester_type, requester_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_runs_status ON runs(status, created_at);
CREATE INDEX idx_runs_workflow ON runs(workflow_key, created_at);
CREATE INDEX idx_runs_target ON runs(target_key, created_at);
CREATE INDEX idx_runs_requester ON runs(requester_type, requester_id, created_at);
CREATE TABLE requests (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id text COLLATE "C",
    seq bigint NOT NULL DEFAULT 0,
    operation text COLLATE "C" NOT NULL,                   -- chat | generate | summarize | classify | extract | enrich | embed | transcribe
    provider_key text COLLATE "C" NOT NULL,
    model_key text COLLATE "C",
    route_key text COLLATE "C",
    route_version bigint,
    status text COLLATE "C" NOT NULL,                      -- ok | error | timeout | skipped | cancelled
    skip_reason text COLLATE "C",                          -- disabled | circuit_open | unsupported | no_credentials
    fallback bigint NOT NULL DEFAULT 0,       -- 1 when this was not the route's primary
    prompt_hash text COLLATE "C",
    input_hash text COLLATE "C",
    output_hash text COLLATE "C",
    tokens_in bigint NOT NULL DEFAULT 0,
    tokens_out bigint NOT NULL DEFAULT 0,
    tokens_cached bigint NOT NULL DEFAULT 0,
    tokens_estimated bigint NOT NULL DEFAULT 0,
    cost_usd double precision NOT NULL DEFAULT 0,
    latency_ms bigint,
    error text COLLATE "C",
    debug_prompt text COLLATE "C",                         -- only with AI_DEBUG_RAW_LOG and a caller opt-in
    debug_response text COLLATE "C",
    created_at text COLLATE "C" NOT NULL
);
CREATE INDEX idx_requests_run ON requests(run_id, seq);
CREATE INDEX idx_requests_provider ON requests(provider_key, created_at);
CREATE TABLE citations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id text COLLATE "C" NOT NULL,
    ordinal bigint NOT NULL DEFAULT 0,
    source_type text COLLATE "C" NOT NULL,
    source_id text COLLATE "C",
    url text COLLATE "C",
    title text COLLATE "C",
    author text COLLATE "C",
    published_at text COLLATE "C",
    retrieved_at text COLLATE "C",
    snippet text COLLATE "C",
    content_hash text COLLATE "C",
    trust text COLLATE "C" NOT NULL DEFAULT '{}',
    provenance text COLLATE "C" NOT NULL DEFAULT '{}',
    attached_by text COLLATE "C",                          -- workflow | <principal sub>
    created_at text COLLATE "C" NOT NULL
);
CREATE INDEX idx_citations_run ON citations(run_id, ordinal);
CREATE TABLE cache_entries (
    cache_key text COLLATE "C" PRIMARY KEY,                -- sha256 over everything below
    scope text COLLATE "C" NOT NULL,                       -- who may read it (see server/cache.js)
    workflow_key text COLLATE "C" NOT NULL,
    workflow_version bigint NOT NULL,
    template_version bigint,
    route_key text COLLATE "C",
    route_version bigint,
    model_key text COLLATE "C",
    input_hash text COLLATE "C" NOT NULL,
    privacy text COLLATE "C" NOT NULL,                     -- private | service
    output text COLLATE "C" NOT NULL,
    run_id text COLLATE "C" NOT NULL,
    hits bigint NOT NULL DEFAULT 0,
    created_at text COLLATE "C" NOT NULL,
    expires_at bigint NOT NULL
);
CREATE INDEX idx_cache_expiry ON cache_entries(expires_at);
CREATE INDEX idx_cache_workflow ON cache_entries(workflow_key);
CREATE TABLE quotas (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scope_type text COLLATE "C" NOT NULL,                  -- global | service | actor | attribution
    scope_id text COLLATE "C" NOT NULL,                    -- '*' | live | user:usr_… | live:user:42
    "window" text COLLATE "C" NOT NULL,                      -- minute | hour | day
    max_requests bigint,
    max_tokens bigint,
    max_cost_usd double precision,
    workflow_prefix text COLLATE "C",                      -- optional: only runs of workflows with this prefix
    status text COLLATE "C" NOT NULL DEFAULT 'active',
    origin text COLLATE "C" NOT NULL DEFAULT 'admin',      -- seed | admin | import
    created_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);
CREATE UNIQUE INDEX idx_quotas_unique ON quotas(scope_type, scope_id, "window", COALESCE(workflow_prefix, ''));
CREATE TABLE usage_counters (
    scope_type text COLLATE "C" NOT NULL,
    scope_id text COLLATE "C" NOT NULL,
    "window" text COLLATE "C" NOT NULL,
    window_start bigint NOT NULL,             -- epoch seconds, UTC
    workflow_prefix text COLLATE "C" NOT NULL DEFAULT '',
    requests bigint NOT NULL DEFAULT 0,
    tokens bigint NOT NULL DEFAULT 0,
    cost_usd double precision NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_type, scope_id, "window", window_start, workflow_prefix)
);
CREATE TABLE usage_daily (
    day text COLLATE "C" NOT NULL,                         -- YYYY-MM-DD (UTC)
    requester text COLLATE "C" NOT NULL,                   -- service:live
    attribution text COLLATE "C" NOT NULL DEFAULT '',      -- live:user:42
    workflow_key text COLLATE "C" NOT NULL,
    provider_key text COLLATE "C" NOT NULL,
    model_key text COLLATE "C" NOT NULL DEFAULT '',
    requests bigint NOT NULL DEFAULT 0,
    tokens_in bigint NOT NULL DEFAULT 0,
    tokens_out bigint NOT NULL DEFAULT 0,
    tokens_cached bigint NOT NULL DEFAULT 0,
    cost_usd double precision NOT NULL DEFAULT 0,
    PRIMARY KEY (day, requester, attribution, workflow_key, provider_key, model_key)
);
CREATE TABLE audit_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at text COLLATE "C" NOT NULL,
    actor text COLLATE "C" NOT NULL,                       -- principal sub (svc:live) or 'system'
    action text COLLATE "C" NOT NULL,                      -- run.create | template.version | provider.update | ...
    target_type text COLLATE "C",
    target_id text COLLATE "C",
    trace_id text COLLATE "C",
    metadata text COLLATE "C" NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_target ON audit_log(target_type, target_id, id);
CREATE INDEX idx_audit_action ON audit_log(action, id);
CREATE TABLE console_sessions (
    id_hash text COLLATE "C" PRIMARY KEY,                  -- sha256 of the session cookie; the cookie value is never stored
    subject text COLLATE "C" NOT NULL,                     -- the Network person (usr_…)
    username text COLLATE "C",
    staff text COLLATE "C" NOT NULL DEFAULT '{}',          -- the sign-in token's staff claims (role, is_owner, staff_caps, staff_map)
    csrf text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" NOT NULL,
    expires_at text COLLATE "C" NOT NULL,
    revoked_at text COLLATE "C",
    ip_hash text COLLATE "C"                               -- keyed hash of the client address
);
CREATE TABLE import_ledger (
    source text COLLATE "C" NOT NULL,                      -- live.ai_usage, live.translations, ...
    source_key text COLLATE "C" NOT NULL,
    target text COLLATE "C" NOT NULL,                      -- where it went (table:key)
    imported_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (source, source_key)
);
CREATE TABLE import_holds (
    source text COLLATE "C" NOT NULL,
    source_key text COLLATE "C" NOT NULL,
    reason text COLLATE "C" NOT NULL,
    detail text COLLATE "C",
    held_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (source, source_key)
);

-- openvibe-sdk/events PostgreSQL outbox
CREATE TABLE IF NOT EXISTS event_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS event_outbox_due ON event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS event_outbox_sent ON event_outbox (sent_at) WHERE sent_at IS NOT NULL;

-- Added after the first SQLite schema: a run's grounding ({ cited, gaps }, WS-O task 3).
ALTER TABLE runs ADD COLUMN grounding text COLLATE "C";

-- server/user-modules.js: the last preferences hash pushed to Network per person (was created on first use).
CREATE TABLE ai_module_pushes (
    subject_id text COLLATE "C" PRIMARY KEY,
    hash       text COLLATE "C" NOT NULL,
    pushed_at  text COLLATE "C" NOT NULL
);

-- server/credentials.js: a person's own provider keys (WS-O task 2), encrypted (was created on first use).
CREATE TABLE subject_credentials (
    owner          text COLLATE "C" NOT NULL,
    subject        text COLLATE "C" NOT NULL,
    provider       text COLLATE "C" NOT NULL CHECK (provider IN ('openai', 'anthropic')),
    base_url       text COLLATE "C",
    key_enc        text COLLATE "C" NOT NULL,
    key_hint       text COLLATE "C" NOT NULL,
    models         text COLLATE "C" NOT NULL DEFAULT '{}',
    budget_usd_day double precision,
    created_at     text COLLATE "C" NOT NULL,
    updated_at     text COLLATE "C" NOT NULL,
    last_used_at   text COLLATE "C",
    PRIMARY KEY (owner, subject)
);
