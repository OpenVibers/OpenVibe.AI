'use strict';
/**
 * The AI authority's SQLite database (better-sqlite3). One table family per canonical record
 * group of the plan (§12.13 / §15.14):
 *
 *   1  providers (+ provider_health)     6  runs
 *   2  models                            7  requests          (request/completion log)
 *   3  routes      (versioned)           8  citations         (sources/citations)
 *   4  templates   (versioned)           9  cache_entries
 *   5  workflows   (versioned)          10  quotas + usage_counters
 *                                       11  audit_log
 *
 * Templates, workflows and routes are append-only per key: an edit inserts version n+1 and the
 * previous version stays readable, so every run can say exactly which versions produced it.
 * import_ledger / import_holds belong to scripts/import-from-live.js.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS providers (
    key TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    kind TEXT NOT NULL,                        -- stub | openai | anthropic | http | whisper
    status TEXT NOT NULL DEFAULT 'active',     -- active | disabled
    base_url TEXT,
    auth_mode TEXT NOT NULL DEFAULT 'none',    -- none | bearer | x-api-key
    secret_ref TEXT,                           -- 'env:NAME' — never a value
    default_model TEXT,
    capabilities TEXT NOT NULL DEFAULT '[]',   -- features supports() answers true for
    timeout_ms INTEGER NOT NULL DEFAULT 30000,
    priority INTEGER NOT NULL DEFAULT 100,
    metadata TEXT NOT NULL DEFAULT '{}',
    origin TEXT NOT NULL DEFAULT 'seed',       -- seed (from env at boot) | admin | import
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_health (
    provider_key TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'closed',      -- closed (healthy) | open (skipped) | half_open (one probe)
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    opened_at INTEGER,
    last_error TEXT,
    last_success_at INTEGER,
    last_failure_at INTEGER
);
CREATE TABLE IF NOT EXISTS models (
    provider_key TEXT NOT NULL,
    model_key TEXT NOT NULL,
    display_name TEXT,
    type TEXT NOT NULL DEFAULT 'chat',         -- chat | vision | embedding | stt
    status TEXT NOT NULL DEFAULT 'active',
    context_window INTEGER,
    max_output INTEGER,
    cost_in_per_mtok REAL,
    cost_out_per_mtok REAL,
    cost_cached_per_mtok REAL,
    supports_json INTEGER NOT NULL DEFAULT 1,
    supports_tools INTEGER NOT NULL DEFAULT 0,
    supports_streaming INTEGER NOT NULL DEFAULT 0,
    supports_vision INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (provider_key, model_key)
);
CREATE TABLE IF NOT EXISTS routes (
    key TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',     -- active | disabled
    primary_provider TEXT NOT NULL,
    primary_model TEXT,
    fallbacks TEXT NOT NULL DEFAULT '[]',      -- [{provider, model}]
    options TEXT NOT NULL DEFAULT '{}',        -- temperature and friends
    max_output_tokens INTEGER,
    response_format TEXT NOT NULL DEFAULT 'text', -- text | json
    timeout_ms INTEGER,
    alias_of TEXT,                             -- historical key kept as an explicit alias
    created_by TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (key, version)
);
CREATE TABLE IF NOT EXISTS templates (
    key TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    input_schema TEXT NOT NULL DEFAULT '{}',
    output_schema TEXT NOT NULL DEFAULT '{}',
    system_prompt TEXT NOT NULL DEFAULT '',
    user_prompt TEXT NOT NULL DEFAULT '',
    default_route TEXT,
    owner TEXT NOT NULL DEFAULT 'ai',
    visibility TEXT NOT NULL DEFAULT 'internal', -- public | first-party | internal
    status TEXT NOT NULL DEFAULT 'active',     -- draft | active | deprecated | archived
    metadata TEXT NOT NULL DEFAULT '{}',
    created_by TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (key, version)
);
CREATE TABLE IF NOT EXISTS workflows (
    key TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    namespace TEXT NOT NULL,                   -- owning product: live, network, wiki, ...
    input_schema TEXT NOT NULL,
    output_schema TEXT NOT NULL,
    steps TEXT NOT NULL,                       -- [{kind, template?, operation?, ...}]
    default_route TEXT,
    cache_mode TEXT NOT NULL DEFAULT 'private', -- none | private | service
    cache_ttl_sec INTEGER,
    status TEXT NOT NULL DEFAULT 'active',     -- draft | active | deprecated | archived
    metadata TEXT NOT NULL DEFAULT '{}',
    created_by TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (key, version)
);
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,                       -- run_<ULID>
    workflow_key TEXT NOT NULL,
    workflow_version INTEGER NOT NULL,
    template_key TEXT,
    template_version INTEGER,
    route_key TEXT,
    route_version INTEGER,
    status TEXT NOT NULL,                      -- queued | running | succeeded | failed | cancelled | cached
    requester_type TEXT NOT NULL,              -- service | app | mod (the token principal)
    requester_id TEXT NOT NULL,
    on_behalf_of TEXT,                         -- SubjectRef JSON (optional)
    attribution TEXT,                          -- EntityRef JSON the spend is attributed to (optional)
    source_service TEXT,
    target TEXT,                               -- EntityRef JSON (optional)
    target_key TEXT,                           -- service:type:id for lookups
    input TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    output TEXT,
    citations_count INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_detail TEXT,
    synthetic INTEGER NOT NULL DEFAULT 0,      -- produced by the stub provider
    provider_key TEXT,
    model_key TEXT,
    fallback_used INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    cache_key TEXT,
    cached_from TEXT,                          -- run id whose output a cached run reused
    retry_of TEXT,
    idempotency_key TEXT,
    trace_id TEXT,
    request_id TEXT,
    options TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idem ON runs(requester_type, requester_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_workflow ON runs(workflow_key, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_target ON runs(target_key, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_requester ON runs(requester_type, requester_id, created_at);
CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT,
    seq INTEGER NOT NULL DEFAULT 0,
    operation TEXT NOT NULL,                   -- chat | generate | summarize | classify | extract | enrich | embed | transcribe
    provider_key TEXT NOT NULL,
    model_key TEXT,
    route_key TEXT,
    route_version INTEGER,
    status TEXT NOT NULL,                      -- ok | error | timeout | skipped | cancelled
    skip_reason TEXT,                          -- disabled | circuit_open | unsupported | no_credentials
    fallback INTEGER NOT NULL DEFAULT 0,       -- 1 when this was not the route's primary
    prompt_hash TEXT,
    input_hash TEXT,
    output_hash TEXT,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    tokens_cached INTEGER NOT NULL DEFAULT 0,
    tokens_estimated INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    error TEXT,
    debug_prompt TEXT,                         -- only with AI_DEBUG_RAW_LOG and a caller opt-in
    debug_response TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_run ON requests(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests(provider_key, created_at);
CREATE TABLE IF NOT EXISTS citations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL DEFAULT 0,
    source_type TEXT NOT NULL,
    source_id TEXT,
    url TEXT,
    title TEXT,
    author TEXT,
    published_at TEXT,
    retrieved_at TEXT,
    snippet TEXT,
    content_hash TEXT,
    trust TEXT NOT NULL DEFAULT '{}',
    provenance TEXT NOT NULL DEFAULT '{}',
    attached_by TEXT,                          -- workflow | <principal sub>
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_citations_run ON citations(run_id, ordinal);
CREATE TABLE IF NOT EXISTS cache_entries (
    cache_key TEXT PRIMARY KEY,                -- sha256 over everything below
    scope TEXT NOT NULL,                       -- who may read it (see server/cache.js)
    workflow_key TEXT NOT NULL,
    workflow_version INTEGER NOT NULL,
    template_version INTEGER,
    route_key TEXT,
    route_version INTEGER,
    model_key TEXT,
    input_hash TEXT NOT NULL,
    privacy TEXT NOT NULL,                     -- private | service
    output TEXT NOT NULL,
    run_id TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_expiry ON cache_entries(expires_at);
CREATE INDEX IF NOT EXISTS idx_cache_workflow ON cache_entries(workflow_key);
CREATE TABLE IF NOT EXISTS quotas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_type TEXT NOT NULL,                  -- global | service | actor | attribution
    scope_id TEXT NOT NULL,                    -- '*' | live | user:usr_… | live:user:42
    window TEXT NOT NULL,                      -- minute | hour | day
    max_requests INTEGER,
    max_tokens INTEGER,
    max_cost_usd REAL,
    workflow_prefix TEXT,                      -- optional: only runs of workflows with this prefix
    status TEXT NOT NULL DEFAULT 'active',
    origin TEXT NOT NULL DEFAULT 'admin',      -- seed | admin | import
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_quotas_unique ON quotas(scope_type, scope_id, window, COALESCE(workflow_prefix, ''));
CREATE TABLE IF NOT EXISTS usage_counters (
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    window TEXT NOT NULL,
    window_start INTEGER NOT NULL,             -- epoch seconds, UTC
    workflow_prefix TEXT NOT NULL DEFAULT '',
    requests INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_type, scope_id, window, window_start, workflow_prefix)
);
CREATE TABLE IF NOT EXISTS usage_daily (
    day TEXT NOT NULL,                         -- YYYY-MM-DD (UTC)
    requester TEXT NOT NULL,                   -- service:live
    attribution TEXT NOT NULL DEFAULT '',      -- live:user:42
    workflow_key TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    model_key TEXT NOT NULL DEFAULT '',
    requests INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    tokens_cached INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (day, requester, attribution, workflow_key, provider_key, model_key)
);
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,                       -- principal sub (svc:live) or 'system'
    action TEXT NOT NULL,                      -- run.create | template.version | provider.update | ...
    target_type TEXT,
    target_id TEXT,
    trace_id TEXT,
    metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, id);
CREATE TABLE IF NOT EXISTS import_ledger (
    source TEXT NOT NULL,                      -- live.ai_usage, live.translations, ...
    source_key TEXT NOT NULL,
    target TEXT NOT NULL,                      -- where it went (table:key)
    imported_at TEXT NOT NULL,
    PRIMARY KEY (source, source_key)
);
CREATE TABLE IF NOT EXISTS import_holds (
    source TEXT NOT NULL,
    source_key TEXT NOT NULL,
    reason TEXT NOT NULL,
    detail TEXT,
    held_at TEXT NOT NULL,
    PRIMARY KEY (source, source_key)
);
`;

function openDb(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    // Added after the first release: ADD COLUMN only, so an older build ignores it.
    const cols = new Set(db.prepare("SELECT name FROM pragma_table_info('runs')").all().map((c) => c.name));
    if (!cols.has('grounding')) db.exec('ALTER TABLE runs ADD COLUMN grounding TEXT'); // { cited, gaps } (WS-O task 3)
    return db;
}

module.exports = { openDb, SCHEMA };
