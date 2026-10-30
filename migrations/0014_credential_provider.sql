-- phase: expand
-- Codes C3 (contracts 0.241.0 ai.credential-put@2): one credential per provider. A person's key now has a provider
-- dimension, so the same owner and subject may hold an anthropic, openai, deepseek, minimax, openrouter or custom key
-- side by side. The row a pre-C3 caller stored stays the default one (the route without a provider reads it), and its
-- spend keeps the provider_key its requests were already logged under (byo:<owner>:<subject>); a row added per provider
-- logs under byo:<owner>:<subject>:<provider>. Only an expand step: the old key_enc format (v1, bound to owner and
-- subject) is read and rewritten as v2 (bound to owner, subject and provider) on first use, in server/credentials.js.
ALTER TABLE subject_credentials ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;
ALTER TABLE subject_credentials ADD COLUMN IF NOT EXISTS spend_key text COLLATE "C" NOT NULL DEFAULT '';
UPDATE subject_credentials SET spend_key = 'byo:' || owner || ':' || subject WHERE spend_key = '';
-- Before this migration there is one row per (owner, subject): it becomes the default.
UPDATE subject_credentials c SET is_default = true
  WHERE NOT EXISTS (SELECT 1 FROM subject_credentials d WHERE d.owner = c.owner AND d.subject = c.subject AND d.is_default);
ALTER TABLE subject_credentials DROP CONSTRAINT IF EXISTS subject_credentials_pkey;
ALTER TABLE subject_credentials ADD CONSTRAINT subject_credentials_pkey PRIMARY KEY (owner, subject, provider);
ALTER TABLE subject_credentials DROP CONSTRAINT IF EXISTS subject_credentials_provider_check;
ALTER TABLE subject_credentials ADD CONSTRAINT subject_credentials_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'node', 'deepseek', 'minimax', 'openrouter', 'custom'));
CREATE UNIQUE INDEX IF NOT EXISTS subject_credentials_default_idx ON subject_credentials (owner, subject) WHERE is_default;
