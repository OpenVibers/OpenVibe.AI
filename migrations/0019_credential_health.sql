-- phase: expand
-- L36 Y1/Y8: the health of a person's own provider key, and every provider the console knows.
-- Expand only: the new columns have defaults, so rows and releases before this migration keep working; the
-- provider CHECK is widened to a superset, so an older release's inserts still pass.
--   status       ok | failing | untested: what the last save-time or run-time check found
--   checked_at   when that check ran (ISO 8601 UTC)
--   last_error   the redacted reason it failed (never the key)
--   models_count how many models the provider listed when it was last tested
ALTER TABLE subject_credentials ADD COLUMN IF NOT EXISTS status text COLLATE "C" NOT NULL DEFAULT 'untested';
ALTER TABLE subject_credentials ADD COLUMN IF NOT EXISTS checked_at text COLLATE "C";
ALTER TABLE subject_credentials ADD COLUMN IF NOT EXISTS last_error text COLLATE "C";
ALTER TABLE subject_credentials ADD COLUMN IF NOT EXISTS models_count integer NOT NULL DEFAULT 0;
ALTER TABLE subject_credentials DROP CONSTRAINT IF EXISTS subject_credentials_provider_check;
ALTER TABLE subject_credentials ADD CONSTRAINT subject_credentials_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'node', 'deepseek', 'minimax', 'openrouter', 'custom',
                      'gemini', 'mistral', 'xai', 'groq', 'cerebras', 'together', 'fireworks'));
