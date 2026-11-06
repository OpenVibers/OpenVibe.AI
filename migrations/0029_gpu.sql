-- phase: expand
-- OpenVibe GPUs (the GPU provisioner): the marketplace instances AI rents, the money they cost and the
-- owner's requests to start or stop them. Money is integer nano-USD in bigint (AI's D1 rule: never a
-- float). Additive only: nothing existing is changed.
CREATE TABLE IF NOT EXISTS gpu_instances (
    id                   text COLLATE "C" PRIMARY KEY,
    model_key            text COLLATE "C" NOT NULL,
    provider_key         text COLLATE "C" NOT NULL,
    marketplace          text COLLATE "C" NOT NULL,
    offer_id             text COLLATE "C",
    remote_id            text COLLATE "C",
    status               text COLLATE "C" NOT NULL CHECK (status IN ('starting','running','stopping','destroyed','dead','refused')),
    endpoint             text COLLATE "C",
    month                text COLLATE "C" NOT NULL,
    gpu_name             text COLLATE "C",
    gpu_ram_mb           integer,
    num_gpus             integer,
    disk_gb              integer,
    reliability          double precision,
    region               text COLLATE "C",
    price_per_hour       text COLLATE "C",           -- the marketplace's own decimal price, as it quoted it
    hourly_nano          bigint NOT NULL DEFAULT 0, -- that price as exact nano-USD per hour
    reserved_nano        bigint NOT NULL DEFAULT 0, -- the budget held for this instance (never above the cap)
    spent_nano           bigint NOT NULL DEFAULT 0, -- the money this instance really cost
    max_runtime_minutes  integer NOT NULL,
    started_at           timestamptz,
    charged_at           timestamptz,               -- the moment the money was last put on the ledger
    ready_at             timestamptz,
    last_used_at         timestamptz,
    last_health_at       timestamptz,
    health_failures      integer NOT NULL DEFAULT 0,
    destroyed_at         timestamptz,
    error                text COLLATE "C",
    created_at           timestamptz NOT NULL,
    updated_at           timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS gpu_instances_model ON gpu_instances (model_key, status);
CREATE INDEX IF NOT EXISTS gpu_instances_month ON gpu_instances (month);

-- The money the GPU instances really cost. One row per settled instance (and per refund); the month's
-- spend is their sum, so the ledger and the cap are the same numbers.
CREATE TABLE IF NOT EXISTS gpu_spend (
    id           bigserial PRIMARY KEY,
    at           timestamptz NOT NULL,
    month        text COLLATE "C" NOT NULL,
    kind         text COLLATE "C" NOT NULL CHECK (kind IN ('charge','credit')),
    nano_usd     bigint NOT NULL,
    instance_id  text COLLATE "C",
    detail       text COLLATE "C",
    actor        text COLLATE "C",
    created_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS gpu_spend_month ON gpu_spend (month);

-- What the owner asked for: start or stop a model's GPU. The reconciler fulfils it (the console and the
-- admin API only write the request; one implementation acts on it).
CREATE TABLE IF NOT EXISTS gpu_requests (
    id         bigserial PRIMARY KEY,
    model_key  text COLLATE "C" NOT NULL,
    action     text COLLATE "C" NOT NULL CHECK (action IN ('launch','stop')),
    at         timestamptz NOT NULL,
    actor      text COLLATE "C",
    created_at timestamptz NOT NULL,
    done_at    timestamptz,
    error      text COLLATE "C"
);
CREATE INDEX IF NOT EXISTS gpu_requests_model ON gpu_requests (model_key, done_at);
