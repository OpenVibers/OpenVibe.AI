-- phase: expand
-- OpenRouter request presets belong to a person, independently of routing-only presets.
CREATE TABLE IF NOT EXISTS exchange_compat_presets (
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    definition JSONB NOT NULL,
    PRIMARY KEY (owner, name)
);
