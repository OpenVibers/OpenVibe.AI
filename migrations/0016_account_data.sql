-- phase: expand
-- OpenVibe.AI: the receipts of the ADR-033 account export and deletion deliveries this service applied
-- (openvibe-sdk/account-data's ACCOUNT_DATA_SCHEMA), so a redelivered export or deletion changes nothing.
-- The row holds an export_id or deletion_id, the subject and the counts sent to Network; it is not a secret.

CREATE TABLE IF NOT EXISTS account_data_events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    outcome JSONB,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ
);
