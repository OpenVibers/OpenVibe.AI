-- phase: expand
-- The batch run receipt says which route answered and why, and what an item is waiting for.
ALTER TABLE batch_items ADD COLUMN IF NOT EXISTS route_reason text COLLATE "C";
ALTER TABLE batch_items ADD COLUMN IF NOT EXISTS waiting_reason text COLLATE "C";
