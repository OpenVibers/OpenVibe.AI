-- phase: expand
-- The idempotency key of ai.call-report@1 (Contracts 0.421.0, ai-metrics.md): a product reports an AI call it
-- made without OpenVibe.AI, and AI records it once. SYSTEM + RUN_ID (or TURN_ID, for a harness turn) is the key:
-- a report delivered twice inserts nothing the second time and is counted as a duplicate. The rows are small and
-- are kept for 30 days (POST /api/v1/usage/calls prunes older ones), long enough for a retrying sender.
CREATE TABLE IF NOT EXISTS ai_usage_reported_calls (
    system text COLLATE "C" NOT NULL,
    call_key text COLLATE "C" NOT NULL,
    run_id text COLLATE "C",
    turn_id text COLLATE "C",
    received_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (system, call_key),
    CHECK (run_id IS NOT NULL OR turn_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ai_usage_reported_calls_received ON ai_usage_reported_calls(received_at);
