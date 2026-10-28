-- phase: expand
-- BENCH-11 (plan §4.12 and §4.7): a route can learn from OpenVibe.Bench's measured outcomes.
-- Bench publishes bench.rating.changed; AI keeps the latest rating and cost-per-solved it has seen per
-- kind/category/model, and only a route that opts in (routes.learn_from_bench) consults it during placement.
-- The inbox is openvibe-sdk/events.inboxSchema('bench_event_inbox'): a redelivered event is a no-op.
CREATE TABLE IF NOT EXISTS bench_evidence (
    kind_id         text COLLATE "C" NOT NULL,             -- bench.kind@1's id, e.g. chat.reply
    category        text COLLATE "C" NOT NULL DEFAULT 'all', -- bench.rating@1's category (the board's task class)
    model           text COLLATE "C" NOT NULL,             -- bench.rating@1's subject: the model rated
    provider        text COLLATE "C" NOT NULL DEFAULT '',  -- AI's provider for that model, '' when unknown/ambiguous
    rating          double precision NOT NULL,             -- Elo
    ci_lower        double precision,
    ci_upper        double precision,
    games           bigint NOT NULL DEFAULT 0,
    provisional     bigint NOT NULL DEFAULT 0,             -- Bench's flag; games < 10 is provisional too
    cost_per_solved double precision,                      -- USD from GET /api/v1/boards/:kind?type=cost
    updated_at      text COLLATE "C" NOT NULL,             -- the event's at (ISO-8601)
    PRIMARY KEY (kind_id, category, model, provider)
);
CREATE INDEX IF NOT EXISTS bench_evidence_kind ON bench_evidence (kind_id, category);

CREATE TABLE IF NOT EXISTS bench_event_inbox (
    consumer     text NOT NULL,
    event_id     text NOT NULL,
    processed_at bigint NOT NULL,
    PRIMARY KEY (consumer, event_id)
);

-- The opt-in is per route version, default off. bench_kind names the board to learn from; when it is
-- null, AI infers it from the route key or its operation (chat.reply for chat/generate/...).
ALTER TABLE routes ADD COLUMN IF NOT EXISTS learn_from_bench bigint NOT NULL DEFAULT 0;
ALTER TABLE routes ADD COLUMN IF NOT EXISTS bench_kind text COLLATE "C";
ALTER TABLE routes ADD COLUMN IF NOT EXISTS bench_category text COLLATE "C";
