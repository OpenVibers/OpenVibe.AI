-- phase: expand
CREATE TABLE IF NOT EXISTS exchange_api_keys (
 id text PRIMARY KEY, owner text NOT NULL, name text NOT NULL, digest text NOT NULL UNIQUE,
 prefix text NOT NULL, monthly_cap_usd double precision NOT NULL CHECK(monthly_cap_usd >= 0),
 allowed_models text NOT NULL DEFAULT '[]', created_at text NOT NULL, revoked_at text
);
CREATE TABLE IF NOT EXISTS exchange_key_months (
 key_id text NOT NULL REFERENCES exchange_api_keys(id), month text NOT NULL,
 spent double precision NOT NULL DEFAULT 0, reserved double precision NOT NULL DEFAULT 0,
 PRIMARY KEY(key_id,month)
);
CREATE TABLE IF NOT EXISTS exchange_key_usage (
 id text PRIMARY KEY, key_id text NOT NULL REFERENCES exchange_api_keys(id), day text NOT NULL,
 model text NOT NULL, tokens_in bigint NOT NULL DEFAULT 0, tokens_out bigint NOT NULL DEFAULT 0,
 cost_usd double precision NOT NULL DEFAULT 0, status text NOT NULL
);
CREATE TABLE IF NOT EXISTS exchange_supply_settings (
 model text PRIMARY KEY, settings text NOT NULL, updated_at text NOT NULL, actor text NOT NULL
);
CREATE TABLE IF NOT EXISTS gpu_price_book (
 provider text NOT NULL, gpu text NOT NULL, region text NOT NULL, hourly_usd double precision NOT NULL CHECK(hourly_usd > 0),
 vram_mb bigint NOT NULL CHECK(vram_mb > 0), source text NOT NULL, observed_at text NOT NULL,
 PRIMARY KEY(provider,gpu,region)
);
