-- phase: expand
-- T6 provider router, phase 0 (brief-t6-ai.out.md §4 "Prices/latency page", decisions-t4-t6.md "T6"):
-- the daily per-provider/model rollup the public price/latency page will read (never the requests table),
-- and the persisted placement state the router will rebalance on. Both are written in the same transaction
-- as usage_daily, from server/quota.js account(); nothing reads them yet.

CREATE TABLE provider_stats_daily (
    day date NOT NULL,                                     -- UTC day
    provider text COLLATE "C" NOT NULL,
    model text COLLATE "C" NOT NULL DEFAULT '',
    requests bigint NOT NULL DEFAULT 0,
    ok bigint NOT NULL DEFAULT 0,
    errors bigint NOT NULL DEFAULT 0,
    latency_p50_ms integer,
    latency_p95_ms integer,
    cost_usd_total numeric NOT NULL DEFAULT 0,
    tokens_in bigint NOT NULL DEFAULT 0,
    tokens_out bigint NOT NULL DEFAULT 0,
    -- A fixed-bucket latency histogram (server/quota.js LATENCY_BUCKETS_MS): the streaming estimate the
    -- p50/p95 columns are read from. Length = length(bounds)+1, the last bucket the overflow (>= top
    -- bound). Keeping it per row means the percentiles never scan the requests table.
    latency_hist bigint[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (day, provider, model)
);

CREATE TABLE placement_state (
    route_key text COLLATE "C" PRIMARY KEY,
    current_provider text COLLATE "C",                     -- the last finished candidate on the route
    current_model text COLLATE "C",
    ewma_latency_ms double precision NOT NULL DEFAULT 0,   -- alpha 0.2 per finished attempt (quota.js)
    ewma_error_rate double precision NOT NULL DEFAULT 0,   -- alpha 0.2, errors / attempts
    quality double precision,                              -- no quality signal yet: always null
    updated_at timestamptz NOT NULL DEFAULT now()
);
