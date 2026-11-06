-- phase: expand
-- Community AI offers (the design's "Offer to the network"; plan E4). A person's Node offers its local models to the
-- router; the offer itself lives in OpenVibe.Network's resource registry (a user-owned provider offer whose detail.kind
-- is `ai`), and this table keeps what only AI knows: whether the machine passed its canaries and model fingerprint, its
-- spot re-runs against a trusted machine, its reputation, and what it served. One row per offer and model, because a
-- canary proves one model. The usage rows are the seller's ledger: tokens × the owner's credits-per-million price in
-- integer micro-credits (1 credit = 1,000,000 micro), recorded only for verified tokens; nothing here moves cash.
CREATE TABLE IF NOT EXISTS community_offers (
    offer_key       text PRIMARY KEY,                 -- <offer_id>|<model>
    offer_id        text NOT NULL,
    machine_id      text NOT NULL,
    owner_subject   text NOT NULL,
    model           text NOT NULL,
    models          jsonb NOT NULL,
    price_in        numeric(20, 6) NOT NULL CHECK (price_in >= 0),
    price_out       numeric(20, 6) NOT NULL CHECK (price_out >= 0),
    status          text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'verified', 'failed', 'paused')),
    canary_passes   integer NOT NULL DEFAULT 0 CHECK (canary_passes >= 0),
    canary_failures integer NOT NULL DEFAULT 0 CHECK (canary_failures >= 0),
    spot_runs       integer NOT NULL DEFAULT 0 CHECK (spot_runs >= 0),
    spot_failures   integer NOT NULL DEFAULT 0 CHECK (spot_failures >= 0),
    reputation      integer NOT NULL DEFAULT 0 CHECK (reputation BETWEEN 0 AND 100),
    checks          integer NOT NULL DEFAULT 0 CHECK (checks >= 0),
    up_checks       integer NOT NULL DEFAULT 0 CHECK (up_checks >= 0),
    last_canary_at  timestamptz,
    last_spot_at    timestamptz,
    failure_reason  text,
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS community_offers_owner ON community_offers (owner_subject, updated_at DESC);
CREATE INDEX IF NOT EXISTS community_offers_status ON community_offers (status);

CREATE TABLE IF NOT EXISTS community_usage (
    id              text PRIMARY KEY,
    offer_key       text NOT NULL REFERENCES community_offers (offer_key) ON DELETE CASCADE,
    offer_id        text NOT NULL,
    machine_id      text NOT NULL,
    owner_subject   text NOT NULL,
    model           text NOT NULL,
    request_id      text NOT NULL,
    tokens_in       bigint NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
    tokens_out      bigint NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
    credits_micro   bigint NOT NULL DEFAULT 0 CHECK (credits_micro >= 0),
    verified        boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL,
    UNIQUE (offer_key, request_id)
);
CREATE INDEX IF NOT EXISTS community_usage_owner ON community_usage (owner_subject, created_at DESC);
CREATE INDEX IF NOT EXISTS community_usage_offer ON community_usage (offer_key, created_at DESC);
