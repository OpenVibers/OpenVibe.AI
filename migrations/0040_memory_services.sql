-- phase: expand
-- OpenVibe Memory M5: the memory services a person connects with their own key (mem0, Letta, Zep).
--
-- The key is sealed exactly the way a BYO provider key is (server/credentials.js): AES-256-GCM with
-- AI_CREDENTIALS_KEY, `v1:<iv>:<tag>:<body>`, and the additional data `memory-service|<subject>|<provider>`, so a row
-- copied to another person or provider does not decrypt. The key is never returned by any route, never logged and
-- never put in an error; only `key_hint` (the last four characters) is shown to the person.
--
-- `account` is an optional user/agent id the service needs (Zep's user, Letta's agent when the person names one);
-- `base_url` is an optional self-hosted endpoint. `last_sync_*` are counts and times only, never text.
CREATE TABLE IF NOT EXISTS memory_service_connections (
    subject text COLLATE "C" NOT NULL,                      -- usr_…
    provider text COLLATE "C" NOT NULL,                     -- mem0 | letta | zep
    base_url text COLLATE "C",
    account text COLLATE "C",
    key_enc text COLLATE "C" NOT NULL,                      -- v1:<iv>:<tag>:<body>, never plaintext
    key_hint text COLLATE "C" NOT NULL,                     -- the last four characters
    status text COLLATE "C" NOT NULL DEFAULT 'untested',    -- untested | ok | failing
    checked_at text COLLATE "C",
    last_error text COLLATE "C",                            -- redacted, at most 300 characters
    last_sync_at text COLLATE "C",
    last_sync_count integer NOT NULL DEFAULT 0,
    created_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (subject, provider)
);
