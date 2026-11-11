-- phase: expand
-- Early model sightings are separate from provider-listed registry models and never enable routing.
CREATE TABLE model_spots (
    id text COLLATE "C" PRIMARY KEY,
    provider_key text COLLATE "C" NOT NULL,
    model_key text COLLATE "C" NOT NULL,
    display_name text COLLATE "C" NOT NULL,
    status text COLLATE "C" NOT NULL DEFAULT 'spotted' CHECK (status IN ('spotted', 'promoted', 'dismissed')),
    sources_json text COLLATE "C" NOT NULL DEFAULT '[]',
    first_seen_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);
CREATE INDEX model_spots_recent ON model_spots(last_seen_at DESC);
CREATE TABLE model_discovery_runs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at timestamptz NOT NULL,
    finished_at timestamptz,
    status text COLLATE "C" NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
    sources_read integer NOT NULL DEFAULT 0,
    spotted integer NOT NULL DEFAULT 0
);
