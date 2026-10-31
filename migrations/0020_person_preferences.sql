-- phase: expand
-- L36 Y3: one person's ai.me-preferences (only_my_keys, free_first, price_ceiling_usd_per_mtok and a default
-- model or `auto` per kind of work), stored per person. Expand only: a service without this table keeps running
-- (its routes simply answer the defaults), and the row holds JSON so more preferences add without a migration.
CREATE TABLE IF NOT EXISTS ai_person_preferences (
    subject     text COLLATE "C" PRIMARY KEY,
    preferences text COLLATE "C" NOT NULL DEFAULT '{}',
    created_at  text COLLATE "C" NOT NULL,
    updated_at  text COLLATE "C" NOT NULL
);
