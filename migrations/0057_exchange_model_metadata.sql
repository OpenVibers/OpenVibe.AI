-- phase: expand
-- Last successful public models.dev read survives restarts and failed refreshes.
CREATE TABLE IF NOT EXISTS exchange_model_metadata (
    id TEXT PRIMARY KEY,
    payload JSONB NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL
);

-- Own-page observations include models that have never been enabled in the router.
CREATE TABLE IF NOT EXISTS exchange_market_prices (
    provider_key TEXT NOT NULL,
    model_key TEXT NOT NULL,
    price JSONB NOT NULL,
    source TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (provider_key, model_key)
);
