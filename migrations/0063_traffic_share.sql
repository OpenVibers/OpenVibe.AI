-- phase: expand
-- Real-traffic share (plan 2026-11-09, stage B8).
--
-- One row per completed UTC week: the share of requests and tokens each model and each app category
-- carried, read from the Exchange receipts. Only cells with at least k requests are published; a cell
-- below k is withheld and only counted in the withheld totals. Receipts are pruned with their runs, so
-- the weekly row is the durable copy: it stays after the receipts it was computed from are gone.
--
-- payload is the exact public answer (aggregate counts and shares, never a person, an app's name or a
-- prompt). recomputed_at is the last time the same week was recomputed (before the receipts aged out).
-- The weekly aggregate scans the last seven days of receipts; that read gets its own index.
CREATE INDEX IF NOT EXISTS ai_receipts_created_idx ON ai_receipts (created_at);

CREATE TABLE IF NOT EXISTS exchange_traffic_share (
    week_start      date PRIMARY KEY,                  -- Monday 00:00 UTC
    week_end        date NOT NULL,                    -- the next Monday, exclusive
    k               integer NOT NULL CHECK (k >= 1),   -- the minimum requests per published cell
    payload         jsonb NOT NULL,
    cells           integer NOT NULL DEFAULT 0,        -- cells before the k rule
    published_cells integer NOT NULL DEFAULT 0,
    withheld_cells  integer NOT NULL DEFAULT 0,
    computed_at     timestamptz NOT NULL DEFAULT now(),
    recomputed_at   timestamptz
);
