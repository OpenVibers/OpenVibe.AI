-- phase: expand
-- The owner's economy switches act (2026-11-10). Prompt caching is now gated by the owner's
-- owner_economy.prompt_cache row, so the saving it reports needs the write side of the provider's
-- cache as well as its reads: the adapters already return cache_write (server/providers/usage.js),
-- and requests only kept tokens_cached. This column records the writes, so the panel can price a
-- cache read against the input price and subtract the write premium from the provider's own
-- cache-write card (the price book's cost_cache_write_per_mtok, migrations/0022).
-- Expand-only: the column is nullable-free with a default, and no existing row changes meaning.

ALTER TABLE requests ADD COLUMN IF NOT EXISTS tokens_cache_write bigint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_requests_created_cached ON requests(created_at) WHERE tokens_cached > 0;
