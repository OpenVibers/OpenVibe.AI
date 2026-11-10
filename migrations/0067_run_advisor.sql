-- phase: expand
-- The advisor (ai.advisor@1, plan AL3): one row per advice call on a run. The row is on the run's receipt
-- and explain; the advice itself is answered to the caller and never stored. advice_run_id is the ai.chat
-- run that made the call, so its own receipt, quota and usage record hold the price. seq is the 1-based use
-- number and is unique per run (at most 3).
CREATE TABLE IF NOT EXISTS run_advisor_uses (
    id text PRIMARY KEY,
    run_id text NOT NULL,
    seq integer NOT NULL,
    advice_run_id text,
    model text,
    effort text,
    tokens_in integer NOT NULL DEFAULT 0,
    tokens_out integer NOT NULL DEFAULT 0,
    cost_usd numeric NOT NULL DEFAULT 0,
    words integer,
    created_at text NOT NULL,
    UNIQUE (run_id, seq)
);
CREATE INDEX IF NOT EXISTS run_advisor_uses_run ON run_advisor_uses (run_id);
CREATE INDEX IF NOT EXISTS run_advisor_uses_advice_run ON run_advisor_uses (advice_run_id);
