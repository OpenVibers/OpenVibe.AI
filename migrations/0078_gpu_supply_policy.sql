-- phase: expand
-- Owner GPU supply policy. Rows start absent and therefore disabled and quote-only.
-- Credentials stay in the sealed ai.gpus config namespace, never in this table.
CREATE TABLE IF NOT EXISTS gpu_supply_policy (
    scope text COLLATE "C" PRIMARY KEY,
    settings text COLLATE "C" NOT NULL,
    updated_by text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);
