-- phase: expand
-- Versioned rate cards for the search engines (plan §W.2 step 3, 11-13): what one unit of an engine costs,
-- the conservative ceiling a hold reserves, the currency, the monthly allowance, the page it was read on and
-- the day it was read. A card is never edited: a new price is a new version, a draft until the owner
-- activates it, and activating it retires the card it replaces. One ACTIVE card per (engine, unit).
--
-- Version 1 is the price every adapter carried before the clean cut (its price per 1,000 as a per-unit
-- decimal, its own unit, the day its page was read), so nothing about today's prices changes. The prices are
-- text, never a float: the money is integer nano-USD, parsed like max_cost_usd.
CREATE TABLE IF NOT EXISTS search_rate_cards (
    id text COLLATE "C" PRIMARY KEY,
    engine text COLLATE "C" NOT NULL,
    version integer NOT NULL,
    unit text COLLATE "C" NOT NULL,
    price text COLLATE "C" NOT NULL,
    ceiling text COLLATE "C" NOT NULL,
    currency text COLLATE "C" NOT NULL DEFAULT 'USD',
    "included" text COLLATE "C",
    source_url text COLLATE "C",
    read_on date NOT NULL,
    status text COLLATE "C" NOT NULL DEFAULT 'draft',
    reviewed_by text COLLATE "C",
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS search_rate_cards_version ON search_rate_cards (engine, unit, version);
CREATE UNIQUE INDEX IF NOT EXISTS search_rate_cards_active ON search_rate_cards (engine, unit) WHERE status = 'active';
INSERT INTO search_rate_cards (id, engine, version, unit, price, ceiling, currency, "included", source_url, read_on, status, reviewed_by, created_at) VALUES
('src_openverse_result_v1', 'openverse', 1, 'result', '0', '0', 'USD', NULL, 'https://api.openverse.org/', '2026-11-09', 'active', 'seed', '2026-11-09T00:00:00.000Z'),
('src_commons_result_v1', 'commons', 1, 'result', '0', '0', 'USD', NULL, 'https://www.mediawiki.org/wiki/API:Main_page', '2026-11-09', 'active', 'seed', '2026-11-09T00:00:00.000Z'),
('src_searxng_request_v1', 'searxng', 1, 'request', '0', '0', 'USD', NULL, 'https://docs.searxng.org/', '2026-11-09', 'active', 'seed', '2026-11-09T00:00:00.000Z'),
('src_openvibe_request_v1', 'openvibe', 1, 'request', '0', '0', 'USD', NULL, 'https://search.openvibe.network', '2026-11-12', 'active', 'seed', '2026-11-12T00:00:00.000Z'),
('src_iconify_result_v1', 'iconify', 1, 'result', '0', '0', 'USD', NULL, 'https://iconify.design/docs/api/', '2026-11-09', 'active', 'seed', '2026-11-09T00:00:00.000Z'),
('src_deepseek_request_v1', 'deepseek', 1, 'request', '0.00075', '0.00075', 'USD', NULL, 'https://api-docs.deepseek.com/guides/search/', '2026-11-09', 'active', 'seed', '2026-11-09T00:00:00.000Z'),
('src_brave_request_v1', 'brave', 1, 'request', '0.005', '0.005', 'USD', '$5 monthly credit', 'https://api-dashboard.search.brave.com/app/plans', '2026-11-09', 'active', 'seed', '2026-11-09T00:00:00.000Z'),
('src_exa_request_v1', 'exa', 1, 'request', '0.007', '0.007', 'USD', NULL, 'https://exa.ai/docs/admin/pricing', '2026-11-09', 'active', 'seed', '2026-11-09T00:00:00.000Z'),
('src_tavily_request_v1', 'tavily', 1, 'request', '0.008', '0.008', 'USD', '1,000 credits a month', 'https://www.tavily.com/pricing', '2026-11-09', 'active', 'seed', '2026-11-09T00:00:00.000Z'),
('src_serper_request_v1', 'serper', 1, 'request', '0.001', '0.001', 'USD', NULL, 'https://serper.dev/', '2026-11-09', 'active', 'seed', '2026-11-09T00:00:00.000Z'),
('src_serpapi_request_v1', 'serpapi', 1, 'request', '0.025', '0.025', 'USD', '250 searches a month', 'https://serpapi.com/pricing', '2026-11-09', 'active', 'seed', '2026-11-09T00:00:00.000Z'),
('src_jina_request_v1', 'jina', 1, 'request', '0.0005', '0.005', 'USD', NULL, 'https://jina.ai/reader/#apiform', '2026-11-09', 'active', 'seed', '2026-11-09T00:00:00.000Z'),
('src_openvibe-egress_page_v1', 'openvibe-egress', 1, 'page', '0', '0', 'USD', NULL, 'https://openvibe.exchange', '2026-11-09', 'active', 'seed', '2026-11-09T00:00:00.000Z'),
('src_perplexity_request_v1', 'perplexity', 1, 'request', '0.0025', '0.1', 'USD', NULL, 'https://docs.perplexity.ai/docs/getting-started/pricing', '2026-11-09', 'active', 'seed', '2026-11-09T00:00:00.000Z'),
('src_kagi_request_v1', 'kagi', 1, 'request', '0.025', '0.025', 'USD', NULL, 'https://help.kagi.com/kagi/api/search-legacy.html', '2026-11-09', 'active', 'seed', '2026-11-09T00:00:00.000Z'),
('src_google_request_v1', 'google', 1, 'request', '0.005', '0.005', 'USD', NULL, 'https://developers.google.com/custom-search/v1/overview', '2026-11-09', 'active', 'seed', '2026-11-09T00:00:00.000Z'),
('src_unsplash_result_v1', 'unsplash', 1, 'result', '0', '0', 'USD', NULL, 'https://unsplash.com/documentation#search-photos', '2026-11-13', 'active', 'seed', '2026-11-13T00:00:00.000Z'),
('src_pexels_result_v1', 'pexels', 1, 'result', '0', '0', 'USD', NULL, 'https://www.pexels.com/api/', '2026-11-09', 'active', 'seed', '2026-11-09T00:00:00.000Z'),
('src_pixabay_result_v1', 'pixabay', 1, 'result', '0', '0', 'USD', NULL, 'https://pixabay.com/api/docs/', '2026-11-13', 'active', 'seed', '2026-11-13T00:00:00.000Z'),
('src_brave-images_request_v1', 'brave-images', 1, 'request', '0.005', '0.005', 'USD', '$5 monthly credit', 'https://api-dashboard.search.brave.com/app/plans', '2026-11-09', 'active', 'seed', '2026-11-09T00:00:00.000Z'),
('src_meta_request_v1', 'meta', 1, 'request', '0.0025', '4', 'USD', NULL, 'https://dev.meta.ai/docs/pricing-rate-limits', '2026-11-10', 'active', 'seed', '2026-11-10T00:00:00.000Z'),
('src_serper-images_request_v1', 'serper-images', 1, 'request', '0.001', '0.001', 'USD', NULL, 'https://serper.dev/', '2026-11-10', 'active', 'seed', '2026-11-10T00:00:00.000Z'),
('src_serpapi-images_request_v1', 'serpapi-images', 1, 'request', '0.025', '0.025', 'USD', '250 searches a month', 'https://serpapi.com/google-images-api', '2026-11-13', 'active', 'seed', '2026-11-13T00:00:00.000Z'),
('src_searchapi-images_request_v1', 'searchapi-images', 1, 'request', '0.004', '0.004', 'USD', '100 trial searches', 'https://www.searchapi.io/docs/google-images', '2026-11-13', 'active', 'seed', '2026-11-13T00:00:00.000Z'),
('src_serpapi-reverse_request_v1', 'serpapi-reverse', 1, 'request', '0.025', '0.025', 'USD', '250 searches a month', 'https://serpapi.com/google-reverse-image', '2026-11-13', 'active', 'seed', '2026-11-13T00:00:00.000Z'),
('src_tineye_request_v1', 'tineye', 1, 'request', '0.04', '0.04', 'USD', NULL, 'https://api.tineye.com/python/docs/', '2026-11-13', 'active', 'seed', '2026-11-13T00:00:00.000Z'),
('src_mojeek_request_v1', 'mojeek', 1, 'request', '0.00265', '0.00265', 'USD (Mojeek publishes in GBP: £2.00 per 1,000 requests at 1 GBP = 1.3227 USD, ECB reference rate read 2026-11-13)', 'Free credit on the Startup plan', 'https://www.mojeek.com/services/search/web-search-api', '2026-11-13', 'active', 'seed', '2026-11-13T00:00:00.000Z'),
('src_parallel_request_v1', 'parallel', 1, 'request', '0.001', '0.001', 'USD', NULL, 'https://docs.parallel.ai/getting-started/pricing', '2026-11-13', 'active', 'seed', '2026-11-13T00:00:00.000Z'),
('src_you_request_v1', 'you', 1, 'request', '0.005', '0.005', 'USD', NULL, 'https://you.com/docs/administration/billing', '2026-11-13', 'active', 'seed', '2026-11-13T00:00:00.000Z'),
('src_dataforseo_request_v1', 'dataforseo', 1, 'request', '0.002', '0.002', 'USD', NULL, 'https://dataforseo.com/pricing/google-serp/google-organic-serp-api', '2026-11-13', 'active', 'seed', '2026-11-13T00:00:00.000Z'),
('src_europeana_result_v1', 'europeana', 1, 'result', '0', '0', 'USD', NULL, 'https://api.europeana.eu/record/v2/search.json', '2026-11-13', 'active', 'seed', '2026-11-13T00:00:00.000Z'),
('src_nasa_result_v1', 'nasa', 1, 'result', '0', '0', 'USD', NULL, 'https://images.nasa.gov/docs/images.nasa.gov_api_docs.pdf', '2026-11-13', 'active', 'seed', '2026-11-13T00:00:00.000Z'),
('src_dataforseo-images_request_v1', 'dataforseo-images', 1, 'request', '0.002', '0.002', 'USD', NULL, 'https://dataforseo.com/pricing/google-serp/google-images-serp-api', '2026-11-13', 'active', 'seed', '2026-11-13T00:00:00.000Z'),
('src_smithsonian_result_v1', 'smithsonian', 1, 'result', '0', '0', 'USD', NULL, 'https://www.si.edu/openaccess/devtools', '2026-11-13', 'active', 'seed', '2026-11-13T00:00:00.000Z');
