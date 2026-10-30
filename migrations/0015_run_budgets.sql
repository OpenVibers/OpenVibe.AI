-- phase: expand
-- The budget one Codes run token carries (Codes C3), and what that run has spent.
--
-- The budget is a row, not a claim on the token: Codes registers it under the token's jti when it mints the
-- token, and the row is what the meter counts against. A holder of the token cannot write the row (only the
-- service Codes writes it, with its own token) and cannot name another run's row (the jti is signed inside
-- the token by Network). The row dies with the token: expires_at is the token's expiry.
CREATE TABLE IF NOT EXISTS run_budgets (
    jti            text COLLATE "C" PRIMARY KEY,   -- the run token's jti (signed inside the token)
    budget_usd     double precision,                -- null: no dollar cap
    budget_tokens  bigint,                          -- null: no token cap
    spent_usd      double precision NOT NULL DEFAULT 0,
    spent_tokens   bigint NOT NULL DEFAULT 0,
    expires_at     bigint NOT NULL,                 -- epoch seconds: the token's expiry
    created_at     text COLLATE "C" NOT NULL,
    updated_at     text COLLATE "C" NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_budgets_expires ON run_budgets (expires_at);
