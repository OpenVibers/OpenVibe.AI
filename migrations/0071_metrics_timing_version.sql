-- phase: expand
-- Versioned jobs backfill retained run timestamps once when receipt timing improves.
ALTER TABLE exchange_metrics_job ADD COLUMN IF NOT EXISTS algorithm_version integer NOT NULL DEFAULT 1;
ALTER TABLE exchange_observations_job ADD COLUMN IF NOT EXISTS algorithm_version integer NOT NULL DEFAULT 1;
