-- phase: expand
-- Optional role policy. Existing deployments and runs retain their routes.
CREATE TABLE IF NOT EXISTS agent_role_defaults (
    role TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_receipts_effort_created ON ai_receipts (created_at);
