-- phase: expand
-- A batch can be cancelled: the prompts that had not run are cancelled, and nothing is charged for them.
--
-- The check on the status of a batch and of one of its prompts learns the new value. Nothing else changes: a
-- batch that is cancelled keeps the answers it already has, and the prompts that already answered keep their
-- status and their charge.
ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_status_check;
ALTER TABLE batches ADD CONSTRAINT batches_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'expired', 'cancelled'));
ALTER TABLE batch_items DROP CONSTRAINT IF EXISTS batch_items_status_check;
ALTER TABLE batch_items ADD CONSTRAINT batch_items_status_check
    CHECK (status IN ('queued', 'waiting', 'running', 'succeeded', 'failed', 'expired', 'cancelled'));
