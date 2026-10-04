-- phase: expand
-- T5 lane F: AI → Billing usage readings (platform.usage-sample@1, server/usage-samples.js). A second outbox with the
-- same shape as event_outbox (openvibe-sdk outboxSchema). Its relay posts each row to billing.usage.record. event_id is
-- the reading's idempotency_key (ai:<run id>:tokens). runs.usage_sample_id names the reading a run produced.
-- Additive only: a new table and a nullable column; no existing row is rewritten.
CREATE TABLE IF NOT EXISTS usage_sample_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS usage_sample_outbox_due ON usage_sample_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS usage_sample_outbox_sent ON usage_sample_outbox (sent_at) WHERE sent_at IS NOT NULL;
ALTER TABLE runs ADD COLUMN usage_sample_id text COLLATE "C";
