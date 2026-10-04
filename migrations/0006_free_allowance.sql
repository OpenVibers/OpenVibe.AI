-- phase: expand
-- T6 step 2 / §2.1.8: the provider free allowance a subject has used, per provider, metric and reset period
-- (server/free-allowance.js). account() claims from it in the transaction that accounts a run; the free share is
-- reported as free_allowance_used on the run's platform.usage-sample@1 and never priced on its cost_estimate.
-- Pricing only, never admission: no request is refused because of this table. Additive only: a new table.
CREATE TABLE IF NOT EXISTS free_allowance_usage (
    subject      text COLLATE "C" NOT NULL,   -- attributionKey | actorKey | requesterType:requesterId
    provider     text COLLATE "C" NOT NULL,
    metric       text COLLATE "C" NOT NULL,   -- the card's metric: input-tokens[:model] | cached-input-tokens[:model] | output-tokens[:model]
    period_start bigint NOT NULL,             -- epoch ms: the card's reset period start
    period_end   bigint NOT NULL,             -- epoch ms: its end (reset_period 'none': the card's effective_until, else never)
    free_used    bigint NOT NULL DEFAULT 0,   -- tokens, never more than the card's free_allowance
    updated_at   text COLLATE "C" NOT NULL,
    PRIMARY KEY (subject, provider, metric, period_start)
);
CREATE INDEX IF NOT EXISTS idx_free_allowance_period ON free_allowance_usage (period_end);
