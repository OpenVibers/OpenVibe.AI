-- phase: expand
-- Search keys reuse the provider-bound encrypted store, in a namespace excluded from model routing.
ALTER TABLE subject_credentials DROP CONSTRAINT IF EXISTS subject_credentials_provider_check;
ALTER TABLE subject_credentials ADD CONSTRAINT subject_credentials_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'node', 'link', 'deepseek', 'minimax', 'openrouter', 'custom',
                      'gemini', 'mistral', 'xai', 'groq', 'cerebras', 'together', 'fireworks',
                      'search-deepseek', 'search-brave', 'search-exa', 'search-tavily', 'search-serper',
                      'search-serpapi', 'search-jina', 'search-perplexity', 'search-kagi', 'search-google',
                      'search-unsplash', 'search-pexels', 'search-pixabay'));
