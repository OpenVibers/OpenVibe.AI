-- phase: expand
-- OpenVibe Memory M2a (spec research-2026-10-30/memory-m2-spec.md): the person's memory store, one row per item,
-- sealed at rest with AI_MEMORY_KEY. `owner` is `user:usr_…`; every query is scoped by it. `text_enc` and
-- `source_ref_enc` are `m1:` AES-256-GCM (AAD memory|<owner>|<id>|<scope>); `text_mac` is HMAC-SHA256 of the
-- normalized text, for dedupe without reading plaintext. `memory_profiles` is a cache keyed by owner and scope;
-- `memory_reads` is the audit of what an agent read (item ids, never text).
CREATE TABLE IF NOT EXISTS memory_items (
    id text COLLATE "C" PRIMARY KEY,
    owner text COLLATE "C" NOT NULL,
    scope text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL,                         -- preference | fact | project_rule | procedure | decision | lesson
    text_enc text COLLATE "C" NOT NULL,                     -- m1:<iv>:<tag>:<body>
    text_mac text COLLATE "C" NOT NULL,                     -- HMAC-SHA256 of the normalized text
    source text COLLATE "C" NOT NULL,                       -- adapter id or service
    source_ref_enc text COLLATE "C",                        -- sealed { path, heading }
    status text COLLATE "C" NOT NULL DEFAULT 'active',      -- active | suggested | archived | conflict
    confidence double precision NOT NULL DEFAULT 1,
    seen_at text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL,
    machine text COLLATE "C"
);
CREATE INDEX IF NOT EXISTS memory_items_owner_scope_status ON memory_items (owner, scope, status);
CREATE INDEX IF NOT EXISTS memory_items_owner_text_mac ON memory_items (owner, text_mac);

CREATE TABLE IF NOT EXISTS memory_profiles (
    owner text COLLATE "C" NOT NULL,
    scope text COLLATE "C" NOT NULL,
    text_enc text COLLATE "C" NOT NULL,
    items_hash text COLLATE "C" NOT NULL,
    built_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (owner, scope)
);

CREATE TABLE IF NOT EXISTS memory_reads (
    id text COLLATE "C" PRIMARY KEY,
    owner text COLLATE "C" NOT NULL,
    actor text COLLATE "C" NOT NULL,                        -- svc:codes, …
    purpose text COLLATE "C",                               -- the task or run the person sees
    scopes text COLLATE "C" NOT NULL DEFAULT '[]',          -- JSON array of the scopes searched
    item_ids text COLLATE "C" NOT NULL DEFAULT '[]',        -- JSON array; never text
    created_at text COLLATE "C" NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_reads_owner_created ON memory_reads (owner, created_at);
