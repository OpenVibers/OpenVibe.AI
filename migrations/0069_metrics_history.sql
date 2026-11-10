-- phase: expand
-- Public listed prices, and provider-hour aggregates of at least twenty run receipts.
CREATE TABLE IF NOT EXISTS exchange_prices_daily (
    day date NOT NULL,
    model text NOT NULL,
    provider text NOT NULL,
    offer text NOT NULL,
    price_in double precision,
    price_out double precision,
    price_cached double precision,
    source text,
    captured_at timestamptz NOT NULL,
    PRIMARY KEY (day, model, provider, offer)
);
CREATE INDEX IF NOT EXISTS exchange_prices_model_day ON exchange_prices_daily (model, day);
CREATE TABLE IF NOT EXISTS exchange_provider_hours (
    hour timestamptz NOT NULL,
    provider text NOT NULL,
    runs integer NOT NULL CHECK (runs >= 20),
    success_rate double precision NOT NULL CHECK (success_rate BETWEEN 0 AND 1),
    latency_p50_ms double precision,
    latency_samples integer CHECK (latency_samples >= 20),
    computed_at timestamptz NOT NULL,
    PRIMARY KEY (hour, provider)
);
CREATE TABLE IF NOT EXISTS exchange_observations_job (
    id integer PRIMARY KEY CHECK (id = 1),
    next_due timestamptz NOT NULL,
    completed_hour timestamptz
);
INSERT INTO exchange_observations_job (id, next_due) VALUES (1, '1970-01-01') ON CONFLICT DO NOTHING;
