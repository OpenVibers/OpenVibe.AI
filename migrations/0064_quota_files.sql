-- phase: expand
-- Files on an AI turn (ai.file@1): per-person attachment limits live in the existing quota system.
-- A quota may cap the number of files (max_files) and their total bytes (max_file_bytes) in its
-- window; usage_counters gains the running totals the same way it counts requests, tokens and cost.
-- Both are nullable, so every existing quota keeps meaning exactly what it meant before.
ALTER TABLE quotas ADD COLUMN IF NOT EXISTS max_files bigint;
ALTER TABLE quotas ADD COLUMN IF NOT EXISTS max_file_bytes bigint;
ALTER TABLE usage_counters ADD COLUMN IF NOT EXISTS files bigint NOT NULL DEFAULT 0;
ALTER TABLE usage_counters ADD COLUMN IF NOT EXISTS file_bytes bigint NOT NULL DEFAULT 0;
