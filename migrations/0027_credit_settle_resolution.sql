-- phase: expand
-- AI Exchange operations console (P7): a person has looked at a settle row in review and resolved it.
-- The settle is never retried from here; these columns say who ended the review and when. Additive only.
ALTER TABLE credit_settle_queue ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE credit_settle_queue ADD COLUMN IF NOT EXISTS resolved_by text;
