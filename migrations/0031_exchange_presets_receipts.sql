-- phase: expand
-- The Exchange's saved routing profiles (presets) and the receipt of every answered request
-- (the plan of 2026-11-06, "Product lines and features", item 1).
--
-- ai_presets  one row per named preset per owner: an account (a person), a Network project or a service.
--              The policy is JSON, so a new knob adds without a migration. The service's five built-in
--              presets (cheapest, fastest, private, uncensored, eu-only) are not rows: they are code
--              (server/exchange/presets.js), so they cannot be edited away by an owner.
--
-- ai_receipts one row per answered request: the offer, the price, the tokens, the cache, the latency,
--              why the router chose it, the fallbacks it would have used, the payer, the BYOK label and
--              the privacy label. It never carries the prompt or the answer. It is kept with the usage
--              (the same retention window as the runs) and read by GET /v1/receipts/:id.
--
-- Additive only: two new tables and one new column on runs.
CREATE TABLE IF NOT EXISTS ai_presets (
    owner_type text COLLATE "C" NOT NULL,          -- 'user' (an account), 'project' (a Network project), 'service'
    owner_id   text COLLATE "C" NOT NULL,
    name       text COLLATE "C" NOT NULL,          -- the preset's name: cheapest, fastest, private, ...
    policy     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_type, owner_id, name)
);

CREATE TABLE IF NOT EXISTS ai_receipts (
    id             text COLLATE "C" PRIMARY KEY,   -- rcpt_<run id>: the same answer always has the same receipt
    run_id         text COLLATE "C",
    requester_type text COLLATE "C",
    requester_id   text COLLATE "C",
    owner_type     text COLLATE "C",               -- who the answer was for (a person), when there is one
    owner_id       text COLLATE "C",
    body           jsonb NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_receipts_run_idx ON ai_receipts (run_id);
CREATE INDEX IF NOT EXISTS ai_receipts_owner_idx ON ai_receipts (owner_type, owner_id, created_at DESC);

-- The run points at its receipt, so the usage page and the run's own record can find it.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS receipt_id text COLLATE "C";
