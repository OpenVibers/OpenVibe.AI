-- phase: expand
-- Exchange webhooks (design EXCHANGE-REMAKE-2026-11-06, "For builders", item 7). A developer registers an https
-- receiver; AI signs every delivery with X-OpenVibe-Signature-V2 (t=<unix>, v2=hex HMAC-SHA256 of "<t>.<raw body>"),
-- exactly the header openvibe-sdk/exchange's verifyWebhook checks. usage, earnings and offer.down are the three
-- events. A delivery is a row, retried with a backoff, so a receiver that is down loses nothing while the log keeps
-- what happened. The secret is a per-subscription signing key (never a person's token), and the receiver URL is
-- judged by the same egress guard the community endpoint flow uses.
CREATE TABLE IF NOT EXISTS exchange_webhook_endpoints (
    id              text COLLATE "C" PRIMARY KEY,       -- whk_<ULID>
    owner_subject   text COLLATE "C" NOT NULL CHECK (owner_subject ~ '^(usr|prj)_[0-9A-HJKMNP-TV-Z]{26}$'),
    url             text COLLATE "C" NOT NULL,          -- https, a public host name, no query or fragment
    secret          text COLLATE "C" NOT NULL,          -- whsec_…: signs this subscription's deliveries, shown once
    events          text[] COLLATE "C" NOT NULL CHECK (events <@ ARRAY['usage', 'earnings', 'offer.down']::text[]),
    description     text COLLATE "C",
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS exchange_webhook_endpoints_owner ON exchange_webhook_endpoints (owner_subject, created_at DESC);

CREATE TABLE IF NOT EXISTS exchange_webhook_deliveries (
    id              text COLLATE "C" PRIMARY KEY,       -- whd_<ULID>
    endpoint_id     text COLLATE "C" NOT NULL REFERENCES exchange_webhook_endpoints (id) ON DELETE CASCADE,
    owner_subject   text COLLATE "C" NOT NULL,
    event_id        text COLLATE "C" NOT NULL,          -- evt_…, stable for the same source event
    event_type      text COLLATE "C" NOT NULL CHECK (event_type IN ('usage', 'earnings', 'offer.down')),
    payload         jsonb NOT NULL,                     -- the exact bytes that are signed and sent
    status          text COLLATE "C" NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz,
    last_attempt_at timestamptz,
    delivered_at    timestamptz,
    last_status     integer,
    last_error      text COLLATE "C",
    created_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS exchange_webhook_deliveries_endpoint ON exchange_webhook_deliveries (endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS exchange_webhook_deliveries_due ON exchange_webhook_deliveries (next_attempt_at) WHERE status = 'pending';
