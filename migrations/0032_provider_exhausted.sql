-- phase: expand
-- A provider that answered "insufficient balance" is out of money, not flaky: it is opened for the long
-- exhausted cooldown (AI_BREAKER_EXHAUSTED_COOLDOWN_MS, 10 minutes) instead of the ordinary breaker cooldown.
-- exhausted_at records when that happened; a successful (or manually reset) probe clears it. Additive only.
ALTER TABLE provider_health ADD COLUMN exhausted_at bigint;  -- epoch ms of the last "insufficient balance" answer
