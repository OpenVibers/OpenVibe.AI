-- phase: expand
-- Per provider+model circuits (server/providers/index.js). A provider can fail one offer while another
-- offer on the same provider still answers, so the breaker is keyed by the offer, not only by the provider.
-- The row survives a restart: state, the class that opened it, when a half-open probe may run, the
-- transient backoff that doubles to the ceiling, the owner's-key fingerprint (a SHA-256, never the key)
-- and the one owner notification sent for this open circuit.
CREATE TABLE IF NOT EXISTS provider_circuits (
    provider_key text COLLATE "C" NOT NULL,
    model_key text COLLATE "C" NOT NULL DEFAULT '',
    state text COLLATE "C" NOT NULL DEFAULT 'closed',      -- closed | open | half_open
    failure_class text COLLATE "C",                        -- balance | auth | rate_limit | transient | request (the class that opened it, or the last one)
    consecutive_failures bigint NOT NULL DEFAULT 0,
    opened_at bigint,                                      -- epoch ms the current open state began
    retry_at bigint,                                       -- epoch ms a half-open probe may run
    backoff_ms bigint NOT NULL DEFAULT 0,                  -- the current transient backoff (0 for balance/auth)
    key_stamp text COLLATE "C",                            -- sha256(provider key): a new key resets the circuits
    last_error text COLLATE "C",                           -- the provider's own short error, never a prompt or answer
    last_success_at bigint,
    last_failure_at bigint,
    notified_at bigint,                                    -- one owner alert per open balance/auth circuit
    PRIMARY KEY (provider_key, model_key)
);
CREATE INDEX IF NOT EXISTS idx_provider_circuits_state ON provider_circuits(state);

-- Why failures happened, by provider and class, for ai_provider_failures_total. Kept here so the
-- counter survives a restart; a request log row also carries its error_class (migrations/0060).
CREATE TABLE IF NOT EXISTS provider_failure_counts (
    provider_key text COLLATE "C" NOT NULL,
    failure_class text COLLATE "C" NOT NULL,
    count bigint NOT NULL DEFAULT 0,
    updated_at bigint,
    PRIMARY KEY (provider_key, failure_class)
);

-- The class of each failed attempt (server/providers/failure.js): balance, auth, rate_limit, transient or
-- request. The error message is still stored in `error`; this is the machine-readable class, no body.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS error_class text COLLATE "C";
