-- phase: expand
-- What each search v2 depth really costs and takes (plan AD.34 item 5), kept across restarts: production starts AI
-- without a Valkey client, so the in-process lists emptied on every deploy (11-20). One row per answered v2 search:
-- the depth, the output (results or answer), its receipt's cost in nano-USD and its time. No query, no person.
-- server/search/depth-stats.js keeps the newest 200 per depth and output and deletes the rest as it adds.
CREATE TABLE IF NOT EXISTS search_depth_samples (
    id bigserial PRIMARY KEY,
    depth text COLLATE "C" NOT NULL,
    output text COLLATE "C" NOT NULL,
    cost_nano bigint NOT NULL,
    time_ms integer NOT NULL,
    at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS search_depth_samples_slot ON search_depth_samples (depth, output, at DESC, id DESC);
