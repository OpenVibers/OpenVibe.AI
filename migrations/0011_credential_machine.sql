-- phase: expand
-- AI on your own machines (contracts 0.220.0): a person's own provider may be their own machine, provider node with the
-- machine it runs on (a dev_ id on OpenVibe.Bot). It has no key: key_enc and key_hint stay empty for it.
ALTER TABLE subject_credentials DROP CONSTRAINT IF EXISTS subject_credentials_provider_check;
ALTER TABLE subject_credentials ADD CONSTRAINT subject_credentials_provider_check CHECK (provider IN ('openai', 'anthropic', 'node'));
ALTER TABLE subject_credentials ADD COLUMN IF NOT EXISTS machine text COLLATE "C";
