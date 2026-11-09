-- phase: expand
-- Optional expiry; existing keys retain their current lifetime.
ALTER TABLE exchange_api_keys ADD COLUMN IF NOT EXISTS expires_at text;

-- Claim a logical request before taking its hold. Store only a fingerprint and the
-- admitted ceiling; the durable runs table remains the authority for the result.
CREATE TABLE IF NOT EXISTS exchange_key_requests (
 owner text NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL,
 max_cost_usd double precision,
 PRIMARY KEY(owner, idempotency_key)
);
