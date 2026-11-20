-- phase: expand
-- Wikipedia joins search v2 as a reference engine (11-20): free, its own rate card, version 1, active. A SimpleQA check
-- on production found the right answer missing from the sources a quarter of the time with two shared web engines.
INSERT INTO search_rate_cards (id, engine, version, unit, price, ceiling, currency, "included", source_url, read_on, status, reviewed_by, created_at) VALUES
('src_wikipedia_request_v1', 'wikipedia', 1, 'request', '0', '0', 'USD', NULL, 'https://www.mediawiki.org/wiki/API:Search', '2026-11-20', 'active', 'seed', '2026-11-20T00:00:00.000Z')
ON CONFLICT DO NOTHING;
