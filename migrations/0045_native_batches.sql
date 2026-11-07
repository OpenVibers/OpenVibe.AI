-- phase: expand
-- 0045: the native batch queue (BA2).
--
-- The providers' own batch APIs need somewhere to wait. This adds the two tables the native batcher
-- uses: the provider batches it has submitted (one row per batch the provider is working on) and the
-- queue of the items that wait for an answer (one row per request, with the run that waits for it).
--
-- The rule that shaped the tables: this is a QUEUE and a STATUS, never a second ledger. The money a
-- batch costs is the money of the ordinary runs (Billing holds and settles them), and the price of a
-- provider's batch tier is read from the registry's own card, never written here.
--
-- Nothing is removed and nothing is narrowed. The batches table's owner check only ever grows: a
-- first-party service may now open a batch of its own (billed to the network), which it could not do
-- before because there was no owner type for it.

-- The run's latency class. BA1 adds the same column in 0044; both are ADD COLUMN IF NOT EXISTS, so
-- whichever migration lands first wins and the other is a no-op.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS latency_class text COLLATE "C" NOT NULL DEFAULT 'interactive';

-- A batch of the network's own: the owner may be a service.
ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_owner_type_check;
ALTER TABLE batches ADD CONSTRAINT batches_owner_type_check CHECK (owner_type IN ('user', 'app', 'service'));

-- One row per batch the provider is working on.
CREATE TABLE IF NOT EXISTS provider_batches (
    id                text COLLATE "C" PRIMARY KEY,      -- pb_<id>
    provider          text COLLATE "C" NOT NULL,         -- the provider whose batch API took it
    model             text COLLATE "C" NOT NULL,
    adapter           text COLLATE "C" NOT NULL,         -- which adapter spoke to it
    provider_batch_id text COLLATE "C",                  -- the provider's own id for the batch
    completion_window text COLLATE "C",                  -- the window the provider promised ('24h')
    status            text COLLATE "C" NOT NULL DEFAULT 'submitting'
                      CHECK (status IN ('submitting', 'submitted', 'completed', 'failed', 'expired')),
    item_count        integer NOT NULL DEFAULT 0,
    bytes             bigint NOT NULL DEFAULT 0,
    discount          numeric NOT NULL DEFAULT 1,        -- the provider's batch price, as a fraction of its list price
    claimed_until     timestamptz,                       -- while this is in the future a worker owns the poll
    claimed_by        text COLLATE "C",
    error_code        text COLLATE "C",
    error_detail      text COLLATE "C",
    created_at        timestamptz NOT NULL,
    updated_at        timestamptz NOT NULL,
    submitted_at      timestamptz,
    finished_at       timestamptz
);
CREATE INDEX IF NOT EXISTS provider_batches_poll_idx ON provider_batches (status, submitted_at);

-- One row per request that waits for an answer.
CREATE TABLE IF NOT EXISTS batch_queue (
    id            text COLLATE "C" PRIMARY KEY,           -- bni_<id>: the custom_id the provider answers with
    run_id        text COLLATE "C",                       -- the run that waits for the answer
    kind          text COLLATE "C" NOT NULL DEFAULT 'service'
                  CHECK (kind IN ('customer', 'service')),
    batch_id      text COLLATE "C",                       -- the customer's batch (batches.id), for a customer item
    idx           integer,                               -- the customer's item index in that batch
    provider      text COLLATE "C" NOT NULL,
    model         text COLLATE "C" NOT NULL,
    prompt        text COLLATE "C" NOT NULL,
    request_body  text COLLATE "C" NOT NULL,             -- the provider's own request body (JSON)
    hold_card     text COLLATE "C",                       -- the retail card the customer is charged on (JSON)
    status        text COLLATE "C" NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'submitted', 'settling', 'succeeded', 'failed', 'expired', 'rerouted')),
    job_id        text COLLATE "C" REFERENCES provider_batches (id) ON DELETE SET NULL,
    answer        text COLLATE "C",
    usage         text COLLATE "C",
    cost_nano_usd bigint NOT NULL DEFAULT 0,             -- what the provider really charged, in nano-USD
    error_code    text COLLATE "C",
    error_detail  text COLLATE "C",
    deadline_at   timestamptz NOT NULL,
    created_at    timestamptz NOT NULL,
    updated_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS batch_queue_group_idx ON batch_queue (provider, model, status, created_at);
CREATE INDEX IF NOT EXISTS batch_queue_job_idx ON batch_queue (job_id, status);
CREATE INDEX IF NOT EXISTS batch_queue_run_idx ON batch_queue (run_id);
