-- phase: expand
-- AI Exchange F (P7): a settle Billing could not take is kept here and retried with backoff, with the same
-- idempotency key, until Billing answers 2xx. A 409 or 422 marks the row for review; it is not retried.
-- Expand only: no existing table is touched.
CREATE TABLE IF NOT EXISTS credit_settle_queue (
    id            text PRIMARY KEY,                 -- the settle idempotency key (ai-settle:<request id>)
    hold_id       text NOT NULL,
    request_id    text,
    settle_body   jsonb NOT NULL,                   -- the full POST .../settle body, key included
    attempts      jsonb NOT NULL DEFAULT '[]'::jsonb,
    status        text NOT NULL DEFAULT 'queued',   -- queued | sent | review
    tries         integer NOT NULL DEFAULT 0,
    next_at       timestamptz NOT NULL,
    last_error    text,
    created_at    timestamptz NOT NULL,
    updated_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS credit_settle_queue_due ON credit_settle_queue (status, next_at);
