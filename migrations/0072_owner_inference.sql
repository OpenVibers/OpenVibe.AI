-- phase: expand
-- Owner-configured inference (the owner 2026-11-10): spend caps per provider, a routing choice
-- per capability (cheapest / fastest / fixed order with a ceiling and a denylist), and economy
-- toggles per capability (batches, prompt cache, small-model-first, output limit, answer cache).
-- All tables start empty / off: no provider is capped or denied by installation. Every edit is
-- audited through registry.audit; no secret value ever reaches these tables.

CREATE TABLE IF NOT EXISTS provider_spend_caps (
    provider_key text COLLATE "C" PRIMARY KEY,
    daily_usd double precision,
    monthly_usd double precision,
    updated_by text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_routing (
    capability text COLLATE "C" PRIMARY KEY,
    strategy text COLLATE "C" NOT NULL DEFAULT 'auto',
    ceiling_usd_per_mtok_out double precision,
    denylist text COLLATE "C" NOT NULL DEFAULT '[]',
    choices text COLLATE "C" NOT NULL DEFAULT '[]',
    enabled boolean NOT NULL DEFAULT false,
    updated_by text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_economy (
    capability text COLLATE "C" PRIMARY KEY,
    batches boolean NOT NULL DEFAULT true,
    prompt_cache boolean NOT NULL DEFAULT true,
    small_first boolean NOT NULL DEFAULT false,
    output_limit bigint,
    answer_cache boolean NOT NULL DEFAULT true,
    updated_by text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);
