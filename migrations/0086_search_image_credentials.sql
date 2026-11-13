-- phase: expand
-- The three image providers whose personal keys are new: SearchAPI.io and TinEye. SerpApi Images and its
-- reverse operation share the existing search-serpapi row.
ALTER TABLE subject_credentials DROP CONSTRAINT IF EXISTS subject_credentials_provider_check;
ALTER TABLE subject_credentials ADD CONSTRAINT subject_credentials_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'node', 'link', 'deepseek', 'minimax', 'openrouter', 'custom',
                      'gemini', 'mistral', 'xai', 'groq', 'cerebras', 'together', 'fireworks',
                      'search-deepseek', 'search-brave', 'search-exa', 'search-tavily', 'search-serper',
                      'search-serpapi', 'search-jina', 'search-perplexity', 'search-kagi', 'search-google',
                      'search-unsplash', 'search-pexels', 'search-pixabay',
                      'search-searchapi', 'search-tineye'));
