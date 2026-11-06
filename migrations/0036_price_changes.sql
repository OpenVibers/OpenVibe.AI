-- phase: expand
-- The living price book (plan E1, 2026-10-30 §8): the log of every price change the weekly job found.
--
-- A price is only ever read from the provider that sells it, and a live price never changes silently. The job
-- reads each catalogued provider's own listing, compares it with the price the router charges, and writes what it
-- found here: the old price, the new price, the listing the price was read from and the day it was read. A change
-- of more than 20% waits as 'pending' until the owner approves it on the operator console; a smaller one is
-- applied to the model row at once and lands here as 'applied'.
--
-- This table is the log, not a second list of prices: the live price stays in the models row the router reads
-- (server/registry.js), and this table says how it got there and who said so.
CREATE TABLE IF NOT EXISTS price_changes (
    id            text COLLATE "C" PRIMARY KEY,       -- pc_<ULID>
    provider_key  text COLLATE "C" NOT NULL,
    model_key     text COLLATE "C" NOT NULL,
    field         text COLLATE "C" NOT NULL CHECK (field IN ('in_per_mtok', 'cached_per_mtok', 'out_per_mtok')),
    old_price     numeric(20, 6),                     -- null when the model had no price yet
    new_price     numeric(20, 6) NOT NULL,
    change_pct    numeric(14, 6),                     -- the signed relative change, null when there was no price
    source        text COLLATE "C" NOT NULL,          -- the provider's own listing the price was read from
    checked_at    date NOT NULL,                      -- the day the price was read
    status        text COLLATE "C" NOT NULL CHECK (status IN ('applied', 'pending', 'approved', 'rejected', 'superseded')),
    created_at    timestamptz NOT NULL,
    decided_at    timestamptz,
    decided_by    text COLLATE "C",
    note          text COLLATE "C"
);
CREATE INDEX IF NOT EXISTS price_changes_model_idx ON price_changes (provider_key, model_key, created_at DESC);
CREATE INDEX IF NOT EXISTS price_changes_status_idx ON price_changes (status, created_at DESC);
