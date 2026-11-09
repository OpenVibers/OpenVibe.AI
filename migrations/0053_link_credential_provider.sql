-- phase: expand
-- The owner-owned machine provider is Link. Rewrite the few existing rows in place;
-- encrypted credentials belong to other providers and are not touched.
ALTER TABLE subject_credentials DROP CONSTRAINT IF EXISTS subject_credentials_provider_check;
ALTER TABLE subject_credentials ADD CONSTRAINT subject_credentials_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'node', 'link', 'deepseek', 'minimax', 'openrouter', 'custom',
                      'gemini', 'mistral', 'xai', 'groq', 'cerebras', 'together', 'fireworks'));
UPDATE subject_credentials
SET provider = 'link', spend_key = regexp_replace(spend_key, ':node$', ':link')
WHERE provider = 'node';
