-- phase: expand
-- Deep dive runs (workflow design.deep_dive): the live state of one run, its chosen sites and its report.
-- The run table keeps the input, output and receipt; this row is what the page reads while the run is still
-- working (step progress, candidates, captures), so a restart or a deploy loses nothing. One row per run;
-- capture_cache holds the 7-day screenshot cache per URL, viewport and theme.
CREATE TABLE deep_dives (
    id text COLLATE "C" PRIMARY KEY,
    run_id text COLLATE "C" NOT NULL UNIQUE,
    owner_type text COLLATE "C",
    owner_id text COLLATE "C",
    status text COLLATE "C" NOT NULL DEFAULT 'queued',
    step text COLLATE "C",
    progress double precision NOT NULL DEFAULT 0,
    question text COLLATE "C" NOT NULL,
    depth text COLLATE "C" NOT NULL,
    site_limit integer NOT NULL,
    price_usd numeric(12, 6) NOT NULL DEFAULT 0,
    steps jsonb NOT NULL DEFAULT '[]'::jsonb,
    candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
    decision_at timestamptz,
    captures jsonb NOT NULL DEFAULT '[]'::jsonb,
    report jsonb,
    gaps jsonb NOT NULL DEFAULT '[]'::jsonb,
    error_code text COLLATE "C",
    error_detail text COLLATE "C",
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    finished_at timestamptz
);
CREATE INDEX deep_dives_owner ON deep_dives(owner_type, owner_id, created_at DESC);

CREATE TABLE capture_cache (
    key text COLLATE "C" PRIMARY KEY,
    url text COLLATE "C" NOT NULL,
    viewport integer NOT NULL,
    theme text COLLATE "C" NOT NULL,
    extras boolean NOT NULL DEFAULT false,
    result jsonb NOT NULL,
    captured_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE INDEX capture_cache_expiry ON capture_cache(expires_at);
