-- phase: expand
-- Auto's decision step (plan 16d): one calibrated yes/no question before an openvibe/auto request picks between a
-- cheaper and a stronger model (server/routing/auto-decision.js).
--
-- route_thresholds: the p a task kind's cheaper model needs, seeded 0.7 (no row = 0.7), re-fitted weekly from the
-- outcomes below. The empty kind '' only marks a weekly fit that had nothing to fit.
CREATE TABLE IF NOT EXISTS route_thresholds (
    kind text COLLATE "C" PRIMARY KEY,
    threshold double precision NOT NULL CHECK (threshold > 0 AND threshold <= 1),
    budget_usd_per_1k double precision,
    n integer NOT NULL DEFAULT 0,
    updated_at text COLLATE "C" NOT NULL,
    fitted_at text COLLATE "C"
);

-- route_decisions: one row per decision. No request text: the person and the prompt are hashes, kept only to see the
-- same person asking the same thing again within 10 minutes (outcome 'retried'); a product may report 'good' or 'bad'.
-- Kept 120 days (the fit reads the last 28).
CREATE TABLE IF NOT EXISTS route_decisions (
    id text COLLATE "C" PRIMARY KEY,
    kind text COLLATE "C" NOT NULL,
    p double precision NOT NULL,
    threshold double precision NOT NULL,
    picked text COLLATE "C" NOT NULL CHECK (picked IN ('cheap', 'strong')),
    explore integer NOT NULL DEFAULT 0,
    decision_cost_usd double precision NOT NULL DEFAULT 0,
    cheap_offer text COLLATE "C" NOT NULL,
    strong_offer text COLLATE "C" NOT NULL,
    cheap_cost_usd double precision,
    strong_cost_usd double precision,
    subject_hash text COLLATE "C",
    prompt_hash text COLLATE "C" NOT NULL,
    outcome text COLLATE "C" CHECK (outcome IS NULL OR outcome IN ('good', 'bad', 'retried')),
    created_at text COLLATE "C" NOT NULL
);
CREATE INDEX IF NOT EXISTS route_decisions_retry ON route_decisions (subject_hash, prompt_hash, created_at);
CREATE INDEX IF NOT EXISTS route_decisions_kind ON route_decisions (kind, created_at);
