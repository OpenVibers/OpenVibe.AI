-- phase: expand
-- The latency class of a run, the tier it really ran on, and the off-peak windows as weekday blocks.
--
-- A run's latency class says how long the caller may wait: 'interactive' (today's routing), 'background'
-- (the cheapest tier that answers in minutes) or 'batch' (a deadline, answered later). The class is the
-- workflow's own, read from the route it uses (routes.constraints.latency_class); a caller may ask for a
-- slower one (options.latency) and never a faster one.
--
-- service_tier is the tier the run really ran on: 'standard', 'flex', 'batch', 'offpeak' or 'local'. The
-- cost on the run is what the provider really charged for that tier, and saved_usd is what waiting earned
-- (the standard price minus the real one). A run that never reached a provider has no tier.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS latency_class text NOT NULL DEFAULT 'interactive';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS service_tier text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS saved_usd double precision NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS runs_latency_class_idx ON runs (latency_class, created_at DESC);
CREATE INDEX IF NOT EXISTS runs_service_tier_idx ON runs (service_tier, provider_key);

-- The price book's off-peak windows as weekday blocks.
--
-- The old table holds ONE daily window per (provider, model, field): a start hour and an end hour, and the
-- window applies every day of the week. That cannot express a rule like DeepSeek's, whose peak hours are
-- 01:00-04:00 and 06:00-10:00 UTC Monday to Friday (every other hour is off-peak, weekends in full).
--
-- This table holds blocks: a set of weekdays and the hours inside them. The old rows are still read (a
-- provider with only old rows keeps its old window), and the new rows are read on top of them.
CREATE TABLE IF NOT EXISTS price_book_offpeak_blocks (
    id              bigserial PRIMARY KEY,
    provider_key    text COLLATE "C" NOT NULL,
    model_key       text COLLATE "C" NOT NULL,
    field           text COLLATE "C" NOT NULL CHECK (field IN ('in_per_mtok', 'out_per_mtok', 'cached_per_mtok')),
    price           numeric(20, 6) NOT NULL,             -- the provider's own price inside the block
    weekdays        text COLLATE "C" NOT NULL,           -- the ISO weekdays the block is on: '1,2,3,4,5' (1 = Monday)
    start_hour      integer NOT NULL CHECK (start_hour BETWEEN 0 AND 23),   -- the UTC hour the block opens
    end_hour        integer NOT NULL CHECK (end_hour BETWEEN 0 AND 24),     -- the UTC hour it closes (24 = midnight)
    source          text COLLATE "C" NOT NULL,           -- the listing the block was read from
    checked_at      date NOT NULL,                       -- the day it was read
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS price_book_offpeak_blocks_key_idx
    ON price_book_offpeak_blocks (provider_key, model_key, field, weekdays, start_hour, end_hour);
CREATE INDEX IF NOT EXISTS price_book_offpeak_blocks_lookup_idx
    ON price_book_offpeak_blocks (provider_key, model_key);
