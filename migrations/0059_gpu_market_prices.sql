-- phase: expand
-- The public GPU marketplace prices the owner compares against API tokens. One row is the lowest price a
-- provider publishes right now for one card and one kind; a source that fails keeps its rows, and
-- gpu_market_sources records that the last read failed so the console can mark them stale.
CREATE TABLE IF NOT EXISTS gpu_market_prices (
  provider text NOT NULL,
  gpu_key text NOT NULL,
  gpu text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('on_demand', 'spot')),
  hourly_usd double precision NOT NULL CHECK(hourly_usd > 0),
  region text NOT NULL DEFAULT '',
  reliability double precision,
  note text NOT NULL DEFAULT '',
  variant text NOT NULL DEFAULT '',
  source text NOT NULL,
  observed_at text NOT NULL,
  PRIMARY KEY(provider, gpu_key, kind)
);
CREATE TABLE IF NOT EXISTS gpu_market_sources (
  provider text PRIMARY KEY,
  label text NOT NULL,
  source text NOT NULL,
  status text NOT NULL CHECK(status IN ('ok', 'failed')),
  read_at text,
  ok_at text,
  error text,
  offers integer NOT NULL DEFAULT 0
);
