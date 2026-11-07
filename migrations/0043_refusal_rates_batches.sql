-- phase: expand
-- The measured refusal rates of every offer, and the half-price batches.
--
-- The refusal job measures what each offer actually refuses (server/refusal/): a fixed, published probe
-- set, no person's data, and the rate with the day it was measured. Like the price book, the job is
-- due-based: its last run is a row here, not a moment in memory, so the week survives the several
-- deploys a day this service gets.
--
-- The batches are many prompts answered later, at half the retail price. They are billed through
-- Billing like every other request: this table is the queue and the status, not a second ledger.
CREATE TABLE IF NOT EXISTS refusal_state (
    id              text COLLATE "C" PRIMARY KEY CHECK (id = 'refusal'),   -- one row
    last_run_at     timestamptz,       -- when the last run finished (null before the first one)
    claimed_until   timestamptz,       -- while this is in the future, an instance holds the run
    claimed_by      text COLLATE "C",  -- the instance that holds it
    updated_at      timestamptz NOT NULL
);
INSERT INTO refusal_state (id, last_run_at, claimed_until, claimed_by, updated_at)
VALUES ('refusal', NULL, NULL, NULL, now()) ON CONFLICT (id) DO NOTHING;

-- One row per measured offer: the rate, the counts it came from, the day it was measured and the probe
-- set it was measured with. A rate nobody measured is absent, never zero.
CREATE TABLE IF NOT EXISTS refusal_rates (
    provider_key    text COLLATE "C" NOT NULL,   -- the registry provider that served the offer
    model_key       text COLLATE "C" NOT NULL,   -- the registry model of that offer
    offer_id        text COLLATE "C",            -- the exact artifact id, when the row has one
    refusals        integer NOT NULL DEFAULT 0,  -- the probes the offer refused
    attempts        integer NOT NULL DEFAULT 0,  -- the probes it was asked
    refusal_rate    numeric(12, 6),               -- refusals / attempts, null when nothing was measured
    prompt_set      text COLLATE "C" NOT NULL,   -- the probe set it was measured with
    measured_at     timestamptz NOT NULL,        -- when it was measured
    measured_on     date NOT NULL,               -- the same day, for the public catalog
    updated_at      timestamptz NOT NULL,
    PRIMARY KEY (provider_key, model_key)
);
CREATE INDEX IF NOT EXISTS refusal_rates_measured_idx ON refusal_rates (measured_at DESC);

-- A batch: many prompts, answered later, at half the retail price. The owner is the person or the
-- project that pays for it (Billing's hold names the same subject), and the cap is the number of
-- prompts one batch may carry.
CREATE TABLE IF NOT EXISTS batches (
    id              text COLLATE "C" PRIMARY KEY,       -- bat_<id>
    owner_type      text COLLATE "C" NOT NULL CHECK (owner_type IN ('user', 'app')),
    owner_id        text COLLATE "C" NOT NULL,
    project_id      text COLLATE "C",                    -- the project's Balance, for an app's batch
    status          text COLLATE "C" NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'expired')),
    items           integer NOT NULL,                    -- how many prompts the batch carries
    discount        text COLLATE "C" NOT NULL DEFAULT 'half',   -- the price the batch is charged at
    deadline_at     timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
                    -- when the prompts give up: after this they expire, uncharged, unless the owner's
                    -- loss budget says the network may run them on regular capacity and absorb the difference
    ran_on_regular_capacity boolean NOT NULL DEFAULT false,
                    -- true when at least one item ran on regular capacity (the loss budget paid for it)
    absorbed_nano_usd bigint NOT NULL DEFAULT 0,         -- what the network absorbed, over the whole batch
    claimed_until   timestamptz,                        -- while this is in the future, an instance holds the batch
    claimed_by      text COLLATE "C",
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    finished_at     timestamptz
);
CREATE INDEX IF NOT EXISTS batches_queue_idx ON batches (status, created_at);
CREATE INDEX IF NOT EXISTS batches_owner_idx ON batches (owner_type, owner_id, created_at DESC);

-- One row per prompt of a batch: what was asked, which run answered it, and what it cost.
CREATE TABLE IF NOT EXISTS batch_items (
    batch_id        text COLLATE "C" NOT NULL REFERENCES batches (id) ON DELETE CASCADE,
    idx             integer NOT NULL,
    status          text COLLATE "C" NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'waiting', 'running', 'succeeded', 'failed', 'expired')),
    model           text COLLATE "C",                    -- the model the prompt asked for, when it named one
    prompt          text NOT NULL,                      -- the prompt itself, as the caller wrote it
    run_id          text COLLATE "C",                    -- the run that answered it
    answer          text,                               -- the answer, once it is there
    error_code      text COLLATE "C",
    error_detail    text COLLATE "C",
    reason          text,                               -- the plain reason, when the item expired
    capacity        text COLLATE "C",                   -- 'low-cost' or 'regular': what it ran on
    route_provider  text COLLATE "C",                   -- the provider that answered it
    route_model     text COLLATE "C",
    cost_nano_usd   bigint,                             -- what the route really cost the network
    absorbed_nano_usd bigint NOT NULL DEFAULT 0,        -- what the network absorbed (the loss budget)
    charged_nano_usd bigint,                            -- what Billing charged for this prompt
    deadline_at     timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
                    -- when this prompt gives up: after this it expires, uncharged, unless the owner's
                    -- loss budget says the network may run it on regular capacity and absorb the difference
    claimed_until   timestamptz,                        -- while this is in the future, an instance holds this prompt
    claimed_by      text COLLATE "C",
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    PRIMARY KEY (batch_id, idx)
);
CREATE INDEX IF NOT EXISTS batch_items_queue_idx ON batch_items (status, created_at);
CREATE INDEX IF NOT EXISTS batch_items_claim_idx ON batch_items (claimed_until);

-- The price book's off-peak windows: what a provider's own price is when it is at least half lower than
-- the price the router charges, and when that is. Read from the provider's own listing by the price book
-- job (server/pricebook/offpeak.js); a provider the price book has no window for is not eligible for a
-- batch, because the network cannot tell what that route really costs.
CREATE TABLE IF NOT EXISTS price_book_offpeak (
    provider_key    text COLLATE "C" NOT NULL,
    model_key       text COLLATE "C" NOT NULL,
    field           text COLLATE "C" NOT NULL CHECK (field IN ('in_per_mtok', 'out_per_mtok', 'cached_per_mtok')),
    price           numeric(20, 6) NOT NULL,            -- the provider's own price inside the window
    start_hour      integer NOT NULL CHECK (start_hour BETWEEN 0 AND 23),   -- UTC hour the window opens
    end_hour        integer NOT NULL CHECK (end_hour BETWEEN 0 AND 23),     -- UTC hour it closes
    source          text COLLATE "C" NOT NULL,          -- the listing the window was read from
    checked_at      date NOT NULL,                      -- the day it was read
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    PRIMARY KEY (provider_key, model_key, field)
);
