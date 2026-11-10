-- phase: expand
-- Durable, public-safe statistics from completed run receipts. No caller, prompt,
-- answer, template, site or run id is copied into this table. Sparse cells stay private.
CREATE TABLE IF NOT EXISTS exchange_metrics_daily (
    day date NOT NULL,
    model text NOT NULL,
    provider text NOT NULL,
    task_kind text NOT NULL,
    runs integer NOT NULL CHECK (runs >= 20),
    metrics jsonb NOT NULL,
    computed_at timestamptz NOT NULL,
    PRIMARY KEY (day, model, provider, task_kind)
);
CREATE INDEX IF NOT EXISTS exchange_metrics_model_day ON exchange_metrics_daily (model, day);
CREATE TABLE IF NOT EXISTS exchange_metrics_job (
    id integer PRIMARY KEY CHECK (id = 1),
    next_due timestamptz NOT NULL,
    completed_through date,
    completed_at timestamptz
);
INSERT INTO exchange_metrics_job (id, next_due) VALUES (1, '1970-01-01') ON CONFLICT DO NOTHING;
