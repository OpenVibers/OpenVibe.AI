-- phase: expand
-- AI Exchange P7 (PLAN §D ObservedPerformance, §E): measured per-deployment evidence for alias routing.
-- Behind AI_ROUTING_EVIDENCE (off by default); additive only: no existing table or column is changed.
--
-- provider_metrics is one EWMA row per deployment (provider_key, model_key). Every attempt AI already logs
-- updates it, and a restart keeps it. Counts are separate per measurement so a missing TTFT (a non-streamed
-- answer) never drags the latency average to zero. The rates are EWMA values in [0, 1]; ttft_ms and
-- decode_tps are null until the first measurement.
CREATE TABLE provider_metrics (
    provider_key text COLLATE "C" NOT NULL,
    model_key text COLLATE "C" NOT NULL,
    ttft_ms double precision,                              -- EWMA of the first-token time (streamed answers)
    ttft_samples bigint NOT NULL DEFAULT 0,
    decode_tps double precision,                           -- EWMA of output tokens / (finish - first token)
    decode_samples bigint NOT NULL DEFAULT 0,
    success_rate double precision NOT NULL DEFAULT 0,      -- EWMA of 1 (ok) / 0 (failed or timed out)
    timeout_rate double precision NOT NULL DEFAULT 0,      -- EWMA of 1 (provider.timeout) / 0
    cache_hit_ratio double precision NOT NULL DEFAULT 0,   -- EWMA of cached / prompt tokens
    cache_samples bigint NOT NULL DEFAULT 0,
    sample_count bigint NOT NULL DEFAULT 0,                -- every attempt (the n in the explanation)
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider_key, model_key)
);

-- The incumbent an alias route is keeping for hysteresis, and the challenger's consecutive-decision streak.
-- route_key is the router's route key plus the alias policy, so each alias keeps its own incumbent.
CREATE TABLE routing_incumbents (
    decision_key text COLLATE "C" PRIMARY KEY,
    provider_key text COLLATE "C",
    model_key text COLLATE "C",
    challenger_provider text COLLATE "C",
    challenger_model text COLLATE "C",
    challenger_streak integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
);
