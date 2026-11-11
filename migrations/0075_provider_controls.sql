-- phase: expand
-- The owner's provider controls and the routing rules of the 2026-11-10 provider wave.
--
-- provider_controls: one row per provider the owner changed. `enabled` null follows the provider's own
-- status; `tier` is the service tier the owner wants (standard or flex); `base_url`, `model_key`,
-- `hourly_usd` and `throughput_tokens_per_hour` are the owner's own OpenAI-compatible endpoint (the rented
-- Runpod/Vast vLLM), whose key lives in the provider's sealed key slot, never here.
--
-- owner_inference_rules: one row, 'default'. Every switch starts at the safe value:
--   private_training          false  a provider that trains on or retains prompts never gets private data
--   flex_interactive          false  a Flex offer never answers an interactive request
--   latency_limited_interactive false  a background/batch-only provider never answers interactively
--   free_allowance_first      true   spend a free allowance before paid capacity
-- The hard floor and the 18+ gate are not here: they are not switches (server/policy/).

CREATE TABLE IF NOT EXISTS provider_controls (
    provider_key text COLLATE "C" PRIMARY KEY,
    enabled boolean,
    tier text COLLATE "C",
    base_url text COLLATE "C",
    model_key text COLLATE "C",
    hourly_usd double precision,
    throughput_tokens_per_hour bigint,
    updated_by text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_inference_rules (
    id text COLLATE "C" PRIMARY KEY,
    private_training boolean NOT NULL DEFAULT false,
    flex_interactive boolean NOT NULL DEFAULT false,
    latency_limited_interactive boolean NOT NULL DEFAULT false,
    free_allowance_first boolean NOT NULL DEFAULT true,
    updated_by text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);
