-- phase: expand
-- The SDK's outbox status().rejected counts SELECT count(*) FROM event_outbox WHERE rejected_at IS NOT NULL.
-- Without an index on rejected_at that count reads the whole outbox (0 rejected rows still cost 523 ms and
-- 112 M buffers a day on Deals on 2026-11-08). This partial index holds only rejected rows, so the count is an
-- index-only scan over an index that is usually empty. openvibe-sdk 0.99.0 adds the same index to outboxSchema()
-- for new outboxes; this table already exists, so the statement goes here.
CREATE INDEX IF NOT EXISTS event_outbox_rejected ON event_outbox (rejected_at) WHERE rejected_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS usage_sample_outbox_rejected ON usage_sample_outbox (rejected_at) WHERE rejected_at IS NOT NULL;
