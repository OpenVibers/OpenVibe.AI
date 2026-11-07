-- phase: expand
-- Your own endpoint (the Exchange remake, product line 6 / build order 7): a private GPU endpoint a person
-- rents for a chosen catalog model or their own Hugging Face weights. The instance is the existing
-- gpu_instances row (the GPU provisioner rents, health-checks, scales it to zero and enforces the owner's
-- monthly cap); this table is the person's endpoint on top of it: who owns it, what it serves, the Billing
-- hold that pays for the seconds, and the public proxy its owner calls. Additive only: nothing existing is
-- changed, gpu_instances gains two nullable columns.
CREATE TABLE IF NOT EXISTS own_endpoints (
    id                    text COLLATE "C" PRIMARY KEY,           -- oep_<ULID>
    subject               text COLLATE "C" NOT NULL,              -- usr_<ULID>: the owner and the payer
    status                text COLLATE "C" NOT NULL CHECK (status IN ('requested','starting','running','stopping','stopped','refused','error')),
    source                text COLLATE "C" NOT NULL CHECK (source IN ('catalog','weights')),
    catalog_key           text COLLATE "C",                        -- a model the provisioner knows, when source=catalog
    display_name          text COLLATE "C" NOT NULL,
    weights_repo          text COLLATE "C",
    weights_file          text COLLATE "C",
    lora_repo             text COLLATE "C",
    lora_file             text COLLATE "C",
    context_window        integer,
    idle_minutes          integer NOT NULL,
    max_runtime_minutes   integer NOT NULL,
    marketplace           text COLLATE "C",
    price_per_hour        text COLLATE "C",                        -- the marketplace's own decimal price
    hourly_nano           bigint,                                  -- that price as exact nano-USD per hour
    reserved_nano         bigint NOT NULL DEFAULT 0,               -- the budget held from Billing for this start
    instance_id           text COLLATE "C",                        -- gpu_instances.id
    endpoint              text COLLATE "C",                        -- the rented instance's own URL (never public)
    url                   text COLLATE "C",                        -- this endpoint's public URL (the AI proxy)
    billing_hold_id       text COLLATE "C",
    billing_settled_at    timestamptz,
    charged_nano          bigint NOT NULL DEFAULT 0,               -- what the person's Balance paid for this start
    month                 text COLLATE "C" NOT NULL,
    error                 text COLLATE "C",                        -- a plain reason when refused or stopped
    created_at            timestamptz NOT NULL,
    updated_at            timestamptz NOT NULL,
    started_at            timestamptz,
    ready_at              timestamptz,
    stopped_at            timestamptz
);
CREATE INDEX IF NOT EXISTS own_endpoints_subject ON own_endpoints (subject, created_at DESC);
CREATE INDEX IF NOT EXISTS own_endpoints_status ON own_endpoints (status);
CREATE INDEX IF NOT EXISTS own_endpoints_month ON own_endpoints (month);

-- The instance knows the endpoint it serves, so the reconciler can tell a private rent from a shared model
-- offer (a private rent is never registered for the router) and give it the endpoint's own idle timer.
ALTER TABLE gpu_instances ADD COLUMN IF NOT EXISTS own_endpoint_id text COLLATE "C";
ALTER TABLE gpu_instances ADD COLUMN IF NOT EXISTS idle_minutes integer;
CREATE INDEX IF NOT EXISTS gpu_instances_own ON gpu_instances (own_endpoint_id) WHERE own_endpoint_id IS NOT NULL;
