-- phase: expand
-- Bounded owner-visible history of model discovery. Models remain in the existing models table.
CREATE TABLE provider_model_syncs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_key text COLLATE "C" NOT NULL REFERENCES providers(key),
    trigger_kind text COLLATE "C" NOT NULL,
    actor text COLLATE "C" NOT NULL,
    status text COLLATE "C" NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
    started_at timestamptz NOT NULL,
    finished_at timestamptz,
    added integer NOT NULL DEFAULT 0,
    updated integer NOT NULL DEFAULT 0,
    missing integer NOT NULL DEFAULT 0,
    error_code text COLLATE "C"
);
CREATE INDEX provider_model_syncs_recent ON provider_model_syncs(provider_key, started_at DESC);
