-- phase: expand
-- T6 J4: a model's prices become platform.rate-card@1 objects (server/providers/rate-cards.js), one per
-- metric (input, cached input, output tokens per million). These columns hold what the contract needs beyond
-- the price itself. Additive only: every column is nullable or defaulted and no existing row is rewritten.
-- A NULL date or source means "not recorded": the card then says so (effective_from/verified_at 1970-01-01,
-- source urn:openvibe:ai:unverified:models). Rate cards change only by review.
-- The index serves the router's per-provider usage query for platform.provider-state@1 (this period's usage).

ALTER TABLE models ADD COLUMN effective_from text COLLATE "C";                              -- YYYY-MM-DD the price took effect, or NULL (unknown)
ALTER TABLE models ADD COLUMN source text COLLATE "C";                                      -- URI of the provider's price page it was checked against, or NULL (unknown)
ALTER TABLE models ADD COLUMN verified_at text COLLATE "C";                                 -- YYYY-MM-DD someone checked it against that source, or NULL (never)
ALTER TABLE models ADD COLUMN free_allowance double precision NOT NULL DEFAULT 0;           -- free tokens per reset period, for each of the model's token metrics
ALTER TABLE models ADD COLUMN reset_period text COLLATE "C" NOT NULL DEFAULT 'month';       -- day | month | none: when the free allowance resets

CREATE INDEX idx_usage_daily_provider_day ON usage_daily(provider_key, day);
