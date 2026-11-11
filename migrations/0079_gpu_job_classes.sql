-- phase: expand
-- GPU job classes (2026-11-11): a rental is interactive or batch, and a batch job may name where it
-- resumes from. Interruptible capacity is only ever chosen for a batch job with a checkpoint.
-- Additive only: existing rows are interactive and have no checkpoint.
ALTER TABLE gpu_instances ADD COLUMN IF NOT EXISTS job_class text COLLATE "C" NOT NULL DEFAULT 'interactive';
ALTER TABLE gpu_instances ADD COLUMN IF NOT EXISTS checkpoint text COLLATE "C";
ALTER TABLE gpu_instances ADD COLUMN IF NOT EXISTS interruptible boolean NOT NULL DEFAULT false;
ALTER TABLE gpu_requests ADD COLUMN IF NOT EXISTS job_class text COLLATE "C" NOT NULL DEFAULT 'interactive';
ALTER TABLE gpu_requests ADD COLUMN IF NOT EXISTS checkpoint text COLLATE "C";
CREATE INDEX IF NOT EXISTS gpu_instances_class ON gpu_instances (job_class, month);
