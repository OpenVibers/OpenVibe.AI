-- phase: expand
-- Video analyses (workflow video.analyze): the live state of one run, its frames and its report.
-- The run table keeps the input, output and receipt; this row is what the page reads while the run is
-- still working (step progress, the frames as they land), so a restart or a deploy loses nothing.
-- One row per run.
CREATE TABLE video_analyses (
    id text COLLATE "C" PRIMARY KEY,
    run_id text COLLATE "C" NOT NULL UNIQUE,
    owner_type text COLLATE "C",
    owner_id text COLLATE "C",
    status text COLLATE "C" NOT NULL DEFAULT 'queued',
    step text COLLATE "C",
    progress double precision NOT NULL DEFAULT 0,
    media_id text COLLATE "C",
    depth text COLLATE "C" NOT NULL DEFAULT 'standard',
    input jsonb NOT NULL DEFAULT '{}'::jsonb,
    steps jsonb NOT NULL DEFAULT '[]'::jsonb,
    frames jsonb NOT NULL DEFAULT '[]'::jsonb,
    report jsonb,
    gaps jsonb NOT NULL DEFAULT '[]'::jsonb,
    error_code text COLLATE "C",
    error_detail text COLLATE "C",
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    finished_at timestamptz
);
CREATE INDEX video_analyses_owner ON video_analyses(owner_type, owner_id, created_at DESC);
