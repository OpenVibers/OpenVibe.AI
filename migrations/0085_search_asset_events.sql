-- phase: expand
-- Provider side-effects that must happen once per person and asset: Unsplash's required download event
-- (POST /v1/search/images/unsplash/download). The claim is the idempotency key; a failed call releases it.
CREATE TABLE IF NOT EXISTS search_asset_events (
    scope text COLLATE "C" NOT NULL,
    provider text COLLATE "C" NOT NULL,
    event_key text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (scope, provider, event_key)
);
CREATE INDEX IF NOT EXISTS search_asset_events_created ON search_asset_events(created_at);
