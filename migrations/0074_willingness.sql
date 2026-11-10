-- phase: expand
-- The 18+ board's measurements (server/willing/): the willingness rates of every offer on the
-- published lawful adult prompt set, and the abliteration tax of each declared base/abliterated pair.
--
-- A rate nobody measured is absent, never zero. The prompt set and the objective set are written
-- beside every row, so a number always says which questions produced it. The jobs are due-based and
-- default off; their last run and claim are rows in job_state, so a deploy does not restart a run.
CREATE TABLE IF NOT EXISTS willingness_rates (
    provider_key      text COLLATE "C" NOT NULL,
    model_key         text COLLATE "C" NOT NULL,
    offer_id          text COLLATE "C",
    prompt_set        text COLLATE "C" NOT NULL,
    prompts           integer NOT NULL DEFAULT 0,   -- how many prompts the set has
    attempts          integer NOT NULL DEFAULT 0,   -- how many were answered
    refusals          integer NOT NULL DEFAULT 0,
    hedges            integer NOT NULL DEFAULT 0,
    refusal_rate      numeric(12, 6),               -- refusals / attempts, null when nothing was answered
    hedge_rate        numeric(12, 6),               -- hedges / attempts, null when nothing was answered
    refusal_ci_lower  numeric(12, 6),
    refusal_ci_upper  numeric(12, 6),
    hedge_ci_lower    numeric(12, 6),
    hedge_ci_upper    numeric(12, 6),
    measured_at       timestamptz NOT NULL,
    measured_on       date NOT NULL,
    updated_at        timestamptz NOT NULL,
    PRIMARY KEY (provider_key, model_key)
);
CREATE INDEX IF NOT EXISTS willingness_rates_measured_idx ON willingness_rates (measured_at DESC);

-- One row per declared pair: the same objective set on the base build and the abliterated build, with
-- the score difference and its interval. The interval is Newcombe's hybrid score interval over the
-- two Wilson intervals; a difference that spans zero does not show a cost.
CREATE TABLE IF NOT EXISTS abliteration_tax (
    pair_id              text COLLATE "C" PRIMARY KEY,
    family               text COLLATE "C",
    base_provider        text COLLATE "C" NOT NULL,
    base_model           text COLLATE "C" NOT NULL,
    abliterated_provider text COLLATE "C" NOT NULL,
    abliterated_model    text COLLATE "C" NOT NULL,
    source               text COLLATE "C" NOT NULL,
    objective_set        text COLLATE "C" NOT NULL,
    n                    integer NOT NULL DEFAULT 0,
    base_passed          integer NOT NULL DEFAULT 0,
    abliterated_passed   integer NOT NULL DEFAULT 0,
    base_rate            numeric(12, 6),
    abliterated_rate     numeric(12, 6),
    difference           numeric(12, 6),
    ci_lower             numeric(12, 6),
    ci_upper             numeric(12, 6),
    measured_at          timestamptz NOT NULL,
    measured_on          date NOT NULL,
    updated_at           timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS abliteration_tax_measured_idx ON abliteration_tax (measured_at DESC);

-- The due/claim rows of the two owner-budget jobs. The table is generic so the next measurement job
-- does not need another migration; only these two ids are written today.
CREATE TABLE IF NOT EXISTS job_state (
    id            text COLLATE "C" PRIMARY KEY,
    last_run_at   timestamptz,
    claimed_until timestamptz,
    claimed_by    text COLLATE "C",
    updated_at    timestamptz NOT NULL
);
INSERT INTO job_state (id, last_run_at, claimed_until, claimed_by, updated_at)
VALUES ('willingness', NULL, NULL, NULL, now()), ('abliteration_tax', NULL, NULL, NULL, now())
ON CONFLICT (id) DO NOTHING;
